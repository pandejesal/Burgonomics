# BURGONOMICS — Master Store Submission & Review Package

> **Authoritative submission metadata, compliance declarations, review credentials, and build instructions for Apple App Store & Google Play Store.**

---

## 📱 1. Application Identifiers & Architecture

| Parameter | Customer App | Partner POS & Operations App |
|---|---|---|
| **App Name** | `BURGONOMICS` | `Burgonomics Partner` |
| **Subtitle (iOS)** | `100% Pure Veg Gourmet Burgers` | `Kitchen Display, POS & Ops` |
| **Package / Bundle ID** | `com.glassdoorsstudio.burgonomics` | `com.glassdoorsstudio.burgonomics.partner` |
| **Primary Category** | Food & Drink (Food Delivery) | Business (Operations / POS) |
| **Content Rating** | 4+ (Apple) / Everyone (Google Play) | 4+ (Apple) / Everyone (Google Play) |
| **Default Language** | English (en-US / en-IN) | English (en-US / en-IN) |
| **Support URL** | `https://burgonomics.com/support` | `https://burgonomics.com/partner/support` |
| **Privacy Policy URL** | `https://burgonomics.com/privacy` | `https://burgonomics.com/privacy` |
| **Terms of Service URL** | `https://burgonomics.com/terms` | `https://burgonomics.com/terms` |

---

## 🔐 2. App Reviewer Demo Credentials (Mandatory for Store Approval)

> [!IMPORTANT]
> Both Apple and Google review teams are located internationally. Provide these exact credentials in the **App Review Information / Sign-in required** section of App Store Connect & Google Play Console to ensure immediate approval without SMS delays.

### Customer App Reviewer Login
- **Authentication Method**: Phone Number OTP
- **Phone Number**: `+91 99999 99999` (or `9999999999`)
- **Fixed Verification Code / OTP**: `123456`
- **Reviewer Instructions**:
  > "Please log in using the test phone number and OTP above. A sandbox delivery address and test branch ('Ahmedabad Central') will be pre-selected. Placing an order triggers our automated sandbox checkout where payment completes instantly and transitions to live order tracking."

### Partner App Reviewer Login
- **Authentication Method**: Email & Password
- **Email**: `reviewer@burgonomics.com`
- **Password**: `Burgonomics@2026`
- **Assigned Role**: `branch_owner` (Demo Branch)
- **Reviewer Instructions**:
  > "Burgonomics Partner is an internal operations management application for authorized franchise store managers and kitchen staff. Log in with the credentials above to test live Kitchen Order Tickets (KDS), menu item 86ing, ticket management, and analytics."

---

## 📝 3. Store Listing Metadata & Copy

### A. Customer App (`BURGONOMICS`)
- **Short Description (Google Play - 80 chars max)**:
  `Order 100% Pure Veg Gourmet Burgers, Combos & Shakes with live order tracking!`
- **Promotional Text (App Store - 170 chars max)**:
  `Crave-worthy 100% Pure Veg gourmet burgers crafted with artisanal buns and bold house sauces. 1-tap quick add, 3-way fulfillment & real-time kitchen tracking.`
- **Keywords (App Store - 100 chars max, comma-separated)**:
  `burgers,veg burger,gourmet burger,pure veg,food delivery,fast food,takeaway,dine in,burgonomics`
- **Full Description (Google Play & App Store)**:
  ```markdown
  Welcome to BURGONOMICS — The House of DAMN GOOD 100% Pure Veg Burgers!

  Crafted for true burger enthusiasts, Burgonomics redefines the fast-casual dining experience with gourmet vegetarian patties, freshly baked artisanal brioche buns, melted artisanal cheeses, and signature house-made sauces.

  Why You'll Love Burgonomics:
  • 100% Pure Veg Kitchens: Zero cross-contamination. Prepared with pride and uncompromising hygiene.
  • 3-Way Fulfillment: Choose Delivery to your doorstep, Quick Takeaway, or Contactless Dine-In.
  • 1-Tap Quick Add: Customize your burgers with extra cheese, jalapenos, patties, or meal combos in seconds.
  • Live Kitchen Tracking: Watch your burger progress from grill preparation to delivery dispatch.
  • Global Grill Coins: Earn loyalty coins on every bite and redeem them for free sides and drinks.
  • Secure & Fast Payments: Pay effortlessly with UPI, Credit/Debit Cards, Netbanking, or Cash on Delivery.

  Download BURGONOMICS today and taste the pure veg gourmet revolution!
  ```

---

### B. Partner App (`Burgonomics Partner`)
- **Short Description (Google Play - 80 chars max)**:
  `Franchise operations, live KDS kitchen display, POS billing & Porter dispatch.`
- **Promotional Text (App Store - 170 chars max)**:
  `Complete store operations app for Burgonomics franchise partners. Live KOT audio alerts, fast POS billing, menu item toggling, and logistics dispatch.`
- **Keywords (App Store - 100 chars max, comma-separated)**:
  `pos,kds,kitchen display,restaurant pos,order management,kot,burgonomics,franchise pos`
- **Full Description (Google Play & App Store)**:
  ```markdown
  Burgonomics Partner is the unified franchise operations and kitchen management platform for Burgonomics restaurants.

  Built for fast-paced QSR environments, Burgonomics Partner empowers store operators and kitchen chefs to streamline orders, manage menus, and monitor real-time sales.

  Core Features:
  • Live Kitchen Display (KDS): Real-time KOT tickets with loud audio alerts, prep timer badges, and 1-tap state transitions (Prep -> Ready -> Dispatched).
  • POS Billing & Counter Orders: Fast walk-in and takeaway billing with instant thermal receipt generation.
  • Instant Menu 86ing: Mark ingredients or items out-of-stock instantly across all customer ordering channels.
  • Porter Logistics Dispatch: 1-tap manual driver request and rider live tracking.
  • Unified Support Ticketing: 3-tier escalation desk for resolving customer queries and branch issues.
  • Executive Analytics: Monitor hourly sales, top-performing burgers, average ticket size, and revenue breakdown.

  Authorized access only. Account credentials provided by Burgonomics Brand Management.
  ```

---

## 🛡️ 4. Google Play Data Safety & Apple Privacy Questionnaire

### Google Play Data Safety Form Responses
| Data Type | Collected? | Shared? | Purpose | Ephemeral / Optional? |
|---|---|---|---|---|
| **Approximate Location** | Yes | Yes (Porter Delivery) | Delivery address detection & nearest branch routing | Required |
| **Precise Location** | Yes | Yes (Porter Delivery) | Pinpoint doorstep delivery drop-off | Optional (User can enter manual address) |
| **Name** | Yes | No | Account profile & order receipts | Required |
| **Phone Number** | Yes | Yes (Delivery Rider) | Phone OTP login & order contact | Required |
| **Address** | Yes | Yes (Porter Delivery) | Delivery fulfillment | Required for delivery |
| **Purchase History** | Yes | No | Order tracking, loyalty coins & history | Required |
| **Photos & Videos** | Yes | No | Customer avatar & support ticket attachments | Optional |
| **Crash Logs & Performance** | Yes | No | Firebase Crashlytics & performance monitoring | Ephemeral |
| **Device Identifiers** | Yes | No | FCM Push Notification routing | Ephemeral |

- **Data Encryption in Transit**: Yes (HTTPS / TLS 1.3 enforced).
- **Account Deletion Mechanism**: Yes (In-app `Delete Account` button in Profile > Settings, plus web request URL).

---

### Apple App Privacy Nutrition Labels
- **Data Used to Track You**: **None** (Burgonomics does NOT track users across third-party apps).
- **Data Linked to You**:
  - `Contact Info` (Name, Phone Number, Physical Address) — App Functionality.
  - `Financial Info` (Payment History) — App Functionality.
  - `Location` (Coarse & Precise Location) — App Functionality / Order Delivery.
  - `User Content` (Customer Support photos) — Customer Support.
  - `Identifiers` (User ID, Device ID) — App Functionality & Push Notifications.
  - `Usage Data` (Product Interaction) — Analytics & App Optimization.

---

## 📦 5. Native Release Compilation & Build Commands

### Step 1: Android Release App Bundle (`.aab`) Compilation (Windows / Mac)
```bash
# 1. Build Customer App
cd burgonomics-foundation-core
npm run build:mobile
npx cap sync android

# Open in Android Studio or compile via CLI:
cd android
./gradlew bundleRelease

# 2. Build Partner App
cd ../../burgonomics-partner
npm run build:mobile
npx cap sync android

cd android
./gradlew bundleRelease
```
*Outputs located at: `android/app/build/outputs/bundle/release/app-release.aab`*

---

### Step 2: iOS Distribution Archive (`.ipa`) Compilation (Mac with Xcode)
```bash
# 1. Customer App (Run in Terminal on Mac):
cd burgonomics-foundation-core
chmod +x mac-build.sh
./mac-build.sh

# 2. Partner App (Run in Terminal on Mac):
cd burgonomics-partner
chmod +x mac-build.sh
./mac-build.sh
```
*In Xcode: Select **Any iOS Device (arm64)** -> Click **Product** -> **Archive** -> **Distribute App** -> **App Store Connect / TestFlight**.*

---

## 🚀 6. 15-Day Submission Checklist & Sign-Off

- [x] iOS Native projects generated for both Customer and Partner apps.
- [x] Reviewer Sandbox mode configured for zero-error store approval.
- [x] Store App Icons (1024x1024) and Feature Graphics (1024x500) generated.
- [x] App Privacy, Data Safety, and Reviewer copy prepared.
- [x] Mac automated build scripts created and verified.
