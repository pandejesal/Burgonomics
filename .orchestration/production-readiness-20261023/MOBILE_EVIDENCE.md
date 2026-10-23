# Customer committed-tree mobile evidence

Scope: isolated customer checkout at `7affdf6`. No production environment files
were copied into this checkout. Compilation does not prove runtime configuration.

| Check | Result |
|---|---|
| TypeScript, no emit | exit 0 |
| Customer package test selection | 99 files / 757 tests passed; exit 0 |
| Firestore rules integration suite | excluded from that selection; NOT VERIFIED |
| `npm run build:mobile` | exit 0; 2,874 transformed modules |
| Hosting validator regression tests | 22/22 passed |
| Initial mixed hosting fixture (original partner output) | 25 PASS / 2 FAIL; exit 1, both Apple TEAMID; NOT a clean partner baseline |
| Same initial fixture, explicit local-only Team ID override | 25 PASS / 2 WARN; exit 0; NOT release approval |
| Fully committed-tree customer + partner hosting fixture | 22 PASS / 3 FAIL: both Apple TEAMID placeholders and missing partner assetlinks.json |
| Fully committed-tree fixture with local Team ID override | 22 PASS / 2 WARN / 1 FAIL; partner assetlinks.json still absent |
| Physical install, signing, runtime APIs, FCM | NOT VERIFIED |

The prior 820-test dirty-primary run is not a committed-tree result. No completed
gate in this table should be repeated merely because OpenCode restarted.

## Artifact hashes (independent Nexus tester)

Tester `ses_e9889ce77ffe42WIAZFTydscHu`, model
`google/antigravity-gemini-3.8-flash-low`, read-only:

| File under `dist/mobile` | SHA-256 |
|---|---|
| `index.html` | `E800AD1BE637F1BDD753FB6A01A23119ECDA9FAB4045303B3AF4AB063BD126E8` |
| `.well-known/assetlinks.json` | `F1105F9A2E6DFE40D8933432119595D6102D5A4A01903BD59CA5DF0606016DB6` |
| `.well-known/apple-app-site-association` | `121F6F621E013EEAEB3DC1E0534740BAFCDF9F6609FBC30F28D5D9EB8D1A706D` |

Referenced HTML assets exist; no source maps found. Android/Capacitor/Xcode IDs
agree on `com.burgonomics`. Apple associations retain `TEAMID.com.burgonomics`:
this is a real blocking placeholder, not an acceptable production identity.

Root, customer and partner committed Firestore rules all have Git blob
`32238e8b1a46eb84622cbfcf20cdc124a060d963`. This proves byte identity only, not
rules execution or deployed-rule state. Java 21 is available; no cached Firestore
emulator artifact was established during this run, so no emulator pass is claimed.

External gate receipt: `%LOCALAPPDATA%/Temp/opencode/customer-isolated-gate-20261023/result.json`.
Hosting fixture: `%LOCALAPPDATA%/Temp/opencode/production-hosting-rehearsal-20261023`.
These machine-local paths are supporting runtime artifacts, not durable independent
provider evidence. They contain no database export or production keys.
The temporary fixture's two directory links disappeared during session recovery;
they were reconstructed against the unchanged build outputs, without rebuilding.
Both strict and local-only checks then reproduced the counts above.

## Partner committed-tree baseline

Isolated `7374d3e`: typecheck exit 0; 85 files / 576 tests passed / 1 skipped;
build-typecheck and Vite build exit 0. The first isolated attempt failed before
assertions in 18 suites because tests depend on a sibling customer DOM dependency
and import Firebase without synthetic config. The corrected external fixture
supplied that dependency junction and test-only dummy Firebase values; a Node
network guard refused non-loopback connections. No app source or real keys changed.
The prior dirty-primary 649-test total is not committed-tree evidence.

The clean partner build lacks `public/.well-known/assetlinks.json` in its source
commit. The original app has an UNTRACKED version with a syntactically plausible
certificate fingerprint, but no verified Play App Signing/release certificate
provenance. It was not adopted or rewritten. A human must verify the correct
certificate identity before this file is accepted and Android App Links approved.
The validator does not establish fingerprint provenance merely by parsing a file.

Read-only follow-up: `keytool -printcert -jarfile` on the existing legacy
`client-handover/release-builds/burgonomics-partner-v1.0.0-20261017.aab` exited 0;
its embedded public SHA-256 fingerprint matches the untracked association file.
This supports a historical candidate, not the current Play App Signing identity.
`jarsigner -verify` did not complete within the command timeout; no archive
integrity/signing approval is claimed. No private keystore or password was opened.

Corrected partner gate receipt:
`%LOCALAPPDATA%/Temp/opencode/partner-isolated-fixture-gate-20261023/result.json`.
Fully committed-tree hosting fixture:
`%LOCALAPPDATA%/Temp/opencode/production-hosting-clean-rehearsal-20261023`.
