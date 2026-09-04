# BURGONOMICS — Production Runbook

> Single reference for going live and staying live. Last updated: 2026-09-04.
> Rule: **Petpooja is the only POS.** Everything else is a dev fallback.

## 1. System map

| Part | Path | Deploy target | Gate |
|---|---|---|---|
| Delivery / Customer app | `burgonomics-foundation-core/` | Firebase Hosting `burgonomics-app` → `dist/mobile` | `npx tsc --noEmit && npm run build` |
| Partner / POS Ops app | `burgonomics-partner/` | Firebase Hosting `burgonomics-partner` → `dist` | `npm run typecheck && npm run build` |
| Backend API + schedulers | `functions/` | Cloud Functions `asia-south1`, `api` entrypoint | `npm test && npm run build` |
| DB + rules | `firestore.rules`, `firestore.indexes.json` | `firebase deploy --only firestore` | — |
| Legacy (do not deploy) | `_archive/`, `*/netlify/functions` | — | reference only |

Firebase project: **`burgonomics-7faa8`** (region `asia-south1`).
API base (both clients): `https://asia-south1-burgonomics-7faa8.cloudfunctions.net/api`
(override: `VITE_FUNCTIONS_API_URL`. Health: `GET /health`.)

### Planned: Blaze (not started)
Third app (rider/delivery-ops). When created: same Firebase project, reuse
`orders` contract (`utils/orderContract.ts` pattern), add its hosting target
to `firebase.json`, add a row to this table.

## 2. Key inventory — where every credential comes from

### 2a. Server (`functions/` env — `firebase functions:config` / GCP Secret Manager; never in client bundles)

| Variable | From | Format | Used by |
|---|---|---|---|
| `PETPOOJA_APP_KEY` | Petpooja team via `developerapi.petpooja.com` | 32 chars | save_order / fetch menu |
| `PETPOOJA_APP_SECRET` | Petpooja team (same panel) | 40 chars | save_order body + webhook HMAC verify |
| `PETPOOJA_ACCESS_TOKEN` | Petpooja team (same panel) | 40 chars | `Authorization: Bearer` |
| `PETPOOJA_MENU_URL` / `PETPOOJA_ORDER_URL` | defaults OK | AWS execute-api URLs | menu / order push |
| `RAZORPAY_KEY_ID` / `KEY_SECRET` / `WEBHOOK_SECRET` | Razorpay dashboard | `rzp_live_…` | payments; deploy **refuses** to boot in production on mock keys (`assertProductionKeys`) |
| `PORTER_API_KEY` / `PORTER_CUSTOMER_ID` / `PORTER_WEBHOOK_SECRET` | Porter Enterprise onboarding (`porter.in/api-integrations`, ~1 business day, `help@porter.in`) | — | quote/book dispatch |
| `FIREBASE_SERVICE_ACCOUNT` / `FIREBASE_PROJECT_ID` | GCP console | JSON | admin SDK |

Mock auto-detection (server): any key missing or containing `mock` ⇒ that
integration runs in mock mode (`functions/src/config/env.ts` → `config.mock.*`).
No code change needed to flip — just set real keys and redeploy.

### 2b. Clients (`.env`, Vite — safe to ship, no secrets)

| Variable | Meaning |
|---|---|
| `VITE_PETPOOJA_ENABLED=true` | use live Petpooja gateway (default `false` = offline mock) |
| `VITE_PETPOOJA_PROXY_URL` | override Functions base (default derived from project id) |
| `VITE_FUNCTIONS_API_URL` | override Functions base (Partner) |
| `VITE_PAYMENTS_API_BASE_URL` | payments base (Delivery) |
| `VITE_RAZORPAY_KEY_ID` | publishable key only (`rzp_live_…` in prod) |
| `VITE_FIREBASE_*` / `VITE_FIREBASE_CONFIG` | Firebase web config (browser-public by design) |

## 3. Go-live checklist (in this order)

1. **Keys**: Petpooja key set → Functions env. Porter key set → Functions env.
   Razorpay live keys → Functions env + client publishable key.
2. **Link outlets** (§5): set `stores/{id}.partnerBranchId` + confirm restIDs.
3. **Deploy backend**: `firebase deploy --only functions,firestore` from repo root.
4. **Verify backend**: `GET …/api/health` → `{"status":"healthy"}`.
5. **Flip clients**: `VITE_PETPOOJA_ENABLED=true` in both apps → rebuild → deploy hosting:
   `firebase deploy --only hosting:burgonomics-app,hosting:burgonomics-partner`.
6. **Smoke test**: place a test order → KOT prints (Partner Orders), menu sync pulls
   (Partner Dashboard → Petpooja sync), Porter dispatch assigns a rider.
7. **Watch**: Functions logs, `petpooja_sync_logs`, `petpooja_webhook_logs`,
   Partner Admin → Petpooja dashboard (outbox depth must be 0).

Rollback: set flag back to `false`, redeploy clients (mocks resume instantly).

## 4. Petpooja contract reference (verified vs official V2.1.0 docs)

- Docs: `onlineorderingapisv210.docs.apiary.io`. All APIs are POST.
- Menu base `https://qle1yy2ydc.execute-api.ap-southeast-1.amazonaws.com/V1`
  (`/mapped_restaurant_menus`); Orders base
  `https://47pfzh5sf2.execute-api.ap-southeast-1.amazonaws.com/V1` (`/save_order`).
- Order auth: `Content_key: <app_key>` + `Authorization: Bearer <access_token>` headers,
  `rest_id` per outlet; body carries `app_key/app_secret/access_token`.
- KOT callback statuses: `-1` cancelled, `1/2/3` accepted, `4` dispatch (+ rider),
  `5` food ready, `10` delivered. Handled by `POST /petpooja/webhook`.
- Stock toggles from Petpooja: `POST /petpooja/stockWebhook` (86-ing).
- ⚠️ If the Petpooja team issues different endpoint paths with the keys, update
  `PETPOOJA_MENU_URL` / `PETPOOJA_ORDER_URL` only — no code changes.

## 5. Outlet linking (store ↔ branch) — ops procedure

Delivery (`stores/*`) and Partner (`branches/*`) were seeded independently.
Until linked, customer orders appear only under **All Outlets**.

1. In the Petpooja panel, confirm Delivery `petpoojaRestId` and Partner
   `petpoojaStoreId` are the same physical outlet.
2. Set Firestore `stores/{storeId}.partnerBranchId = "{branchId}"`.
3. Add the same pair to Partner `utils/storeBranchRegistry.ts` with
   `verified: true` (covers historical orders lacking `branchId`).
4. Verify: branch-scoped Orders/KDS/Analytics show the outlet's orders.

## 6. Porter reference (implementation matches the real API)

- Enterprise: `porter.in/api-integrations`. Covers Ahmedabad, Surat, Vadodara
  (all brand cities). Activation ~1 business day, training included.
- API: `https://api.porter.in`, `x-api-key` header, `request_id` + `pickup_details` /
  `drop_details` with `contact_details{name, phone_number}`, `2_WHEELER`.
  Mirrored 1:1 in `functions/src/modules/porter/client.ts`.
- Wallet is prepaid — top up before volume. Webhook secret → `PORTER_WEBHOOK_SECRET`.

## 7. GitHub (wired 2026-09-04)

| Local | Remote | Branch pushed |
|---|---|---|
| `burgonomics-foundation-core/` | `github.com/pandejesal/Burgonomics-App` | `main` |
| `burgonomics-partner/` | `github.com/pandejesal/Burgonomics-Partner` | `feat/partner-device-smoke` |
| repo root (functions, rules, docs) | `github.com/pandejesal/Burgonomics` | `master` |

All remotes use clean `https://github.com/…` URLs (no tokens on disk —
`gh` credential helper handles auth). repos are public; make private via
`gh repo edit <name> --visibility private` if desired.
- ⚠️ **STILL REQUIRED — rotate the classic token**: it was removed from disk
  but is still valid on GitHub (and appeared in a chat log). GitHub → Settings
  → Developer settings → Personal access tokens → revoke the `ghp_…` token.
  Note: the `gh` CLI session token in this environment cannot push (read-only
  scope) — after revoking, run `gh auth login` once to restore push access.

## 8. Debugging rules (why fallbacks were removed)

- Production never shows fake data: seed catalogs/orders/stats are dev-only.
  Empty backend ⇒ empty/error states, never invented numbers.
- Every external call fails loudly (toast + log + persisted outbox for orders).
- `petpooja_sync_logs` / `petpooja_webhook_logs` are the first place to look.

## 9. Research findings & remaining gaps (4 parallel lanes, 2026-09-04)

**Applied from lanes:**
- Razorpay: `partial_payment:false` on orders (Route requirement), boolean
  `reverse_all`/`on_hold`, `transfer.processed/failed/reversed` webhook handlers,
  dedicated `OTP_HMAC_SECRET`, canonical object order-status writes everywhere.
- Petpooja: correct AWS fallback URLs, `success:"1"` response parsing,
  `callback_url` on save_order (KOT updates flow back), canonical object status
  on Petpooja webhooks.
- Porter: payload interface corrected (`street_address1`, state/pincode/country,
  structured instructions); dead duplicate `bookingService.ts` deleted (it held a
  `"1234"`-default OTP bypass — the live verifier throws when no OTP exists).
- FCM: server templates now target channels that actually exist on device
  (`burgonomics_orders_channel` + bundled `new_order` sound); `dispatchFCM`
  returns the real outcome.
- Indexes: added `support_tickets`/`tickets (branchId,status,createdAt)` and
  `orders (customerId,createdAt)` composites.
- Seeds are dev-only: production shows honest empty/error states (Runbook §8).

**Verify-live list (weak public evidence — confirm with live keys, do NOT code against yet):**
- Porter quote endpoint shape, webhook header name/algorithm, tracking URL
  format, cancel endpoint. No sandbox exists — first live booking is the test.
- Petpooja nested `OrderInfo.details` payload claim (third-party mirror only);
  current flat shape is used consistently in 3 places — confirm via Petpooja's
  Postman collection before changing.
- KOT numeric callback codes (community consensus + in-repo simulation agree).

**Still open:**
1. Menu pipeline (3 collections!): Partner reads `menu/{branchId}/items`,
   Delivery reads `petpooja_products`, server sync writes `products`.
   Unify on one path with `petpoojaItemId` as the join key.
2. Backfill: pre-bridge orders lack `customerId/createdAt/branchId` (script TBD).
3. Remove `*/netlify/functions` once Firebase Functions serve all traffic.
4. App Check enforcement, web-push client, branch-topic subscriptions (FCM gaps).
5. Blaze app: not started (§1).
