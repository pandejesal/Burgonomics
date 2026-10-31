# Lane 07 — Firebase database, auth, rules, FCM

Mission: Firestore data model, rules, indexes, Auth/RBAC, Storage, and FCM are
secure and correct under real client behavior, including multi-tenant branch scoping
and token ownership.

Owned:
- `firebase.json`, `firestore.rules`, `firestore.indexes.json`, storage rules.
- `functions/src/modules/auth/**`, `functions/src/modules/notifications/**`.
- Auth/notification tests, customer `tests/rules/**`, `scripts/test-rules.mjs`.

Do not touch: other Functions modules, app routes/screens, payment or dispatch.

First actions:
1. Read CONTRACT/BASELINE/LANES; check the committed state of the token-ownership fix
   and rules tests before redoing anything.
2. Run the rules/emulator tests that the repo actually supports; record exact
   commands and whether the emulator/tooling was available. If not available, say so.
3. Pick one real security/correctness gap with a negative test proving the hole:
   e.g. cross-tenant read, ownerless token adoption, branchId authority, role claim
   escalation, missing index causing failed production query.
4. Claim exact files; fix; add positive+negative tests; DS then GLM; gate; commit.

Known focus: `unregisterToken` ownership/transactionality (recently committed — verify),
register-token wiring owned by lane 04 (`index.ts`) with your service review,
customer-writable branchId authority, rules that permit foreign-owner writes.
No rules deployment. No live PII read/write. No auth weakening for convenience.

Constraints: emulator-only unless a real test project is explicitly approved; never
print credentials or service account material.
