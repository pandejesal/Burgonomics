/**
 * Pure/static tests for .github/workflows/scripts/validate-customer-harness-pin.mjs
 * (DEC-09 root rules × customer-harness gate).
 *
 * Run: node --test .github/workflows/scripts/test/validate-customer-harness-pin.test.mjs
 * No installs, no network, no emulator.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateHarnessPin, validateHarnessPinText, main } from "../validate-customer-harness-pin.mjs";

const SCRIPT = fileURLToPath(new URL("../validate-customer-harness-pin.mjs", import.meta.url));
const VALID = { repo: "pandejesal/Burgonomics-App", commit: "a".repeat(40) };

test("valid pin is accepted and echoed", () => {
  const result = validateHarnessPin({ repo: VALID.repo, commit: VALID.commit });
  assert.deepEqual(result, { ok: true, repo: VALID.repo, commit: VALID.commit });
});

test("invalid JSON text fails closed", () => {
  const result = validateHarnessPinText("{repo: broken");
  assert.equal(result.ok, false);
  assert.match(result.reason, /not valid JSON/);
});

test("missing/extra keys fail closed (exactly {commit, repo})", () => {
  assert.equal(validateHarnessPin({ commit: VALID.commit }).ok, false);
  assert.equal(validateHarnessPin({ repo: VALID.repo }).ok, false);
  assert.equal(validateHarnessPin({ repo: VALID.repo, commit: VALID.commit, pin: "extra" }).ok, false);
});

test("non-object manifests fail closed", () => {
  for (const bad of [null, "x", 17, [VALID]]) assert.equal(validateHarnessPin(bad).ok, false);
});

test("commit rejects moving refs: branches, tags, HEAD, short shas", () => {
  for (const commit of ["main", "master", "latest", "HEAD", "v1.2.3", "1.2.3", "refs/heads/main", "refs/tags/v1", "a".repeat(39), "a".repeat(7)]) {
    assert.equal(validateHarnessPin({ repo: VALID.repo, commit }).ok, false, commit);
  }
});

test("commit rejects uppercase/41-char/non-hex, accepts exactly 40 lowercase hex", () => {
  assert.equal(validateHarnessPin({ repo: VALID.repo, commit: "A".repeat(40) }).ok, false);
  assert.equal(validateHarnessPin({ repo: VALID.repo, commit: "a".repeat(41) }).ok, false);
  assert.equal(validateHarnessPin({ repo: VALID.repo, commit: "g".repeat(40) }).ok, false);
  assert.equal(validateHarnessPin({ repo: VALID.repo, commit: null }).ok, false);
  assert.equal(validateHarnessPin({ repo: VALID.repo, commit: "0123456789abcdef0123456789abcdef01234567" }).ok, true);
});

test("repo rejects malformed owner/name pairs", () => {
  for (const repo of ["pandejesal", "Burgonomics-App", "a b/c", "c/", "/d", "", "owner//name"]) {
    assert.equal(validateHarnessPin({ repo, commit: VALID.commit }).ok, false, `"${repo}" must be rejected`);
  }
  assert.equal(validateHarnessPin({ repo: "pandejesal/Burgonomics-App", commit: VALID.commit }).ok, true);
});

test("CLI: missing manifest file exits 2 with NEEDS_FINAL_HARNESS_SHA guidance", () => {
  const run = spawnSync(process.execPath, [SCRIPT, path.join(os.tmpdir(), "definitely-missing-pin.json")], { encoding: "utf8" });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /NEEDS_FINAL_HARNESS_SHA/);
  assert.match(run.stderr, /not found/);
});

test("CLI: invalid pin exits 2; valid pin exits 0 with GITHUB_OUTPUT lines", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "harness-pin-"));
  const invalidPath = path.join(dir, "invalid.json");
  writeFileSync(invalidPath, JSON.stringify({ repo: "pandejesal/Burgonomics-App", commit: "main" }));
  const invalidRun = spawnSync(process.execPath, [SCRIPT, invalidPath], { encoding: "utf8" });
  assert.equal(invalidRun.status, 2);
  assert.match(invalidRun.stderr, /moving ref/);

  const validPath = path.join(dir, "valid.json");
  writeFileSync(validPath, JSON.stringify(VALID));
  const validRun = spawnSync(process.execPath, [SCRIPT, validPath], { encoding: "utf8" });
  assert.equal(validRun.status, 0);
  assert.match(validRun.stdout, /^repo=pandejesal\/Burgonomics-App\ncommit=[0-9a-f]{40}\n$/);
});

test("CLI without arguments prints usage and exits 2", () => {
  const run = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8" });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /usage:/);
});

test("main() is importable and returns the same contract (pure CLI parity)", () => {
  assert.equal(main(["node", "script", path.join(os.tmpdir(), "no-such-file.json")]), 2);
});
