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
