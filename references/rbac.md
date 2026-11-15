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

**Client-read scope is narrower than the capability column.** The capability column describes what a role may do through server routes; it is not a Firestore grant. Under the current rules `support` and `regional_manager` pass `isStaff()` (used only for `branches` read) but not `isAdmin()` or `isBranchOwner()`, so on `orders` they can read only their own rows (`customerId`/`userId` == uid) and on `support_tickets`/`tickets` only tickets they raised themselves; `franchise_leads` and the money/PII collections are `isBrandOwner()`-only, giving them no staff read at all, while `branches` is readable by all six operator roles. `regional_manager` is additionally clamped to `cityIds` by the app — **unverified in this backend worktree**, since the Partner source is not present here; what is verified in `firestore.rules` is that the rules never evaluate `cityIds`, so city scoping can only be query-side, and a UI selection cannot grant Firestore permission. Whether the Partner analytics and ticket boards degrade for those two roles as a result is also **unverified** (derived from rule shape, not an emulator run); see the §4 note.

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

**Note — rules are not filters.** Firestore evaluates the rule per document and refuses a query whose constraint set cannot prove access, so a client query must itself satisfy the rule: `orders/{orderId}` read admits only `customerId == uid`, `userId == uid`, or `ownsBranch(resource.data.branchId)` (L390–395), which means a query constrained only by `store.id` is refused for branch-scoped roles (derived from the rule shape, not from an emulator run). `support` and `regional_manager` are `isStaff()` but neither `isBranchOwner()` nor `isAdmin()`, so their only `orders` read path is the self-id arm — brand-wide order reads are `brand_owner` / `developer` only. The Partner app's `isGlobalRole()` and its `GLOBAL_ROLES` membership are **unverified in this backend worktree** (the file `burgonomics-partner/src/utils/branchScope.ts` is absent here); whatever it contains, it governs UI outlet *selection* visibility and query scoping only and grants no Firestore permission.
