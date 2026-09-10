# Burgonomics Dual-App Audit Report (Antigravity)
Date: 2026-09-03

## Executive Summary

A comprehensive architectural, integration, security, build configuration, and store-readiness audit was conducted across the Burgonomics ecosystem:
1. **`burgonomics-foundation-core`** (Customer Mobile & Web App)
2. **`burgonomics-partner`** (Franchise / Branch / Kitchen Display & Admin App)
3. **`functions/`** (Firebase Cloud Functions v2 shared backend)

### Status Matrix

| Component | Status | Unit Tests | Typecheck | Production Build | Key Observations |
| :--- | :---: | :---: | :---: | :---: | :--- |
| **burgonomics-foundation-core** | **WARNING** | PASS (33/33 files, 200 tests) | PASS (0 errors) | PASS (`dist/mobile` SPA) | Client-side payments pointed to legacy Netlify function instead of Firebase Functions v2; hardcoded Firebase config; `webContentsDebuggingEnabled` enabled. |
| **burgonomics-partner** | **FAIL** | PASS (22/22 files, 118 tests) | PASS (0 errors) | PASS (`dist` SPA) | Native FCM push notifications completely unwired in React layer despite plugin installed; loud order alarm audio (`new_order.wav`) missing from native bundles; `webContentsDebuggingEnabled` enabled. |
| **functions (Cloud Functions v2)** | **FAIL** | PASS (13/13 files, 86 tests) | PASS (0 errors) | PASS (`dist/index.js`) | Root `firestore.rules` allows arbitrary user self-elevation to `brand_owner` via `/admins/{uid}`; `assertProductionKeys()` guard never called; Petpooja signature verification crashes on length mismatch. |

---

## burgonomics-foundation-core

### Architecture & Code Quality
- **Framework**: React 19.2.0, Vite 8.0.16, Tailwind CSS v4.2.1, TanStack Router with `@tanstack/router-plugin/vite` file-based routing, TanStack Query v5.101.1, Zustand v5.0.14.
- **Dual-Packaging Architecture**:
  - Web uses TanStack Start SSR / Nitro.
  - Mobile packaging uses a dedicated Vite configuration ([`vite.mobile.config.ts:1-58`](file:///C:/Users/DELL/Desktop/Burgonomics/burgonomics-foundation-core/vite.mobile.config.ts#L1-L58)) outputting a static SPA to `dist/mobile` (target `es2020`, hashed assets, `assetsInlineLimit: 4096`).
  - [`capacitor.config.ts:14`](file:///C:/Users/DELL/Desktop/Burgonomics/burgonomics-foundation-core/capacitor.config.ts#L14) correctly maps `webDir: "dist/mobile"`.
- **Code Health**: Clean type check (`npx tsc --noEmit` exited 0), test suite passed with 200 unit tests across 33 files.

### Third-Party Integrations

#### Firebase (Auth/Firestore/Functions/Storage)
- **Configuration**:
  - In [`src/core/config/firebase.ts:5-13`](file:///C:/Users/DELL/Desktop/Burgonomics/burgonomics-foundation-core/src/core/config/firebase.ts#L5-L13), Firebase web credentials are hardcoded as static string literals (`apiKey: "AIzaSyAuoa6yU-S8bNR3QDI3DjTUvbKNyBu3_Fs"`, `projectId: "burgonomics-7faa8"`) rather than read from `import.meta.env.VITE_FIREBASE_*`.
- **Adapter Layer**:
  - [`src/core/integrations/firebase/index.ts:26-40`](file:///C:/Users/DELL/Desktop/Burgonomics/burgonomics-foundation-core/src/core/integrations/firebase/index.ts#L26-L40) implements an empty stub contract (`firebaseAdapter` returning mock `prompt` permissions and `null` push token). The actual operational logic resides in [`src/shared/platform/pushNotifications.ts`](file:///C:/Users/DELL/Desktop/Burgonomics/burgonomics-foundation-core/src/shared/platform/pushNotifications.ts).

#### Razorpay Payments
- **Client Implementation**:
  - [`src/core/integrations/razorpay/index.ts:72`](file:///C:/Users/DELL/Desktop/Burgonomics/burgonomics-foundation-core/src/core/integrations/razorpay/index.ts#L72) hardcodes `keyId: "rzp_test_mock"`.
  - [`src/features/payments/services/paymentsService.ts:34-39`](file:///C:/Users/DELL/Desktop/Burgonomics/burgonomics-foundation-core/src/features/payments/services/paymentsService.ts#L34-L39) defaults to `/.netlify/functions/payments` instead of the Firebase Cloud Functions backend.
  - In [`.env:1`](file:///C:/Users/DELL/Desktop/Burgonomics/burgonomics-foundation-core/.env#L1), `VITE_PAYMENTS_API_BASE_URL` points to `https://burgonomics.netlify.app/.netlify/functions/payments`, diverging from the shared backend engine in `functions/`.

#### Petpooja POS
- **Client Implementation**:
  - Uses [`src/core/integrations/petpooja/mockGateway.ts`](file:///C:/Users/DELL/Desktop/Burgonomics/burgonomics-foundation-core/src/core/integrations/petpooja/mockGateway.ts) and [`src/core/integrations/petpooja/mapper.ts`](file:///C:/Users/DELL/Desktop/Burgonomics/burgonomics-foundation-core/src/core/integrations/petpooja/mapper.ts).
  - Direct POS interaction from the customer app is disabled; order syncing is deferred to server webhooks upon payment capture.

#### FCM Push Notifications
- **Implementation**:
  - [`src/shared/platform/pushNotifications.ts:40-125`](file:///C:/Users/DELL/Desktop/Burgonomics/burgonomics-foundation-core/src/shared/platform/pushNotifications.ts#L40-L125) properly binds `@capacitor/push-notifications` dynamically.
  - Registers device token to Firestore via `notificationsService.registerDeviceToken(token.value)`.
  - Listens to foreground push messages and triggers in-app toast (`toast()`) and Zustand notification store append.
- **Routing Issue**:
  - In [`src/shared/platform/pushNotifications.ts:95,112`](file:///C:/Users/DELL/Desktop/Burgonomics/burgonomics-foundation-core/src/shared/platform/pushNotifications.ts#L95), deeplink handling uses `window.location.href = deeplink;` which causes a full-page reload within the Capacitor WebView instead of client-side routing via TanStack Router.

### API Layer (via Functions)
- In the customer app, API requests currently target Netlify serverless functions (`/.netlify/functions/payments`) instead of the unified Firebase Cloud Functions v2 backend.
- Token handling attaches `Authorization: Bearer <token>` retrieved from [`@aparajita/capacitor-secure-storage`](file:///C:/Users/DELL/Desktop/Burgonomics/burgonomics-foundation-core/package.json#L26).

### Security
- **Local Firestore Rules**:
  - [`burgonomics-foundation-core/firestore.rules:282-285`](file:///C:/Users/DELL/Desktop/Burgonomics/burgonomics-foundation-core/firestore.rules#L282-L285) restricts `/admins/{uid}` write strictly to `isBrandOwner()`. (However, see the root `firestore.rules` vulnerability in Cross-Cutting Issues).
- **Hardcoded Keys**:
  - Firebase config hardcoded in `src/core/config/firebase.ts`.
  - Razorpay mock key `rzp_test_mock` hardcoded in `src/core/integrations/razorpay/index.ts`.

### Build Configurations
- **Capacitor** ([`capacitor.config.ts`](file:///C:/Users/DELL/Desktop/Burgonomics/burgonomics-foundation-core/capacitor.config.ts)):
  - Line 22: `webContentsDebuggingEnabled: true` is hardcoded. Must be set to `false` or conditioned on build mode.
  - Line 18: `limitsNavigationsToAppBoundDomains: true` is active for iOS WKWebView security.
- **Android Gradle** ([`android/app/build.gradle`](file:///C:/Users/DELL/Desktop/Burgonomics/burgonomics-foundation-core/android/app/build.gradle)):
  - Version management uses [`version.properties`](file:///C:/Users/DELL/Desktop/Burgonomics/burgonomics-foundation-core/android/app/build.gradle#L6-L14).
  - Lines 53-54: `minifyEnabled false` and `shrinkResources false` in release block.
  - Release signing falls back to `signingConfigs.debug` if environment variables are missing.
- **Android Manifest** ([`android/app/src/main/AndroidManifest.xml`](file:///C:/Users/DELL/Desktop/Burgonomics/burgonomics-foundation-core/android/app/src/main/AndroidManifest.xml)):
  - Line 4: `android:allowBackup="false"` is correctly set.
  - Deep link configured with custom scheme `<data android:scheme="burgonomics" />`. Lacks Android App Links (`https://burgonomics.com` with `autoVerify="true"`).
- **iOS Xcode** ([`ios/App/App/Info.plist`](file:///C:/Users/DELL/Desktop/Burgonomics/burgonomics-foundation-core/ios/App/App/Info.plist)):
  - Privacy permission descriptions present: `NSLocationWhenInUseUsageDescription`, `NSCameraUsageDescription`, `NSPhotoLibraryUsageDescription`.
  - App-bound domains declared: `burgonomics.com`, `partner.burgonomics.com`, `burgonomics.netlify.app`.

### Store Readiness
- **Google Play Store**:
  - Target SDK: 36, Compile SDK: 36, Min SDK: 24 ([`android/variables.gradle:2-4`](file:///C:/Users/DELL/Desktop/Burgonomics/burgonomics-foundation-core/android/variables.gradle#L2-L4)). Meets Google Play minimum API level requirements.
  - App Bundle: Build commands emit standard Capacitor outputs.
- **Apple App Store**:
  - `PrivacyInfo.xcprivacy` ([`ios/App/App/PrivacyInfo.xcprivacy`](file:///C:/Users/DELL/Desktop/Burgonomics/burgonomics-foundation-core/ios/App/App/PrivacyInfo.xcprivacy)): Required reason APIs (`UserDefaults`, `FileTimestamp`, `DiskSpace`, `SystemBootTime`) are declared. However, `NSPrivacyCollectedDataTypes` is empty `[]`, which conflicts with the customer data collected (Name, Phone, Location, Orders).
  - `project.pbxproj`: `DEVELOPMENT_TEAM` is empty, requiring signing configuration in CI/Xcode before archive.

### Testing & CI/CD
- **Workflows**:
  - [`.github/workflows/ci.yml`](file:///C:/Users/DELL/Desktop/Burgonomics/burgonomics-foundation-core/.github/workflows/ci.yml): Runs web build, typecheck, lint, dashboard verify, vitest unit suite, gitleaks secret scanning, and Android debug build (`./gradlew assembleDebug`).
  - [`.github/workflows/android-build.yml`](file:///C:/Users/DELL/Desktop/Burgonomics/burgonomics-foundation-core/.github/workflows/android-build.yml) & [`ios-build.yml`](file:///C:/Users/DELL/Desktop/Burgonomics/burgonomics-foundation-core/.github/workflows/ios-build.yml) available for automated release artifact packaging.

### Issues Found
| Category | Severity | File | Line | Description | Remediation |
| :--- | :---: | :--- | :---: | :--- | :--- |
| Integration | P1 | `src/features/payments/services/paymentsService.ts` | 38 | Payments service defaults to Netlify serverless function instead of Firebase Functions v2 API. | Point `VITE_PAYMENTS_API_BASE_URL` to `https://asia-south1-${PROJECT_ID}.cloudfunctions.net/api/payments`. |
| Security | P1 | `src/core/config/firebase.ts` | 6-13 | Firebase credentials hardcoded directly in source. | Read configuration dynamically from `import.meta.env.VITE_FIREBASE_*`. |
| Security | P1 | `capacitor.config.ts` | 22 | `webContentsDebuggingEnabled: true` in production configuration. | Disable web contents debugging in release builds: `process.env.NODE_ENV !== "production"`. |
| Store Readiness | P2 | `ios/App/App/PrivacyInfo.xcprivacy` | 82-83 | `NSPrivacyCollectedDataTypes` is empty despite collecting customer name, phone, and order history. | Add Apple privacy manifest declarations for Contact Info, Location, and User IDs. |
| Store Readiness | P2 | `ios/App/App.xcodeproj/project.pbxproj` | - | `DEVELOPMENT_TEAM` is not set in project build configurations. | Configure Apple Developer Team ID in Xcode target settings. |
| Architecture | P2 | `src/shared/platform/pushNotifications.ts` | 95, 112 | Push click navigates via `window.location.href`, reloading the whole WebView. | Use TanStack Router `router.navigate({ to: deeplink })`. |

---

## burgonomics-partner

### Architecture & Code Quality
- **Framework**: React 19.2.8, Vite 8.2.0, React Router DOM 7.18.2, TanStack Query v5.102.0, Tailwind CSS v4.3.3, Zustand v5.0.15.
- **Build Output**: Static SPA emitted to `dist/` with manual chunk splitting configured in [`vite.config.ts:18-92`](file:///C:/Users/DELL/Desktop/Burgonomics/burgonomics-partner/vite.config.ts#L18-L92) for vendor modules, admin modules, charts, icons, and analytics.
- **Code Health**: Clean typecheck (`tsc --noEmit` exited 0), test suite passed (22 test files, 118 tests). Production build completed in 29.43s.

### Third-Party Integrations

#### Firebase (Auth/Firestore/Functions/Storage)
- **Configuration**:
  - [`src/config/firebase.ts:7-13`](file:///C:/Users/DELL/Desktop/Burgonomics/burgonomics-partner/src/config/firebase.ts#L7-L13) correctly sources credentials from `import.meta.env.VITE_FIREBASE_*`.

#### Razorpay Payments
- **Client Implementation**:
  - The partner app does not collect customer credit card/UPI transactions directly.
  - Payment management (refunds, transaction lookups, discrepancies) is executed server-side via [`src/services/partnerFunctionsApi.ts`](file:///C:/Users/DELL/Desktop/Burgonomics/burgonomics-partner/src/services/partnerFunctionsApi.ts) calling `/payments/refund`.

#### Petpooja POS
- **Client Implementation**:
  - Implemented in [`src/services/petpoojaSync.ts`](file:///C:/Users/DELL/Desktop/Burgonomics/burgonomics-partner/src/services/petpoojaSync.ts) and [`src/services/partnerFunctionsApi.ts:61`](file:///C:/Users/DELL/Desktop/Burgonomics/burgonomics-partner/src/services/partnerFunctionsApi.ts#L61).
  - Triggers `/petpooja/pushOrder` and `/petpooja/syncMenu` against Cloud Functions v2.

#### FCM Push Notifications (CRITICAL DEFECT)
- **Problem**:
  - `@capacitor/push-notifications` is declared in `package.json` ([`package.json:33`](file:///C:/Users/DELL/Desktop/Burgonomics/burgonomics-partner/package.json#L33)), configured in `capacitor.config.ts` ([`capacitor.config.ts:40-42`](file:///C:/Users/DELL/Desktop/Burgonomics/burgonomics-partner/capacitor.config.ts#L40-L42)), and permissioned in `AndroidManifest.xml` ([`android/app/src/main/AndroidManifest.xml:44`](file:///C:/Users/DELL/Desktop/Burgonomics/burgonomics-partner/android/app/src/main/AndroidManifest.xml#L44)).
  - **However, `@capacitor/push-notifications` is NEVER imported or initialized anywhere in `burgonomics-partner/src`**.
  - In [`src/hooks/useNotifications.ts:27-34`](file:///C:/Users/DELL/Desktop/Burgonomics/burgonomics-partner/src/hooks/useNotifications.ts#L27-L34), notifications are only fetched via Firestore polling (`db.collection('notifications')`).
  - **Consequence**: The partner device NEVER registers a native device token, never receives APNs/FCM push notifications, and never subscribes to `branch_${branchId}` topic alerts. When a customer places an order, branch staff will never receive a native system tray notification or sound alert.
- **Missing Audio Resource**:
  - Backend notification dispatcher requests `sound: "new_order.wav"` ([`functions/src/modules/notifications/fcm.service.ts:22`](file:///C:/Users/DELL/Desktop/Burgonomics/functions/src/modules/notifications/fcm.service.ts#L22)).
  - `new_order.wav` is completely missing from `burgonomics-partner/android/app/src/main/res/raw/` and `burgonomics-partner/ios/App/App/`. As a result, native platforms fallback to silent or default system chimes.

### API Layer (via Functions)
- Authoritative gateway implemented in [`src/services/partnerFunctionsApi.ts`](file:///C:/Users/DELL/Desktop/Burgonomics/burgonomics-partner/src/services/partnerFunctionsApi.ts).
- Dynamically resolves Cloud Functions v2 URL (`https://asia-south1-${projectId}.cloudfunctions.net/api`), injects Firebase Auth Bearer tokens, and communicates with `/petpooja/*`, `/porter/*`, `/orders/*`, and `/auth/*`.

### Security
- Strict RBAC claims checked.
- No hardcoded secrets in source files (all environment-driven via `.env`).

### Build Configurations
- **Capacitor** ([`capacitor.config.ts`](file:///C:/Users/DELL/Desktop/Burgonomics/burgonomics-partner/capacitor.config.ts)):
  - Line 13: `webContentsDebuggingEnabled: true` is hardcoded.
  - Line 6: `webDir: 'dist'` matches Vite build output.
- **Android Gradle** ([`android/app/build.gradle`](file:///C:/Users/DELL/Desktop/Burgonomics/burgonomics-partner/android/app/build.gradle)):
  - Lines 10-11: `versionCode 1` and `versionName "1.0"` are hardcoded in `build.gradle` rather than pulled from a version properties file or CI variable.
  - Release signing falls back to debug keystore.
- **iOS Xcode** ([`ios/App/App/Info.plist`](file:///C:/Users/DELL/Desktop/Burgonomics/burgonomics-partner/ios/App/App/Info.plist)):
  - Line 77: `NSLocationAlwaysAndWhenInUseUsageDescription` declared without `UIBackgroundModes: location` entitlement, creating an App Store review rejection risk.
  - Line 83: `NSUserNotificationUsageDescription` declared, which is an invalid key for iOS (Apple uses `UNUserNotificationCenter` runtime prompts).

### Store Readiness
- **Google Play Store**:
  - Target SDK: 36, Compile SDK: 36, Min SDK: 24.
  - Lacks deep linking intent filter in `AndroidManifest.xml` (only `MAIN` launcher configured).
- **Apple App Store**:
  - `PrivacyInfo.xcprivacy`: `NSPrivacyCollectedDataTypes` empty `[]`.
  - `DEVELOPMENT_TEAM` missing in `project.pbxproj`.

### Testing & CI/CD
- [`.github/workflows/ci.yml`](file:///C:/Users/DELL/Desktop/Burgonomics/burgonomics-partner/.github/workflows/ci.yml): Steps run `npm run build`, `npm run typecheck`, `npm run lint`, `npm run test`, `gitleaks`, `./gradlew assembleDebug`, and iOS simulator xcodebuild.

### Issues Found
| Category | Severity | File | Line | Description | Remediation |
| :--- | :---: | :--- | :---: | :--- | :--- |
| Integration | P0 | `src/` (all) | - | Native push notification registration completely missing. Staff never receive native push or audio alerts on incoming orders. | Initialize `@capacitor/push-notifications` on app startup and register token to FCM / topic `branch_${branchId}`. |
| Integration | P1 | `android/app/src/main/res/` & `ios/App/App/` | - | `new_order.wav` custom notification sound file missing from native resource directories. | Add `new_order.wav` to Android `res/raw/` and iOS Xcode app bundle. |
| Security | P1 | `capacitor.config.ts` | 13 | `webContentsDebuggingEnabled: true` enabled in production config. | Set `webContentsDebuggingEnabled: false` for release builds. |
| Store Readiness | P2 | `ios/App/App/Info.plist` | 77, 83 | Declares `NSLocationAlwaysAndWhenInUseUsageDescription` without background mode; declares invalid `NSUserNotificationUsageDescription`. | Remove background location string or add background mode; remove invalid notification key. |
| Store Readiness | P2 | `android/app/build.gradle` | 10-11 | Hardcoded `versionCode 1` and `versionName "1.0"`. | Bind version code and name to CI environment or `version.properties`. |
| Store Readiness | P2 | `ios/App/App/PrivacyInfo.xcprivacy` | 82-83 | Missing data collection declarations in Apple Privacy Manifest. | Declare Staff Identity, Location, and Device Identifiers. |

---

## Functions Backend

### Architecture & Runtime
- **Platform**: Firebase Cloud Functions v2 ([`functions/src/index.ts`](file:///C:/Users/DELL/Desktop/Burgonomics/functions/src/index.ts)), deployed to region `asia-south1` with `512MiB` memory, concurrency 80, maxInstances 20.
- **Server Framework**: Express 4.19.2, CORS with origin whitelist, `express-rate-limit` (100 req / 15 min per IP), `rawBody` buffer capture for HMAC webhook validation.
- **Code Health**: 13 test files (86 tests) passed; typecheck passed clean; build emitted to `dist/index.js`.

### API Endpoints
1. **Payments (`/payments/*`)**:
   - `POST /payments/createPaymentOrder`: Generates authoritative price calculation via `pricing.engine.ts` and creates Razorpay order with Route split metadata.
   - `POST /payments/verifyPayment`: Validates HMAC signature; executes instant Razorpay Route transfer to branch linked account.
   - `POST /payments/refund`: Initiates refund with RBAC restriction (`brand_owner`, `developer`, `support`).
   - `POST /payments/webhook`: Idempotent webhook handler logging to `payment_audits` collection (`aud_evt_${eventId}`). Auto-triggers KDS notification and pushes KOT to Petpooja.
2. **Petpooja POS (`/petpooja/*`)**:
   - `POST /petpooja/syncMenu`: Syncs categories and items for branch.
   - `POST /petpooja/stockWebhook`: Handles 86ing / out-of-stock updates.
   - `POST /petpooja/webhook`: Handles general POS updates.
   - `POST /petpooja/pushOrder`: Pushes KOT order payload to Petpooja open API.
3. **Porter Logistics (`/porter/*`)**:
   - `POST /porter/quote`: Distance calculation (Haversine) with 10-minute fee lock TTL.
   - `POST /porter/book` & `rebook`: Rider booking and re-dispatch.
   - `POST /porter/webhook`: Normalizes rider events (`DRIVER_ALLOCATED`, `ARRIVED_AT_PICKUP`, `STARTED_DELIVERY`, `DELIVERED`, `RIDER_CANCELLED`).
4. **Auth & RBAC (`/auth/*`)**:
   - `POST /auth/setClaims`: Custom claims assignment and token invalidation.
   - `POST /auth/assignRole` & `revokeRole`: Admin management with role hierarchy validation.
   - `POST /auth/migrateGuest`: Merges guest orders, tickets, and addresses to permanent user; awards welcome bonus.
5. **Support & Notifications (`/tickets/*`, `/notifications/*`)**:
   - Ticket lifecycle management with inactivity reminders.

### Schedulers & Background Workers
- `hourlyPetpoojaMenuSync`: Hourly menu sync for all branches (`0 * * * *`).
- `retryPetpoojaOrders`: Retries failed KOT pushes every 5 minutes (`*/5 * * * *`).
- `retryRouteTransfers`: Retries pending Razorpay Route splits every 5 minutes (`*/5 * * * *`).
- `ticketInactivityReminder`: Scans pending tickets every 15 minutes (`*/15 * * * *`).
- `pollActivePorterDeliveries`: Polls in-progress courier deliveries every 5 minutes (`*/5 * * * *`).
- `cleanupExpiredGuestSessions`: Purges expired guest carts daily at 03:00 IST (`0 3 * * *`).

### Security Analysis
- **Webhook HMAC Timing Attack Prevention**:
  - Uses `crypto.timingSafeEqual` in `functions/src/core/security.ts`.
- **CRITICAL DEFECT: Petpooja Signature Length Exception**:
  - In [`functions/src/modules/petpooja/client.ts:43-46`](file:///C:/Users/DELL/Desktop/Burgonomics/functions/src/modules/petpooja/client.ts#L43-L46):
    ```typescript
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSignature)
    );
    ```
  - If an incoming request passes an invalid signature whose character length is not equal to `expectedSignature` (e.g. non-64 hex string), Node.js throws `RangeError: Input buffers must have the same length`, causing an unhandled 500 error instead of a clean rejection.
- **CRITICAL DEFECT: Production Key Guard Not Executed**:
  - [`functions/src/config/env.ts:54-60`](file:///C:/Users/DELL/Desktop/Burgonomics/functions/src/config/env.ts#L54-L60) provides `assertProductionKeys()`, but it is **never called anywhere in `functions/src/`**.
  - If deployed without live keys, the server will silently run in mock mode, accepting any signature except `"force_fail"` as valid payments!

---

## Cross-Cutting Issues

### P0 — Critical (Immediate Blocker)

#### 1. Privilege Escalation via `/admins/{uid}` in Root `firestore.rules`
- **Location**: [`firestore.rules:316-319`](file:///C:/Users/DELL/Desktop/Burgonomics/firestore.rules#L316-L319)
- **Vulnerability**:
  ```firestore-security-rules
  match /admins/{uid} {
    allow read: if isUser(uid) || isBrandOwner();
    allow write: if isBrandOwner() || isUser(uid);
  }
  ```
- **Exploitation Mechanism**:
  Any authenticated user `uid` can execute `setDoc(doc(db, "admins", user.uid), { role: "brand_owner" })`.
  Immediately, [`firestore.rules:22-27`](file:///C:/Users/DELL/Desktop/Burgonomics/firestore.rules#L22-L27) (`isAdmin()`) and [`firestore.rules:29-34`](file:///C:/Users/DELL/Desktop/Burgonomics/firestore.rules#L29-L34) (`isBrandOwner()`) evaluate to `true` because they check `exists(/databases/$(database)/documents/admins/$(request.auth.uid))` and `getAdminDoc().data.role == 'brand_owner'`.
  Furthermore, [`functions/src/core/middleware.ts:92-105`](file:///C:/Users/DELL/Desktop/Burgonomics/functions/src/core/middleware.ts#L92-L105) includes a fallback to read `db.collection("admins").doc(req.user.uid)`.
  **Impact**: Any customer or anonymous user can elevate their account to full Brand Owner across both Firestore and the Cloud Functions backend.
- **Remediation**:
  Modify [`firestore.rules:318`](file:///C:/Users/DELL/Desktop/Burgonomics/firestore.rules#L318) to allow write ONLY if `isBrandOwner()`:
  ```firestore-security-rules
  match /admins/{uid} {
    allow read: if isUser(uid) || isBrandOwner();
    allow write: if isBrandOwner();
  }
  ```

#### 2. Non-Enforced Production Keys & Silent Mock Payment Gateway
- **Location**: [`functions/src/config/env.ts:54`](file:///C:/Users/DELL/Desktop/Burgonomics/functions/src/config/env.ts#L54), [`functions/src/index.ts`](file:///C:/Users/DELL/Desktop/Burgonomics/functions/src/index.ts)
- **Vulnerability**: `assertProductionKeys()` is never invoked at runtime. If `RAZORPAY_KEY_ID` contains "mock" or is unset, `config.mock.paymentGateway` is `true`, causing [`functions/src/modules/payments/razorpay.service.ts:110`](file:///C:/Users/DELL/Desktop/Burgonomics/functions/src/modules/payments/razorpay.service.ts#L110) to accept ANY payment signature other than `"force_fail"`.
- **Remediation**: Call `assertProductionKeys()` at top-level initialization in `functions/src/index.ts`.

#### 3. Partner App Lacks Native FCM Push Integration
- **Location**: `burgonomics-partner/src/`
- **Impact**: Store managers and kitchen staff will not receive push notifications or loud sound alarms when orders are placed.
- **Remediation**: Add a native push initialization bootstrap in `burgonomics-partner/src/core/platform/pushBootstrap.ts`, mirroring the customer app's implementation, and subscribe branch devices to `branch_${branchId}`.

### P1 — High (Severe Operational / Security Risks)

1. **Dual-Backend Architectural Divergence**:
   - `burgonomics-foundation-core` points to Netlify functions (`/.netlify/functions/payments`), while `burgonomics-partner` and Cloud Schedulers point to Firebase Cloud Functions v2 (`https://asia-south1-${PROJECT_ID}.cloudfunctions.net/api`).
   - *Remediation*: Deprecate the Netlify functions; unify all payment, petpooja, and porter calls on Firebase Cloud Functions v2.
2. **Missing `new_order.wav` in Android and iOS Native Bundles**:
   - `functions/src/modules/notifications/fcm.service.ts` requests `new_order.wav`. Because the file does not exist in `burgonomics-partner/android/app/src/main/res/raw/` or iOS app bundle, native sound alerts fail silently.
   - *Remediation*: Place `new_order.wav` into Android `res/raw/` and iOS Xcode project resources.
3. **`webContentsDebuggingEnabled: true` in Release Builds**:
   - Exposed in both `burgonomics-foundation-core/capacitor.config.ts:22` and `burgonomics-partner/capacitor.config.ts:13`.
   - *Remediation*: Condition on environment: `webContentsDebuggingEnabled: process.env.NODE_ENV !== "production"`.
4. **Unhandled Crash in Petpooja Signature Validation**:
   - In `functions/src/modules/petpooja/client.ts:43-46`, `crypto.timingSafeEqual` throws `RangeError` if input buffer lengths differ.
   - *Remediation*: Use `timingSafeEqual` from `functions/src/core/security.ts`, which safely checks buffer lengths.

### P2 — Medium (Store Readiness & Polish)

1. **Incomplete Apple Privacy Nutrition Manifests**:
   - `NSPrivacyCollectedDataTypes` is empty `[]` in both apps' `PrivacyInfo.xcprivacy`.
   - *Remediation*: Add declarations for Contact Info, User ID, and Location.
2. **Missing `DEVELOPMENT_TEAM` in Xcode Projects**:
   - `DEVELOPMENT_TEAM` is not set in `project.pbxproj` for either app.
   - *Remediation*: Set team ID to allow automated CI archiving.
3. **Invalid Info.plist Entries in Partner App**:
   - `NSUserNotificationUsageDescription` is invalid on iOS; `NSLocationAlwaysAndWhenInUseUsageDescription` is declared without `UIBackgroundModes: location`.
   - *Remediation*: Clean up `Info.plist` usage strings.
4. **Hardcoded Android Versioning in Partner App**:
   - `burgonomics-partner/android/app/build.gradle:10-11` uses static `versionCode 1`.
   - *Remediation*: Read from `version.properties` or CI environment.

---

## Verification Evidence

### 1. `functions` Test Suite & Builds
```text
> burgonomics-functions@1.0.0 test
> vitest run

 RUN  v1.6.1 C:/Users/DELL/Desktop/Burgonomics/functions

 ✓ tests/auth.guestMigration.test.ts  (8 tests) 46ms
 ✓ tests/porter.service.test.ts  (12 tests) 58ms
 ✓ tests/auth.claims.test.ts  (10 tests) 92ms
 ✓ tests/fcm.notifications.test.ts  (4 tests) 42ms
 ✓ tests/petpooja.service.test.ts  (12 tests) 23ms
 ✓ tests/e2e.flow.test.ts  (2 tests) 71ms
 ✓ tests/ticketReminder.escalator.test.ts  (10 tests) 15ms
 ✓ tests/pricing.engine.test.ts  (5 tests) 11ms
 ✓ tests/webhooks.idempotency.test.ts  (4 tests) 77ms
 ✓ tests/notifications.test.ts  (7 tests) 19ms
 ✓ tests/payments.route-splits.test.ts  (7 tests) 17ms
 ✓ tests/tickets.service.test.ts  (2 tests) 21ms
 ✓ tests/razorpay.service.test.ts  (3 tests) 12ms

 Test Files  13 passed (13)
      Tests  86 passed (86)
   Duration  44.64s

> burgonomics-functions@1.0.0 typecheck
> tsc --noEmit
[Exit Code: 0]

> burgonomics-functions@1.0.0 build
> tsc
[Exit Code: 0]
```

### 2. `burgonomics-partner` Test Suite & Builds
```text
> burgonomics-partner@0.0.0 test
> vitest run

 RUN  v4.1.11 C:/Users/DELL/Desktop/Burgonomics/burgonomics-partner

 Test Files  22 passed (22)
      Tests  118 passed (118)
   Duration  17.94s

> burgonomics-partner@0.0.0 typecheck
> tsc --noEmit
[Exit Code: 0]

> burgonomics-partner@0.0.0 build
> tsc && vite build

✓ 3424 modules transformed.
dist/index.html                               0.96 kB
dist/assets/index-DSQAV3iL.css              182.29 kB
dist/assets/vendor-react-DJqx-A8e.js        174.78 kB
dist/assets/index-B8cgbfz4.js               439.89 kB
dist/assets/admin-core-BspCsXo0.js          808.14 kB
dist/assets/admin-analytics-DhGFbH5-.js   1,283.98 kB
✓ built in 29.43s
```

### 3. `burgonomics-foundation-core` Test Suite & Builds
```text
> burgonomics@1.0.0 test
> vitest run --exclude 'tests/rules/**'

 RUN  v4.1.10 C:/Users/DELL/Desktop/Burgonomics/burgonomics-foundation-core

 Test Files  33 passed (33)
      Tests  200 passed (200)
   Duration  49.16s

> npx tsc --noEmit
[Exit Code: 0]

> burgonomics@1.0.0 build
> vite build

✓ 2684 modules transformed.
dist/mobile/index.html                        1.94 kB
dist/mobile/assets/home-ZW7Oi2PH.js          75.27 kB
dist/mobile/assets/firebase-B2FmDdIe.js      92.52 kB
dist/mobile/assets/AppShell-BfXKvJzn.js     201.11 kB
dist/mobile/assets/index.esm-BmcDwB3X.js    486.83 kB
dist/mobile/assets/index-ItWfLY0M.js        571.24 kB
✓ built in 57.46s
```
