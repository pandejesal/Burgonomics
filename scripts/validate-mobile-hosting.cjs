#!/usr/bin/env node
"use strict";

/**
 * validate-mobile-hosting.cjs — opt-in iOS/Android release preflight.
 *
 * WHAT THIS IS
 * ------------
 * A read-only gate you run by hand before a store release. It never builds,
 * never installs, never deploys, never touches the network, and never invents
 * an Apple Team ID. It only reads files and prints findings.
 *
 * It is deliberately NOT wired into `firebase deploy`, `mac-build.sh`, or any
 * workflow: a local Xcode archive must stay possible on a borrowed Mac while
 * the published AASA still carries a `TEAMID.` placeholder.
 *
 *   node scripts/validate-mobile-hosting.cjs
 *   node scripts/validate-mobile-hosting.cjs --allow-unresolved-teamid
 *
 * Exit code 0 = no FAIL findings, 1 = at least one FAIL.
 *
 * WHY IT EXISTS (the failure it prevents)
 * ---------------------------------------
 * 1. `firebase.json` hosting `ignore` lists used to carry the blanket dotfile
 *    pattern "double-star slash dot-star". `.well-known` is a *dot directory*,
 *    so any tooling that prunes dot-directories silently drops the Apple App
 *    Site Association
 *    and the Android Digital Asset Links file, and universal links / App Links
 *    verify against nothing. The validator refuses any blanket-dotfile ignore
 *    pattern outright, so the shape can never come back.
 * 2. `netlify.toml` / `public/_headers` set `Content-Type: application/json`
 *    for both `.well-known` files. The Firebase Hosting config set no such
 *    header, so the AASA (an extension-less filename) is served under the
 *    catch-all `X-Content-Type-Options: nosniff` with a non-JSON type. The
 *    validator requires an explicit JSON content-type rule per `.well-known`
 *    path per hosting site.
 * 3. `public/.well-known/apple-app-site-association` ships with the literal
 *    placeholder `TEAMID.com.burgonomics`. Until a human substitutes their real
 *    10-character Team ID, the published file authorizes nothing and every
 *    universal link fails verification. The validator fails on the unresolved
 *    placeholder — it will not guess a Team ID for you.
 *
 * DEPENDENCIES
 * ------------
 * Zero. Node standard library only, so it runs on the Mac, in CI, and on a bare
 * checkout. The glob matcher below covers exactly the pattern shapes used in
 * hosting `ignore` / header `source`; an unsupported shape is reported rather
 * than silently approximated.
 */

const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..");
const FIREBASE_JSON = path.join(REPO_ROOT, "firebase.json");

const WELL_KNOWN_FILES = [
  { hosting: "/.well-known/apple-app-site-association", disk: "apple-app-site-association" },
  { hosting: "/.well-known/assetlinks.json", disk: "assetlinks.json" },
];

const TEAMID_PLACEHOLDER = "TEAMID";

/** Dot-blanket patterns that swallow a `.well-known/` directory on some tools. */
const BLANKET_DOTFILE_PATTERN = /(^|\/)\.\*+(\/|\*|$)/;

/* ------------------------------------------------------------------ *
 * Glob matcher — the subset of glob syntax hosting ignore/header
 * `source` values actually use. Anything outside the subset throws, so a
 * new pattern shape surfaces as a loud "unsupported" finding instead of a
 * wrong yes/no answer.
 * ------------------------------------------------------------------ */

/** Translate one literal-ish segment. `*` = any chars but `/`; `?` = one char but `/`. */
function translateSegment(seg, pattern) {
  if (seg === "**") {
    throw new Error(`interior "**" is not modelled (pattern ${JSON.stringify(pattern)})`);
  }
  if (!/^[*?\w.@-]+$/.test(seg)) {
    throw new Error(`unsupported glob segment ${JSON.stringify(seg)} in ${JSON.stringify(pattern)}`);
  }
  return seg.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]");
}

/**
 * Supported shapes: a bare `**`, a leading `**/`, a trailing `/**`, and
 * literal segments with `*` / `?`. That is the whole grammar used by the
 * shipped hosting `ignore` lists and header `source` globs. Anything else
 * throws so the caller reports "unsupported" instead of guessing.
 */
function globToRegExp(pattern) {
  if (pattern === "**") return /^.*$/;

  const segs = pattern.split("/");
  let prefix = "";
  let start = 0;
  if (segs[0] === "**") {
    // zero or more whole leading segments
    prefix = "(?:[^/]+/)*";
    start = 1;
  }
  const hasTrailing = segs.length - 1 > start && segs[segs.length - 1] === "**";
  const bodySegs = hasTrailing ? segs.slice(start, -1) : segs.slice(start);
  const body = bodySegs.map((s) => translateSegment(s, pattern)).join("/");
  // trailing `/**` covers the directory itself and everything under it
  const suffix = hasTrailing ? "(?:/.*)?" : "";
  return new RegExp(`^${prefix}${body}${suffix}$`);
}

function matches(pattern, candidate) {
  return globToRegExp(pattern).test(candidate);
}

/** Header `source` globs and ignore globs both address files relative to the site root. */
function hostingPath(p) {
  return String(p || "").replace(/^\/+/, "");
}

/* ------------------------------------------------------------------ *
 * Findings
 * ------------------------------------------------------------------ */

function createReport() {
  const findings = [];
  return {
    findings,
    pass(site, check, detail) {
      findings.push({ level: "PASS", site, check, detail });
    },
    warn(site, check, detail) {
      findings.push({ level: "WARN", site, check, detail });
    },
    fail(site, check, detail) {
      findings.push({ level: "FAIL", site, check, detail });
    },
    skipped(site, check, detail) {
      findings.push({ level: "SKIP", site, check, detail });
    },
  };
}

/* ------------------------------------------------------------------ *
 * Individual checks
 * ------------------------------------------------------------------ */

function checkIgnoreList(report, target, ignore) {
  if (!Array.isArray(ignore)) {
    report.fail(target, "ignore-shape", "hosting.ignore must be an array");
    return;
  }
  let sawNegation = false;
  let sawBlanket = false;
  for (const raw of ignore) {
    const pattern = String(raw);
    if (pattern.startsWith("!")) {
      sawNegation = true;
      report.fail(
        target,
        "ignore-no-negation",
        `${pattern} — firebase-tools passes hosting "ignore" straight to glob's ` +
          `"ignore" option, where "!" is not a re-include: it is dead config that ` +
          `reads like a fix. Use an explicit ignorelist instead.`,
      );
    }
    if (BLANKET_DOTFILE_PATTERN.test(pattern)) {
      sawBlanket = true;
      report.fail(
        target,
        "ignore-no-dotfile-blanket",
        `${pattern} — excludes every dot-path. ".well-known" is a dot directory, so ` +
          `this is what silently drops apple-app-site-association / assetlinks.json ` +
          `from any deploy path that prunes matched dot-directories.`,
      );
    }
  }
  if (!sawNegation) report.pass(target, "ignore-no-negation", "no negation patterns");
  if (!sawBlanket) report.pass(target, "ignore-no-dotfile-blanket", "no blanket dotfile pattern");
}

function checkWellKnownNotIgnored(report, target, ignore, publishDir) {
  // Evaluate every pattern once. An unsupported glob shape used to WARN and
  // return, which skipped the existence checks entirely — a release-breaking
  // config could then pass with exit 0. It now FAILs and evaluation continues.
  let evaluationError = null;
  const matched = new Map();
  for (const pattern of ignore || []) {
    try {
      for (const file of WELL_KNOWN_FILES) {
        if (matches(String(pattern), hostingPath(file.hosting))) matched.set(file.hosting, String(pattern));
      }
    } catch (err) {
      evaluationError = `pattern ${pattern}: ${err.message}`;
      break;
    }
  }
  if (evaluationError) {
    report.fail(
      target,
      "ignore-unsupported",
      `hosting ignore contains a glob shape this preflight cannot model (${evaluationError}). ` +
        `It therefore cannot prove .well-known survives, so this is release-blocking until the ` +
        `pattern is simplified to a shape the validator models.`,
    );
  }
  for (const file of WELL_KNOWN_FILES) {
    const abs = path.join(publishDir, ".well-known", file.disk);
    if (!fs.existsSync(abs)) {
      report.fail(
        target,
        "well-known-present",
        `${file.hosting} is missing from the publish dir (${publishDir}). ` +
          `Nothing in the source tree copies it in, so the deployed site can only answer this ` +
          `path with the SPA fallback (index.html) and App/Universal link verification fails. ` +
          `Add it under <app>/public/.well-known/ and rebuild the publish dir.`,
      );
      continue;
    }
    const matchedBy = matched.get(file.hosting);
    if (matchedBy) {
      report.fail(
        target,
        "well-known-not-ignored",
        `${file.hosting} exists in the publish dir but hosting ignore pattern ${matchedBy} ` +
          `matches it — it would be uploaded, then served as the SPA fallback, and App/Universal ` +
          `link verification would read index.html instead of JSON.`,
      );
    } else if (evaluationError) {
      report.skipped(
        target,
        "well-known-not-ignored",
        `${file.hosting} existence checked, but ignore overlap is UNKNOWN because a pattern could not be modelled`,
      );
    } else {
      report.pass(target, "well-known-not-ignored", `${file.hosting} survives hosting ignore`);
    }
  }
}

function checkJsonMimeHeader(report, target, headers) {
  for (const file of WELL_KNOWN_FILES) {
    const covering = (headers || []).filter((rule) => {
      const source = rule?.source ?? rule?.glob;
      if (typeof source !== "string") return false;
      try {
        return matches(hostingPath(source), hostingPath(file.hosting));
      } catch {
        return false;
      }
    });
    const setsJson = covering.some((rule) =>
      (rule.headers || []).some((h) => String(h.key).toLowerCase() === "content-type" && /application\/json/i.test(h.value)),
    );
    if (setsJson) {
      report.pass(target, "json-content-type", `${file.hosting} -> application/json`);
    } else {
      report.fail(
        target,
        "json-content-type",
        `no header rule sets Content-Type: application/json for ${file.hosting}. ` +
          `The AASA filename has no extension, so the catch-all "X-Content-Type-Options: nosniff" ` +
          `would apply to a non-JSON response type and iOS rejects it.`,
      );
    }
  }
}

function checkAasa(report, target, publishDir, bundleIds, allowUnresolvedTeamId) {
  const aasaPath = path.join(publishDir, ".well-known", "apple-app-site-association");
  if (!fs.existsSync(aasaPath)) return;
  let aasa;
  try {
    aasa = JSON.parse(fs.readFileSync(aasaPath, "utf8"));
    report.pass(target, "aasa-parses", aasaPath);
  } catch (err) {
    report.fail(target, "aasa-parses", `not valid JSON: ${err.message}`);
    return;
  }

  const appIds = [];
  for (const detail of aasa?.applinks?.details ?? []) {
    // modern shape: details[].appIDs[] + components[].{"/": path}
    for (const id of detail?.appIDs ?? []) appIds.push(id);
    // legacy shape: details[].appID (singular) + paths[] — still honoured by iOS
    if (typeof detail?.appID === "string") appIds.push(detail.appID);
  }
  for (const id of aasa?.webcredentials?.apps ?? []) appIds.push(id);

  if (appIds.length === 0) {
    report.fail(
      target,
      "aasa-appids",
      "no applinks.details[].appIDs / appID or webcredentials.apps entries — the file authorizes nothing",
    );
    return;
  }
  report.pass(target, "aasa-appids", `${appIds.length} app id entr(y|ies): ${appIds.join(", ")}`);

  const unresolved = appIds.filter((id) => id.includes(TEAMID_PLACEHOLDER));
  if (unresolved.length > 0 && !allowUnresolvedTeamId) {
    report.fail(
      target,
      "aasa-teamid-resolved",
      `unresolved ${TEAMID_PLACEHOLDER} placeholder in ${unresolved.join(", ")}. ` +
        `Replace it with your real 10-character Apple Team ID (Xcode > Settings > Accounts, or ` +
        `the Team shown in Signing & Capabilities). This script will not invent one. ` +
        `Pass --allow-unresolved-teamid to downgrade to a warning for local-only builds.`,
    );
  } else if (unresolved.length > 0) {
    report.warn(
      target,
      "aasa-teamid-resolved",
      `${unresolved.join(", ")} still carries the ${TEAMID_PLACEHOLDER} placeholder (allowed by flag)`,
    );
  } else {
    report.pass(target, "aasa-teamid-resolved", `${appIds.length} app id(s) fully qualified`);
  }

  if (!bundleIds || bundleIds.length === 0) {
    report.skipped(target, "aasa-bundleid", "PRODUCT_BUNDLE_IDENTIFIER not found in project.pbxproj");
    return;
  }
  const mismatched = appIds.filter((id) => !bundleIds.some((bundleId) => id.endsWith(`.${bundleId}`)));
  const expected = bundleIds.map((bundleId) => `.${bundleId}`).join(" or ");
  // Coverage, one-directional check is not enough: a project may ship several
  // bundle ids (app + NotificationService/extension), and an AASA that lists
  // ONLY an extension id authorizes no app at all. The base app id is the
  // shortest one, since extension ids extend it.
  const primaryBundleId = [...bundleIds].sort((a, b) => a.length - b.length)[0];
  const primaryCovered = appIds.some((id) => id.endsWith(`.${primaryBundleId}`));
  if (mismatched.length > 0) {
    report.fail(
      target,
      "aasa-bundleid",
      `${mismatched.join(", ")} does not end with any shipped bundle id (${expected}) — ` +
        `iOS matches the AASA appID against the signed bundle id, so universal links stay dead.`,
    );
  } else if (!primaryCovered) {
    report.fail(
      target,
      "aasa-bundleid",
      `AASA authorizes ${appIds.join(", ")} but not the primary app bundle id ${primaryBundleId}. ` +
        `Only an extension/auxiliary target is authorized, so the app's own universal links stay dead.`,
    );
  } else {
    report.pass(target, "aasa-bundleid", `all app ids end with ${expected}`);
  }
}

function checkAssetLinks(report, target, publishDir, applicationId) {
  const linksPath = path.join(publishDir, ".well-known", "assetlinks.json");
  if (!fs.existsSync(linksPath)) return;
  let links;
  try {
    links = JSON.parse(fs.readFileSync(linksPath, "utf8"));
    report.pass(target, "assetlinks-parses", linksPath);
  } catch (err) {
    report.fail(target, "assetlinks-parses", `not valid JSON: ${err.message}`);
    return;
  }
  const entries = Array.isArray(links) ? links : [links];
  const packages = entries
    .map((e) => e?.target?.namespace === "android_app" ? e?.target?.package_name : null)
    .filter(Boolean);
  if (packages.length === 0) {
    report.fail(target, "assetlinks-package", "no android_app target.package_name entry");
    return;
  }
  if (!applicationId) {
    report.skipped(target, "assetlinks-package", "applicationId not found in android/app/build.gradle");
    return;
  }
  const wrong = packages.filter((p) => p !== applicationId);
  if (wrong.length > 0) {
    report.fail(
      target,
      "assetlinks-package",
      `${wrong.join(", ")} != android applicationId ${applicationId} — App Links will not verify.`,
    );
  } else {
    report.pass(target, "assetlinks-package", `package_name matches ${applicationId}`);
  }
}

/* ------------------------------------------------------------------ *
 * Repo fact extraction (read-only, per hosting site)
 * ------------------------------------------------------------------ */

/**
 * The owning app root for a hosting site, taken from its publish dir
 * (e.g. `burgonomics-foundation-core/dist/mobile` -> `burgonomics-foundation-core`).
 * Keeps bundle-id / application-id checks scoped to the right app instead of
 * hardcoding one target name.
 */
function appRootFor(repoRoot, declaredPublic) {
  const segs = String(declaredPublic).split(/[\\/]+/).filter(Boolean);
  if (segs.length < 2) return repoRoot;
  const candidate = path.resolve(repoRoot, segs[0]);
  return fs.existsSync(candidate) && fs.statSync(candidate).isDirectory() ? candidate : repoRoot;
}

function readBundleIds(appRoot) {
  try {
    const src = fs.readFileSync(path.join(appRoot, "ios", "App", "App.xcodeproj", "project.pbxproj"), "utf8");
    const ids = [...src.matchAll(/PRODUCT_BUNDLE_IDENTIFIER\s*=\s*([^;]+);/g)].map((m) =>
      m[1].trim().replace(/^"|"$/g, ""),
    );
    // Return EVERY distinct id, not just the singleton case. A project with a
    // Debug-suffix target or an extension target has several ids; returning null
    // there used to downgrade the AASA check to SKIP, i.e. it silently stopped
    // checking exactly the projects that need it most.
    return [...new Set(ids)].filter(Boolean);
  } catch {
    return [];
  }
}

function readApplicationId(appRoot) {
  try {
    const src = fs.readFileSync(path.join(appRoot, "android", "app", "build.gradle"), "utf8");
    const m = src.match(/applicationId\s+["']([^"']+)["']/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Orchestration
 * ------------------------------------------------------------------ */

function validate({ repoRoot = REPO_ROOT, allowUnresolvedTeamId = false } = {}) {
  const report = createReport();
  const firebasePath = path.join(repoRoot, "firebase.json");

  let config;
  try {
    config = JSON.parse(fs.readFileSync(firebasePath, "utf8"));
    report.pass("config", "firebase-json-parses", firebasePath);
  } catch (err) {
    report.fail("config", "firebase-json-parses", `${firebasePath}: ${err.message}`);
    report.findings.repoRoot = repoRoot;
    return report.findings;
  }

  const hosting = config.hosting;
  if (!Array.isArray(hosting) || hosting.length === 0) {
    report.fail("config", "hosting-present", "firebase.json has no hosting[] entries");
    report.findings.repoRoot = repoRoot;
    return report.findings;
  }

  for (const site of hosting) {
    const target = site.target || "(unnamed)";
    const ignore = site.ignore || [];

    checkIgnoreList(report, target, ignore);

    const declared = site.public;
    if (typeof declared !== "string" || declared.length === 0) {
      report.fail(target, "publish-dir-declared", "hosting.public is not set");
      continue;
    }
    const publishDir = path.resolve(repoRoot, declared);
    if (!fs.existsSync(publishDir) || !fs.statSync(publishDir).isDirectory()) {
      report.fail(
        target,
        "publish-dir-exists",
        `${declared} does not exist. Firebase would refuse the deploy with ` +
          `"Directory '${declared}' for Hosting does not exist." Build it first ` +
          `(the app that owns it, e.g. cd burgonomics-foundation-core && npm run build:mobile).`,
      );
      // Structural checks below need the dir; report what is knowable and move on.
      checkJsonMimeHeader(report, target, site.headers);
      continue;
    }
    report.pass(target, "publish-dir-exists", `${declared} -> ${publishDir}`);

    // bundle/application ids come from the app that owns this publish dir
    const appRoot = appRootFor(repoRoot, declared);

    checkWellKnownNotIgnored(report, target, ignore, publishDir);
    checkJsonMimeHeader(report, target, site.headers);
    checkAasa(report, target, publishDir, readBundleIds(appRoot), allowUnresolvedTeamId);
    checkAssetLinks(report, target, publishDir, readApplicationId(appRoot));
  }

  report.findings.repoRoot = repoRoot;
  return report.findings;
}

const LEVEL_MARK = { PASS: "ok  ", WARN: "warn", FAIL: "FAIL", SKIP: "skip" };

function render(findings) {
  if (!Array.isArray(findings) || findings.length === 0) {
    return "validate-mobile-hosting — nothing to report";
  }
  const width = Math.max(...findings.map((f) => `${f.site}/${f.check}`.length), 10);
  const lines = [
    "validate-mobile-hosting — read-only iOS/Android release preflight",
    `repo root: ${findings.repoRoot ?? REPO_ROOT}`,
    "",
  ];
  let lastSite = null;
  for (const f of findings) {
    if (f.site !== lastSite) {
      lines.push(`[${f.site}]`);
      lastSite = f.site;
    }
    lines.push(`  ${LEVEL_MARK[f.level]}  ${`${f.site}/${f.check}`.padEnd(width)}  ${f.detail}`);
  }
  const count = (level) => findings.filter((f) => f.level === level).length;
  lines.push(
    "",
    `PASS ${count("PASS")}  WARN ${count("WARN")}  FAIL ${count("FAIL")}  SKIP ${count("SKIP")}`,
  );
  if (count("FAIL") > 0) {
    lines.push("Result: BLOCKED — fix the FAIL rows before a store release build.");
  } else {
    lines.push("Result: ok for hosting config. Signing / Team ID / device verification are out of scope here.");
  }
  return lines.join("\n");
}

function main(argv) {
  const allowUnresolvedTeamId = argv.includes("--allow-unresolved-teamid");
  const findings = validate({ allowUnresolvedTeamId });
  process.stdout.write(`${render(findings)}\n`);
  process.exit(findings.some((f) => f.level === "FAIL") ? 1 : 0);
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = { validate, render, matches, globToRegExp };