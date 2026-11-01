# BURGONOMICS — Petpooja POS Integration (Layer 3 Constraint)

> **Reference Specification**: Petpooja POS menu ingestion, live KOT push, item out-of-stock webhooks (instant 86ing), and backoff retries.

> **Reading correction (2026-10-28):** Sections 0–4 contain historical design
> proposals, not a verified description of the current implementation. Use §6
> below and `petpooja_save_order_api.md §§21–22` for the contract and runtime results.
> In particular, do not restore the old envelope/`Discount` object or assume that
> an echoed client order reference guarantees vendor-side retry idempotency.

---

## 0. Research Decisions & Design Constraints (locked — gap review)

> Grounding: Petpooja's documented **Online Ordering API is V2.1.0** (`api-evangelist/petpooja` OpenAPI; Apiary `onlineorderingapisv210`). Two separate API-gateway hosts: **Menu API** (`https://qle1yy2ydc.execute-api.ap-southeast-1.amazonaws.com/V1`, `POST /mapped_restaurant_menus`, auth via `app-key`/`app-secret`/`access-token` **headers**) and **Orders API** (`https://47pfzh5sf2.execute-api.ap-southeast-1.amazonaws.com/V1`, `POST /save_order`, auth via `app_key`/`app_secret`/`access_token` **in the body**). Credentials are **per-restID (per branch)**. The callback model is **outbound to our `callback_url`** (Petpooja calls us) — the documented contract does not describe a shared inbound HMAC secret.

- **P1 — Align order push to the V2.1.0 nested contract**: `pushOrderToPetpooja` must send `{ app_key, app_secret, access_token, orderinfo: { OrderInfo: { Restaurant, Customer, Order, OrderItem[], Tax[], Discount[] } }, udid, device_type }`. The current FLAT body (`order_id`, `customer_name`, `items`, `tax_details`, `total` at top level) is structurally incompatible and must be refactored to the nested `orderinfo` shape.
- **P2 — OrderItem mapping**: On the first pass, map `OrderItem.id` to the Petpooja `itemid` (`product.petpoojaItemId` from menu sync). Confirm the **exact `AddonItem.details[]` / `variation_id` / `variation_name` and `item_tax[]` / `gst_liability` required shape with Petpooja support before implementing add-on + tax mapping** — the public spec shows the fields but not their required contract. Until then, add-ons are not transmitted (known limitation; KOT shows base item + base price).
- **P3 — restID, not the Firestore doc id**: Both menu sync and order push must use `branches/{branchId}.petpooja.restId` as the restaurant identifier. The current code passes the branch **doc id** as `rest_id`, which targets the WRONG restaurant whenever the two differ.
- **P4 — Per-branch webhook auth + product scoping**: `verifyPetpoojaAuth` must resolve the calling branch's **stored** `appKey`/`accessToken` (by `restID` in the webhook body), not one global `config.petpooja.*` set. Unknown `restID`s are rejected. Synced menu products must be **namespaced per branch** (e.g. `products/branches/{branchId}/items/{itemid}`) so an 86 at one branch never flips another branch's item, and a branch's stock event is attributed correctly.
- **P5 — Idempotency via `clientOrderID`**: V2.1.0 has **no explicit idempotency field**; the returned `clientOrderID` (+ Petpooja `orderID`) is the dedup hook. Populate `clientOrderID` with our order id so Petpooja can dedupe a retried push. The retry worker (`petpoojaRetryCount <= 3`) must therefore re-send the SAME `clientOrderID`, otherwise a lost-response success re-pushes and **double-prints the KOT**.

---

## 1. Credentials & Configuration
Each branch stores credentials under `branches/{branchId}.petpooja`:
```json
{
  "restId": "REST_AHMEDABAD_01",
  "appKey": "pp_key_...",
  "appSecret": "pp_sec_...",
  "accessToken": "pp_token_..."
}
```
- **`restId` is the authoritative restaurant scope (P3)**: all menu/order/webhook calls must use `petpooja.restId` for a branch, never the Firestore doc id, and each branch's credentials are resolved from THIS stored object — not a single global `config.petpooja.*` set (P4).
- **Auth differs by API surface (P1)**: Menu/restaurant calls authenticate with `app-key`/`app-secret`/`access-token` **headers**; `save_order` sends `app_key`/`app_secret`/`access_token` in the **body**.

---

## 2. Menu Sync & Pricing Truth
- **Hourly Cron Worker (`syncMenu`)**: Fetches menu categories and items from the Menu API **`/mapped_restaurant_menus`** per active branch using that branch's stored credentials (P3), and writes items to the **branch-scoped** `products/branches/{branchId}/items/{itemid}` path (P4).
- **MRP Truth**: Item MRP is authoritative from Petpooja. Client UI displays cached data; Cloud Functions recompute authoritative totals at checkout.
- **Pre-Configured Items**: All burgers, sides, and drinks are ingested without modifier builders — except add-ons/variations whose exact `AddonItem` contract is still pending Petpooja confirmation (P2).

---

## 3. Order Push & Idempotency
- Triggered immediately upon payment capture (`payment.status == 'paid'`).
- POSTs to the Orders API **`/save_order`** with the nested V2.1.0 `orderinfo` payload (P1) and the branch's `restId` (P3).
- **Idempotency (P5)**: Each push carries our order id as `clientOrderID`; re-sends reuse the SAME `clientOrderID` so Petpooja dedupes. A `success == "1"` response stores Petpooja's `orderID` on `orders/{orderId}.petpooja`.
- **Retry Queue**: In case of temporary Petpooja gateway failure, backoff retries occur at 1 min, 5 mins, and 30 mins (`pending_petpooja_retry`), each re-sending the identical `clientOrderID` so a lost-response success cannot double-print a KOT.
- Orders are visible immediately in Partner POS regardless of Petpooja status.

---

## 4. Instant 86ing & Post-Order Rejections
- **Stock Webhook (`petpoojaStockWebhook`)**: Authenticated per-branch via the calling branch's stored `appKey`/`accessToken`, attributed by `restID`, and unknown `restID`s rejected (P4).
- When Petpooja marks an ingredient or item out-of-stock, the Cloud Function updates the **branch-scoped** product (`products/branches/{branchId}/items/{itemid}`) `.available = false` instantly (P4) — never a shared/global product, so one branch's 86 cannot affect another branch.
- **Post-Checkout Auto-Refund**: If an item is 86ed during cooking, the branch manager can adjust the order, automatically triggering a partial refund via Razorpay.

## 5. Callback Trust Boundary and Remaining Exposure

The documented order callback does not provide an inbound HMAC contract. The
compatibility allowance in `functions/src/core/middleware.ts` applies only to
`/petpooja/webhook`; payload shape is not authentication. Stock and menu endpoints
must not inherit this allowance.

An uncredentialed callback must resolve its `restID` to a linked branch and match
the order's current branch. It must not set the POS acceptance markers that stop
outbound retries, enqueue a refund, or rewind a terminal order. Scope, replay,
terminal and refund decisions must use the same fresh transactional snapshot.
The regression owner is `functions/tests/petpooja.status-callback-race.stress.test.ts`.

Remaining exposure: a caller who knows a linked restaurant ID and an internal
order ID may still forge a permitted non-terminal kitchen status or create a
review row. These identifiers are not secrets and do not prove origin. Keeping
money-moving effects blocked does not eliminate status spoofing or review-queue
noise; operators must not treat an uncredentialed review row as provider proof.

Before live rollout, the integrations and infrastructure owners must resolve
provider authentication with Petpooja: an agreed signed callback contract or a
verified source restriction appropriate to the provider. This limitation is
recorded for that decision, not as approval to weaken authentication on other
routes. The stress sweep changes no deployed credentials or infrastructure.

## 6. Current vendor-document interpretation — 2026-10-28

- The supplied corrected attachment requires credentials at the root and
  `orderinfo: { OrderInfo: { Restaurant, Customer, Order, OrderItem, Tax }, udid,
  device_type }`. Each section carries its documented `details` wrapper. There
  is no separate `Discount` object or legacy duplicate envelope member.
- The request's client reference is `Order.details.orderID`. Save Order returns
  `clientOrderID` as an echo; the callback's `orderID` is also the client reference.
  The documentation does not promise provider duplicate suppression for repeated
  submissions. Reuse a stable client reference, but retain local serialization,
  accepted markers and manual reconciliation after ambiguous transport outcomes.
  Do not blindly replay an uncertain relay based on old P5's dedup assumption.
- Item prices include selected add-ons/variation price; `final_price` is per unit
  less item discount. Order discount fields are separate. The item-local variation
  child item ID and variation-master ID are distinct mappings, not interchangeable
  numeric strings. Fresh vendor configuration and end-to-end selection mapping
  are both required before the blocked scenarios can be resubmitted honestly.
- POS `total` means restaurant due, not automatically customer grand total.
  Menu `gst_type` defines tax ownership. The isolated candidate still hard-codes
  restaurant liability, copies grand total and populates COD `collect_cash` with
  third-party delivery enabled; these gaps are not resolved by its passing shape
  and paise-conservation tests. Full details are in the Save Order reference §21.
- Sandbox Guide p.2 supports optional Client Authorization and Headers
  Configuration. No standard inbound HMAC algorithm is specified by these docs.
  §5's remaining spoofing exposure is real; confirm/enforce the provisioned trust
  mechanism rather than treating an undocumented signature as permission for
  unauthenticated production callbacks.
- The PDF and public Apiary Save Order hosts conflict. Confirm the host provisioned
  for this sandbox instead of changing endpoints or sending exploratory orders.
  No sandbox submission, deployment or production approval is authorized here.

### 6.1 Subsequent authorized correction and runtime proof

The preceding candidate-gap and authorization statements are historical.
The user subsequently authorized demo configuration, five resubmissions and a
specific demo menu publication to the existing webhook. The isolated candidate's
GST ownership, restaurant due and cash-instruction corrections passed its gates;
all16 application/test fingerprints matched those gates before live preparation.

On 2026-10-28, five corrected cases were each saved once at the Staging account's
confirmed `qle1yy2ydc` endpoint. All returned HTTP200/success1 and were separately
verified in Order Listing/detail, with real variation child/master pairs and
add-on group membership. They remain **Waiting For Acceptance**. No status action,
physical printing, callback completion or production approval is claimed.

The approved menu push returned webhook HTTP503, not successful synchronization.
Its exact generated-menu request supplied current services/vendor GST ownership,
exclusive pricing, item/variant/add-on identities and explicit charge-tax flags.
Do not replace that captured provenance with hardcoded scenario ownership, and do
not infer the deployed app can ingest or relay these selections end-to-end.
See `petpooja_save_order_api.md §22` for IDs, financial results, evidence paths
and unresolved production gates. No email was sent and no code was deployed.
