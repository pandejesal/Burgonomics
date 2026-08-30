# Stage 02: Firebase & Firestore Data Layer

> **Layer 2 Stage Contract**: Firestore initialization, typed collections, security rules, indexes, and database service wrappers.

---

## 1. Inputs
- **Layer 3 (Reference)**: `../../references/firestore_schema.md`
- **Layer 3 (Reference)**: `../../references/rbac.md`
- **Layer 3 (Reference)**: `../../_config/coding_standards.md`
- **Authoritative Backend Spec**: `../../references/backend_upgrade_spec.md`
- **Layer 4 (Working)**: `../01_project_setup/output/stage_summary.md`

---

## 2. Process
1. Configure Firebase client SDK instance in both client apps and Admin SDK in `/functions`.
2. Define TypeScript interfaces for all Firestore entities (`Branch`, `Product`, `UserProfile`, `Order`, `SupportTicket`, `FranchiseLead`, `Coupon`, `DevErrorSnapshot`).
3. Implement strongly typed CRUD and realtime subscription services.
4. Write and validate `firestore.rules` enforcing role-based isolation (Brand Owner, Branch Manager, Kitchen Staff, Support, Developer, Customer).
5. Generate `firestore.indexes.json` for compound queries (e.g. `branchId + status + createdAt`).

---

## 3. Outputs
- `src/core/firebase/config.ts`
- `src/types/firestore.ts`
- `firestore.rules`
- `firestore.indexes.json`
- `output/stage_summary.md` -> Stage verification summary

---

## 4. Verify
```bash
npx tsc --noEmit && npx vitest run
```
- Validate that all Firestore interfaces export without type conflicts.
- Ensure `firestore.rules` syntax passes Firebase CLI validation.
