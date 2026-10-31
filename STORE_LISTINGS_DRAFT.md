# STORE SUBMISSION PACKAGE — DRAFT 1 (2026-10-17)

Owner: coordinator session (review + release-readiness lane).
Builds: `burgonomics-partner` (com.burgonomics.partner) and
`burgonomics-foundation-core` (com.burgonomics). Android AAB build candidates archived; public release is blocked.
Status: DRAFT — every `[NEEDS: …]` marker is an input only a human can supply.

## STATUS 2026-10-18 ~01:00 (coordinator, final for the night)

| Item | State |
|---|---|
| Signed AABs (v1.0.0, versionCode 1) | ✅ BUILT + **signature-verified** (`jarsigner -verify` exit 0; the JAR-vs-JarInputStream notices are the normal AAB scheme note, not a failure). `burgonomics-partner-v1.0.0-20261017.aab` 26.4 MB SHA-256 `B86291AD4BF39AF5FA4DA886FCA0F4DC3199D0ADB168400C4CA26410AAA01120`; `burgonomics-customer-v1.0.0-20261017.aab` 20.9 MB SHA-256 `60D1B11CA673B4D14439F6D06A38E5ABCB341CD9837864FBF17609CAEB01CE4B`. Keystores keytool-verified, fail-closed signing, targetSdk 36 (policy-compliant) |
| Full-tree validation (functions, dirty tree incl. payments) | ✅ `vitest run`: 53 files passed / 1 skipped; **591 passed / 2 skipped / 0 failed**; `tsc` (build) exit 0 |
| Doc corrections made at close | Store copy rebuilt as an explicitly-unverified skeleton; reviewer access changed to "working demo account required" (video supplementary only); test-mode/mock integrations no longer described as storable-ready; partner Mac runbook corrected (no archive/Xcode claim), SPM claim downgraded to inspected-not-resolved, push claim requires APNs + device test, core's full patch-ioS-spm scope noted as not merely version rewriting |
| assetlinks fingerprints | ✅ FIXED: core corrected to `15:3F:30:0D:…CD54` (stale `C8:70:5A:38` replaced); partner file CREATED (`25:C9:63:BC:…CF:D7`). Both propagated to publish dirs |
| Root hosting preflight | ✅ PASS 25 / FAIL 2 — the only remaining FAILs are the `TEAMID.` App Store placeholder (needs the Apple Team ID; blocked on team) |
| "Delivery app" identity | ✅ CONFIRMED == `burgonomics-foundation-core` (`com.burgonomics`); exactly two Capacitor apps exist, no courier app |
| CI device-status | core `android-build.yml` builds signed AAB/APK from secrets, proven green (run 37866985230); NO Play upload API in any workflow → uploads are manual console |
| Petpooja backend | ✅ FULLY reviewed, zero blockers: `152d834` → `9c20c12` → `b26d5e3` → `1627204` → `9407006` → `317b6ea` → `cc9fc8c` (docs) |
| dispatch backend | ✅ FULLY reviewed, zero blockers: `39efc40` → `91f487c` → `8a144f7`. Owner items deliberately open: wire probes, `store.phone` backfill, finding 15 |

---

## 0. Hard constraints stated plainly (decided from user's answers 2026-10-17)

1. **No Play Console account exists yet.** Creating one today is step one;
   identity verification can take 48h+ (org accounts need D-U-N-S).
   → **"Live on Play by tomorrow" is not attainable from zero; "submitted by
   tomorrow" is, if account creation starts today and verification is kind.**
2. **Apple** — account is burgonomics-team-owned. Required from them: the
   **Apple Team ID** (10 chars), an **App Store Connect invite**, and approval
   for the friend's Mac run (no tooling installed there; a human runs
   `mac-build.sh` per `MAC_INSTRUCTIONS.txt`).
3. **Integrations are mock/test or unverified** (Razorpay, Porter/Borzo/Shadowfax,
   Petpooja sandbox). These builds are internal-test candidates, NOT approved
   production releases. Staged rollout does not make broken checkout or
   dispatch safe. Verify supported order/payment/refund/fulfilment flows before
   production submission; do not advertise unverified functionality.
4. Apps are login-gated: provide working reviewer accounts and any necessary
   OTP/login instructions. A video can supplement access, not replace a
   functioning reviewable app. `[NEEDS: accessible demo account per app]`

---

## 1. Customer app — com.burgonomics ("BURGONOMICS")

**Play**
- Name: `Burgonomics` (12/30)
- Short description (≤80):
  `Order fresh burgers from local Burgonomics branches. Exclusive offers inside.` (78) `[verify offers are usable in demo mode]`
- Full description (≤4000): unverified feature-copy skeleton below. Remove
  every claim whose end-to-end acceptance check has not passed before use.
  ```
  Skip the line. Burgonomics is the official way to order from your
  neighbourhood Burgonomics branch.

  • Browse the live menu of your nearest branch, with real-time availability
  • Customise every item and check ingredients before you add
  • Track your order from kitchen to doorstep, with live status updates
  • Collect Grill-Coins on every order and redeem them on the next one
  • Members-only offers, combos and coupons
  • Secure sign-in, saved addresses, one-tap reorders

  New branches are added regularly. Support: [NEEDS: support email]
  ```
- Category: Food & Drink / tags: Food & Drink, Shopping
- Graphics `[NEEDS: assets]`: app icon 512×512 (source found in repo? audit
  running), feature graphic 1024×500, 8 screenshots:
  1. Home (branch/store discovery)
  2. Menu category view
  3. Item customizer (screenshot_4_customizer.png exists at repo root as source)
  4. Cart
  5. Checkout (payment-sheet state, test mode)
  6. Offers/combo view
  7. Order tracking screen
  8. Profile / Grill-Coins wallet
- Content rating questionnaire: complete `[NEEDS: does app show any user-generated images? offers banners only → "no UGC" path]`
- Data safety form: Firebase (Auth/Firestore/FCM), Razorpay — answers in
  section 4. `[NEEDS: confirm Analytics + App Check still enabled]`

**App Store**
- Title `Burgonomics`, subtitle (≤30): `Burger ordering, done right` `[final polish pass]`
- Keywords (≤100): `burger,food,delivery,offers,grill,coins,menu,order,tracking,rewards` (71)
- Promo text ≤170; description mirrors Play.
- Screenshots at 2026-required device sizes (6.9" + optional iPad set) —
  `xcrun simctl` capture on the friend's Mac, or export Play-set images scaled.
- **App Privacy labels** must match Firebase+Razorpay usage (identifiers,
  purchase history, location-when-using if address/location used).
  `[NEEDS: team confirms Apple account holder fills the privacy manifest]`
- Review notes: demo login or video (see §0.4); test-mode payments explained
  in notes; `TEAMID.` placeholder must be replaced BEFORE archive (R18 preflight).

**versionCode/versionName**: held in `android/version.properties` — bump both
before archive. Current values read from `version.properties` (audit output). `[NEEDS: confirm current versionCode policy — first launch starts at 1]`

---

## 2. Partner app — com.burgonomics.partner ("Burgonomics Partner")

**Play**
- Name: `Burgonomics Partner` (20/30)
- Short: `POS & operations console for Burgonomics franchise branches.` (58)
- Full description: from README §1 (KOT stream, Porter screen, ticket
  escalator, combo/offer creator, RBAC, dev diagnostics). Write in
  operator-facing voice; mention Petpooja POS bridge and courier dispatch as
  platform capabilities without promising live coverage. `[draft pass 2]`
- Category: Food & Drink / Productivity
- Screenshots plan (8): KOT stream · Live orders · Porter dispatch quote/booking
  · 3-tier tickets · Combo creator · Analytics · Users/RBAC · Dev diagnostics.
- Ratings/segmentation: business app; still needs the questionnaire. Data
  safety: Firebase Auth/Firestore/FCM, Razorpay refunds, Petpooja/Porter
  server-side.
- **Demo credentials are mandatory here** (RBAC login wall). Two demo users:
  Branch Manager + Brand Owner, both visible in a demo branch.
  `[NEEDS: these two accounts — the Petpooja sandbox demo store exists]`

**App Store**: same structure; keywords
`pos,kitchen,orders,kot,restaurant,delivery,dispatch,tickets,adapter,owner` (≤100 check) `[draft pass 2]`

**versionCode/versionName**: `android/version.properties` — bump.

---

## 3. Shared assets + policy artifacts `[NEEDS: owner]`

| Artifact | Status | Owner |
|---|---|---|
| Privacy policy URL per app | `[NEEDS: must be a live URL before submission — publish burgonomics.land/privacy or similar; Apple+Play both hard-require it]` | burgonomics team |
| Terms of use (Apple's pairing with privacy when any IAP/coins exist) | `[NEEDS]` | burgonomics team |
| Support email + phone | `[NEEDS]` | burgonomics team |
| App icon 1024 (iOS) / 512 (Play) | verify existing source; regenerate if mismatch | I can validate today |
| Feature graphic 1024×500 (Play) | `[NEEDS]` | designer |
| Screenshots | capture on device/Mac after AAB lands | me (device not present → produce from browser captures + note) |
| assetlinks.json fingerprint check | ✅ FIXED 17-10: core source + `dist/mobile` corrected to real `15:3F:30:0D:…`; partner `assetlinks.json` created (source + `dist`) with `25:C9:63:BC:…` — verifies green in root preflight. Note: when Play "app signing" generates a Google-managed key later, ADD that SHA-256 as a second entry rather than replacing this one | me — done |
| AASA `TEAMID.` placeholder | ⏳ BLOCKED — the single remaining preflight failure, requires burgonomics team's Apple Team ID in 4 files (core public, partner public, partner android assets, partner ios public) | team |
| iOS `GoogleService-Info.plist` for both apps | ⏳ MISSING (neither `ios/App/App/` has it) — register the iOS apps in Firebase console (project `burgonomics-7faa8`), download the plists, drop into both `ios/App/App/` — console/web work, NOT Mac-blocked | team |

---

## 4. Data-safety answers (Play) — pre-filled skeleton

- Does app collect personal data? Yes (account email, name, addresses, order
  history, device identifiers via Firebase).
- Collected for: app functionality, personalisation, analytics `[confirm]`.
- Transmitted off device: Yes (Firebase Firestore/functions, Razorpay).
- Location:-if-used by customer app? `[confirm branches-based only]`
- Purchases: order totals via Razorpay `[test mode at submission]`.
- Deletion path: account delete in profile settings `[confirm exists]`.

## 5. Apple App Privacy — pre-filled skeleton

Identifiers (user id, device), Purchase history, Coarse location `[confirm]`,
Contact info (name/email/address), In-app purchase none.

---

## 6. Submission sequence (critical path)

**Today 2026-10-17 (me + user) — DONE unless noted**
1. ✅ AAB builds landed; signatures verified; archived in `client-handover/release-builds/*-v1.0.0-20261017.aab`. versionCode 1/1.0.0 = correct for first upload; hand-bump every next upload (`android/version.properties` + the matching gradle fallback lines).
2. ✅ assetlinks fingerprints fixed/created and propagated (see STATUS table).
3. 🔄 Review + close dispatch/payments lane work (in-flight) + Petpooja `9c20c12` fix-up review (running).
4. ✅ Listings + reviewer-access spec in this document; screenshots: pre-captured sets exist at `client-handover/store-assets` (29 customer / 22 partner) — pair them with the §1/§2 plans at upload time.

**Tonight (burgonomics team)**
5. Create Play Console account NOW (longest external lead time), invite user.
6. Apple Team ID + App Store Connect invite + integration-keys decision.

**Tomorrow 2026-10-18**
7. Play: app entries + internal testing track upload (AABs ready).
   Production release = after review + team decision on live keys.
8. iOS: friend's Mac runs `mac-build.sh`; if Team ID supplied tonight, the
   archive upload can happen tomorrow — App Store **submission** (not release)
   is the realistic iOS outcome.

## 7. Anti-rejection checklist (Google Play, new app 2026)

- [ ] Registration fee paid + identity verification `[team]`
- [ ] Closed-testing track first for personal accounts (12 testers × 14 days if
      account is personal — org accounts bypass; D-U-N-S needs verifying) `[team]`
- [ ] Screenshot set matches required min count per form-factor
- [ ] App reviewed by human + demo access works (`§0.4`)
- [ ] No functional payment claim while Razorpay is in test mode
- [ ] versionCode ≥ dist already-shipped APKs (if any installs exist) `[confirm]`

## 8. Anti-rejection checklist (App Store)

- [ ] Team ID substituted in AASA (both sites) + hosting redeployed `[team/self after Team ID]`
- [ ] `xcrun simctl`/Screenshot capture on Mac; images at required sizes
- [ ] App Privacy + privacy policy URL live
- [ ] Demo credentials or video in review notes
- [x] SPM resolution ground-truth 17-10: on a fresh `npm ci`, BOTH apps' graphs resolve (all plugins `from: "8.0.0"` + aggregator `exact: "8.5.2"`); partner needs NO patch step; core's patch step is optional (pins everything to 8.5.0 = the documented skew). Partner runbook: `burgonomics-partner/MAC_INSTRUCTIONS.txt`
- [ ] Export compliance: uses standard HTTPS only → answer ITSAppUsesNonExemptEncryption-no at review `[confirm no custom crypto]`
