# BURGONOMICS — Store Submission & Launch Checklist

**Target**: Google Play Store & Apple App Store Launch  
**Live Firebase Backend**: `https://api-jgxunirgwq-el.a.run.app` (`asia-south1`)  
**Compiled Release Date**: 2026-10-11  

---

## 📁 1. Release Files Directory (`client-handover/`)

All required binaries, store graphics, and screenshots are organized:

```
client-handover/
├── release-builds/
│   ├── burgonomics-customer-release.aab   (20.89 MB) -> Upload to Google Play Console (Customer App)
│   ├── burgonomics-partner-release.aab    (26.43 MB) -> Upload to Google Play Console (Partner App)
│   ├── burgonomics-customer-release.apk   (21.32 MB) -> Direct installable APK for internal device testing
│   └── burgonomics-partner-release.apk    (26.85 MB) -> Direct installable APK for internal POS testing
├── store-assets/
│   ├── customer-icon-1024x1024.png        -> Google Play App Icon (Customer)
│   ├── partner-icon-1024x1024.png         -> Google Play App Icon (Partner)
│   ├── customer-feature-graphic-1024x500.png -> Google Play Feature Graphic (Customer)
│   └── partner-feature-graphic-1024x500.png  -> Google Play Feature Graphic (Partner)
└── screens/
    ├── 01-customer-app-new/               -> 29 high-res phone screenshots (Customer App)
    └── 02-partner-app-new/                -> 22 high-res phone screenshots (Partner App)
```

---

## 🌐 2. Webhook URLs to Register in Partner Portals

Register these URLs in your third-party developer consoles to receive live updates:

| Provider | Portal Setting | Live Deployed Webhook URL | Subscribed Events |
| :--- | :--- | :--- | :--- |
| **Petpooja POS** | Webhook / Callback URL | `https://api-jgxunirgwq-el.a.run.app/petpooja/webhook` | Order status changes, Out-of-Stock (86ing) updates |
| **Petpooja POS** | Menu Sync Endpoint | `https://api-jgxunirgwq-el.a.run.app/petpooja/menu-sync` | Menu catalog updates |
| **Razorpay** | Webhook URL | `https://api-jgxunirgwq-el.a.run.app/payments/webhook` | `payment.captured`, `payment.failed`, `refund.processed`, `transfer.processed` |
| **Porter Logistics** | Webhook Callback URL | `https://api-jgxunirgwq-el.a.run.app/dispatch/webhook/porter` | Order status transitions (rider assigned, arrived, picked up, delivered) |
| **Borzo Logistics** | Webhook Callback URL | `https://api-jgxunirgwq-el.a.run.app/dispatch/webhook/borzo` | Delivery updates |
| **Shadowfax** | Webhook Callback URL | `https://api-jgxunirgwq-el.a.run.app/dispatch/webhook/shadowfax` | Rider telemetry and tracking updates |

---

## 🤖 3. Google Play Console Submission Steps

> [!WARNING]
> Turn off TOR / VPN IP rotators before logging into Google Play Console to prevent automated fraud locks.

### Step 3.1: Customer App (`com.burgonomics`)
1. Log into [Google Play Console](https://play.google.com/console).
2. Create App:
   - **App name**: `BURGONOMICS`
   - **Default language**: `English (United States)` or `English (India)`
   - **App or game**: `App`
   - **Free or paid**: `Free`
3. Under **App Content**:
   - **Privacy Policy**: `https://burgonomics.com/privacy`
   - **App Access / Reviewer Credentials**: Select "All or some functionality is restricted" -> Add credentials:
     - Phone: `+91 99999 99999`
     - OTP: `123456`
     - Instructions: "Login with test phone and OTP. Ahmedabad test branch and sandbox address are pre-selected. Checkout executes instant sandbox payment."
   - **Data Safety**: Consult Section 4 of `STORE_SUBMISSION_GUIDE.md` (Location, Name, Phone, Address, Purchase history collected for order fulfillment).
4. Under **Main Store Listing**:
   - **Short description**: `Order 100% Pure Veg Gourmet Burgers, Combos & Shakes with live order tracking!`
   - **Full description**: Paste full description from Section 3.A of `STORE_SUBMISSION_GUIDE.md`.
   - **App Icon**: Upload `client-handover/store-assets/customer-icon-1024x1024.png`.
   - **Feature Graphic**: Upload `client-handover/store-assets/customer-feature-graphic-1024x500.png`.
   - **Phone Screenshots**: Upload screenshots from `client-handover/screens/01-customer-app-new/` (Upload at least 4: `02-home.png`, `05-menu.png`, `08-cart.png`, `14-order-tracking.png`).
5. Under **Releases**:
   - Create release in **Production** (or Closed Testing).
   - Upload `client-handover/release-builds/burgonomics-customer-release.aab`.
   - Review and rollout.

### Step 3.2: Partner POS App (`com.burgonomics.partner`)
1. Create App:
   - **App name**: `Burgonomics Partner`
   - **Default language**: `English (India)`
   - **Category**: `Business`
2. Under **App Content**:
   - **Privacy Policy**: `https://burgonomics.com/privacy`
   - **App Access / Reviewer Credentials**:
     - Email: `reviewer@burgonomics.com`
     - Password: `Burgonomics@2026`
     - Instructions: "Internal operations app for store managers. Login to test live KDS Kitchen Order Tickets, item 86ing, ticket management, and analytics."
3. Under **Main Store Listing**:
   - **Short description**: `Franchise operations, live KDS kitchen display, POS billing & Porter dispatch.`
   - **Full description**: Paste full description from Section 3.B of `STORE_SUBMISSION_GUIDE.md`.
   - **App Icon**: Upload `client-handover/store-assets/partner-icon-1024x1024.png`.
   - **Feature Graphic**: Upload `client-handover/store-assets/partner-feature-graphic-1024x500.png`.
   - **Phone Screenshots**: Upload screenshots from `client-handover/screens/02-partner-app-new/` (e.g. `02-dashboard.png`, `03-orders.png`, `05-delivery-queue.png`, `06-kds.png`).
4. Under **Releases**:
   - Upload `client-handover/release-builds/burgonomics-partner-release.aab`.
   - Review and rollout.

---

## 🍎 4. Apple App Store Submission Steps (Mac / Xcode)

1. Connect to Mac machine.
2. In `burgonomics-foundation-core/`:
   ```bash
   chmod +x mac-build.sh
   ./mac-build.sh
   ```
3. In `burgonomics-partner/`:
   ```bash
   chmod +x mac-build.sh
   ./mac-build.sh
   ```
4. In Xcode:
   - Target **Any iOS Device (arm64)** -> **Product** -> **Archive** -> **Distribute App** -> **App Store Connect**.
5. In [App Store Connect](https://appstoreconnect.apple.com):
   - Fill in Privacy Nutrition Labels (from Section 4 of `STORE_SUBMISSION_GUIDE.md`).
   - Add Reviewer Credentials (Customer: `+91 99999 99999` / `123456`, Partner: `reviewer@burgonomics.com` / `Burgonomics@2026`).
   - Submit for Review.
