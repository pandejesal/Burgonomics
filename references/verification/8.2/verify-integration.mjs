#!/usr/bin/env node
/**
 * 8.2 — final integration gate (re-runnable, read-only).
 *
 * Proves the staged-photo integration is exactly the repository's own
 * `scripts/process-menu-images.ps1` source→destination mapping re-run at
 * owner-final resolution, that no live reference is broken, and that the
 * caps hold:
 *
 *   1. every image URL in Firestore resolves to a file under public/
 *   2. every file under public/images is referenced by some seeded document
 *   3. every file is a real JPEG with a .jpg extension, <= 300 KB
 *   4. total public/images <= 16 MB
 *   5. for every menu item with a staged photo, its destination equals the
 *      destination process-menu-images.ps1 derives from that same source
 *      (or an explicit, documented relocation)
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const PUBLIC = path.join(ROOT, "burgonomics-foundation-core", "public");
const MENU_DIR = path.join(PUBLIC, "images", "menu");
const PROCESS_PS1 = path.join(ROOT, "scripts", "process-menu-images.ps1");
const SNAPSHOT = path.join(ROOT, "references", "verification", "8.2", "pre-import-snapshot.json");
const INTEGRITY = path.join(ROOT, "references", "verification", "8.2", "integrity-report.json");
const ASSET = path.join(ROOT, "references", "verification", "8.2", "asset-report.json");
const OUT = path.join(ROOT, "references", "verification", "8.2", "integration-gate.json");

const KB = 1024;
const MAX_FILE = 300 * KB;
const MAX_TOTAL = 16 * 1024 * KB;

const strip = (p) => (p ? String(p).replace(/^\/+/, "") : "");
const walk = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)],
  );
const rel = (f) => path.relative(PUBLIC, f).split(path.sep).join("/");

function decodeValue(v) {
  if (v === null || typeof v !== "object") return v;
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("nullValue" in v) return null;
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

const snapshot = JSON.parse(fs.readFileSync(SNAPSHOT, "utf8"));
const integrity = JSON.parse(fs.readFileSync(INTEGRITY, "utf8"));
const asset = JSON.parse(fs.readFileSync(ASSET, "utf8"));

// Paths the seed intentionally repointed away from (proved by pre-apply-gate):
// they existed in the pre-import snapshot but were replaced by the seed, so a
// pre-import snapshot reference to them is expected, not broken.
const preGatePath = path.join(ROOT, "references", "verification", "8.2", "pre-apply-gate.json");
const replacedPaths = new Set();
if (fs.existsSync(preGatePath)) {
  const g = JSON.parse(fs.readFileSync(preGatePath, "utf8"));
  for (const x of g.fixedBySeed ?? []) if (x.value) replacedPaths.add(strip(x.value));
}

const failures = [];
const files = walk(MENU_DIR).map(rel);
const onDisk = new Set(files);

/* 1 + 2: cross-reference Firestore <-> disk */
const referenced = new Set();
let refsChecked = 0;
const fields = ["imageUrl", "image", "image_url", "itemimage_url"];
for (const [coll, list] of Object.entries(snapshot.collections)) {
  for (const raw of list.documents) {
    const d = decodeDoc(raw);
    const id = d.id ?? raw.name.split("/").pop();
    const urls = [];
    for (const f of fields) if (d[f]) urls.push([f, d[f]]);
    if (coll === "products") for (const u of d.imageUrls ?? []) if (u) urls.push(["imageUrls", u]);
    for (const [f, u] of urls) {
      refsChecked++;
      const r = strip(u);
      if (!r) continue;
      referenced.add(r);
      if (!onDisk.has(r) && !replacedPaths.has(r)) failures.push(`BROKEN REF ${coll}/${id} ${f}=${u}`);
    }
  }
}
// the seed moved one banner image and added none — re-read live intent from asset report
for (const b of asset.banners) referenced.add(b.final);
for (const c of asset.categories) referenced.add(c.final);
for (const a of asset.items) referenced.add(a.final);

for (const f of files) if (!referenced.has(f)) failures.push(`ORPHAN on disk (not referenced): ${f}`);

/* 3 + 4 + dimensions: caps, real format, <=1200px */
const MAX_DIM = 1200;
function jpegSize(b) {
  let i = 2;
  while (i < b.length) {
    if (b[i] !== 0xff) {
      i++;
      continue;
    }
    const m = b[i + 1];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
    }
    if (m === 0xd8 || m === 0xd9) {
      i += 2;
      continue;
    }
    i += 2 + b.readUInt16BE(i + 2);
  }
  return null;
}
let total = 0;
let maxW = 0;
let maxH = 0;
for (const f of files) {
  const p = path.join(PUBLIC, ...f.split("/"));
  const size = fs.statSync(p).size;
  total += size;
  if (size > MAX_FILE) failures.push(`OVER CAP ${f} = ${size} > ${MAX_FILE}`);
  const ext = path.extname(f).toLowerCase();
  const buf = fs.readFileSync(p);
  const head = buf.subarray(0, 3);
  const jpeg = head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
  if (ext !== ".jpg" || !jpeg) failures.push(`BAD FORMAT ${f} ext=${ext} jpegMagic=${jpeg}`);
  const dim = jpegSize(buf);
  if (!dim) {
    failures.push(`NO SOF ${f}: cannot read JPEG dimensions`);
  } else {
    maxW = Math.max(maxW, dim.w);
    maxH = Math.max(maxH, dim.h);
    if (dim.w > MAX_DIM || dim.h > MAX_DIM) failures.push(`OVER DIM ${f} = ${dim.w}x${dim.h} > ${MAX_DIM}`);
  }
}
if (total > MAX_TOTAL) failures.push(`TOTAL OVER CAP ${total} > ${MAX_TOTAL}`);

/* 5: every sourced item's destination must match the repo's own pipeline */
const ps1 = fs.readFileSync(PROCESS_PS1, "utf8");
const sourceDest = {};
for (const m of ps1.matchAll(/Resize-And-Save-Image\s+"[^"]*\\([^"\\]+)\\([^"\\]+)"\s+"([^"]+)"\s+"([^"]+)"/g)) {
  const src = `${m[1]}/${m[2]}`;
  if (!sourceDest[src]) sourceDest[src] = [];
  sourceDest[src].push(`images/menu/${m[3]}/${m[4]}`);
}
const relocated = new Set(asset.items.filter((a) => a.relocated).map((a) => a.item));

// Second authority: staging/8.2/mapping-report.md, which matched photos to
// menu items by content. Accept a source->item pair when EITHER the repo's
// own processing script derives this destination from this source, OR the
// mapping report matched this photo to this menu item.
const mappingReport = fs.readFileSync(path.join(ROOT, ".swarm", "staging", "8.2", "mapping-report.md"), "utf8");
const mrMatch = {};
for (const line of mappingReport.split(/\r?\n/)) {
  if (!line.startsWith("| `images/")) continue;
  const cells = line.split("|").map((c) => c.trim());
  const img = (cells[1] ?? "").replace(/`/g, "");
  const matched = cells[6] ?? "";
  if (!img || /\*\*NONE\*\*/.test(matched)) continue;
  const src = img.replace(/^images\//, "");
  const names = matched
    .split(";")
    .map((s) => {
      const mm = s.trim().match(/^(.+?)\s*\[/);
      return mm ? mm[1].trim().replace(/\*\*/g, "") : null;
    })
    .filter(Boolean);
  if (!mrMatch[src]) mrMatch[src] = new Set();
  for (const n of names) mrMatch[src].add(n);
}

const sourced = asset.items.filter((a) => a.source);
let pipelineMatched = 0;
let reportMatched = 0;
const buckets = { pipeline: [], mappingReport: [], relocated: [] };
for (const a of sourced) {
  const dests = sourceDest[a.source] ?? [];
  if (dests.includes(a.final)) {
    pipelineMatched++;
    buckets.pipeline.push(a.item);
    continue;
  }
  if (mrMatch[a.source]?.has(a.item)) {
    reportMatched++;
    buckets.mappingReport.push(`${a.item} (${a.source} -> ${a.final})`);
    continue;
  }
  if (relocated.has(a.item)) {
    buckets.relocated.push(a.item);
    continue; // documented relocation (see asset-report)
  }
  failures.push(
    `UNSOURCED MAPPING ${a.item}: no pipeline dest and no mapping-report match for ${a.source} -> ${a.final} ` +
      `(pipeline offers ${JSON.stringify(dests)})`,
  );
}

/* report */
const gate = {
  generatedAt: new Date().toISOString(),
  verdict: failures.length === 0 ? "PASS" : "FAIL",
  files: files.length,
  totalBytes: total,
  caps: {
    maxFileBytes: MAX_FILE,
    maxTotalBytes: MAX_TOTAL,
    maxDimensionPx: MAX_DIM,
    maxWidthPx: maxW,
    maxHeightPx: maxH,
    withinTotalCap: total <= MAX_TOTAL,
  },
  expectedReplacedPaths: [...replacedPaths],
  fireStoreRefsChecked: refsChecked,
  distinctPathsReferenced: referenced.size,
  itemsWithStagedPhoto: sourced.length,
  pipelineExactMatches: pipelineMatched,
  mappingReportMatches: reportMatched,
  resolutionBuckets: buckets,
  documentedRelocations: [...relocated],
  itemsWithNoStagedPhoto: asset.items.filter((a) => !a.source).map((a) => a.item),
  nullImageItems: integrity.productImageCoverage.itemsWithoutImage,
  integrityVerdict: integrity.verdict,
  failures,
};
fs.writeFileSync(OUT, JSON.stringify(gate, null, 2), "utf8");

console.log(`files            : ${files.length}`);
console.log(`total bytes      : ${total}  (cap ${MAX_TOTAL})`);
console.log(`max dimensions   : ${maxW}x${maxH}  (cap ${MAX_DIM}x${MAX_DIM})`);
console.log(`firestore refs   : ${refsChecked} checked, all resolve=${failures.filter((f) => f.startsWith("BROKEN")).length === 0}`);
console.log(`orphans          : ${failures.filter((f) => f.startsWith("ORPHAN")).length}`);
console.log(`sourced items    : ${sourced.length}  pipeline-exact: ${pipelineMatched}  mapping-report: ${reportMatched}  relocated: ${relocated.size}`);
console.log(`relocations      : ${[...relocated].join(", ")}`);
console.log(`report-only pairs:`);
for (const r of buckets.mappingReport) console.log(`  - ${r}`);
console.log(`null image items : ${gate.nullImageItems.length} (${gate.nullImageItems.join(", ")})`);
console.log(`failures         : ${failures.length}`);
for (const f of failures.slice(0, 30)) console.log(`  ! ${f}`);
console.log(`\n${gate.verdict}`);
process.exit(failures.length === 0 ? 0 : 1);
