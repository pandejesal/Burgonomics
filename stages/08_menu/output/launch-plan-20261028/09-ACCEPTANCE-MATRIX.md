# 09 — Evidence/acceptance matrix and command contracts

**No release gate is marked passed by this planning task.** Existing Android UI observation is limited to the old installed artifacts in document 02. No new typecheck/unit/emulator/browser/native/provider/store acceptance was executed. Proposed paths below describe future evidence; they do not claim those artifacts exist.

## Four release identities

| Release ID | Owned repository | Platform/package | Required release identity |
|---|---|---|---|
| DEL-AND | `burgonomics-foundation-core` | Android / `com.burgonomics` | Source+locks+environment manifest; version/code; signed AAB + installable APK hashes; public certificate identity |
| DEL-IOS | `burgonomics-foundation-core` | iOS / `com.burgonomics` | Same source manifest; marketing/build version; signed distribution archive/export; team/profile/entitlements; exact iOS device/build |
| PAR-AND | `burgonomics-partner` | Android / `com.burgonomics.partner` | Independent source+locks+environment manifest; version/code; signed AAB/APK; certificate identity |
| PAR-IOS | `burgonomics-partner` | iOS / `com.burgonomics.partner` | Independent source manifest; signed archive/export; team/profile/entitlements; iOS device/build |

Both clients additionally record the exact root backend/rules/index contract/deployed version under test. No release is identified by HEAD alone while dirty overlays/native generated assets are unrecorded. Current partial input fingerprints are in [10](10-SOURCE-FINGERPRINTS.md); QA must expand to every source/test/config/generated-web/native input actually shipped.

Before B1 reconciliation, record **both** root and app-mirror rule hashes as “reconciliation pending”; the different Delivery mirror cannot satisfy G03. After B1, only the agreed authoritative bytes loaded by the emulator and bound to the release contract satisfy G03. This is an input inventory, not permission to test or deploy an arbitrary mirror.

## Evidence recipe for every executed case

Store later results at an approved location such as `acceptance/<release-id>/<gate-id>/<run-id>/`, with:

- Case ID, required behaviour, work-package/human/model owner and independent reviewer.
- Exact three repo commits, approved dirty overlay + complete path/SHA-256 manifests, lock/toolchain/config identities; native artifact SHA-256/version/code/certificate and relevant backend/rules/index version.
- Environment/project ID and **sandbox/emulator/live** classification, outlet/mode/tender/caller role, device/OS/locale/font-scale/theme; secrets/PII omitted or redacted. No real customer corpus copied to tests.
- Command + working directory, UTC/IST start/end, exit/signal, passed/failed/skipped/todo **counts**, duration, stdout/stderr and limitations. Missing/zero/aborted execution cannot pass. Approved unrelated skips require explicit rationale; required release cases cannot be skipped.
- Screenshots/video plus hierarchy/interaction proof, computed-style/contrast checks, authorised sandbox receipts or operator witness; artifact path/hash and what it proves. A screenshot alone does not prove successful payment/KOT/permission denial.
- Result stage: proposed/implemented/locally verified/sandbox verified/native verified/operator accepted/store-approved. Reviewer/approver name + date; defects, rerun scope and recovery owner.

Provider identifiers may need a restricted receipt store; link a redacted reference here, never secrets/customer details. Reusing backend test evidence across releases requires the **identical** backend/rules/environment identity and compatible tested client contract; it does not waive per-platform native acceptance.

## Gate matrix

`U` = unexecuted/unverified for a release candidate. `B` = blocked by known predecessor. `—` = not a feature of that app, with coupled evidence still required. All cells must be explicitly resolved, not changed to PASS from historical evidence.

| Gate | Owner / environment / source binding | DEL-AND | DEL-IOS | PAR-AND | PAR-IOS | Required evidence and exit |
|---|---|---|---|---|---|---|
| G01 Baseline + design | A0/A1; offline; relevant G group + complete snapshot | B | B | B | B | Approved per-repo overlay/worktree/comp revision, hash manifest and no overwritten user work |
| G02 Code review/package gates | Engineers + independent GLM; isolated local/CI; exact source/locks | U | U | U | U | Typecheck + all unit tests + web/mobile builds + lint where defined; scoped reviewed diff, no unresolved release-blocking failures |
| G03 Authoritative rules/RBAC | B1/B5/R1; demo emulator; exact root rules bytes | U | U | U | U | Executed staff/customer/branch/create/update/overwrite/refund-field/query regressions and zero required skips |
| G04 Styled UI/appearance | D/P + QA; actual styled local/emulator web build | U | U | U | U | CSS/fonts loaded, white/black/System/override, contrast, 320 reflow/200% text, keyboard/focus/non-colour states |
| G05 Delivery Home/Menu/Cart | D2/D3/D4; local + native source/artifact | U | U | — | — | Four shortcuts, pause/reduced motion, vertical banner gesture, continuous section boundaries/bounded queries, empty-cart reorder, one note → payload |
| G06 Partner operations | P1–P3/B5; synthetic authorised users + native | — | — | U | U | Invite deny/roles/branch, navigation, KDS/alerts/stale/reconnect/terminal/outbox, stock & dispatch truth; no prod demo queue |
| G07 Pricing/payment/rewards/refund | B1/B2; hermetic + emulator + approved sandbox; backend/client identity | U | U | U | U | Every enabled lane uses server price, amounts/currency/capture, duplicate/concurrent/ambiguous paths, equal partial refunds, reward race/cancel policy |
| G08 POS and instructions | B3/B4; hermetic + sandbox + scoped operator | U | U | U | U | Correct outlet/items/options/tax/note, safe duplicate/ambiguous/ACK-no-ID handling, durable retries; actual displayed/printed KOT witness separately |
| G09 Stock + fulfilment/dispatch | B4/B6/P3/D3; emulator + scoped provider/operator | U | U | U | U | Branch-isolated 86, no forged callback state; actual serviceable provider/manual lane, no duplicate bookings or invented riders |
| G10 Native build/signature | R1/R2; approved SDK/Mac/Android toolchain; artifact bound | U | B | U | B | Fresh web-assets sync, correct IDs/version/cert/entitlements, release not debug/unsigned; Android ABI/16 KB evidence; iOS SDK/privacy manifests |
| G11 Native lifecycle/plugins | R2/Q1; each identified Android/iOS build/device | U | B | U | B | Auth/logout/isolation, push/permission/background/resume, location fallback, storage, keyboard/insets/back/deep links; approved recipients only |
| G12 POS pending/escalation | B3/P2 + QA; fake time then scoped native/operator | U | U | U | U | 119/120/299/300s eligibility, actual latency/delivery, no duplicate alert or automatic refund/false acceptance |
| G13 Operator acceptance | O1; separately approved live envelope; all identities | B | B | B | B | Exact outlet/order/amount/operator/KOT/instructions/fulfilment scope, receipts, reconciliation, sign-off; one outlet ≠ all |
| G14 Account/legal/listing | Owner/R3; read-only console + approved metadata | U | U | U | U | Account eligibility/signing/app record/version, privacy/data forms/deletion/support, accurate screenshots, secure reviewer access |
| G15 Submission/review/publication | Owner/R4; exact artifact/console record | B | B | B | B | Explicit submission approval then upload/review/approval/public availability separately, rejection/rollback plan |

## Fulfilment/outlet/tender submatrix (must be instantiated, not implied)

For each outlet proposed for launch, create rows for **Delivery / Takeaway / Dine-in × each actually supported tender × Delivery Android/iOS + staff execution in Partner Android/iOS**. Where an app/platform observes rather than initiates a lane, record that coupled role explicitly. Unsupported tender combinations are “not offered” only with approved configuration evidence, not a skipped happy-path test.

Each row verifies: authorised open/serviceable outlet; mode-specific address/table/order reference (only what the actual approved flow requires); stock/options/current canonical price/tax/fees/rewards; online capture or honest external cash collection; POS mapping/note/one KOT; pending-POS 2m/5m; appropriate kitchen progression, courier/manual or counter/dine-in completion; cancellation/refund authority and reconciliation. **No obsolete Takeaway/Dine-in pickup PIN is added** merely because Stage 05 says so; delivery handover OTP is a separate approved flow.

Negative cases per lane: closed/unserviceable outlet, stale price, item 86/options removed, user/branch switch, duplicate tap/webhook/trigger, callback before local confirm, missing credentials, explicit provider rejection, timeout-after-send, callback reorder/replay, network/permission failure, partial refund and terminal-state update. Fault injection is hermetic; real failures are not manufactured in production.

## Command contracts — future execution only

All commands below require C-approved owned worktrees, installed locked dependencies and isolated non-production configuration. No deploy, `serve`, functions shell, backfill, wire probe or upload command is part of these gates. Inspect tests/setup first; remove live-wire flags from the **test child process** and deny external provider egress. Do not edit global/user secrets or assume a staging label means no real side effects.

### C-GATES — Delivery working directory

Run separately and capture each exit:

```powershell
npx tsc --noEmit
npm test
npm run build
npm run build:mobile
npm run lint
```

`npm test` is `vitest run --exclude 'tests/rules/**'`. It **does not pass G03**. Stage contracts' Vitest gate is reconciled as full applicable unit execution plus the separate real rules gate; if running literal `npx vitest run`, run with the repaired emulator/test configuration so rules genuinely execute, not skip. Do not silently exclude new failing launch tests. Use the package's actual TypeScript version, not an automatically downloaded replacement.

### P-GATES — Partner working directory

```powershell
npm run typecheck
npm test
npm run build
npm run build:mobile
npm run lint
```

`typecheck` is `tsc --noEmit`; `test` is `vitest run`; both builds currently run `tsc` and Vite. Both build outputs remain distinct evidence even if their scripts match. R1 must remove accidental sibling-install dependence.

### F-GATES — root-owned `functions` working directory

```powershell
npm run typecheck
npm test
npm run build
```

Scripts are `tsc --noEmit`, `vitest run`, `tsc`. Add each work package's targeted regression run, then the full unit suite; targeted green alone is insufficient. Node 22 per package engine. Do **not** inherit `WIRE_BORZO=1`; `tests/wire.env.setup.ts` explicitly loads real `.env` in that mode. Inventory any other wire/provider opt-in before execution and block egress. Vitest defaults alone are not an isolation boundary.

### RULES-GATE — after B1/R1 repair, Delivery working directory

Current runner hardcodes non-demo `burgonomics-test-rules`, reads cwd mirror through tests, and maps null status to zero. **Do not execute it unchanged as acceptance.** Repair its error/status handling, align project ID in all four suites and explicitly load/assert root authoritative rules bytes. Synchronising/removing mirrors requires approved ownership, not copying over dirty files here.

Required wrapper command after repair: `npm run test:rules`. Equivalent explicit CLI template only once config/tests are aligned:

```powershell
$env:CI = "true"
$env:FIRESTORE_EMULATOR_PORT = "8080"
npx -y firebase-tools@latest emulators:exec --config firebase.json --only firestore --project demo-burgonomics-launch "npx vitest run tests/rules --reporter=verbose --hookTimeout=120000 --fileParallelism=false"
```

Record resolved Firebase CLI/JDK versions. Save/restore prior shell environment in the execution harness; do not alter the user's active Firebase project. Verify hash of root rules **before/after**, actual test-loaded bytes equal it, emulator project ID/port are consistent, test count >0 and no required skips. Customer config is **8080**; root emulator config is **8085**. Do not point one test process at the other blindly. No production fixtures/imports or Firebase collection reads.

### C-BROWSER / P-BROWSER — styled-browser gate

Existing browser configs are **partial**, not launch coverage:

- Delivery `tests/playwright/ui-a11y-gestures.config.ts` bundles a gesture utility into a file harness; it does not prove full styled Home/Menu/Cart.
- Partner equivalent config needs an already-served `UI_BASE_URL`, skips without it and covers public surfaces only; no authenticated KDS/stock proof.
- Root `playwright.config.ts` serves built apps at ports 5173/5174 and may reuse an existing server; it does not automatically prove the serving files match a new source manifest.

Q1 owns proposed new configs/specs: Delivery `tests/playwright/launch-delivery.config.ts` + `launch-delivery.spec.ts`; Partner `tests/playwright/launch-partner.config.ts` + `launch-partner.spec.ts`. These **do not exist yet**. After approval/creation, commands from the corresponding app working directory are:

```powershell
npx --no-install playwright test -c tests/playwright/launch-delivery.config.ts
```

or

```powershell
npx --no-install playwright test -c tests/playwright/launch-partner.config.ts
```

R1 must make the runner dependency explicit and use an available approved browser; no implicit download/install. Serve a fresh **actual styled** app build configured to demo/emulators with synthetic users and no external provider egress, not a real authenticated customer profile. Record served bundle/CSS/font hashes; reject stale/reused server mismatch. Test 320/390/768 widths, light/dark/System, reduced motion, large text, keyboard/focus, errors/reconnect and real components/routes. Record computed styles plus screenshots/traces/requests. Browser test fixtures are not provider verification and not native device proof.

### Native templates — not run here

From each app's owned worktree, after all relevant package gates and explicit native-build approval:

```powershell
npm run build:mobile
npx cap sync android
```

Then from that app's verified `android` directory: `.\gradlew.bat assembleRelease bundleRelease` using owner-controlled signing; inspect final manifest/cert/artifacts. Before/after native generated assets must be fingerprinted. Release signing guards must fail rather than use debug credentials. Use verified SDK executable paths for signature/ZIP/ELF analysis; never print key passwords.

For iOS, on an approved Mac runner, build mobile web assets and `npx cap sync ios`, apply only that app's proven SPM step, then use the approved Xcode project/scheme/distribution/export options for a **signed** archive/export. Concrete signing arguments depend on the owner-verified profile/team and are intentionally not guessed here. An unsigned archive command is not the release gate. Store upload is separate F authority.

Record installed device APK/export identity; check TalkBack/VoiceOver, OS theme/reduced motion/text size, foreground/background/resume/kill/relaunch/permissions/deep links and all app-specific cases. Newly installed artifacts require installation approval; observing the pre-existing phone build is not a substitute. Do not change GPS, device permissions, keys or production account state just to fill a matrix cell.

### PowerShell failure handling

Do not paste Bash `&&` into this host or trust a semicolon chain that continued after failure. Capture `$LASTEXITCODE` immediately after **each** command and stop on failure; record process signals/timeouts too. Example execution harness pattern (not a combined gate run here):

```powershell
npm run typecheck
$code = $LASTEXITCODE
if ($code -ne 0) { throw "Typecheck failed: $code" }
```

Use package working directories, not workspace root (root package has browser dev dependencies, no application build/test scripts). Builds do not substitute for tests, and tests do not substitute for build/typecheck.

## Q1 — Integrated acceptance/regression work package (24–40 hours)

Owner: QA/release engineer / NIM route conditional; independent GLM Free review; engineers fix owned defects. Stages 01/02/03/04/05/06/08. Prerequisites: relevant implementation/review exits, R1 isolation/rules runner, R2 signed artifacts, R3 secure test/reviewer accounts. Existing read/owned test infrastructure: root `playwright.config.ts`, `playwright-webview-tests.spec.ts`, `scripts/spa-server.mjs`; per-app existing browser configs/specs above and the tests explicitly assigned in documents 03–05. Proposed new full-app browser suites as above; any wider regression-file ownership must be enumerated/hashed before editing. Root/server test harness must be inspected for private/live side effects before execution, not blindly run.

Acceptance: all required G02–G12 cases on exact integrated source/build/environment, counts/skips accounted for; signed Android and iOS independently; no P0/P1 launch blocker open; scope coverage list includes every offered outlet/mode/tender. Commands: C/P/F-GATES, RULES-GATE, C/P-BROWSER, native templates and approved hermetic/provider test envelopes. Fingerprints: complete release-source/lock/config/rules manifests + each signed artifact, not only G-group snapshots. Recovery: preserve failures, return defects to owning lane, rebuild and rerun impacted + full required gates; never modify expectations/skips to manufacture green. External blockers: requested test/review routes, Mac/iOS/16 KB environment, test accounts and sandbox entitlement.

Q1 is a **rolling per-release window**, starting only when that lane's prerequisites pass. Reserve the estimated 24–40 hands-on hours and actual qualified QA/device/rebuild capacity; it is not a one-day task because the grid lists it on Day 6. Earlier component/package checks do not replace integrated/native cases. A lane missing evidence on 3 November remains not-ready and continues past the checkpoint; parallel runs require genuinely available independent people/devices, not five model names.

## O1 — Supervised live acceptance work package (6–10 hours for agreed pilot)

Owner: Burgonomics outlet operator + finance/provider owner + QA; Phoenix route may assist interpretation, never authorise actions. Stage 05/04/08. **Prerequisites:** offline/emulator/sandbox/native exits and a separate signed approval specifying exact environment/outlet/restID, source/builds, operator/time window, order/items/notes/mode/tender/amount, allowed capture/cancel/refund/dispatch/stock/push/SMS actions, maximum exposure, stop conditions and reconciliation owner. No such action approval exists now.

Owned source: read-only exact accepted manifests/B3/B4/B6 clients and backend; proposed output is restricted receipts/witness record plus redacted ledger references. No live-command invocation is prescribed without scope. Acceptance: operator matches actual POS order/outlet/items/tax/instructions, displayed KOT and **physical print where used**, genuine capture/cash/fulfilment/stock behaviour, pending/escalation recovery, and reconciles every approved financial/booking action. HTTP 200 or sandbox ACK alone fails the physical KOT case. Do not deliberately produce real outages/double payments to test a race.

Failure/rollback: stop further approved test actions, preserve capture/POS/booking identities, contact named operator/provider/finance owner and reconcile. Refund/rebook/cancel is not automatic cleanup and must fit the approved envelope; otherwise obtain further approval. Evidence for a single outlet/build does not enable every branch or changed build. Store approval/publication remains G14/G15, not an inference from the pilot.
