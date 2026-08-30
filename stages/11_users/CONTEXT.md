# Stage 11: User & Staff Administration

> **Layer 2 Stage Contract**: Staff directory, role assignments (Brand Owner, Branch Manager, Kitchen Staff, Support, Developer), branch access mapping, Firebase custom claims, and audit logging.

---

## 1. Inputs
- **Layer 3 (Reference)**: `../../references/rbac.md`
- **Layer 3 (Reference)**: `../../_config/coding_standards.md`
- **Authoritative Backend Spec**: `../../references/backend_upgrade_spec.md`
- **Layer 4 (Working)**: `../10_branches/output/stage_summary.md`

---

## 2. Process
1. Build Staff User Directory table (filtered for Brand Owners).
2. Create "Invite Staff / Add User" modal:
   - Full Name, Email, Phone
   - Role selection dropdown (`branch_manager`, `kitchen_staff`, `support_agent`, `developer`)
   - Branch mapping (Select assigned branch)
3. Call `setCustomClaims` Cloud Function to update Firebase Auth tokens with custom claims.
4. Implement deactivate user / revoke access controls with audit logs.

---

## 3. Outputs
- `src/features/users/components/UserList.tsx`
- `src/features/users/components/AddUserModal.tsx`
- `functions/src/auth/setCustomClaims.ts`
- `output/stage_summary.md` -> Stage verification summary

---

## 4. Verify
```bash
npx tsc --noEmit && npx vitest run
```
- Verify that role assignments sync correctly with Firebase custom claims and Firestore security rules.
