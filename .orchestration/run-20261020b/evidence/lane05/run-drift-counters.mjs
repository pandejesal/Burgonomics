#!/usr/bin/env node
/**
 * lane05 — deterministic counter-test harness for verify-doc-code-drift.mjs.
 * Builds every control variant itself (node string splicing, so no shell/em-dash
 * mangling), runs the probe against each, and asserts the expected exit code.
 *
 * Run from anywhere:  node run-drift-counters.mjs
 * Writes: probe-counter-tests-<date>.txt next to this file.
 */
import { readFileSync, writeFileSync, mkdirSync, cpSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../../..");
const PROBE = path.join(HERE, "verify-doc-code-drift.mjs");
const DOC = path.join(ROOT, "references/delivery_routing.md");
const TMP = path.join(os.tmpdir(), "lane05-counters");
mkdirSync(TMP, { recursive: true });

const doc = readFileSync(DOC, "utf8");
// The pre-fix control must be SYNTHETIC, not `git show HEAD:...` — once this bundle is
// committed, HEAD contains the fixed doc and a git-based control silently becomes a
// duplicate of the positive run (observed at commit 4787e8d). Re-inserting the original
// universal-claim bullet is stable across commits and clones.
const ORIGINAL_BULLET =
  "   - **Ambiguous is never transient.** A provider returning 2xx with no usable order id has *accepted* the request; the delivery may already exist. That case throws a **plain** (non-`ProviderDispatchError`) `502 PROVIDER_BOOK_AMBIGUOUS`, so the router releases the claim and stops instead of walking to the next rider and booking a second real courier for one order. Same rule for all three providers (Borzo, Porter, Shadowfax) — see `functions/src/modules/dispatch/providers/shared.ts`.";
const BLOCK = /   - \*\*Ambiguous is never transient\.\*\*[\s\S]*?pointed at `shared\.ts` incorrectly\./;
if (!BLOCK.test(doc)) {
  console.error("FATAL: could not locate the ambiguity block to build the pre-fix control");
  process.exit(2);
}
const vOldDoc = doc.replace(BLOCK, ORIGINAL_BULLET);

// Variant 1: paraphrased universal claim in a new sentence.
const vUniversal = doc + "\n\nThis rule holds for Borzo, Shadowfax AND Porter.\n";
// Variant 2: "extends to Porter too" (found by the GLM verifier).
const vExtends = doc + "\n\nThe no-failover guarantee extends to Porter too.\n";
// Variant 3: "Porter preserves the ambiguous-book contract" (found by the GLM verifier).
const vPreserves = doc + "\n\nPorter preserves the ambiguous-book contract.\n";
// Variant 4: the deviation note replaced by a false resolution claim.
const i = doc.indexOf("KNOWN DEVIATION");
const j = doc.indexOf(".**", i);
const vFalseResolution =
  doc.slice(0, i) +
  "KNOWN DEVIATION (historical): resolved; Porter is now fully compliant and reraises the plain error" +
  doc.slice(j + 3);

const variants = [
  { name: "positive-working-tree-doc", doc: null, repo: ROOT, expect: 0 },
  { name: "negative-original-universal-wording", doc: vOldDoc, repo: ROOT, expect: 1 },
  { name: "negative-paraphrased-universal", doc: vUniversal, repo: ROOT, expect: 1 },
  { name: "negative-extends-to-porter-too", doc: vExtends, repo: ROOT, expect: 1 },
  { name: "negative-porter-preserves-contract", doc: vPreserves, repo: ROOT, expect: 1 },
  { name: "negative-false-resolution-note", doc: vFalseResolution, repo: ROOT, expect: 1 },
];

// Variant: code fixed (tag preserved) but the doc left stale.
const fakeRepo = path.join(TMP, "fakerepo");
for (const rel of [
  "functions/src/modules/dispatch/providers/porter.adapter.ts",
  "functions/src/modules/dispatch/providers/borzo.adapter.ts",
  "functions/src/modules/dispatch/providers/shadowfax.adapter.ts",
  "functions/src/modules/porter/porter.service.ts",
  "functions/src/modules/dispatch/dispatch.router.ts",
  "references/delivery_routing.md",
]) {
  const dest = path.join(fakeRepo, rel);
  mkdirSync(path.dirname(dest), { recursive: true });
  cpSync(path.join(ROOT, rel), dest);
}
const fakeAdapter = path.join(fakeRepo, "functions/src/modules/dispatch/providers/porter.adapter.ts");
let adapterSrc = readFileSync(fakeAdapter, "utf8");
adapterSrc = adapterSrc.replace(
  /if \(err\?\.statusCode === 404/,
  "if (err?.code === 'PROVIDER_BOOK_AMBIGUOUS') { throw err; }\n      if (err?.statusCode === 404"
);
if (!/err\?\.code === 'PROVIDER_BOOK_AMBIGUOUS'/.test(adapterSrc)) {
  console.error("FATAL: could not patch the synthetic porter.adapter.ts — the anchor line moved");
  process.exit(2);
}
writeFileSync(fakeAdapter, adapterSrc);
variants.push({ name: "negative-code-fixed-doc-stale", doc: null, repo: fakeRepo, expect: 1 });

let log = `lane05 drift-probe counter tests\nprobe: ${path.relative(ROOT, PROBE)}\nran: ${new Date().toISOString()}\n\n`;
let failures = 0;
for (const v of variants) {
  const docPath = v.doc === null ? null : path.join(TMP, `${v.name}.md`);
  if (docPath) writeFileSync(docPath, v.doc);
  const args = ["--repo", v.repo];
  if (docPath) args.push("--doc", docPath);
  let out = "";
  let code = 0;
  try {
    out = execFileSync(process.execPath, [PROBE, ...args], { encoding: "utf8" });
  } catch (err) {
    out = String(err.stdout || "");
    code = err.status ?? 1;
  }
  const ok = code === v.expect;
  if (!ok) failures++;
  log += `### ${v.name}\n${out}\nexit=${code} (expected ${v.expect}) ${ok ? "OK" : "MISMATCH"}\n\n`;
}
const summary =
  failures === 0
    ? "ALL COUNTER TESTS OK — every negative variant exits non-zero, the positive exits 0"
    : `${failures} COUNTER TEST(S) DID NOT BEHAVE AS EXPECTED`;
log += summary + "\n";
const outFile = path.join(HERE, `probe-counter-tests-${new Date().toISOString().slice(0, 10)}.txt`);
writeFileSync(outFile, log);
process.stdout.write(execFileSync(process.execPath, ["-e", "0"], { encoding: "utf8" }));
console.log(log.match(/exit=\d+ \(expected \d+\) (OK|MISMATCH)/g).join("\n"));
console.log(summary);
console.log(`written: ${outFile}`);
process.exit(failures === 0 ? 0 : 1);
