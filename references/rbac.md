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
| `branch_owner` | Partner App | Assigned Branches (`branchIds`) | Live KOT stream, manual Porter rider booking, branch combo creation, ticket resolution |
| `branch_staff` | Partner App | Assigned Branches (`branchIds`) | Live KOT cooking progression (`preparing` → `food_ready`), 86ing stock toggles |
| `customer` | Foundation Core | Self (`uid`) | Place orders, track deliveries, raise tickets, manage addresses & Grill Coins |

---

## 3. Server-Side Middleware Enforcement (`functions/src/core/middleware.ts`)

- **`requireAuth`**: Extracts Bearer JWT and executes `auth.verifyIdToken(token, true)` enforcing `checkRevoked: true` on every protected route.
- **`requireRole(allowedRoles)`**: Enforces custom claims role validation against the whitelist with fallback verification to the Firestore `admins` collection.
- **`verifyPetpoojaAuth`**: Validates Petpooja webhook authentication secret/tokens for POS sync and stock webhooks.
- **Token Invalidation on Role Change**: When `setUserCustomClaims` is called in `auth.service.ts`, it automatically executes `auth.revokeRefreshTokens(uid)` to revoke outstanding tokens immediately.

---

## 4. Firestore Security Rules Helpers (`firestore.rules`)

- `isAuthenticated()`: `request.auth != null`
- `isUser(userId)`: `isAuthenticated() && request.auth.uid == userId`
- `isAdmin()`: `isAuthenticated() && (exists(/databases/$(database)/documents/admins/$(request.auth.uid)) || request.auth.token.role in ['brand_owner', 'developer', 'support', 'regional_manager', 'branch_owner', 'branch_staff'])`
- `isBrandOwner()`: `isAdmin() && (request.auth.token.role in ['brand_owner', 'developer'] || getAdminDoc().data.role in ['brand_owner', 'developer'])`
- `isBranchOwner()`: `isAdmin() && (request.auth.token.role in ['branch_owner', 'branch_staff'] || getAdminDoc().data.role in ['branch_owner', 'branch_staff'])`
- `ownsBranch(branchId)`: `isBrandOwner() || (isBranchOwner() && (branchId in request.auth.token.branchIds || getAdminDoc().data.branchId == branchId))`
