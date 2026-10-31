# Lane 05 — Third-party integration matrix (run 2026-10-20b)

Purpose: one authoritative row per external contract the product depends on, reconciled with
the code as it exists in the working tree. Provenance is labelled on every fact:

- **[CODE]** — read directly from the repo at the commit/working-tree cited; reproducible by grep.
- **[DOC]** — the vendor's own document, as recorded in `references/**` with its access date.
- **[UNKNOWN]** — no primary vendor evidence on this machine; never asserted.

Reviewed by lane 05 (`ses_ea5c88b2fffeMMzjFL6tYZzs5W`) on 2026-10-20/21 against the root tree at
the lane05 evidence commit (root HEAD was `4be553b` when the survey started and had advanced to
`70a09be` while the bundle was in review; the dispatch code paths below did not change in between),
customer `29fd0e6`, partner `09fe39b`. Every third-party mirror is treated as secondary.

---

## 1. Petpooja POS

| Field | Value |
|---|---|
| Auth | Request-level `app_key`/`app_secret` + `access_token` fields in the JSON body [CODE `functions/src/modules/petpooja/client.ts`]; inbound callback auth is **undocumented** and not signature-verified beyond `PETPOOJA_WEBHOOK_SECRET` presence [CODE `functions/src/config/env.ts:57`] |
| Base URLs | Mapped-restaurant menus `https://qle1yy2ydc.execute-api.ap-southeast-1.amazonaws.com/V1/mapped_restaurant_menus`; save order `https://47pfzh5sf2.execute-api.ap-southeast-1.amazonaws.com/V1/save_order`; update item stock `https://qle1yy2ydc.execute-api.ap-southeast-1.amazonaws.com/V1/update_item_stock` [CODE `client.ts:28,31,34`] |
| Contract source | Petpooja **Apiary V2.1** blueprint is the only vendor spec found so far; the local extracts live in scratch, are **not committed**, and are not vendor-confirmed [DOC `references/petpooja_save_order_api.md`; lane brief trap list] |
| Callback semantics | Callback `orderID` is the **client order id** (ours), not the POS id [DOC + lane brief]; inbound webhook route `api/petpooja/webhook` on `asia-south1` [CODE `functions/src/modules/petpooja/orderPush.ts:11`, `testRunner.ts:663`] |
| Idempotency | Not vendor-documented locally; our side relies on local markers/evidence pins [CODE, `functions/tests/petpooja.evidence-truth.test.ts`] |
| Vendor writes | **Read-only** in this run: no menu/stock write, no re-push (contract hard limit) |
| Known unknowns | Sandbox mapping `31z58ciw0h`, outlet 5439; sandbox returns an S3 fetch error; demo outlet has no addon groups/variations; `in_stock "2"` semantics unknown; 0/5 fulfilment verified [BASELINE §Provider/account state] |
| Status | Sandbox probe execution is **EXTERNAL_BLOCK** (vendor-side S3 error); code contracts are documented, vendor contracts are not verifiable here |

## 2. Razorpay payments / Route

| Field | Value |
|---|---|
| Auth | Key id/secret pair via the Razorpay SDK; secrets never printed [CODE `config/env.ts`], `RAZORPAY_WEBHOOK_SECRET` present in config slot |
| Base URLs | SDK-mediated (`getRazorpayClient()`), no raw HTTP base constant in our code [CODE `razorpay.service.ts:1494`] |
| Signature scheme | Inbound webhook: `x-razorpay-signature` HMAC over the raw body [DOC `references/razorpay_payments.md` §2, labelled verified 2026-10-19]; client confirm HMAC binds `orderId`+`paymentId` [DOC §2] |
| Idempotency | Refund idempotency via `X-Refund-Idempotency` header [CODE `razorpay.service.ts:157`, DOC RZ3]; event-scoped audit ids (`aud_evt_<eventId>`) [DOC §5] |
| Callback semantics | `payment.captured` / `order.paid` is the authoritative confirm channel; `notes.orderId` is the resolution key [DOC RZ1/RZ2, marked IMPLEMENTED — re-verified 2026-10-19] |
| Rate limits | Not recorded in our docs [UNKNOWN] |
| Known unknowns | **Webhook secret missing in local env** and a dashboard error is on record [BASELINE]; live/test money operations are prohibited this run; refund/late-transfer pricing is a human policy decision [CONTRACT §Known external blockers] |
| Status | Provider sandbox verification **BLOCKED** on the missing webhook secret; docs and code are reconciled |

## 3. Borzo rider dispatch

| Field | Value |
|---|---|
| Auth | `BORZO_API_KEY` (+ optional `BORZO_CUSTOMER_ID`) [CODE `config/env.ts:84-85`] |
| Base URL | prod `https://robot-in.borzodelivery.com`, test `https://robotapitest-in.borzodelivery.com`; adapter appends `/api/business/1.8` [CODE `config/env.ts:91`, `dispatch/readiness.ts:26`] |
| Endpoints | `calculate-order` (quote), `create-order` (book), `GET /api/business/1.8/orders?order_id=&status=` (documented status fallback) [DOC `references/delivery_routing.md` §9b] |
| Signature scheme | `X-DV-Signature` = HMAC-SHA256 of the request data with the Callback Secret Key (`BORZO_WEBHOOK_SECRET`); legacy `x-borzo-signature` accepted [DOC §9b, §5] |
| Callback semantics | Order + delivery callbacks; `orderID`/`client_order_id` is our client order id; statuses mapped in `SCOPED_EVENT_ALIASES` [DOC §5, §9b]; non-2xx retried at increasing intervals up to 24h [DOC §9b] |
| Idempotency | Dedup by deterministic park id in `dispatch_webhook_events` [CODE `dispatch.webhooks.ts`] |
| Rate limits | Not stated in the vendor doc read [UNKNOWN] |
| Known unknowns | `X-DV-Signature` encoding (hex vs base64) and exact hashed bytes; whether the apitest account exposes the Integration-tab callback URL/secret; whether a TEST order can dispatch a real rider (`DISPATCH_ALLOW_TEST_BOOKING` stays false) [DOC §9b]. In this workspace `BORZO_WEBHOOK_SECRET` and the registered callback are **absent** [BASELINE] |
| Status | Quote/book contract documented from the vendor doc (2026-10-20, double-sourced); status leg **BLOCKED** without callback registration + secret |

## 4. Shadowfax rider dispatch

| Field | Value |
|---|---|
| Auth | `SHADOWFAX_API_KEY` + `SHADOWFAX_CLIENT_CODE` [CODE `config/env.ts:95-97`] |
| Base URL | `https://api.shadowfax.in` [CODE `config/env.ts:100`] |
| Endpoints | serviceability quote `PUT /api/v1/order-serviceability/`, book `POST /api/v2/orders/` [DOC `references/delivery_routing.md` §1 matrix] |
| Signature scheme | Static shared secret in custom header `x-shadowfax-signature` (no native HMAC; a body HMAC also verifies) [DOC §10/§5] |
| Callback semantics | `ALLOTTED/ARRIVED/DISPATCHED/ARRIVED_CUSTOMER_DOORSTEP/DELIVERED/CANCELLED_BY_CUSTOMER/RETURNED_TO_SELLER` mapped to canonical lifecycle [DOC §5] |
| Idempotency | Same park-id dedup as every provider [CODE `dispatch.webhooks.ts`] |
| Rate limits | Not known [UNKNOWN] |
| Known unknowns | **No verified vendor contract or credentials**; the developer docs URL returns HTTP 404 [CODE `shadowfax.adapter.ts:29`]; the provider stays behind `SHADOWFAX_CONTRACT_VERIFIED` (human-set `"true"` only) [DOC §9] |
| Status | **EXTERNAL_BLOCK** — fail-closed posture only; no live calls this run |

## 5. Porter (manual-hybrid + API lane)

| Field | Value |
|---|---|
| Auth | `PORTER_API_KEY` + `PORTER_CUSTOMER_ID` + `PORTER_WEBHOOK_SECRET` for the API path; **manual paste lane needs no key** [CODE `dispatch/providers/porter.adapter.ts:26-32`, `config/env.ts:73-76`] |
| Base URL | `https://api.porter.in` [CODE `config/env.ts:76`] |
| Endpoints | quote `POST /v1/orders/quote`, book `POST /v1/orders/create` [CODE `porter.service.ts` — the same doc's §1 matrix previously said `/v1/orders`; that drift is fixed in this bundle], webhook `x-porter-signature` HMAC [DOC §5] |
| Signature scheme | HMAC `x-porter-signature` (existing Porter secret) [DOC §5] |
| Callback semantics | Existing Porter status semantics, normalized to the same canonical lifecycle (DR9) [DOC §5] |
| Idempotency | Preclaimed flag avoids double-guard/202 on the same tap [CODE `porter.adapter.ts:121-125`] |
| Rate limits | Not known [UNKNOWN] |
| Known unknowns | Porter refused food-vertical API access → manual-hybrid lane is the operating mode; `PORTER_ENABLED=false` in staging must not demand `PORTER_*` [DOC §0/§9] |
| Status | Manual lane usable without keys; API lane needs a key grant (owner decision) |

## 6. Firebase / FCM / Auth

| Field | Value |
|---|---|
| Region / project | Single Firestore backend in `asia-south1`; callable/web functions under the same region [GEMINI.md §2, CODE `orderPush.ts:11`] |
| Auth | Firebase Auth (phone/email), RBAC custom claims [DOC `references/rbac.md`] |
| Push | FCM topics; loud-alarm semantics [DOC `references/push_notifications.md`]; token ownership pins exist in tests [CODE `functions/tests/notifications.token-ownership.test.ts`] |
| Rules / indexes | Local-only; **no deploy** [BASELINE §Environment] |
| Idempotency | Token unregister and notification paths have ownership guards [CODE `functions/src/modules/notifications/unregisterToken.ts`] |
| Known unknowns | Emulator-only verification; rules deploy and indexes stay local this run [CONTRACT §Safety] |
| Status | LOCAL CODE VERIFIED only; no deployed-config claim |

## 7. Google Maps / geocoding

| Field | Value |
|---|---|
| Presence | **Not integrated.** Geo math is local (`calculateHaversineDistanceKm`, `calculatePorterFare`, `estimatePickupMinutes`) [CODE `functions/src/core/geo.ts` used by `providers/porter.adapter.ts:45-46`] |
| Consequence | No vendor map contract to reconcile; addresses are assembled from real order fields only, never geocoded defaults [CODE `providers/shared.ts:134-153`] |
| Status | N/A (documented as absent, not as unknown) |

---

## Cross-integration drift findings

1. **Ambiguous-book rule (fixed in `references/delivery_routing.md` §3 today).** The doc claimed
   the no-failover ambiguity guarantee for all three dispatch providers. It holds for Borzo and
   Shadowfax; Porter's adapter re-wraps the tagged ambiguity as transient, so the router can fail
   over and book a second courier. Source fix proposed to lane 04 (dispatch) — see the proposal post
   on `fresh-run-2-ownership`.
   - Repro + control: `evidence/lane05/verify-doc-code-drift.mjs`.
   - Positive: 11/11 PASS, `DOC_MATCHES_CODE`, exit 0 (`probe-final-fee8b16.json`, regenerated in a
     clean worktree at the committed SHA).
   - Negative controls (all exit 1, all captured in `counters-final-fee8b16.txt`,
     regenerated deterministically by `run-drift-counters.mjs`): the original universal-claim
     wording re-inserted synthetically (`B1/B2/B3` fail) · paraphrased universal claim appended
     (`B1` fails) · "extends to Porter too" (`B1` fails) · "Porter preserves the ambiguous-book
     contract" (`B1` fails) · deviation note replaced by a false "resolved / now fully compliant"
     claim (`B2/B3` fail) · code fixed but the doc left stale (`A4/B3` fail, run against a
     synthetic patched tree). The pre-fix control is synthetic on purpose: a `git show HEAD:`-based
     control stops being a control the moment this bundle is committed (caught by the post-commit
     gate run, then fixed).
   - Line-number citations for the two concurrently-edited adapters were dropped in favour of
     symbol anchors (`borzoBookAmbiguous()`, the shadowfax create-order throw) after the DeepSeek
     reviewer caught them going stale mid-review — foreign files changed under us.
   - Cross-request caveat added after the final DeepSeek pass: the no-failover rule is per request.
     A plain ambiguous throw still reaches `releaseClaimFailed` (`needsRebook: true`,
     `rebookTrigger: "dispatch_failed"`), and the scheduled auto-rebook worker re-enters the ranked
     walk with an exclusion set derived only from `dispatchProvider` / provider order ids — none of
     which an ambiguous book writes. Staff must reconcile before a rebook is approved.
   - Probe hardening is itself reviewed across rounds: DeepSeek child `ses_ea554f449ffeyywZuMqNBtfMZ8`
     APPROVE_WITH_CHANGES -> applied; GLM child `ses_ea5376817ffeV8IeTjjjSsbxvL`
     VERIFIED_WITH_RESIDUALS -> polarity + bidirectional consistency checks added; final DeepSeek
     pass on the committed bytes (child `ses_ea4a16e42ffeeWNP1e80Z4YeD4`) APPROVE_WITH_CHANGES ->
     negation-evasion hole closed, A5 tightened, misleading hash reference dropped, captures
     regenerated from the committed tree; second GLM pass (child `ses_ea4339fe3ffe1XeExichW4KbB0`)
     VERIFIED_WITH_RESIDUALS -> Borzo provenance corrected to the four COMMITTED throw shapes
     (the duplicate/named-id shapes had been landed by lane 09 commit `b4d43ed`, so the
     "uncommitted" wording was false), A5 gained the mutation-proof A5b pin on the
     release-then-rethrow arm, compliance detection became subject-scoped with scoped negation
     (table-row and double-negative evasions closed) and the synthetic router mutation
     (release arm folded into the failover walk) joined the counter variants.
2. **Porter book endpoint drift (fixed in the same doc).** The same doc's §1 provider matrix listed
   Porter's book call as `POST /v1/orders`; `porter.service.ts` posts to `/v1/orders/create` (and
   `/v1/orders/quote` for quotes). The matrix row now matches the code.
3. **Doc pointer corrected.** The §3 bullet pointed at `providers/shared.ts` as the home of the
   rule; that module holds HTTP classification, address assembly, fare math and mock riders — the
   rule lives in the adapters.
