# Release acceptance and planning constraints

This is the required evidence contract for the future plan, not a day-by-day execution plan. No gate below is marked passed by this handoff.

## Targets and ownership

- Both apps on Android and iOS; original targets remain 2026-11-03 for tested release candidates/submission readiness and 2026-11-08 for public launch.
- Submit ready apps/platforms independently when Burgonomics approves; do not synchronise releases at the cost of hiding a blocker.
- Burgonomics owns Apple/Google accounts. Current account verification, organisation/personal classification, signing/provisioning, console permissions and production eligibility have not been checked.
- The user forwards proposed design screenshots to the Burgonomics team for approval. No proposed design, screenshot or release artifact from this task has been approved.
- Store review/identity verification cannot be guaranteed by the agent. Re-check current official policies and actual account status before claiming the dates are attainable. Old notes about Play closed-testing requirements are dated research, not a current account verdict.

## Existing release evidence and gaps

### Direct parent checks

- Customer `.github/workflows/ios-build.yml:1-20,95-103` explicitly produces unsigned simulator/archive artifacts and disables signing. It is not proof of App Store distribution readiness or of an executed CI run.
- Customer `public/.well-known/apple-app-site-association:7,28` still contains `TEAMID.com.burgonomics` placeholders.
- No customer iOS `GoogleService-Info.plist` was found by an exact app-scoped glob. Native Firebase configuration/push readiness needs checking; do not infer that every web Firebase feature is broken from this alone.
- Customer `android/version.properties` says versionCode 1, versionName 1.0.0. Check actual Play history before deciding the next code; never guess what was uploaded.

### Worker checks to revalidate before planning

- Both native projects and older October 17 AAB/APK artifacts exist. They do not establish that current dirty source is in those builds or that either build is production-approved.
- Partner iOS native Firebase config was not found; its SPM/signing workflow needs independent inspection. Do not assume copying the customer's patch is correct.
- Worker reported signing-material files exist without reading their contents. Existence is not custody, valid signing, Play/App Store access or permission to expose keys.
- Old release/checklist documents contain pending legal/privacy, reviewer-access, APNs, Team ID and account tasks. Review their current status rather than treating old placeholders as live account facts.

## Layered evidence, never interchangeable

| Evidence level | What it establishes | What it does not establish |
|---|---|---|
| Source inspection | A code path/config exists in specified bytes | It ran successfully or is deployed |
| Hermetic tests | Specified logic passed under stated mocks | Real provider connectivity, physical printing or concurrency not modelled by the fixture |
| Emulator tests | Rules/local integration under stated emulator configuration | Production IAM/config, real SMS/payment/POS/delivery |
| Browser QA | Actual styled web UI and browser interactions | Native Android/iOS plugin or lifecycle correctness |
| Signed native build | A specific distributable artifact was produced and signature checked | Store approval or all device flows working |
| Native device QA | Specified screens/flows on identified device/build | Another platform/build or untested background/permission states |
| Vendor sandbox | Specified sandbox contract response | Production entitlement, merchant configuration or physical KOT output |
| Supervised live acceptance | Approved real actions and observed receipts | Unapproved outlets, other builds or store approval |
| Store console outcome | Actual submission/review/publication state | Automatic future approval or business-flow correctness |

## Required acceptance matrix

The future plan must assign an owner, source/build fingerprint, environment, test and evidence location to each row:

- Delivery Home/Menu/Cart/reorder/instructions in both themes, large text, gestures and safe areas.
- Partner invite/role/branch access, navigation, order arrival, KDS/audio, stock, disconnect/reconnect and dispatch.
- Delivery/Takeaway/Dine-in independently, including required location/outlet/order-reference handling and genuinely supported tenders.
- Server pricing/payment confirmation, duplicate/ambiguous responses, captured-but-pending POS, refund permissions and reconciliation.
- Petpooja correct branch/items/taxes/options, instruction transfer, duplicate protection, stock propagation and real printed/displayed KOT as applicable.
- Native auth, push registration/delivery, location, permissions, app resume/deep links, secure storage and account/logout isolation on Android and iOS.
- Correct public download/invite-only Partner behaviour and reviewer access without embedding live credentials in a repo.
- Current privacy/support/legal metadata, disclosures, screenshots, bundle IDs, versioning, signing and console requirements for **each** app/platform.

## Verified package commands — run later on owned source

PowerShell 5.1 does not support `&&`. Run each gate separately and inspect its exit; do not continue as if failed commands passed. These commands were read from current package scripts, **not executed** for this handoff.

| Working directory | Gates |
|---|---|
| `burgonomics-foundation-core` | `npx tsc --noEmit`, `npm test`, `npm run build`, `npm run build:mobile`, `npm run lint` |
| `burgonomics-foundation-core` rules gate | `npm run test:rules` with a real local emulator, verified rules-file identity, compatible Java/CLI and actual executed tests; ordinary `npm test` excludes `tests/rules/**` |
| `burgonomics-partner` | `npm run typecheck`, `npm test`, `npm run build`, `npm run build:mobile`, `npm run lint` |
| `functions` | `npm run typecheck`, `npm test`, `npm run build` plus targeted provider/security regression suites |

ICM global gates also require typecheck, unit tests and build for changed code. Read each owned stage's exact Verify contract and resolve script/config differences explicitly. Rules/emulator ports differ by configuration; inspect the runner rather than assuming root port 8085 applies to the customer runner's 8080 default. Do not use a production project for emulator fixtures.

Use current official docs for Firebase/Capacitor/SDK/CLI syntax. For explicit Firebase CLI commands use `npx -y firebase-tools@latest ...` per the Firebase skill; existing package wrappers must be inspected rather than assumed equivalent. Do not run deployment, `serve`, backfill, provider probe or wire scripts as harmless unit checks.

## Failure reporting

Record command, working directory, exit, passed/failed/skipped counts, duration, exact source files/hash, artifact/version and unresolved limitations. A skipped emulator suite, interrupted command, silent spawn failure or older green artifact is not a pass. Existing failures remain blockers unless their relevance is explicitly resolved; never weaken assertions or filters to manufacture green results.

For supervised live acceptance, obtain a separate approval record with outlet, merchant environment, operator, exact order/payment amount, allowed actions, expected receipts, cancellation/refund/dispatch scope and cleanup/reconciliation owner. No such record exists yet.
