# BURGONOMICS — Master Deployment & Next Steps Prompt

> **Single Source of Truth for Immediate Session Resumption & Production Deployment**  
> **Project**: Burgonomics — 100% Pure Veg Fast Casual QSR Ecosystem  
> **Methodology**: Interpretable Context Methodology (ICM) — Layers 0 to 4  
> **Architecture**: Two-App Monorepo + Firebase Cloud Functions v2 (`asia-south1`) + Single Firestore Backend  
> **Timestamp**: 2026-08-29 | Version: 2.5.3 (Release Candidate 1)

---

## 📋 Copy-Paste Prompt for the Next Session

```markdown
You are Antigravity, the lead software engineering agent for Burgonomics.
Please read CLIENT_HANDOVER_AND_KEYS.md, NEXT_STEPS_PROMPT.md, CONTEXT.md, and GEMINI.md to resume our work immediately.

Current Objective:
Execute the 4-day production handover deployment for Firebase project `burgonomics-7faa8`:
1. Build and verify all 3 packages (`functions`, `burgonomics-foundation-core`, `burgonomics-partner`).
2. Deploy Firestore rules and indexes (`firebase deploy --only firestore`).
3. Deploy Cloud Functions v2 in `asia-south1` (`firebase deploy --only functions`).
4. Apply hosting targets and deploy both Customer App and Partner POS sites (`firebase deploy --only hosting`).
5. Run smoke validation tests on the deployed endpoints and URLs.
6. Compile release Android APK/AAB and prepare iOS TestFlight archive.

All tests are currently passing (27 backend tests, 74 customer tests), partner mock stubs are eliminated via partnerFunctionsApi, and builds compile with zero errors. Proceed step-by-step and report status after each phase.
```

---

## 1. System Topology & Architecture

| Component | Directory | Stack & Responsibilities | Port / Output |
|---|---|---|---|
| **Customer App** | `burgonomics-foundation-core/` | React 18, Vite, TanStack Router, Tailwind CSS (60-30-10 tokens), Capacitor Mobile. 3-way fulfillment (Delivery, Takeaway, Dine-In), 1-tap quick add, floating mini-cart. | `http://localhost:5173` / `dist/` |
| **Partner POS App** | `burgonomics-partner/` | React 18, Vite, Lucide, Recharts, Tailwind CSS. Live KDS stream, Cloud Functions POS & Porter bridge (`partnerFunctionsApi.ts`), 3-tier ticketing, multi-branch revenue analytics. | `http://localhost:5174` / `dist/` |
| **Backend Functions** | `functions/` | Firebase Cloud Functions v2 (Node.js 20, TypeScript, Express). `asia-south1`. Authoritative pricing engine, Razorpay Route splits, Petpooja POS bridge, Porter 3PL dispatch, Ticket auto-escalator. | `http://localhost:5001` / `dist/` |
| **Firestore & Security** | Root (`firestore.rules`, `firestore.indexes.json`) | Single Firestore database in `asia-south1`. RBAC hierarchy (6 roles), strict custom claims enforcement, DPDP Act 2023 compliance. | `http://localhost:8080` |

---

## 2. Current Health & Verification Status

- ✅ **All 12 ICM Stages Complete**: Stages `01_project_setup` through `12_settings_notifications` have fully verified stage contracts and output summaries.
- ✅ **Test Suites Passing (100%)**:
  - `burgonomics-foundation-core`: 74 unit & integration tests passing (including 611k ops/sec cart stress test).
  - `burgonomics-partner`: All tests and TypeScript checks passing (`tsc --noEmit` 0 errors).
  - `functions`: 27 tests passing across Porter, Petpooja, E2E flow, Pricing engine, Tickets, and Razorpay.
- ✅ **Production Builds Verified**:
  - `burgonomics-foundation-core/dist/` (Web bundle + mobile assets)
  - `burgonomics-partner/dist/` (Web bundle)
  - `functions/dist/` (Compiled TypeScript backend)
- ✅ **Android Binaries & Capacitor Sync**: Synced latest web assets and native plugins for both mobile apps.
- ✅ **Client Handover Package Published**: [CLIENT_HANDOVER_AND_KEYS.md](file:///c:/Users/DELL/Desktop/Burgonomics/CLIENT_HANDOVER_AND_KEYS.md).

---

## 3. Firebase Environment & Project Configuration

- **Authenticated Firebase Account**: `pandejesal@gmail.com`
- **Active Firebase Project ID**: `burgonomics-7faa8`
- **Project Number**: `738930066637`
- **Default Hosting URL**: `https://burgonomics-7faa8.web.app`

### Configured `.firebaserc`
```json
{
  "projects": {
    "default": "burgonomics-7faa8"
  },
  "targets": {
    "burgonomics-7faa8": {
      "hosting": {
        "burgonomics-app": [
          "burgonomics-7faa8"
        ]
      }
    }
  }
}
```

### Configured `firebase.json` Multi-Site Targets
- **Target `burgonomics-app`**: Points to `burgonomics-foundation-core/dist/mobile` (Customer 3-Way App).
- **Target `burgonomics-partner`**: Points to `burgonomics-partner/dist` (Partner POS & Operations).

---

## 4. Step-by-Step Deployment Playbook

Run the following commands in PowerShell from the project root (`c:\Users\DELL\Desktop\Burgonomics`):

### Step 1: Pre-Deployment Production Builds
```powershell
# 1. Build Backend Cloud Functions
cd c:\Users\DELL\Desktop\Burgonomics\functions
npm run build

# 2. Build Customer App
cd c:\Users\DELL\Desktop\Burgonomics\burgonomics-foundation-core
npm run build

# 3. Build Partner Operations App
cd c:\Users\DELL\Desktop\Burgonomics\burgonomics-partner
npm run build

cd c:\Users\DELL\Desktop\Burgonomics
```

### Step 2: Bind Partner Hosting Target Site (One-Time Setup)
```powershell
# Create or bind the second hosting site for Partner POS if not already created
npx firebase-tools hosting:sites:create burgonomics-partner --project burgonomics-7faa8

# Apply the target mapping to .firebaserc
npx firebase-tools target:apply hosting burgonomics-partner burgonomics-partner --project burgonomics-7faa8
```

### Step 3: Deploy Firestore Security Rules & Indexes
```powershell
npx firebase-tools deploy --only firestore --project burgonomics-7faa8
```

### Step 4: Deploy Cloud Functions v2 (`asia-south1`)
```powershell
npx firebase-tools deploy --only functions --project burgonomics-7faa8
```

### Step 5: Deploy Web Hosting Sites
```powershell
# Deploy both Customer App and Partner App
npx firebase-tools deploy --only hosting --project burgonomics-7faa8
```

---

## 5. Post-Deployment Verification & Operational Checklist

| # | Task | Description | Command / Action |
|---|---|---|---|
| **1** | **Cloud Function Health Check** | Verify `api` endpoint returns correct CORS and responses | `curl https://asia-south1-burgonomics-7faa8.cloudfunctions.net/api/porter/quote` |
| **2** | **Customer App Verification** | Open live Customer App URL in browser | Visit `https://burgonomics-7faa8.web.app` — test 3-way fulfillment switcher and menu |
| **3** | **Partner App Verification** | Open live Partner POS URL in browser | Visit `https://burgonomics-partner.web.app` — test KDS stream and revenue analytics |
| **4** | **Bootstrap Brand Owner Claim** | Set `brand_owner` custom claim on initial admin account | Call `/auth/setClaims` endpoint with ID token |
| **5** | **Live API Keys (Production Flip)** | Set Secret Manager variables for production | `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `PETPOOJA_APP_KEY`, `PORTER_API_KEY` |
| **6** | **Automated Firestore Backup** | Enable daily GCP export in `asia-south1` | Cloud Console -> Firestore -> Backups |

---

## 6. Key Reference Files

- [CONTEXT.md](file:///c:/Users/DELL/Desktop/Burgonomics/CONTEXT.md) — Layer 1 Task Router & Stage Index
- [GEMINI.md](file:///c:/Users/DELL/Desktop/Burgonomics/GEMINI.md) — Layer 0 Identity & Strict 60-30-10 Design Rules
- [references/backend_upgrade_spec.md](file:///c:/Users/DELL/Desktop/Burgonomics/references/backend_upgrade_spec.md) — Master Backend Specification
- [references/known_issues.md](file:///c:/Users/DELL/Desktop/Burgonomics/references/known_issues.md) — Active Operational Roadmap
- [STORE_SUBMISSION_GUIDE.md](file:///c:/Users/DELL/Desktop/Burgonomics/STORE_SUBMISSION_GUIDE.md) — Google Play & App Store Release Guide
