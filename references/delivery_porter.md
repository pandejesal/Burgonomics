# BURGONOMICS — Porter Logistics Integration (Layer 3 Constraint)

> **Reference Specification**: Real-time delivery fare estimation, Partner POS manual courier dispatch, webhook tracking, and cancellation recovery.

---

## 1. Real-Time Quotes at Checkout
- When a customer inputs or selects a delivery address with GPS coordinates, `getPorterQuote` Cloud Function calls Porter API (`api.porter.in/v1/orders/quote`).
- Customer pays the exact live bike delivery fee (or ₹0 if order qualifies for Free Delivery > ₹499).
- Delivery fee is locked in the order summary for 10 minutes.

---

## 2. Partner POS "Book Porter Rider" Screen
- **Manual Trigger**: Rather than auto-dispatching immediately on checkout, the Branch Manager triggers Porter dispatch when the order reaches `ready` or is 5 mins from packing.
- The Partner app provides a dedicated **"Book Porter Rider"** panel showing live quote, pickup details, and single-click dispatch button.
- On dispatch, Porter returns `porterOrderId` and tracking URL, saved to `orders/{orderId}.porter`.

---

## 3. Webhook Tracking & Driver Updates
- `porterWebhook` Cloud Function verifies HMAC signature and processes driver milestone events:
  - `DRIVER_ASSIGNED`: Updates rider name and phone.
  - `IN_TRANSIT`: Advances order to `out_for_delivery`.
  - `DELIVERED`: Advances order to `delivered`.

---

## 4. Cancellation Handling & Rebook
- If a Porter driver cancels or no driver is found within 5 minutes:
  - Partner POS plays an urgent audio notification and displays an alert card.
  - 1-Click Rebook button re-requests a new Porter rider.
  - Fallback option: "Switch to In-House Delivery" allows branch staff to deliver locally.
