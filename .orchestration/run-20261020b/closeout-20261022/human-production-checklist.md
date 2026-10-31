# BURGONOMICS — Human Production Checklist (repo-grounded)

Source inspection at repo HEAD `d5f8c0d` (historical snapshot), corrected by Main on 2026-10-22 after user confirmation. Blaze is already enabled; ADB is installed; Porter is cancelled. This checklist is not deployed-configuration verification. Variables are NAMES only; no secret values are printed. See `PRODUCTION_ACTION_PLAN.md` for the corrected action sequence.

Context rules verified from code (fail-closed): production boot refuses mocks/missing keys (`BURGONOMICS_ENV` boot guard, `functions/.env.example:8-12` + `assertProductionKeys`, §7/§9 of RELEASE_AND_INTEGRATION_GUIDE.md). A provider with an empty key is silently excluded from dispatch quotes, never faked.

## A. Firebase project, Auth, Rules/Indexes, Functions, Hosting
- DONE in code: `firebase.json` (functions predeploy, rules+indexes wiring, 2 hosting targets `burgonomics-app`/`burgonomics-partner` with CSP + `.well-known` MIME headers, `firebase.json:1-144`); `firestore.rules`, `firestore.indexes.json` exist at root.
- 1.1 [DONE — USER CONFIRMED] Blaze was enabled long ago. Do not repeat the upgrade. Review target project/alias and budget alerts before a release; an older runbook's "not started" line is stale.
- 1.2 [BLOCKING] Run deploys: `firebase deploy --only firestore` → `functions` → `hosting` (exact commands, RELEASE_AND_INTEGRATION_GUIDE.md:253-267). Owner: Dev. Verify: hosting URLs respond; GCF Console shows functions in `asia-south1`.
- 1.3 [BLOCKING] Enable Auth providers: Phone OTP with the review test number (fixed OTP, guide §6 — repo does not prove it is live) and email/password for partner. Register Android upload-key SHA-1/SHA-256 (guide:172). Owner: Yash.
- 1.4 [BLOCKING] Fill `functions/.env` from `functions/.env.example` with `BURGONOMICS_ENV=production` and all production secrets; deploy. Verify: boot log shows production guard passed; mock flags all unset/false.

## B. Razorpay payments
- DONE: server webhook route `POST /payments/webhook` (`functions/src/index.ts:423`), handler `payments/webhookHandler.ts` (dup-capture guard, `payment.captured`/`order.paid`, :155, :613); POS-cancel refunds parked for staff approval (`item86ingSync.ts:763-780`, `PENDING_APPROVAL`).
- 2.1 [BLOCKING TO LIVE RELEASE] Company confirms KYC/live-account status and secure key provisioning: `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`; `OTP_HMAC_SECRET` is a separate application secret, not a Razorpay-issued key. First verify a test-mode payment with order-bound captured evidence and downstream effects, not just HTTP 200. Confirm webhook subscriptions from the deployed handler.
- 2.2 [BLOCKING / BUSINESS DECISION] Refund amount/authority on POS cancellation needs company confirmation. Route code exists (for example the transfer chokepoint fix `980ef3e`); account activation, branch-linked accounts, actual split policy and real settlement remain unverified, not absent implementation.
- 2.3 [BLOCKING] Client `VITE_RAZORPAY_KEY_ID` (rejects `rzp_test_*` in production builds, customer `.env.example:49-50`).

## C. Petpooja POS
- DONE: outbound KOT push fails closed on missing `branch.petpoojaStoreId` (`orderPush.ts:577-585`); inbound `/api/petpooja/webhook` + `/api/petpooja/stockWebhook` (`index.ts:605`, `item86ingSync.ts:40`); hourly menu sync scheduler.
- 3.1 [BLOCKING] Obtain merchant keys from Petpooja panel; set `PETPOOJA_APP_KEY/APP_SECRET/ACCESS_TOKEN/WEBHOOK_SECRET` + URLs (names at `functions/.env.example:32-39`). Note: APP_KEY is also the inbound webhook secret.
- 3.2 [BLOCKING] Set `branches/{id}.petpoojaStoreId` top-level field per outlet (Runbook §5 procedure). Verify: a paid order prints a KOT on the real printer; `petpoojaOrderId` saved in Firestore.
- 3.3 [BLOCKING — VENDOR RESPONSE NEEDED] The recorded menu request returns `"unable to fetch Object from s3 bucket"`. Menu Push mode is a proposed explanation, not an independently proved permanent cause. Ask Petpooja to confirm supported menu delivery/provisioning, representative addon/variation fixtures and `in_stock "2"` meaning. Verify catalog and observable POS/KOT results, not receipt alone.
- 3.4 [BLOCKING] Register the two inbound callback URLs in the vendor console (Menu Push paths).

## D. Borzo dispatch (contract-gated)
- DONE: adapter + callback `POST /dispatch/webhooks/borzo` (`index.ts:916`); inbound HMAC in `X-DV-Signature` verified against `BORZO_WEBHOOK_SECRET` (`functions/.env.example:55-65`); test base URL documented (`robotapitest-in.borzodelivery.com`).
- HUMAN (BLOCKING to enable Borzo): company account/billing and secure `BORZO_API_KEY`/`BORZO_WEBHOOK_SECRET` setup, callback registration, written no-real-rider sandbox boundary and current official contract. Verify quote and order-bound lifecycle effects with negative controls. Restaurant in-house delivery is an allowed distinct route, not proof Borzo works.

## E. Shadowfax dispatch (contract-gated)
- DONE: adapter + `POST /dispatch/webhooks/shadowfax` (`index.ts:936`); secret relayed to Shadowfax in `x-shadowfax-signature` custom header (no native HMAC, `.env.example:56-58`); names `SHADOWFAX_API_KEY`, `SHADOWFAX_CLIENT_CODE`, `SHADOWFAX_WEBHOOK_SECRET`, `SHADOWFAX_BASE_URL`, plus `SHADOWFAX_CONTRACT_VERIFIED` gate.
- HUMAN: obtain the official Shadowfax API/callback/pricing contract and a safe test boundary; confirm the implementation against it before setting `SHADOWFAX_CONTRACT_VERIFIED`. Credentials alone do not justify the flag.

Provider choice is confirmed: Borzo and Shadowfax, with restaurant-selected in-house riders. Porter is cancelled. No Porter onboarding or real booking belongs in this launch checklist; preserve historical reconciliation only.

## F. FCM / Push
- DONE: server sends via Firebase Admin SDK (no FCM server-key env needed) — `modules/notifications/*` builds `apns`+`webpush` payloads (templates.ts:42-45).
- HUMAN: 4.1 create web-push VAPID key in the Firebase console and set `VITE_PUSH_VAPID_PUBLIC_KEY` (customer `.env.example:43-46`) / `VITE_FCM_VAPID_KEY` (partner .env:29-31). 4.2 upload APNs auth key in the Firebase console for iOS. Verify: push banner on a real device.

## G. Android release
- DONE (verified fail-closed): customer `android/app/build.gradle:32-68` signing from CI env or gitignored `key.properties`, NO debug fallback; release-task guard throws on absent/undebug keys and rejects `CN=Android Debug` (:99-151); optional `RELEASE_CERT_SHA256` pin (:96, :156-171). Rescue record: R15-android-release-signing-repair.md. `key.properties` and `google-services.json` EXIST in both apps' android/app dirs (existence confirmed only — contents not read).
- HUMAN [BLOCKING]: 5.1 confirm human ownership + offline backup of the keystore (passwords, .jks) — a lost Play-signing lock is unrecoverable. 5.2 create Play Console apps `com.burgonomics` + `com.burgonomics.partner`, upload first AAB via `gradlew bundleRelease`, enable Play App Signing (guide §5). 5.3 store listing assets from STORE_LISTINGS_DRAFT.md / STORE_SUBMISSION_GUIDE.md; reviewer demo credentials decision per guide §7 note §9 (rotate, don't ship them as-is). Verify: Play Console shows "App signing key generated"; signed AAB accepted.

## H. iOS release
- DONE (source-only): `mac-build.sh` + `scripts/patch-ios-spm.js` exist in the CUSTOMER app (partner has `mac-build.sh` but NO `patch-ios-spm.js` — flag; partner iOS SPM graph state unknown). R18 finding 7: partner site publishes no `assetlinks.json`.
- HUMAN [BLOCKING]: 6.1 Apple Developer account + Xcode 16+ Mac; run `./mac-build.sh`, pick Team, auto-signing, Archive → TestFlight (customer MAC_INSTRUCTIONS.txt steps 1-4). 6.2 replace literal `TEAMID` placeholder in `public/.well-known/apple-app-site-association` then redeploy hosting (MAC_INSTRUCTIONS.txt:76-83; R18 finding 3 — proven blocker). 6.3 APNs key upload (see F). Verify: `node scripts/validate-mobile-hosting.cjs` passes w/o `--allow-unresolved-teamid`; TestFlight build installs.

## I. Device smoke test on the USB Android phone
- Status: ADB 37.0.0 is installed in `%LOCALAPPDATA%/Android/Sdk/platform-tools/adb.exe`. Latest direct check: no attached ADB device. This is not an installation blocker.
- 7.1 [BLOCKING TO DEVICE QA] Reconnect/unlock the phone, enable USB debugging if needed, and accept its computer-authorization prompt. Verify ADB state `device`; never publish the serial.
- 7.2 [BLOCKING TO DEVICE ACCEPTANCE] Use a documented staging build/test plan, not an unexplained install or live payment. Test OTP → menu → cart → address → Razorpay test-mode payment → POS/KOT → Borzo/Shadowfax safe test dispatch or restaurant in-house → tracking/push. Record actual order effects and negative controls.

## J. Data/PII & money safety sign-off
- 8.1 [BLOCKING] Generate strong `OTP_HMAC_SECRET` before rotating `RAZORPAY_WEBHOOK_SECRET` (dedicated; `.env.example:20-23`).
- 8.2 [NON-BLOCKING at first test, BLOCKING to scale] `APP_CHECK_ENFORCEMENT=false` = monitor mode; enforce only after `VITE_RECAPTCHA_SITE_KEY` ships + native Play Integrity/App Attest enrollment (`.env.example:89-92`).
- 8.3 [BLOCKING] Secrets policy: server keys only in `functions/.env`/Secret Manager; partner `.env.example` contains filled-looking Firebase web values (pointer, without printing) — review and reissue any value that was ever committed. Owner: Yash + Dev.
- 8.4 [BLOCKING] Seed/verify `admins` RBAC docs (customer `.env.example:84-86`) and set `VITE_ADMIN_MAINTENANCE_PIN` (partner .env:22-24, no default).
- 8.5 [BUSINESS] Refund authority + signage of POS-cancel differential refunds (see 2.2); Blaze budget alarm.

## What the repo CANNOT prove
- Any credential works in production (validity, vendor quotas, live-mode KYC); Petpooja vendor cooperation (S3 blocker); Borzo/Shadowfax contract terms; Mac/iOS compile results and TestFlight acceptance; store-review approval incl. App-Bound-Domains justification (MAC_INSTRUCTIONS.txt:92-95); real-device behaviour (adb absent); reviewer demo numbers actually live (guide §8 note §9); refund business policy; which delivery 3PL to use; Blast-radius of budget.

## Minimum path to a first REAL test order
1. Blaze is done. Finish engineering gates and select an isolated staging project, approved secrets and rollback before any deploy.
2. Razorpay TEST keys: `RAZORPAY_KEY_ID/KEY_SECRET/WEBHOOK_SECRET` + `OTP_HMAC_SECRET`; register webhook `<base>/api/payments/webhook`.
3. Petpooja keys into `functions/.env`; set `branches/{id}.petpoojaStoreId`; re-deploy functions.
4. Delivery: validate Borzo/Shadowfax within an agreed no-real-rider sandbox, and independently test restaurant-selected in-house delivery. Takeaway is not a substitute for that flow.
5. Android: use installed ADB, authorize the phone, validate a staged build with test-mode payment and actual downstream effects. No "live-mock" claim or automatic real spend.
6. Only after acceptance: company confirms live financial policy/keys and release sign-off; production deploy and store submissions are separate recorded gates.
