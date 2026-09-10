# Burgonomics — Backend Cloud Functions v2

> **Firebase Cloud Functions v2 (TypeScript) in region `asia-south1` (Mumbai)**  
> Authoritative backend service handling payments, marketplace splits, POS syncing, logistics dispatch, ticketing escalator, push notifications, and RBAC enforcement.

---

## 1. ⚡ Architecture Overview

The backend is organized in `/functions` as a single TypeScript package executing on **Firebase Cloud Functions v2** (Google Cloud 2nd Gen infrastructure).

```
functions/
├── src/
│   ├── config/                 # Firebase Admin SDK & Secret Manager definitions
│   ├── core/                   # Auth & RBAC middleware, pricing engine, Zod validators, error logger
│   │   ├── middleware.ts       # requireAuth, requireRole, verifyPetpoojaAuth
│   │   ├── firebase.ts         # Firebase Admin & Firestore references
│   │   └── errors.ts           # DPDP PII-masked dev error snapshot & webhook dispatch
│   ├── modules/
│   │   ├── auth/               # setUserCustomClaims & token revocation
│   │   ├── payments/           # Razorpay Route split, HMAC verification & refunds
│   │   ├── petpooja/           # Menu ingestion, KOT order push & 86ing stock webhook
│   │   ├── porter/             # Delivery quotes, rider booking & tracking webhooks
│   │   ├── tickets/            # 3-tier escalation, auto-refunds & 60-min reminder cron
│   │   └── notifications/      # FCM topic dispatch & loud POS audio triggers
│   └── index.ts                # Cloud Functions v2 endpoint exports & CORS whitelist
├── tsconfig.json
└── package.json
```

---

## 2. 🛡️ Security & Middleware Pipeline (`core/middleware.ts`)

1. **Bearer Token Authentication (`requireAuth`)**:
   - Validates incoming `Authorization: Bearer <ID_TOKEN>`.
   - Enforces `auth.verifyIdToken(token, true)` with `checkRevoked: true` to prevent usage of revoked tokens.
2. **Role-Based Access Control (`requireRole`)**:
   - Enforces 6-tier custom claims roles: `brand_owner`, `developer`, `support`, `regional_manager`, `branch_owner`, `branch_staff`.
   - Verifies claims from token or validates against the Firestore `admins` collection.
3. **Webhook Verification (`verifyPetpoojaAuth`)**:
   - Authenticates Petpooja POS webhook tokens and headers before ingesting orders or stock updates.
4. **Token Invalidation on Role Changes**:
   - `setUserCustomClaims` automatically executes `auth.revokeRefreshTokens(uid)` upon role assignment.
5. **Strict CORS Whitelist**:
   - Replaced wildcard CORS with strict origin validation (`burgonomics.com`, `partner.burgonomics.com`, `burgonomics.netlify.app`, `capacitor://localhost`, localhost dev).
6. **DPDP Act 2023 PII Masking**:
   - Automated masking for customer phone numbers and IDs in error alerts.

---

## 3. 🔌 HTTP Route Table (Express `api`, `asia-south1`)

Implementation-module names are NOT routes — curl these paths (all POST except `/health`):

| Route | Auth | Purpose |
|---|---|---|
| `GET /health` | public | `{status:"healthy", timestamp, service}` — assert `.status`, not the exact body |
| `/payments/createPaymentOrder` | optional + schema | server-priced order (MRP from `products`, 5% GST, packaging, coupons, loyalty ≤20%), idempotent retries |
| `/payments/verifyPayment` | optional + schema | HMAC verify + Razorpay Route split (no double-transfer on retry) |
| `/payments/refund` | staff | full/partial refund with Route reversal |
| `/payments/webhook` | Razorpay HMAC | capture/fail/transfer/refund events; claim-first idempotency |
| `/petpooja/syncMenu` | staff | on-demand branch menu sync |
| `/petpooja/pushOrder` | staff | push one KOT now |
| `/petpooja/pushStock` | staff | single-item 86-ing push |
| `/petpooja/stockWebhook` | Petpooja token | POS → us stock updates |
| `/petpooja/webhook` | Petpooja token | KOT status callbacks |
| `/porter/quote` | optional + schema | fare quote (`isEstimate:true` when GPS defaulted — re-quote before charging) |
| `/porter/book`, `/porter/rebook` | staff + branch scope | dispatch / re-dispatch (caller must hold the order's branch) |
| `/porter/webhook` | Porter HMAC | rider lifecycle; cancellation flips canonical `RIDER_CANCELLED` + pages the branch |
| `/orders/verifyDeliveryOtp` | staff + branch scope | 4-digit handover OTP (3 attempts, 15-min lockout) |
| `/orders/manualDispatch` | staff + branch scope | in-house rider fallback |
| `/tickets/create`, `/tickets/message` | auth | customer tickets + replies |
| `/tickets/resolve`, `/tickets/escalate` | staff | resolve (refund actions fail LOUD without a captured payment) / escalate |
| `/notifications/dispatch` | brand roles | FCM dispatch |
| `/notifications/subscribe` | auth + ownership-checked | device → branch topic subscription |
| `/customers/adjustCoins` | staff + branch scope | Grill-Coins compensation with ledger row |
| `/auth/setClaims`, `/auth/assignRole`, `/auth/revokeRole` | brand | RBAC (revocation deletes the `admins/` fallback doc) |
| `/auth/migrateGuest` | auth | guest→permanent migration (anonymous-source proof required) |
| `/auth/verifyBonusEligibility` | auth | welcome-bonus check (advisory; grant is atomic) |

Schedulers: hourly menu sync, 5-min KOT retry + Route-transfer retry + Porter poll, 15-min ticket reminders, daily guest-cart purge. Auth user-deletion cleanup trigger included.

---

## 4. 🔐 Environment & Secret Configuration

Server keys come from the **`functions/.env` dotenv file** (NOT `firebase functions:config`,
NOT Secret Manager bindings — the code reads plain `process.env`; anything else never
reaches runtime and production silently runs mocked). Copy `.env.example`, fill, redeploy:

```bash
# Firebase Cloud Functions (asia-south1, project burgonomics-7faa8)
FIREBASE_PROJECT_ID=burgonomics-7faa8
FIREBASE_REGION=asia-south1

# Gateway Secrets
RAZORPAY_KEY_ID=rzp_live_xxxxxxxx
RAZORPAY_KEY_SECRET=xxxxxxxxxxxxxxxxxxxxxxxx
RAZORPAY_WEBHOOK_SECRET=whsec_xxxxxxxxxxxx
OTP_HMAC_SECRET=<openssl rand -hex 32>   # set BEFORE first deploy; rotating the webhook secret without it kills in-flight OTPs
PETPOOJA_APP_KEY=xxxxxxxx
PETPOOJA_APP_SECRET=xxxxxxxx
PETPOOJA_ACCESS_TOKEN=xxxxxxxx
PORTER_API_KEY=prt_live_xxxxxxxx
PORTER_CUSTOMER_ID=cust_xxxxxxxx
PORTER_WEBHOOK_SECRET=prt_whsec_xxxxxxxx
```

Production boot **refuses** mock/missing Razorpay, Porter, and Petpooja keys (`assertProductionKeys`).

---

## 5. 🛠️ Development & Deployment

### Local Emulation & Testing
```bash
# 1. Install dependencies
cd functions && npm install

# 2. Type check (0 errors)
npx tsc --noEmit

# 3. Run test suite (230 tests passing across 23 test suites)
npm test

# 4. Build TypeScript bundle (output: dist/index.js)
npm run build

# 5. Start Firebase Emulators
npm run serve
# or: firebase emulators:start --only functions,firestore
```

### Test Suite Verification Matrix
- `tests/auth.claims.test.ts` (15 tests)
- `tests/auth.guestMigration.test.ts` (17 tests)
- `tests/batch4.bridge.test.ts` (4 tests)
- `tests/customerCoins.test.ts` (5 tests)
- `tests/e2e.flow.test.ts` (5 tests)
- `tests/env.failclosed.test.ts` (6 tests)
- `tests/fcm.notifications.test.ts` (5 tests)
- `tests/notifications.test.ts` (9 tests)
- `tests/orderBackfill.test.ts` (7 tests)
- `tests/paymentSignature.test.ts` (2 tests)
- `tests/payments.route-splits.test.ts` (10 tests)
- `tests/petpooja.service.test.ts` (12 tests)
- `tests/porter.service.test.ts` (22 tests)
- `tests/pricing.engine.test.ts` (11 tests)
- `tests/pricing.parity.test.ts` (24 tests)
- `tests/razorpay.service.test.ts` (17 tests)
- `tests/routeValidation.test.ts` (3 tests)
- `tests/ticketReminder.escalator.test.ts` (10 tests)
- `tests/tickets.notify.test.ts` (22 tests)
- `tests/tickets.service.test.ts` (13 tests)
- `tests/webhook.reject.test.ts` (3 tests)
- `tests/webhook.replay.test.ts` (4 tests)
- `tests/webhooks.idempotency.test.ts` (4 tests)

**Total**: **230 Tests Passing** | **100% Green**

### Production Deployment
See [`RELEASE_AND_INTEGRATION_GUIDE.md`](file:///c:/Users/DELL/Desktop/Burgonomics/RELEASE_AND_INTEGRATION_GUIDE.md) for full deployment instructions:
```bash
# Deploy all functions to asia-south1
npx firebase-tools deploy --only functions --project burgonomics-7faa8
```

