# WHITEBOX-FUNC — White-Box Security Review: functions + rules (findings only)

Model: opencode/muse-spark-1.3-contributor-free (all lanes same model). Scope: `functions/`, `firestore.rules`, `firestore.indexes.json`, `firebase.json`. Read-only, no commits/builds. Three parallel lanes: (a) authz+rules, (b) injection/forgery, (c) secrets/crypto/storage+headers.

## EXPLOITABLE (ranked)

### Critical
1. `firestore.rules:285,301` — Branch-owner direct ticket UPDATE bypasses Admin SDK transitions. Any `branch_staff` with `ownsBranch(branchId)` can client-`update()` `tickets/` + `support_tickets/` `status/resolution` (e.g. self-resolve/escalate). Fix: `allow update: if isBrandOwner()` only; force mutations via `tickets.service.ts`.
2. `functions/src/index.ts:520` + `functions/src/modules/tickets/tickets.service.ts:260` — `/tickets/message` trusts client `senderRole` fallback. Authed customer with stale/role-less token posts `{"senderRole":"staff"}` → flips `status=in_progress`, forges `actorRole=staff` timeline. Fix: `senderRole = caller?.role ?? "customer"`, drop body fallback.

### High
3. `functions/src/modules/petpooja/item86ingSync.ts:39,153,217` — 86-ing webhook has no HMAC/replay; `status:-1` auto-refunds. Attacker with leaked `appKey` (same secret sent outbound as `Content_key` in `orderPush.ts:104`) POSTs `rest_id/item_id/in_stock` to hide menu or trigger `autoRefund()` on own payment. Fix: verify inbound HMAC over raw bytes + timestamp + idempotency key; separate inbound/outbound secrets.
4. `functions/src/modules/petpooja/menuSyncWebhook.ts:227,161` — Menu-push takes unauth `payload`; forged `rest_id`+items overwrite `products.price`, then `pricing.engine.ts:174` charges attacker price. Fix: require HMAC + `resolveBranchIdForRestId` allowlist, reject unlinked, never fallback.
5. `functions/src/modules/payments/razorpay.service.ts:645` — `autoRefund()` takes no `caller`. Compromised Petpooja webhook path (`item86ingSync.ts:219`) refunds arbitrary `paymentId` without staff RBAC. Fix: add `caller:StaffCaller` + `assertOrderBranchAccess` + `requireRole` + idempotency on `(paymentId,amount)`.
6. `functions/src/modules/payments/razorpay.service.ts:361` vs `functions/src/modules/payments/routeTransfers.ts:100,258` — Sync-verify transfer path omits ceiling; tampered `pricing.split.branchTransferPaise` over-pays branch. Fix: pass `capturedAmountPaise` from `assertLivePaymentMatchesOrder` into `attemptRouteTransfer`.
7. `functions/src/modules/auth/guestMigration.ts:285,293` — `guestProof` optional + null-caller path. Unauth POST with guessed `guestSessionId`/`anonymousUid` + arbitrary `permanentUid` relinks victim guest orders/tickets to attacker. Fix: always require `verifyGuestOwnershipProof`, `requireAuth`, `caller.uid===permanentUid` fail-closed.
8. `functions/src/core/middleware.ts:43` — `optionalAuth` swallows bad token, continues as guest; `createPaymentOrder` falls back to body `customerId` (`validation.ts:39`). Expired/revoked token stamps victim `customerId`, poisons pricing/loyalty. Fix: 401 on present-but-invalid token; `customerId = req.user.uid` authoritative.
9. `functions/src/modules/porter/porter.service.ts:550,838` — Webhook dedup check-then-act. Concurrent replay `DELIVERED` vs `RIDER_CANCELLED` both pass, last-writer-wins state flip-flop + double alert. Fix: `create()`-claim on `parkId` (cf. `webhookHandler.ts:78`) before `orderRef.set`.
10. `firestore.rules:262` — `branch_announcements` any-staff global write, no `ownsBranch`/`branchId` bind/mask. Any `branch_staff` writes any announcement (defacement/phishing broadcast). Fix: `isStaff() && ownsBranch(branchId)` + field mask.
11. `firestore.rules:454,465` — `franchise_leads` + `franchise_inquiries` readable by ALL branch staff, no `ownsBranch` (docs carry no `branchId`). Bulk PII harvest (name/phone/city). Fix: `allow read: if isBrandOwner()` only.
12. `firestore.rules:85` — `customers` update mask misses money flags (`grillCoins`, `hasClaimedWelcomeBonus`, `branchIds`, `favoriteBranchId`). Customer PATCHes own coins/bonus. Fix: extend `hasAny` list.
13. `firestore.rules:99` — `users` update mask misses `hasClaimedWelcomeBonus/branchIds/cityIds`; owner resets bonus then re-calls `/auth/migrateGuest`. Fix: extend mask (deterministic-ID is only backstop today).
14. `functions/src/modules/tickets/tickets.service.ts:27` — `assertStaff` null-caller bypass (`if(!caller) return`). Miswired/legacy direct call resolves/escalates as anyone. Fix: `throw 403` fail-closed.
15. `functions/src/modules/customers/customerCoins.ts:54` — Branch scope via mutable `favoriteBranchId` + stale token `branchIds`, no `admins`-doc re-fetch. Customer rewrites own branch to shop for payout. Fix: staff-only `favoriteBranchId`; resolve `branchIds` server-side.
16. `functions/src/modules/notifications/fcm.service.ts:143` — `Math.random()` notification IDs (~21 bits entropy) enumerable/spoofable. Fix: `crypto.randomUUID()`/`randomBytes`.

### Medium (exploitable with preconditions)
17. `functions/src/modules/payments/webhookHandler.ts:14` — `rawBody` fallback `JSON.stringify(req.body)`; missing `express.json verify` → legit 401 DoS or key-order collision forgery. Fix: fail-closed 401 when `rawBody` absent.
18. `functions/src/modules/payments/webhookHandler.ts:29` — `if(mock.paymentGateway) skip-verify`; one env flip disables all Razorpay auth. Fix: separate `MOCK_ALLOW_UNSIGNED_WEBHOOK` gate, fail-closed in prod + alert.
19. `functions/src/modules/payments/pricing.engine.ts:304,48,71` — `loyaltyPointsToRedeem` never checked vs ledger (20%-cap only); negative customizer `priceDelta` floors total. Free discount. Fix: `min(requested,balance,20%)` + atomic debit; reject negatives in-engine.
20. `functions/src/modules/payments/pricing.engine.ts:234` — Coupon doc read-only, no `maxUses/perUser/usedCount` transaction; replay across checkouts. Fix: transactional counters + refuse-to-charge on mismatch.
21. `functions/src/modules/porter/porter.service.ts:245,932,1044` — `if(caller)` makes branch auth optional; caller-less call books/verifies/dispatches any order. Fix: require non-null caller + `assertOrderBranchAccess`; schedulers use service identity.
22. `functions/src/core/middleware.ts:90` — `requireRole` falls back to `admins/{uid}` doc; if rules ever allow self-write, attacker mints `branch_staff`. Fix: claims-only, alert on fallback hit.
23. `functions/src/modules/notifications/fcm.service.ts:85` + `fcmClient.ts:166,178` — `dispatchFCM`/`pushToCustomer` accept arbitrary copy+topic; token register without ownership proof → phishing push + token-harvest. Fix: topic allowlist, server-only templates, device-attested self-only `arrayUnion`, rate-limit.
24. `firestore.rules:68` — `ownsBranch` singular/plural mismatch (`branchId` vs mirrored `branchIds[]` in `claimsManager.ts:177`) + stale `token.branchIds` trust. Fix: check `branchId in doc.get('branchIds',[])`, re-fetch.
25. `firestore.rules:119,137` — `users/{uid}/orders` create has no body bind; top-level allows `customerId==uid OR userId==uid` → stamp `self+victim` to pollute victim reads. Fix: pin both fields to path `userId`.
26. `firestore.rules:376` — `chats/{chatId}` participant update, no field mask; member rewrites thread, ejects victims, adds sockpuppets. Fix: `hasOnly(['lastMessage','updatedAt'])`.
27. `functions/src/modules/auth/claimsManager.ts:30,173` — `branchIds/cityIds` unvalidated; `driver` gets `isStaff`+`admins` doc but `staffRoles()` (`firestore.rules:31`) excludes it (orphan). Fix: validate IDs + caller scope; add or drop `driver`.
28. `functions/src/core/security.ts:12-14` — `timingSafeEqual` early-false on length mismatch leaks signature length via timing. Fix: hash both sides before compare.
29. `functions/src/core/firebase.ts:12-13` — Service-account parse failure warns (may echo key fragment) then fail-open `initializeApp()`. Fix: throw, log `message` only.
30. `functions/src/modules/notifications/fcm.service.ts:137` / `fcmClient.ts:63,135,148,194` — Full-error/`console.warn` logging of FCM failures persists tokens/PII in Cloud Logs. Fix: log `.message` (+ hashed uid) only.

## HARDENING (defense-in-depth)
- `firebase.json` (no `storage` key) — No Storage rules section; buckets fall back to default/permissive. Fix: add `"storage"` + deny-by-default `storage.rules`.
- `firebase.json:58,98` — CSP `style-src 'unsafe-inline'`, no `form-action`/`upgrade-insecure-requests`. Fix: nonce/hash, add `form-action 'self'; upgrade-insecure-requests`.
- `firebase.json:55,95` — HSTS without `preload`. Fix: append `; preload` after submission.
- `firebase.json:104-118` — Emulator ports `5001/8085/9099/4000` + UI enabled. Fix: bind `127.0.0.1`, `enabled:false` outside dev.
- `functions/package.json:23` — `cors`+`express` present, no allowlist in scope; wildcard `cors()` would expose payments/webhooks. Fix: pin `origin:[app,partner]` + verify wiring.
- `firestore.rules:428,111` — `notifications` readable by all brand roles (`isAdmin()` incl `developer` via `token.role`). Fix: owner-only default, audit-logged triage path.
- `firestore.rules:411,421` note — `/admins/{uid}/sessions` correctly server-only (`allow ... : if false`); keep partner `adminAuthService` client write migrated to server mint (queued 4Z/5).
- `functions/src/modules/payments/razorpayClient.ts:17` vs `functions/src/config/env.ts:135-136` — Mock-guard case-sensitive `includes("mock")`. Fix: `toLowerCase()` + block `test/dummy/example`.
- `functions/src/modules/payments/webhookHandler.ts:62` — Freshness only if `created_at` present; strip to bypass 15-min window. Fix: require timestamp or quarantine to `unmatched_payments`.
- `firestore.indexes.json:46,150,258,276` — `dev_error_snapshots/payments/refunds/coin_transactions(phone)` are client-queryable shapes (PII: phone in `coin_transactions`). Confirm rules keep `payments/refunds/payment_audits/unmatched_*/admin_audit_logs/dev_error_snapshots` at `allow read,write: if false` (server-only via Admin SDK) and strip PII from error snapshots.
- `functions/src/index.ts:507,517` — `/tickets/*` lack `validateBody`; spam guards fail-open on query error. Fix: wire schemas, fail-closed.

## Method note
- Lane (a) authz+rules, lane (b) injection/forgery, lane (c) secrets/headers ran in parallel, same model; 2 lanes hit transient connect flakes once and succeeded on retry. Spot-check scoping only; `file:line` values are lane-reported — re-verify against HEAD before ticketing.
- Positive: no `|| 'test'` secret fallbacks (`env.ts`, `.env.example`); Razorpay/Petpooja verifiers deny on empty secret (`razorpayClient.ts:14-25`, `petpooja/client.ts:37-43`, `security.ts:34-65`).
