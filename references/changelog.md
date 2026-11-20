# BURGONOMICS — Changelog (Layer 3 Reference)

> **All notable changes across Burgonomics applications and backend. Format: Keep a Changelog + SemVer.**

> **Retirement note (2026-10-22; code retirement in root `086b60d`, business sign-off date not recorded here).** Porter was later
> RETIRED as a dispatch partner: dispatch is Borzo / Shadowfax or the restaurant's own in-house rider via
> `POST /orders/manualDispatch` (`deliveryStatus: "dispatched"`, `dispatchType: "manual_branch_terminal"` — restaurant-driven delivery, never customer pickup), and Porter stays cold unless `PORTER_ENABLED="true"` (which
> re-arms FULL dispatch — no history-only mode). The historical entries below are annotated where
> relevant; original wording is preserved as evidence.

---

## [Unreleased] — 2026-11-20 (Petpooja inbound callback replies matched to the docs)

### Fixed
- **Item On/Off webhook (`/petpooja/stockWebhook`)**: the documented `itemID` is an array; the handler read one scalar, so a multi-id callback failed the doc-id guard and every id was dropped. Both shapes now normalise to a bounded id list (≤200), each id is applied through the same identity/ownership/version-precondition rules, and the batch reports one outcome (all applied / retry when any failure is retryable / `partial: n/m applied` when a permanent park blocks the rest). A replay of an already-applied toggle no longer rewrites the product; the idempotence check runs on the fresh transaction read so a concurrent staff write stays a version conflict.
- **Stock webhook reply**: now the documented `{"code":200,"status":"success","message":"Stock status updated successfully"}` (failure body `{"code":400,"status":"failed","message":"Stock status not updated successfully"}`), replacing `{"status":"success"}`. A redelivery keeps its fail-closed 503.
- **Get Store Status (`/petpooja/webhook`)**: answers the documented `{"http_code":200,"status":"success","store_status":"1","message":"Store Delivery Status fetched successfully"}` with `store_status` derived from the branch's real state (`active:false` or `acceptingOrdersStatus:"closed"` → `"0"`).
- **Update Store Status (`/petpooja/webhook`)**: applies the documented `store_status` `0`/`1` encoding to `branches/{id}.acceptingOrdersStatus` (+ `turnOnAt`, `storeStatusReason`) and answers the documented body. Idempotent; the legacy `{restID, status}` ping is still recorded and never applied; an uncredentialed shape-admitted update is recorded and refused; an unlinked `restID` or undocumented value answers `http_code:400` / `store_status:""` and changes nothing.
- **Push Menu (`/petpooja/menu-sync`)**: an ingested push now answers the documented `{"success":"1","message":"Menu items are successfully listed."}` instead of `{"success":true,"itemCount":N}`. Menu processing is unchanged; a refused unlinked outlet keeps its diagnostic body.

### Verified
- Order callback: no change needed — the documented `{restID, orderID, status, …}` shape already resolves, maps and answers 200.
- Not ours, still open: Rider Information (`rider_status_update`) returns Petpooja's SQS passthrough instead of the documented 200 body.
- Regression suite `functions/tests/petpooja.callback-replies.test.ts` (24 tests) pins the documented bodies; full Petpooja set 575/575 and functions typecheck clean.

## [Unreleased] — 2026-11-20 (Petpooja callback follow-ups, r2)

### Fixed
- **Get Store Status reachable without a credential.** The documented request is a bare `{"restID"}`; the shape allowance required a status key, so genuine vendor calls 401'd at the middleware. `verifyPetpoojaAuth` now also admits exactly that shape on `/petpooja/webhook` (`looksLikePetpoojaStoreStatusRead`: a restID, no `status`/`store_status` key, no order reference). The GET path stays read-only, an unknown `restID` gets the documented failure, and `petpooja_store_status_events.trusted` now records the real verdict (`isTrustedPetpoojaAuth`) instead of `true`. `/petpooja/stockWebhook` and `/petpooja/menu-sync` still 401 a credential-less body; every write path remains credential-only.
- **Update Store Status now actually stops and restarts customer ordering.** r1 wrote only `branches/{id}.acceptingOrdersStatus`, which no ordering path reads. The update now writes the live gate `stores/{id}.isOpen` (the field `storesService.mapStoreDoc` surfaces and `PaymentRepository` refuses to open the gateway for), keeps the branch flag in step, and mirrors into an **existing** `admin_stores` doc only. Storefront resolution is `partnerBranchId`/`petpoojaRestId`, with the customer directory's `admin_stores` fallback honoured; an unlinked or ambiguous outlet is refused with the documented failure body and nothing written. Repeated identical updates are idempotent. Precedence on this branch: the POS owns open/closed while the outlet is linked (rule A); an operator override (rule C) is the documented target. Known gap deferred to the Partner app fix wave: the Partner toggle writes only `admin_stores` and never the customer gate.
- **Item On/Off no longer answers success after truncating at the 200-id cap.** `normalizeStockItemIds` reports `{ids,total,truncated}`; an over-cap batch is refused wholesale with the real total named (nothing applied), a permanent partial is `outcome: "partial"` with `n/m applied` and the documented failure body, and `pos_webhook_audits` records `partial` plus an explicit `partial: "n/m"` field. The audit `itemId` is a capped summary (`summariseStockItemRef`, ≤96 chars) rather than the raw unbounded `itemID` array.
- **Small corrections.** `storeStatusFailure(message, kind)` — GET failures now report `kind: "get"` (they were labelled `update`). `turn_on_time` is capped at `MAX_TURN_ON_TIME_CHARS` (64) by `normalizeTurnOnTime` before it is persisted. Get Store Status answers closed when either the storefront gate or the branch flags say closed.

### Verified
- RED-first suite `functions/tests/petpooja.callback-replies.r2.test.ts` (21 tests, 13 red against r1) plus the r1 suite (24 tests) pin the new behaviour. Full Petpooja set 596/596, functions typecheck and build clean.

## [Unreleased] — 2026-11-19 (Audit remediation deployed to staging)

### Fixed & Deployed (staging `burgonomics-7faa8`, production untouched)
- **F06 staff suspension**: `users/{uid}.active` now gates every privileged path — Firestore `staffActive()` as the last conjunct of both `hasRole` arms plus the Storage `privilegedAndActive()` single-read gate, the server `requireRole` gate (`403 ACCOUNT_SUSPENDED`), and `POST /auth/suspendStaff` (one transaction, denies self-suspension, audited, `revokeRefreshTokens` secondary). Clients can no longer write `active`/`suspendedAt`/`suspendedBy`. Missing field = suspended, so staff profiles were inventoried and backfilled on staging before enforcement.
- **F24 customer cancellation**: `POST /orders/customerCancel` (server-first, non-terminal and rank ≤ `PREPARING`, no rider assigned; 409 otherwise). Rules deny direct client cancellation in all mirrors; idempotent retries; durable provider-cancel intent on rider-bearing bookings.
- **F08 uncertain dispatch create**: transport classification from the cause chain (bounded, non-enumerable `cause`, no body/credential leakage); only proven pre-send codes fail over; 5xx and unreadable bodies park as `PROVIDER_BOOK_AMBIGUOUS` before the id guards, so an uncertain booking can no longer produce a second paid courier booking. Same error shape across Borzo, Shadowfax and Porter.
- **F17 private-key resend**: an unchanged legacy private key re-sent into the public `admin_stores` document is denied — the empty `affectedKeys()` diff can no longer satisfy the public-shape test (canonical `70e620ea…9713`, byte-identical in the customer mirror; Partner's own drift preserved with the blocks LF-equal).
- **F23 refund-gateway 409**: treated as reconciliation-required uncertainty, not a rejection.
- **F04 kitchen admission**: requires the server capture marker, not `method === 'online'`; legacy fixtures were moved to an explicit non-gateway lane rather than the gate being relaxed.
- **F10 dependency-setup test**: verified 19/19 inside the unchanged 5000 ms timeout (case 9 at 46 ms); test-only import hook, no timeout or threshold changed.

### Changed
- Deployment: functions (18), hosting (both sites), Firestore and Storage rules released to staging through the reviewed rollback-aware driver in six phases; pre-deploy rollback state recorded. No commit, push or production change.

## [Unreleased] — 2026-10-02 (Spec v2.1 — Multi-Provider Dispatch Requirements & Phase 7 Plan)

### Added
- **Spec Version 2.1** (.swarm/spec.md, 2026-10-02): multi-provider delivery dispatch requirements — FR-021 cheapest-serviceable-wins routing across Borzo/Shadowfax/Porter (parallel quote fan-out bounded by DISPATCH_QUOTE_TIMEOUT_MS default 6000 ms after the branch-radius gate, tie-break borzo > shadowfax > porter, bounded booking failover, fail-closed HTTP 503 when no provider is serviceable, ₹20/10% book-time fare-drift confirmation), FR-022 fail-closed per-provider webhook HMAC verification with unknown/stale/conflicting events parked as needs_review, FR-023 Porter manual-hybrid dispatch lane (POST /dispatch/porter-manual for food-vertical API refusal), FR-024 dispatch mock-flag ban rejecting MOCK_BORZO_DISPATCH/MOCK_SHADOWFAX_DISPATCH/MOCK_PORTER_DISPATCH at production boot, plus Scenario 9, Assumptions A-007/A-008, the In-Scope dispatch bullet, and Success Criteria amendments 1/10/13.
- **Plan Phase 7 (Multi-Provider Delivery Dispatch)**: tasks 7.1 dispatch router/adapter audit against references/delivery_routing.md, 7.2 fail-closed provider webhook verification and test gaps, 7.3 partner POS manual-hybrid dispatch UI, 7.4 dispatch environment keys and mock-flag ban; the full verification suite task's dependencies extended with 7.1-7.4. *(2026-10-22: Porter has since been retired — see `086b60d`; the opt-in rule now governs 7.1/7.4 and FR-023 records are historical.)*

## [2.6.2] — 2026-09-10 (Audit Loop 1-12 Complete, 606 Tests Gate)

### Fixed & Verified
- **12-Loop Audit Campaign Closed** (all checkboxes green): swallowed errors, rules/queries/indexes, money paths, webhooks, notifications, menu pipeline, auth/RBAC/session, mock-deadcode census (5 zero-ref deletions), perf/native parity (no-op, 12 queued), logging/PII/secrets (quote-log message-only, KDS phone masked), a11y/UX dead-ends (double-submit guards, refund label, dispatch confirm, deep-link routing), adversarial re-review (all Loop-3/Loop-7 attacks hold).
- **Monorepo Test Suite (606 Total Tests Passed, 91 Suites, 0 Failures)**: functions 234/234 (23 suites), partner 151/151 (30 suites), core 221/221 (38 suites), Firestore rules 20/20 green under emulator. All three builds clean.
- **Queued (product/server calls, carried in AUDIT_LOOP_REPORT.md)**: cash-order server pricing endpoint (P0), mock-as-live-path purge, server aggregation for dashboards, query limits, iOS entitlement + keystore verify, reconciliation role normalization.

## [2.6.1] — 2026-09-09 (Quality Loop 20/20 Complete, 602 Tests Gate & Full Sweep Verification)

### Fixed & Verified
- **Monorepo Test Suite Expansion (602 Total Tests Passed, 91 Suites)**:
  - **Functions Backend**: 230 / 230 tests across 23 test suites (`auth`, `porter`, `petpooja`, `payments`, `tickets` + ticket-authz + ticket-notify, `notifications`, `e2e.flow`, `pricing.parity`, `customerCoins`, `orderBackfill`, `paymentSignature`, `webhook.replay/reject`, `webhooks.idempotency`, `fcm.notifications`, `routeValidation`, `env.failclosed`, `batch4.bridge`).
  - **Partner POS App**: 151 / 151 tests across 30 test suites (`kds`, `thermal-kot`, `porter-logistics`, `rbac`, `analytics`, `orders`, `tickets`, `settings`, `dashboard`, `order-detail`, `delivery-queue`).
  - **Customer App**: 221 / 221 tests (+18 Firestore rules) across 38 test suites (`pricing`, `cart-fulfillment`, `bogo`, `coupons`, `geofencing`, `parity`, `reconcile`, `payments`, `auth`, `support`, `benchmarks`).
- **Upstream MOP-S1/B-Series Merged**: fail-closed env (no mock literals), B3-S1 authz model, B4-S1 bridge hardening, B5-S1 ticket honesty + spam guards, B6-S1 perf/hygiene — merged with doc counts and ticket guards, conflicts resolved keeping both sides.
- **Loop 57/58 Adversarial Findings Closed**: resolveTicket double-resolution guard (409) layered over autoRefund idempotency, addTicketMessage claims-derived authz with ticket visibility checks, pinned by tests.
- **Quality Loop 20/20 Campaign Completed** (Loops 1-20: swallowed errors, Firestore rules, money paths, notifications, menu pipeline, auth/RBAC, performance, UX dead-ends, test quality, docs/config drift, indexes, logging, accessibility, resilience, type safety, secrets, notification topics, dead code, Capacitor parity, final verification).
- **UI Sweep 10-Iteration Campaign Closed** (B1-B11 ban list, zero regressions verified across core/partner at mobile 390x844 and tablet 768x1024).
- **Repository Hygiene**: Stale Netlify legacy archived (`_archive/netlify-legacy`), Petpooja barrel consolidation, 4 dead files removed, old codebase improvement report archived.

---

## [2.6.0] — 2026-09-01 (Store Publication Readiness, 404 Tests Gate & Live Gateway Hardening)

### Added & Verified
- **Master Release & Integration Guide (`RELEASE_AND_INTEGRATION_GUIDE.md`)**:
  - Full end-to-end technical specifications for Petpooja POS (V2.1.0) and Porter Logistics v1 live vs. mock operations.
  - Complete App Store Connect (iOS) and Google Play Console (Android) publishing workflows, review credentials, graphics dimensions, and Data Safety declarations.
- **Monorepo Test Suite Expansion (404 Total Tests Passed)**:
  - **Functions Backend**: 86 / 86 tests passed across 13 test suites (`auth`, `porter`, `petpooja`, `payments`, `tickets`, `notifications`, `e2e.flow`).
  - **Partner POS App**: 118 / 118 tests passed across 22 test suites (`kds`, `thermal-kot`, `porter-logistics`, `rbac`, `analytics`, `orders`).
  - **Customer App**: 200 / 200 tests passed across 33 test suites (`pricing`, `cart-fulfillment`, `bogo`, `coupons`, `geofencing`, `parity`, `reconcile`).
- **Gateway & Security Gap Closures (R6–R22)**:
  - Implemented fail-closed Porter quote validation, strict JSON error handling, branch delivery radius geofencing pre-check, and cryptographic delivery OTP verification.
  - Aligned Petpooja order push to standard nested `orderinfo` schema with `clientOrderID` deduplication and per-branch `restId` resolution.
  - Hardened Razorpay authoritative webhook handling with idempotent Route transfer locks, captured pre-checks, and caller-distinct refund keys.
  - Locked Firestore `coupons` to server-only writes and auth-gated `petpooja_offers`.

---

## [2.5.3] — 2026-08-29 (Zero-Mock Audit, Partner POS Bridge & Client Handover Package)


### Fixed & Enhanced
- **Partner POS Backend Bridge (`partnerFunctionsApi.ts`)**:
  - Eliminated client-side random string generator (`PP-KOT-...`) in `useOrder.ts` by bridging `pushToPetpooja` mutation directly to authoritative Cloud Function `/petpooja/pushOrder`.
  - Eliminated client-side sample rider picker (`sampleRiders`) in `useOrder.ts` by bridging `autoDispatchPorter` mutation directly to authoritative Cloud Function `/porter/book`.
  - Replaced stub returns in `porterDelivery.ts` (`verifyDeliveryOtp`, `manualBranchDispatch`) with live calls to Cloud Functions `/orders/verifyDeliveryOtp` and `/orders/manualDispatch`.
  - Implemented automatic Firebase Auth ID token attachment (`Authorization: Bearer <idToken>`) for all partner cloud operations.
- **Verification & Store Packaging**:
  - Re-verified all test suites: 27 backend unit tests, 74 customer app unit tests (including 611k ops/sec cart stress test), 0 TypeScript errors across all 3 packages (`functions`, `burgonomics-foundation-core`, `burgonomics-partner`).
  - Synced Capacitor Android native projects for both apps with the latest compiled web bundles.
  - Published master client handover guide `CLIENT_HANDOVER_AND_KEYS.md` with copy-paste `.env` files, webhook URLs, and a 4-day handover timeline.

---

## [2.5.2] — 2026-08-28 (Integration Accuracy & Production Quality Remediation)

### Fixed & Hardened
- **Petpooja POS Integration**:
  - Resolved `isVeg` parsing bug in `petpooja.service.ts` removing `|| true` tautology.
  - Aligned `pushOrderToPetpooja` to send `app_key`, `app_secret`, and `access_token` in the JSON request body matching the Petpooja POS API standard.
  - Added bidirectional `normalizePetpoojaStatus` mapping numeric codes (`-1`, `1..3`, `4`, `5`, `10`) and string statuses.
  - Enforced `timingSafeEqual` in `verifyPetpoojaAuth` webhook middleware.
  - Parallelized branch menu sync in `petpooja.scheduler.ts` with chunked `Promise.allSettled` in batches of 4.
- **Porter 3PL Logistics Integration** *(historical — Porter has since been retired, see `086b60d`; these capabilities are dormant behind `PORTER_ENABLED="true"`)*:
  - Upgraded courier dispatch payload with structured nested address and contact details schemas.
  - Implemented `normalizePorterEvent` reconciling Porter standard events (`ASSIGNED`, `IN_TRANSIT`, `DELIVERED`, `CANCELLED`, `ARRIVED_AT_PICKUP`).
  - Added 10-minute quote fee lock TTL (`validForSeconds: 600`, `expiresAt`) in backend and partner app.
  - Centralized Haversine distance and Porter 2W rate card logic in `functions/src/core/utils/geo.utils.ts`.
- **Customer App Payments**:
  - Implemented production `RazorpayAdapter` in `burgonomics-foundation-core/src/core/integrations/razorpay` delegating to `paymentsService` with simulation and live test support.
- **Testing & Verification**:
  - Added comprehensive `e2e.flow.test.ts` validating complete lifecycle: Authoritative Pricing → Razorpay Route Split → Petpooja KOT Ingestion → Kitchen State Transition → Porter Dispatch → Webhook Lifecycle → Post-Checkout Auto-Refund.

---

## [2.5.1] — 2026-08-25 (India Security Hardening & Zero-Vulnerability Gate)

### Security & Hardening
- **Cloud Functions v2 RBAC & Auth Middleware**: Created `requireAuth` enforcing ID token verification with `checkRevoked: true`, `requireRole` supporting 6-tier roles, and `verifyPetpoojaAuth` webhook validation in `functions/src/core/middleware.ts`.
- **API Protection**: Hardened all 15 Cloud Function endpoints with Bearer token authentication and role checking.
- **Authoritative Server-Side Pricing Engine**: Hardened `pricing.engine.ts` with real-time Firestore `products` catalog price resolution to prevent client price tampering. Capped Grill Coins loyalty burn at 20% of subtotal.
- **Firestore Security Rules Hardening**: Blocked mass-assignment of `role`, `isStaff`, `isBrandAdmin`, `isSuperAdmin`, `grillCoins`, and `loyaltyPoints` in `users/{userId}`. Restricted global catalog writes to `isBrandOwner()`.
- **Token Revocation on Role Changes**: `setUserCustomClaims` now invokes `auth.revokeRefreshTokens(uid)` upon role assignment to immediately invalidate stale tokens.
- **CORS Whitelisting**: Replaced wildcard CORS with strict domain whitelist (`burgonomics.com`, `partner.burgonomics.com`, `burgonomics.netlify.app`, `capacitor://localhost`).
- **DPDP Act 2023 Compliance**: Customer identifiers, phone numbers, and addresses are masked in developer alerts and error snapshots.
- **Resource Constraints**: Configured Cloud Functions v2 resource bounds (`maxInstances: 20`, `timeoutSeconds: 60`, `concurrency: 80`, `memory: "512MiB"`).
- **Production Sourcemap Disablement**: Configured `sourcemap: false` in `burgonomics-partner/vite.config.ts`.
- **Hosting Security Headers**: Configured CSP, HSTS, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, and `Referrer-Policy` in `firebase.json`.

---

## [2.5.0-Gold] — 2026-08-25 (Gold Master Release & Production Binaries)

### Added
- **Production Android Release Binaries**: Compiled and verified Release APKs and Google Play App Bundles (`.aab`) for both `burgonomics-foundation-core` and `burgonomics-partner`.
- **Specialized Core Benchmarks & Stress Suite**: Sub-millisecond calculation benchmarks for Customer 3-way cart (`549,692 ops/sec`) and Partner 5% Route Brand Royalty reconciliation (`713,674 ops/sec`).
- **Physical Device Smoke Validation**: End-to-end photo-verified live smoke test on connected Android device (`RZCX51TXRKB`) covering all 12 modules across both apps.
- **Team & Staff RBAC System**: 6-Tier role matrix (`brand_owner`, `regional_manager`, `branch_owner`, `branch_staff`, `support`, `developer`) with granular permissions.
- **Franchise CRM Pipeline**: 4-tab Store Network Hub with 1-tap **"🚀 Convert to Store"** workflow.
- **Real-Time Staff Chat & Kitchen Audio**: Firestore-native direct DMs, branch rooms, 1-click order/ticket reference attachments, and Web Audio QSR chime synthesizer.

---

## [2.0.0] — 2026-08-24 (Production QSR Architecture & La Pino'z Experience)

### Added
- **Firebase Functions v2**: Root `/functions` package in `asia-south1` managing Razorpay Route marketplace splits, Petpooja POS bridge, Porter logistics dispatch (historical; Porter later retired via `086b60d`), and 3-tier ticketing escalator.
- **La Pino'z QSR Mobile Experience**: 3-Way Fulfillment header (Delivery, Takeaway, Dine-In), 1-Tap Quick Add, 3-column Explore Menu grid, Floating Mini-Cart bar, and Animated Order Tracker.
- **Partner Operations POS App**: Live KOT stream, manual rider booking (dispatch panel; historical "manual Porter rider booking" wording), 3-tier ticket resolution, and Dev Diagnostics console.
- **Strict 60-30-10 Design System**: Complete design tokens in `:root` and `.dark` with WCAG 2.2 AA / AAA contrast.

### Fixed
- **Store Cards**: Clean readable cards with `bg-surface` contrast in light and dark mode.
- **Category Tabs**: Added `overflow-hidden` and `rounded-full` to eliminate pill rendering overflow.
- **Dual-Axis Momentum Scrolling**: Resolved touch delegation across horizontal rails and vertical feed.

---

## [1.0.0] — 2026-08-21 (Phase 1 Baseline)

### Added
- Firestore security rules with custom claims (`brand_owner`, `branch_manager`, `cashier`).
- Server-side pricing engine with 5% GST and tamper-proof verification.
- Capacitor mobile initialization (`com.burgonomics.app` and `com.burgonomics.partner`).
