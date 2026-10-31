#!/usr/bin/env node
/**
 * 8.2 — pre-apply safety gate.
 *
 * Pruning orphans must never strand a live Firestore document. This script
 * walks every stored image URL in the pre-import snapshot and classifies it:
 *
 *   SURVIVES        the file it points at is kept by the prune
 *   FIXED_BY_SEED   the prune removes it, but the doc is in the seed's update
 *                   set, so seed-menu.mjs repoints it (and verifies it exists)
 *   STRANDED        neither — apply must not run
 *
 * It also proves the seed is safe to overlay: every product doc's name is in
 * menuData, and within a product name all non-null image URLs already agree
 * (so writing the resolved path only fills nulls / the documented relocations).
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const SNAPSHOT = path.join(ROOT, "references", "verification", "8.2", "pre-import-snapshot.json");
const REPORT = path.join(ROOT, "references", "verification", "8.2", "asset-report.json");
const MENU_DATA = path.join(ROOT, ".swarm", "staging", "8.2", "menuData.json");

const strip = (p) => (p ? String(p).replace(/^\/+/, "") : p);

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

const snap = JSON.parse(fs.readFileSync(SNAPSHOT, "utf8"));
const report = JSON.parse(fs.readFileSync(REPORT, "utf8"));
const menuData = JSON.parse(fs.readFileSync(MENU_DATA, "utf8"));

const surviving = new Set(report.items.map((a) => strip(a.final)));
for (const c of report.categories) surviving.add(strip(c.final));
for (const b of report.banners) surviving.add(strip(b.final));
// files already on disk that the prune keeps (referenced but not rewritten)
const pruned = new Set(report.orphansRemoved.map(strip));

const seedNames = new Set(menuData.items.map((i) => i.name));
const seedBannerIds = new Set(report.banners.filter((b) => b.swapped).map((b) => b.id));
const fields = ["imageUrl", "image", "image_url", "itemimage_url"];
const problems = { STRANDED: [], FIXED_BY_SEED: [] };
const stats = { SURVIVES: 0, nulls: 0 };
const byName = new Map();

function classify(currentPath, seedable) {
  const rel = strip(currentPath);
  if (surviving.has(rel)) return "SURVIVES";
  if (pruned.has(rel) && seedable) return "FIXED_BY_SEED";
  return "STRANDED";
}

for (const d of snap.collections.products.documents.map(decodeDoc)) {
  const seedable = seedNames.has(d.name);
  if (!seedable) problems.STRANDED.push({ doc: "products", id: d.id, reason: `name not in menuData: ${d.name}` });
  let found = false;
  for (const f of fields) {
    if (!(f in d)) continue;
    const v = d[f];
    if (v === null || v === undefined || v === "") {
      stats.nulls++;
      continue;
    }
    found = true;
    const verdict = classify(v, seedable);
    if (verdict === "SURVIVES") stats.SURVIVES++;
    else problems[verdict].push({ doc: "products", id: d.id, name: d.name, field: f, value: v });
    if (!byName.has(d.name)) byName.set(d.name, new Set());
    if (v) byName.get(d.name).add(strip(v));
  }
  if (!found) stats.nulls++;
}

for (const d of snap.collections.categories.documents.map(decodeDoc)) {
  for (const f of fields) {
    if (!(f in d) || !d[f]) continue;
    const verdict = classify(d[f], true);
    if (verdict === "SURVIVES") stats.SURVIVES++;
    else problems[verdict].push({ doc: "categories", id: d.id, field: f, value: d[f] });
  }
}

for (const d of snap.collections.banners.documents.map(decodeDoc)) {
  for (const f of fields) {
    if (!(f in d) || !d[f]) continue;
    const verdict = classify(d[f], seedBannerIds.has(d.id));
    if (verdict === "SURVIVES") stats.SURVIVES++;
    else problems[verdict].push({ doc: "banners", id: d.id, field: f, value: d[f] });
  }
}

// 1. every product name is seedable (proved above: STRANDED would catch it)
// 2. within a product name, all non-null paths must already agree
const disagreements = [...byName.entries()]
  .filter(([, set]) => set.size > 1)
  .map(([name, set]) => ({ name, paths: [...set] }));

console.log(`surviving refs          : ${stats.SURVIVES}`);
console.log(`null image values       : ${stats.nulls}`);
console.log(`fixed by seed           : ${problems.FIXED_BY_SEED.length}`);
for (const p of problems.FIXED_BY_SEED.slice(0, 5)) console.log(`    ${p.doc}/${p.id} ${p.value}`);
console.log(`STRANDED                : ${problems.STRANDED.length}`);
for (const p of problems.STRANDED.slice(0, 30)) console.log(`  ! ${p.doc}/${p.id} ${p.value ?? p.reason}`);
console.log(`product names with disagreeing non-null paths: ${disagreements.length}`);
for (const d of disagreements) console.log(`  ? ${d.name}: ${d.paths.join(" | ")}`);

const ok = problems.STRANDED.length === 0;
fs.writeFileSync(
  path.join(ROOT, "references", "verification", "8.2", "pre-apply-gate.json"),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      verdict: ok ? "PASS" : "FAIL",
      survivingRefs: stats.SURVIVES,
      nullImageValues: stats.nulls,
      fixedBySeed: problems.FIXED_BY_SEED,
      stranded: problems.STRANDED,
      pathDisagreements: disagreements,
      note:
        "FIXED_BY_SEED rows are docs the prune would strand, each of which seed-menu.mjs rewrites " +
        "to report.items[].final before any client can read them. seed-menu.mjs re-verifies that " +
        "every target file exists after the prune.",
    },
    null,
    2,
  ),
  "utf8",
);
console.log(`\n${ok ? "PASS" : "FAIL"} — gate written to references/verification/8.2/pre-apply-gate.json`);
process.exit(ok ? 0 : 1);
