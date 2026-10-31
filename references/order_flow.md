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
- **Refunds are parked, not automatic**:
  - A Petpooja cancel/86ing after payment writes a `PENDING` refund request (`refunds/refund_pos_cancel_<orderId>`) plus `payment.refundStatus: PENDING_APPROVAL` for staff approval — per the recorded 2026-09-23 decision there is no human-less refund.
  - The inbound cancel webhook never calls `autoRefund`; ticket/staff refunds use the authorised refund service (captured-state, cumulative and idempotency guards apply).
