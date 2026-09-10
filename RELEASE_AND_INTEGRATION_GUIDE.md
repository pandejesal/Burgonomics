# BURGONOMICS — Master Release, Integration & Store Publication Guide

> **Authoritative Guide for Live Gateways (Petpooja POS & Porter Delivery), Production Deployment, and App Store & Google Play Store Publishing.**  
> **Target Project ID**: `burgonomics-7faa8` (or Client GCP Project) | **Region**: `asia-south1` (Mumbai)  
> **System Verification**: 602 Tests Passing (230 Functions, 151 Partner POS, 221 Customer App)

---

## 📑 Table of Contents

1. [Architecture & Live Gateway Operations](#1-architecture--live-gateway-operations)
2. [Petpooja POS Bridge Deep Dive (Live vs Mock)](#2-petpooja-pos-bridge-deep-dive-live-vs-mock)
3. [Porter 3PL Logistics Deep Dive (Live vs Mock)](#3-porter-3pl-logistics-deep-dive-live-vs-mock)
4. [Apple App Store Publication Guide](#4-apple-app-store-publication-guide)
5. [Google Play Store Publication Guide](#5-google-play-store-publication-guide)
6. [Reviewer Demo Credentials & Sandbox Mode](#6-reviewer-demo-credentials--sandbox-mode)
7. [Environment Secrets & Production Deployment Checklist](#7-environment-secrets--production-deployment-checklist)
8. [Automated Verification & Build Commands](#8-automated-verification--build-commands)

---

## 1. Architecture & Live Gateway Operations

Burgonomics operates as a modern dual-app QSR platform powered by Firebase Cloud Functions v2 and Google Cloud infrastructure in `asia-south1` (Mumbai):

```
                               ┌─────────────────────────────────────────┐
                               │   Customer App (BURGONOMICS)            │
                               │   • 3-Way Fulfillment (Delivery/Take/Dine)│
                               │   • 1-Tap Add & MiniCart                │
                               │   • Razorpay Checkout & Live Tracking   │
                               └────────────────────┬────────────────────┘
                                                    │
                               ┌────────────────────▼────────────────────┐
                               │     Firebase Cloud Functions v2         │
                               │     (Serverless Backend in asia-south1) │
                               └──────────────┬──────────────┬───────────┘
                                              │              │
                     ┌────────────────────────┘              └────────────────────────┐
                     ▼                                                                ▼
   ┌───────────────────────────────────┐                            ┌───────────────────────────────────┐
   │        PETPOOJA POS BRIDGE        │                            │       PORTER LOGISTICS 3PL        │
   ├───────────────────────────────────┤                            ├───────────────────────────────────┤
   │ • Menu Sync: /mapped_restaurant   │                            │ • Live Fare Quote: /orders/quote  │
   │ • Live KOT Push: /save_order      │                            │ • 2-Wheeler Dispatch: /orders/cr. │
   │ • Instant 86ing: /item_stock_up.  │                            │ • HMAC Webhooks: Milestone Sync   │
   │ • Webhooks: Status & Auto-Refund  │                            │ • Handover OTP: 4-digit security  │
   └───────────────────────────────────┘                            └───────────────────────────────────┘
```

Both 3rd-party gateway integrations have been architected with **fail-safe fallback triggers**:
- In **development / sandbox mode**, they gracefully return simulated data if credentials are missing or contain `"mock"`.
- In **production mode**, providing live credentials and setting `MOCK_PETPOOJA_POS=false` and `MOCK_PORTER_DISPATCH=false` executes real, authoritative HTTP requests.

---

## 2. Petpooja POS Bridge Deep Dive (Live vs Mock)

### Implementation Overview
- **Service Files**:
  - Client & Config: [`functions/src/modules/petpooja/client.ts`](file:///c:/Users/DELL/Desktop/Burgonomics/functions/src/modules/petpooja/client.ts)
  - Order Push: [`functions/src/modules/petpooja/orderPush.ts`](file:///c:/Users/DELL/Desktop/Burgonomics/functions/src/modules/petpooja/orderPush.ts)
  - Menu Ingestion: [`functions/src/modules/petpooja/menuSyncWebhook.ts`](file:///c:/Users/DELL/Desktop/Burgonomics/functions/src/modules/petpooja/menuSyncWebhook.ts)
  - Stock 86ing & Webhooks: [`functions/src/modules/petpooja/item86ingSync.ts`](file:///c:/Users/DELL/Desktop/Burgonomics/functions/src/modules/petpooja/item86ingSync.ts)
  - Schedulers: [`functions/src/modules/petpooja/petpooja.scheduler.ts`](file:///c:/Users/DELL/Desktop/Burgonomics/functions/src/modules/petpooja/petpooja.scheduler.ts)

### How Each Operation Works

| Operation | Trigger | Live API Endpoint & Payload | Action Taken |
|---|---|---|---|
| **KOT Push** | Payment capture (`verifyPayment` or `payment.captured` webhook) | `POST /save_order` with `app_key`, `app_secret`, `access_token`, and nested `orderinfo` (including `clientOrderID` dedup hook). | Sends order to kitchen thermal printer; saves returned `petpoojaOrderId` to Firestore. |
| **Menu Ingestion** | Hourly Cloud Scheduler (`hourlyPetpoojaMenuSync`) or Manual Partner Trigger | `POST /mapped_restaurant_menus` (Menu API host) with `rest_id` and auth headers. | Writes items to Firestore `products` collection with MRP, `isVeg`, `inStock`, and category mappings. |
| **Instant 86ing (Stock Out)** | Petpooja POS Terminal toggle | `POST /api/petpooja/stockWebhook` (Inbound webhook) | Sets `inStock = false` on the specific product doc in real time, disabling it on customer app. |
| **Kitchen Webhook & Refund** | Chef cancels item or entire order in Petpooja POS | `POST /api/petpooja/webhook` (Inbound webhook) | Updates order status to `cancelled` and automatically triggers an instant partial/full Razorpay refund. |

### How to Switch to Live Petpooja
In `functions/.env` (and GCP Secret Manager):
```ini
PETPOOJA_ENABLED=true
MOCK_PETPOOJA_POS=false
PETPOOJA_APP_KEY=your_live_app_key
PETPOOJA_APP_SECRET=your_live_app_secret
PETPOOJA_ACCESS_TOKEN=your_live_access_token
PETPOOJA_MENU_URL=https://qle1yy2ydc.execute-api.ap-southeast-1.amazonaws.com/V1
PETPOOJA_ORDER_URL=https://47pfzh5sf2.execute-api.ap-southeast-1.amazonaws.com/V1
```
*In Firestore: Ensure each branch document (`branches/{branchId}`) contains the branch's specific Petpooja restaurant ID under `petpooja.restId`.*

---

## 3. Porter 3PL Logistics Deep Dive (Live vs Mock)

### Implementation Overview
- **Service Files**:
  - Client & Rates: [`functions/src/modules/porter/client.ts`](file:///c:/Users/DELL/Desktop/Burgonomics/functions/src/modules/porter/client.ts)
  - Booking & OTP: [`functions/src/modules/porter/bookingService.ts`](file:///c:/Users/DELL/Desktop/Burgonomics/functions/src/modules/porter/bookingService.ts)
  - Porter Core: [`functions/src/modules/porter/porter.service.ts`](file:///c:/Users/DELL/Desktop/Burgonomics/functions/src/modules/porter/porter.service.ts)

### How Each Operation Works

| Operation | Trigger | Live API Endpoint & Payload | Action Taken |
|---|---|---|---|
| **Live Delivery Fare Quote** | Customer selects delivery address | `POST https://api.porter.in/v1/orders/quote` with `x-api-key`, `pickup_details` lat/lng, `drop_details` lat/lng, and `vehicle_type: "2_WHEELER"`. | Returns live fare and ETA; locks fare for 10 minutes (`validForSeconds: 600`). |
| **Rider Dispatch** | Partner POS taps **"Book Porter Rider"** when food is ready | `POST https://api.porter.in/v1/orders/create` with outlet address, customer address, and phone numbers. | Porter allocates driver; returns `order_id`, driver name, driver phone, vehicle number, and tracking URL. |
| **Driver Tracking Webhook** | Porter driver status updates | `POST /api/porter/webhook` with `x-porter-signature` HMAC SHA-256 header. | Normalizes events (`DRIVER_ALLOCATED`, `ARRIVED_AT_PICKUP`, `STARTED_DELIVERY`, `DELIVERED`, `RIDER_CANCELLED`) and updates Firestore. |
| **5-Minute Polling Fallback** | Scheduled Cloud Function (`pollActivePorterDeliveries`) | `GET https://api.porter.in/v1/orders/{porterOrderId}` | Checks active deliveries that haven't received a webhook in >15 minutes to guarantee real-time customer tracking. |
| **Handover OTP Verification** | Rider arrives at customer doorstep | `POST /api/orders/verifyDeliveryOtp` with order ID & 4-digit code. | Validates OTP using timing-safe comparison; marks order `delivered`. |

### How to Switch to Live Porter
In `functions/.env`:
```ini
PORTER_ENABLED=true
MOCK_PORTER_DISPATCH=false
PORTER_API_KEY=your_live_porter_api_key
PORTER_CUSTOMER_ID=your_porter_customer_id
PORTER_WEBHOOK_SECRET=your_porter_webhook_secret
PORTER_BASE_URL=https://api.porter.in
```

---

## 4. Apple App Store Publication Guide

### App Identifiers
- **Customer App**: `com.glassdoorsstudio.burgonomics`
- **Partner POS App**: `com.glassdoorsstudio.burgonomics.partner`

### Prerequisites
1. **Apple Developer Account** enrolled at [developer.apple.com](https://developer.apple.com).
2. **Xcode 16+** installed on macOS.
3. Place `GoogleService-Info.plist` in:
   - `burgonomics-foundation-core/ios/App/App/GoogleService-Info.plist`
   - `burgonomics-partner/ios/App/App/GoogleService-Info.plist`

### Build & Upload Commands (macOS)
```bash
# 1. Compile and prepare Customer App
cd burgonomics-foundation-core
chmod +x mac-build.sh
./mac-build.sh

# 2. Compile and prepare Partner App
cd ../burgonomics-partner
chmod +x mac-build.sh
./mac-build.sh
```

### Xcode Archive & Distribution
1. Open the project in Xcode:
   - Customer: `burgonomics-foundation-core/ios/App/App.xcworkspace`
   - Partner: `burgonomics-partner/ios/App/App.xcworkspace`
2. Select **Any iOS Device (arm64)** as build target.
3. In the top menu, click **Product → Archive**.
4. Once the Organizer opens, click **Distribute App → App Store Connect / TestFlight**.
5. Select automatic signing and click **Upload**.

---

## 5. Google Play Store Publication Guide

### App Identifiers
- **Customer App**: `com.glassdoorsstudio.burgonomics`
- **Partner POS App**: `com.glassdoorsstudio.burgonomics.partner`

### Prerequisites
1. **Google Play Console Account** at [play.google.com/console](https://play.google.com/console).
2. Place `google-services.json` in:
   - `burgonomics-foundation-core/android/app/google-services.json`
   - `burgonomics-partner/android/app/google-services.json`
3. Register your upload key SHA-1 and SHA-256 in Firebase Console under Project Settings → Your Apps.

### Compilation Commands (Windows / macOS / Linux)
```powershell
# 1. Customer App (.aab)
cd c:\Users\DELL\Desktop\Burgonomics\burgonomics-foundation-core
npm run build:mobile
npx cap sync android
cd android
./gradlew bundleRelease

# 2. Partner POS App (.aab)
cd c:\Users\DELL\Desktop\Burgonomics\burgonomics-partner
npm run build:mobile
npx cap sync android
cd android
./gradlew bundleRelease
```
*Generated output paths:*
- Customer AAB: `burgonomics-foundation-core/android/app/build/outputs/bundle/release/app-release.aab`
- Partner AAB: `burgonomics-partner/android/app/build/outputs/bundle/release/app-release.aab`

---

## 6. Reviewer Demo Credentials & Sandbox Mode

> [!IMPORTANT]
> Both Apple and Google review teams are located internationally. Enter these exact credentials in the **App Review Information / Sign-in required** section to ensure instant approval without SMS delivery failure.

### Customer App Reviewer Login
- **Login Method**: Phone OTP
- **Phone Number**: `+91 99999 99999` (or `9999999999`)
- **Fixed Verification Code / OTP**: `123456`
- **Reviewer Note**:
  > *"Please log in using the test phone number and OTP above. A sandbox delivery address and test branch ('Ahmedabad Central') will be pre-selected. Placing an order triggers automated sandbox checkout where payment completes instantly and transitions to live order tracking."*

### Partner POS App Reviewer Login
- **Login Method**: Email & Password
- **Email**: `reviewer@burgonomics.com`
- **Password**: `Burgonomics@2026`
- **Assigned Role**: `branch_owner` (Demo Branch)
- **Reviewer Note**:
  > *"Burgonomics Partner is an internal operations management application for authorized franchise store managers and kitchen staff. Log in with the credentials above to test live Kitchen Order Tickets (KDS), menu item 86ing, ticket management, and analytics."*

---

## 7. Environment Secrets & Production Deployment Checklist

### Production `.env` for Cloud Functions (`functions/.env`)
```ini
# Firebase Cloud Functions (asia-south1)
FIREBASE_PROJECT_ID=burgonomics-7faa8
FIREBASE_REGION=asia-south1

# Razorpay (Live / Production)
RAZORPAY_KEY_ID=rzp_live_xxxxxxxxxxxxxx
RAZORPAY_KEY_SECRET=xxxxxxxxxxxxxxxxxxxxxxxx
RAZORPAY_WEBHOOK_SECRET=whsec_xxxxxxxxxxxxxxxxxxxx

# Petpooja POS (Live / Production)
PETPOOJA_ENABLED=true
PETPOOJA_APP_KEY=xxxxxxxxxxxxxxxxxxxxxxxx
PETPOOJA_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxx
PETPOOJA_ACCESS_TOKEN=xxxxxxxxxxxxxxxxxxxxxxxx
PETPOOJA_MENU_URL=https://qle1yy2ydc.execute-api.ap-southeast-1.amazonaws.com/V1
PETPOOJA_ORDER_URL=https://47pfzh5sf2.execute-api.ap-southeast-1.amazonaws.com/V1

# Porter Logistics (Live / Production)
PORTER_ENABLED=true
PORTER_API_KEY=prt_live_xxxxxxxxxxxxxxxx
PORTER_CUSTOMER_ID=cust_xxxxxxxxxxxxxxxx
PORTER_WEBHOOK_SECRET=prt_whsec_xxxxxxxxxxxx
PORTER_BASE_URL=https://api.porter.in

# Feature Flags (Set false for live gateways)
MOCK_PAYMENT_GATEWAY=false
MOCK_PORTER_DISPATCH=false
MOCK_PETPOOJA_POS=false
```

### Full Deployment Execution
```bash
# 1. Deploy Firestore Security Rules & Indexes
npx firebase-tools deploy --only firestore --project burgonomics-7faa8

# 2. Deploy Cloud Functions v2
cd functions
npm run build
npx firebase-tools deploy --only functions --project burgonomics-7faa8

# 3. Deploy Multi-Site Web Hosting
cd ../burgonomics-foundation-core && npm run build
cd ../burgonomics-partner && npm run build
cd ..
npx firebase-tools deploy --only hosting --project burgonomics-7faa8
```

---

## 8. Automated Verification & Build Commands

All 602 tests across the three monorepo packages are green:

```bash
# 1. Backend Functions (230 tests)
cd functions
npx tsc --noEmit && npm test && npm run build

# 2. Partner POS App (151 tests)
cd ../burgonomics-partner
npx tsc --noEmit && npm test && npm run build

# 3. Customer App (221 tests)
cd ../burgonomics-foundation-core
npx tsc --noEmit && npm test && npm run build
```

| Package | Test Suites | Total Tests | Status |
|---|---|---|---|
| **Backend Functions** (`functions/`) | 23 Suites | **230 passed** | ✅ Clean (`dist/index.js`) |
| **Partner POS App** (`burgonomics-partner/`) | 30 Suites | **151 passed** | ✅ Clean (`dist/`) |
| **Customer App** (`burgonomics-foundation-core/`) | 38 Suites | **221 passed** | ✅ Clean (`dist/mobile`) |
| **Total Monorepo Suite** | **91 Suites** | **602 passed** | ✅ **Release Ready** |
