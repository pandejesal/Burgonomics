# BURGONOMICS — Razorpay Payments & Route Splits (Layer 3 Constraint)

> **Reference Specification**: Razorpay server-order creation with authoritative server-side pricing, HMAC payment/webhook signature verification, Razorpay Route transfer splits to franchise branches, refund & transfer reversal handling, and India-compliant payment audit trails.

---

## 0. Research Decisions & Design Constraints (locked — gap review)

> Grounding: Razorpay order/payment creation, Route transfers, refunds, and transfer reversals are verified against the current Razorpay API docs (Create Order, Create Normal Refund incl. idempotent request, Refund Payments & Reverse Transfer, Reverse a Transfer). Key confirmed semantics: refunds may only be issued on payments in the **`captured`** state; refund **idempotency** is supported via the `X-Refund-Idempotency` request header (a stable, ≥10-char key; a retry with a different body is rejected `BAD_REQUEST`, an in-flight same-key request returns `409`); `reverse_all: true` recovers the linked-account transfer before refunding, and is valid for both **full refunds** and **partial refunds when the payment was transferred to a SINGLE linked account** (our case — one branch account per order) — for multi-account partial refunds Razorpay requires explicit per-transfer reversals instead.

- **RZ1 — `orderId` MUST be embedded in the payment order `notes`** at creation (`createPaymentOrder`), alongside the existing `branchId`/`customerId`/`orderType`/split fields. Today `razorpay.service.ts:64-70` omits it, so `handleRazorpayWebhook` reads `paymentEntity.notes.orderId` as `undefined` and the `payment.captured` handler **silently no-ops** (`if (orderId)` is false). The reliable, server-side confirmation channel is currently dead; the only working confirm is the client-called `verifyPayment`, which is lost when a user force-closes the browser after the Pay modal.
- **RZ2 — Webhook `payment.captured` is the AUTHORITATIVE confirmation; `verifyPayment` becomes an idempotent confirmation shim.** Both channels may now fire for one payment, and neither has a shared dedup guard today: `attemptRouteTransfer` (`razorpay.service.ts:121`) has no "already transferred" check, and both paths set `status: "accepted"`. Without reconciliation, a browser-killed session + re-open can double-fire the Route transfer (real money movement) and/or double-push KOT. Locked design: the webhook performs the Route transfer + status flip + delivery-OTP generation as source of truth; `verifyPayment` first checks the order state (already `accepted`/transferred ⇒ no-op) and otherwise performs the same transfer **only if not already executed**, then flips state. `pushOrderToPetpooja` (KOT) must also be gated so it cannot double-push.
- **RZ3 — `autoRefund` is made safe against state + idempotency gaps.** Confirmed from docs: refunds only succeed on **`captured`** payments, and refund idempotency exists via the **`X-Refund-Idempotency`** header — the current `autoRefund` (`razorpay.service.ts:423`) does neither (a lost-response retry double-refunds; it can refund a non-captured payment). Locked design: (a) pre-check that the payment is `captured` and the order is not already refunded; (b) send `X-Refund-Idempotency` with a stable per-refund key (e.g. `refund_{orderId}_{ticketId|lineItem}_v1`) so retries are deduped by Razorpay; (c) keep `reverse_all: 1` — valid for our single-linked-account partial-refund case, reversing the branch transfer proportionally; (d) track the **brand-royalty / main-account share** of a partial item refund (reverse_all only reverses the linked-account transfer; the main-account portion is deducted from our balance and must be recorded).
- **RZ4 — Amount authority stays server-side; both create and confirm paths never trust a client-supplied total.** `createPaymentOrder` recomputes `pricing.grandTotal` via `calculateOrderPricing` server-side, and payment `captured` HMAC binds `orderId`+`paymentId` (not an amount from the client). The webhook's `notes.orderId` (RZ1) lets it reload the order and use the same server-computed `pricing.split` for the Route transfer. Do not add client-supplied amount anywhere into order/payment confirmation.

---

## 1. Order Creation & Amount Authority
- **Server-side pricing**: `createPaymentOrder` calls `calculateOrderPricing` to derive authoritative `grandTotal` (GST, catalog validation, coupons, loyalty cap) and the `split` (`branchTransferPaise` / `brandRoyaltyPaise`). `amountPaise = round(grandTotal * 100)`.
- **Notes contract (RZ1)**: the Razorpay order `notes` MUST include `orderId` (our Firestore order id) in addition to the existing `branchId`, `customerId`, `orderType`, `brandRoyaltyPaise`, `branchTransferPaise`. This is what lets the downstream webhook resolve the order.
- Receipt id is a random `rcpt_...`; for audit reversibility we rely on the recorded `razorpayOrderId`/`razorpayPaymentId`, not the receipt.

## 2. Payment Confirmation — Single Authoritative Path
- **Webhook (`payment.captured` / `order.paid`) is authoritative (RZ2)**: verifies the `x-razorpay-signature` webhook HMAC, uses `notes.orderId` to load the order, and is idempotent by event id. On a genuine captured event it: flips `paymentStatus`/`status` to completed/accepted, generates the crypto-secure delivery OTP, executes the Route transfer (reading `pricing.split` from the order), and pushes KOT to Petpooja — **once**.
- **Client `verifyPayment` is a guarded shim (RZ2)**: it verifies the client-side HMAC (`orderId`, `paymentId`, `signature`) and then acts **only if** the order is not already confirmed/transferred (guard with a shared, event-sourced "already processed" marker on the order + a "already transferred" check inside `attemptRouteTransfer`). This makes the client re-open/re-tap safe after the webhook already ran.
- **Shared dedup (RZ2)**: introduce a single processed-marker/idempotency guard on the order (e.g. `payment.capturedEventId` and `routeTransferStatus != "transferred"` as a precondition) consumed by BOTH paths, so the Route transfer and KOT push can never run twice for the same captured payment.

## 3. Route Splits & Retry
- `attemptRouteTransfer` transfers `branchTransferPaise` to the branch's linked `razorpayAccountId` with `on_hold: 0` and brand-royalty in notes.
- Failures are marked `routeTransferStatus: "pending_retry"`; `retryPendingRouteTransfersWorker` retries up to 3x. A successful transfer sets `routeTransferStatus: "transferred"`.
- **Guard required (RZ2)**: check `routeTransferStatus`/`payment.routeTransfer` before executing so a concurrent webhook + verifyPayment, or a retry worker + capture, cannot transfer twice.

## 4. Refunds & Transfer Reversal
- **State pre-check (RZ3)**: `autoRefund` only proceeds when the payment is `captured` and the order is not already `refunded`.
- **Idempotency (RZ3)**: send `X-Refund-Idempotency` with a stable per-refund key (derived from order id + refund context — ticket id versus post-checkout rejection line item — so the two distinct refund callers do not collide). On a `409` (already in-flight) or a lost-response retry, the same key makes Razorpay return the original refund rather than a second one.
- **`reverse_all: 1`** (RZ3): valid here because each order transfers to a single linked branch account; the transfer reverses proportionally to the refund. Explicit transfer-reversal API (`/v1/transfers/:id/reversals`) is only needed if a future order transfers to multiple linked accounts.
- **Main-account share (RZ3)**: `reverse_all` recovers the linked-account transfer; the **brand-royalty/main-account** portion of a partial item refund is deducted from our balance and must be recorded in the refund audit (note the refund amount + which split portions it reverses).

## 5. Audit & Compliance
- Every capture writes a `payment_audits` row (`payment_captured`); every refund writes a `refund_processed` row. Audit ids are timestamp-scoped.
- India/PII compliance: the delivery OTP is stored only as an HMAC-SHA256 hash (`deliveryOtpHash`); the raw OTP is returned once. Never log raw payment ids beyond `_audits` and masked snapshots.

---

## 6. Open / Watchlist Mapping
- `references/known_issues.md` R15–R18 track the concrete implementation gaps behind RZ1–RZ3.
