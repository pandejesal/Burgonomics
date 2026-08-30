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
