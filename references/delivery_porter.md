# BURGONOMICS — Porter Logistics Integration (Layer 3 Constraint)

> **Reference Specification**: Real-time delivery fare estimation, serviceability pre-check, Partner POS manual courier dispatch, webhook tracking, and cancellation recovery.

---

## 0. Research Decisions & Design Constraints (locked — gap review)

> Grounding: Porter public API (`api.porter.in`) is **quote-based only**. There is **no dedicated pincode/coverage endpoint**. Porter is **intra-city**, API integration across **16 cities**, and the API is **Two-Wheeler (bike) only**. Confirmed industry pattern (Porter/Shopify integrations): the `POST /v1/orders/quote` call doubles as the coverage gate — a successful quote = serviced, an address-unsupported error = not serviced.

- **D1 — Fail closed on quote**: A live Porter quote failure must **never** silently degrade to the static rate card. If the live quote cannot be fetched, delivery is unavailable for that address/trip (surface an error), and the customer is never charged an unverified static fare.
- **D2 — Distinct states**: `not_serviced` (address genuinely outside Porter coverage or branch radius — a 4xx/address-unsupported error) must be distinguished from `transient_failure` (network / 5xx / timeout). They require different UI, different retry behavior, and different Cloud Function return codes. Implement by inspecting the quote response `status`/error body, not by treating every failure alike.
- **D3 — Hybrid serviceability pre-check**: Use a self-managed **branch delivery radius/geofence** in Firestore as the cheap fast pre-filter (fires before any Porter call, both to reduce quote-API cost/latency and to give the client a instant result). The Porter quote is the **final authority** for addresses near the branch boundary (radius check passes → quote confirms or rejects). Two-stage: `radius gate → quote-as-gate`.
- **D4 — Quote-as-gate is authoritative**: Because Porter has no coverage endpoint, `POST /v1/orders/quote` success/failure IS the serviceability verdict for the boundary case. No separate coverage API call.
- **D5 — Bike for all orders**: Porter's API is bike-only and we accept that constraint. No per-order size/weight cap is applied; large/catering orders are not currently routed around Porter capacity (documented assumption — revisit if Porter ships 3-wheeler/truck API support).
- **D6 — Re-quote + confirm at payment**: The 10-minute quote lock may expire during a slow checkout. At payment time, re-quote if the lock expired; if the new fare differs materially from the shown price, block placement and require the customer to confirm the updated fee. Authoritative price is the one charged at the actual booking / dispatch.

---

## 1. Real-Time Quotes at Checkout
- When a customer inputs or selects a delivery address with GPS coordinates, `getPorterQuote` Cloud Function performs the **D3 two-stage check**: (a) branch-radius pre-check from Firestore; (b) if in radius, call Porter API (`api.porter.in/v1/orders/quote`) as the authoritative fare + coverage verdict (D4).
- Follows **D1**: a failed/absent live quote returns `not_serviced` or `transient_failure` (D2) — never an estimated static price.
- Customer pays the exact live bike delivery fee (or ₹0 if order qualifies for Free Delivery > ₹499).
- Delivery fee is locked in the order summary for 10 minutes, then re-quoted and confirmed per **D6**.

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
