# BURGONOMICS — Order Flow Lifecycle & State Machine (Layer 3 Constraint)

> **Reference Specification**: State machines, 3-way fulfillment lifecycles, Razorpay Route payments, and cancellation flows.

---

## 1. 🔄 Order State Machine

```
               [PLACED] (checkout initiated / payment authorized)
                  │
                  ▼
              [CONFIRMED] (KOT pushed to Petpooja / POS acknowledged)
                  │
                  ▼
              [PREPARING] (grilling in kitchen)
                  │
                  ▼
        [READY_FOR_PICKUP] (assembled & packed)
                  │
      ┌───────────┴────────────────────────┐
      │ (Delivery)                         │ (Dine-In)
      ▼                                    ▼
[OUT_FOR_DELIVERY] (courier en route)  [READY_TO_SERVE] (dine-in only)
      │
      ▼
  [DELIVERED] (terminal)

Takeaway collection reuses [READY_FOR_PICKUP]; the tracking screen shows the real
order reference. [CANCELLED] is terminal. These are the written literals from
`functions/src/modules/orders/orderStatus.ts` (PLACED/CONFIRMED/PREPARING/
READY_FOR_PICKUP/OUT_FOR_DELIVERY/DELIVERED/CANCELLED, plus the dine-in
READY_TO_SERVE fork); partner keys such as `accepted`/`ready` are internal inputs,
not customer-facing state codes.
```

---

## 2. 🍔 Fulfillment Modes & Invariants

1. **🛵 Delivery**:
   - Requires verified street address and GPS coordinates.
   - Triggers a real-time courier fee quote at checkout (multi-provider dispatch: Borzo / Shadowfax, cheapest serviceable wins — see `references/delivery_routing.md`; providers without credentials are skipped, not simulated. Porter is **retired**: it only participates if an operator explicitly re-arms it with `PORTER_ENABLED="true"`, which re-arms FULL dispatch — there is no history-only mode). Delivery is free above a ₹499 food total (`FREE_DELIVERY_THRESHOLD`), otherwise a flat fee applies.
   - Partner POS features a dispatch screen (Borzo / Shadowfax) to dispatch the courier upon reaching `ready`; the restaurant may instead assign its own in-house rider via `POST /orders/manualDispatch` (`deliveryStatus: "dispatched"`, `dispatchType: "manual_branch_terminal"`) — a restaurant-driven delivery, never customer pickup.
2. **🛍️ Takeaway**:
   - Customer chooses pickup outlet and sees dynamic preparation ETA (e.g. 10–15 mins).
   - No pickup PIN is generated or displayed. The tracking screen shows the real order reference (`orderNumber` / `shortCode`) for counter collection. The only 4-digit secret in the system is the **delivery** handover OTP (`deliveryOtpHash`), which applies to delivery orders only.
   - Zero delivery fee.
3. **🍽️ Dine-In**:
   - Frictionless in-store ordering without table number input friction.
   - Order sent directly to the branch kitchen KOT. The fulfillment marker is read from `fulfillmentType` / `orderType` / `fulfillment` as the string `"dinein"` (not a nested object). Customer collects with the order number / dining token.

---

## 3. 💳 Payment & Settlement Flow
- **Razorpay Pre-paid**:
  - `POST /payments/createPaymentOrder` creates the Razorpay order with Route transfers (brand royalty retained; net branch total transferred to the branch Razorpay account); the amount is recomputed server-side.
  - The **`payment.captured` webhook is the authoritative confirmation**: it writes the `CONFIRMED` literal (never `accepted`) and pushes KOT once. Client `verifyPayment` is a guarded, idempotent shim for the same path.
- **Cash / Pay at Counter**:
  - Order confirmed directly with `payment.status: 'pending'`, settled at counter or doorstep.
  - Direct client creation of `customerId: 'cust_walkin'` is denied for every role and payment state; walk-ins must use the server-priced `POST /orders/createWalkIn` path. Its R1 contract creates pending payment only; settlement is not provided. Ordinary customer creation and COD flow remain unchanged.
- **Refunds are parked, not automatic**:
  - A Petpooja cancel/86ing after payment writes a `PENDING` refund request (`refunds/refund_pos_cancel_<orderId>`) plus `payment.refundStatus: PENDING_APPROVAL` for staff approval — per the recorded 2026-09-23 decision there is no human-less refund.
  - The inbound cancel webhook never calls `autoRefund`; ticket/staff refunds use the authorised refund service (captured-state, cumulative and idempotency guards apply).

---

## 4. 📦 Delivery Handover & Customer OTP (Approved Contract, 3 Nov 2026)

1. **Deterministic v2 Delivery Codes**:
   - Server-minted delivery codes carry `deliveryOtpVersion: 2`.
   - The 4-digit code is derived deterministically from domain-separated HMAC of the canonical Firestore document ID with `OTP_HMAC_SECRET` (`burgonomics:delivery-otp:v2\0<canonicalOrderId>`), mapping to 1000–9999 (never leading zero).
   - Stored in Firestore as salted verifier `deliveryOtpHash: HMAC(OTP_HMAC_SECRET, "v2:" + canonicalOrderId + ":" + otp)` with `deliveryOtpVersion: 2`. Plaintext is never persisted.
   - Both client payment verification and webhook-first confirmation share the same mint logic; an existing hash is never overwritten.

2. **Owner-Only Repeatable Retrieval (`POST /orders/deliveryOtp`)**:
   - Endpoint uses revoked-token-checked `requireAuth` and strict canonical customer ownership (`customerId` primary; unambiguous legacy `userId` fallback only when `customerId` is absent and non-conflicting; denies guest, walk-in, staff, and admin bypass).
   - Read-only, no-store/private cache-control, no mutations or lockout resets.
   - Returns genuine code only for active paid delivery orders with server Razorpay capture proof and unconsumed v2 code.
   - Historical unversioned random codes return `LEGACY_OTP_UNAVAILABLE` byte-for-byte untouched (no replacement or brute-force).
   - Never logs, exposes via URLs, or stores plain code on public documents.

3. **Atomic Staff Handover Transaction (`POST /orders/verifyDeliveryOtp`)**:
   - Single atomic transaction: branch authorization recheck (with fallback to `admins/{uid}` carrying `branchIds`), payment and active delivery lifecycle guard (`assertDeliveryOtpOrderActive`), and serialized guess attempts.
   - Invalid attempts commit incremented attempt counter before throwing; 3-attempt lockout (15 min). Lockout expiry resets prior attempts so the first attempt after expiry does not immediately re-lock.
   - Successful verification atomically sets `DELIVERED` terminal status, burns `deliveryOtpHash` and legacy plaintext `deliveryOtp`, stamps `deliveryOtpConsumedAt`, and resets attempt counters.
   - `verifiedByStaff` binds to authenticated staff identity (`caller.email || caller.uid`).
   - Concurrency: only one verification can succeed; competing cancellation/terminal state wins.
