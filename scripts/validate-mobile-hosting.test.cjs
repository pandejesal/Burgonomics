"use strict";

/**
 * Hermetic tests for scripts/validate-mobile-hosting.cjs.
 *
 *   node --test scripts/validate-mobile-hosting.test.cjs
 *
 * Zero dependencies, zero network, zero builds. Every case builds a throwaway
 * fixture under os.tmpdir() and tears it down afterwards; the real repo tree is
 * only ever read.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { validate, render, matches } = require("./validate-mobile-hosting.cjs");

const AASA_GOOD = {
  applinks: { apps: [], details: [{ appIDs: ["ABCDE12345.com.burgonomics"], components: [{ "/": "/orders/*" }] }] },
  webcredentials: { apps: ["ABCDE12345.com.burgonomics"] },
};
const AASA_TEAMID = JSON.parse(JSON.stringify(AASA_GOOD).replaceAll("ABCDE12345", "TEAMID"));
const ASSETLINKS = [
  {
    relation: ["delegate_permission/common.handle_all_urls"],
    target: { namespace: "android_app", package_name: "com.burgonomics", sha256_cert_fingerprints: ["AA:BB"] },
  },
];

const GOOD_IGNORE = ["firebase.json", "**/node_modules/**", "**/.DS_Store", "**/*.log"];
const JSON_HEADER = [
  { source: "**", headers: [{ key: "X-Content-Type-Options", value: "nosniff" }] },
  {
    source: "/.well-known/apple-app-site-association",
    headers: [{ key: "Content-Type", value: "application/json" }],
  },
  {
    source: "/.well-known/assetlinks.json",
    headers: [{ key: "Content-Type", value: "application/json" }],
  },
];

/** Build a throwaway repo root shaped like the real one (customer app layout). */
function makeFixture({ ignore = GOOD_IGNORE, headers = JSON_HEADER, publishDir = "burgonomics-foundation-core/dist/mobile", aasa = AASA_GOOD, assetlinks = ASSETLINKS, omitWellKnown = null, pbxproj = 'PRODUCT_BUNDLE_IDENTIFIER = com.burgonomics;\nCURRENT_PROJECT_VERSION = 1;\nPRODUCT_BUNDLE_IDENTIFIER = com.burgonomics;\n' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "r18-hosting-"));
  const pub = path.join(root, publishDir);
  fs.mkdirSync(path.join(pub, "assets"), { recursive: true });
  fs.writeFileSync(path.join(pub, "index.html"), "<html></html>");
  fs.writeFileSync(path.join(pub, "assets", "app-abc123.js"), "console.log(1)");

  if (!omitWellKnown) {
    fs.mkdirSync(path.join(pub, ".well-known"), { recursive: true });
    if (aasa) fs.writeFileSync(path.join(pub, ".well-known", "apple-app-site-association"), JSON.stringify(aasa));
    if (assetlinks) fs.writeFileSync(path.join(pub, ".well-known", "assetlinks.json"), JSON.stringify(assetlinks));
  }

  fs.writeFileSync(
    path.join(root, "firebase.json"),
    JSON.stringify(
      { hosting: [{ target: "burgonomics-app", public: publishDir, ignore, headers }] },
      null,
      2,
    ),
  );

  const iosDir = path.join(root, "burgonomics-foundation-core", "ios", "App", "App.xcodeproj");
  fs.mkdirSync(iosDir, { recursive: true });
  fs.writeFileSync(
    path.join(iosDir, "project.pbxproj"),
    pbxproj,
  );
  const androidDir = path.join(root, "burgonomics-foundation-core", "android", "app");
  fs.mkdirSync(androidDir, { recursive: true });
  fs.writeFileSync(path.join(androidDir, "build.gradle"), 'namespace = "com.burgonomics"\napplicationId "com.burgonomics"\n');

  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function levels(findings, check) {
  return findings.filter((f) => f.check === check).map((f) => f.level);
}

/* ------------------------------------------------------------------ */

test("glob matcher covers the pattern shapes hosting ignore/header use", () => {
  assert.equal(matches("**/.DS_Store", ".DS_Store"), true);
  assert.equal(matches("**/.DS_Store", "assets/.DS_Store"), true);
  assert.equal(matches("**/.DS_Store", ".well-known/apple-app-site-association"), false);
  assert.equal(matches("**/node_modules/**", "node_modules/x/y.js"), true);
  assert.equal(matches("**/node_modules/**", ".well-known/assetlinks.json"), false);
  assert.equal(matches("firebase.json", "firebase.json"), true);
  assert.equal(matches("**/*.log", "assets/debug.log"), true);
  assert.equal(matches("**/*.log", "assets/debug.txt"), false);
  assert.equal(matches("assets/**", "assets/app-abc123.js"), true);
  assert.equal(matches("assets/**", "index.html"), false);
  assert.equal(matches(".well-known/apple-app-site-association", ".well-known/apple-app-site-association"), true);
  // regex metacharacters in a literal segment must not leak
  assert.equal(matches("**/.firebase/**", ".firebase/hosting.json"), true);
  assert.equal(matches("**/Thumbs.db", "images/ThumbsXdb"), false);
});

test("glob matcher refuses shapes it cannot model instead of guessing", () => {
  assert.throws(() => matches("a{b,c}/x", "a/x"), /unsupported glob segment/);
  assert.throws(() => matches("a+b/x", "a+b/x"), /unsupported glob segment/);
});

test("healthy config produces no FAIL findings", () => {
  const fx = makeFixture();
  try {
    const findings = validate({ repoRoot: fx.root });
    const fails = findings.filter((f) => f.level === "FAIL");
    assert.deepEqual(fails, [], render(findings));
    assert.ok(findings.some((f) => f.check === "well-known-not-ignored" && f.level === "PASS"));
    assert.ok(findings.some((f) => f.check === "aasa-teamid-resolved" && f.level === "PASS"));
    assert.ok(findings.some((f) => f.check === "aasa-bundleid" && f.level === "PASS"));
    assert.ok(findings.some((f) => f.check === "assetlinks-package" && f.level === "PASS"));
    assert.ok(findings.some((f) => f.check === "json-content-type" && f.level === "PASS"));
  } finally {
    fx.cleanup();
  }
});

test("REGRESSION: a blanket dotfile ignore pattern is rejected", () => {
  // This is the historical `**/.*` shape that puts .well-known at risk.
  const fx = makeFixture({ ignore: ["firebase.json", "**/.*", "**/node_modules/**"] });
  try {
    const findings = validate({ repoRoot: fx.root });
    assert.ok(levels(findings, "ignore-no-dotfile-blanket").includes("FAIL"), render(findings));
  } finally {
    fx.cleanup();
  }
});

test("REGRESSION: negation re-includes are rejected as dead config", () => {
  const fx = makeFixture({ ignore: [...GOOD_IGNORE, "!**/.well-known/**"] });
  try {
    const findings = validate({ repoRoot: fx.root });
    assert.ok(levels(findings, "ignore-no-negation").includes("FAIL"), render(findings));
  } finally {
    fx.cleanup();
  }
});

test("a .well-known file matched by an ignore pattern is reported", () => {
  const fx = makeFixture({ ignore: [...GOOD_IGNORE, "**/.well-known/**"] });
  try {
    const findings = validate({ repoRoot: fx.root });
    const hit = findings.filter((f) => f.check === "well-known-not-ignored" && f.level === "FAIL");
    assert.equal(hit.length, 2, render(findings));
    assert.match(hit[0].detail, /\*\*\/\.well-known\/\*\*/);
  } finally {
    fx.cleanup();
  }
});

test("missing publish dir FAILs with a build hint", () => {
  const fx = makeFixture();
  fs.rmSync(path.join(fx.root, "burgonomics-foundation-core", "dist"), { recursive: true, force: true });
  try {
    const findings = validate({ repoRoot: fx.root });
    const hit = findings.filter((f) => f.check === "publish-dir-exists" && f.level === "FAIL");
    assert.equal(hit.length, 1);
    assert.match(hit[0].detail, /build:mobile/);
  } finally {
    fx.cleanup();
  }
});

test("publish dir without .well-known FAILs per file", () => {
  const fx = makeFixture({ omitWellKnown: true });
  try {
    const findings = validate({ repoRoot: fx.root });
    const hit = findings.filter((f) => f.check === "well-known-present" && f.level === "FAIL");
    assert.equal(hit.length, 2, render(findings));
  } finally {
    fx.cleanup();
  }
});

test("unresolved TEAMID placeholder FAILs, and --allow-unresolved-teamid downgrades it to WARN", () => {
  const fx = makeFixture({ aasa: AASA_TEAMID });
  try {
    const strict = validate({ repoRoot: fx.root });
    const hit = strict.filter((f) => f.check === "aasa-teamid-resolved" && f.level === "FAIL");
    assert.equal(hit.length, 1, render(strict));
    assert.match(hit[0].detail, /will not invent one/);

    const lax = validate({ repoRoot: fx.root, allowUnresolvedTeamId: true });
    assert.deepEqual(levels(lax, "aasa-teamid-resolved"), ["WARN"]);
    assert.equal(lax.filter((f) => f.level === "FAIL").length, 0, render(lax));
  } finally {
    fx.cleanup();
  }
});

test("missing JSON content-type headers FAIL for both Apple/Android association files", () => {
  const fx = makeFixture({
    headers: [{ source: "**", headers: [{ key: "X-Content-Type-Options", value: "nosniff" }] }],
  });
  try {
    const findings = validate({ repoRoot: fx.root });
    const hit = findings.filter((f) => f.check === "json-content-type" && f.level === "FAIL");
    assert.equal(hit.length, 2, render(findings));
  } finally {
    fx.cleanup();
  }
});

test("AASA appID that does not match the shipped bundle id FAILs", () => {
  const fx = makeFixture({
    aasa: JSON.parse(JSON.stringify(AASA_GOOD).replaceAll("com.burgonomics", "com.oldapp")),
  });
  try {
    const findings = validate({ repoRoot: fx.root });
    const hit = findings.filter((f) => f.check === "aasa-bundleid" && f.level === "FAIL");
    assert.equal(hit.length, 1, render(findings));
  } finally {
    fx.cleanup();
  }
});

test("assetlinks package_name that does not match applicationId FAILs", () => {
  const fx = makeFixture({
    assetlinks: [
      {
        relation: ["delegate_permission/common.handle_all_urls"],
        target: { namespace: "android_app", package_name: "com.someoneelse", sha256_cert_fingerprints: ["AA"] },
      },
    ],
  });
  try {
    const findings = validate({ repoRoot: fx.root });
    const hit = findings.filter((f) => f.check === "assetlinks-package" && f.level === "FAIL");
    assert.equal(hit.length, 1, render(findings));
  } finally {
    fx.cleanup();
  }
});

test("legacy AASA shape (details[].appID + paths[]) is accepted, not reported empty", () => {
  // The partner site ships the pre-Team-ID-AASA format; iOS still honours it.
  const fx = makeFixture({
    aasa: { applinks: { apps: [], details: [{ appID: "ABCDE12345.com.burgonomics", paths: ["*"] }] } },
    assetlinks: null,
  });
  try {
    const findings = validate({ repoRoot: fx.root });
    assert.deepEqual(levels(findings, "aasa-appids"), ["PASS"], render(findings));
    assert.deepEqual(levels(findings, "aasa-bundleid"), ["PASS"], render(findings));
    assert.deepEqual(levels(findings, "assetlinks-package"), [], render(findings));
  } finally {
    fx.cleanup();
  }
});

test("render survives an empty findings list instead of throwing", () => {
  assert.match(render([]), /nothing to report/);
  assert.match(render(undefined), /nothing to report/);
});

test("malformed firebase.json and empty hosting FAIL loudly instead of throwing", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "r18-hosting-bad-"));
  try {
    fs.writeFileSync(path.join(root, "firebase.json"), "{ not json");
    let findings = validate({ repoRoot: root });
    assert.deepEqual(levels(findings, "firebase-json-parses"), ["FAIL"]);

    fs.writeFileSync(path.join(root, "firebase.json"), JSON.stringify({ hosting: [] }));
    findings = validate({ repoRoot: root });
    assert.deepEqual(levels(findings, "hosting-present"), ["FAIL"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the real root firebase.json passes every structural guard", () => {
  // Structural only: the repo has no dist/mobile until someone builds, and the
  // published AASA still carries TEAMID, so those two FAIL rows are expected.
  const findings = validate({ repoRoot: path.resolve(__dirname, "..") });
  const structural = ["ignore-no-dotfile-blanket", "ignore-no-negation", "json-content-type"];
  for (const check of structural) {
    const bad = findings.filter((f) => f.check === check && f.level === "FAIL");
    assert.deepEqual(bad, [], `${check}\n${render(findings)}`);
  }
});
/* ------------------------------------------------------------------ *
 * Regressions found in independent review (2026-10-23)
 * ------------------------------------------------------------------ */

test("REGRESSION: several distinct bundle ids do not downgrade the AASA check to SKIP", () => {
  // A project with a Debug-suffix target has >1 PRODUCT_BUNDLE_IDENTIFIER.
  // Before the fix readBundleId() returned null, so an AASA appID pointing at a
  // completely different app silently produced SKIP and exit 0.
  const fx = makeFixture({
    pbxproj:
      "PRODUCT_BUNDLE_IDENTIFIER = com.burgonomics;\n" +
      "PRODUCT_BUNDLE_IDENTIFIER = com.burgonomics.debug;\n",
    aasa: {
      applinks: { apps: [], details: [{ appIDs: ["ABCDE12345.com.some.other.app"] }] },
      webcredentials: { apps: [] },
    },
  });
  try {
    const findings = validate({ repoRoot: fx.root });
    assert.deepEqual(levels(findings, "aasa-bundleid"), ["FAIL"], render(findings));
    const hit = findings.find((f) => f.check === "aasa-bundleid");
    assert.match(hit.detail, /com\.burgonomics\.debug/);
    assert.match(hit.detail, /universal links stay dead/);
  } finally {
    fx.cleanup();
  }
});

test("REGRESSION: an ignore glob the matcher cannot model FAILs and still checks existence", () => {
  // `**/{.*,**/.*}` is a real Firebase/glob shape that drops dot directories.
  // Before the fix it produced only a WARN and returned early, so a missing
  // .well-known was never reported either.
  const fx = makeFixture({ ignore: ["firebase.json", "**/{.*,**/.*}"], omitWellKnown: true });
  try {
    const findings = validate({ repoRoot: fx.root });
    assert.deepEqual(levels(findings, "ignore-unsupported"), ["FAIL"], render(findings));
    assert.equal(
      findings.filter((f) => f.check === "well-known-present" && f.level === "FAIL").length,
      2,
      render(findings),
    );
    const overlap = findings.filter((f) => f.check === "well-known-not-ignored");
    assert.deepEqual(overlap.map((f) => f.level), [], render(findings));
    assert.ok(findings.some((f) => f.level === "FAIL"));
  } finally {
    fx.cleanup();
  }
});

test("REGRESSION: an unmodellable ignore glob SKIPs overlap instead of claiming PASS", () => {
  const fx = makeFixture({ ignore: ["firebase.json", "**/{.*,**/.*}"] });
  try {
    const findings = validate({ repoRoot: fx.root });
    assert.deepEqual(levels(findings, "ignore-unsupported"), ["FAIL"], render(findings));
    assert.deepEqual(
      findings.filter((f) => f.check === "well-known-not-ignored").map((f) => f.level),
      ["SKIP", "SKIP"],
      render(findings),
    );
  } finally {
    fx.cleanup();
  }
});

test("REGRESSION: a WRONG Content-Type (not just a missing one) FAILs", () => {
  const headers = JSON_HEADER.map((rule) => ({
    ...rule,
    headers: rule.headers.map((h) =>
      String(h.key).toLowerCase() === "content-type" ? { ...h, value: "text/plain" } : h,
    ),
  }));
  const fx = makeFixture({ headers });
  try {
    const findings = validate({ repoRoot: fx.root });
    assert.equal(
      findings.filter((f) => f.check === "json-content-type" && f.level === "FAIL").length,
      2,
      render(findings),
    );
  } finally {
    fx.cleanup();
  }
});
test("REGRESSION: an AASA that authorizes only an extension target FAILs", () => {
  // App + NotificationService extension: an AASA listing only the extension id
  // authorizes no app, so the primary bundle must be covered explicitly.
  const fx = makeFixture({
    pbxproj:
      "PRODUCT_BUNDLE_IDENTIFIER = com.burgonomics;\n" +
      "PRODUCT_BUNDLE_IDENTIFIER = com.burgonomics.NotificationService;\n",
    aasa: {
      applinks: { apps: [], details: [{ appIDs: ["ABCDE12345.com.burgonomics.NotificationService"] }] },
      webcredentials: { apps: [] },
    },
  });
  try {
    const findings = validate({ repoRoot: fx.root });
    assert.deepEqual(levels(findings, "aasa-bundleid"), ["FAIL"], render(findings));
    assert.match(findings.find((f) => f.check === "aasa-bundleid").detail, /primary app bundle id com\.burgonomics/);
  } finally {
    fx.cleanup();
  }
});

test("extension ids do not have to be listed in the AASA (no false positive)", () => {
  const fx = makeFixture({
    pbxproj:
      "PRODUCT_BUNDLE_IDENTIFIER = com.burgonomics;\n" +
      "PRODUCT_BUNDLE_IDENTIFIER = com.burgonomics.NotificationService;\n",
  });
  try {
    const findings = validate({ repoRoot: fx.root });
    assert.deepEqual(levels(findings, "aasa-bundleid"), ["PASS"], render(findings));
  } finally {
    fx.cleanup();
  }
});