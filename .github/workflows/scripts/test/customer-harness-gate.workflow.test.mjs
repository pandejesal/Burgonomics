/**
 * Static (pure) contract test for .github/workflows/customer-emulator-harness-gate.yml
 * — DEC-09 root rules × pinned-customer-harness required PR check.
 *
 * Always-on checks are structural (string level on real content, comments
 * stripped); the deep YAML syntax check runs only when an existing local YAML
 * parser (`yaml`, else `js-yaml` with JSON_SCHEMA) is resolvable — no installs.
 *
 * Run: node --test .github/workflows/scripts/test/customer-harness-gate.workflow.test.mjs
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..", "..");
const WORKFLOW_REL = ".github/workflows/customer-emulator-harness-gate.yml";
const WORKFLOW = readFileSync(path.join(REPO_ROOT, WORKFLOW_REL), "utf8");

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
      const pkgPath = req.resolve(path.join(name, "package.json").split("\\").join("/"), { paths });
      const pkgJson = JSON.parse(readFileSync(pkgPath, "utf8"));
      const mod = req(pkgPath.replace(/package\.json$/, "index.js"), { paths });
      return { name: pkgJson.name, version: pkgJson.version, mod };
    } catch {
      /* next candidate */
    }
  }
  return null;
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
