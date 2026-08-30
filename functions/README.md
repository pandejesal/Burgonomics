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

## 3. 🔌 Core Cloud Function Modules

### 1. Payments (`modules/payments`)
- `createRazorpayOrder`: Server-computed pricing engine (MRP lookup from Firestore `products`, 5% GST, ₹15 packaging, delivery fee, coupons, loyalty points capped at 20%).
- `verifyRazorpayPayment`: Timing-safe HMAC verification and automated **Razorpay Route** marketplace split (Brand Royalty % retained; net branch revenue transferred).
- `razorpayWebhook`: Idempotent payment capture and dispute webhook handler.
- `autoRefund`: Full or partial refund execution with proportional Route split reversals (protected by `requireRole(["brand_owner", "developer", "support"])`).

### 2. Petpooja POS Bridge (`modules/petpooja`)
- `syncPetpoojaMenu`: Scheduled hourly menu sync (Cloud Scheduler) + on-demand sync.
- `pushOrderToPetpooja`: Pushes confirmed orders to kitchen KOT with exponential retry worker (1m, 5m, 30m).
- `petpoojaStockWebhook`: Instant 86ing webhook to mark out-of-stock items in real-time.
- `petpoojaWebhook`: Real-time kitchen state transitions (`accepted`, `food_ready`, `cancelled`).

### 3. Porter Delivery Logistics (`modules/porter`)
- `getDeliveryQuote`: Computes live 2-Wheeler courier fare based on outlet-to-customer GPS distance.
- `bookPorterRider`: Called by Partner POS when food is `food_ready` to dispatch a driver.
- `porterWebhook`: Verifies signature and tracks driver allocation, pickup, and delivery milestones.

### 4. Support Ticketing & Escalator (`modules/tickets`)
- `createTicket`: Customer app issue submission linked to `orders/{orderId}`.
- `resolveTicket`: Partner app resolution with instant full/partial refunds or coupons.
- `escalateTicket`: 3-tier escalator (Branch Manager → Brand Owner / Support → Developer Team).
- `reminderCron`: Scheduled 60-minute worker notifying branch managers of unattended tickets.

### 5. Push Notifications (`modules/notifications`)
- `dispatchFCM`: Native APNS / FCM push dispatch across topics (`order_{id}`, `branch_{id}`, `brand`, `support_ticket_{id}`).

---

## 4. 🔐 Environment & Secret Configuration

Secret keys are managed via **Google Secret Manager** (`defineSecret`):

```bash
# Firebase Cloud Functions (asia-south1)
FIREBASE_PROJECT_ID=burgonomics-prod
FIREBASE_REGION=asia-south1

# Gateway Secrets
RAZORPAY_KEY_ID=rzp_live_xxxxxxxx
RAZORPAY_KEY_SECRET=xxxxxxxxxxxxxxxxxxxxxxxx
RAZORPAY_WEBHOOK_SECRET=whsec_xxxxxxxxxxxx
PETPOOJA_APP_KEY=xxxxxxxx
PETPOOJA_APP_SECRET=xxxxxxxx
PETPOOJA_ACCESS_TOKEN=xxxxxxxx
PORTER_API_KEY=prt_live_xxxxxxxx
PORTER_WEBHOOK_SECRET=prt_whsec_xxxxxxxx
```

---

## 5. 🛠️ Development & Deployment

### Local Emulation & Testing
```bash
# 1. Install dependencies
cd functions && npm install

# 2. Type check
npx tsc --noEmit

# 3. Run test suite
npm test

# 4. Build TypeScript bundle
npm run build

# 5. Start Firebase Emulators
npm run serve
# or: firebase emulators:start --only functions,firestore
```

### Production Deployment
```bash
# Deploy all functions to asia-south1
firebase deploy --only functions
```
