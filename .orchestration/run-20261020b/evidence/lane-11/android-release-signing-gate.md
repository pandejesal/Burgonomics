# Lane 11 — Android release signing gate evidence

Owner: `ses_ea5c87669ffeLD1vE6kugwmFVm` (lane 11, `opencode/deepseek-v4.1-flash-free`)
Date: 2026-10-21 (IST) · Host: Windows, PowerShell 5.1

## Toolchain (measured)

| Item | Value |
|---|---|
| JDK | `C:\Program Files\Android\Android Studio\jbr` → openjdk 21.0.10 |
| Android SDK | `%LOCALAPPDATA%\Android\Sdk` (platforms 34/36/36.1; build-tools 34.0.0/35.0.0/36.0.0) |
| compileSdk / targetSdk / minSdk | 36 / 36 / 24 (`android/variables.gradle`, both repos) |
| AGP / Gradle | com.android.tools.build:gradle:8.13.0 / gradle-8.14.3 |
| Capacitor | @capacitor/core 8.5.x (customer 8.5.0 range, partner 8.5.x), @capacitor/android 8.5.x |

## Method (no stash, no reset, no foreign edit)

Isolated detached worktrees from the **committed** HEAD, plus only the lane-11 file:

```
git worktree add --detach C:\Users\DELL\AppData\Local\Temp\opencode\lane11-wt-partner2 HEAD   # partner 643eb09 (re-gated after HEAD advanced from 09fe39b)
git worktree add --detach C:\Users\DELL\AppData\Local\Temp\opencode\lane11-wt-customer HEAD   # customer 29fd0e6
# generated/ignored build inputs, never source:
mklink /J <wt>\node_modules <repo>\node_modules
copy android/local.properties, android/capacitor-cordova-android-plugins\
# key.properties deliberately ABSENT in both worktrees (simulates missing store secrets)
```

Frozen path under test (only file changed vs HEAD in each worktree):
`android/app/build.gradle`.

## A. DEFECT reproduced on committed HEAD (both repos)

HEAD still contains `initWith(signingConfigs.debug)` inside `signingConfigs.release`.
`assembleRelease` with **no keystore and no passwords** completed successfully and produced
an artifact signed by the public Android **debug** key:

```
app-release.apk  (partner worktree, 7,641,417 bytes, 21-10-2026 00:20:21)
Signer #1 certificate DN: C=US, O=Android, CN=Android Debug
Signer #1 certificate SHA-256 digest: 8f3f90a62057409a48d7fc2a750798ec2e209b889ab377ba692204c94a069a48
Signer #1 certificate SHA-1 digest: e6fd0edc9d77e30960692aa5c4cb92f8a1c98d7b
```

Customer worktree at HEAD `29fd0e6`: same result, same `CN=Android Debug`, same SHA-256 digest.
`apksigner verify --print-certs` used; command:
`%LOCALAPPDATA%\Android\Sdk\build-tools\36.0.0\apksigner.bat verify --print-certs app-release.apk`

**Truth label: LOCAL CODE VERIFIED (defect present at the cited HEAD), artifact-level proof.**

## B. FIX verified in the same worktrees (HEAD + only `android/app/build.gradle`)

Final guard (both repos, partner lines 68-106 / customer 69-107) does, for release
artifact tasks only: require readable keystore + store/key password + alias; load the
keystore in-process with `java.security.KeyStore.getInstance(File, char[])`; look up the
certificate for the alias; refuse when the certificate subject contains `CN=Android Debug`
or the alias is `androiddebugkey` (case-insensitive).

### B1. release without keystore → fails closed, names the real path/alias
```
Release signing requires a readable keystore, store password, key password and key alias.
Looked for keystore: <worktree>\android\release.keystore (alias: burgonomics).
BUILD FAILED
```
(partner + customer, identical output shape)

### B2. release pointed at the public Android debug key → refused
Env: `RELEASE_STORE_FILE=%USERPROFILE%\.android\debug.keystore`, alias `androiddebugkey`,
passwords `android` (the public AOSP debug defaults; nothing written to disk, nothing committed).
```
Release artifacts must not be signed with the public Android debug key
(C:\Users\DELL\.android\debug.keystore, alias androiddebugkey).
```

### B2b. same debug store, alias that does not exist → refused
```
Release key alias 'burgonomics' is not present in C:\Users\DELL\.android\debug.keystore.
```
This is the shape a "copy the debug keystore to release.keystore" attempt hits first; the
certificate-subject check is the backstop if the same alias is reused.

### B3. debug development path unaffected
```
BUILD SUCCESSFUL in 24s     (partner worktree)
BUILD SUCCESSFUL in 2m 45s  (customer worktree)
app-debug.apk 9,310,823 bytes
sha256 partner  B6FF831D865ED1D4DF37290E4432208EDC33D67D5D199026C2AEDB6E8A879558
sha256 customer 275B76BBD02C2A634C4E7E1FF8871E38C559148A5341E4EC7EB1B0613B0093FB
```
(Debug APKs in these worktrees are ~9.3 MB because `dist/mobile` web assets are absent from the
worktree; the main trees produce ~30 MB. Size difference is asset payload only, not code.)

## C. Full-app Android positive gate (main working trees, unmodified by this lane)

```
customer: npm run build:mobile -> npx cap sync android -> gradlew assembleDebug -> BUILD SUCCESSFUL (25s)
          android/app/build/outputs/apk/debug/app-debug.apk 30,334,363 bytes? (see note) / partner: 30,334,363 bytes 23:06
partner:  npm run build:mobile -> npx cap sync android -> gradlew assembleDebug -> BUILD SUCCESSFUL (2m27s)
          android/app/build/outputs/apk/debug/app-debug.apk 30,334,363 bytes, 20-10-2026 23:06:36
```
Note: only the partner main-tree figure above was re-measured (30,334,363 bytes). Customer main-tree
debug APK was rebuilt successfully in the same session; its byte size was not recorded before the
worktree runs.

## E. Review provenance and outcome (final, 2026-10-21)

| Step | State |
|---|---|
| Reviewer 1 (fresh read-only child, `opencode/deepseek-v4.1-flash-free`) | v1/v2 review `ses_ea532f603ffehDEYlZG7BHtuJj` (model verified in `session_v2`), v3 `ses_ea427aa40ffexQHWcmUywJ865j`, v4 `ses_ea41ebc92ffea6GIYw4qsV6bWa` — **VERDICT: APPROVE** on v4. Findings applied across the chain: key-material identity check, configuration-cache-safe execution, wrong-key pin (`RELEASE_CERT_SHA256`/`certSha256`, normalised), Android Studio injected-signing validation (not skipped), cause chaining, blank-alias handling, keystore-type detection. |
| Verifier (`opencode/glm-5.3-flash-free`, separate child) | `ses_ea41841e3ffepHWd2uyUhibE84` — first pass `NOT VERIFIED` because the *customer worktree copy* was stale (it lacked two Low hardening fragments the main tree already had); after refreshing the worktree copy: **VERIFIED**, all four guard copies byte-identical (5,834 chars each), behaviour re-run. |
| Isolated exact-bundle gate | PASS. Detached worktree at committed HEAD + only `android/app/build.gradle`; `npm run build:mobile` → `npx cap sync android` → `assembleDebug` BUILD SUCCESSFUL in both repos, with the full web bundle present (partner apk 29,982,162 B; customer 24,550,577 B). Negatives: no-keystore, debug-keystore+`androiddebugkey`, debug-keystore+absent alias, injected `-Pandroid.injected.signing.*` with the debug key, and `--configuration-cache` replay (same readable failure on reuse). |
| Commits | local only, one file per repo, reported on `fresh-run-2-progress`. No push. |

Re-gating note: the partner HEAD advanced (09fe39b → 643eb09 → 64fc3c0) while this lane worked; the guard was re-verified at 643eb09, and `git diff 643eb09..HEAD -- android/app/build.gradle` is empty, so the gate remains valid for the committed file. Customer HEAD advanced 29fd0e6 → 2801d17 with the same empty-diff check for this file.

## D. Explicitly rejected candidate defects (so they are not re-opened)

| Candidate | Why rejected |
|---|---|
| Partner `android:windowSoftInputMode` "missing" | Capacitor 8 core `SystemBars` pads the decor view by the IME inset (`node_modules/@capacitor/android/.../SystemBars.java` 186-240) — manifest `adjustResize` is not the mechanism and adding it would double-count. |
| Partner iOS SPM graph "unresolvable" | All installed plugins declare `from: "8.0.0"`; `CapApp-SPM/Package.swift` `exact: 8.5.2` satisfies them. R18's hard-pin note was measured in an already-patched customer tree. |
| Partner missing `ACCESS_FINE_LOCATION` | `rg` finds no Geolocation caller in partner `src/**`; manifest comment says so. No current user effect. |
| Partner iOS `WKAppBoundDomains` = 3 vs MAC_INSTRUCTIONS "9" | Partner native App Check uses `@capacitor-firebase/app-check` (not reCAPTCHA) and auth is email/password XHR, so no navigation to the missing origins. It is a stale-doc mismatch, not a broken flow. |

## E. Still open in this lane (not claimed by this commit)

- Partner Android has **zero** deep-link intent filters while partner iOS
  `App.entitlements` declares 3 `applinks:` hosts and `public/.well-known/assetlinks.json`
  exists. Partner `src/**` has no `App.addListener('appUrlOpen')`, so adding the native
  filter alone would capture URLs and drop the route — proposal sent to lane 02 instead.
- iOS: real build/archive/TestFlight needs macOS + Xcode + Apple Team ID → BLOCKED.
  `public/.well-known/apple-app-site-association` still carries the literal `TEAMID.`
  placeholder (user-only secret).
