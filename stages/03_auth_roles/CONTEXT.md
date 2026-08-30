# Stage 03: Authentication & Role-Based Access Control

> **Layer 2 Stage Contract**: Firebase Authentication, Phone OTP, Role Claims, Auth Guards, Guest Browsing policy, and Role Context.

---

## 1. Inputs
- **Layer 3 (Reference)**: `../../references/rbac.md`
- **Layer 3 (Reference)**: `../../references/firestore_schema.md`
- **Layer 3 (Reference)**: `../../_config/coding_standards.md`
- **Authoritative Backend Spec**: `../../references/backend_upgrade_spec.md`
- **Authoritative UI/UX Spec**: `../../references/ui_ux_spec.md`
- **Layer 4 (Working)**: `../02_firebase_firestore/output/stage_summary.md`

---

## 2. Process
1. Implement Firebase Auth state observer and token listener.
2. Support dual sign-in paradigms:
   - **Customer App**: Frictionless guest browsing across Home & Menu; Phone SMS OTP login triggered seamlessly at Checkout / Profile.
   - **Partner App**: Firebase Auth with custom claims (`brand_owner`, `branch_manager`, `kitchen_staff`, `support_agent`, `developer`).
3. Build route protection guards (`ProtectedRoute.tsx`, `RoleGuard.tsx`) filtering views based on user roles and branch scoping.
4. Implement `setCustomClaims` in `/functions` for administrative staff management.

---

## 3. Outputs
- `src/core/auth/AuthContext.tsx`
- `src/core/auth/ProtectedRoute.tsx`
- `src/features/auth/components/PhoneOtpModal.tsx`
- `functions/src/auth/claims.ts`
- `output/stage_summary.md` -> Stage verification summary

---

## 4. Verify
```bash
npx tsc --noEmit && npx vitest run
```
- Assert route guards redirect unauthorized roles cleanly.
- Verify role permissions map strictly to `references/rbac.md`.
