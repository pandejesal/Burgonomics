# BURGONOMICS — Order Flow Lifecycle & State Machine (Layer 3 Constraint)

> **Reference Specification**: State machines, 3-way fulfillment lifecycles, Razorpay Route payments, and cancellation flows.

---

## 1. 🔄 Order State Machine

```
               [pending] (Checkout initiated / Payment authorized)
                  │
                  ▼
              [accepted] (KOT pushed to Petpooja / POS acknowledged)
                  │
                  ▼
             [preparing] (Grilling in kitchen)
                  │
                  ▼
               [ready] ── (Order assembled & packed)
                  │
      ┌───────────┴──────────────────────────┐
      │ (Fulfillment: Delivery)              │ (Fulfillment: Takeaway / Dine-In)
      ▼                                      ▼
[out_for_delivery] (Porter rider en-route)   │ (Customer presents 4-digit PIN / seated)
      │                                      │
      ▼                                      ▼
 [delivered] ◄───────────────────────────────┘
```

---

## 2. 🍔 Fulfillment Modes & Invariants

1. **🛵 Delivery**:
   - Requires verified street address and GPS coordinates.
   - Triggers real-time Porter delivery fee quote at checkout (or Free Delivery if food total > ₹499).
   - Partner POS features a dedicated "Book Porter Rider" screen to dispatch the courier upon reaching `ready`.
2. **🛍️ Takeaway**:
   - Customer chooses pickup outlet and sees dynamic preparation ETA (e.g. 10–15 mins).
   - System generates a 4-digit Pickup PIN (e.g. `7419`) displayed on live tracking screen for counter collection.
   - Zero delivery fee.
3. **🍽️ Dine-In**:
   - Frictionless in-store ordering without table number input friction.
   - Order sent directly to branch kitchen KOT with `fulfillment: { mode: 'dinein' }`.
   - Customer collects with order number / dining token.

---

## 3. 💳 Payment & Settlement Flow
- **Razorpay Pre-paid**:
  - `createOrder` Cloud Function creates Razorpay order with Route transfers (Brand Royalty retained; net branch total transferred to branch Razorpay account).
  - `verifyPayment` verifies HMAC signature before advancing status to `accepted` and pushing to Petpooja.
- **Cash / Pay at Counter**:
  - Order confirmed directly with `payment.status: 'pending'`, settled at counter or doorstep.
- **Auto-Refunds**:
  - If Petpooja 86ing rejects an item post-payment, or customer ticket is resolved with refund, `autoRefund` Cloud Function initiates Razorpay Route refund reversal.
