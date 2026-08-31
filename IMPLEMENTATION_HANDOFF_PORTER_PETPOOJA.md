# IMPLEMENTATION HANDOFF — Porter + Petpooja + Razorpay + Firebase Gap Closure

> **For**: the implementing agent/AI.
> **Source of truth**: `references/delivery_porter.md` (§0 decisions **D1–D6**), `references/petpooja_pos.md` (§0 decisions **P1–P5**), `references/razorpay_payments.md` (§0 decisions **RZ1–RZ4**), and `references/firebase_security.md` (§0 decisions **F-PAY / F-RBAC / F-COUPON / F-TOKEN**). This document is the executable task list mapped to concrete code.
> **Watchlist**: `references/known_issues.md` **R6–R22** track each item.
>
> **Mandatory verification gate (this repo's functions service):**
> ```bash
> npm test && npm run build
> ```
> Run this after **each** completed task, not just at the end.

---

## Context (read first)

Two 3rd-party API integrations and the payment layer have design + code gaps discovered during research against their *documented* public contracts:

- **Porter** — quote-based only; no coverage endpoint; intra-city; bike-only. The current code silently falls back to a static rate card on any quote failure, which violates the locked "fail closed" rule.
- **Petpooja** — documented Online Ordering API is **V2.1.0**; the current code posts a FLAT payload that is structurally incompatible with the documented nested `/save_order` contract, and never sends the `clientOrderID` dedup hook.
- **Razorpay** — the server-side `payment.captured` webhook is effectively **dead** (our `orderId` is never put in the payment `notes`, so the handler no-ops), leaving only a client-chokeable confirm path; both confirmation channels have no shared dedup (double Route transfer / double KOT risk); and `autoRefund` neither checks the `captured` state nor uses refund idempotency.
- **Firebase** — `firestore.rules` has rules-layer trust-boundary gaps: branch staff can mark orders paid without a real capture (bypassing the webhook authority), branch owners can repoint the Route payout / mutate POS credentials, coupon + offer tables are publicly readable despite server-side-only validation, and a vestigial `device_tokens` block gives a false sense of security.

All decisions below are **locked** by the user (already grilling-confirmed). Implement as specified — do not re-open the design trade-offs.

---

## PART A — PORTER

### A1. `getDeliveryQuote` — fail closed (R6, D1/D2)
**File**: `functions/src/modules/porter/porter.service.ts` (~lines 85–102)

**Current bug**: any live-quote failure falls through to the static rate card (`calculatePorterFare`), returning `source: "porter_standard_rate_card"`. This can charge a customer an unverified price.

**Required behavior**:
1. Inspect the fetch response **`status`** and error body. Map to two distinct outcomes:
   - **`not_serviced`** — address genuinely outside Porter coverage / branch radius (4xx / address-unsupported / city-not-covered). This is a *deterministic* verdict.
   - **`transient_failure`** — network error, 5xx, timeout. This is *retryable* and *not* a verdict.
2. **Never** return the static rate card as a quote result. Remove the `calculatePorterFare` fallback path.
3. Return a structured result carrying the verdict (`not_serviced` | `transient_failure` | `serviced` + fare), not a bare price object, so the Cloud Function (`functions/src/index.ts`, `getPorterQuote`) maps it to the correct HTTP code / client state.
4. Keep the quote `TTL_SECONDS` lock semantics (D6 re-quote is handled separately in A4).

**Failure signature to convey** (used by frontend states from R8):
- `not_serviced` → client shows "not serviced" state (no delivery for that address).
- `transient_failure` → client shows a retry / "try again in a moment" state.

### A2. `bookPorterRider` — response parse order (R7)
**File**: `functions/src/modules/porter/porter.service.ts` (~lines 220–223)

**Current bug**: `const data = await response.json();` runs **before** `if (!response.ok)`. On a non-JSON error body (HTML error page, gateway 502), `response.json()` throws a misleading `SyntaxError: Unexpected token '<'` and loses the real Porter rejection reason.

**Required behavior**: reorder —
```ts
if (!response.ok) {
  let msg: string;
  try {
    const errBody = await response.json();
    msg = errBody?.message || errBody?.error || `Porter HTTP ${response.status}`;
  } catch {
    msg = `Porter HTTP ${response.status}`;
  }
  throw new Error(msg);
}
const data = await response.json();
```
Then continue using `data.order_id`, `data.driver_details`, etc. as the code already does at lines 225–232.

### A3. Branch delivery-radius field + radius pre-check (D3, R9)
**Files**: branch/Store model + `functions/src/core/utils/geo.utils.ts` + `FulfillmentSelector.tsx` / `DeliveryPanel.tsx` (frontend homes)

**Gap**: no `servicedRadius`/`deliveryRadius` on the branch model, and no two-stage serviceability check in the stack.

**Required behavior**:
1. Add `servicedRadiusKm` (number) to the branch record / Store model and Firestore branch docs, defaulted for existing branches (e.g. 5 km).
2. Add a cheap radius pre-filter (Haversine from branch coords to delivery coords) that returns `not_serviced` **before** any Porter API call when the address is clearly out of range (D3 first stage).
3. The Porter quote remains the **final authority** for addresses near the boundary (D3 second stage / D4).
4. Wire the two-state result (`not_serviced` / `transient_failure` / `serviced`) into the frontend:
   - `burgonomics-foundation-core/src/features/cart/components/FulfillmentSelector.tsx` — replace the static `store.supports.delivery`-only gating (R8).
   - `burgonomics-foundation-core/src/features/checkout/components/DeliveryPanel.tsx` — replace the perpetual "Calculating…" fee with a real coverage state (R8).

### A4. Re-quote + confirm at payment (D6)
**File**: payment capture flow (`functions/src/modules/payments/...`) + checkout client

**Gap**: the 10-min quote lock can expire during a slow checkout; the current flow does not re-quote or block on a materially changed fare.

**Required behavior**:
1. At payment time, if the quote lock expired, re-quote.
2. If the new fare differs **materially** (threshold: >5% or >₹10, configurable) from the price the customer was shown, **block** placement and require explicit customer confirmation of the updated fee.
3. The authoritative price is the one charged at the actual booking / dispatch (D6).

---

## PART B — PETPOOJA

> The single most important finding: **the current `pushOrderToPetpooja` success check does not match the documented V2.1.0 response.** Documented response is `success: "1"` (string) + `orderID` + `clientOrderID`. The code checks `result.status === "success"` (line 278), so **every real push would be misread as failure** even after the payload is fixed. Align the response parse too.

### B1. Align order push to V2.1.0 nested contract (P1, R10)
**File**: `functions/src/modules/petpooja/petpooja.service.ts` `pushOrderToPetpooja` (payload at lines 240–264)

**Required**:
1. Endpoint: `POST <Orders API host>/save_order` (base `https://47pfzh5sf2.execute-api.ap-southeast-1.amazonaws.com/V1`). Confirm `config.petpooja.orderUrl` points at `/save_order`.
2. Body shape — behind one **`orderinfo`** key:
   ```
   {
     app_key, app_secret, access_token,        // credentials IN BODY for save_order
     orderinfo: {
       OrderInfo: {
         Restaurant: { details: { res_name, address, contact_information, restID } },
         Customer:   { details: { name, phone, address, latitude, longitude, email } },
         Order:      { details: { orderID, order_type, payment_type, delivery_charges, dc_tax_*, packing_charges, pc_tax_*, discount_total, tax_total, total, min_prep_time, callback_url, ... } },
         OrderItem:  [ { id, name, price, final_price, quantity, item_attribute, ... }, ... ],
         Tax:        [ ... ],
         Discount:   [ ... ],
       }
     },
     udid, device_type
   }
   ```
3. **`Order.details.orderID` = our order id, and set `Order.details.callback_url`** (the partner `petpoojaWebhook` / stock webhook URLs) so Petpooja can post status updates back.
4. Remove the flat top-level fields (`order_id`, `customer_name`, `items`, `tax_details`, `total`, etc.) that are not part of the contract.

### B2. Idempotency via `clientOrderID` (P5, R11)
**File**: same `pushOrderToPetpooja`

**Required**:
1. Ensure our order id is sent as `clientOrderID` (via `Order.details.orderID` and/or the field Petpooja echoes back as `clientOrderID`). There is **no** explicit idempotency field in V2.1.0 — `clientOrderID` is the dedup hook.
2. The retry worker (`petpooja.scheduler.ts`, `retryPendingPetpoojaOrdersWorker`) calls `pushOrderToPetpooja(doc.id)` re-sending the **same** `clientOrderID` on every retry — do NOT mint a new one per attempt. A different `clientOrderID` per retry would defeat dedup and **double-print the KOT**.
3. On success (`result.success === "1"`), store the Petpooja `orderID` on `orders/{orderId}.petpooja` (this is Petpooja's assigned id, distinct from ours).

### B3. OrderItem id → `petpoojaItemId`; defer add-ons (P2, R12)
**File**: same `pushOrderToPetpooja`, `orderItems` mapping (lines 230–238)

**Required**:
1. Map `OrderItem.id` (`id` field) to **`it.petpoojaItemId`** (from menu sync) — the documented field is `id`, and it must be the Petpooja item id, not our product id.
2. **Do NOT transmit `addon_items`/`selectedAddons`** as raw passthrough (current line 236). The exact `AddonItem.details[]` / `variation_id` / `variation_name` required shape is **not yet confirmed with Petpooja support**. Until confirmed: omit add-ons (known limitation — KOT prints base item + base price). Do **not** invent a shape.
3. Populate `item_attribute` (veg/non-veg) as the code already attempts (line 237) — keep, but ensure it matches the field the contract expects (`item_attribute`).

### B4. Use stored `petpooja.restId`, not the doc id (P3, R13)
**File**: `pushOrderToPetpooja` (line 244) **and** `syncPetpoojaMenu` (`petpooja.service.ts`, menu section)

**Required**:
1. `pushOrderToPetpooja` already fetches `branchData.petpooja` (lines 217–227) — pull **`restId`** from there and use it. Replace `rest_id: branchId` (line 244) with `branches/{branchId}.petpooja.restId`.
2. `syncPetpoojaMenu` must likewise call the Menu API (`POST /mapped_restaurant_menus`, menu host `https://qle1yy2ydc.execute-api.ap-southeast-1.amazonaws.com/V1`) with the branch's stored credentials and `restID` — never the Firestore doc id.

### B5. Per-branch webhook auth + scoped products (P4, R14)
**Files**: `functions/src/core/middleware.ts` `verifyPetpoojaAuth` (lines 117–154) + menu write path

**Required**:
1. **Webhook auth**: resolve the calling branch's **stored** `appKey`/`accessToken` by `restID` present in the webhook body (per-restID scoping). Unknown `restID` → reject (401/403). Do **not** rely on one global `config.petpooja.*` set for all branches.
2. **Auth differs by surface**: menu/restaurant calls use `app-key`/`app-secret`/`access-token` **headers**; `save_order` uses body creds (P1). Replace the odd `Content_key` header (line 270) with the documented header scheme for the surface being called.
3. **Product namespacing**: write synced items to `products/branches/{branchId}/items/{itemid}` (not shared `products/prod_{itemid}`). Update `petpoojaStockWebhook` to flip `.available=false` on the **branch-scoped** product only, so an 86 at one branch never affects another.

### B6. Response success predicate (discovered during review)
**File**: `pushOrderToPetpooja` (line 278)

**Gap**: code checks `result.status === "success"`, but documented success is `result.success === "1"` (string), with `result.orderID` / `result.clientOrderID` echoed. **Fix the success predicate to match V2.1.0**, otherwise every push is treated as failed and retried forever → KOT double-send risk.

---

## PART C — RAZORPAY

> Grounding: `references/razorpay_payments.md` §0 (RZ1–RZ4). Confirmed against current Razorpay docs.
> Highest-stakes **money** surface — the Route transfer is real movement between the main and linked branch accounts; treble-check idempotency.

### C1. Put our `orderId` in the payment order `notes` (RZ1, R15)
**File**: `functions/src/modules/payments/razorpay.service.ts` `createPaymentOrder` (notes at lines 64–70)

**Gap**: `notes` currently carries `branchId`, `customerId`, `orderType`, `brandRoyaltyPaise`, `branchTransferPaise` — but **not** `orderId`. The webhook (`razorpay.webhook.ts:48`) reads `paymentEntity.notes.orderId` which is therefore `undefined`, so the `payment.captured` handler **silently no-ops** and the reliable server-side confirmation never happens. Only the client-chokeable `verifyPayment` works.

**Required**: add `orderId: params.orderId` (the Firestore order id) to the `notes` object. The webhook can then resolve the order and act on capture.

### C2. Webhook authoritative + `verifyPayment` idempotent shim (RZ2, R16)
**Files**: `razorpay.service.ts` `verifyPayment` (179–299) + `attemptRouteTransfer` (121–173) + `razorpay.webhook.ts` `handleRazorpayWebhook` (12–132)

**Gap**: once `orderId` is in notes (C1), BOTH the webhook and the client `verifyPayment` become live, and there is no shared dedup: `attemptRouteTransfer` has no "already transferred" guard, and both paths set `status: "accepted"`. A user who pays, force-closes the browser, then reopens can get the webhook to transfer + push KOT, and then `verifyPayment` to transfer **again** (double money movement) and/or double-push KOT.

**Required** (locked: **webhook authoritative + idempotent verifyPayment**):
1. **Webhook `payment.captured`/`order.paid`** (requires C1) becomes the authoritative confirmation. On genuine capture it must: flip `paymentStatus`/`status` → completed/accepted, generate the crypto-secure delivery OTP, **execute the Route transfer** (load the order via `notes.orderId`, read `pricing.split`, call `attemptRouteTransfer`), and push KOT to Petpooja — each **once**.
2. **`verifyPayment` becomes a guarded shim**: verify the client-side HMAC, then check the order state first — if already `accepted`/transferred (or a processed-marker exists), **no-op** (return success without re-transferring / re-pushing KOT).
3. **Shared dedup guard**: add an "already transferred" precondition inside `attemptRouteTransfer` (e.g. bail if `routeTransferStatus === "transferred"` or `payment.routeTransfer` exists) so webhook + verifyPayment + retry worker can never transfer a payment twice. Add an event-sourced processed marker on the order (e.g. `payment.capturedEventId`) consumed by both channels.
4. Keep `retryPendingRouteTransfersWorker` semantics (retries only when `pending_retry`, max 3), now consistent with the guard.

### C3. `autoRefund` — captured-state check + idempotency header (RZ3, R17)
**File**: `razorpay.service.ts` `autoRefund` (423–487)

**Gap**: per Razorpay docs, refunds only succeed on **`captured`** payments, and refund idempotency exists via the **`X-Refund-Idempotency`** header. Current `autoRefund` does neither: it can refund a non-captured payment, and a lost-response retry double-refunds.

**Required** (locked: **state check + idempotency header**, keep `reverse_all: 1`):
1. **State pre-check**: only proceed when the payment is `captured` and the order is not already `refunded`; otherwise return/reject without calling Razorpay.
2. **Idempotency header**: send `X-Refund-Idempotency` with a stable, ≥10-char key derived from order id + refund context. Handle Razorpay `409` (already in-flight) by reading the existing refund rather than issuing a second one.
3. **Keep `reverse_all: 1`** — valid for our single-linked-account partial refund (reverses the branch transfer proportionally). No explicit transfer-reversal API needed unless a future order transfers to multiple linked accounts.
4. **Brand-royalty / main-account share**: `reverse_all` only recovers the linked-account transfer; the main-account (brand royalty) portion of a partial item refund is deducted from our balance. Record the refund amount and which split portions it reverses in the refund audit (see C4).

### C4. Caller-distinct refund idempotency keys (RZ3, R18)
**Files**: `autoRefund` callers — `functions/src/modules/tickets/tickets.service.ts` (line 186, support-ticket resolution) and `functions/src/modules/petpooja/petpooja.service.ts` (line 386, post-checkout item-rejection auto-refund)

**Gap**: both callers invoke the same `autoRefund` with distinct refund *contexts*. If the idempotency key is only `refund_{orderId}`, a ticket refund and an item-rejection refund on the same order would collide.

**Required**: key derivation must be caller-distinct, e.g. `refund_{orderId}_ticket_{ticketId}_v1` for the tickets path and `refund_{orderId}_item_{lineItemRef}_v1` for the rejection path. Each caller passes its context into `autoRefund` (extend `RefundParams` with an idempotency key / context) so two legitimate distinct refunds on one order never dedupe into each other.

---

## PART D — FIREBASE (Firestore rules / trust boundary)

> Source of truth: `references/firebase_security.md` (§0 **F-PAY / F-RBAC / F-COUPON / F-TOKEN**). All edits are to `firestore.rules` (admin SDK ignores rules, so server functions are unaffected — this only tightens direct client writes). Watchlist **R19–R22**.

### D1. Orders + branches payment/credential keys are server-only (F-PAY, R19/R20)
**File**: `firestore.rules`

**Gap**: the orders branch-owner update guard (`:113-117`) allows any non-`totals`/`pricing` key, so `paymentStatus`/`status`/`payment.*`/`refundStatus` are directly client-writable — a branch staffer can flip an order to paid with NO Razorpay capture (bypasses the authoritative RZ2 webhook). The branches update rule (`:129`) lets branch staff edit `razorpayAccountId`, `petpooja.restId`/`appKey`/`accessToken`, and `servicedRadiusKm` — a compromised branch owner can repoint the Route payout or leak POS creds.

**Required**:
1. Extend the orders affected-key guard to also refuse `paymentStatus`, `status`, `payment`, `refundStatus`, and split fields. Branch staff keep only fulfillment/customer-service keys (kitchen state transitions, `driverId`, delivery-OTP confirmation counters).
2. Restrict `razorpayAccountId`, `petpooja.*`, `servicedRadiusKm` on `branches` to `isBrandOwner()` only.

### D2. Hybrid RBAC — fresh `admins/{uid}` check on sensitive writes (F-RBAC, R21)
**File**: `firestore.rules`

**Gap**: `isBrandOwner()`/`isBranchOwner()` accept the stale (~1h) `request.auth.token.role` even after revocation, so a revoked staffer keeps admin writes up to 1h (`revokeRefreshTokens`+`checkRevoked` narrow but don't eliminate).

**Required**: keep custom claims for read-cheap checks, but on **sensitive writes** (payments, refunds, credentials, branch edits) additionally require a fresh confirmation from the `admins/{uid}` doc (`getAdminDoc().data.role` + `branchId` match) so the retained-access window is closed at the money/credential boundary.

### D3. `coupons` server-only; `petpooja_offers` auth-gated (F-COUPON, R22)
**File**: `firestore.rules`

**Gap**: `coupons` is `allow read: if true` though no client reads it (server validates via `pricing.engine.ts:141`); `petpooja_offers` is also public and carries `code`+`discount`+`maxDiscount` — enumerable by unauthenticated scrapers. Guest checkout is unaffected because it validates server-side via `calculateOrderPricing`.

**Required**:
1. `coupons` → `allow read, write: if false` (server-only).
2. `petpooja_offers` → `allow read: if isAuthenticated()` (registered users browse; guests + scrapers can't enumerate codes/discounts).

### D4. Dead `device_tokens` block + real token home (F-TOKEN)
**File**: `firestore.rules` (and document in `references/firestore_schema.md`)

**Gap**: the `device_tokens/{token}` rules (`:333`, `allow create, update: if isAuthenticated()` — no ownership check) are VESTIGIAL — nothing in any app or function reads/writes the collection; FCM dispatches via server-controlled topics or explicit trusted tokens (`fcm.service.ts:48-52`). The naive "device-token hijack" isn't reachable today, but the block misleads.

**Required**:
1. Lock the dead block fully server-only (`allow read, write: if false`) or delete it.
2. Document the intended per-device model in `firestore_schema.md`: personal FCM tokens live at `users/{uid}/tokens/{deviceId}` with `allow create, update: if isUser(uid)` (owner's own device only), for any future per-device sends. No code change required unless per-device pushes are built.

---

## Definition of Done

- [ ] A1: `getDeliveryQuote` returns `serviced | not_serviced | transient_failure` — never a static rate-card fallback.
- [ ] A2: `bookPorterRider` parses error body after the `response.ok` check.
- [ ] A3: branch `servicedRadiusKm` exists; radius pre-check + frontend coverage states wired.
- [ ] A4: payment re-quote + material-change confirm blocks placement.
- [ ] B1: `pushOrderToPetpooja` sends the nested V2.1.0 `orderinfo` payload.
- [ ] B2: same `clientOrderID` reused on every retry; Petpooja `orderID` stored.
- [ ] B3: `OrderItem.id` = `petpoojaItemId`; add-ons omitted until confirmed.
- [ ] B4: menu sync + order push use stored `petpooja.restId`.
- [ ] B5: webhook resolves per-branch creds by `restID`; products namespaced per branch.
- [ ] B6: success predicate matches `success: "1"` / `orderID`.
- [ ] C1: `orderId` in Razorpay payment `notes`; webhook `payment.captured` resolves the order.
- [ ] C2: webhook authoritative; `verifyPayment` idempotent shim; shared transfer/processed dedup guard.
- [ ] C3: `autoRefund` checks `captured` + not-already-refunded; sends `X-Refund-Idempotency`; keeps `reverse_all: 1`; tracks brand-royalty share.
- [ ] C4: caller-distinct refund idempotency keys (ticket vs item-rejection) so distinct refunds don't collide.
- [ ] D1: orders + branches payment/credential/split keys server-only (branch staff can't mark paid or repoint payout / mutate POS creds).
- [ ] D2: hybrid RBAC — fresh `admins/{uid}` confirmation on sensitive writes (payments/refunds/creds/branch edits).
- [ ] D3: `coupons` server-only (`allow read/write if false`); `petpooja_offers` auth-gated (`isAuthenticated()`).
- [ ] D4: dead `device_tokens` block locked/deleted; intended `users/{uid}/tokens/{deviceId}` model documented in `firestore_schema.md`.
- [ ] `npm test && npm run build` green.
- [ ] `references/known_issues.md` R6–R22 updated to reflect resolution.
