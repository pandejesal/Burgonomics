# Existing session: close the release-infrastructure packet (Android + iOS readiness)

Queue task: `release-infra-closeout`. Owner: original root11
`ses_ea5c87669ffeLD1vE6kugwmFVm` (DeepSeek V4.1 Flash Free). No replacement writer.
Read `AUTONOMOUS_WINDOW.md`. Deadline 2026-10-22T03:05:59Z. Main is coordinator only.

## What already exists (adopt; do not rebuild)

Existing dirty/uncommitted release work in all three repos. Main already executed the
pure read-only node test suites today and they are GREEN — treat this as the starting
point, not as a completed packet:

- ROOT: `scripts/validate-mobile-hosting.cjs` (458 lines, read-only store preflight)
  + `scripts/validate-mobile-hosting.test.cjs` → **16 tests, 16 pass, 0 fail**
- CUSTOMER: `scripts/validate-ios-workflow.test.cjs` → **10 pass, 1 skip, 0 fail**
  (skip = real bash/Xcode execution unavailable on this Windows host)
- PARTNER: `scripts/validate-ios-workflow.test.cjs` → **8 pass, 2 skip, 0 fail**
  (same Windows-host limitation)
- CUSTOMER: `.github/workflows/android-build.yml` (+26), `.github/workflows/ios-build.yml`
  (+64), `MAC_INSTRUCTIONS.txt` (+48), `mac-build.sh` (+15),
  `scripts/patch-ios-spm.js` (+92), `scripts/select-xcode-toolchain.sh` (new, 168),
  `public/.well-known/assetlinks.json` (2 lines changed)
- PARTNER: `ios/App/App.xcodeproj/project.pbxproj`, `MAC_INSTRUCTIONS.txt` (new),
  `public/.well-known/assetlinks.json` (new), `scripts/select-xcode-toolchain.sh` (new),
  `scripts/validate-ios-workflow.test.cjs` (new)
- ROOT: `.github/workflows/functions-ci.yml` (NEW, untracked) — the discoverable root
  workflow replacing the inert `functions/.github/workflows/ci.yml`; runs `npm ci`,
  `npm run build`, `npm run test` in `functions/`; no deploys, no secrets.
- ROOT: `.gitignore` (+2 lines for `scripts/petpooja-ip-watch.log`,
  `scripts/petpooja-sandbox-evidence.json`).
- ROOT docs: `R15-android-release-signing-repair.md`, `R18-ios-release-preparation.md`.
- ROOT: `client-handover/release-builds/burgonomics-customer-v1.0.0-20261017.aab` and
  `.../burgonomics-partner-v1.0.0-20261017.aab` (new, untracked). The directory already
  tracks release AAB/APK artefacts, so this follows the existing handover convention.

## Exact sole-writer scope

ROOT: `scripts/validate-mobile-hosting.cjs`, `scripts/validate-mobile-hosting.test.cjs`,
`.github/workflows/functions-ci.yml`, `.gitignore`, `R15-android-release-signing-repair.md`,
`R18-ios-release-preparation.md`, `client-handover/release-builds/*v1.0.0-20261017.aab`
(only if you decide they belong; see below).
CUSTOMER: `.github/workflows/android-build.yml`, `.github/workflows/ios-build.yml`,
`MAC_INSTRUCTIONS.txt`, `mac-build.sh`, `scripts/patch-ios-spm.js`,
`scripts/select-xcode-toolchain.sh`, `scripts/validate-ios-workflow.test.cjs`,
`public/.well-known/assetlinks.json`.
PARTNER: `ios/App/App.xcodeproj/project.pbxproj`, `MAC_INSTRUCTIONS.txt`,
`public/.well-known/assetlinks.json`, `scripts/select-xcode-toolchain.sh`,
`scripts/validate-ios-workflow.test.cjs`.
Evidence: `closeout-20261022/lane-11.md`.

OUT of scope: app source, Functions source, rules, payments, delivery, menu, partner
`src/**`, root `firestore.rules`, and every other dirty path. Another owner currently
holds the CUSTOMER repo (payments) and the PARTNER repo (delivery choice): do not
stage, revert, format or "fix" anything outside your list, and do not run a heavy
CUSTOMER/PARTNER build gate while those owners are active — the shared repo gate slot
is theirs; ask on the bus instead of waiting idly.

## Required engineering outcome

- The release preflight must FAIL LOUDLY on the real release-breaking cases it
  claims to prevent: missing/incorrect `Content-Type` on the AASA/assetlinks files,
  an `appID` that does not match the shipped bundle id, an `assetlinks`
  `package_name` that does not match `applicationId`, and a hosting config that would
  drop `.well-known` (the dot-directory ignore trap). Prove the negative cases fail
  for the right reason, not by accident.
- `scripts/select-xcode-toolchain.sh` must enforce its floors (Xcode major and iOS SDK
  major) WITHOUT hard-pinning a single Xcode version, must work on a borrowed Mac,
  and must not silently select a too-old toolchain. The customer and partner copies
  must stay byte-identical (drift guard already exists — keep it true).
- The iOS workflow must not pin unsupported runners and must keep its discovery gate;
  artifact uploads must reference only build outputs.
- `patch-ios-spm.js` must not silently swallow failures.
- State the honest limits: iOS archive/TestFlight/signing still require a Mac and
  credentials → **iOS is BLOCKED, static readiness only**. The Windows host cannot
  execute the real bash/Xcode path, so the skipped tests must remain visibly skipped
  with that reason. No emulator/device claim, no store upload, no "signed release"
  claim without a real build artefact and its provenance.
- The two new AABs: include them ONLY if you can state their provenance honestly
  (which repo, which commit, which toolchain, which date) and the repo convention
  supports it. Otherwise leave them untracked and say so. Do not print keystore
  material, passwords, or any signing secret; existing keystores must never be
  copied, generated or printed.
- `functions-ci.yml` is a GitHub-Actions file: it cannot be executed here. Say so.
  Verify only that it is syntactically coherent YAML with the right working
  directory, node version and no deploy/secrets steps.

## Reviews, gates, commit

Freeze exact paths with immutable copies + Git blobs + SHA256 (three repos, one
manifest each). ONE fresh read-only actual DeepSeek Free reviewer child, THEN a
DIFFERENT fresh read-only actual GLM Free verifier child; verify actual serving
models via the local session API; reviewers spawn no children and write nothing.
Apply findings, refreeze material deltas. On 429/transport stop and report.

Gates: the pure node test suites above are your primary gate and already pass; re-run
them and capture the real counts. The Android/iOS real build needs the toolchain — run
it only if the SDK/JDK is actually present, otherwise report the exact blocker. Do
not claim a build you did not run. Do not run a heavy CUSTOMER/PARTNER app gate while
another owner holds that repo's gate slot.

Commit per repo, only your listed paths, locally; verify committed blobs against the
manifest; never stage foreign work, binaries you cannot justify, or secrets; never
push, deploy, publish to a store, or touch a device.

Report `QUEUE_TASK: release-infra-closeout` with per-repo commits (or BLOCKED), hashes,
test counts, review IDs + actual models, and the explicit limits (iOS needs a Mac;
no device/store acceptance). End with the exact unquoted final line
`SUPERVISOR_STATE: COMPLETE` only when the packet is really closed.
