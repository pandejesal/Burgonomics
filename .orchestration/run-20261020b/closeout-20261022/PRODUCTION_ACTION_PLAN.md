# Burgonomics — Production Action Plan

Written 2026-10-22. Grounded in `KEYS_REQUEST_FOR_BURGONOMICS.md`,
`PRODUCTION_RUNBOOK.md`, `RELEASE_AND_INTEGRATION_GUIDE.md`, `references/`,
`functions/.env.example`, and the closeout reconciliation. Vendor email
addresses below are the ones already used in this repo — anything not found in
the repo is marked "from your console" rather than invented.

Current acceptance: cited commits have LOCAL CODE VERIFIED evidence only. This
run has not verified a deployment, current provider fulfilment, store upload or
device E2E. Older records include provider test responses; they are not current
release acceptance. Blaze is already enabled (user confirmation). ADB is installed.
Porter is cancelled; dispatch is Borzo/Shadowfax or restaurant-selected in-house.

---

## Part 0 — The verified commit set (what a release would actually ship)

Local only, nothing pushed. These are the commits with a reviewed, gated, exact-scope
history. Anything not in this table is uncommitted dirty work and must not be deployed.

| Repo | Commit | What it changes | Why it matters for the human |
|---|---|---|---|
| root | `5e1777c` | ticket resolution serialised behind a server-owned lease | two staff can no longer both close one ticket |
| root | `086b60d` | **Porter retired by default**; direct booking refuses before any I/O; cancelled Porter secrets no longer block production boot | no paid Porter rider can be booked by default, and boot does not need a dead partner's keys |
| root | `4b6e4f6` | device-token detach gated on ownership; holders scrub is a second transaction | a logged-out device can no longer keep a token, and a token rebound to another account is not scrubbed out of the new owner |
| customer | `2f47cef` | client rules mirror freeze | client SDK and deployed rules agree |
| customer | `6e25a0c` | address save/delete failures surface honestly, no duplicate submit, account-switch safe | no false "address saved", no duplicate addresses |
| partner | `6f81fba` | rules mirror freeze | same, partner side |

Still open and NOT in any release: the dispatch webhook boundary packet, the FCM
recipient-ownership packet, the customer payment packet, the restaurant in-house
delivery packet, the reference/doc drift packet and the release-infrastructure
packet were all in review or in progress when this window closed. Their truth labels
are in `closeout-20261022/SUMMARY.md`.

Deployment order for a human: functions first (the backend rules and services are the
source of truth), then Firestore rules, then the two apps. Take a Firestore export
and a Functions snapshot before each step and know how to roll back.

---

## Part 1 — What YOU can do yourself, today

These need no vendor reply and no other person.

### 1.1 Phone / device (15 min)
ADB 37.0.0 is installed at `%LOCALAPPDATA%/Android/Sdk/platform-tools/adb.exe`.
The last check returned an empty device list, despite Windows previously seeing
an MTP connection. Do not reinstall ADB merely because it is absent from PATH.

1. Use the installed SDK's `adb.exe`, or add that existing directory to PATH yourself.
2. On the phone: Settings → About phone → tap Build number ×7 → Developer options
   → USB debugging ON.
3. Reconnect, run `adb devices`, tap **Allow** on the phone.
4. Confirm it prints `<serial>  device` (not `unauthorized`).

Pass: `adb devices` shows `device`. This unlocks every later device test.

### 1.2 Firebase project (30–60 min, needs your Google account)
1. **Blaze is already enabled**, confirmed by the user. Do not repeat the upgrade.
   Check the selected staging/project alias before any deployment.
2. Set a budget alert (₹ cap + email) before deploying anything.
3. Release engineering first closes the reviewed commit set, isolated gates,
   staging configuration and rollback plan. Only then run explicit scoped deploys
   to the verified target, recording SHAs, project ID and results. Deployment has
   not been performed by this agent.
4. Auth → enable Phone (add the reviewer test number + fixed OTP) and
   Email/Password for the Partner app.
5. Auth → Project settings → add Android SHA-1 and SHA-256 fingerprints for both
   apps (build.gradle signing cert).

Pass: Functions list shows the `api` function in `asia-south1`; a test OTP request
returns a code.

### 1.3 Fill and load the env (45 min)
Do not overwrite an existing `functions/.env`. Compare required variable NAMES
against the example, and load actual secrets through the approved secret channel. Set
`BURGONOMICS_ENV=production` **only when you are truly going live** — the boot
guard refuses mock keys in production, so a half-filled prod env will refuse to
start (that is deliberate). For the first test round use the trial/dev value.

Client apps: `burgonomics-foundation-core/.env` needs `VITE_FIREBASE_*`,
`VITE_API_BASE_URL`, and later `VITE_RAZORPAY_KEY_ID`; partner app the same plus
`VITE_ADMIN_MAINTENANCE_PIN`.

### 1.4 Keystore ownership and recovery
1. Confirm the existing release keystore before generating another. Store the `.jks`, alias and both passwords
   in a password manager **and** an offline backup.
2. Keep it out of git (`key.properties` is already gitignored).
3. Distinguish the upload key from the app-signing key. Play App Signing supports
   upload-key reset and some signing-key upgrade/recovery procedures; the company
   owner must verify its actual enrollment before changing any key.

### 1.5 Decide these five business questions (they block code paths)
1. **Refund policy** for POS-cancelled orders — full or differential? The code
   only parks `PENDING_APPROVAL`; somebody must be named approver.
2. **Royalty split** — the repo assumes 95% outlet / 5% platform Route split.
   Confirm or change before Razorpay linked accounts are created.
3. **Dispatch choice is settled:** Borzo and Shadowfax are the third-party partners,
   with restaurant-selected in-house riders. Porter is cancelled; no onboarding,
   wallet funding or new Porter booking belongs in this launch plan. Confirm
   branch fees and safe switching after a provider booking, not the provider choice.
4. **Support inbox** — `support@burgonomics.com` vs `support@burgonomics.in`
   (the repo uses both; terms, about page and invoice footer disagree).
5. Main may approve ordinary engineering decisions under the user's instruction.
   The company still owns financial policy, business contracts and release accounts;
   engineering approval is not a fabricated vendor authorization or credential.

### 1.6 Register webhooks (10 min each, after deploy)
- Razorpay → Settings → Webhooks → `<base>/api/payments/webhook`, events
  `payment.captured`, `payment.failed`, `refund.processed`, `transfer.processed`.
- Borzo → Personal cabinet → callback URL
  `<base>/api/dispatch/webhooks/borzo`, grab the Callback Secret Key.
- Shadowfax → get the official callback/authentication contract and register
  `<base>/api/dispatch/webhooks/shadowfax` with its account team. Do not enable a
  contract-verification flag solely because an API token was supplied.

Transport check: each dashboard shows authenticated callback receipt. Fulfilment
acceptance additionally requires the right order's state/effect and duplicate,
stale, conflicting and late-event negative controls; HTTP 200 alone is not success.

---

## Part 2 — Emails to send

Send from a company address, sign as the business entity, and CC the technical
owner. Replace `[legal name]`, `[GSTIN]`, `[phone]` before sending.

### 2.1 Petpooja — the most blocking one
**To:** `support@petpooja.com`
**CC:** `malvi.vaghela@petpooja.com`, `rohan.sakhrani@petpooja.com`
**Subject:** Burgonomics — Menu Push provisioning and API credentials for outlet integration

```
Hello Petpooja team,

We are integrating our ordering platform with our Petpooja POS account for
[legal name] (GSTIN [GSTIN]).

Two blockers and one request.

1) Menu ingestion is failing. Our server calls mapped_restaurant_menus and
   receives: "unable to fetch Object from s3 bucket". Our account appears to be
   in Menu Push mode. Please confirm whether a fetch object should exist for
   this integration, provision/correct it if needed, or provide the supported
   Menu Push contract. We have not independently proved the cause of the S3 error.

2) Please confirm the credentials for one test outlet and every live outlet:
   - APP_KEY, APP_SECRET, ACCESS_TOKEN, through your secure credentials channel
   - restID for each outlet

3) Please whitelist these two callback URLs:
   https://asia-south1-burgonomics-7faa8.cloudfunctions.net/api/petpooja/webhook
   https://asia-south1-burgonomics-7faa8.cloudfunctions.net/api/petpooja/stockWebhook

Please confirm external restID values to map to our internal branch records;
our petpoojaStoreId field is internal, not a claim about your API schema.
Please enable a representative test menu with addon groups and variations,
clarify the meaning of in_stock "2", and provide an observable POS order/KOT
result for each agreed test case. Callback receipt is not fulfilment evidence.

Thank you,
[name], [role], [phone]
```

### 2.2 Razorpay — live keys + Route
**To:** your Razorpay account manager (dashboard → Help → Chat/email) — no public
address is recorded in this repo, so take it from the dashboard.
**Subject:** Live activation, Route linked accounts, and webhook registration

```
Hello,

We are going live with [legal name] (GSTIN [GSTIN]) on project burgonomics-7faa8.

1) Please confirm our KYC status and, if pending, the exact documents outstanding
   (PAN, GSTIN, FSSAI, current account + IFSC, brand website).
2) Please confirm Route eligibility and one Linked Account per outlet. A 95/5
   outlet/platform split is an existing repository assumption, not a newly
   approved financial instruction; our company will confirm the final schedule.
3) Please confirm that live API keys (rzp_live_...) will be issued after KYC, and
   that our webhook can subscribe to payment.captured, payment.failed,
   refund.processed and transfer.processed.
4) Our orders are created with partial_payment:false, which we understand Route
   requires — please confirm.

We will register the webhook URL ourselves once our endpoint is deployed, and
will provide the URL. We will choose/store the webhook secret securely, not send
API keys, OTP secrets or passwords in this email thread.

Thank you,
[name], [role], [phone]
```

### 2.3 Borzo — production enablement
**To:** `api.in@borzodelivery.com`
**Subject:** Production API enablement — Burgonomics, Ahmedabad (2-wheeler)

```
Hello Borzo team,

Our historical test records (2 October; not current release acceptance) report:
- GET /client authenticated
- POST calculate-order returned a quote (INR 67, 2.9 km)
- POST create-order booked test order #331979

We now request production enablement for food delivery, Ahmedabad pickup,
2-wheeler. Please confirm the current vehicle_type_id and supported food-delivery
service in our operating cities, rather than relying on historical assumptions.

Please provide:
1) Production access and a secure channel for credentials; do not email tokens
2) Callback Secret Key setup, and confirmation of which callback types are enabled
   (order_created / order_changed / delivery_created / delivery_changed)
3) Confirmation that the production base is https://robot-in.borzodelivery.com
   with the same 1.8 endpoints
4) Commercial terms, with the cabinet and billing owned by [legal name]
5) Written confirmation of a no-real-rider sandbox test mode, fees and cancellation
   behavior. We will not create a booking unless that test boundary is agreed.

Our callback endpoint is:
https://asia-south1-burgonomics-7faa8.cloudfunctions.net/api/dispatch/webhooks/borzo

Thank you,
[name], [role], [phone]
```

### 2.4 Porter — cancelled; no onboarding email

No Porter onboarding, funding or new booking is required. Preserve only whatever
historical records need reconciliation; do not erase existing order bindings.

### 2.5 Shadowfax — account team only, no self-serve
**To:** your Shadowfax account manager / partner desk (no public address is
recorded in this repo; get it from the sales contact or
developer.shadowfax.in).
**Subject:** Hyperlocal Marketplace API access — Burgonomics

```
Hello Shadowfax team,

We are integrating the Hyperlocal Marketplace API for [legal name]
(GSTIN [GSTIN]), 2-wheeler food delivery.

Please provide:
1) API token (sent as Authorization: Token <token>), staging and live
2) client_code assigned to our merchant account, required in the place-order body
3) Your official callback signing/authentication specification. Our current
   implementation expects x-shadowfax-signature; please confirm whether a custom
   shared-secret header or a body HMAC is supported and how retries are signed.
4) Registration of our callback:
   https://asia-south1-burgonomics-7faa8.cloudfunctions.net/api/dispatch/webhooks/shadowfax
5) Confirmation of staging base URL and order-tracking endpoint
6) A no-real-rider sandbox guarantee, serviceability/pricing schema, declared-value
   and insurance rules (including whether value 0 is permitted for our use case),
   cancellation behavior and duplicate/idempotency guarantees

We have a SHADOWFAX_CONTRACT_VERIFIED gate in our configuration and will only
enable the provider once you confirm the commercial contract.

Thank you,
[name], [role], [phone]
```

### 2.6 Not emails — portal actions
- **Google Play:** play.google.com/console → organisation account (needs D-U-N-S
  and legal entity verification). Create both apps, upload first AAB.
- **Apple:** developer.apple.com/programs/enroll → organisation enrolment
  (D-U-N-S). Then App Store Connect + TestFlight.
- **Firebase/Google Cloud:** Blaze is complete. Use support only for a confirmed
  billing, project-access or quota issue; do not request another plan upgrade.

---

## Part 3 — What the Burgonomics engineering team must do

### 3.1 Close the remaining review/commit backlog
These are dirty, owned, and have **no valid DeepSeek→GLM chain**, so they are
correctly uncommitted. Each needs: freeze bytes → DS review → separate GLM →
isolated gate → exact-path local commit.

| Priority | Bundle | Repo | Size |
|---|---|---|---|
| 1 | `unregisterToken.ts` + both ownership/original tests | root | 3 paths; the original fixture lacks runTransaction and realistic arrayRemove/query behavior |
| 2 | `dispatch.webhooks.ts` F7 hunk | root | 1 file |
| 3 | Lane 03 menu/gesture/a11y | customer | ~25 paths |
| 4 | Lane 01 addresses/profile | customer | ~10 paths |
| 5 | Lane 11 release infra (workflows, `firebase.json`, assetlinks, Mac scripts) | both | ~10 paths |
| 6 | Lane 02 KDS/DeliveryQueue/Header/Sidebar | partner | ~10 paths |
| 7 | Lane 06 `petpoojaSync.ts` + evidence docs | partner/root | ~5 paths |

### 3.2 Fix the five known lease defects (committed as documented debt)
1. Add a test that fails if the commit fence (`TICKET_RESOLUTION_CLAIM_LOST`) is
   deleted — the fence currently has zero negative coverage.
2. Map a commit-transaction ABORTED to 503 and persist a recoverable marker; today
   it degrades to 500 with money already refunded and the ticket still `open`.
3. Reject non-finite `claimedAt` (`Infinity`) and far-future claims so a corrupt
   document cannot wedge a ticket permanently.
4. Fix the delete-sentinel test shim so it asserts field removal, not the string
   `MOCK_DELETE`.
5. Test that a failed resolve releases the lease.

### 3.3 Environment and release engineering
- Stand up a **staging** Firebase project or alias. Nothing should be first-tested
  in production.
- Write the rollback procedure (functions rollback + rules rollback + hosting
  rollback) and rehearse it once.
- Review and commit the CI workflows (`functions-ci.yml`, android/ios build
  workflows) — currently untracked or dirty with no review.
- Decide App Check rollout: stay in monitor mode (`APP_CHECK_ENFORCEMENT=false`)
  until reCAPTCHA site key + Play Integrity/App Attest are enrolled.

### 3.4 Security hygiene
- Audit `burgonomics-partner/.env.example`: it contains filled-looking Firebase
  web values. Firebase web keys are public by design, but confirm nothing
  server-side leaked, and rotate anything that was ever a real secret.
- Confirm `admins` RBAC documents are seeded for each real staff user.
- Confirm no `.env`, keystore, or service-account JSON is tracked.

### 3.5 Verification work that replaces "mocks passed"
- Device E2E on the authorized phone, with isolated staging and Razorpay test-mode
  money: OTP → menu → cart → address → test payment → observable POS/KOT →
  Borzo/Shadowfax test dispatch or restaurant in-house choice → tracking → push.
- Record sanitized order/effect evidence and actual provider sandbox responses;
  no secrets, customer data or phone identifiers. A receipt is not a KOT result.
- Add a smoke test that fails if `BURGONOMICS_ENV=production` boots with mock
  flags set.

### 3.6 iOS
The Partner app has `mac-build.sh` but **no `patch-ios-spm.js`** (customer does).
Someone with a Mac must resolve the SPM graph for the partner app before any
TestFlight attempt, and replace the literal `TEAMID` placeholder in
`apple-app-site-association`, then redeploy hosting.

---

## Part 4 — Critical path, in order

1. Use the installed ADB; resolve device authorization/connection. Blaze is done.
2. Close reviewed/gated engineering bundles and capture a reproducible release set.
3. Company sends the Petpooja, Razorpay, Borzo and Shadowfax requests above.
   No Porter request. Vendor response or KYC turnaround is not known or promised.
4. Prepare isolated staging with actual test secrets, safe provider test contracts
   and rollback; deploy only after explicit target/config acceptance.
5. Run test-payment/POS/KOT and provider or in-house device journeys, including
   duplicates/failures and account-switch isolation. Keep each truth label separate.
6. After acceptance, company confirms live financial policy and signs off any
   controlled live transaction. Do not treat this plan as automatic spend approval.
7. Build/store submission and iOS on a Mac follow their own signing/device gates.

## Part 5 — What must never happen
- Do not deploy to production with `MOCK_*` flags set — the boot guard will (and
  should) refuse.
- Do not commit `.env`, keystore, service-account JSON or the phone's identifiers.
- Do not test refunds with real money until the refund policy is decided and an
  approver is named.
- Do not treat a webhook receipt, an HTTP 200, or a mock test as proof that an
  integration works.
