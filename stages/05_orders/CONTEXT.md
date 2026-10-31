# Stage 05: Orders Pipeline, POS Push & Delivery Dispatch

> **Layer 2 Stage Contract**: Order lifecycle management, 3-way fulfillment (Delivery, Takeaway, Dine-In), Petpooja POS bridge push, Porter rider dispatch screen, and manual delivery fallback.

---

## 1. Inputs
- **Layer 3 (Reference)**: `../../references/order_flow.md`
- **Layer 3 (Reference)**: `../../references/petpooja_pos.md`
- **Layer 3 (Reference)**: `../../references/delivery_porter.md`
- **Layer 3 (Reference)**: `../../_config/design_system.md`
- **Authoritative Backend Spec**: `../../references/backend_upgrade_spec.md`
- **Authoritative UI/UX Spec**: `../../references/ui_ux_spec.md`
- **Layer 4 (Working)**: `../04_dashboard/output/stage_summary.md`

---

## 2. Process
1. Build interactive Order Management UI with status lanes:
   - `pending` -> `accepted` -> `preparing` -> `ready` -> `out_for_delivery` -> `delivered` / `cancelled`.
2. Connect Petpooja order push trigger on verified payment capture (`functions/src/modules/petpooja/orderPush.ts`).
3. Build dedicated Dispatch Choice panel in Partner POS for courier dispatch (Borzo / Shadowfax) or restaurant in-house delivery assignment (`POST /orders/manualDispatch`, `dispatchType: manual_branch_terminal`, `deliveryStatus: dispatched`). Note: in-house delivery is staff delivery, strictly distinct from counter pickup / takeaway.
4. Connect 4-digit security OTP verification for delivery handoff only (Takeaway and Dine-In counter collections are PIN-free).
5. Support in-house rider assignment fallback allowing branch operators to assign local rider name & phone number when third-party couriers are unserviceable.
6. Provide looping audible alert on incoming new `pending` orders.

---

## 3. Outputs
- `src/features/orders/components/OrderCard.tsx`
- `src/features/orders/components/OrderDetailModal.tsx`
- `src/features/delivery/components/RiderAssignmentModal.tsx`
- `functions/src/modules/petpooja/orderPush.ts`
- `functions/src/modules/dispatch/dispatch.router.ts`
- `output/stage_summary.md` -> Stage verification summary

---

## 4. Verify
```bash
npx tsc --noEmit && npx vitest run
```
- Assert status transitions strictly follow `references/order_flow.md`.
- Verify Petpooja payload mappings, idempotency keys, and Porter fallback logic.
