# BURGONOMICS — 100% Pure Veg Gourmet Burgers QSR Ecosystem

> **Authoritative Monorepo for Burgonomics QSR: Customer Ordering Mobile App, Partner Operations POS, and Firebase Cloud Functions v2 Backend Engine.**  
> Built under the **Interpretable Context Methodology (ICM)**.  
> **Backend Region**: `asia-south1` (Mumbai) | **Firebase Project**: `burgonomics-7faa8`

---

## 📱 Ecosystem Architecture

Burgonomics is architected as two dedicated applications backed by a single authoritative cloud engine:

```
                               ┌──────────────────────────────────────────────┐
                               │             BURGONOMICS ECOSYSTEM            │
                               └──────────────────────┬───────────────────────┘
                                                      │
                     ┌────────────────────────────────┴────────────────────────────────┐
                     ▼                                                                 ▼
      ┌─────────────────────────────┐                                   ┌─────────────────────────────┐
      │  CUSTOMER ORDERING APP      │                                   │    PARTNER POS & OPS APP    │
      │ `burgonomics-foundation-`   │                                   │    `burgonomics-partner/`   │
      │ `core/`                     │                                   │                             │
      │ ─────────────────────────── │                                   │ ─────────────────────────── │
      │ • 3-Way Fulfillment:        │                                   │ • Live KDS Kitchen Orders   │
      │   Delivery, Takeaway, DineIn│                                   │ • Loud Audio Alarm          │
      │ • 1-Tap Quick Add & MiniCart│                                   │ • 1-Tap Petpooja KOT Push   │
      │ • Razorpay / UPI / Cards    │                                   │ • Porter Courier Dispatch   │
      │ • Grill Coins Loyalty       │                                   │ • 3-Tier Support Tickets    │
      │ • Live Order Tracking       │                                   │ • Route Royalty Analytics   │
      └──────────────┬──────────────┘                                   └──────────────┬──────────────┘
                     │                                                                 │
                     └────────────────────────────────┬────────────────────────────────┘
                                                      │
                                                      ▼
                                       ┌─────────────────────────────┐
                                       │   FIREBASE CLOUD FUNCTIONS  │
                                       │   v2 ENGINE (`functions/`)  │
                                       │ ─────────────────────────── │
                                       │ • Server Pricing & 5% GST   │
                                       │ • Razorpay Route Splits     │
                                       │ • Petpooja POS Menu/86ing   │
                                       │ • Porter 3PL GPS Dispatch   │
                                       │ • 3-Tier Auto-Escalator     │
                                       │ • FCM Topic Push Alerts     │
                                       └──────────────┬──────────────┘
                                                      │
                                                      ▼
                                       ┌─────────────────────────────┐
                                       │     FIRESTORE DATABASE      │
                                       │        `asia-south1`        │
                                       │ ─────────────────────────── │
                                       │ • Single Source of Truth    │
                                       │ • 6-Tier RBAC Claims        │
                                       │ • DPDP Act 2023 Compliant   │
                                       └─────────────────────────────┘
```

---

## 📚 Master Documentation & Operational Guides

| Document | Description | Link |
|---|---|---|
| **Client Handover & API Keys** | Master 4-day handover timeline, copy-paste `.env` templates, and vendor webhook registration URLs. | [CLIENT_HANDOVER_AND_KEYS.md](file:///c:/Users/DELL/Desktop/Burgonomics/CLIENT_HANDOVER_AND_KEYS.md) |
| **Store Submission Guide** | Apple App Store & Google Play metadata, reviewer test credentials, and Xcode/Gradle build instructions. | [STORE_SUBMISSION_GUIDE.md](file:///c:/Users/DELL/Desktop/Burgonomics/STORE_SUBMISSION_GUIDE.md) |
| **Next Steps & Deployment** | Step-by-step Firebase deployment prompt, hosting targets, and post-deploy smoke commands. | [NEXT_STEPS_PROMPT.md](file:///c:/Users/DELL/Desktop/Burgonomics/NEXT_STEPS_PROMPT.md) |
| **ICM Task Router (Layer 1)** | Workspace stage matrix and Layer 3 specifications index. | [CONTEXT.md](file:///c:/Users/DELL/Desktop/Burgonomics/CONTEXT.md) |
| **Global Agent Rules (Layer 0)** | Strict 60-30-10 design system tokens and workspace protocols. | [GEMINI.md](file:///c:/Users/DELL/Desktop/Burgonomics/GEMINI.md) |
| **Changelog & Release Notes** | SemVer release history from v1.0.0 to v2.5.3 (RC1). | [references/changelog.md](file:///c:/Users/DELL/Desktop/Burgonomics/references/changelog.md) |
| **Active Roadmap & Issues** | Resolved defects and active operational watchlist. | [references/known_issues.md](file:///c:/Users/DELL/Desktop/Burgonomics/references/known_issues.md) |

---

## 🧪 Verification & Health Matrix

| Subsystem | Directory | Typecheck | Test Suite Status | Build Status |
|---|---|---|---|---|
| **Backend Functions** | `functions/` | ✅ `tsc --noEmit` (0 errors) | ✅ **27 tests passed** (Porter, Petpooja, E2E flow, Pricing, Tickets, Razorpay) | ✅ `dist/index.js` |
| **Customer App** | `burgonomics-foundation-core/` | ✅ `tsc --noEmit` (0 errors) | ✅ **74 tests passed** (Pricing, Cart 3-way, Parity, Porter, Reconcile, 611k ops/sec stress benchmark) | ✅ `dist/mobile/` |
| **Partner POS App** | `burgonomics-partner/` | ✅ `tsc --noEmit` (0 errors) | ✅ All components & benchmarks verified | ✅ `dist/` |

---

## ⚡ Quick Start & Development

### 1. Install Dependencies
```bash
# Backend Functions
cd functions && npm install

# Customer App
cd ../burgonomics-foundation-core && npm install

# Partner POS App
cd ../burgonomics-partner && npm install
```

### 2. Run Local Development Servers
```bash
# Terminal 1: Customer App (Port 5173)
cd burgonomics-foundation-core && npm run dev

# Terminal 2: Partner POS App (Port 5174)
cd burgonomics-partner && npm run dev

# Terminal 3: Firebase Functions Local Shell / Emulators
cd functions && npm run serve
```

### 3. Run Test Suites
```bash
# Run all backend unit tests
cd functions && npm test

# Run all customer app tests
cd ../burgonomics-foundation-core && npm test
```

### 4. Deploy to Firebase (`burgonomics-7faa8`)
```bash
# Deploy Firestore security rules and indexes
npx firebase-tools deploy --only firestore --project burgonomics-7faa8

# Deploy Cloud Functions v2 in asia-south1
cd functions && npm run build
npx firebase-tools deploy --only functions --project burgonomics-7faa8

# Deploy Web Hosting for both apps
cd ..
npx firebase-tools deploy --only hosting --project burgonomics-7faa8
```

---

## 🛡️ Store Reviewer Demo Credentials

- **Customer App**: Phone `+91 99999 99999` | Fixed OTP: `123456`
- **Partner App**: Email `reviewer@burgonomics.com` | Password: `Burgonomics@2026`
