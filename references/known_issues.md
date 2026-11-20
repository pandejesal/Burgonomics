# BURGONOMICS — Known Issues & System Roadmap (Layer 3 Reference)

> **Single source of truth for open items, deferred enhancements, and resolved bugs.**  
> Maintained across audit, security hardening, and sprint verification milestones.

---

## 🟢 Resolved Items (Reference)

> **Retired-provider note (2026-10-22; code retirement in root `086b60d`, business sign-off date not recorded here).** Porter has since been
> RETIRED as a dispatch partner (root `086b60d`): dispatch is Borzo / Shadowfax or the restaurant's
> own in-house rider via `POST /orders/manualDispatch` (`deliveryStatus: "dispatched"`,
> `dispatchType: "manual_branch_terminal"` — restaurant-driven delivery, never customer pickup).
> The Porter rows below are kept verbatim as historical resolution records — they describe work
> that was real at the time, not an active provider commitment to configure. Porter's code paths
> (quote, `bookPorterRider`, webhook HMAC, paste lane, reconciliation) remain real but cold:
> `PORTER_ENABLED="true"` must be explicitly set to re-arm full dispatch (no history-only mode).

| Issue | Resolution | Area |
|---|---|---|
| Petpooja `isVeg` boolean parsing | Removed `|| true` tautology in `petpooja.service.ts`, correctly differentiating Veg (`"1"`) vs NonVeg (`"2"`) | Integrations / Petpooja |
| Petpooja auth payload format | Aligned `save_order` to send `app_key`, `app_secret`, `access_token` in request body per POS API spec | Integrations / Petpooja |
| Petpooja webhook numeric enums | Added `normalizePetpoojaStatus` mapping numeric codes (`-1`, `1..3`, `4`, `5`, `10`) to standard statuses | Integrations / Petpooja |
| Porter address payload structure | Updated `bookPorterRider` to send structured nested address and contact details | Integrations / Porter |
| Porter webhook event names | Implemented `normalizePorterEvent` reconciling `ASSIGNED`, `IN_TRANSIT`, `DELIVERED`, `CANCELLED` | Integrations / Porter |
| Porter quote staleness TTL | Added 10-minute fee lock metadata (`validForSeconds: 600`, `expiresAt`) across backend and partner app | Integrations / Porter |
| Sequential branch menu sync timeout | Parallelized branch menu sync in `petpooja.scheduler.ts` with chunked `Promise.allSettled` | Integrations / Scalability |
| Razorpay client adapter stub | Implemented production `RazorpayAdapter` in `burgonomics-foundation-core/src/core/integrations/razorpay` | Customer App / Payments |
| Missing E2E integration test suite | Added comprehensive `e2e.flow.test.ts` covering price → Razorpay Route → Petpooja KOT → Porter delivery | Quality / Testing |
| Pricing asymmetry (client vs server) | Authoritative server `pricing.engine.ts` with 5% GST, catalog price validation & loyalty cap | Backend / Functions |
| Missing endpoint authentication | Enforced `requireAuth` Bearer token verification with `checkRevoked: true` on all routes | Security / Cloud Functions |
| Missing server-side authorization (RBAC) | Implemented `requireRole` supporting 6-tier roles (`brand_owner` to `branch_staff`) | Security / RBAC |
| User doc mass assignment | Added key-diff constraints in `firestore.rules` preventing self-assigning roles or coins | Security / Firestore |
| Catalog manipulation risk | Restricted `products` collection write permissions strictly to `isBrandOwner()` | Security / Firestore |
| Stale JWT tokens after role change | `setUserCustomClaims` invokes `auth.revokeRefreshTokens(uid)` immediately | Security / Auth |
| Overly permissive CORS | Replaced wildcard CORS with strict domain whitelist in `functions/src/index.ts` | Security / Networking |
| DPDP Act PII exposure in error logs | Customer IDs, phone numbers, and addresses masked in webhooks & error snapshots | Privacy / DPDP Act |
| Public `.env` in partner repo | Added `.env` and `.env.*` to `burgonomics-partner/.gitignore` | Security / Repo |
| Leaked production sourcemaps | Set `build.sourcemap: false` in `burgonomics-partner/vite.config.ts` | Security / Build |
| Missing security headers | Configured HSTS, CSP, X-Frame-Options DENY, and nosniff in `firebase.json` | Security / Hosting |
| Cloud Function concurrency runaway | Configured `maxInstances: 20`, `timeoutSeconds: 60`, `concurrency: 80` in v2 entrypoints | Infrastructure |
| Firestore `admin_stores` public read | Restricted write access via custom claims in `firestore.rules` | Security |
| Menu chip overflow defect | Added `overflow-hidden` + `rounded-full` to motion container in `CategoryTabs.tsx` | Customer App UI |
| Dark mode contrast drift | Enforced strict 60-30-10 tokens (`#0A0A0A` / `#0E4825` / `#4ADE80` / `#CC5200`) | Design System |
| Horizontal rail touch latch | Implemented dual-axis delegate scroll hook `useDirectionalScroll.ts` | Mobile UX |
| Monorepo documentation drift | Consolidated all docs to ICM Layers 0-4 with single root source | Repository |
| Partner POS client mock bypasses | Eliminated client-side random IDs & sample riders in `useOrder.ts` and `porterDelivery.ts` by bridging to `partnerFunctionsApi.ts` calling Cloud Functions `/petpooja/pushOrder`, `/porter/book`, `/orders/verifyDeliveryOtp`, and `/orders/manualDispatch` | Partner POS / Backend Bridge |
| Missing Partner App Unit Test Gate | Configured Vitest + JSDOM runner with 28 automated tests covering RBAC, Porter quote calculations, 3-tier SLA escalation, KDS bump state machine, 86ing inventory, and POS order stream | Partner App / Testing |
| Ineffective dynamic import warning | Converted dynamic `adminPaymentsService` import in `AdminPaymentHealthPage.tsx` to static import with proper unmount listener cleanup | Partner App / Build |
| Partner Bundle Chunk Splitting | Optimized `manualChunks` in `vite.config.ts` separating `vendor-react`, `vendor-icons`, `admin-analytics`, eliminating all bundle size warnings | Partner App / Performance |
| Backend 3-Tier SLA Escalator Suite | Added comprehensive unit tests in `ticketReminder.escalator.test.ts` & `webhooks.idempotency.test.ts` expanding backend coverage to 40 tests | Backend / Testing |
| Customer BOGO & Geofence Deliverability Suite | Added unit tests for La Pino'z BOGO 1+1 engine and branch geofencing deliverability expanding customer coverage to 81 tests | Customer App / Testing |
| Porter Non-JSON Error Body Parsing (R7) | Added `!response.ok` pre-check before parsing JSON body with graceful fallback on gateway HTTP 502/504 errors | Integrations / Porter |
| Petpooja clientOrderID Deduplication (R11) | Populated `clientOrderID` and `client_order_id` in `pushOrderToPetpooja` to ensure idempotent KOT printing across retry attempts | Integrations / Petpooja |
| Petpooja Per-Branch restId Resolution (R13) | Stored `branches/{id}.petpooja.restId` is preferentially resolved and passed to Petpooja API rather than Firestore doc ID | Integrations / Petpooja |
| Razorpay Order Creation Notes orderId (R15) | Added `orderId` to Razorpay `notes` payload in `createPaymentOrder` enabling instant server webhook correlation on `payment.captured` | Payments / Razorpay |
| Firestore Rules Payment & Pricing Tamper Guard (R19) | Hardened `orders` update rule preventing client writes to `paymentStatus`, `payment`, `refundStatus`, and `routeTransferStatus` | Security / Firestore Rules |
| Firestore Rules Branch Secret Tamper Guard (R20) | Hardened `branches` update rule restricting `razorpayAccountId`, `petpooja`, and `servicedRadiusKm` strictly to `isBrandOwner()` | Security / Firestore Rules |
| Branch Delivery Serviceability Pre-check (R8/R9) | Added `checkBranchDeliveryServiceability` and delivery radius evaluations in `functions/src/core/utils/geo.utils.ts` and test suite | Logistics / Geofencing |
| Porter Fare Quote Fail-Closed Architecture (R6) | Refactored `getDeliveryQuote` to strictly evaluate live quote responses with structured TTL metadata (`validForSeconds: 600`) | Logistics / Porter |
| Razorpay Authoritative Webhook & Route Dedup (R16) | Guarded `attemptRouteTransfer` with idempotent state verification preventing duplicate transfers on re-opened browser sessions | Payments / Razorpay |
| Auto-Refund Captured Pre-Check & Idempotency (R17/R18) | Verified captured payment pre-condition and structured caller-distinct refund idempotency keys (`refund_{orderId}_{context}`) | Payments / Razorpay |
| Hybrid RBAC Security Gate (R21) | Enforced fresh Firestore `admins/{uid}` confirmation alongside token custom claims on sensitive money & credential writes | Security / RBAC |
| Sensitive Catalog Rules Hardening (R22) | Locked `coupons` collection to server-only writes (`allow read, write: if false`) and auth-gated `petpooja_offers` | Security / Firestore Rules |

---

## 🟡 Operational Roadmap & Active Watchlist

| ID | Area | Item Description | Status / Next Step |
|---|---|---|---|
| **R1** | Logistics | ~~Live Porter API production credentials flip~~ **Porter is RETIRED (code retirement in root `086b60d`; business sign-off date not recorded here).** Re-arming is a deliberate operator decision: add `PORTER_ENABLED="true"` (this fully re-arms dispatch - new quotes, paid booking, rebooking; there is no history-only mode), then `PORTER_API_KEY` / `PORTER_CUSTOMER_ID` / `PORTER_WEBHOOK_SECRET`, and toggle `MOCK_PORTER_DISPATCH=false`. Do not arm without the business decision. |
| **R2** | POS Sync | Petpooja live branch credentials configuration (`PETPOOJA_APP_KEY`, `PETPOOJA_APP_SECRET`, `PETPOOJA_ACCESS_TOKEN`) | Set in `functions/.env` and toggle `MOCK_PETPOOJA_POS=false` |
| **R3** | Payment | Razorpay Route linked account onboarding for new franchise branches | Self-serve via Partner App / Branch settings (`branches/{id}.razorpayAccountId`) |
| **R4** | Mobile | Native App Store Connect & Google Play Console app submission | Build `.aab` (Android) and Xcode Archive `.ipa` (iOS) via [RELEASE_AND_INTEGRATION_GUIDE.md](file:///c:/Users/DELL/Desktop/Burgonomics/RELEASE_AND_INTEGRATION_GUIDE.md) |
| **R5** | Backup | Daily GCP automated Firestore backup exports in `asia-south1` | Cloud Console automated export schedule |
| **R12** | POS Sync | Ingest extended Petpooja item modifiers (`AddonItem.details[]`, `variation_id`) | Pending Petpooja Account Manager confirmation of custom add-on schema |


## Review of 31 October 2026

Added by the full review; earlier entries are left as written. Each statement below was verified on the live staging project burgonomics-7faa8 unless marked. Full record: staging-review-20261030/11-final-report.md.

**Open, needs a decision or setup**
- Online ordering works end to end only on DEMO. 16 of 17 stores have no `partnerBranchId`; createPaymentOrder now returns 409 STORE_NOT_LINKED for them.
- All 166 DEMO products are `inStock:false`, written by one mapper run on 2026-10-17 from vendor value `in_stock:"2"`. 81 also have price 0. Do not bulk-flip. Fix the vendor menu first.
- Vendor menu fetch fails: `unable to fetch Object from s3 bucket`.
- GST: the client treats menu prices as inclusive, the server adds 5%, and the POS payload says `tax_inclusive:false`. Checkout shows a price-change prompt as a result. Needs an owner and accountant decision.
- Delivery: the real charge is a flat 35. The 499 and 40 rule survives only in a cart fallback and the terms copy.
- Cash order totals are client-written. A server order endpoint is the proper fix.
- Firestore has no backups, no PITR, and no delete protection.
- App Check and Firebase Storage are not enabled. Support photo upload fails honestly.

**Changed behaviour worth knowing**
- Cash KOT is sent when staff first move an order out of PLACED, not at creation, because `payment.method` is client-written. It relies on the rule that clients cannot write `status`.
- A 200 from Petpooja with an empty order id is `accepted_unconfirmed`, not synced. It raises an operator alert and is not auto-retried, since a retry could print a duplicate KOT.
- An unauthenticated Petpooja callback can no longer apply a terminal status; it is parked.
- Rule mirrors in the customer and partner repos must stay byte-identical to the root file. `npm run test:rules` runs the customer copy.
- Any functions deploy needs `functions/.env` in the tree. Deployed env comes from that file.

### Update, night of 31 October 2026

Owner decided: menu prices are GST-inclusive, and the delivery fee comes from Borzo and Shadowfax. The GST and delivery entries above are superseded by the following.

- GST is included, never added. The included share is net food x 5/105, on client and server. Royalty is taken on the ex-GST food value; that base needs owner sign-off before Route goes live.
- The delivery fee is a live courier quote from POST /checkout/fees, stored in `delivery_fee_quotes` and bound to one order. No static fee exists. If no courier can quote, delivery is unavailable. Only Borzo is enabled until Shadowfax has credentials.
- `createPaymentOrder` prices the order document only. The branch comes from the order, and option prices come from the catalog.
- POS `total` and the tax shape now follow Petpooja's BINDING 2 Nov 2026 ruling
  (`references/petpooja_save_order_api.md` §23): the delivery/packing charges and
  any GST on them are INSIDE `total`, COD `collect_cash` equals `total`, and a
  tax-inclusive line omits `item_tax` with no food GST in the bottom `Tax` block.
  The earlier "total excludes a third-party courier fee" reading is dead, as is
  "`tax_inclusive:true` is unconfirmed" — the vendor now specifies the inclusive
  shape explicitly. The exclusive menu path (the approved sandbox runs) is
  unchanged. Still open: whether packing is order-wise or item-wise (merchant
  portal configuration, to confirm with Petpooja support after integration).
- Lines with unverified POS ids are parked, never sent with invented ids. Petpooja has rejected addon, variation, and group ids until they match the pushed menu.
- Borzo returns a fee plus a phone warning at quote time. The adapter accepts that warning for quotes only. Booking needs a real store phone, and 9 of 17 stores, including DEMO, do not have one.
- Windows Storage Sense on the dev machine deletes from Temp under low disk. Do not work from Temp.

### Update, audit remediation deployed to staging, 19 November 2026

Seven audit findings were fixed, validated and deployed to staging `burgonomics-7faa8`
(production untouched). Each entry replaces the behaviour described above where it
overlaps.

- **F06 staff suspension (live)**: `users/{uid}.active` is now an authorization input.
  A missing field means not-active, so staff without the field lose staff access. Rules
  (`staffActive()` as the last conjunct of both `hasRole` arms, plus the Storage
  `privilegedAndActive()` gate), the server `requireRole` gate and `POST /auth/suspendStaff`
  all enforce it; `active`/`suspendedAt`/`suspendedBy` are no longer client-writable.
  Staging was provisioned before enforcement: 4 staff profiles missing `active` were set
  `true` by the deploy driver, which writes only where the field is absent. The `admins`
  registry UIDs with a non-staff claim role (`0ziP…`, `4Kfv…`, `kY2B…`, `tmgV…`) stay
  unprovisioned by design — they were recorded as skips, not errors. Any future staff
  profile created outside `staffInvite` must set `active: true` explicitly.
- **F24 customer cancellation (live)**: cancellation is server-owned via
  `POST /orders/customerCancel`, allowed only up to `PREPARING` and only before a rider is
  assigned; direct client cancellation is denied by rules in every mirror.
- **F08 uncertain dispatch create (live)**: a book whose outcome is uncertain parks as
  `PROVIDER_BOOK_AMBIGUOUS` instead of failing over, so one order can no longer produce two
  paid courier bookings. Only proven pre-send codes (`ENOTFOUND`/`EAI_AGAIN`/`ECONNREFUSED`)
  and 4xx rejections fail over.
- **F17 private-key resend (live)**: a brand owner re-sending an unchanged legacy private
  key into the world-readable `admin_stores` document is now denied; the shape test requires
  the private key set to be affected before it can pass.
- **F23 refund-gateway 409 (live)**: a gateway HTTP 409 on refunds is treated as
  reconciliation-required uncertainty, not a rejection.
- **F04 kitchen admission (live)**: kitchen admission requires the server capture marker,
  not merely `method === 'online'`.
- **F10 dependency-setup test**: the diagnostic run is 19/19 inside the unchanged 5000 ms
  timeout (case 9 at 46 ms vs 2,419 ms); no timeout was raised.
- **App Check remains OFF** (`APP_CHECK_ENFORCEMENT=false`): the new routes follow that;
  `POST /orders/customerCancel` is deliberately outside the App Check allowlist. Route
  enrolment is a follow-up before enforcement is switched on.
- **Rollback**: pre-deploy state is recorded in
  `staging-deploy-r3/execute-r3-P0-20261118T233304305Z/ROLLBACK.json` (rulesets
  `5e09da7e…` Firestore / `b3e55f69…` Storage, hosting `8cefd8b74d254b40` Customer /
  `5025176a15ba88f1` Partner, 18 functions). Redeploy the previous source and re-release
  those version names; no data restore is needed.

### Update, Petpooja callback replies matched to the docs, 20 November 2026

Closed from the 2026-11-20 sandbox run (`Burgonomics-comms/petpooja-sandbox-20261120/RESULTS.md`):

- **Item On/Off `itemID` arrays**: a multi-id callback used to fail the doc-id guard and
  drop every id. Arrays (and a single scalar) are now normalised and applied per id,
  idempotently, with one aggregate outcome. Multi-id payloads are no longer silently lost.
- **Stock webhook reply**: `{"status":"success"}` → the documented
  `{"code":200,"status":"success","message":"Stock status updated successfully"}`; the
  failure body is the documented `{"code":400,"status":"failed",…}`. A redelivery keeps
  its fail-closed 503.
- **Get Store Status** now answers the documented body with `store_status` derived from
  the branch's real state (`"1"` open, `"0"` closed) instead of a bare `{"status":"success"}`.
- **Update Store Status** applies the documented 0/1 encoding to
  `branches/{id}.acceptingOrdersStatus` and answers the documented body. The legacy
  `{restID, status}` ping is still recorded, never applied, and an uncredentialed
  (shape-admitted) update is recorded and refused.
- **Menu push reply** is the documented `{"success":"1","message":"Menu items are
  successfully listed."}`. Menu processing is unchanged; a refused unlinked outlet keeps
  its diagnostic body.

Not closed, and not ours: Rider Information (`rider_status_update`) still returns the
vendor's SQS passthrough instead of the documented 200 body — that is Petpooja's own
outbound response, awaiting a vendor answer.

### Update, Petpooja callback follow-ups (r2), 20 November 2026

Four gaps the r1 reply fix left open, found in review because they break in real life:

- **Get Store Status was unreachable without a credential.** The documented request is a
  bare `{"restID"}`; the shape allowance required a status key, so genuine vendor calls
  401'd. **Closed**: `verifyPetpoojaAuth` now also admits exactly that shape on
  `/petpooja/webhook` (`looksLikePetpoojaStoreStatusRead` — no status key, no order
  reference), the read path is read-only, and `trusted` is now the real auth verdict
  instead of a hardcoded `true`. The sibling write routes (`/petpooja/stockWebhook`,
  `/petpooja/menu-sync`) still 401 a credential-less body; every write path stays
  credential-only. Safe because open/closed is already world-readable (`stores/*` public
  read; the customer app renders the same flag).
- **Update Store Status did not stop ordering.** It wrote only
  `branches/{id}.acceptingOrdersStatus`, which no ordering path reads; the live gate is
  `stores/{id}.isOpen` (PaymentRepository `closed_store`; cart/checkout disabled states).
  **Closed**: the update now writes that gate (plus the branch flag and a mirror into an
  existing `admin_stores` doc), is idempotent, and refuses an unlinked or ambiguous
  storefront with the documented failure body and no partial write — answering "success"
  while customers keep ordering was the bug.
  - **Rule in force (A)**: while an outlet is linked to Petpooja the POS owns open/closed;
    a POS "closed" stops ordering immediately and only a POS "open" restarts it.
  - **Target rule (C, not implemented)**: an explicit staff "closed" in the Partner app
    should win until staff reopen. Needs the Partner toggle to write the gate plus an
    override field.
  - **Known gap, deferred to the Partner app fix wave**: the Partner toggle
    (`AdminStoresPage.handleConfirmToggleStoreState` → `adminStoresService.bulkUpsert`)
    writes only `admin_stores` and never `stores/{id}.isOpen`, so an operator "closed"
    does not gate ordering where the directory is served from `stores`, and a later
    operator save can overwrite the mirrored copy. Both apps are gitignored here, so that
    fix is not in this branch.
- **Item On/Off answered success after truncating at the 200-id cap.** A 250-id batch
  applied 200 and replied success — 50 toggles silently lost. **Closed**: an over-cap
  batch is now refused wholesale (reason names the real total, nothing applied), a
  permanent partial is `outcome: "partial"` (never `applied`) with `n/m applied`, and
  `pos_webhook_audits` records `partial` with an explicit `partial: "n/m"` field.
- **Low items.** `storeStatusFailure` now carries the right `kind` (GET failures were
  labelled `update`), and `turn_on_time` is capped at 64 chars before it is persisted.
  The audit `itemId` is a capped summary instead of the raw unbounded `itemID` array.
