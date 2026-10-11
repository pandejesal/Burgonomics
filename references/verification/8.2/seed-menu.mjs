#!/usr/bin/env node
/**
 * 8.2 — re-runnable Firestore seed for the customer app's final menu.
 *
 * Source of truth: `.swarm/staging/8.2/menuData.json` (56 items / 15
 * categories, extracted from the owner's `finale - Copy` menu module) plus
 * `references/verification/8.2/image-map.json` (the resolved public image
 * path produced by integrate-assets.mjs).
 *
 * Writes (merge, never delete):
 *   products    name, price (price ?? steamPrice ?? friedPrice), categoryId,
 *               categoryName, order, imageUrl, imageUrls, description,
 *               updatedAt (only when something else actually changed)
 *               — applied to EVERY product doc with that name, across all
 *               27 restIds / branches, so no branch keeps a stale path.
 *
 *               imageUrl is written only when the document already carries
 *               one, or when an owner-final staged photo exists for that item
 *               (asset-report `source`). 13 items have no owner photo at all,
 *               and existing Firestore practice is null-or-own-photo for
 *               products — so those stay null rather than borrowing another
 *               product's picture. Category images are different: the data
 *               already reuses one photo across categories, so sydney-s-viral
 *               (currently null) gets the same fallback its products use.
 *   categories  name, order (menuData array order), imageUrl
 *   banners     imageUrl for the one banner whose image asset moved, plus
 *               gradient normalisation via BANNER_GRADIENTS (keeps banner
 *               colors inside the 60-30-10 scheme — see note in that block)
 *
 * Everything else in each document (id, createdAt, restId, branchId, inStock,
 * isAvailable, isBestSeller, badges, tags, prepTimeMinutes, customizable,
 * veg, active) is preserved verbatim from the live document.
 *
 * Usage:
 *   node references/verification/8.2/seed-menu.mjs           # dry run
 *   node references/verification/8.2/seed-menu.mjs --apply    # write + verify
 *
 * Token: env FIRESTORE_TOKEN > --token <t> > `gcloud auth application-default
 * print-access-token`. The token is never written to disk.
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const PROJECT = "burgonomics-7faa8";
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const PUBLIC_DIR = path.join(ROOT, "burgonomics-foundation-core", "public");
const MENU_DATA = path.join(ROOT, ".swarm", "staging", "8.2", "menuData.json");
const IMAGE_MAP = path.join(ROOT, "references", "verification", "8.2", "image-map.json");
const ASSET_REPORT = path.join(ROOT, "references", "verification", "8.2", "asset-report.json");
const OUT_INTEGRITY = path.join(ROOT, "references", "verification", "8.2", "integrity-report.json");

const APPLY = process.argv.includes("--apply");
const CHUNK = 400;
const SEED_SOURCES =
  "menuData.json extracted from finale - Copy/src/components/Menu/menuData.js " +
  "(one-time owner-provided seed for the test build; Petpooja remains the " +
  "ongoing authoritative menu source per FR-001)";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function resolveToken() {
  if (process.env.FIRESTORE_TOKEN) return process.env.FIRESTORE_TOKEN;
  const fromArg = arg("token", null);
  if (fromArg) return fromArg;
  const { execFileSync } = await import("node:child_process");
  // Windows ships `gcloud.cmd`/`gcloud.ps1`; spawning "gcloud" directly fails
  // with EINVAL/ENOENT, so run it through cmd.exe where gcloud is on PATH.
  const tokenFromGcloud = () => {
    const out = execFileSync(
      process.env.ComSpec || "cmd.exe",
      ["/d", "/s", "/c", "gcloud auth application-default print-access-token"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    const line = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop();
    if (!line || /\s/.test(line)) throw new Error(`unexpected gcloud output: ${out.slice(0, 80)}`);
    return line;
  };
  try {
    return tokenFromGcloud();
  } catch (e) {
    throw new Error(
      `No Firestore token (gcloud ADC failed: ${e.message}). ` +
        `Set FIRESTORE_TOKEN or run 'gcloud auth application-default login'.`,
    );
  }
}

async function listCollection(token, collectionId) {
  const docs = [];
  let pageToken = "";
  for (;;) {
    const url =
      `${BASE}/${collectionId}?pageSize=300` + (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "");
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`list ${collectionId} -> HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const json = await res.json();
    for (const d of json.documents ?? []) docs.push(d);
    if (!json.nextPageToken) break;
    pageToken = json.nextPageToken;
  }
  return docs;
}

function decodeValue(v) {
  if (v === null || typeof v !== "object") return v;
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("nullValue" in v) return null;
  if ("timestampValue" in v) return v.timestampValue;
  if ("bytesValue" in v) return v.bytesValue;
  if ("arrayValue" in v) return (v.arrayValue.values ?? []).map(decodeValue);
  if ("mapValue" in v) {
    const o = {};
    for (const [k, val] of Object.entries(v.mapValue.fields ?? {})) o[k] = decodeValue(val);
    return o;
  }
  return v;
}
const decodeDoc = (d) => {
  const o = {};
  for (const [k, v] of Object.entries(d.fields ?? {})) o[k] = decodeValue(v);
  return o;
};

const S = (s) => ({ stringValue: String(s) });
const I = (n) => ({ integerValue: String(Math.round(n)) });
const D = (n) => ({ doubleValue: n });
const A = (vs) => ({ arrayValue: { values: vs.map(S) } });
const slug = (s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-+|-+$)/g, "");

const walk = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)],
  );

/** every file currently served out of `public/`, as `images/...` */
const onDiskFiles = new Set(
  walk(PUBLIC_DIR).map((f) => path.relative(PUBLIC_DIR, f).split(path.sep).join("/")),
);
const strip = (p) => (p ? String(p).replace(/^\/+/, "") : p);
const exists = (p) => onDiskFiles.has(strip(p));

/* ------------------------------------------------------------------ */
const menuData = JSON.parse(fs.readFileSync(MENU_DATA, "utf8"));
const imageMap = JSON.parse(fs.readFileSync(IMAGE_MAP, "utf8"));
const assetReport = JSON.parse(fs.readFileSync(ASSET_REPORT, "utf8"));

if (menuData.items.length !== 56) throw new Error(`menuData has ${menuData.items.length} items, expected 56`);
if (Object.keys(imageMap.items).length !== 56) throw new Error("image-map.json does not cover 56 items");

const priceOf = (it) => it.price ?? it.steamPrice ?? it.friedPrice ?? null;

/** item -> true when an owner-final staged photo for it was installed */
const itemHasPhoto = new Map(assetReport.items.map((a) => [a.item, !!a.source]));
/** item names whose live docs already carry an imageUrl (populated after fetch) */
const hadImage = new Set();

/** item name -> categoryId / categoryName / order, from menuData array order */
const itemIndex = new Map();
const catOrder = new Map();
menuData.categories.forEach((c, i) => {
  const id = slug(c.subcategory || c.category);
  const name = c.subcategory || c.category;
  catOrder.set(id, { order: i + 1, name, index: i });
  c.items.forEach((n, j) => {
    itemIndex.set(n, { categoryId: id, categoryName: name, order: j + 1 });
  });
});
for (const it of menuData.items) {
  if (!itemIndex.has(it.name)) throw new Error(`item not placed in any category: ${it.name}`);
}

/* ------------------------------------------------------------------ */
let token = await resolveToken();

const live = {};
for (const c of ["products", "categories", "banners"]) {
  try {
    live[c] = await listCollection(token, c);
  } catch (e) {
    if (/HTTP 401/.test(String(e.message))) {
      token = await resolveToken();
      live[c] = await listCollection(token, c);
    } else throw e;
  }
}

const writes = []; // { update: { name, fields } }
const changes = { products: [], categories: [], banners: [] };
let skipped = 0;

/* ---- products ---- */
const byName = new Map();
for (const doc of live.products) {
  const n = doc.fields?.name?.stringValue;
  if (!n) continue;
  if (doc.fields?.imageUrl?.stringValue) hadImage.add(n);
  if (!byName.has(n)) byName.set(n, []);
  byName.get(n).push(doc);
}

for (const it of menuData.items) {
  const idx = itemIndex.get(it.name);
  const newUrl = imageMap.items[it.name];
  if (!newUrl) throw new Error(`image-map has no entry for ${it.name}`);
  const price = priceOf(it);
  const docs = byName.get(it.name) ?? [];
  if (!docs.length) {
    changes.products.push({ name: it.name, error: "no live product doc" });
    continue;
  }

  for (const doc of docs) {
    const before = { ...doc.fields };

    // name
    if (doc.fields.name?.stringValue !== it.name) before.name = S(it.name);
    // price (preserve the document's numeric encoding)
    if (price !== null && price !== undefined) {
      const raw = doc.fields.price;
      const same =
        raw &&
        (("integerValue" in raw && Number(raw.integerValue) === price) ||
          ("doubleValue" in raw && raw.doubleValue === price));
      if (!same) before.price = raw && "doubleValue" in raw ? D(price) : I(price);
    }
    // category placement
    if (doc.fields.categoryId?.stringValue !== idx.categoryId) before.categoryId = S(idx.categoryId);
    if (doc.fields.categoryName?.stringValue !== idx.categoryName) before.categoryName = S(idx.categoryName);
    if (Number(doc.fields.order?.integerValue ?? -1) !== idx.order) before.order = I(idx.order);
    // description (menuData only carries it for 4 items)
    if (it.description !== undefined && doc.fields.description?.stringValue !== it.description) {
      before.description = S(it.description);
    }
    // image path — only for documents that already have one, or items whose
    // owner-final staged photo we actually installed (see header).
    const docHasImage = !!(doc.fields.imageUrl && doc.fields.imageUrl.stringValue);
    if (docHasImage || itemHasPhoto.get(it.name)) {
      if (doc.fields.imageUrl?.stringValue !== newUrl) before.imageUrl = S(newUrl);
      // imageUrls: drop anything that no longer resolves, guarantee primary present
      const existingUrls = Array.isArray(decodeValue(doc.fields.imageUrls))
        ? decodeValue(doc.fields.imageUrls)
        : [];
      const cleaned = [];
      for (const u of existingUrls) {
        if (!u) continue;
        const keep = exists(u) ? `/${strip(u)}` : newUrl;
        if (!cleaned.includes(keep)) cleaned.push(keep);
      }
      if (!cleaned.includes(newUrl)) cleaned.unshift(newUrl);
      if (JSON.stringify(cleaned) !== JSON.stringify(existingUrls)) before.imageUrls = A(cleaned);
    }

    const changedKeys = Object.keys(before).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(doc.fields[k]));
    if (!changedKeys.length) {
      skipped++;
      continue;
    }
    before.updatedAt = S(new Date().toISOString());
    writes.push({ update: { name: doc.name, fields: before } });
    changes.products.push({
      id: doc.fields.id?.stringValue ?? doc.name.split("/").pop(),
      name: it.name,
      restId: doc.fields.restId?.stringValue ?? null,
      changedKeys: [...changedKeys, "updatedAt"],
    });
  }
}

/* ---- categories ---- */
const catDocs = new Map();
for (const doc of live.categories) {
  const id = doc.fields?.id?.stringValue;
  if (id) catDocs.set(id, doc);
}
for (const [id, want] of catOrder) {
  const doc = catDocs.get(id);
  if (!doc) {
    changes.categories.push({ id, error: "no live category doc" });
    continue;
  }
  const before = { ...doc.fields };
  if (doc.fields.name?.stringValue !== want.name) before.name = S(want.name);
  if (Number(doc.fields.order?.integerValue ?? -1) !== want.order) before.order = I(want.order);
  const newUrl = imageMap.categories[id];
  if (newUrl && doc.fields.imageUrl?.stringValue !== newUrl) before.imageUrl = S(newUrl);
  const changedKeys = Object.keys(before).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(doc.fields[k]));
  if (!changedKeys.length) {
    skipped++;
    continue;
  }
  writes.push({ update: { name: doc.name, fields: before } });
  changes.categories.push({ id, changedKeys });
}
for (const [id] of catDocs) {
  if (!catOrder.has(id)) changes.categories.push({ id, error: "live category not present in menuData (left untouched)" });
}

/* ---- banners ---- */
// Brand 60-30-10 guard (references/ui_ux_spec.md): banner gradients must stay
// in-scheme. banner_myob shipped off-scheme purple (#4A2E7A -> #6D47B8); the
// MYOB banner uses the Vibrant Orange accent so it stays distinct from the two
// green banners and the red Peri Peri banner. Future imports inherit this map.
const BANNER_GRADIENTS = {
  banner_myob: "bg-gradient-to-br from-[#FF6600] to-[#E55C00] text-white",
};
for (const doc of live.banners) {
  const id = doc.fields?.id?.stringValue ?? doc.name.split("/").pop();
  const before = { ...doc.fields };
  const wantGradient = BANNER_GRADIENTS[id];
  if (wantGradient && doc.fields.gradient?.stringValue !== wantGradient) before.gradient = S(wantGradient);
  const newUrl = imageMap.banners[id];
  if (newUrl && doc.fields.imageUrl?.stringValue !== newUrl) before.imageUrl = S(newUrl);
  const changedKeys = Object.keys(before).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(doc.fields[k]));
  if (!changedKeys.length) {
    skipped++;
    continue;
  }
  writes.push({ update: { name: doc.name, fields: before } });
  changes.banners.push({ id, changedKeys });
}

/* ------------------------------------------------------------------ */
console.log(`source   : ${SEED_SOURCES}`);
console.log(`live     : products=${live.products.length} categories=${live.categories.length} banners=${live.banners.length}`);
console.log(`writes   : ${writes.length}  (unchanged/skipped docs: ${skipped})`);
for (const c of changes.products.slice(0, 12)) console.log(`  P ${c.name ?? c.id} ${c.error ?? c.changedKeys?.join(",")}`);
if (changes.products.length > 12) console.log(`  P ... ${changes.products.length - 12} more`);
for (const c of changes.categories) console.log(`  C ${c.id} ${c.error ?? c.changedKeys?.join(",")}`);
for (const c of changes.banners) console.log(`  B ${c.id} ${c.error ?? c.changedKeys?.join(",")}`);

if (!APPLY) {
  console.log("\nDRY RUN — re-run with --apply to write.");
  process.exit(0);
}

/* ---- batchWrite ---- */
async function batchWrite(chunk) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`${BASE}:batchWrite`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ writes: chunk }),
    });
    if (res.status === 401) {
      token = await resolveToken();
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      continue;
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`batchWrite -> HTTP ${res.status}: ${text.slice(0, 500)}`);
    const json = JSON.parse(text);
    const failed = (json.writeResults ?? []).filter((w) => w.error);
    if (failed.length) throw new Error(`batchWrite partial failure: ${JSON.stringify(failed[0].error).slice(0, 400)}`);
    return;
  }
  throw new Error("batchWrite exhausted retries");
}

for (let i = 0; i < writes.length; i += CHUNK) {
  const part = writes.slice(i, i + CHUNK);
  await batchWrite(part);
  console.log(`  batch ${Math.floor(i / CHUNK) + 1}/${Math.ceil(writes.length / CHUNK)} (${part.length} writes)`);
}

/* ---- verify ---- */
const after = {};
for (const c of ["products", "categories", "banners"]) after[c] = await listCollection(token, c);

const broken = [];
let refsChecked = 0;
const fields = ["imageUrl", "image", "image_url", "itemimage_url"];
for (const [coll, docs] of Object.entries(after)) {
  for (const doc of docs) {
    const id = doc.fields?.id?.stringValue ?? doc.name.split("/").pop();
    for (const f of fields) {
      const v = doc.fields?.[f]?.stringValue;
      if (!v) continue;
      refsChecked++;
      if (!exists(v)) broken.push({ collection: coll, id, field: f, value: v, reason: "no file on disk" });
    }
    if (coll === "products") {
      const urls = decodeValue(doc.fields?.imageUrls) ?? [];
      for (const u of urls) {
        if (!u) continue;
        refsChecked++;
        if (!exists(u)) broken.push({ collection: coll, id, field: "imageUrls", value: u, reason: "no file on disk" });
      }
    }
  }
}

// every seeded value must have landed — checked on ALL 1512 product docs,
// not one sample per item, so no branch can keep a stale value.
const landedItems = [];
const mismatched = [];
const docsByName = new Map();
for (const doc of after.products) {
  const n = doc.fields?.name?.stringValue;
  if (!docsByName.has(n)) docsByName.set(n, []);
  docsByName.get(n).push(doc);
}
const coverage = { withImage: 0, withoutImage: 0, withoutImageItems: new Set() };
for (const doc of after.products) {
  if (doc.fields?.imageUrl?.stringValue) coverage.withImage++;
  else {
    coverage.withoutImage++;
    coverage.withoutImageItems.add(doc.fields?.name?.stringValue ?? "?");
  }
}

for (const it of menuData.items) {
  const docs = docsByName.get(it.name) ?? [];
  const idx = itemIndex.get(it.name);
  const want = imageMap.items[it.name];
  const price = priceOf(it);
  const expectImage = itemHasPhoto.get(it.name) || hadImage.has(it.name);
  if (!docs.length) {
    mismatched.push({ name: it.name, reason: "no live product doc" });
    continue;
  }
  const local = [];
  for (const doc of docs) {
    const p = decodeDoc(doc);
    const id = p.id ?? doc.name.split("/").pop();
    const bad = [];
    if (expectImage && p.imageUrl !== want) bad.push(`imageUrl ${p.imageUrl} != ${want}`);
    if (p.categoryId !== idx.categoryId) bad.push(`categoryId ${p.categoryId} != ${idx.categoryId}`);
    if (p.order !== idx.order) bad.push(`order ${p.order} != ${idx.order}`);
    if (price != null && p.price !== price) bad.push(`price ${p.price} != ${price}`);
    if (bad.length) local.push({ id, restId: p.restId ?? null, bad });
  }
  if (local.length) mismatched.push({ name: it.name, branches: local });
  else landedItems.push(it.name);
}
for (const [id, want] of catOrder) {
  const doc = after.categories.find((d) => d.fields?.id?.stringValue === id);
  const p = doc ? decodeDoc(doc) : null;
  if (!p || p.order !== want.order || p.name !== want.name) {
    mismatched.push({ id, reason: `category order/name not landed (${p?.order}/${p?.name})` });
  }
}
const categoryOrder = after.categories
  .map((d) => ({ id: d.fields?.id?.stringValue, order: d.fields?.order?.integerValue }))
  .sort((a, b) => Number(a.order) - Number(b.order));

const verdict = broken.length === 0 && mismatched.length === 0 ? "PASS" : "FAIL";
const integrity = {
  generatedAt: new Date().toISOString(),
  applied: APPLY,
  seedSources: SEED_SOURCES,
  counts: {
    products: { live: after.products.length, expected: 1512 },
    categories: { live: after.categories.length, expected: 15 },
    banners: { live: after.banners.length, expected: 4 },
  },
  writesApplied: writes.length,
  documentsLeftUnchanged: skipped,
  changed: changes,
  imageReferencesChecked: refsChecked,
  brokenImageReferences: broken,
  productImageCoverage: {
    docsWithImage: coverage.withImage,
    docsWithoutImage: coverage.withoutImage,
    itemsWithoutImage: [...coverage.withoutImageItems].sort(),
    policy:
      "13 menuData items have no owner-final photo in the staged set. Existing Firestore practice " +
      "is null-or-own-photo for products, so their imageUrl stays null instead of borrowing a " +
      "different product's picture. Category images are different and may be shared, so " +
      "sydney-s-viral (previously null) is seeded with the same fallback its products use.",
  },
  categoryOrder,
  itemsVerified: landedItems.length,
  itemsCheckedAcrossAllBranches: true,
  mismatched,
  verdict,
  petpoojaDisclosure:
    "Petpooja remains the ongoing authoritative menu source (FR-001). This seed is a one-time " +
    "owner-provided refresh of the test build; a future Petpooja sync may overwrite these documents.",
};
fs.writeFileSync(OUT_INTEGRITY, JSON.stringify(integrity, null, 2), "utf8");

console.log(`\nrefs checked : ${refsChecked}`);
console.log(`broken refs  : ${broken.length}`);
for (const b of broken.slice(0, 20)) console.log(`  ! ${b.collection}/${b.id} ${b.field}=${b.value}`);
console.log(`items landed : ${landedItems.length}/56 (all branches)   mismatched: ${mismatched.length}`);
console.log(`image cover  : ${coverage.withImage}/${after.products.length} docs have an image, ${coverage.withoutImage} null across ${coverage.withoutImageItems.size} items`);
console.log(`cat order    : ${categoryOrder.map((c) => `${c.id}=${c.order}`).join(" ")}`);
for (const m of mismatched.slice(0, 20)) console.log(`  ? ${JSON.stringify(m)}`);
console.log(`report       ${path.relative(ROOT, OUT_INTEGRITY)}`);
console.log(`\n${verdict}`);
process.exit(verdict === "PASS" ? 0 : 1);
