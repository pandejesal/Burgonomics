# Production Handoff & Operational Truth

## 1. Status Overview

The 13-commit ledger below is an earlier stabilization snapshot (8 root, 3 customer,
2 partner), alongside reconciliation record `91fd901`. Its counts are not the final
stress-sweep totals. All gates and reviews describe local code and fixtures, not
live provider connectivity, physical device execution, credential validity, or
store-submission readiness. Nothing in this handoff authorizes deployment.

### 2026-10-24 stress-sweep update

The root `stress-fixes-20261024` branch passed TypeScript, the full Functions suite
(98 files passed, one skipped; 1,101 tests passed, two skipped), and build at
`654dd48`. These tests include stubbed gateway HTTP and transaction interleavings;
they do not prove the deployed functions or vendor integrations work. Customer and
partner review-fix commits are recovered locally at `38a25d6` and `d2b6be3`, with
their updated full gates in progress. All three `no-mistakes` runs failed on a
provider quota before push/PR/CI; those pipeline gates are not passed.

Before any rollout, operators must coordinate these dependencies:

- **Refund API:** deploy the backend `refundRequestId` contract before or with the
  partner caller update. Old live callers without that ID are rejected by the new
  backend. Conversely, a new client talking to the old backend is not protected by
  the new request identity: the old schema strips the field. Do not claim that
  client-side validation detects the backend version.
- **Firestore:** the missing `support_tickets (customerId ASC, createdAt DESC)`
  composite is now in the manifest, not deployed. The new
  `payment_refund_requests` and `dispatch_correlation_map` collections have explicit
  client-deny matches. These document the intended boundary; Firestore allows are
  additive, so a future overlapping allow rule must still be reviewed.
- **Partner scoped order queries:** some existing queries use an unordered
  `limit(100)`. Sorting those results in memory does not make them the newest 100
  orders. This is a known potentially missing-ticket defect, not a safe fallback.
  The required `orders (branchId ASC, createdAt DESC)` composite already exists
  in the root manifest; its deployed readiness is unverified. Restore server-side
  ordering and check that index before rollout. The query repair is pending;
  no index rollout was performed in this sweep.
- **KDS merge order:** commit the existing `ui-sweep` delta in
  `useKDSRealtimeStream.ts` before merging the partner stress branch, which
  deliberately carries that delta. The original dirty worktree remains untouched.
- **Provider trust:** uncredentialed Petpooja order callbacks retain a known
  non-terminal status-spoofing exposure. See `references/petpooja_pos.md` section 5.
  Borzo/Shadowfax pending-binding recovery is tested against fixtures, not a live
  vendor callback contract. Porter cannot echo the token and remains fail-closed
  pending operator reconciliation.

No live money, courier booking, POS order, index/rules rollout, hosting deployment,
or autonomous merge was performed by the stress sweep.

---

## 2. Local Commit Ledger

Every commit below was reviewed, gated, and committed locally to its target repository; working trees remain separated from uncommitted staging artifacts.

| Repo | SHA | Lane / Scope | Paths | Gate Result | Independent Review | Explicit Limit of Evidence |
|---|---|---|---|---|---|---|
| root | `636b90d` | Lane 07 FCM ownership | 4 | 952 passed / 2 skipped; build 0 | OpenCode GLM + Antigravity `gemini-3.8-flash-high` APPROVE | Local code only; no live FCM delivery proof; token read and send are non-atomic. |
| customer | `98c8dc4` | Lane 08 customer payments | 8 | 93 files / 695 tests; build 0 | DeepSeek APPROVE → GLM VERIFIED; manifest matched | Client hook/repo truth only; no live Razorpay keys, webhook receipt, or real money movement. |
| root | `20c4600` | Lane 04 dispatch teardown | 3 | 959 passed / 2 skipped; build 0 | 2× GLM + Antigravity `gemini-3.8-flash-high` APPROVE | Unit/fixture state only; no live provider callback or Firestore deployment; Porter lane lacks fence. |
| customer | `ea1bc3f` | Lane 01 customer addresses | 5 | 94 files / 721 tests; build 0 | GLM APPROVE_WITH_NOTES | Seed runs only on saved-addresses mount; tombstones not pruned; route loading/error tested at repo level. |
| partner | `6da19bc` | Lane 02 restaurant dispatch | 6 | 85 files / 574 passed / 1 skipped; build 0 | DeepSeek PASS + GLM VERIFIED | UI/hook choice logic only; backend atomic assignment hardening is separate; no live rider booking. |
| root | `81e20d1` | Lane 02 dispatch doc | 1 | Docs-only | Main read / verified | Orchestration evidence record only. |
| root | `2b3824d` | Lane 11 release infra | 7 | 22/22 focused tests; preflight red/green | GLM APPROVE + Antigravity `gemini-3.8-flash-high` APPROVE | `functions-ci.yml` inspected not executed; iOS blocked without Mac/Xcode/Team ID; AABs left untracked. |
| customer | `7affdf6` | Lane 03 customer menu/a11y | 15 | tsc 0; 12 files / 89 focused; build 0; full at `7affdf6`: 104 files / 820 | GLM APPROVE_WITH_NOTES (prettier-only notes) | Local component tests only; no real device, screen reader, or app-store review; kind tab click does not re-search. |
| partner | `7374d3e` | Lane 06 Petpooja zero-fab | 2 | Partner 11/11 focused, 649 passed / 3 skipped, build 0 | Antigravity `gemini-3.8-flash-low` APPROVE | Refuses demo catalog write outside DEV; no live Petpooja credentials or vendor round-trip. |
| root | `ed3bca0` | Lane 06 Petpooja docs | 2 | Functions 7/7 focused | Antigravity `gemini-3.8-flash-low` APPROVE | Provenance pin proves citation honesty, not vendor confirmation. |
| root | `870c548` | Lane 05b Porter quote guard | 2 | 36/36 focused, 6/6 e2e, 969 passed / 2 skipped, build 0 | `big-pickle` confirmed CLOSED | Local 409 throw before I/O only; does not prove deployed functions updated or keys removed. |
| root | `3f38a76` | Lane 05 Porter references | 10 | Docs-only (9 full files + 2 Porter hunks) | `big-pickle` APPROVE_WITH_CHANGES → findings closed | Reference documents only; excludes dirty UI spec tokens. |
| root | `b6c9269` | Lane 10 Shadowfax evidence | 1 | 90/90 focused, tsc 0 | Main read directly; read-only evidence packet | Read-only static analysis and test evidence; no vendor contract or live wire interaction. |

---

## 3. What is Actually Verified Locally (Code Behavior Only)

All findings reflect static guarantees and isolated test assertions. An HTTP 200, unit assertion, or mock handler is **never** treated as live integration success.

1. **Customer Menu & Touch Accessibility (`7affdf6`)**:
   - `MenuProductCard` presents real remaining servings and disables `ADD` on zero stock.
   - 44px touch targets enforced across `CategoryPills`, `QuantityStepper`, `FavoriteHeart` (44px target bounding a 36px disc), and `CategoryGrid`. The `MenuProductCard` grid ADD control remains 32px minimum (still above the WCAG 2.2 AA 24px floor); the 44px claim is limited to the named controls.
   - `searchStore` enforces last-wins sequence counters for search, trending, and suggestions, preventing stale responses from overwriting active store states.
   - *Limit*: Local Vitest DOM harness only; no physical touch hardware or screen reader verified.
2. **Payment Error & Monetary Truth (`98c8dc4`)**:
   - `useRazorpayPayment` never downgrades monetary state on gateway errors, does not clear carts on unfinalized payments, and halts duplicate submission.
   - `PaymentRepository` hydrates order stores exclusively from server-confirmed records; client cache is untrusted.
   - *Limit*: Mocked Razorpay bridge and unit fixtures only; zero real money moved.
3. **Customer Address Persistence & Default Promotion (`ea1bc3f`)**:
   - `hydrate()` seeds signed-in user addresses from server truth; UID mismatch aborts; revision merge prevents overwriting fresher local writes; tombstones prevent resurrection.
   - Default address promotion is confirmed only after server response; failures leave no false default flag and return `DEFAULT_PROMOTION_FAILED`.
   - Accessible error states retained in `AddressForm` without fake success toasts.
   - *Limit*: Mount-time seed only; checkout cold start limited; tombstones not pruned.
4. **FCM Recipient Ownership (`636b90d`)**:
   - Batch verification checks `device_tokens/{token}.userId` before sending recipient-targeted pushes.
   - Unowned or foreign tokens are withheld from multicast sends; unowned tokens are pruned only from the caller's record.
   - *Limit*: In-memory emulator DB; token read and send are non-atomic; no live APNs/FCM delivery tested.
5. **Dispatch Teardown Binding (`20c4600`)**:
   - Atomic teardown moves active dispatch bindings into `dispatchReleasedBindings` (last 5 entries with ms timestamp) and nulls active tracking fields.
   - Late callbacks from dead/cancelled bookings park with high severity (`order_binding_released`) without mutating order state or firing false customer FCM.
   - *Limit*: Unit tests only; Porter lane lacks fence (retired anyway); no live webhook server.
6. **Restaurant Dispatch Choice (`6da19bc`)**:
   - Partner UI strictly limits dispatch options to Borzo, Shadowfax, or in-house delivery (`POST /orders/manualDispatch`).
   - Porter options completely eliminated from UI cards and dispatch modals.
   - In-house delivery explicitly treated as staff delivery, never conflated with takeaway/customer pickup.
   - *Limit*: Component mock states only; backend atomic race hardening is a separate packet; zero real riders dispatched.
7. **Petpooja Zero-Fabrication (`7374d3e`, `ed3bca0`)**:
   - `petpoojaSync.ts` strictly checks `!import.meta.env.DEV` before loading demo catalog data; throws fatal error in production before executing any Firestore `writeBatch`.
   - References pinned to surviving evidence and explicit notice that 0/5 past webhook cases had verified fulfillment.
   - *Limit*: No live Petpooja API key, no store mapping verified on vendor side, no physical KOT printout.
8. **Porter Retirement & Direct Quote Guard (`870c548`, `3f38a76`)**:
   - `PORTER_ENABLED` defaults to `false`. Requires exact `"true"` to enable full dispatch.
   - `getDeliveryQuote()` in `porter.service.ts` throws `PORTER_RETIRED` (HTTP 409) before GPS coordinate parsing or network I/O.
   - *Limit*: Code-level guard only; does not verify if production Cloud Functions have been redeployed.
9. **Shadowfax Fail-Closed Adapter (`b6c9269`)**:
   - Adapter refuses quote/book calls without trimmed `apiKey`, `clientCode`, and explicit `SHADOWFAX_CONTRACT_VERIFIED=true`.
   - Syntactic URL validation rejects non-root, non-HTTPS, or query-laden base URLs before network dispatch.
   - Production boot halts if `MOCK_SHADOWFAX_DISPATCH` is active.
   - *Limit*: Static analysis and unit tests only; no live vendor staging calls; signature contract unconfirmed.
10. **Release Preflight (`2b3824d`)**:
    - `validate-mobile-hosting.cjs` verifies `.well-known` configuration, catches unmodelled ignore globs, and checks bundle identifiers.
    - Explicitly halts with exit 1 if placeholder `TEAMID` is found in Apple App Site Association.
    - *Limit*: Script run locally; CI workflows not run on GitHub Actions; no mobile build created.

---

## 4. What is NOT Verified or BLOCKED

### Production Deployment & External Services
- **Firebase Deploy & Rules**: Neither Firestore security rules (`firestore.rules`) nor composite indexes (`firestore.indexes.json`) nor Cloud Functions v2 have been deployed to production or staging projects.
- **Petpooja Live Integration**: No production merchant keys (`PETPOOJA_APP_KEY`, `APP_SECRET`, `ACCESS_TOKEN`). No live branch ID mapping (`branches/{id}.petpoojaStoreId`). Inbound webhooks (`/api/petpooja/webhook`, `/api/petpooja/stockWebhook`) unmapped on vendor portal. Historical `"unable to fetch Object from s3 bucket"` error remains unresolved. Real-time 86ing sync and physical KOT printer round-trips are UNVERIFIED.
- **Razorpay Live Payments & Settlement**: Live keys (`RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`) unconfigured. Live webhooks unregistered. Linked account Route split (95/5) and POS cancellation refund approvals (`PENDING_APPROVAL`) lack executive business sign-off. Zero real monetary movement tested.
- **Borzo & Shadowfax 3PL Contracts & Live Credentials**: No production API tokens or webhook callback registrations. Borzo food delivery vehicle type in operating cities unconfirmed. Shadowfax contract, credentials, callback auth, and declared value liability unconfirmed. Written sandbox no-real-rider guarantee is BLOCKED.
- **Real FCM Device Delivery**: APNs authentication key and WebPush VAPID key (`VITE_PUSH_VAPID_PUBLIC_KEY`) unconfigured. Token-to-device push delivery across Android/iOS is UNVERIFIED.
- **Android Physical Device & ADB**: ADB is installed, but no physical device is currently attached/authorized. Device smoke test unperformed.
- **iOS Toolchain & Credentials**: BLOCKED. Requires a physical Mac, Xcode 16+, and an active Apple Developer Program Team ID. Placeholder `TEAMID` still present in `apple-app-site-association`. Partner app lacks `patch-ios-spm.js`.
- **App Store & Play Store Submission (operator-reported)**: Play Console apps uncreated; release signing credentials must be backed up offline before any Play upload; store listing assets and review accounts unfinalized.
- **Production Monitoring, Backups & Alerting (operator-reported where not repo-verifiable)**: No automated Firestore backups scheduled; Google Cloud budget alerts unconfigured; App Check enforcement unconfigured (`APP_CHECK_ENFORCEMENT=false`).
- **Legal & Commercial Sign-off (operator-reported; the support-email mismatch is recorded in `client-handover/OWNER_INFO_NEEDED.md`)**: Terms, GSTIN entity details, and support contact mismatch (`support@burgonomics.com` vs `.in`) unfinalized.

### Exact Shadowfax Vendor Questions (Verbatim from Lane 10)
1. Please provide the official Shadowfax Hyperlocal Marketplace API specification (production base URL, sandbox/staging base URL, authentication headers, serviceability/quote endpoint, create-order endpoint, and tracking/ETA endpoints) as a standalone document or public Postman collection.
2. For the order serviceability (`/api/v1/order-serviceability/`) endpoint: what is the complete request and response JSON schema? Does the quote response provide distance, pickup ETA, drop ETA, quote ID, and quote expiration? How are unserviceable areas or absence of riders indicated (HTTP 400 vs 200 with specific body flags)?
3. For the create-order (`/api/v2/orders/`) endpoint: what is the complete set of mandatory versus optional fields and data types? What are the maximum length constraints for address fields and item array length limits? What is the exact response schema and field name for the canonical provider order ID?
4. What is the declared value (`order_value`) policy? What value must be sent for prepaid versus cash-on-delivery (COD) orders? Does declared value affect transit insurance or liability, and does a value of 0 trigger rejection or penalty?
5. What are the official webhook/callback specifications for order status updates: endpoint registration method, authentication mechanism (custom header with shared secret versus HMAC-SHA256 signature), retry backoff schedule, and payload schema with all possible `order_status` enumeration values?
6. Do callbacks guarantee per-order FIFO delivery ordering, at-least-once delivery, and consistent order identifiers? What deduplication key should be used to prevent duplicate webhook processing?
7. Is a dedicated sandbox environment available, and does test booking in the sandbox guarantee that no real rider will be dispatched? We require written confirmation before performing end-to-end sandbox booking tests.
8. Does the create-order API support an idempotency key (e.g., `client_order_id`), and what is the behavior if a request with an existing key is received (HTTP 409, cached 200, or duplicate order creation)?
9. What are the cancellation rules and APIs for customer-initiated or branch-initiated cancellations? What cancellation charges apply at each order stage, and what callback events are triggered upon cancellation?
10. What are the official credentials provisioning channels, API key rotation procedures, and technical support SLAs for live operations?

---

## 5. Production Activation Checklist (Fail-Closed Sequence)

Follow this strict sequential order. Do not skip steps.

1. `[HUMAN-ONLY]` **State & Database Backup**: Export current Firestore data, indexes, and Cloud Functions configuration snapshot. Ensure rollback scripts are tested.
2. `[HUMAN-ONLY]` **Secret Provisioning Outside Repo**: Store production keys (`BURGONOMICS_ENV=production`, `RAZORPAY_*`, `PETPOOJA_*`, `BORZO_*`, `SHADOWFAX_*`, `OTP_HMAC_SECRET`) in Secret Manager / Cloud Functions secrets (`defineSecret`). A gitignored `functions/.env.<project>` may be used only for local emulation; it is never the source of truth. Never commit secrets to git.
3. `[HUMAN-ONLY]` **Staging Target Deployment**: Deploy Firestore security rules (`firestore.rules`), composite indexes (`firestore.indexes.json`), and Cloud Functions v2 (`functions/src`) to an isolated staging Firebase project.
4. `[HUMAN-ONLY]` **Webhook Registration**: Register endpoint URLs in provider dashboards (Razorpay, Petpooja, Borzo, Shadowfax) with verified callback secrets.
5. `[HUMAN-ONLY]` **Staging End-to-End Test Order**: Execute one complete test order using Razorpay test mode: OTP login -> address selection -> test payment -> order creation -> verify Firestore documents.
6. `[HUMAN-ONLY]` **Petpooja POS & 86ing Validation**: Verify test order triggers real KOT printout on physical kitchen terminal; test 86ing an item in POS updates Firestore `inStock: false` in customer app.
7. `[HUMAN-ONLY]` **Dispatch Refusal & In-House Validation**: Test Borzo/Shadowfax sandbox booking under written no-rider guarantee; test failure fallback to in-house assignment (`POST /orders/manualDispatch`); verify Porter calls return 409.
8. `[HUMAN-ONLY]` **Android Build & Signing**: Verify release keystore offline backup; build signed AAB via `gradlew bundleRelease`; verify upload to the Play Console internal test track only (this is not production submission).
9. `[HUMAN-ONLY]` **iOS Release Prerequisite (BLOCKED)**: Procure Mac with Xcode 16+ and Apple Team ID; replace `TEAMID` in `apple-app-site-association`; run SPM patch on partner app; archive TestFlight build.
10. `[HUMAN-ONLY]` **Store Submission & Legal Sign-off**: Finalize store listings, privacy policy, support email alignment, and terms; obtain executive business sign-off before production traffic switch.
11. `[HUMAN-ONLY]` **Monitoring, Budgets & Rollback**: Configure Google Cloud budget alerts, error reporting, and retain one-command rollback ready.

---

## 6. Business & Operational Facts

- **Firebase Blaze Plan**: Confirmed enabled by user. Do not re-request plan upgrade.
- **Android Debug Bridge (ADB)**: Version 37.0.0 installed at `%LOCALAPPDATA%/Android/Sdk/platform-tools/adb.exe`, but no physical device is currently attached/authorized.
- **Porter Retirement**: Porter is completely retired. `config.porter.enabled` in `functions/src/config/env.ts` defaults to `false`. It requires exact string `"true"` to enable full dispatch. There is no history-only mode; direct quotes/bookings return `409 PORTER_RETIRED`.
- **Dispatch Topology**: Active 3PL providers are Borzo and Shadowfax, plus restaurant-selected in-house delivery via `POST /orders/manualDispatch` (`dispatchType: "manual_branch_terminal"`, `deliveryStatus: "dispatched"`).
- **In-House Delivery vs Takeaway**: Restaurant-selected in-house delivery is handled by restaurant staff riders; it is NEVER customer pickup / takeaway.

---

## 7. Known Residuals & Technical Risks

- **Uncommitted Design System Tokens**: `references/ui_ux_spec.md` contains uncommitted palette tokens, typography tables, and gesture delta (excluded from accepted commits).
- **Dead Documentation**: `stages/10_branches/CONTEXT.md:24` still mentions branch-level `features.porterEnabled` toggle (no code reads it).
- **Untested Physical Accessibility**: Lane 03 menu/a11y improvements have only been verified in headless Vitest; physical screen reader and device touch sweeps remain unperformed.
- **Petpooja Cloud Storage Outage**: S3 bucket error reported in prior integration logs remains unexplained by vendor; 0/5 past webhook cases had confirmed fulfillment.
- **Shadowfax Commercial Contract**: Signature scheme, webhook verification header, and declared value zero policy remain unconfirmed.
- **Zero Live Dispatch Bookings**: No real-world 3PL courier has been booked.
- **Zero Live Money Movement**: No real currency has moved through Razorpay gateway or Route transfers.

---

## 8. Reproduce Commands & Verified Gate Counts

Commands must be executed from clean working trees or isolated worktrees.

### Root & Functions (`C:\Users\DELL\Desktop\Burgonomics\functions`)
```bash
npx tsc --noEmit
npx vitest run
npm run build
```
- Full Gate at `b6c9269` (docs-only `91fd901` follows; numbers hold): 81 files passed, 1 skipped (82 files); 969 passed, 2 skipped (971 tests); tsc 0; build exit 0.
- Focused suites:
  - Shadowfax gates: `npx vitest run tests/dispatch.shadowfax-contract-gates.test.ts tests/dispatch.provider-contract.test.ts tests/dispatch.readiness.test.ts` (3 files, 90 passed).
  - Porter quote guard: `npx vitest run tests/porter.service.test.ts` (36 focused, 6 e2e passed).
  - FCM recipient ownership: `npx vitest run tests/fcm.recipient-ownership.test.ts tests/tickets.notify.test.ts` (35 passed).
  - Teardown binding: `npx vitest run tests/dispatch.teardown-binding.test.ts` (7 passed; red: 6 failed / 1 passed).
  - Petpooja reference truth: `npx vitest run tests/petpooja.evidence-truth.test.ts` (7 passed).
  - Mobile hosting preflight: `node scripts/validate-mobile-hosting.test.cjs` (22/22 passed).

### Customer App (`C:\Users\DELL\Desktop\Burgonomics\burgonomics-foundation-core`)
```bash
npx tsc --noEmit
npm test
npm run build
```
- Full Gate at `7affdf6`: 104 files, 820 passed; tsc 0; build exit 0.
- Focused suites:
  - Payments truth: `npx vitest run tests/server-payment-truth-guards.test.ts tests/paid-order-finalization.test.ts tests/payment-response-wire.test.ts tests/order-service-auth-isolation.test.ts` (focused payment-truth set; the lane 08 full gate at `98c8dc4` was 93 files / 695 tests).
  - Address truth: `npx vitest run tests/address-persistence-failures.test.ts src/routes/profile.addresses.test.tsx` (56 focused passed).
  - Menu & touch a11y: `npx vitest run src/features/menu/components/MenuProductCard.test.tsx src/features/menu/components/CategoryNavRail.test.tsx src/features/menu/components/QuantityStepper.test.tsx src/features/favorites/components/FavoriteHeart.test.tsx src/features/menu/utils/categorySwipe.test.ts tests/search-state-races.test.ts` (12 files, 89 passed; red: 5 files / 21 failed).

### Partner App (`C:\Users\DELL\Desktop\Burgonomics\burgonomics-partner`)
```bash
npm run typecheck
npm test -- --maxWorkers=2
npm run build
```
- Full Gate at `7374d3e`: 649 passed, 3 skipped; build exit 0 (lane-02 baseline at `6da19bc` was 85 files / 574 passed / 1 skipped).
- Focused suites:
  - Restaurant dispatch: `npx vitest run tests/restaurant-dispatch-choice.test.tsx` (30/30 passed; red: 22 failed / 4 passed).
  - Petpooja demo catalog refusal: `npx vitest run src/services/petpoojaSync.test.ts` (11/11 passed).

---

## 9. Prohibited Actions ("Do Not Do This Yet")

Under no circumstances should any developer, agent, or operator perform the following actions until all prerequisites in Section 5 are verified:
- **DO NOT** deploy Cloud Functions, Firestore rules, or hosting to production.
- **DO NOT** push local commits upstream (`git push origin ...`).
- **DO NOT** execute live payments or trigger live refunds with real bank accounts.
- **DO NOT** attempt real 3PL rider bookings on Borzo, Shadowfax, or Porter.
- **DO NOT** execute live catalog writes or syncs against Petpooja production APIs.
- **DO NOT** export customer PII, phone numbers, or addresses from development databases.
- **DO NOT** rotate production secrets or webhooks without staging validation and coordination.
- **DO NOT** weaken Firestore security rules, client auth guards, or App Check monitors.
- **DO NOT** submit an Android AAB or iOS bundle to production tracks or App Store review until all verification gates and business sign-offs are satisfied. A Play Console internal-test-track upload is allowed only after step 8 and is not production submission.
