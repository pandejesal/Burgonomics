# OpenCode Stream 3: Burgonomics Backend POS Gate & Dispatch Router

You are working in `functions/`. Implement and verify the launch requirements:

## 1. Strict Petpooja Gate (Fail-Closed)
- In the order processing pipeline (`functions/src/modules/orders` and Petpooja integration):
  - When a customer places an order, the system must push `save_order` to Petpooja POS.
  - The order confirmation must fail closed if Petpooja POS is unreachable or rejects the payload.
  - Return clear diagnostic error if POS rejects, and do NOT charge or capture payment until POS confirms (or trigger auto-refund if pre-captured).

## 2. Delivery Fee & Packaging Model
- Food prices are inclusive of 5% GST.
- Delivery Fee: Pass dynamic quote from Borzo / Shadowfax routing engine (fallback ₹35 in test mode) + ₹20 packaging fee.
- If order type is `TAKEAWAY` or `DINE_IN`, delivery fee is ₹0 and packaging is ₹15 or ₹0 respectively.

## 3. Verify Vitest Suite
Run `npm test` to verify that all 331+ unit and integration tests across 37 test files pass with 0 failures.
