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
