# Stage 06: Customer Relationship Management (CRM) & Global Loyalty

> **Layer 2 Stage Contract**: Customer profiles, lifetime value (LTV) metrics, Global Grill Coins loyalty management, saved address books, and ticket history.

---

## 1. Inputs
- **Layer 3 (Reference)**: `../../references/firestore_schema.md`
- **Layer 3 (Reference)**: `../../_config/design_system.md`
- **Authoritative Backend Spec**: `../../references/backend_upgrade_spec.md`
- **Authoritative UI/UX Spec**: `../../references/ui_ux_spec.md`
- **Layer 4 (Working)**: `../05_orders/output/stage_summary.md`

---

## 2. Process
1. Build Customer directory table with search, phone lookup, and order frequency sorting.
2. Build Customer 360 profile view displaying:
   - Order history timeline across all 16+ branches
   - Total spend and Average Order Value (AOV)
   - Global Grill Coins loyalty balance (1 coin = ₹1) with manual adjustment audit
   - Associated delivery addresses
   - Support ticket interaction history
3. Implement export to CSV functionality for marketing campaigns.

---

## 3. Outputs
- `src/features/customers/components/CustomerList.tsx`
- `src/features/customers/components/CustomerProfileModal.tsx`
- `output/stage_summary.md` -> Stage verification summary

---

## 4. Verify
```bash
npx tsc --noEmit && npx vitest run
```
- Verify customer search filter performance and responsive table rendering.

## 6. Launch overlay - 2026-10-28 (loyalty deferred)

Read this before executing the historical Process above. The launch decision set is recorded in
[launch-plan D31-D33](../../stages/08_menu/output/launch-plan-20261028/01-DECISIONS-AND-OWNERSHIP.md)
and [the Reelo feasibility note](../../stages/08_menu/output/launch-plan-20261028/07-REELO-FEASIBILITY.md).

- The Delivery app ships with **no loyalty balance or redemption UI**. Do not add or expose a
  Reelo balance, points total, earn promise or redemption control in this release.
- Existing Firebase Grill Coins balances and coin_transactions history are preserved unchanged.
  Do not migrate, zero, translate or display them as Reelo points.
- Reelo remains the CRM/marketing system and already receives Petpooja bills. The app must not
  post the same bill again; Petpooja is the single bill producer.
- Hiding UI is not a financial control. New earn/redeem behaviour must be set so a bill cannot
  credit the customer twice; that configuration is still to be confirmed by the owner.
- Customer CSV export and marketing sync are **not** authorised launch operations. Data
  minimisation, consent and retention approval remain outstanding.

This overlay does not rewrite historical Stage 06 verification and does not approve loyalty code.
