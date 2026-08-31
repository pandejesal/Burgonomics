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

---

## 🟡 Operational Roadmap & Active Watchlist

| ID | Area | Item Description | Status / Next Step |
|---|---|---|---|
| **R1** | Logistics | Live Porter API production credentials flip | In Sandbox / Awaiting live key activation |
| **R2** | POS Sync | Petpooja live branch credentials configuration | In Sandbox / Mocks active for smoke testing |
| **R3** | Payment | Razorpay Route linked account onboarding for new franchise branches | Self-serve via Partner App / Branch settings |
| **R4** | Mobile | Native iOS App Store packaging and provisioning profile setup | Post-Android release milestone |
| **R5** | Backup | Daily GCP automated Firestore backup exports in `asia-south1` | Cloud Console schedule activation |
| **R6** | Logistics | `getDeliveryQuote` silently falls back to static rate card on any live quote failure (`porter.service.ts:85-91`) — violates D1; must fail closed and distinguish 4xx (not_serviced) vs 5xx (transient) per D2 | Open — refactor quote with status-aware error mapping |
| **R7** | Logistics | `bookPorterRider` calls `response.json()` before checking `response.ok` (`porter.service.ts:220-222`) — a non-JSON error body throws a misleading error and loses the real Porter rejection | Open — parse body after status check |
| **R8** | Logistics | No serviceability pre-check exists in the stack: `FulfillmentSelector.tsx` gates delivery only on static `store.supports.delivery`; `DeliveryPanel.tsx` shows "Calculating..." fee with no coverage state | Open — add radius gate + not_serviced/transient UI per D3/D2 |
| **R9** | Logistics | No `servicedRadius`/`deliveryRadius` field on the branch/Store model (no radius concept in `geo.utils.ts`); Porter coverage is intra-city + city-scoped, so a per-branch radius source of truth is missing | Open — add radius to branch model + Firestore |
| **R10** | POS Sync | `pushOrderToPetpooja` sends a FLAT payload (order_id/customer_name/items/tax_details at top level) incompatible with the documented V2.1.0 `/save_order` nested `orderinfo.{OrderInfo.{Restaurant,Customer,Order,OrderItem,Tax,Discount}}` contract (P1) | Open — refactor to nested `orderinfo` shape |
| **R11** | POS Sync | Order push sends NO `clientOrderID`, so Petpooja cannot dedupe; retry worker (`petpoojaRetryCount<=3`) can DOUBLE-PRINT a KOT on a lost-response success (P5) | Open — populate `clientOrderID` with order id; reuse exact same value across retries |
| **R12** | POS Sync | `pushOrderToPetpooja` sends no variation/addon (`AddonItem.details[]`, `variation_id`) — KOT prints base item at base price, underpricing add-on burgers (P2) | Deferred — confirm `AddonItem` contract with Petpooja support first |
| **R13** | POS Sync | Menu sync + order push pass the branch Firestore DOC ID as `rest_id`, ignoring `branches/{id}.petpooja.restId`; cross-restaurant mis-target if they differ (P3) | Open — use stored `petpooja.restId` |
| **R14** | POS Sync | `verifyPetpoojaAuth` validates against ONE global `config.petpooja.*` set and products are written to a SHARED `products/prod_{itemid}` path — a branch's stock event can flip/overwrite another branch's item (P4) | Open — per-branch cred resolution + namespace `products/branches/{branchId}/items/{itemid}` |
| **R15** | Payment | `createPaymentOrder` never puts our `orderId` in the Razorpay order `notes` (`razorpay.service.ts:64-70`), so the webhook (`razorpay.webhook.ts:48`) reads `notes.orderId` as `undefined` and `payment.captured` handler silently no-ops — the reliable server-side confirmation is dead; only the client-chokeable `verifyPayment` works (RZ1) | Open — add `orderId` to `notes` |
| **R16** | Payment | Webhook (`payment.captured`) and client `verifyPayment` are two live confirmation channels with NO shared dedup: `attemptRouteTransfer` has no "already transferred" guard and both set `status: accepted` — browser-killed session + re-open can double-fire the Route transfer (real money) and/or double-push KOT (RZ2) | Open — webhook authoritative; `verifyPayment` idempotent shim; shared processed/transfer marker |
| **R17** | Payment | `autoRefund` (`razorpay.service.ts:423`) issues refunds with NO state pre-check (only `captured` payments are refundable) and NO `X-Refund-Idempotency` header — a lost-response retry double-refunds; per docs refund idempotency exists via that header (RZ3) | Open — captured-state check + idempotency header + brand-royalty/main-account share tracking |
| **R18** | Payment | `autoRefund` is invoked from two callers (`tickets.service.ts:186` support ticket, `petpooja.service.ts:386` post-checkout rejection) with distinct refund contexts — the idempotency key must be caller-distinct so a ticket refund and an item-rejection refund can't collide (RZ3) | Open — stable per-context idempotency keys (`refund_{orderId}_{ticket|lineItem}`) |
| **R19** | Security (Rules) | Orders update rule (`firestore.rules:113-117`) lets `branch_owner`/`branch_staff` who `ownsBranch` write ANY key except totals/pricing — incl. `paymentStatus`/`status`/`payment.*`/`refundStatus` — so a staffer can flip an order to paid/completed with NO real Razorpay capture, bypassing the authoritative webhook (F-PAY, composes RZ2) | Open — extend affected-key guard; payment/split keys server-only |
| **R20** | Security (Rules) | Branches update rule (`firestore.rules:129`) lets `branch_owner`/`branch_staff` edit `razorpayAccountId` (the Route payout linked account), `petpooja.restId`/`appKey`/`accessToken`, and `servicedRadiusKm` — a compromised branch owner can repoint the Route payout or leak/rotate POS creds (F-PAY, composes P3/P4) | Open — restrict these keys to `isBrandOwner()` only |
| **R21** | Security (Rules) | Mixed client + custom-claims role resolution: `isBrandOwner()`/`isBranchOwner()` accept the stale (~1h) `request.auth.token.role` even when the `admins/{uid}` doc no longer grants it — revoked staffer keeps admin writes up to 1h (F-RBAC; `revokeRefreshTokens`+`checkRevoked` narrow but don't eliminate) | Open — hybrid: fresh `admins/{uid}` confirmation on sensitive writes (payments/refunds/creds/branch edits) |
| **R22** | Security (Rules) | `coupons` is PUBLIC READ (`firestore.rules:358`) though no client reads it (server validates via `pricing.engine.ts:141`) — code/discount enumeration; `petpooja_offers` also public (`firestore.rules:179`) and carries `code`+`discount` (F-COUPON) | Open — `coupons` server-only (`allow read/write if false`); `petpooja_offers` auth-gated (`isAuthenticated()`). Plus lock/delete vestigial `device_tokens` block (F-TOKEN; dead collection) and document `users/{uid}/tokens/{deviceId}` model |
