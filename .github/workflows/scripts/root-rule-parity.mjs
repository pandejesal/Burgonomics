#!/usr/bin/env node
/**
 * Root-PR rules parity prover for the customer-emulator-harness gate (DEC-09).
 *
 * The root rules PR's firestore.rules must be the EXACT bytes loaded by the
 * pinned customer harness — never a sibling checkout, never a moving default.
 * This script:
 *   1. reads the ROOT PR rules file (its sha256 is the provenance hash),
 *   2. atomically REPLACES the pinned customer-harness checkout's own
 *      firestore.rules with those bytes (the harness checkout is an ephemeral
 *      CI-only copy — no worktree, no source tree is touched),
 *   3. re-hashes the harness file and asserts byte equality with the root PR
 *      hash (fail-closed on any mismatch),
 *   4. writes a parity proof JSON (uploaded as an artifact) and prints
 *      ROOT_RULES_SHA256 / HARNESS_RULES_SHA256 / PARITY lines.
 *
 * Exit codes: 0 parity proven, 2 fail-closed.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

export function assertByteEqual(rootSha, harnessSha) {
  if (rootSha !== harnessSha) {
    throw new Error(
      `rules parity mismatch: root PR ${rootSha} != harness checkout ${harnessSha} — refusing to run the lane on different bytes`,
    );
  }
}

export function copyRootRulesIntoHarness({ rootRulesPath, harnessRulesPath, proofPath }) {
  if (!existsSync(rootRulesPath)) {
    throw new Error(`root PR rules file missing: ${rootRulesPath}`);
  }
  if (!existsSync(harnessRulesPath)) {
    throw new Error(
      `pinned customer harness has no firestore.rules at ${harnessRulesPath} — the pinned commit is not a valid lane harness`,
    );
  }
  const rootSha = sha256File(rootRulesPath);
  const bytes = readFileSync(rootRulesPath);
  // Atomic replace INSIDE the ephemeral harness checkout only.
  const tempPath = `${harnessRulesPath}.root-pr-rules.tmp`;
  writeFileSync(tempPath, bytes);
  renameSync(tempPath, harnessRulesPath);
  const harnessSha = sha256File(harnessRulesPath);
  assertByteEqual(rootSha, harnessSha);
  const proof = {
    rootRulesPath,
    harnessRulesPath,
    rootSha256: rootSha,
    harnessSha256: harnessSha,
    equal: true,
    copiedAt: new Date().toISOString(),
  };
  if (proofPath) {
    writeFileSync(proofPath, `${JSON.stringify(proof, null, 2)}\n`, "utf8");
  }
  return proof;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 1) {
    switch (argv[i]) {
      case "--root-rules":
      case "--harness-rules":
      case "--proof":
        out[argv[i].slice(2)] = argv[i + 1];
        i += 1;
        break;
      default:
        throw new Error(`unknown argument: ${argv[i]}`);
    }
  }
  return out;
}

export function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
    if (!options["root-rules"] || !options["harness-rules"]) {
      process.stderr.write("usage: root-rule-parity.mjs --root-rules <path> --harness-rules <path> [--proof <path>]\n");
      return 2;
    }
    const proof = copyRootRulesIntoHarness({
      rootRulesPath: options["root-rules"],
      harnessRulesPath: options["harness-rules"],
      proofPath: options.proof,
    });
    process.stdout.write(
      `ROOT_RULES_SHA256=${proof.rootSha256}\nHARNESS_RULES_SHA256=${proof.harnessSha256}\nPARITY=equal\nRUNNER_RULES_BYTES=root-pr\n`,
    );
    if (proofPathNeeded(options)) process.stdout.write(`PARITY_PROOF=${options.proof}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`FAIL (fail-closed): ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
}

function proofPathNeeded(options) {
  return Boolean(options.proof);
}

if (process.argv[1] && process.argv[1].endsWith("root-rule-parity.mjs")) {
  process.exit(main(process.argv));
}
