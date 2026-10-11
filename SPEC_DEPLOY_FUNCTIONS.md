# SPEC: Deploy Cloud Functions Backend

## Problem Statement
The Burgonomics Firebase project (`burgonomics-7faa8`) has **Firestore deployed and working** (delivery app reads/writes orders, menus, users directly), but **Cloud Functions are NOT deployed** (all endpoints return 404 across all regions).

## Current State
- ✅ Firestore: Deployed, rules active, delivery app functional
- ✅ Firebase Auth: Deployed, users can sign in
- ❌ Cloud Functions: NOT deployed (404 on all endpoints)
- ❓ Firebase Hosting: Not verified

## Domains Affected
1. **Payments/Razorpay** - Payment order creation, verification, refunds, webhooks
2. **POS/Petpooja** - Menu sync, order push, KOT webhooks, stock webhooks
3. **Logistics/Porter** - Quote, booking, rebooking, cancellation, webhooks
4. **Multi-provider Dispatch** - Borzo/Shadowfax/Porter routing, booking, webhooks
5. **Delivery OTP** - OTP verification for delivery handover
6. **Tickets/Loyalty** - Server-side resolution with loyalty/refund
7. **Notifications/FCM** - Topic management, device token registration
8. **Auth/Account** - Account deletion, staff invite, custom claims

## Deployment Prerequisites
- [ ] `functions/.env` filled with REAL keys (see KEYS_REQUEST_FOR_BURGONOMICS.md)
- [ ] `google-services.json` present in `functions/`
- [ ] Firestore rules/indexes deployed (or deploy first)

## Deployment Commands
```bash
# 1. Prepare environment
cd C:\Users\DELL\Desktop\Burgonomics\functions
cp .env.example .env
# Edit .env with REAL keys from KEYS_REQUEST_FOR_BURGONOMICS.md

# 2. Deploy Firestore (rules + indexes)
cd C:\Users\DELL\Desktop\Burgonomics
firebase deploy --only firestore

# 3. Deploy Functions (requires real keys - assertProductionKeys blocks mock)
firebase deploy --only functions

# 4. Verify deployment
curl https://asia-south1-burgonomics-7faa8.cloudfunctions.net/api/health
# Expected: {"status":"healthy","timestamp":"...","service":"burgonomics-api"}
```

## Success Criteria
- [ ] `GET /api/health` returns 200 with `{"status":"healthy",...}`
- [ ] `POST /api/payments/createPaymentOrder` accepts valid payload
- [ ] `POST /api/petpooja/syncMenu` works for staff
- [ ] `POST /api/porter/quote` returns fare quote
- [ ] `POST /api/dispatch/quote` returns multi-provider quotes
- [ ] All webhook endpoints respond to provider callbacks
- [ ] No `assertProductionKeys` errors in Functions logs

## Risk Mitigation
- Functions `assertProductionKeys` will REFUSE to boot with mock/missing keys
- Must have REAL keys in `functions/.env` before deploy
- Deploy Firestore first (rules/indexes) since Functions depend on them
- Monitor Functions logs for `assertProductionKeys` failures post-deploy