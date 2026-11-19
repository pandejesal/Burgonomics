# BURGONOMICS — Role-Based Access Control & Claims (Layer 3 Constraint)

> **Reference Specification**: Role hierarchy, Firebase custom claims, Express auth middleware, and Firestore security rule helpers.

---

## 1. Role Hierarchy & Matrix

```
[ Developer ] ───────── [ Brand Owner ] (Global Super-Admin)
                             │
                      [ Regional Manager ]
                             │
                      [ Support Agent ]
                             │
                      [ Branch Owner / Manager ]
                             │
                      [ Branch Staff / Kitchen ]
                             │
                      [ Customer ]
```

---

## 2. Firebase Custom Claims & Scoping

| Role Claim (`role`) | Target Application | Scope | Key Permissions & Capabilities |
|---|---|---|---|
| `brand_owner` | Partner App | Global (All Branches) | Global analytics, edit brand royalty %, manage branches, global combos, claims administration |
| `developer` | Partner App | Global (All Branches) | System diagnostics, error snapshot inspection, developer alert channels, claims administration |
| `regional_manager`| Partner App | Multi-Branch / City | Multi-branch analytics, regional menu synchronization, franchise oversight |
| `support` | Partner App | Global Tickets | Central dispute management, multi-branch customer support, goodwill coupon dispatch |
| `branch_owner` | Partner App | Assigned Branches (`branchIds`) | Live KOT stream, courier dispatch (Borzo / Shadowfax provider booking or the restaurant's own in-house rider via `POST /orders/manualDispatch` [`deliveryStatus: "dispatched"`, `dispatchType: "manual_branch_terminal"` — restaurant-driven delivery, never customer pickup]; the retired Porter adapter refuses bookings unless explicitly re-armed via `PORTER_ENABLED="true"`), branch combo creation, ticket resolution |
| `branch_staff` | Partner App | Assigned Branches (`branchIds`) | Live KOT cooking progression (`preparing` → `food_ready`), 86ing stock toggles, in-house rider assignment (`POST /orders/manualDispatch`) |
| `customer` | Foundation Core | Self (`uid`) | Place orders, track deliveries, raise tickets, manage addresses & Grill Coins |

**Client-read scope is narrower than the capability column.** On primary `orders`, support can read globally and regional managers can read assigned branches only, using `admins/{uid}` role and `branchIds` from the same document. This adds no write permission or other collection grants. Existing self-order, brand and branch arms remain unchanged; ticket and money/PII access is not expanded. A selection or city does not confer order authority.

**Walk-in replay metadata is server-only.** `walkInRequestHash` and `walkInReceipt` bind a retry to the original server-priced result. No client role, including brand/developer and assigned branch operators, may add, replace, remove or patch nested values in either field. Safe notes edits remain permitted; the Admin SDK retains the server write lane.

---

## 3. Server-Side Middleware Enforcement (`functions/src/core/middleware.ts`)

- **`requireAuth`**: Extracts Bearer JWT and executes `auth.verifyIdToken(token, true)` enforcing `checkRevoked: true` on every protected route.
- **`requireRole(allowedRoles)`**: Grants on any of three tests: the `isBrandAdmin` claim / `brand_owner` / `developer` role always passes regardless of `allowedRoles` (`middleware.ts` L76–84); otherwise the token `role` must be in the whitelist (L86–89); otherwise an `admins/{uid}` doc whose `role` is in the whitelist (or `brand_owner`/`developer`) passes (L91–106). No branch/city scope is checked here — services do that from `caller.branchIds`.
- **`verifyPetpoojaAuth`**: Fail-closes (401) when `PETPOOJA_APP_KEY` is unset; an `x-petpooja-signature` header must verify as HMAC-SHA256 over the raw body (timing-safe, no fallback on a bad signature); otherwise accepts an app-key token header, and accepts credential-less callbacks by shape on the order route only (`middleware.ts` L327–409).
- **Token Invalidation on Role Change**: `setUserCustomClaims` (`functions/src/modules/auth/claimsManager.ts`, not `auth.service.ts` — that file does not exist) calls `auth.setCustomUserClaims` then best-effort `auth.revokeRefreshTokens(uid)` (L181–188), and mirrors `role`/`branchIds`/`cityIds` into `users/{uid}` (L190–205); it mirrors them into `admins/{uid}` only for staff, and otherwise attempts to delete that admin document (L207–227).

---

## 4. Firestore Security Rules Helpers (`firestore.rules`)

The RBAC helpers live in one block at the top of the file (L18–78) and are called from `allow` expressions throughout; path-specific helper families (order create masks, announcement bounds, ticket masks, chat authorship) are declared further down next to the collection they guard.

- `isAuthenticated()`: `request.auth != null` (L18–20).
- `isUser(userId)`: `isAuthenticated() && request.auth.uid == userId` (L22–24).
- `getAdminDoc()`: `get(/databases/$(database)/documents/admins/$(request.auth.uid))` — an unconditional doc fetch with no existence guard of its own; all three call sites (`hasRole`, `ownsBranch`, `chatSenderRoleIsOwn`) guard it with an `exists(...)` check first (L26–28, used at L40, L74, L961–966).
- `brandRoles()`: `['brand_owner', 'developer']` (L30–32).
- `staffRoles()`: `['brand_owner', 'developer', 'support', 'regional_manager', 'branch_owner', 'branch_staff']` (L34–36).
- `hasRole(roles)`: `isAuthenticated() && ((exists(admins/uid) && getAdminDoc().data.role in roles) || (request.auth.token != null && request.auth.token.role in roles))` — either source suffices, so a token claim alone passes without an `admins` doc. An `admins` doc with no `role` field fails closed (L38–43).
- `isAdmin()`: `hasRole(brandRoles())` — `brand_owner` / `developer` only. It no longer admits `support`, `regional_manager`, `branch_owner` or `branch_staff`; holding only an `admins/{uid}` doc (no matching `role`) does not pass (L52–54).
- `isStaff()`: `hasRole(staffRoles())` — all six operator roles. It is called exactly once today, for `branches/{branchId}` read (L499); announcement writes use a separate `hasRole(['brand_owner', 'developer', 'support'])` helper (`globalAnnouncementWriter`, L691–693). Non-brand operators get no staff grant to user profiles (`users/{userId}` read is `isUser(userId) || isAdmin()`, L344–345) or to the money ledgers (`payments` L881–883, `refunds` L886–891, `payment_discrepancies` L893–898, all `isBrandOwner()` read / `false` write); self-profile access remains permitted through `isUser()` (L345).
- `isBrandOwner()`: `isAdmin()` — `brand_owner` / `developer` only, with no separate claim-or-doc test of its own (L63–65).
- `isBranchOwner()`: `hasRole(['branch_owner', 'branch_staff'])` — it does **not** include `isAdmin()`, so a brand owner is not `isBranchOwner()` (L67–69).
- `ownsBranch(branchId)`: `isBrandOwner() || (isBranchOwner() && ((exists(admins/uid) && getAdminDoc().data.branchId == branchId) || (request.auth.token != null && branchId in request.auth.token.branchIds)))` — brand roles own every branch; a branch role must prove ownership through the token `branchIds` array or the singular `branchId` on its `admins` doc. The `branchIds` array written into the `admins` doc is **not** read here (L71–78).

**Note — rules are not filters.** Regional order queries must constrain `branchId` to assigned values; split larger assignments into `in` chunks of at most 10. Unbounded, mixed-foreign and `store.id`-only queries fail. Missing/scalar/empty assignments deny. Firestore rules cannot generically type-check every member of an unbounded list: the emulator accepts a matching string in a mixed list such as `["a", 42]`. Only matching nonempty string branch IDs grant access; registry writes remain protected and the client resolver is stricter. Regional token claims never substitute for the registry in this new grant; existing independent self and branch/brand grants are unchanged.

## 5. Staff suspension (F06) — `users/{uid}.active` is an authorization input (deployed 2026-11-19)

A role is no longer sufficient on its own: an operator must also be **active**.

- `users/{uid}.active` is the suspension flag. Missing field means **not active** (fail closed); the F06 drawdown therefore requires a one-time inventory/backfill of staff profiles before the gate is enforced (staging: 4 staff profiles had no `active` and were set `true` by the deploy driver's P1, which only writes where the field is absent).
- Firestore: `staffProfile()` / `staffActive()` helpers; `active == true` is the LAST conjunct in **both** `hasRole` arms, so neither a token claim nor an `admins/{uid}` doc can bypass a suspended profile. `regionalOrderRead()` is gated the same way (privileged read). Brand `users/{uid}` update arm now denies `active`, `suspendedAt`, `suspendedBy`, `isDeleted`, `deletedAt` — clients cannot self-reactivate.
- Storage: `privilegedStaffToken()` (claim-only, zero reads) + `staffActive()` via exactly ONE `firestore.get`, combined as `privilegedAndActive() = !privilegedStaffToken() || staffActive()` on create and read. Customer tokens short-circuit before any read. A privileged token with **no** `users/{uid}` doc makes the read evaluate to null and the request is denied — the intended fail-closed path (it logs a rules evaluation error, accepted by the parent as intended behaviour).
- Server: `functions/src/core/middleware.ts` `isAccountActive(uid)` (one read, fail closed) plus a lazy `requireRole` gate on every admission arm; denials return `403 ACCOUNT_SUSPENDED`. `requireAuth` is untouched, so customer routes are unaffected.
- Suspension itself: `POST /auth/suspendStaff` (requireAuth + requireRole brand/developer + strict body, no `actorUid`) runs ONE transaction that re-reads the actor (`admins` role AND `users.active`), denies self-suspension, writes `active` + `suspendedAt`/`suspendedBy` + the `admin_audit_logs` row atomically, and no-ops on repeat; `revokeRefreshTokens` runs after commit and is secondary. `staffInvite` samples existence BEFORE `setUserCustomClaims`, so `active: true` is initialised only on first provision and a re-invite never reactivates.
- Partner client: `useUsers.toggleUserStatus` is server-first — no `updateDoc`/`setDoc` of `active`, no optimistic flip; a refusal reaches the existing error toast.
