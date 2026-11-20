# BURGONOMICS — Store Submission & Launch Checklist

**Target**: Google Play Store & Apple App Store Launch  
**Live Firebase Backend**: `https://api-jgxunirgwq-el.a.run.app` (`asia-south1`)  
**Compiled Release Date**: 2026-10-11  

---

## 🚫 0. Legal facts — BLOCKING (do not submit either app while any item is open)

Apple and Google both require a **live privacy-policy URL**, and Indian law requires a refund/cancellation
policy, a named grievance contact and the FSSAI licence of the kitchen that cooks the food. The Customer app
now carries all four documents and publishes them at stable public URLs on **its own hosting** (not
`burgonomics.com`, which is out of scope for this wave):

| Public URL (append to the Customer app hosting base) | Document | In-app route |
|---|---|---|
| `/legal/privacy` | Privacy Policy | `/privacy` |
| `/legal/terms` | Terms of Use | `/terms` |
| `/legal/refund-policy` | Refund & Cancellation Policy | `/refund-policy` |
| `/legal/grievance` | Grievance Redressal | `/grievance` |
| `/legal/` | index of the four | — |

Hosting base today (staging, target `burgonomics-app` → site `burgonomics-7faa8`):
`https://burgonomics-7faa8.web.app` → e.g. `https://burgonomics-7faa8.web.app/legal/privacy`.
Production (`burgonomics-prod`) uses the same paths once its hosting target is deployed; the release
worker confirms the prod URL before it fills a store form.

### 0.1 Missing facts — each renders as a visible `[TO BE SUPPLIED: …]` mark

The pages **say on screen** that they are not publishable while these are open, and a store reviewer
reads that banner. **All four must be supplied before submission.**

- [ ] **F1. FSSAI licence number for each outlet.** One number per outlet, not per brand. The app's
      `fssaiLicense` constant is still the masked `1072XXXXXXXXXX`, which is why the pages mark it
      instead of printing a fake number. Owner: Burgonomics team.
- [ ] **F2. Grievance Officer — full name.** A named individual, not a job title. The previous pages
      printed "Manager — Legal", which the DPDP Act 2023 and the IT Rules 2021 do not accept.
      Owner: owner.
- [ ] **F3. Grievance Officer — phone number.** A complaint must not depend on an inbox staying alive.
      Owner: owner.
- [ ] **F4. CIN — or a written statement that none applies.** The GST registration names a partnership,
      so no CIN may apply, but nothing on record confirms that in writing and the constant is empty.
      Owner: owner.

### 0.2 Printed but never verified — no mark on the page, so a wrong value would be silent

- [ ] **C1. Registered address.** Printed as
      `A-802, Unicus Shyamal, Shyamal Cross Road, Satellite, Ahmedabad, Gujarat 380015`.
      Older handover notes describe a different address (a studio name), so this must be confirmed
      against the registration certificate. Owner: owner.
- [ ] **C2. GSTIN.** Printed as `24ABHFP6677N1ZG` on receipts and legal pages. Handover notes still
      describe the field as masked, so a wrong value is a false tax disclosure on every invoice.
      Owner: owner.
- [ ] **C3. Grievance / privacy mailboxes.** Printed as `privacy@burgonomics.com` and
      `nodal@burgonomics.com`. No evidence exists that either mailbox has been created. A DPDP erasure
      request that bounces is the exact failure the Act penalises. Owner: Burgonomics team.

### 0.3 How to check the state, and what "done" looks like

```bash
cd burgonomics-foundation-core
npm run legal:facts -- --check    # the owner list is in step with the page content
npm run legal:html                # regenerate the published HTML
npm test -- tests/legal-pages.test.ts
```

Done means: zero `[TO BE SUPPLIED:` marks on all four pages, the banner is gone, and
`burgonomics-foundation-core/LEGAL-FACTS-NEEDED.md` lists nothing open. **Until then the answer to
"can we submit?" is no** — not because of engineering, but because a page that promises a grievance
officer who does not exist is worse than a delayed launch.

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
| **Porter Logistics** | Webhook Callback URL | `https://api-jgxunirgwq-el.a.run.app/porter/webhook` | Order status transitions (rider assigned, arrived, picked up, delivered) |
| **Borzo Logistics** | Webhook Callback URL | `https://api-jgxunirgwq-el.a.run.app/dispatch/webhooks/borzo` | Delivery updates — **contract-gated**: do not register until the Borzo contract is confirmed |
| **Shadowfax** | Webhook Callback URL | `https://api-jgxunirgwq-el.a.run.app/dispatch/webhooks/shadowfax` | Rider telemetry — **contract-gated**: requires `SHADOWFAX_CONTRACT_VERIFIED` and vendor confirmation first |

> Paths above are the deployed Cloud Run forms. Behind the Cloud Functions host the same routes sit under the function name (`...cloudfunctions.net/api/petpooja/webhook`, etc.). Route spellings verified against the current `functions/src/index.ts` route table on 2026-10-20; the earlier `/dispatch/webhook/<provider>` spelling was wrong and has been corrected.

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
   - **Privacy Policy**: `<production hosting base>/legal/privacy` — see §0; never `burgonomics.com`.
   - **App Access / Reviewer Credentials**: Select "All or some functionality is restricted" and add the
     credentials from the secure store (never from this file):
     - Phone: `<from secure store>`
     - OTP: `<fixed code from secure store>`
     - Instructions: "Enter the phone number above and tap Continue, then the fixed code above; no SMS is
       sent. This build uses our rehearsal environment, so outlet and menu data may be limited. Payments run
       in the provider's test mode and no money moves."
   - **Data Safety**: Consult Section 4 of `STORE_SUBMISSION_GUIDE.md` (Location, Name, Phone, Address, Purchase history collected for order fulfillment).
4. Under **Main Store Listing**:
   - **Short description**: `Order pure-veg burgers from your nearest Burgonomics branch.`
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
   - **Privacy Policy**: `<production hosting base>/legal/privacy` — see §0; never `burgonomics.com`.
   - **App Access / Reviewer Credentials**:
     - Email: `<from secure store>`
     - Password: `<from secure store>`
     - Instructions: "Internal operations app for store managers. Sign in with the email and password above
       to open the kitchen display, change item availability, and view tickets and reports."
3. Under **Main Store Listing**:
   - **Short description**: `Order console for Burgonomics branches: kitchen tickets, dispatch, refunds.`
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
   - Add Reviewer Credentials from the secure store (customer phone number + fixed code, partner email +
     password). Nothing is written in this repository.
   - Submit for Review.
