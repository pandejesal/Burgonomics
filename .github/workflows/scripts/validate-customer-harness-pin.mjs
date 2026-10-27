#!/usr/bin/env node
/**
 * Strict validator for .github/customer-emulator-harness.json (DEC-09).
 *
 * The root rules gate must test the PR's firestore.rules against an IMMUTABLE
 * pinned customer-harness commit. The manifest therefore holds exactly:
 *   { "repo": "<owner>/<name>", "commit": "<40 lowercase hex chars>" }
 * Moving refs (branches, tags, short SHAs, HEAD) are forbidden; anything else
 * (missing file, invalid JSON, wrong keys) fails CLOSED with the
 * NEEDS_FINAL_HARNESS_SHA guidance — the parent/coordinator must publish the
 * real final published customer SHA before root rules PRs can pass.
 *
 * On success it prints `repo=…` / `commit=…` lines for GitHub Actions'
 * `>> "$GITHUB_OUTPUT"` capture. Exit codes: 0 valid, 2 fail-closed.
 */
import { readFileSync } from "node:fs";

export const NEEDS_FINAL_HARNESS_SHA =
  "NEEDS_FINAL_HARNESS_SHA: a final, immutable customer-harness commit SHA has not been " +
  "published yet. The coordinator must write the real 40-hex commit into " +
  ".github/customer-emulator-harness.json (repo + commit) before root rules PRs may pass " +
  "this gate. No moving ref, sibling checkout, or baseline/SHA-less fallback is permitted.";

const HEX40 = /^[0-9a-f]{40}$/;
const OWNER_REPO = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/;
/** Typical moving refs: branches, tags, HEAD, or a SHORT sha (7..39 hex). */
const MOVING_REF_PATTERNS = [/^(?:main|master|latest)$/i, /^refs\//i, /^head$/i, /^v?\d+(?:\.\d+)*$/, /^[0-9a-f]{7,39}$/];

export function validateHarnessPin(parsed) {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "manifest must be a JSON object with exactly the keys {commit, repo}" };
  }
  const keys = Object.keys(parsed).sort();
  if (keys.length !== 2 || keys[0] !== "commit" || keys[1] !== "repo") {
    return { ok: false, reason: `manifest keys must be exactly ["commit","repo"] (sorted), got: [${keys.join(", ")}]` };
  }
  const repo = parsed.repo;
  const commit = parsed.commit;
  if (typeof repo !== "string" || !OWNER_REPO.test(repo)) {
    return { ok: false, reason: `manifest.repo must be a strict 'owner/name' pair, got: ${JSON.stringify(repo)}` };
  }
  if (typeof commit !== "string") {
    return { ok: false, reason: "manifest.commit must be a string holding 40 lowercase hex chars" };
  }
  for (const pattern of MOVING_REF_PATTERNS) {
    if (pattern.test(commit)) {
      return {
        ok: false,
        reason: `manifest.commit "${commit}" looks like a moving ref (branch/tag/short sha); only an immutable 40-hex commit SHA is accepted`,
      };
    }
  }
  if (!HEX40.test(commit)) {
    return { ok: false, reason: `manifest.commit must be exactly 40 lowercase hex chars, got length ${commit.length}` };
  }
  return { ok: true, repo, commit };
}

export function validateHarnessPinText(jsonText) {
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    return { ok: false, reason: `manifest is not valid JSON: ${err.message}` };
  }
  return validateHarnessPin(parsed);
}

export function main(argv) {
  const file = argv[2];
  if (!file) {
    process.stderr.write("usage: validate-customer-harness-pin.mjs <manifest-path>\n");
    return 2;
  }
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    process.stderr.write(`FAIL (fail-closed): manifest not found at ${file}\n${NEEDS_FINAL_HARNESS_SHA}\n`);
    return 2;
  }
  const result = validateHarnessPinText(text);
  if (!result.ok) {
    process.stderr.write(`FAIL (fail-closed): ${result.reason}\npath: ${file}\n${NEEDS_FINAL_HARNESS_SHA}\n`);
    return 2;
  }
  process.stdout.write(`repo=${result.repo}\ncommit=${result.commit}\n`);
  return 0;
}

if (process.argv[1] && process.argv[1].endsWith("validate-customer-harness-pin.mjs")) {
  process.exit(main(process.argv));
}
