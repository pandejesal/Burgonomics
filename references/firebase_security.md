# BURGONOMICS — Firebase Firestore Security & Trust Boundary (Layer 3 Constraint)

> **Reference Specification**: Firestore security-rules trust boundary for the Burgonomics customer + partner apps — server-only writes for payment/credential/split keys, an authoritative RBAC role source for sensitive writes, server-side coupon validation, and a defined home for FCM device tokens. Focuses on rules-layer integrity gaps (firestore.rules) and how they interact with the server-authoritative payment/refund flows (razorpay_payments.md RZ1–RZ4) and Petpooja per-branch credentials (petpooja_pos.md P1–P5).

---

## 0. Research Decisions & Design Constraints (locked — gap review)

> Grounding: firestore.rules evaluated line-by-line against the server-authoritative patterns established for payments, credentials, and coupons. Confirmed from code that the admin SDK (`functions/src/core/firebase.ts`) ignores Firestore rules entirely, so rule tightening cannot break server functions — it only gates direct client writes. Confirmed from code that the Firestore Auth ID token (`middleware.ts:32`) is verified with `checkRevoked = true` for authenticated (non-guest) calls, which pairs with `auth.service.ts:38` revoking refresh tokens on role change.

- **F-PAY — Payment / split / credential keys are SERVER-ONLY (blocked from all direct client writes).** The orders update rule (`firestore.rules:113-117`) currently lets a branch owner/**staff** who `ownsBranch` update ANY key except `totals`/`pricingSnapshot`/`pricing`/`customerId`/`userId`/`branchId` — so `paymentStatus`, `status`, `payment.*`, `refundStatus` are directly writable by a branch staffer, letting them flip an order to `paid`/`completed` with NO actual Razorpay capture (bypassing the authoritative `payment.captured` webhook locked in RZ2). The branches update rule (`firestore.rules:129`) lets `branch_owner`/`branch_staff` edit `razorpayAccountId` (the Route linked account payouts transfer into), `petpooja.restId`/`appKey`/`accessToken`, and `servicedRadiusKm` directly — a compromised branch owner could repoint the Route payout or leak/rotate POS credentials. Locked: (a) on `orders`, extend the affected-key guard to `paymentStatus`, `status`, `payment.*`, `refundStatus` (and any split fields) — branch staff may only update fulfillment keys (`status.kind` prep/cooking, `driverId`, delivery-OTP confirmation counters); (b) on `branches`, restrict `razorpayAccountId`, `petpooja.*`, `servicedRadiusKm` to `isBrandOwner()` only.
- **F-RBAC — Hybrid role source: custom claims for read-cheap checks; freshness confirmed against `admins/{uid}` on SENSITIVE WRITES.** The rules decide roles from two sources — the `admins/{uid}` doc (fresh per read) and `request.auth.token.role` custom claim (stale up to ~1h; Firebase Auth ID tokens live ~1h and claims propagate on token refresh). `revokeRefreshTokens` + `checkRevoked=true` (already wired) narrows but does not eliminate the privilege-retention window for a revoked staffer. Locked (operational requirement: hybrid): keep custom claims for read-cheap authorization, and add a **fresh `admins/{uid}`-doc confirmation** gate on sensitive writes — payments, refunds, credentials, branch edits — so a revoked role cannot be used at the money/credential boundary until the token refreshes.
- **F-COUPON — `coupons` is admin/server-only; `petpooja_offers` is auth-gated.** Confirmed from code: ALL checkout coupon validation is server-side via `calculateOrderPricing` (`pricing.engine.ts:141` reads the `coupons` doc through the admin SDK — sole discount authority, RZ4 amount authority). The client never reads `coupons`; it reads `petpooja_offers` (`offersService.ts:26,96`) and can fall back to hardcoded `SAMPLE_OFFERS` (`offersService.ts:35`) for a non-authoritative preview. Yet rules expose BOTH `coupons` (`firestore.rules:358`, `allow read: if true` — zero client consumers) and `petpooja_offers` (`firestore.rules:179`, `allow read: if true` — real consumer, carries `code` + `discount` + `maxDiscount`). Locked: `coupons` = deny ALL client read/write (server-only; guest checkout is unaffected because it validates server-side); `petpooja_offers` = `allow read: if isAuthenticated()` (registered users browse catalog; guests + scrapers can't enumerate codes/discounts).
- **F-TOKEN — dead `device_tokens` rules locked/deleted; real personal-token home is `users/{uid}/tokens/{deviceId}` gated `isUser(uid)`.** Confirmed the `device_tokens` collection (`firestore.rules:333`, `allow create, update: if isAuthenticated()` — no ownership check) is VESTIGIAL: it appears nowhere in any app or function. FCM dispatch is server-controlled via topics (`branch_{id}`) or an explicit token passed by a trusted server caller (`fcm.service.ts:48-52`); in-app notifications write to `users/{uid}/notifications` (`fcm.service.ts:63-78`). There is no client-side FCM-token write anywhere today, so the naive "device-token hijack" is not currently reachable. Locked: lock/delete the dead block (avoid a false sense of security), and define the intended per-device token model as `users/{uid}/tokens/{deviceId}` with `allow create/update: if isUser(uid)` (owner's own device only) for any future per-device sends; document it in `firestore_schema.md`.

---

## 1. Orders Write Boundary
- **Affected-key guard extended (F-PAY)**: the branch-owner update rule must also refuse direct writes to `paymentStatus`, `status`, `payment`, `refundStatus`, and any Route-split fields, exactly like it already refuses `totals`/`pricingSnapshot`/`pricing`/`customerId`/`userId`/`branchId`. The ONLY client-writable keys for branch staff are fulfillment/customer-service ones (kitchen state transitions, driver assignment, OTP confirmation counters).
- **Payment confirmation stays server-only (RZ2 + F-PAY)**: `paymentStatus` flips to `completed`/`accepted` and `refundStatus` to `refunded` exclusively through `payment.captured` (webhook, authoritative) / `verifyPayment` (guarded shim) / `autoRefund` — never by a direct client document write. This makes the RZ2 webhook authority tamper-proof at the rules layer.
- **Create still allows customers** (own order only) — unchanged.

## 2. Branch Credential & Payout Boundary
- **Brand-owner-only keys (F-PAY)**: on `branches`, `razorpayAccountId` (Route linked account), `petpooja.restId`/`appKey`/`appSecret`/`accessToken`, and `servicedRadiusKm` are writable ONLY by `isBrandOwner()`. `branch_owner`/`branch_staff` retain non-credential operational fields (timing, config, availability).
- **Per-branch credential integrity (P3/P4)**: this rules tightening composes with the Petpooja per-branch credential model (P3 uses stored `branches/{id}.petpooja.restId`; P4 per-branch webhook resolution). Because the SDK ignores rules, server-side credential reads are unaffected; the rules change only stops a branch client from mutating another branch's (or its own) credentials.

## 3. RBAC Role Source (Hybrid)
- **Read-cheap checks** (catalog, own-doc reads) may keep the fast custom-claims path (`request.auth.token.role`).
- **Sensitive writes** (payments, refunds, credentials, branch edits) additionally confirm active role against the fresh `admins/{uid}` doc (`getAdminDoc().data.role is ...` + `branchId`) before allowing — closing the up-to-~1h privilege-retention window at the money/credential boundary (F-RBAC).
- `admins/{uid}` writes remain `isBrandOwner()` only.

## 4. Coupon & Offer Access
- **`coupons`**: `allow read, write: if false` (server-only via admin SDK in `pricing.engine.ts:141`). No client consumer exists (F-COUPON).
- **`petpooja_offers`**: `allow read: if isAuthenticated()`; server writes via admin SDK (`allow write: if false` or brand-owner). Guests still get server-side coupon validation through `calculateOrderPricing` (F-COUPON) — no client `coupons` read is required.
- Marketing catalog remains browseable by logged-in users; code/discount enumeration by unauthenticated scrapers is closed.

## 5. Device Tokens
- **Dead `device_tokens` block**: remove or fully deny (`allow read, write: if false`) the vestigial top-level `device_tokens/{token}` rules; nothing consumes it (F-TOKEN).
- **Intended model** (document only, no code change required unless per-device pushes are built): personal FCM tokens live at `users/{uid}/tokens/{deviceId}` with `allow create, update: if isUser(uid)` (owner's own device only) and `allow read: if isUser(uid) || isAdmin()`. Topic-based branch alerts (`branch_{id}`) remain server-dispatched and need no token store.

---

## 6. Open / Watchlist Mapping
- `references/known_issues.md` R19–R22 track the concrete rules gaps behind F-PAY, F-RBAC, F-COUPON, F-TOKEN.
- Composes with `razorpay_payments.md` (RZ2 webhook authority stays tamper-proof at the rules layer) and `petpooja_pos.md` (P3/P4 per-branch credentials protected from client mutation).
