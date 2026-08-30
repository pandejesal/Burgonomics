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
2. Connect Petpooja order push trigger on verified payment capture (`functions/src/petpooja/pushOrder.ts`).
3. Build dedicated **"Book Porter Rider"** panel in Partner POS for manual courier dispatch when orders reach `ready`.
4. Connect 4-digit security PIN verification for Takeaway and Dine-In counter collections.
5. Implement Manual Delivery Fallback modal allowing branch operators to assign local rider name & phone number if Porter is unavailable.
6. Provide looping audible alert on incoming new `pending` orders.

---

## 3. Outputs
- `src/features/orders/components/OrderCard.tsx`
- `src/features/orders/components/OrderDetailModal.tsx`
- `src/features/orders/components/BookPorterRiderModal.tsx`
- `functions/src/petpooja/pushOrder.ts`
- `functions/src/porter/bookRider.ts`
- `output/stage_summary.md` -> Stage verification summary

---

## 4. Verify
```bash
npx tsc --noEmit && npx vitest run
```
- Assert status transitions strictly follow `references/order_flow.md`.
- Verify Petpooja payload mappings, idempotency keys, and Porter fallback logic.
