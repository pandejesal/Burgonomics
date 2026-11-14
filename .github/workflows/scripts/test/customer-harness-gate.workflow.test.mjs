/**
 * Static (pure) contract test for .github/workflows/customer-emulator-harness-gate.yml
 * — DEC-09 root rules × pinned-customer-harness required PR check.
 *
 * Always-on checks are structural (string level on real content, comments
 * stripped); the deep YAML syntax check runs only when an existing local YAML
 * parser (`yaml`, else `js-yaml` with JSON_SCHEMA) is resolvable — no installs.
 *
 * Two deliberately separate kinds of proof about the pinned-tool wiring:
 *   1. STATIC configuration assertions — does the workflow's routing step
 *      physically link both pinned packages into customer-harness/node_modules
 *      (so the sanitised lane child never needs NODE_PATH)? Proven by reading
 *      the real YAML text, plus negative fixtures that must be rejected.
 *   2. RUNTIME resolver proof — a real Node child, same module-resolution rules
 *      as the lane, resolving synthetic pinned packages through harness-relative
 *      links with NODE_PATH absent, and failing MODULE_NOT_FOUND without them.
 *      This proves the mechanism, NOT that the remote workflow executed it.
 *
 * Run: node --test .github/workflows/scripts/test/customer-harness-gate.workflow.test.mjs
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..", "..");
const WORKFLOW_REL = ".github/workflows/customer-emulator-harness-gate.yml";
/** LF-normalized: CI checks out LF, Windows dev checkouts use CRLF; assertions
 *  must describe the same workflow, not the platform's line ending. */
const WORKFLOW = readFileSync(path.join(REPO_ROOT, WORKFLOW_REL), "utf8").replace(/\r\n?/g, "\n");

/** Narrowly scoped: the two reviewable scripts, each one responsibility. */
const SCRIPTS = {
  validator: ".github/workflows/scripts/validate-customer-harness-pin.mjs",
  parity: ".github/workflows/scripts/root-rule-parity.mjs",
};

/** gh-verified official commit SHAs (2026-10-27), shared with the validator tests. */
const PINNED_ACTIONS = {
  "actions/checkout": "11d5960a326750d5838078e36cf38b85af677262",
  "actions/setup-node": "49933ea5288caeca8642d1e84afbd3f7d6820020",
  "actions/setup-java": "cf277c60eb25467037889841efdb72551f06f6c3",
  "actions/upload-artifact": "ea165f8d65b6e75b540449e92b4886f43607fa02",
};

const REQUIRED_PATHS = [
  "firestore.rules",
  "firebase.json",
  "firestore.indexes.json",
  ".firebaserc",
  "functions/**",
  ".github/customer-emulator-harness.json",
  ".github/workflows/**",
];

for (const scriptPath of Object.values(SCRIPTS)) {
  // referenced but not loaded here; loaded by its own unit tests
}

function stripComments(text) {
  return text
    .split("\n")
    .filter((line) => line.trimStart()[0] !== "#")
    .join("\n");
}

const CODE = stripComments(WORKFLOW);

function loadYamlParser() {
  const req = createRequire(import.meta.url);
  const paths = [
    path.join(REPO_ROOT, "node_modules"),
    ...String(process.env.NODE_PATH ?? "").split(path.delimiter).filter(Boolean),
  ];
  for (const name of ["yaml", "js-yaml"]) {
    try {
      // Resolve the package entry point as the package declares it (main /
      // exports), never a hardcoded index.js: yaml@2 ships dist/index.js.
      const entry = req.resolve(name, { paths });
      const pkgPath = req.resolve(`${name}/package.json`, { paths });
      const pkgJson = JSON.parse(readFileSync(pkgPath, "utf8"));
      return { name: pkgJson.name ?? name, version: pkgJson.version, entry, mod: req(entry) };
    } catch {
      /* next candidate */
    }
  }
  return null;
}

/** Slices one workflow step by its `name:` marker, up to the next step. */
function stepBlock(name) {
  const marker = `      - name: ${name}\n`;
  const start = CODE.indexOf(marker);
  if (start < 0) return null;
  const rest = CODE.slice(start + marker.length);
  const next = rest.indexOf("\n      - ");
  return next < 0 ? rest : rest.slice(0, next);
}

const HARNESS_NODE_MODULES = "customer-harness/node_modules";
const PINNED_PREFIX = "$RUNNER_TEMP/ci-tool/node_modules";
const LINK_STEP = "Link the pinned toolchain into the harness node_modules";

/**
 * Pure text-level contract for the harness-local pinned links.
 *
 * The lane's child env is sanitised (run-lane.mjs allowlists vars), so NODE_PATH
 * never reaches lane.mjs and `require.resolve("@playwright/test/cli")` fails
 * unless both pinned packages are physically resolvable inside the harness
 * tree. Any deviation — one package only, an unpinned prefix, a global
 * fallback, or routing that still depends on NODE_PATH — is a problem.
 */
function pinnedLinkProblems(text) {
  const problems = [];
  const escapeRe = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const pkg of ["firebase-tools", "@playwright/test"]) {
    const call = new RegExp(
      `link_pinned "\\$RUNNER_TEMP/ci-tool/node_modules/${escapeRe(pkg)}" "${escapeRe(HARNESS_NODE_MODULES)}/${escapeRe(pkg)}"`,
    );
    if (!call.test(text)) problems.push(`no harness-local link from the pinned prefix for ${pkg}`);
  }
  if (!/ln -s "\$source_path" "\$target_path"/.test(text)) problems.push("links are not created with ln -s from the checked source");
  if (!text.includes(`mkdir -p "${HARNESS_NODE_MODULES}/@playwright"`)) problems.push("the scoped @playwright parent directory is not created first");
  if (!/\[ -e "\$target_path" \] \|\| \[ -L "\$target_path" \]/.test(text)) {
    problems.push("an unexpected existing link target is not rejected (fail-closed missing)");
  }
  if (!/\[ ! -e "\$source_path" \]/.test(text)) problems.push("a missing pinned source is not rejected (fail-closed missing)");
  if (/NODE_PATH/.test(text)) problems.push("the runtime link step must not depend on NODE_PATH");
  if (/npm root -g|npm prefix -g|npm ls -g|\.npm-global|\/usr\/local\/lib\/node_modules|\/usr\/lib\/node_modules/.test(text)) {
    problems.push("a global/ambient toolchain fallback is present");
  }
  if (/(^|\s)-s "[^"]*" "node_modules\//.test(text)) problems.push("the link destination must sit under the harness, not the repo root");
  return problems;
}

test("both gate scripts exist and are self-describing", () => {
  for (const scriptPath of Object.values(SCRIPTS)) {
    const text = readFileSync(path.join(REPO_ROOT, scriptPath), "utf8");
    assert.match(text, /fail-?closed/i, `${scriptPath} must document its fail-closed contract`);
    assert.doesNotMatch(text, /TODO|PLACEHOLDER/i);
  }
});

test("triggers: pull_request (gating) + optional workflow_dispatch", () => {
  assert.match(CODE, /^on:\n/m);
  assert.match(CODE, /  pull_request:\n/m);
  assert.match(CODE, /  workflow_dispatch:\n/m);
});

test("pull_request paths cover coffee root rules + firebase wiring + the gate's own config", () => {
  const pathsBlock = CODE.match(/    paths:\n((?:      - "[^"]+"\n)+)/);
  assert.ok(pathsBlock, "pull_request.paths block must exist");
  const listed = [...pathsBlock[1].matchAll(/      - "([^"]+)"/g)].map((m) => m[1]);
  for (const required of REQUIRED_PATHS) assert.ok(listed.includes(required), `missing path: ${required}`);
  assert.equal(listed.length, REQUIRED_PATHS.length, "root path filter must be exactly the contract set");
});

test("least privilege: contents read; no pull_request_target; no secrets", () => {
  assert.match(CODE, /^permissions:\n  contents: read$/m);
  assert.doesNotMatch(CODE, /pull_request_target/i);
  assert.doesNotMatch(CODE, /secrets\.[A-Z_]+/);
});

test("actions pinned by gh-verified commit SHAs; moving tags forbidden", () => {
  for (const [action, sha] of Object.entries(PINNED_ACTIONS)) {
    const matches = [...CODE.matchAll(new RegExp(`uses:\\s*${action.replace("/", "\\/")}@([0-9a-f]{40})`, "g"))];
    assert.ok(matches.length > 0, `action ${action} must be used and pinned`);
    for (const match of matches) assert.equal(match[1], sha);
  }
  assert.doesNotMatch(CODE, /uses:\s*actions\/[\w-]+@v[0-9]+/m);
});

test("two independent checkouts: root PR + harness pinned from validated manifest output", () => {
  assert.match(CODE, /repository:\s*\$\{\{ steps\.pin\.outputs\.repo \}\}/);
  assert.match(CODE, /ref:\s*\$\{\{ steps\.pin\.outputs\.commit \}\}/);
  assert.match(CODE, /path: customer-harness/);
  // The pin never comes from a hardcoded 40-hex constant or moving ref.
  assert.doesNotMatch(CODE, /ref:\s*[0-9a-f]{40}/, "harness ref must come from the validated manifest, not a hardcoded sha");
  assert.doesNotMatch(CODE, /ref:\s*(main|master|v\d+)/, "harness ref must never be a moving ref");
  assert.doesNotMatch(CODE, /\.\.\/|\.swarm-worktrees|polish-core-20261025|polish-backend-20261025/, "sibling checkouts are forbidden");
});

test("pin validation is fail-closed and output-captured", () => {
  assert.match(CODE, /validate-customer-harness-pin\.mjs/);
  assert.match(CODE, /\$GITHUB_OUTPUT/);
  // No default pin anywhere: the only pin source is the manifest file.
  assert.doesNotMatch(CODE, /defaults:\s*\{\s*run[\s\S]*?commit/);
});

test("parity routing: root-PR rules copied into the harness with hash proof", () => {
  assert.match(CODE, /root-rule-parity\.mjs/);
  assert.match(CODE, /parity-proof\.json/);
  assert.match(CODE, /EMULATOR_CANONICAL_RULES=\$GITHUB_WORKSPACE\/customer-harness\/firestore\.rules/);
});

test("lane: node tests/emulator/run-lane.mjs inside the harness, full two-phase, no skips", () => {
  assert.match(CODE, /node tests\/emulator\/run-lane\.mjs/);
  assert.match(CODE, /working-directory: customer-harness/);
  assert.doesNotMatch(CODE, /--skip-negative/);
  assert.doesNotMatch(CODE, /npx firebase/);
  assert.match(CODE, /EMULATOR_ALLOW_DOWNLOAD=1/);
  assert.match(CODE, /EMULATOR_LANE_ARTIFACTS=\$RUNNER_TEMP\//);
  assert.match(CODE, /EMULATOR_JAVA_HOME=\$\{JAVA_HOME\}/);
});

test("toolchain: Node 22 + JDK21 + exact pinned tools; no legacy-peer-deps", () => {
  assert.match(CODE, /node-version: "22"/);
  assert.match(CODE, /java-version: "21"\n/);
  assert.match(CODE, /firebase-tools@15\.32\.1/);
  assert.match(CODE, /@playwright\/test@1\.63\.0/);
  assert.doesNotMatch(CODE, /--legacy-peer-deps/);
});

test("the customer SHA cannot be invented here (no 40-hex constant in the workflow)", () => {
  const hexConstants = [...CODE.matchAll(/[^@]([0-9a-f]{40})[^0-9a-f]/g)].map((m) => m[1]);
  assert.deepEqual(hexConstants, [], "workflow must not embed a customer commit sha (parent publishes it)");
});

test("project isolation: demo emulator only; no real project ids; no deploy", () => {
  assert.doesNotMatch(CODE, /\bfirebase\s+deploy\b/);
  assert.doesNotMatch(CODE, /RAZORPAY|PETPOOJA|FIREBASE_TOKEN|SERVICE_ACCOUNT|GOOGLE_APPLICATION_CREDENTIALS/i);
  assert.match(CODE, /m\.env\.credentialValuesCopied===true/);
});

test("manifest gate + parity proof + artifact upload survive failure", () => {
  const guardStart = CODE.indexOf("lane manifest missing/unreadable");
  assert.ok(guardStart > 0, "manifest guard must exist");
  const head = CODE.slice(0, guardStart);
  assert.match(head, /if: always\(\)\n        run: \|/);
  assert.match(CODE, /ROOT_RULES_PARITY_PROOF/);
  const artifactStart = CODE.indexOf("- uses: actions/upload-artifact@");
  assert.ok(artifactStart > 0);
  const tail = CODE.slice(artifactStart);
  assert.match(tail, /if: always\(\)/);
  assert.match(tail, /if-no-files-found: error/);
  assert.match(tail, /root-rules-parity/);
});

// ---------------------------------------------------------------------------
// STATIC configuration assertions: the pinned runtime must be harness-local.
//
// The lane child env is sanitised by run-lane.mjs (NODE_PATH dropped), so
// resolution must succeed from customer-harness/tests/emulator alone. These
// assertions read the real workflow YAML; they do not execute it.
// ---------------------------------------------------------------------------

test("static: the pinned toolchain is linked into customer-harness/node_modules", () => {
  const block = stepBlock(LINK_STEP);
  assert.ok(block, `workflow must keep a step named "${LINK_STEP}"`);
  assert.equal(block.match(/npm ci/), null, "link step must not install anything");
  const problems = pinnedLinkProblems(block);
  assert.deepEqual(problems, [], problems.join("; "));
  assert.match(block, /node_modules\/firebase-tools/);
  assert.match(block, /node_modules\/@playwright\/test/);

  // Ordering matters: the links must exist after the harness-local copies are
  // removed and before anything asserts versions or runs the lane.
  const at = (marker) => {
    const index = CODE.indexOf(marker);
    assert.ok(index > 0, `workflow must still contain: ${marker}`);
    return index;
  };
  const linkAt = at(`- name: ${LINK_STEP}`);
  const routeAt = at("rm -rf customer-harness/node_modules/firebase-tools customer-harness/node_modules/@playwright/test");
  const assertAt = at("- name: Assert exact pinned tool versions");
  const laneAt = at("run: node tests/emulator/run-lane.mjs");
  assert.ok(routeAt < linkAt, "links must be created after the harness-local copies are removed");
  assert.ok(linkAt < assertAt, "links must exist before the pinned version assertion");
  assert.ok(linkAt < laneAt, "links must exist before the lane runs");
});

test("static: a single-package, unpinned-prefix or global-fallback routing is rejected", () => {
  const block = stepBlock(LINK_STEP);
  assert.ok(block, "real link step must exist before its negative fixtures are meaningful");

  const onePackageOnly = block.replace(/\n\s*link_pinned "\$RUNNER_TEMP\/ci-tool\/node_modules\/@playwright\/test"[^\n]*\n/, "\n");
  assert.notEqual(onePackageOnly, block, "fixture must actually remove the @playwright/test link");
  assert.ok(
    pinnedLinkProblems(onePackageOnly).includes("no harness-local link from the pinned prefix for @playwright/test"),
    "one-package-only routing must be rejected for the missing @playwright/test link",
  );

  const wrongPrefix = block.replaceAll(PINNED_PREFIX, "$RUNNER_TEMP/unpinned/node_modules");
  assert.notEqual(wrongPrefix, block);
  assert.deepEqual(
    pinnedLinkProblems(wrongPrefix).filter((problem) => problem.startsWith("no harness-local link")),
    [
      "no harness-local link from the pinned prefix for firebase-tools",
      "no harness-local link from the pinned prefix for @playwright/test",
    ],
    "an unpinned/wrong prefix must be rejected for both packages",
  );

  const globalFallback = `${block}\n          ln -s "$(npm root -g)/firebase-tools" "${HARNESS_NODE_MODULES}/firebase-tools"\n`;
  assert.ok(
    pinnedLinkProblems(globalFallback).includes("a global/ambient toolchain fallback is present"),
    "a global toolchain fallback must be rejected",
  );

  const nodePathDependency = `${block}\n          echo "NODE_PATH=$RUNNER_TEMP/ci-tool/node_modules"\n`;
  assert.ok(
    pinnedLinkProblems(nodePathDependency).includes("the runtime link step must not depend on NODE_PATH"),
    "a runtime link step that reintroduces NODE_PATH must be rejected",
  );

  const rootDestination = `${block}\n          ln -s "$RUNNER_TEMP/ci-tool/node_modules/firebase-tools" "node_modules/firebase-tools"\n`;
  assert.ok(
    pinnedLinkProblems(rootDestination).includes("the link destination must sit under the harness, not the repo root"),
    "a repo-root link destination must be rejected",
  );
});

// ---------------------------------------------------------------------------
// RUNTIME resolver proof: real Node child, synthetic packages, no NODE_PATH.
//
// Proves the MECHANISM the workflow relies on — a harness-relative link is
// resolvable from customer-harness/tests/emulator with NODE_PATH absent, and
// unresolvable once the link is gone. It does not prove the remote job ran.
// ---------------------------------------------------------------------------

const RESOLVE_PROBE = `
const { createRequire } = require("node:module");
const path = require("node:path");
const [harnessRoot, moduleId, mode] = process.argv.slice(2);
if (Object.hasOwn(process.env, "NODE_PATH")) {
  console.error("probe must run without NODE_PATH");
  process.exit(3);
}
const fromFile = path.join(harnessRoot, "tests", "emulator", "lane.mjs");
const req = createRequire(fromFile);
try {
  console.log("RESOLVED=" + req.resolve(moduleId));
  process.exit(0);
} catch (error) {
  console.log("UNRESOLVED=" + error.code);
  process.exit(mode === "expect-missing" && error.code === "MODULE_NOT_FOUND" ? 0 : 1);
}
`;

/**
 * The lane sanitises its children with an allowlist (run-lane.mjs), so the probe
 * runs under the same discipline: a minimal allowlisted environment, never a
 * copy-then-delete of the parent env. Anything not listed simply is not there.
 */
const PROBE_ENV_ALLOWLIST = ["PATH", "PATHEXT", "SystemRoot", "windir", "SystemDrive", "ComSpec", "TEMP", "TMP", "NUMBER_OF_PROCESSORS"];

function probeEnv() {
  const allowed = {};
  for (const name of PROBE_ENV_ALLOWLIST) if (process.env[name] !== undefined) allowed[name] = process.env[name];
  return allowed;
}

test("runtime resolver: harness-local links resolve the pinned modules without NODE_PATH", () => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "harness-link-probe-"));
  const harnessRoot = path.join(scratch, "customer-harness");
  const prefixModules = path.join(scratch, "ci-tool", "node_modules");
  const linkedModules = path.join(harnessRoot, "node_modules");

  try {
    mkdirSync(path.join(harnessRoot, "tests", "emulator"), { recursive: true });
    const synthetic = { firebaseTools: "firebase-tools", playwright: path.join("@playwright", "test") };
    const manifests = {
      firebaseTools: '{"name":"firebase-tools","version":"15.32.1"}',
      playwright: '{"name":"@playwright/test","version":"1.63.0"}',
    };
    for (const key of Object.keys(synthetic)) {
      const dir = path.join(prefixModules, synthetic[key]);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "package.json"), `${manifests[key]}\n`);
      writeFileSync(path.join(dir, "cli.js"), "module.exports = { synthetic: true };\n");
    }
    mkdirSync(path.join(linkedModules, "@playwright"), { recursive: true });
    const linkType = process.platform === "win32" ? "junction" : "dir";
    const linkTargets = {
      firebaseTools: path.join(linkedModules, "firebase-tools"),
      playwright: path.join(linkedModules, "@playwright", "test"),
    };
    for (const key of Object.keys(synthetic)) symlinkSync(path.join(prefixModules, synthetic[key]), linkTargets[key], linkType);

    const probe = path.join(scratch, "resolve-probe.cjs");
    writeFileSync(probe, RESOLVE_PROBE);
    const env = probeEnv();
    const resolveFrom = (moduleId, mode = "expect-found") =>
      spawnSync(process.execPath, [probe, harnessRoot, moduleId, mode], { encoding: "utf8", env });

    const playwrightRun = resolveFrom("@playwright/test/cli");
    assert.equal(playwrightRun.status, 0, `stderr: ${playwrightRun.stderr}`);
    assert.match(playwrightRun.stdout, /RESOLVED=.*@playwright[\\/]test[\\/]cli\.js/);

    const firebaseRun = resolveFrom("firebase-tools/package.json");
    assert.equal(firebaseRun.status, 0, `stderr: ${firebaseRun.stderr}`);
    assert.match(firebaseRun.stdout, /RESOLVED=.*firebase-tools[\\/]package\.json/);

    // Control: with the scoped link removed, the identical probe fails closed.
    unlinkSync(linkTargets.playwright);
    const controlRun = resolveFrom("@playwright/test/cli", "expect-missing");
    assert.equal(controlRun.status, 0, `control must end in MODULE_NOT_FOUND; got ${controlRun.stdout} ${controlRun.stderr}`);
    assert.match(controlRun.stdout, /UNRESOLVED=MODULE_NOT_FOUND/);

    // The remaining link is untouched, so only the removed one changed the outcome.
    const stillLinked = resolveFrom("firebase-tools/package.json");
    assert.equal(stillLinked.status, 0, `stderr: ${stillLinked.stderr}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("local parser: deep YAML syntax validation when an existing parser is resolvable", () => {
  const parser = loadYamlParser();
  if (!parser) console.warn("[static test] no existing YAML parser resolvable — structure-only assertions ran");
  test("parsed workflow + scripts yield the required top-level structure", () => {
    if (!parser) return;
    let doc;
    if (parser.name === "yaml") {
      doc = parser.mod.parse(WORKFLOW, { schema: "core", uniqueKeys: true });
    } else {
      doc = parser.mod.load(WORKFLOW, { schema: parser.mod.JSON_SCHEMA, json: true });
    }
    assert.ok(doc && typeof doc === "object");
    for (const key of ["name", "on", "permissions", "jobs"]) assert.ok(Object.hasOwn(doc, key), `top-level key ${key}`);
    assert.equal(typeof doc.on, "object", "`on:` must remain a mapping");
    const job = doc.jobs["root-rules-parity-browser-lane"];
    assert.ok(job, "gate job present");
    const stepNames = job.steps.map((s) => s.name ?? s.uses ?? "").filter(Boolean);
    for (const fragment of ["Validate the immutable customer-harness pin", "Route PR rules into the harness with hash parity proof", "Run local emulator browser lane against the PR rules"]) {
      assert.ok(stepNames.some((n) => n.includes(fragment)), `step missing: ${fragment}`);
    }
  });
});
