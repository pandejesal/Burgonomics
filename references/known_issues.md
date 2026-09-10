# BURGONOMICS — Known Issues & System Roadmap (Layer 3 Reference)

> **Single source of truth for open items, deferred enhancements, and resolved bugs.**  
> Maintained across audit, security hardening, and sprint verification milestones.

---

## 🟢 Resolved Items (Reference)

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
| **R1** | Logistics | Live Porter API production credentials flip (`PORTER_API_KEY`, `PORTER_CUSTOMER_ID`, `PORTER_WEBHOOK_SECRET`) | Set in `functions/.env` and toggle `MOCK_PORTER_DISPATCH=false` |
| **R2** | POS Sync | Petpooja live branch credentials configuration (`PETPOOJA_APP_KEY`, `PETPOOJA_APP_SECRET`, `PETPOOJA_ACCESS_TOKEN`) | Set in `functions/.env` and toggle `MOCK_PETPOOJA_POS=false` |
| **R3** | Payment | Razorpay Route linked account onboarding for new franchise branches | Self-serve via Partner App / Branch settings (`branches/{id}.razorpayAccountId`) |
| **R4** | Mobile | Native App Store Connect & Google Play Console app submission | Build `.aab` (Android) and Xcode Archive `.ipa` (iOS) via [RELEASE_AND_INTEGRATION_GUIDE.md](file:///c:/Users/DELL/Desktop/Burgonomics/RELEASE_AND_INTEGRATION_GUIDE.md) |
| **R5** | Backup | Daily GCP automated Firestore backup exports in `asia-south1` | Cloud Console automated export schedule |
| **R12** | POS Sync | Ingest extended Petpooja item modifiers (`AddonItem.details[]`, `variation_id`) | Pending Petpooja Account Manager confirmation of custom add-on schema |

