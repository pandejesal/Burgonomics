# Stage 10: Dynamic Branch Provisioning, Franchise Leads & Upcoming Branches

> **Layer 2 Stage Contract**: Branch creation wizard, Razorpay Route linked account configuration, Brand Royalty %, Upcoming branch lifecycle (`active` | `upcoming` | `paused`), FCM topic subscriptions, and Franchise Lead tracking.

---

## 1. Inputs
- **Layer 3 (Reference)**: `../../references/firestore_schema.md`
- **Layer 3 (Reference)**: `../../references/push_notifications.md`
- **Layer 3 (Reference)**: `../../references/scaling_architecture.md`
- **Layer 3 (Reference)**: `../../references/rbac.md`
- **Authoritative Backend Spec**: `../../references/backend_upgrade_spec.md`
- **Layer 4 (Working)**: `../09_analytics/output/stage_summary.md`

---

## 2. Process
1. Build Branch Management directory (visible to Brand Owner).
2. Create "Add New Branch" modal wizard with Brand Owner authorization guard (`isBrandOwner()`):
   - Branch Name, City, Address, Phone, Geocoordinates, Operating Hours.
   - **Royalty & Payments Config**: Brand Royalty % (e.g. `8.0%`) and Razorpay Route linked Account ID (`razorpayAccountId`).
   - **Branch Status Selector**: `active` | `upcoming` | `paused`.
   - **Expected Opening Date**: e.g. `2026-09-15` (for `upcoming` status).
   - **Logistics Feature Toggle**: `features.porterEnabled`.
   - **Petpooja POS Credentials**: `appKey`, `appSecret`, `accessToken`, `restId`.
3. Implement Customer App "Notify Me" flow for upcoming branches (subscribing to `upcoming_{branchId}`).
4. Build **Franchise Leads Pipeline** in Partner POS for Brand Owners to review customer franchise inquiries.

---

## 3. Outputs
- `src/features/branches/components/BranchCard.tsx`
- `src/features/branches/components/AddBranchModal.tsx`
- `src/features/branches/components/FranchiseLeadPipeline.tsx`
- `output/stage_summary.md` -> Stage verification summary

---

## 4. Verify
```bash
npx tsc --noEmit && npx vitest run
```
- Assert that only `brand_owner` can create or modify branches and royalty percentages.
- Verify FCM topic naming format `upcoming_{branchId}`.
