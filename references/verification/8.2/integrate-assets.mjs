#!/usr/bin/env node
/**
 * 8.2 — Final menu asset integration (customer app).
 *
 * Brings `burgonomics-foundation-core/public/images/menu/` in line with the
 * owner-final staged photo set (`.swarm/staging/8.2/images/`) and with the
 * final `menuData.json` (56 items / 15 categories), then prunes superseded
 * menu images that no seeded document references any more.
 *
 * Rules
 *   1. A staged photo replaces the bytes of the file its menu item already
 *      resolves to. Staging is owner-final: staged files are the <=1200px /
 *      <=300KB re-encodes of the same shoot; the existing files are the
 *      older 800px / q85 re-encodes produced by scripts/process-menu-images.ps1.
 *   2. Two items that need *different* staged photos for the same file are
 *      de-duplicated by relocating the later item to
 *      `<categoryId>/<slug>.jpg`. Items that merely share a category fallback
 *      keep sharing — no bytes are written for them.
 *   3. Items with no owner photo anywhere fall back to their category image
 *      (always an existing file — never a dangling reference).
 *   4. Files under `public/images/menu` that no seeded product / category /
 *      banner references are removed ("superseded old menu images").
 *      The one banner image that exceeds the per-file cap
 *      (`banners/myob-banner.png`, 1.28 MiB PNG) is replaced by the owner-final
 *      staged photo of that same source at `banners/myob-banner.jpg`; banner
 *      copy, CTA, order and gradient are untouched.
 *
 * Usage:  node references/verification/8.2/integrate-assets.mjs [--apply]
 *          (default is a dry run)
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const MENU_DIR = path.join(ROOT, "burgonomics-foundation-core", "public", "images", "menu");
const PUBLIC_DIR = path.join(ROOT, "burgonomics-foundation-core", "public");
const STAGE_DIR = path.join(ROOT, ".swarm", "staging", "8.2");
const MENU_DATA = path.join(STAGE_DIR, "menuData.json");
const SNAPSHOT = path.join(ROOT, "references", "verification", "8.2", "pre-import-snapshot.json");
const PROCESS_PS1 = path.join(ROOT, "scripts", "process-menu-images.ps1");
const OUT_IMAGE_MAP = path.join(ROOT, "references", "verification", "8.2", "image-map.json");
const OUT_REPORT = path.join(ROOT, "references", "verification", "8.2", "asset-report.json");

const APPLY = process.argv.includes("--apply");
const KB = 1024;
const MAX_FILE = 300 * KB;
const MAX_TOTAL = 16 * 1024 * KB;

/** All internal paths are relative to `public/` with NO leading slash. */
const strip = (p) => (p ? p.replace(/^\/+/, "") : p);
/** Firestore / <img src> form. */
const web = (p) => `/${strip(p)}`;

/**
 * Staged-photo ownership per menu item.
 * Derived from `.swarm/staging/8.2/mapping-report.md` (43 staged photos;
 * 9 of them match no menuData item and are listed in STAGED_UNMATCHED).
 * menuData's own `image` anchor wins, then in-scope name match, then the
 * documented cross-category reuse.
 */
const ITEM_SOURCE = {
  "Great Indian Burger": "Big Bang/Great Indian.jpg",
  "Cheese Burst Burger": "Big Bang/Cheese burst.jpg",
  "Tandoori Paneer Burger": "Big Bang/tandoori paneer.jpg",
  "Super Hero Burger": "Big Bang/Super Hero.jpg",
  "Dirty Fries": "Fries/Dirty fries.jpg",
  "Cheese Heaven Pizza": "Pizza/4 cheese.png",
  "Jr. Hero Burger": "Classic Burgers/Jr. Hero.jpeg",
  "Hero Burger": "Classic Burgers/Hero burgr.jpg",
  "Korean Kimchi Burger": "Classic Burgers/Korean Kimchi.JPG",
  "Mexican Mafia Burger": "Classic Burgers/Mexican.jpg",
  "Veggie Loaded Burger": "Classic Burgers/Veggie loaded.jpg",
  "Veg Sizzling Burger": "Big Bang/Farm Fresh.jpg",
  "Cheese Supreme Burger": "Big Bang/Cheese burst.jpg",
  "Paneer Supreme Burger": "Big Bang/tandoori paneer.jpg",
  "Jr Hero Burger Meal": "Meals/hero meal.JPG",
  "2 Jr. Hero Burger": "Meals/hero meal.JPG",
  "Any Classic Burger Meal": "Meals/hero meal.JPG",
  "Any Big Bang Burger Meal": "Meals/big bang meal.JPG",
  "Classic Salted Fries": "Fries/Salted fries.jpg",
  "Peri Peri Fries": "Fries/Peri peri fries.JPG",
  "Peri Peri Cheese Fries": "Fries/Peri Peri Cheesy.jpeg",
  "Margherita Pizza": "Pizza/margherita pizza.png",
  "Tandoori Paneer Pizza": "Pizza/Tandoori paneer pizza.png",
  "The Veg Overload Pizza": "Pizza/veggie loaded pizza.jpg",
  "White Sauce Pasta": "Pasta/White Sauce.png",
  "Pink Sauce Pasta": "Pasta/Pink and Arrabiata.JPG",
  "Arrabiata Pasta": "Pasta/Pink and Arrabiata.JPG",
  "Veg Momos": "Momos/MOMOS.JPG",
  "Veg Cheese Momos": "Momos/MOMOS.JPG",
  "Kurkure Momos": "Momos/MOMOS.JPG",
  "Lemon Iced Tea": "Beverages/Lemon Iced Tea.jpg",
  "Peach Iced Tea": "Beverages/Peach.jpg",
  "Masala Coke": "Beverages/Lemon Iced Tea.jpg",
  "Kokum Iced Tea": "Beverages/Peach.jpg",
  "Oreo Shake": "Shakes/Oreo.JPG",
  "Chocolate Shake": "Shakes/Chocolate.JPG",
  "Strawberry Oreo Shake": "Shakes/Strawberry Shake.png",
  "Classic Cold Coffee": "Cold Coffee/Oreo.JPG",
  "Hazlenut Cold Coffee": "Cold Coffee/Hazelnut.jpg",
  "Irish Cold Coffee": "Cold Coffee/Irish.jpg",
  "Chocolate Brownie": "Brownie/Chocolate Brownie.png",
};

/** mapping-report.md section (a): staged photos with no menu item. */
const STAGED_UNMATCHED = [
  "Big Bang/Burning Man.jpeg",
  "Big Bang/Farm Fresh.jpg",
  "Classic Burgers/red hot.JPG",
  "Cold Coffee/Mocha.jpg",
  "Meals/Red Hot meal.jpg",
  "MYOB.png",
  "Shakes/Biscoff Shake.png",
  "Shakes/Cookie Crumble.JPG",
  "Shakes/Nutella.JPG",
];

/** Deliberate moves off a shared or mis-named existing path. */
const RELOCATE = {
  "Peri Peri Cheese Fries": "images/menu/fries/peri-peri-cheesy-fries.jpg",
  "Tandoori Paneer Pizza": "images/menu/pizza/tandoori-paneer-pizza.jpg",
  // two items would otherwise collide on one photo file
  "2 Jr. Hero Burger": "images/menu/combos/2-jr-hero-burger.jpg",
  "Strawberry Oreo Shake": "images/menu/thick-shakes/strawberry-oreo-shake.jpg",
};

/**
 * The single banner photo that breaches the per-file cap. Same source photo
 * (staging `MYOB.png`), owner-final bytes, new `.jpg` extension so the file
 * really is a JPEG; the banner document's imageUrl is repointed to match.
 */
const BANNER_IMAGE_SWAP = {
  from: "images/menu/banners/myob-banner.png",
  to: "images/menu/banners/myob-banner.jpg",
  staged: "MYOB.png",
  bannerId: "banner_myob",
};

/* ------------------------------------------------------------------ */

const walk = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)],
  );
const walkDirs = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? [path.join(dir, e.name), ...walkDirs(path.join(dir, e.name))] : [],
  );

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

const slug = (s) =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/['’.]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const categoryIdOf = (item) =>
  (item.subcategory || item.category)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-+|-+$)/g, "");

function tokenize(s) {
  return new Set(
    s
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 2),
  );
}
function similarity(a, b) {
  const A = tokenize(a);
  const B = tokenize(b);
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const t of A) if (B.has(t)) hit++;
  return hit / Math.max(A.size, B.size);
}

/* ------------------------------------------------------------------ *
 * inputs
 * ------------------------------------------------------------------ */
const menuData = JSON.parse(fs.readFileSync(MENU_DATA, "utf8"));
const snapshot = JSON.parse(fs.readFileSync(SNAPSHOT, "utf8"));
const products = snapshot.collections.products.documents.map(decodeDoc);
const categories = snapshot.collections.categories.documents.map(decodeDoc);
const banners = snapshot.collections.banners.documents.map(decodeDoc);

if (products.length === 0) throw new Error("snapshot has no products — run snapshot.mjs first");
if (menuData.items.length !== 56) throw new Error(`menuData has ${menuData.items.length} items, expected 56`);

function majority(paths) {
  const tally = {};
  for (const p of paths) {
    if (!p) continue;
    const k = strip(p);
    tally[k] = (tally[k] ?? 0) + 1;
  }
  const e = Object.entries(tally).sort((a, b) => b[1] - a[1]);
  return e.length ? e[0][0] : null;
}
const existingItemPath = new Map();
for (const p of products) {
  if (!p.name) continue;
  const list = existingItemPath.get(p.name) ?? [];
  list.push(p.imageUrl);
  existingItemPath.set(p.name, list);
}
const existingCatPath = new Map();
for (const c of categories) {
  const list = existingCatPath.get(c.id) ?? [];
  list.push(c.imageUrl);
  existingCatPath.set(c.id, list);
}

function parseSourceDest() {
  const txt = fs.readFileSync(PROCESS_PS1, "utf8");
  const re = /Resize-And-Save-Image\s+"[^"]*\\([^"\\]+)\\([^"\\]+)"\s+"([^"]+)"\s+"([^"]+)"/g;
  const out = {};
  for (const hit of txt.matchAll(re)) {
    const src = `${hit[1]}/${hit[2]}`;
    const dest = `images/menu/${hit[3]}/${hit[4]}`;
    if (!out[src]) out[src] = [];
    out[src].push(dest);
  }
  return out;
}
const sourceDest = parseSourceDest();
if (Object.keys(sourceDest).length < 40) {
  throw new Error(`only parsed ${Object.keys(sourceDest).length} source->dest rows from process-menu-images.ps1`);
}

const stagedSet = new Set(
  walk(path.join(STAGE_DIR, "images")).map((f) =>
    path.relative(path.join(STAGE_DIR, "images"), f).split(path.sep).join("/"),
  ),
);
for (const s of Object.values(ITEM_SOURCE)) if (!stagedSet.has(s)) throw new Error(`staged source missing: ${s}`);
for (const s of STAGED_UNMATCHED) if (!stagedSet.has(s)) throw new Error(`staged unmatched file missing: ${s}`);
const stagedBytes = new Map(
  [...stagedSet].map((s) => [s, fs.statSync(path.join(STAGE_DIR, "images", ...s.split("/"))).size]),
);

/* ------------------------------------------------------------------ *
 * assignment — pass 1: items that own a photo, pass 2: category fallback
 * ------------------------------------------------------------------ */
const catFallback = new Map();
for (const c of categories) {
  catFallback.set(c.id, majority(existingCatPath.get(c.id) ?? []));
}
if (!catFallback.get("sydney-s-viral")) {
  catFallback.set("sydney-s-viral", "images/menu/classic-burgers/hero-burger.jpg");
}
for (const [k, v] of catFallback) if (!v) throw new Error(`no category image for ${k}`);

const claimed = new Map(); // path -> item name (photo owners only)
const assignments = [];

function derivePath(item, src) {
  const dests = sourceDest[src] ?? [];
  const free = dests.filter((d) => !claimed.has(d));
  const best = free
    .map((d) => [d, similarity(item.name, path.basename(d, path.extname(d)))])
    .sort((a, b) => b[1] - a[1])[0];
  if (best && best[1] >= 0.6) return { final: best[0], created: false };
  return { final: `images/menu/${categoryIdOf(item)}/${slug(item.name)}.jpg`, created: true };
}

// pass 1 — every item that has a photo to write or a real existing path
const pass1 = menuData.items.filter(
  (i) => ITEM_SOURCE[i.name] || majority(existingItemPath.get(i.name) ?? []),
);
const pass2 = menuData.items.filter((i) => !pass1.includes(i));

for (const item of pass1) {
  const cid = categoryIdOf(item);
  const src = ITEM_SOURCE[item.name] ?? null;
  const existing = majority(existingItemPath.get(item.name) ?? []);
  let final;
  let created = false;
  let relocated = false;

  if (RELOCATE[item.name]) {
    final = RELOCATE[item.name];
    relocated = true;
    created = !onDiskHas(final);
  } else if (existing) {
    final = existing;
  } else {
    const d = derivePath(item, src);
    final = d.final;
    created = d.created;
    relocated = true;
  }

  const owner = claimed.get(final);
  if (owner !== undefined && src && ITEM_SOURCE[owner] && ITEM_SOURCE[owner] !== src) {
    final = `images/menu/${cid}/${slug(item.name)}.jpg`;
    created = !onDiskHas(final);
    relocated = true;
    if (claimed.has(final)) throw new Error(`relocation collision for ${item.name}`);
  }
  claimed.set(final, item.name);

  assignments.push({
    item: item.name,
    categoryId: cid,
    source: src,
    final,
    created,
    relocated,
    fallback: false,
    previouslyReferenced: !!existing,
  });
}

// pass 2 — no photo anywhere: category fallback (shared is fine)
for (const item of pass2) {
  const cid = categoryIdOf(item);
  assignments.push({
    item: item.name,
    categoryId: cid,
    source: null,
    final: catFallback.get(cid),
    created: false,
    relocated: false,
    fallback: true,
    previouslyReferenced: false,
  });
}

// keep menuData order for the report
const order = new Map(menuData.items.map((i, idx) => [i.name, idx]));
assignments.sort((a, b) => order.get(a.item) - order.get(b.item));

/* categories + banners */
const catRefs = categories.map((c) => {
  const final = majority(existingCatPath.get(c.id) ?? []) ?? catFallback.get(c.id);
  return { id: c.id, final, changed: strip(final) !== strip(c.imageUrl ?? "") };
});
const bannerRefs = banners.map((b) => {
  let final = strip(b.imageUrl ?? "");
  if (b.id === BANNER_IMAGE_SWAP.bannerId) final = BANNER_IMAGE_SWAP.to;
  return { id: b.id, final, swapped: b.id === BANNER_IMAGE_SWAP.bannerId };
});

/* ------------------------------------------------------------------ */
function onDiskHas(rel) {
  return fs.existsSync(path.join(PUBLIC_DIR, rel));
}

const referenced = new Set([
  ...assignments.map((a) => a.final),
  ...catRefs.map((c) => c.final),
  ...bannerRefs.map((b) => b.final),
]);

const onDisk = walk(MENU_DIR).map((f) => path.relative(PUBLIC_DIR, f).split(path.sep).join("/"));
const orphans = onDisk.filter((f) => !referenced.has(f));
const willBeWritten = new Set([
  ...assignments.filter((a) => a.source).map((a) => a.final),
  ...(fs.existsSync(path.join(STAGE_DIR, "images", ...BANNER_IMAGE_SWAP.staged.split("/")))
    ? [BANNER_IMAGE_SWAP.to]
    : []),
]);
const broken = [...referenced].filter((p) => !onDisk.includes(p) && !willBeWritten.has(p));

/* byte accounting */
const sizeOf = (rel) => fs.statSync(path.join(PUBLIC_DIR, rel)).size;
let bytesBefore = 0;
for (const f of onDisk) bytesBefore += sizeOf(f);
const after = new Map(onDisk.map((f) => [f, sizeOf(f)]));
for (const a of assignments) if (a.source) after.set(a.final, stagedBytes.get(a.source));
if (willBeWritten.has(BANNER_IMAGE_SWAP.to)) {
  after.set(BANNER_IMAGE_SWAP.to, stagedBytes.get(BANNER_IMAGE_SWAP.staged));
}
for (const o of orphans) after.delete(o);
let bytesAfter = 0;
for (const [, v] of after) bytesAfter += v;
const overFileCap = [...after.entries()]
  .filter(([, v]) => v > MAX_FILE)
  .map(([f, v]) => ({ file: f, bytes: v }));

const stagedUsed = new Set(Object.values(ITEM_SOURCE));
const report = {
  generatedAt: new Date().toISOString(),
  applied: APPLY,
  menuDir: "burgonomics-foundation-core/public/images/menu",
  filesBefore: onDisk.length,
  filesAfter: after.size,
  bytesBefore,
  bytesAfter,
  caps: { maxFileBytes: MAX_FILE, maxTotalBytes: MAX_TOTAL, totalOk: bytesAfter <= MAX_TOTAL },
  staged: {
    photos: stagedSet.size,
    bytes: [...stagedBytes.values()].reduce((a, b) => a + b, 0),
    installedForItems: stagedUsed.size,
    unmatchedNotInstalled: STAGED_UNMATCHED,
    unmatchedNote:
      "mapping-report.md section (a): 9 staged photos match no menuData item, so they have no " +
      "menu file to update. MYOB.png is the source the existing banners/myob-banner.png was " +
      "built from; its owner-final bytes are installed at banners/myob-banner.jpg because that " +
      "banner breached the 300KB per-file cap.",
  },
  bannerImageSwap: BANNER_IMAGE_SWAP,
  items: assignments,
  categories: catRefs,
  banners: bannerRefs,
  orphansRemoved: orphans,
  brokenRefs: broken,
  createdBySeed: [...willBeWritten].filter((p) => !onDisk.includes(p)),
  overFileCap,
};

console.log(`files      ${onDisk.length} -> ${after.size}`);
console.log(`bytes      ${bytesBefore} -> ${bytesAfter}  (cap ${MAX_TOTAL}, ${bytesAfter <= MAX_TOTAL ? "OK" : "OVER"})`);
console.log(`replaced   ${assignments.filter((a) => a.source).length} item photos from staged sources`);
console.log(`created    ${report.createdBySeed.join(", ") || "none"}`);
console.log(`relocated  ${assignments.filter((a) => a.relocated).map((a) => a.item).join(", ") || "none"}`);
console.log(`fallback   ${assignments.filter((a) => a.fallback).map((a) => a.item).join(", ") || "none"}`);
console.log(`orphans    ${orphans.length}`);
for (const o of orphans) console.log(`           - ${o}`);
if (broken.length) console.log(`BROKEN     ${broken.join(", ")}`);
if (overFileCap.length) console.log(`OVER-CAP   ${overFileCap.map((x) => `${x.file}=${x.bytes}`).join(", ")}`);

fs.mkdirSync(path.dirname(OUT_REPORT), { recursive: true });
fs.writeFileSync(OUT_REPORT, JSON.stringify(report, null, 2), "utf8");
fs.writeFileSync(
  OUT_IMAGE_MAP,
  JSON.stringify(
    {
      generatedAt: report.generatedAt,
      note: "paths are in Firestore/web form (leading slash), rooted at burgonomics-foundation-core/public/",
      items: Object.fromEntries(assignments.map((a) => [a.item, web(a.final)])),
      categories: Object.fromEntries(catRefs.map((c) => [c.id, web(c.final)])),
      banners: Object.fromEntries(bannerRefs.map((b) => [b.id, web(b.final)])),
    },
    null,
    2,
  ),
  "utf8",
);
console.log(`report     ${path.relative(ROOT, OUT_REPORT)}`);
console.log(`image-map  ${path.relative(ROOT, OUT_IMAGE_MAP)}`);

if (!APPLY) {
  console.log("\nDRY RUN — re-run with --apply to perform the file operations.");
  process.exit(0);
}

/* ------------------------------------------------------------------ *
 * apply
 * ------------------------------------------------------------------ */
for (const a of assignments) {
  if (!a.source) continue;
  const from = path.join(STAGE_DIR, "images", ...a.source.split("/"));
  const to = path.join(PUBLIC_DIR, ...a.final.split("/"));
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}
if (willBeWritten.has(BANNER_IMAGE_SWAP.to)) {
  const from = path.join(STAGE_DIR, "images", ...BANNER_IMAGE_SWAP.staged.split("/"));
  const to = path.join(PUBLIC_DIR, ...BANNER_IMAGE_SWAP.to.split("/"));
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}
for (const o of orphans) fs.rmSync(path.join(PUBLIC_DIR, ...o.split("/")), { force: true });
for (const d of walkDirs(MENU_DIR).sort((a, b) => b.length - a.length)) {
  if (fs.readdirSync(d).length === 0) fs.rmdirSync(d);
}
console.log("\nAPPLIED.");
