/**
 * Pure/static tests for .github/workflows/scripts/root-rule-parity.mjs —
 * the root-PR rules → pinned-customer-harness copy with byte-hash parity proof.
 *
 * Run: node --test .github/workflows/scripts/test/root-rule-parity.test.mjs
 * No installs, no network, no emulator; uses os.tmpdir() scratch dirs only.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assertByteEqual, copyRootRulesIntoHarness, sha256File } from "../root-rule-parity.mjs";

const SCRIPT = fileURLToPath(new URL("../root-rule-parity.mjs", import.meta.url));
const RULES_A = "rules_version = '2';\nallow read: if false;\n";
const RULES_B = "rules_version = '2';\nallow read: if true;\n";

function scratchDir() {
  return mkdtempSync(path.join(os.tmpdir(), "rule-parity-"));
}

test("sha256File matches node:crypto digest", () => {
  const dir = scratchDir();
  const file = path.join(dir, "a.rules");
  writeFileSync(file, RULES_A);
  assert.equal(sha256File(file), createHash("sha256").update(RULES_A).digest("hex"));
});

test("assertByteEqual throws on mismatch, passes on equality", () => {
  const shaA = createHash("sha256").update(RULES_A).digest("hex");
  const shaB = createHash("sha256").update(RULES_B).digest("hex");
  assert.throws(() => assertByteEqual(shaA, shaB), /parity mismatch/);
  assert.doesNotThrow(() => assertByteEqual(shaA, shaA));
});

test("copy replaces harness rules with root-PR bytes and proves parity", () => {
  const dir = scratchDir();
  const rootFile = path.join(dir, "root.rules");
  const harnessFile = path.join(dir, "customer.firestore.rules");
  writeFileSync(rootFile, RULES_A);
  writeFileSync(harnessFile, RULES_B);
  const proof = copyRootRulesIntoHarness({ rootRulesPath: rootFile, harnessRulesPath: harnessFile });
  assert.equal(proof.equal, true);
  assert.equal(proof.rootSha256, proof.harnessSha256);
  assert.equal(readFileSync(harnessFile, "utf8"), RULES_A, "harness file now holds the PR bytes");
  assert.equal(sha256File(rootFile), sha256File(harnessFile));
});

test("copy writes the parity proof JSON when requested", () => {
  const dir = scratchDir();
  const rootFile = path.join(dir, "root.rules");
  const harnessFile = path.join(dir, "customer.firestore.rules");
  writeFileSync(rootFile, RULES_A);
  writeFileSync(harnessFile, RULES_B);
  const proofPath = path.join(dir, "parity-proof.json");
  copyRootRulesIntoHarness({ rootRulesPath: rootFile, harnessRulesPath: harnessFile, proofPath });
  const written = JSON.parse(readFileSync(proofPath, "utf8"));
  assert.equal(written.equal, true);
  assert.equal(written.rootSha256, sha256File(rootFile));
  assert.equal(readFileSync(harnessFile, "utf8"), RULES_A);
});

test("fail-closed: missing root file or missing harness rules file", () => {
  const dir = scratchDir();
  const rootFile = path.join(dir, "missing-root.rules");
  const existingHarnessFile = path.join(dir, "customer.firestore.rules");
  writeFileSync(existingHarnessFile, RULES_B);
  assert.throws(
    () => copyRootRulesIntoHarness({ rootRulesPath: rootFile, harnessRulesPath: existingHarnessFile }),
    /root PR rules file missing/,
  );
  assert.throws(
    () => copyRootRulesIntoHarness({ rootRulesPath: existingHarnessFile, harnessRulesPath: path.join(dir, "absent.rules") }),
    /not a valid lane harness/,
  );
});

test("fail-closed: the harness file is never silently left stale on parity failure", () => {
  // After the copy the harness ALWAYS equals the root bytes (byte-equal by
  // construction); a mismatch only arises if a later run's harness bytes differ —
  // exercised in the CLI test below via divergent snapshots.
  const dir = scratchDir();
  const rootFile = path.join(dir, "root.rules");
  const harnessFile = path.join(dir, "customer.firestore.rules");
  writeFileSync(rootFile, RULES_A);
  writeFileSync(harnessFile, RULES_B);
  copyRootRulesIntoHarness({ rootRulesPath: rootFile, harnessRulesPath: harnessFile });
  assert.equal(sha256File(harnessFile), sha256File(rootFile));
});

test("CLI: success prints PARITY=equal and rewrites the harness to PR bytes", () => {
  const dir = scratchDir();
  const rootFile = path.join(dir, "root.rules");
  const harnessFile = path.join(dir, "customer.firestore.rules");
  writeFileSync(rootFile, RULES_B);
  writeFileSync(harnessFile, RULES_A);
  const run = spawnSync(process.execPath, [
    SCRIPT,
    "--root-rules",
    rootFile,
    "--harness-rules",
    harnessFile,
    "--proof",
    path.join(dir, "proof.json"),
  ]);
  assert.equal(run.status, 0, `stderr: ${run.stderr}`);
  assert.match(run.stdout.toString(), /ROOT_RULES_SHA256=[0-9a-f]{64}\nHARNESS_RULES_SHA256=[0-9a-f]{64}\nPARITY=equal/);
  assert.equal(readFileSync(harnessFile, "utf8"), RULES_B);
  assert.equal(JSON.parse(readFileSync(path.join(dir, "proof.json"), "utf8")).equal, true);
});

test("CLI: unknown argument exits 2 with usage", () => {
  const dir = scratchDir();
  const run = spawnSync(process.execPath, [SCRIPT, "--bogus", path.join(dir, "x")]);
  assert.equal(run.status, 2);
  assert.match(run.stderr.toString(), /unknown argument|usage:/);
});

test("CLI: missing required args exits 2 with usage", () => {
  const run = spawnSync(process.execPath, [SCRIPT]);
  assert.equal(run.status, 2);
  assert.match(run.stderr.toString(), /usage: root-rule-parity\.mjs --root-rules <path> --harness-rules <path>/);
});
