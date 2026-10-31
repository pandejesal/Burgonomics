// lane-11 closeout: freeze exact paths -> git blob (tracked) + SHA256 of bytes.
// Read-only: reads git metadata and file bytes, writes only the manifest JSON.
const { execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = "C:/Users/DELL/Desktop/Burgonomics";
const OUT = path.join(ROOT, ".orchestration/run-20261020b/closeout-20261022");

const scope = {
  root: {
    repo: ROOT,
    paths: [
      "scripts/validate-mobile-hosting.cjs",
      "scripts/validate-mobile-hosting.test.cjs",
      ".github/workflows/functions-ci.yml",
      ".gitignore",
      "firebase.json",
      "R15-android-release-signing-repair.md",
      "R18-ios-release-preparation.md",
    ],
  },
  customer: {
    repo: path.join(ROOT, "burgonomics-foundation-core"),
    paths: [
      ".github/workflows/android-build.yml",
      ".github/workflows/ios-build.yml",
      "MAC_INSTRUCTIONS.txt",
      "mac-build.sh",
      "scripts/patch-ios-spm.js",
      "scripts/select-xcode-toolchain.sh",
      "scripts/validate-ios-workflow.test.cjs",
      "public/.well-known/assetlinks.json",
    ],
  },
  partner: {
    repo: path.join(ROOT, "burgonomics-partner"),
    paths: [
      "ios/App/App.xcodeproj/project.pbxproj",
      "MAC_INSTRUCTIONS.txt",
      "public/.well-known/assetlinks.json",
      "scripts/select-xcode-toolchain.sh",
      "scripts/validate-ios-workflow.test.cjs",
    ],
  },
};

const git = (repo, args) =>
  execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();

for (const [name, spec] of Object.entries(scope)) {
  const head = git(spec.repo, ["rev-parse", "HEAD"]);
  const entries = spec.paths.map((p) => {
    const abs = path.join(spec.repo, p);
    const bytes = fs.readFileSync(abs);
    let blob = null;
    let trackedAtHead = false;
    try {
      blob = git(spec.repo, ["rev-parse", `HEAD:${p}`]);
      trackedAtHead = true;
    } catch {
      blob = null;
    }
    return {
      path: p,
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
      trackedAtHead,
      headBlob: blob,
    };
  });
  const doc = { repo: name, head, frozenAt: new Date().toISOString(), entries };
  fs.writeFileSync(path.join(OUT, `lane-11-manifest-${name}.json`), JSON.stringify(doc, null, 2) + "\n");
  console.log(`${name}: HEAD ${head.slice(0, 8)} ${entries.length} paths`);
  for (const e of entries) console.log(`  ${e.trackedAtHead ? "tracked" : "NEW    "} ${e.sha256.slice(0, 16)} ${e.bytes.toString().padStart(7)} ${e.path}`);
}
