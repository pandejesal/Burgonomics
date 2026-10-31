# Petpooja, Borzo and Shadowfax — supplied-document contract review

**Reference review only. No app code, credentials, provider calls or deployment.** Inputs are user-supplied local documents, read through conservative redacted views. Exact bytes, hashes, encodings and redacted-view hashes are in [local-inputs.json](local-inputs.json) and [shadowfax-inputs.json](shadowfax-inputs.json); raw originals were not copied into the repository.

| Provider | Supplied file | Bytes / lines | Status |
|---|---|---:|---|
| Petpooja | `PETPOOJA API Docs.txt` | 254,679 / 9,950 | Reviewed; titled **Petpooja Online Ordering APIs — V2.1.0** |
| Borzo | `Borzo API Docs.txt` | 223,039 / 7,246 | Reviewed; endpoints documented as **Business API 1.8 (India)** |
| Shadowfax | `Shadowfax - Official Rider Booking API Docs.txt` | 37,208 / 2,091 | Reviewed; **Hyperlocal** rider booking, staging and production bases |
| Shadowfax analysis | `Shadowfax - Integration Gap Analysis.md` | 4,242 / 89 | Supplied analysis, not a vendor document; adapter claims still need source verification |
| Shadowfax (rejected) | `ShadowFax API Docs.txt` | — | **Excluded — user identified it as an AfterShip tracking wrapper, not a rider booking contract.** Not used for any endpoint, auth or booking claim |

A document that names endpoints is not a signed merchant contract. Nothing below establishes that Burgonomics holds these credentials, that an outlet is enabled, or that any endpoint currently works.

## Petpooja V2.1.0 — what the document actually supports

| Item | Documented fact | Consequence for the plan |
|---|---|---|
| Relay endpoint | `POST .../V1/save_order` | Server-side only. A development host in the sample is not the production host |
| Credentials | `app_key` (32 chars), `app_secret` (40), `access_token` (40) sent **in the request body**, plus `restID` per restaurant | Secrets never enter either client bundle, logs, screenshots or the mockup packet. Environment/config supply them server-side |
| Required fields | Credentials, `restID`, `device_type`; also customer/order/order-item/add-on/tax/discount objects | `device_type` is case-sensitive per the document. Mapping must fail closed on missing outlet/item/tax data |
| Initial order state | Order arrives in PoS **Pending** until the restaurant accepts or rejects | An HTTP success is transport only. Payment capture ≠ restaurant acceptance ≠ KOT |
| Status callback | Integrator supplies `callback_url` on every save-order request; PoS posts `restID`, `orderID`, `status`, `cancel_reason`, prep/delivery times, rider details, `is_modified` | Callback is the documented source for accepted/dispatch/ready/delivered. Status codes: `-1` cancelled, `1/2/3` accepted, `4` dispatch, `5` food ready, `10` delivered |
| Integrator → PoS status | Only cancellation (`-1`) is documented through `update_order_status`; `orderID` is marked deprecated there and `clientorderID` is required | The app must not push arbitrary lifecycle states to Petpooja. Accepted/ready/delivered come from restaurant callback, not our own write |
| Rider webhook | Separate `rider_status_update` webhook exists for self-delivery rider information | Relevant to delivery status, but must not be confused with a courier booking API |
| Response shape | `success` boolean/flag plus `message`; documented 200 and 400 responses | **No documented idempotency contract, duplicate-order rejection, or status-lookup endpoint** in this file |
| Callback authentication | The supplied document does **not** specify a signature or shared-secret verification for the order-status callback | Do not invent an HMAC scheme. Treat callbacks as unauthenticated shaped data until the vendor supplies a supported verification/lookup method |

Two consequences follow directly. First, the existing plan's distinction between **transport acceptance** and **restaurant/KOT acceptance** is supported by the vendor's own wording, not just our caution. Second, because this document defines no callback signature and no duplicate-send semantics, retry and unverified-callback handling must be designed defensively and confirmed with the vendor — not asserted from this file.

The document's own changelog adds `dc_tax_percentage`, `pc_tax_percentage`, `tax_inclusive` and item `tax_percentage` fields. That does not resolve Burgonomics' current GST-inclusive/inclusive-plus-GST contradiction; finance/vendor-approved per-outlet semantics are still required.

## Borzo Business API 1.8 — what the document actually supports

| Item | Documented fact | Consequence for the plan |
|---|---|---|
| Hosts | Test `https://robotapitest-in.borzodelivery.com/api/business/1.8`, production `https://robot-in.borzodelivery.com/api/business/1.8` | Country/version are documented as India/1.8. Production use needs an approved merchant account, not a test token |
| Authentication | Every request carries `X-DV-Auth-Token` | Merchant token stays server-side. A missing/invalid token is a configured failure, never a mock success |
| Price vs book | `calculate-order` validates parameters and quotes; `create-order` places the booking | Two distinct steps: a quote is not a booking, and a booking is not a delivery |
| Required booking data | `matter` (max 5,000 chars), `points` list, address (max 350 chars), contact person, vehicle `type`/`vehicle_type_id`, weight rules, payment method | We must supply real outlet/customer drop-off data and a declared vehicle/weight; missing data fails closed |
| Client identity | `client_order_id` is an accepted order/point field | Useful as our own correlation key, but the document does not promise it deduplicates server-side |
| Duplicate handling | Error `order_is_duplicate` — “Duplicate order rejected” | Evidence that Borzo may reject a repeat, not proof of which fields form the dedupe key. Never infer success from this error |
| Callbacks | Optional order-change and delivery-change callbacks to a configured URL; `POST` JSON/UTF-8 | Callback configuration lives in the Borzo cabinet, not per request |
| Callback auth | `X-DV-Signature` header; HMAC using **SHA256** and the cabinet **Callback Secret Key** | Implement only after the vendor confirms the exact preimage and encoding. A guessed preimage produces a false sense of security |
| Callback retry | Non-2XX is retried with increasing intervals for **24 hours**, then an email notice | Our handler must be idempotent and fast; a timeout is not a cancellation |
| Events | `order_created`, `order_changed`; separate delivery callbacks for delivery changes | Booking changes and delivery progress are different entities; do not collapse them into one status |
| Statuses | Examples include `new`, `available`, `active`, `delayed`, `completed`, `canceled`; edit is allowed only in `new`, `available`, `active`, `delayed` | Terminal states must be respected; a late callback must not resurrect a completed/cancelled order |
| Cancellation | `cancel-order` documented for `new`, `available`, `active` or `delayed`; **not possible once a courier has visited any address**; cancelled examples present | Cancellation needs its own durable attempt/failure record and a customer-facing "too late to cancel" path. A cancel request is not proof the rider stopped |

### Two documentary inconsistencies to resolve before coding

1. The `invalid_api_version` error text still says available versions are `1.0, 1.1 and 1.2`, while the documented base path is `1.8`. The changelog runs through 1.8. Treat the error string as stale documentation and confirm the live version with Borzo support.
2. “HMAC using SHA256” does not, in the extracted text, state whether the signature is hex or base64, or whether the preimage is the raw body, a timestamp+body, or a canonicalised payload. The supplied PHP sample would settle it only if read exactly; do not port a guess.

## Shadowfax Hyperlocal — what the official document supports

| Item | Documented fact | Consequence for the plan |
|---|---|---|
| Product boundary | **Hyperlocal Marketplace**, explicitly not AfterShip tracking and not Shadowfax360 parcel | This is the rider-booking contract the dispatch adapter needs; the rejected file was a different product |
| Environments | Staging `https://hlbackend.staging.shadowfax.in`, production `https://api.shadowfax.in`; separate credentials | Staging proof does not authorise production booking. Credentials are issued by Shadowfax |
| Authentication | Token in the `Authorization` header, or OAuth2 client credentials exchanged for a **24-hour Bearer token**; production requires **IP whitelisting** | Server-side only. A 24-hour token needs refresh-with-margin handling; an expired token must fail closed, not silently retry a booking |
| Serviceability | `PUT` check; create the order only when `serviceable: true`, **within a couple of minutes of the check**; documented rate limit 1,200 requests/minute | A quote is short-lived. A stale serviceability result must trigger a re-check, never a blind booking |
| Place order | `POST /api/v2/orders/` with merchant `client_code`, order/pickup/drop details and order items | Server-side booking with our own client order identity retained |
| Status | `GET /api/v2/orders/{sfx_order_id}/status/`; rider location refreshed about every 60 seconds | Polling is possible but callbacks are the primary path; do not present a 60-second-old position as live tracking |
| Cancellation | `PUT /api/v2/orders/{sfx_order_id}/cancel/` with `reason` (max 128 chars) and `user` (`Customer`, `Seller`, `Rider`) | A documented cancel API exists. Cancellation needs its own durable record and a possible "too late" outcome |
| Dispatch ready | `PUT /api/v2/orders/{coid}/dispatch-ready/` with `shipment_ready_timestamp`, keyed by client order ID | Food-ready must be signalled separately from booking; omitting it can delay pickup |
| Callbacks | `POST` or `PUT` to a configured URL, optional custom headers, JSON, UTC timestamps, expected `200`/`201` | Callback configuration is provisioned with Shadowfax, not invented per request |
| Callback retry | Every **5 minutes, up to 7 attempts** | Handlers must be fast and idempotent; a timeout must not be read as a failed delivery |
| Callback idempotency | Required; duplicate callbacks must return success, or subsequent updates may be blocked | Deduplicate on provider event identity and return success for repeats |
| Callback events | `ALLOTTED`, `ARRIVED`, `DISPATCHED`, `ARRIVED_CUSTOMER_DOORSTEP`, `DELIVERED`, `CANCELLED`, `CANCELLED_BY_CUSTOMER`, `RETURNED_TO_SELLER` | Terminal and cancellation events must not be resurrected by a late out-of-order callback |
| Callback authentication | The official document describes a configured URL with **optional custom headers**; it does **not** document an HMAC or native signature header | The current static-secret `x-shadowfax-signature` check is a private arrangement unless Shadowfax confirms it. Do not call it vendor-native or treat it as proof of authenticity |
| Rider-location callbacks | Separate configured URL; `order_id` there is the **client** order ID (COID), not `sfx_order_id` | A distinct handler and key mapping are required; mixing the two IDs would attach location to the wrong order |
| Sandbox | Documented sandbox transition APIs; the supplied analysis flags that its explicit no-real-rider wording covers forward/reverse/exchange, with Hyperlocal to be confirmed | Written Hyperlocal staging confirmation is still required before allowing any booking |

### Adapter gaps identified by the supplied analysis

These are analysis claims about our source, not vendor statements. They still need source-level verification against an approved baseline.

1. **Cancellation is not wired.** `dispatch.router.ts` reportedly treats Borzo and Shadowfax cancellation as `manual-required` and says no cancel API is documented; both now have documented cancel endpoints. It also reportedly releases the local binding before the courier is actually cancelled — which could leave a rider travelling to the store.
2. **Dispatch-ready is never sent.** `PUT /api/v2/orders/{coid}/dispatch-ready/` is unused, so Shadowfax is never told the food is ready.
3. **Rider-location callbacks are unhandled.** Only order-status callbacks are processed.
4. **Signature wording overclaims.** A static secret is described as a Shadowfax signature although the vendor documents no such header.
5. **Hyperlocal sandbox is unconfirmed.** Forward/reverse/exchange no-real-rider wording does not automatically cover the Hyperlocal product.
6. **Account setup is missing.** Staging credentials, the Postman collection, merchant `client_code`, callback URLs and IP whitelisting are Shadowfax-provisioned and reportedly absent from `functions/.env`.

The analysis also notes the same cancellation gap for Borzo. That is consistent with the Borzo document's `cancel-order` method and the “no cancel after a courier visit” rule above.

## How this maps to the existing work packages

- **B3 (POS send/retry/reconciliation)** gains vendor support for: pending-until-accepted, callback-driven acceptance, cancel-only outbound status, and the absence of documented idempotency. It does not gain permission to resend ambiguous sends.
- **B6 (dispatch)** now has documented contracts for **both** Borzo and Shadowfax Hyperlocal: authentication, serviceability/quote, booking, status, cancel, dispatch-ready and callbacks. It also has three specific gaps to repair (cancellation wiring, dispatch-ready signal, rider-location handler) and a signature claim to stop overstating. It still has no merchant credentials, no IP whitelist and no confirmed Hyperlocal sandbox behaviour.
- **D4/P2 (notes and status copy)** can keep “payment received, awaiting restaurant confirmation” and must not show “accepted”, “preparing”, a KOT claim or an ETA before the corresponding POS callback/operator evidence.
- **Reelo** stays a separate CRM beside Petpooja POS. The outlet owner reports that **Petpooja bills already sync into Reelo for these outlets**, so the app must not upload the same bill again. Launch scope is settled by **D31–D33**: no loyalty balance or redemption UI, Petpooja the only bill producer, existing balances preserved. Whether new Grill Coins earning stops at launch remains **OPEN-EARN-1**. See [the Reelo feasibility note](../../07-REELO-FEASIBILITY.md).

## Missing before implementation

1. **Shadowfax account evidence**: staging credentials, merchant `client_code`, callback URLs and custom headers, production IP whitelisting, and written confirmation that Hyperlocal staging cannot dispatch a real rider.
2. **Vendor confirmation** of Petpooja callback authenticity/lookup, duplicate-send behaviour, production host, and the KOT/print acknowledgement path.
3. **Vendor confirmation** of the Borzo signature preimage/encoding and current API version, plus merchant/account entitlement in India.
4. **Vendor confirmation** of Shadowfax callback authentication, since the official document describes optional custom headers rather than an HMAC, and of `dispatch-ready` expectations during normal operations.
5. **Burgonomics credentials and mappings**: `restID`, app key/secret/access token custody, outlet item/variation/add-on/tax/instruction mappings, Borzo token and callback secret, Shadowfax credentials — supplied through the owner-approved secret channel, never in chat or the repository.
6. **Reelo**: owner reports bill sync is live. Still needed: dated per-outlet confirmation, whether Reelo is already awarding points, which system owns the spendable balance, and approval before any app-side upload, balance display or Grill Coins migration.
7. **Human approvals**: design revision, Delivery/Partner baseline custody, finance/tax semantics, and supervised sandbox scope.

No endpoint in these documents was called. No order was sent, no rider booked, no credential read, no source file edited, no test/build run, and no commit, push, deployment or store action occurred. Original 3 November RC / 8 November public targets remain unchanged and are not guaranteed by this review.
