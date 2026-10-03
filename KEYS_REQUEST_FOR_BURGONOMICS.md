# Burgonomics — Keys & Actions Required From Company

Hi Burgonomics team,

To test the app end-to-end and launch to production, please provide the items below. I have split it into **what only you can get (needs business KYC / outlet contract)** vs **what I will handle myself**.

Project: `burgonomics-7faa8` | Region: `asia-south1`

**Acquisition status (updated 2 Oct 2026):**

| Key | Route | Status |
|---|---|---|
| Razorpay TEST keys | Self-serve dashboard signup — no KYC, no website needed | ✅ obtained + verified live |
| Borzo TEST API token | Self-serve registration at `apitest.borzodelivery.com` | ✅ obtained + verified live (quote + book probed end-to-end) |
| Borzo Callback Secret Key + callback URL | Self-serve in the Borzo Personal cabinet (our test login) | ⬜ I do this next |
| Razorpay webhook secret | Self-serve — we choose the value when registering our webhook URL | ⬜ with the webhook step |
| Borzo PRODUCTION enablement | Email `api.in@borzodelivery.com` after successful testing; billing account should be company-owned | ⬜ company decision |
| Razorpay LIVE keys | KYC: PAN/GST/bank + OTP — company identity | ⬜ company |
| Petpooja keys | Only from the company's existing Petpooja POS account | ⬜ company |
| Porter API keys | Free Enterprise signup, but requires GST **or** Business PAN | ⬜ company |
| Shadowfax token + `client_code` | No self-serve portal — assigned by their account team | ⬜ company |
| App stores / legal (§6–7) | D-U-N-S, legal entity, KYC | ⬜ company |

---

## 1. Razorpay — ✅ Test keys obtained (self-serve); LIVE keys need company KYC

You need a Razorpay business account. Please share BOTH test and live:

- [x] `RAZORPAY_KEY_ID` — TEST: obtained 2 Oct (self-serve signup, no KYC)
- [x] `RAZORPAY_KEY_SECRET` — TEST secret: obtained
- [ ] `RAZORPAY_WEBHOOK_SECRET` — no action needed: I choose this value myself when registering the webhook URL
- [ ] `RAZORPAY_KEY_ID` — LIVE: `rzp_live_...`
- [ ] `RAZORPAY_KEY_SECRET` — LIVE secret (server-only)
- [ ] `RAZORPAY_WEBHOOK_SECRET` — LIVE webhook secret
- [ ] `razorpayAccountId` per branch — e.g. `acc_...` (for 95% store / 5% royalty auto-split)

What to ask Razorpay for:
1. Complete business KYC (PAN, GSTIN, FSSAI, current-account + IFSC, brand website)
2. Activate **Razorpay Route** + create Linked Accounts for each outlet
3. Dashboard → Settings → API Keys (copy Test + Live)
4. Dashboard → Settings → Webhooks — I will give you the URL after backend deploy. Events to enable: `payment.captured, payment.failed, refund.processed, transfer.processed`

Note: Test keys work immediately. Live keys take 1-3 days after KYC.

## 2. Petpooja — Please call your Petpooja Account Manager (Test + Live)

Please ask for one TEST outlet + all LIVE outlets:

- [ ] `PETPOOJA_APP_KEY` — TEST + LIVE (32 chars)
- [ ] `PETPOOJA_APP_SECRET` — TEST + LIVE (40 chars)
- [ ] `PETPOOJA_ACCESS_TOKEN` — TEST + LIVE (40 chars)
- [ ] `restID` for each outlet — e.g. Test: `Ahmedabad Central`, plus all live stores

What to ask Petpooja for:
1. Sandbox outlet credentials for testing + live credentials per outlet
2. Confirm each outlet's `restID`
3. Whitelist these 2 webhook URLs (I will confirm after deploy):
   - `https://asia-south1-burgonomics-7faa8.cloudfunctions.net/api/petpooja/stockWebhook`
   - `https://asia-south1-burgonomics-7faa8.cloudfunctions.net/api/petpooja/webhook`

You do NOT need to get the Menu/Order URLs — I already have the defaults.

## 3. Porter — Please email help@porter.in / porter.in/api-integrations (Live only)

Porter has NO sandbox — first live booking is the test. The Enterprise signup
form (porter.in/api-integrations) is free but requires **GST or Business PAN**,
so it needs your company documents (~1 business day activation). Please share:

- [ ] `PORTER_API_KEY` — LIVE `x-api-key`
- [ ] `PORTER_CUSTOMER_ID` — LIVE Enterprise Customer ID
- [ ] `PORTER_WEBHOOK_SECRET` — LIVE HMAC secret
- [ ] Prepaid wallet topped-up (required before volume)

What to ask Porter for:
1. Enterprise onboarding (Ahmedabad / Surat / Vadodara, 2-wheeler) — ~1 business day
2. API access + webhook secret. I will give you the webhook URL after deploy:
   - `https://asia-south1-burgonomics-7faa8.cloudfunctions.net/api/porter/webhook`

## 4. Borzo — ✅ Test token obtained (self-serve); production enablement remains

The cheapest-wins dispatch router (references/delivery_routing.md) quotes and
books Borzo first when it is serviceable. Built against the public **Business
API 1.8** doc (borzodelivery.com/in/business-api/doc). Status:

- [x] `BORZO_API_KEY` — **test token obtained 2 Oct** (self-registered at
      `apitest.borzodelivery.com`) and verified live against
      `https://robotapitest-in.borzodelivery.com`: `GET /client` (auth),
      `calculate-order` (quote ₹67 / 2.9 km), and `create-order` (booked test
      order #331979 with tracking URL) all green
- [ ] `BORZO_WEBHOOK_SECRET` — the **Callback Secret Key** from the Borzo
      Personal cabinet (⚠️ different from the API token). I pull this from our
      test cabinet myself — no action from you unless the cabinet login is
      company-owned. Our server signs nothing outbound; Borzo sends HMAC-SHA256
      of the callback body with this key in the `X-DV-Signature` header, which
      we verify fail-closed
- [ ] Callback URL registered in the Personal cabinet — I register this myself
      on the test cabinet (I will confirm after deploy):
  - `https://asia-south1-burgonomics-7faa8.cloudfunctions.net/api/dispatch/webhooks/borzo`
- [ ] Confirm which callback types are switched on: **order callbacks**
      (`order_created` / `order_changed`) and **delivery callbacks**
      (`delivery_created` / `delivery_changed`) — we read the nested
      `order.status` / `delivery.status` from both
- [ ] **PRODUCTION enablement** — after integration sign-off, Borzo enables
      the live API by email (`api.in@borzodelivery.com`). Please run the
      production account / payment method as the company's, not mine

What remains to ask Borzo for:
1. Production API access for food delivery, Ahmedabad pickup (2-wheeler;
   `vehicle_type_id` 8 — types 1/2/3/5 are not permitted for new orders)
2. Confirm the same endpoints are live on the production key (base
   `https://robot-in.borzodelivery.com`):
    - `POST {base}/api/business/1.8/calculate-order` (quote — fare at
      `order.payment_amount`)
    - `POST {base}/api/business/1.8/create-order` (book — result at
      `order.order_id`, tracking at `order.points[].tracking_url`)
3. Commercial terms / billing setup on a company-owned cabinet

## 5. Shadowfax — Please contact your Shadowfax account manager / partner desk

Built against the public **Hyperlocal Marketplace** doc
(developer.shadowfax.in/docs/hyperlocal/marketplace). Please share:

- [ ] `SHADOWFAX_API_KEY` — API token, sent as `Authorization: Token <token>`
      (the keys your team shares at onboarding; staging or live)
- [ ] `SHADOWFAX_CLIENT_CODE` — the merchant/client code your team assigns us;
      required in the place-order body (`client_code`) on `POST /api/v2/orders/`
- [ ] `SHADOWFAX_WEBHOOK_SECRET` — shared secret for our callback endpoint.
      Shadowfax callbacks have **no native HMAC**, so please ask the team to
      configure a **custom callback header** (e.g. `x-shadowfax-signature:
      <shared-secret>`) with this exact value; we verify it fail-closed
- [ ] Webhook URL registered with the Shadowfax team (I will confirm after
      deploy):
  - `https://asia-south1-burgonomics-7faa8.cloudfunctions.net/api/dispatch/webhooks/shadowfax`
- [ ] Confirm callback contract: which `order_status` values they post
      (we map `ALLOTTED / ARRIVED / DISPATCHED / ARRIVED_CUSTOMER_DOORSTEP /
      DELIVERED / CANCELLED / CANCELLED_BY_CUSTOMER / RETURNED_TO_SELLER`) and
      whether retries + dedup on `sfx_order_id` follow the documented 7×/5min

What to ask Shadowfax for:
1. Hyperlocal Marketplace API access for the outlets' serviceable areas
   (quote = `PUT /api/v1/order-serviceability/`, book =
   `POST /api/v2/orders/`; prod base `https://api.shadowfax.in`, staging
   `https://hlbackend.staging.shadowfax.in`)
2. Staging/sandbox token if available (else first live quote is the test)
3. `client_code` assignment, custom callback header setup, and webhook URL
   registration (checkboxes above)

## 6. App Stores — Company-owned (I will build, you publish)

- [ ] Apple Developer Program Organization ($99/yr, needs D-U-N-S + legal entity)
- [ ] Google Play Console ($25 one-time)
- Bundle IDs I will build for:
  - Customer: `com.glassdoorsstudio.burgonomics`
  - Partner: `com.glassdoorsstudio.burgonomics.partner`

## 7. Business / Legal — Required before Live payments

- [ ] GSTIN + FSSAI license + current-account details
- [ ] Live website pages: `burgonomics.com/privacy`, `/terms`, `/support`, `/partner/support`
- [ ] Confirm 95%/5% royalty split per branch

---

## What I will handle myself (no action needed from you)

- Firebase Hosting / Functions deploy (`burgonomics-7faa8`), Firestore rules + indexes
- `OTP_HMAC_SECRET`, `BURGONOMICS_ENV`, `MOCK_*` flags, `google-services.json`, `GoogleService-Info.plist`, `VITE_FCM_VAPID_KEY`, `VITE_RECAPTCHA_SITE_KEY`, `VITE_MAPS_API_KEY`, `VITE_FIREBASE_*`
- Self-serve test keys already obtained: **Razorpay test** + **Borzo test token** (verified with `functions/scripts/verify-keys.mjs`)
- Live-wire probe suite `functions/tests/dispatch.wire.test.ts` (Borzo test-env quote + book through the production adapter)
- Borzo cabinet items on our test login: Callback Secret Key, callback URL, callback types
- `RAZORPAY_WEBHOOK_SECRET` (I choose the value when registering the webhook)
- Reviewer logins for Apple/Google: `+91 99999 99999 / 123456` + `reviewer@burgonomics.com`
- Smoke test: test order → KOT print → menu sync → Porter dispatch → OTP delivery

## Where to send

Reply to this email with:
1. Razorpay LIVE table (§1) — test half already done
2. Petpooja Test + Live table (§2)
3. Porter Live table (§3)
4. Borzo production decision (§4) + Shadowfax table (§5)
5. Store account owner email + GSTIN/FSSAI

Razorpay test + Borzo test keys are already in hand and verified. Remaining:
Shadowfax / Porter / Petpooja (company onboarding) + all LIVE credentials.

Thanks!