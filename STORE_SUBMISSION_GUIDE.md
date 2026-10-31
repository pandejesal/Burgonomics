# BURGONOMICS — Master Store Submission & Review Package

> **Authoritative submission metadata, compliance declarations, review credentials, and build instructions for Apple App Store & Google Play Store.**

---

## 📱 1. Application Identifiers & Architecture

| Parameter | Customer App | Partner POS & Operations App |
|---|---|---|
| **App Name** | `BURGONOMICS` | `Burgonomics Partner` |
| **Subtitle (iOS)** | `100% Pure Veg Gourmet Burgers` | `Kitchen Display, POS & Ops` |
| **Package / Bundle ID** | `com.burgonomics` | `com.burgonomics.partner` |
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
> **Corrected 2026-10-08** after code-ground-truth audit (Phase 3 SME): dropped phantom Crashlytics row (no such SDK installed), widened shared parties to actual processors, declared email + DOB/gender (previously undeclared), fixed non-ephemeral identifiers. Customer-app listing; partner-app listing gets its own form at submission time (staff email/name/account data).

| Data Type | Collected? | Shared? | Purpose | Ephemeral / Optional? |
|---|---|---|---|---|
| **Approximate Location** | Yes | Yes (courier: Porter/Borzo/Shadowfax) | Delivery address detection & nearest branch routing | Required |
| **Precise Location** | Yes | Yes (courier: Porter/Borzo/Shadowfax) | Pinpoint doorstep delivery drop-off | Optional (User can enter manual address) |
| **Name** | Yes | Yes (Petpooja POS + couriers, in order payload only) | Account profile & order receipts | Required |
| **Email** | Yes | No | Account profile / partner-staff login | Optional (customer) / Required (partner staff) |
| **Phone Number** | Yes | Yes (courier rider + Petpooja order payload) | Phone OTP login & order contact | Required |
| **Address** | Yes | Yes (couriers + Petpooja order payload) | Delivery fulfillment | Required for delivery |
| **Purchase History** | Yes | No | Order tracking, loyalty coins & history | Required |
| **Photos & Videos** | Yes | No | Customer avatar & support ticket attachments (≤3) | Optional |
| **Date of Birth, Gender** | Yes | No | Account profile (user-entered) | Optional |
| **Device / App Identifiers** | Yes | No | FCM push routing + Google App Check (Play Integrity) fraud prevention | Persistent while signed in (NOT ephemeral) |
| **Payment identifiers** | Yes | Yes (Razorpay — processed in hosted checkout) | Order/payment reconciliation (no card/UPI data stored) | Required |

- **Crash Logs / Analytics**: **NOT collected** — neither app ships Crashlytics or any analytics SDK (verified in both `package.json`s); do not declare on the form.
- **Data Encryption in Transit**: Yes (HTTPS / TLS 1.3 enforced).
- **Account Deletion Mechanism**: Yes (In-app `Delete Account` button in Profile > Settings, plus web request URL).
- **Third-party processors (privacy-page parity)**: Google/Firebase, Razorpay, Petpooja, Porter, Borzo, Shadowfax.

---

### Apple App Privacy Nutrition Labels
- **Data Used to Track You**: **None** (Burgonomics does NOT track users across third-party apps; no advertising SDKs).
- **Data Linked to You**:
  - `Contact Info` (Name, Phone Number, Email Address, Physical Address) — App Functionality.
  - `Financial Info` (Payment History / Razorpay order identifiers) — App Functionality.
  - `Location` (Coarse & Precise Location) — App Functionality / Order Delivery.
  - `User Content` (Customer Support messages & photos) — Customer Support.
  - `Other User Data` (Date of Birth, Gender) — App Functionality.
  - `Identifiers` (User ID, FCM token, App Check token) — App Functionality & Push Notifications / Fraud prevention.
  - `Product Interaction` (Cart, favorites) — App Functionality (local + Firestore sync; NO analytics SDK).

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

---

## 🔨 7. Phase 1 Execution Log — Identity & Signing (2026-10-07)

> Owner: store-submission readiness agent. **STATUS: GATE PASSED.** UI files untouched (domain split).

### 7.1 Bundle-ID rename → `com.burgonomics.*`
- **Customer app**: `com.glassdoorsstudio.burgonomics` → **`com.burgonomics`**
- **Partner app**: `com.glassdoorsstudio.burgonomics.partner` → **`com.burgonomics.partner`**
- 22 source files edited across both apps: `capacitor.config.ts`, `android/app/build.gradle` (namespace + applicationId), `proguard-rules.pro`, `res/values/strings.xml`, `google-services.json`, `project.pbxproj`, `Info.plist`, `capacitor.config.json`, `apple-app-site-association` (source + iOS/Android asset copies), `assetlinks.json`, `README.md`, `scripts/smoke.{sh,mjs}`
- `MainActivity.java` package declarations rewritten **and files moved** to `com/burgonomics/…`; old `com/glassdoorsstudio/…` package directories removed
- `GLASSDOORS.` team placeholder in AASA → `TEAMID.` (real Team ID pending Apple enrollment)
- `src/` + `tests/` confirmed **zero** old-ID occurrences (no UI/zone files touched — reported, not edited)
- Old IDs remain only in regenerated artifacts (`android/**/build/`, stale `dist/`) — refreshed by the verified builds below

### 7.2 Android signing (both apps)
- Old `release.keystore` passwords **unrecoverable** (repo holds no password; 6 candidates rejected) → archived as `android/release.keystore.old-20261007` (never deleted)
- Fresh keystores generated: RSA-2048, SHA384, validity 10000 days, alias `burgonomics`, CN=Burgonomics (no third-party names)
- Passwords live in `android/key.properties` (**gitignored** in both repos — `.gitignore += key.properties`)
- `signingConfigs.release` rewritten with precedence: **CI env vars → `android/key.properties` → debug fallback** (previously: env-only, silently debug-signed locally)

### 7.3 GitHub Actions secrets (5 × 2 repos, verified listed)
`RELEASE_KEYSTORE_BASE64`, `RELEASE_STORE_PASSWORD`, `RELEASE_KEY_PASSWORD`, `RELEASE_KEY_ALIAS`, `RELEASE_STORE_FILE`
- `pandejesal/Burgonomics-Partner` ✅ · `pandejesal/Burgonomics-App` ✅

### 7.4 Verification (all green)
| Check | Partner | Customer |
|---|---|---|
| `npm run typecheck` / `npx tsc --noEmit` | ✅ RC=0 | ✅ RC=0 |
| `npm run build` (vite) | ✅ RC=0 (58s) | ✅ RC=0 (79s) |
| `gradlew assembleDebug` | ✅ BUILD SUCCESSFUL | ✅ BUILD SUCCESSFUL |
| Packaged `applicationId` | `com.burgonomics.partner` ✅ | `com.burgonomics` ✅ |
| Old-ID sweep (source, `-uu`) | ✅ clean | ✅ clean |

### 7.5 Carried to Phase 2
- Register **new** Android apps in Firebase project `burgonomics-7faa8` (`com.burgonomics`, `com.burgonomics.partner`) and re-download `google-services.json` — current files were re-keyed locally; FCM/App Check need server-side registration ✅ *(done in Phase 2, §8.3)*
- iOS bundle IDs renamed in `project.pbxproj`/`Info.plist`; Apple Team ID + signing certs blocked on developer-account registration (Phase 0)

## 🔌 8. Phase 2 Execution Log — Integrations & Secrets (2026-10-07)

> Owner: store-submission readiness agent. **STATUS: CODE+GATES GREEN — E2E PROOF PENDING on user credentials.** UI files untouched (domain split). Workflow: ANALYZE → SME ×3 (secrets / client-flags+mapping / E2E-path) → COLLATE → CODE → QA_REVIEW (APPROVED ×2) → TEST (PASS ×2).

### 8.1 Secrets & server env (`functions/.env`, gitignored)
- **`OTP_HMAC_SECRET` generated** — fresh 32-byte CSPRNG, 64-char lowercase hex, byte-level splice (file line-ending profile preserved). Unblocks OTP verify + payment `deliveryOtpHash` (was fail-closed HTTP 500).
- **`BURGONOMICS_ENV` stays `dev`** — production boot asserts ~7 required secrets (`config/env.ts:125-135`); flip to `production` only after §8.6 blockers are filled.
- **BLOCKED on user input (still empty):**
  | Key | Consequence while empty |
  |---|---|
  | `PETPOOJA_APP_KEY` / `PETPOOJA_APP_SECRET` / `PETPOOJA_ACCESS_TOKEN` | save_order 401 — E2E proof impossible (lines carry `# TODO: Get from Petpooja panel (sandbox)` — the trio was never pasted; sandbox *login* + mapping code `31z58ciw0h` ARE present) |
  | `RAZORPAY_WEBHOOK_SECRET` | webhook 401 deny — payments fail closed |
  | `PORTER_API_KEY` (+ `PORTER_CUSTOMER_ID`, `PORTER_WEBHOOK_SECRET`) | dispatch degrade |
  | `VITE_FCM_VAPID_KEY` (partner `.env`) | web-push only — Android device FCM does **not** need it |

### 8.2 Client integration flags (both apps' `.env`, gitignored)
- Partner: `VITE_PETPOOJA_ENABLED=true`, `VITE_FCM_ENABLED=true` (were `false`); `VITE_FCM_VAPID_KEY` intentionally left empty (§8.1).
- Customer: file had **no** flag entries — added `VITE_PETPOOJA_ENABLED=true` + `VITE_PUSH_ENABLED=true` (customer has no FCM flag; sole push gate is `VITE_PUSH_ENABLED`, `core/config/env.ts:86`).
- Flag flips are **build-time**: gates below prove the flag-gated chunks compile & emit (Petpooja admin pages, push/firebase chunks).

### 8.3 Firebase Android registration (server-side) ✅
- Pre-state: project `burgonomics-7faa8` had **only a WEB app** — no Android apps at all (Phase 1 files were re-keyed locally).
- Created via CLI (logged in `pandejesal@gmail.com`): `com.burgonomics.partner` → appId `1:738930066637:android:18c3ed5fef4e83eadf9584`; `com.burgonomics` → `1:738930066637:android:0830b80479da19f3df9584`.
- Genuine `google-services.json` downloaded (`apps:sdkconfig`) into both `android/app/`; old files backed up as `google-services.json.pre-phase2`. Both configs are now project-level (2 Android clients each, byte-identical, 48 lines); plugin matches by `package_name`.
- No old-package (`com.glassdoors*`/`erowan*`) Firebase apps existed → nothing to delete.
- FCM + App Check (Play Integrity) now have real server-side app records for the new IDs.

### 8.4 SME findings shaping the E2E proof
- **`PETPOOJA_SANDBOX_MAPPING_CODE` is dead config** — read by no code. Real branch→restID mapping = Firestore `branches/{id}.petpoojaStoreId` (fail-closed 503 if unset) mirrored at `stores/{id}.petpoojaRestId`; payload `restID` filled at `functions/src/modules/petpooja/orderPush.ts` (customer order push + partner POS converge here).
- Customer order flow while Petpooja flag off: order **persists**, `petpoojaStatus:"Failed"` (`ordersService.ts:242-251`) — not an order-loss bug.
- No script anywhere hits the real sandbox; shortest proof = direct POST (`references/petpooja_save_order_api.md:119-125`).
- Local run: `firebase emulators:start` — functions 5001 / firestore 8085 / auth 9099 / UI 4000; `functions/.env` loads at runtime; no host gating on Petpooja client; App Check monitor mode (`APP_CHECK_ENFORCEMENT=false`) so curl/device calls aren't blocked.
- Deploy: `npm --prefix functions run deploy` (`firebase deploy --only functions`); with `BURGONOMICS_ENV=dev` empty optional secrets don't block deploy/boot.

### 8.5 Verification (all green)
| Gate | Result |
|---|---|
| partner `typecheck` / `build` | ✅ RC=0 / RC=0 |
| customer `tsc --noEmit` / `build` | ✅ RC=0 / RC=0 |
| functions `tsc` build | ✅ RC=0 |
| functions `vitest` | ✅ 331 passed, 2 skipped |
| partner `gradlew assembleDebug` w/ new google-services.json | ✅ 7m21s, `processDebugGoogleServices` clean |
| customer `gradlew assembleDebug` w/ new google-services.json | ✅ 1m53s, `processDebugGoogleServices` clean |
| QA review (flags/secrets task) | ✅ APPROVED (5/5) |
| QA review (Firebase registration task) | ✅ APPROVED (5/5) |

### 8.6 Carried forward (Phase 2 remainder → Phase 3)
- **E2E proof sequence** (pending trio creds): direct-POST probe → functions+firestore+auth emulators → seed `branches/{id}.petpoojaStoreId` → auth-emulator ID token → `POST /petpooja/pushOrder` → then live deploy + live proof → evidence JSON at `references/verification/*-petpooja-save-order.json` (`{generatedAt, verdict, …}` convention).
- Android SDK: `emulator` + `system-images;android-34;google_apis;x86_64` install in progress (sdkmanager requires `JAVA_HOME=Android Studio\jbr` — system Java 8 fails with UnsupportedClassVersionError).
- Blocked-on-user: Petpooja trio, `RAZORPAY_WEBHOOK_SECRET`, Porter triple (see §8.1) — E2E + `BURGONOMICS_ENV=production` flip wait on these.

## 🌐 9. Phase 3 Execution Log — Legal/Support URLs (2026-10-08)

> Owner: store-submission readiness agent. **STATUS: DEPLOYED & LIVE on `burgonomics-site.web.app` — custom-domain attach is the only remaining user click.** Workflow: ANALYZE → SME ×2 (deploy-path / content-inventory) → COLLATE → CODE → QA_REVIEW (APPROVED 7/7) → TEST (PHASE3-GATES: PASS).

### 9.1 Hosting architecture discovered (answer to "wasn't it Firebase?")
- **Firebase Hosting was already the configured path**: `firebase.json` targets `burgonomics-app` → customer `dist/mobile` (site `burgonomics-7faa8` → burgonomics-7faa8.web.app) and `burgonomics-partner` → partner `dist` (site `burgonomics-partner.web.app`). Both pre-existed.
- `burgonomics.com` itself was **never attached to Firebase** — it resolves (NS1 DNS: `dns*.p06.nsone.net`) to an **old hand-written MPA on Netlify** whose source exists nowhere findable (not in any of the 21 GitHub repos, not on Desktop, no Netlify CLI login). Its `/privacy|/terms|/support|/partner/support` = 404 because only `index.html` + `menu.html` physically exist (Netlify extensionless→.html serving; no SPA fallback).
- React marketing repo `pandejesal/burgonomics-website` also deploys to **Vercel** (`burgonomics-website.vercel.app`, team safe-sponsor-ai, no custom domains) — kept as secondary; pushed commits auto-sync it.

### 9.2 Shipped (commits `79066c5` + `ced540f` on `main`, pushed)
- 4 routes added to React SPA: `/privacy`, `/terms`, `/support`, `/partner/support` (`src/components/Legal/{Privacy,Terms,Support}.jsx` + CSS); footer dead `#privacy`/`#terms` anchors → router `<Link>` (+ Support link).
- Content: Burgonomics Foods Pvt Ltd, 4 contact emails, effective Oct 7 2026, code-grounded data inventory (matches corrected §4), processors list (Google/Firebase, Razorpay, Petpooja, Porter/Borzo/Shadowfax), deletion path, rights; Terms 13-section; Support channels + FAQ. **Zero** forbidden strings (Glassdoors/erowan/Netlify/Slack/creds) — swept source + dist + live.
- `index.html`: title `finale` → `Burgonomics | The Smart Choice` + description + theme-color.
- New `firebase.json` (site `burgonomics-site`, SPA rewrite, cache/security headers) + `.firebaserc` in the website repo — workspace `firebase.json` untouched.

### 9.3 Verification (all green)
| Check | Result |
|---|---|
| `npm run build` / `npm run lint` | ✅ RC=0 / RC=0 (3 pre-existing warnings) |
| Local preview `/`+4 routes | ✅ 5×200 |
| Forbidden strings (source, dist, live HTML+JS) | ✅ 0 hits |
| QA review (7 dimensions incl. workspace-config boundary) | ✅ APPROVED |
| Firebase hosting site create + deploy | ✅ RC=0, 294 files, release complete |
| **Live `https://burgonomics-site.web.app/{,privacy,terms,support,partner/support}`** | ✅ **5×200**, content verified in served JS |
| Existing app sites (`burgonomics-7faa8`, `burgonomics-partner`) | ✅ unchanged |

### 9.4 Remaining for user (Phase 3 close-out)
1. **Firebase console → Hosting → `burgonomics-site` → Custom domains → add `burgonomics.com` (+`www`)** — console shows the exact DNS records for the NS1 zone; once verified, `https://burgonomics.com/privacy|/terms|/support|/partner/support` all go live (the old Netlify MPA stops serving the domain).
2. Then re-run the URL sweep as final evidence.

### 9.5 Carried forward
- **Phase 2 E2E save_order proof**: still blocked on Petpooja trio (user: "coming later"); direct-POST probe → emulator chain → live deploy sequence ready per §8.6.
- Partner-app Data Safety form (own listing) to fill at submission using §4 table + partner-staff rows.
- Open orchestrator defect (re-flagged): `Glassdoors Studio` in customer `privacy.tsx`/`terms.tsx` + address prefix — those in-app pages must be cleaned before they ship in the customer app build.

## 🚀 10. Phase 4 Execution Log — Release Build Automation (2026-10-09)

> Owner: store-submission readiness agent. **STATUS: local gates ALL GREEN; GitHub push awaiting orchestrator approval (throwaway `release/ci-verify` branch).** Workflow: ANALYZE → SME ×2 (D1 Android CI / D2 iOS readiness) → COLLATE → CODE → QA_REVIEW (REVISION_NEEDED ×1, fixed) → TEST (local PASS).

### 10.1 SME findings (2 of 3 calls used)
- **D1 (Android CI)**: core `android-build.yml` release job generated an **ephemeral throwaway keystore** (DN `GlassdoorsStudio`) and never read `RELEASE_KEYSTORE_BASE64` → any AAB it produced was store-rejectable garbage; both `gradle.properties` hardcode Windows-only `org.gradle.java.home=C:\Program Files\...` (ubuntu landmine — new jobs carry a sed guard); gradle env reads `RELEASE_STORE_FILE/PASSWORD/KEY_ALIAS` + `RELEASE_KEYSTORE_BASE64` — secret names match; partner repo has **zero Actions runs ever** (remote trigger `push: [main]` never matched its default branch).
- **D2 (iOS)**: bundle IDs already `com.burgonomics*` ✓; no `DEVELOPMENT_TEAM` anywhere; core pbxproj forced `Manual + CODE_SIGNING_REQUIRED=NO`; **no Podfile** — SwiftPM (Capacitor 8), so jobs must use `-project App.xcodeproj` (no workspace / no pods); legacy `ios-build.yml` pins Xcode 15.4 and dies at SPM resolve (Capacitor 8 needs Xcode 16 — new jobs use macos-15 default); **no `GoogleService-Info.plist` for iOS** → push blocker until iOS apps are registered in Firebase (bundle IDs known; no Apple account needed for registration).

### 10.2 Shipped (5 files, uncommitted, review-approved after 1 revision)
| File | Change |
|---|---|
| partner `.github/workflows/ci.yml` | + `release-aab` (dispatch-only: web build → cap sync → sed-guard → keystore decode → **fail-closed secret guard** → `bundleRelease` → artifact `partner-release-aab`) + `ios-archive` (macos-15 unsigned `.xcarchive` scaffold) |
| core `.github/workflows/android-build.yml` | ephemeral keystore generation **removed** → `RELEASE_KEYSTORE_BASE64` decode + sed-guard; triggers/artifacts/other steps unchanged |
| core `.github/workflows/ios-build.yml` | + `ios-archive` job (same scaffold); legacy Xcode 15.4 simulator job untouched |
| both `ios/App/App/Info.plist` | + `ITSAppUsesNonExemptEncryption = false` (App Store export-compliance pre-answer) |

### 10.3 Verification (2026-10-09, all green)
| Check | Result |
|---|---|
| actionlint ×3 workflows | ✅ RC=0, zero findings |
| YAML parse ×3 | ✅ OK |
| Forbidden sweep ×5 files (`Glassdoors\|erowan\|Slack\|123456\|Burgonomics@2026`) | ✅ 0 hits |
| QA review | 1 revision (fail-closed guard for partner `release-aab`) → applied + verified in place |
| partner `gradlew bundleRelease` | ✅ BUILD SUCCESSFUL (run with hash-verified temporary cruncher-disable — see 10.4 — `build.gradle` restored byte-exact afterward) |
| core `gradlew bundleRelease` | ✅ AAB 15,464,943 B |
| AAB signer vs release keystore (keytool) | ✅ fingerprints match both apps (`CN=Burgonomics`; partner `25:C9:63:BC…`, core `15:3F:30:0D…`) — no debug / Glassdoors identity |
| Temp-patch leak check | ✅ `cruncherEnabled` absent from `build.gradle`; byte-exact restore |

### 10.4 New defects found (relayed to orchestrator)
1. 🔴 **Corrupt `android/app/src/main/res/drawable/splash.png` (partner, 69 bytes, PIL-unparseable; core's is 14 KB)** — release builds PNG-crunch → reproducible AAPT2 crash at `mergeReleaseResources` → **release AAB cannot build on a clean checkout** until replaced (debug doesn't crunch — why Phase 2 gates passed). UI asset → not mine to replace.
2. 🟠 iOS `GoogleService-Info.plist` absent for both apps — iOS push is dead until iOS apps are registered in Firebase.
3. 🟡 Accepted/known: `burgonomics.netlify.app` in both `WKAppBoundDomains` (pre-existing); legacy core iOS simulator job fails on Xcode 15.4 (out of scope this phase); `|| 'ci_build_keystore_pass'` env fallbacks in core job are pre-existing and fail-closed against the real keystore.

### 10.5 Remaining
- **Awaiting orchestrator go** for throwaway `release/ci-verify` branch push (my 5 files only, committed in a worktree off the origin base — no local `ui-sweep` commits ride along) + core PR → real Actions run using the real secrets. Partner `release-aab` is `workflow_dispatch`-gated → GitHub dispatch proof only after the file lands on the default branch; local proof stands meanwhile.
- After CI proof: record run IDs here. Then Phase 2 E2E (blocked on Petpooja trio — re-verified 2026-10-09: still `# TODO`; sandbox panel email/password ARE in `functions/.env` but self-serve key minting NOT attempted, awaiting user), domain attach (user click), store accounts (user — critical path).
- **Emulator AVD parked (2026-10-09 retry #2)**: boot still FATAL — `need 7372.80 MB for userdata, available 4156 MB`. The requirement comes from a regen source that overwrites `~\.android\avd\burgonomics_e2e.avd\config.ini` at launch (edit `disk.dataPartition.size` 6 GB→2 GB was reverted within the same second; no `6442450944` found in system-image AVD templates). To unblock later: free **≥7.4 GB** on C: (or find the regen source — candidates: emulator AVD self-heal on `quickbootChoice.ini` parse failure). Not on the critical path — physical device `RZCX51TXRKB` remains the screenshot/E2E device (auto-lock: needs PIN for input-driven runs).

### 10.6 CI run evidence (2026-10-09, throwaway branches pushed with orchestrator approval)
- Branches: partner `release/ci-verify` `10f4feb` (base `origin/feat/partner-device-smoke` + my `ci.yml` only); core `release/ci-verify` `f0bb197` (base `origin/main` + my `android-build.yml`/`ios-build.yml`); **core PR #1** opened (`pandejesal/Burgonomics-App#1`). Worktrees `Temp\opencode\wt-{partner,core}-ci` kept for follow-ups. Local trees untouched. (Info.plists excluded from branches — zero CI effect; core's carries sibling edits.)
- ✅ **Core `Android Build (Capacitor)` = SUCCESS** (run `37866985230`, 3m46s): fixed signing job decoded `RELEASE_KEYSTORE_BASE64`, sed-guard passed, AAB+APK artifacts uploaded (249/249 MB). **Downloaded CI AAB → keytool signer SHA256 `15:3F:30:0D…` = exact Phase 1 core release-keystore cert** → full secret→runner→signed-AAB chain proven.
- Pre-existing reds (identical on `main` since Sep 20 — NOT mine, listed for orchestrator): core `CI` job (web typecheck, Firestore-rules suite, android-debug), core `iOS Build` (Xcode 15.4 vs Capacitor 8 SPM — documented in 10.1). Partner run `37866942131`: gitleaks ✅; web ❌ = **TS errors in `src/admin/*` on the remote base** (sibling domain — local ui-sweep likely has newer fixes); android-debug ❌ = `./gradlew: Permission denied` (exec bit lost in repo); iOS-sim ❌ = job runs `cap sync` without a web build. My new jobs already guard all three (chmod + build-before-sync) and correctly **SKIP on push** (dispatch-only) — they cannot run until the workflow files land on default branches (`workflow_dispatch` requires default-branch presence).
- 🟠 **Size defect (relay)**: AAB = 249 MB uncompressed 260 MB — dominated by `base/assets/public/images/menu/*.jpg` (single photos up to **14 MB**; menu images ≈ 210 MB total). Risks Play's base-AAB upload cap (~200 MB initial) and blows past Apple's 200 MB cellular threshold. Fix = squash menu JPGs (target <500 KB each → AAB ≈ 20-30 MB). Web assets = sibling/orchestrator content lane — reported, not edited.
- **Petpooja E2E prep (from the two PDFs, 2026-10-09)**: public IP to whitelist = **103.250.137.67** (laptop egress; dashboard + sandbox API IP-locked). Tokens trio = sandbox dashboard **Configuration** tab (email-sent dashboard login = the creds already in `functions/.env`). `restID` = `PETPOOJA_SANDBOX_MAPPING_CODE=31z58ciw0h`. **Sandbox save_order endpoint differs**: `https://qle1yy2ydc.execute-api.ap-southeast-1.amazonaws.com/V1/save_order` (guide) vs our `PETPOOJA_ORDER_URL=developerapi.petpooja.com/V1/save_order` — probe both in §8.6 step 1. ⚠️ Open question for Petpooja: are API calls IP-locked too (only laptop whitelisted)? Live calls egress from **GCP Cloud Functions**, not this laptop — need GCP egress whitelisted (or Cloud NAT static IP) before live E2E passes.
