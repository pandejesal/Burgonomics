# Stage 09: Revenue Analytics & Operational Reporting

> **Layer 2 Stage Contract**: Sales trends, top-selling items velocity, peak order hours, Razorpay Route royalty reconciliation, Porter margin tracking, and 3-way fulfillment breakdowns.

---

## 1. Inputs
- **Layer 3 (Reference)**: `../../_config/design_system.md`
- **Layer 3 (Reference)**: `../../references/firestore_schema.md`
- **Layer 3 (Reference)**: `../../references/rbac.md`
- **Authoritative Backend Spec**: `../../references/backend_upgrade_spec.md`
- **Layer 4 (Working)**: `../08_menu/output/stage_summary.md`

---

## 2. Process
1. Build comprehensive Analytics Dashboard with date range selectors (Today, 7D, 30D, Custom).
2. Implement visual analytics components:
   - Revenue & Order Volume chart over time
   - Top Selling Items velocity ranking
   - 3-Way Fulfillment breakdown (Delivery vs Takeaway vs Dine-In)
   - Razorpay Route Royalty Ledger (Brand Royalty retained vs Net Branch revenue transferred)
   - Porter margin reconciliation (Porter courier cost vs customer delivery fee)
3. Ensure Brand Owners can compare metrics across all 16+ branches side-by-side with progressive loading skeletons.

---

## 3. Outputs
- `src/features/analytics/components/RevenueChart.tsx`
- `src/features/analytics/components/TopItems.tsx`
- `src/features/analytics/components/RoyaltyLedger.tsx`
- `output/stage_summary.md` -> Stage verification summary

---

## 4. Verify
```bash
npx tsc --noEmit && npx vitest run
```
- Assert chart components follow the 60-30-10 palette tokens and render smoothly without layout shifts.
