# Quality Loop — 10 × 3 parallel find-and-fix sweeps

> Each loop: 3 parallel finder lanes (functions / partner / core) return top
> findings with file:line + evidence → architect verifies → fixes → gates.
> Status: `pending` | `running` | `done`. Lanes are READ-ONLY; fixes by architect.

- [ ] Loop 1: Swallowed errors & silent failures (unhandled rejections, missing toasts, empty catches)
- [ ] Loop 2: Firestore rules vs actual queries (denied reads/writes, missing indexes, offline behavior) [RUNNING → done below]

### Loop 2 — rules vs queries (done)
- Fixed: KDS topic orphan (`branch_<id>` → `branch_<id>_orders`); Android channel creation in customer app; useMenu re-read from dead collection; deleted dead legacy orderService; cancelOrder persists to Firestore; webhook rest_id reverse-lookup (skip-loudly when unlinked); store-id default branchIds removed; combos stamped restId+petpoojaItemId; branch guards on menu mutations; seed CRM dev-gated; sessions listener error UI; 4 new composite indexes (routeTransfer, petpooja retry, coin_transactions, notifications); `petpoojaStoreId` added to branch-update guard; customer self-cancel rule (pre-terminal, status-only); delivery gateway log writes removed (rules-denied noise) + server-side sync audit trail; tracking onError forwarding.
- Dismissed with reason: S5 fcmTokens (allowed by exclusion — not in deny list); C3 restId composite (single-field where needs none); C4 userId query (works; customerId index kept for partner); P1 simulate fallback (explicit dev action, button gated); P3 denial unreachable (activate UI dead + rule now covers field).
- Queued (needs product call): admin orders migration, device_tokens ownership, orders-create field mask.
- Gates: functions 121 · partner 130 · core 205+18 skipped — all green.
- [ ] Loop 3: Money paths re-verify (totals, caps, rounding, refunds, loyalty) [RUNNING → done below]

### Loop 3 — money paths (done)
- Critical: live online payments were unbuildable (client sent no items/branch/loyalty → server 500). Client now sends items + storeId + coupon + loyalty + idempotency key; server resolves branch via stores.partnerBranchId, reuses open gateway orders on retry (no double charge), rejects zero totals.
- Critical: loyalty display 50% vs server 20% (user overpaid + lost points). All client caps + copy + tests now 20%.
- Guards: coupon percent clamped (0,100]; no-repeat transfer on re-verify; order.paid entity shape handled (+ no undefined writes).
- Deferred (bigger): usage-count coupons, Route onboarding checks, admin refund/loyalty server transactions, analytics estimate labels.
- Gates: functions 125 · core 205+18 skipped · builds green; root + core pushed.
- [ ] Loop 4: Notification pipeline end-to-end (topics, channels, tokens, triggers) [RUNNING → done below]

### Loop 4 — notifications (done)
- Fixed: customer PLACED confirm on order create (was kitchen-only); urgent-born tickets alert (new trigger); subscribe route allowlisted + ownership-checked; FCM sound "new_order" (was 404 name); partner subscribes _tickets topics + fresh user on refresh; foreground ticket View action; refresh-login token linking; logout drops token from user fan-out (explicit uid).
- Dismissed: server-side fcmTokens writer (client covers), token-refresh listener (Capacitor re-fires registration), inbox poll fallback (feature, not fix).
- Gates: functions 125 · partner 130 · core tsc clean.
- [ ] Loop 5: Menu pipeline (sync, 86-ing both directions, images, categories) [RUNNING → done below]

### Loop 5 — menu pipeline (done)
- Fixed: branch-scoped product doc IDs (second synced branch no longer steals the first's docs); stock webhook attributes branchId/restId (orphans staged, never merged); stock-push ack accepts all Petpooja forms; retry worker dead-letters exhausted orders; re-enable clears stale 86 metadata; POS pushes skipped (loudly) without petpoojaItemId; combos warn when restId missing; unscoped menu reads return [] instead of cross-store leak; "Other" label; category toggle index.
- Dismissed: categories persistence (derived by design), isVeg default (pure-veg brand), image SAMPLE fallback (exact-match only), home mock rails + trending (separate feature), KDS 86 badges (feature).
- Gates: functions 125 · partner 130 · core 205+18 skipped · all builds green.
- [ ] Loop 6: Auth/session/RBAC (claims, guards, login flows, OTP) [RUNNING → done below]

### Loop 6 — auth/session/RBAC (done)
- Fixed CRITICAL: partner hardcoded PIN roster (1234/5678/9999=owner) deleted — roster empty, PINs fail closed; demo hints + operator-email directory removed from login; lock screen gains sign-out escape.
- Fixed: partner unknown-role fail-open to developer → fail-closed deny; route policy enforced in ProtectedRoute (default-deny, single source routePolicy.ts); branch_staff locked out of picker + all hooks clamp to assigned branches (branchScope.ts); scoped-no-branch reads return empty; customers scoped for staff; single auth listener + force-refresh on bootstrap.
- Fixed: server guest-migration now requires anonymous source proof; welcome bonus atomic via deterministic create() + E.164; delivery OTP route staff-only + branch-scoped; porter/dispatch services enforce order.branchId ∈ caller branches; claims sync admins/ registry (demotion deletes); onUserDeleted wired (v1 trigger) with PII strip.
- Fixed: customer order IDOR (ownership check); bootstrap requires live Firebase uid match; httpClient auth interceptors implemented + wired; OTP resend store-throttled; QuickAuthSheet uses canonical validators, 6-digit gate, no code autofill.
- Dismissed: optionalAuth no-revocation (documented guest exception), categories persistence n/a, admin-portal separate session (queued).
- Gates: functions 131 · partner 138 · core 207+18 skipped · all builds green. Committed locally; pushes blocked on 403 (credential rotation pending user).
- [ ] Loop 7: Performance (N+1 queries, bundle weight, re-renders, pagination) [RUNNING → done below]

### Loop 7 — performance (done)
- Fixed functions: Razorpay webhook idempotency claim-before-work (closes double-KOT on retry, stale-claim takeover); ticket reminder batch+allSettled; KOT retry worker chunked(4) + single-scan dead-letter; route-transfer branch prefetch + chunked attempts; pricing branch+coupon reads concurrent.
- Fixed partner: useOrders limit(100) + server-side dateRange (was accepted-then-ignored); dashboard 3-fetch Promise.all; CustomerDetailPage drops full-collection useOrders for scoped customer.orders; chat threads/messages bounded (30/50, order preserved); tickets dual-fetch concurrent + Set dedup.
- Fixed core: menu restId cache + 30s products cache (one scan per open, invalidated by live listener); live listener merges buckets (no pagination clobber); order history one-fetch-per-session cache; menu pager windowed to active±1; tab bar motion→CSS (shell chunk); home rails lazy+async images, first banner eager.
- Dismissed: aggregate-query counts (needs schema alignment, follow-up); chat "load older" pagination (follow-up); React.lazy sheet splits + manualChunks (follow-up); per-card motion springs (visual, follow-up).
- Gates: functions 131 · partner 138 · core 207+18 skipped · all builds green. Committed locally; pushes still blocked on 403.
- [ ] Loop 8: UX dead-ends (dead buttons, empty states, broken routes/links) [RUNNING → done below]

### Loop 8 — UX dead-ends (done)
- Fixed functions: unmatched captured payments parked in unmatched_payments (was acked-ok + dropped); resolveTicket refund throws loudly when no payment exists (was resolved+success with no money moved); KOT dead-letter sets kotSyncFailed + branch FCM (kitchen still sees order via Firestore); RIDER_CANCELLED flips canonical status + needsRebook + branch alert (customer push via status trigger); porter quotes flag isEstimate when GPS defaulted.
- Fixed partner: Grill Coins now server-side (POST /customers/adjustCoins, branch-scoped, ledger row) — both pages call the mutation, fake local toasts gone; OrdersPage print opens real KOT preview, Porter row books a real rider; /delivery → /delivery-queue; test print renders a real slip to the print dialog; partial refunds strictly validated (digits, 1..100000, inline error, disabled execute).
- Fixed core: paid-but-no-order panel no longer lies about "no money charged" and hides Retry — shows payment id + support CTA deep-linking a prefilled PAYMENT_ISSUE ticket; invoice tile wired to working GST generator; share builds a real track URL with clipboard fallback; search empty state gains Clear action; ratings persist on-device with honest copy.
- Dismissed: per-card motion springs (visual), chat load-older pagination (follow-up), aggregate-count billing (follow-up).
- Gates: functions 136 · partner 138 · core 207+18 skipped · all builds green. Committed locally; pushes still blocked on 403.
- [ ] Loop 9: Test quality (mock-assertions, skipped tests, untested critical paths) [RUNNING → done below]

### Loop 9 — test quality (done)
- Fixed functions: webhook replay test drives the REAL handler (replay→already_processed, stale-claim takeover, orphan parking); tickets.service.test rewritten to real resolveTicket (refund executes, refusals throw, no silent resolve); forged-signature test with mock mode off; escalator test imports the real tier clocks (also fixed: numeric/ISO clocks now escalate) + real topic router; FCM test pins real on-device channels (killed divergent kot_alarm fiction); coins moved into a tx + truly-concurrent bonus test.
- Fixed partner: auth-rbac/login tests import the REAL routePolicy/branchScope (deleted local clones + test-to-test import); new fail-closed suite pins resolveUserProfile deny (customer/typo/missing); thermal test uses the real formatter; PIN test imports real helpers; refund guard extracted to tested util; API gateway test proves endpoint/body/error mapping.
- Fixed core: bootstrap trust gate tested via injected probe (found+fixed: dynamic firebase imports bypass mock interception — static import now); resend-open + ownership helper + trackUrl util tested; payments fictions rewritten to real pricer/HMAC/cancelOrder; FailurePanel logic extracted + branched tests; rules suite wired to CI (fail-hard on skip) + local emulator run: 18/18 PASS.
- Dismissed: component-render tests (no DOM harness in repo — pure helpers extracted instead); aggregate-count billing (prior follow-up).
- Gates: functions 143 · partner 145 · core 218+18 skipped (rules 18/18 green under emulator) · all builds green. Committed locally; pushes still blocked on 403.
- [ ] Loop 10: Docs/config drift (env examples vs code, runbook accuracy, stale .md) [RUNNING → done below]
- [ ] Loop 11: Firestore indexes vs queries (missing composites, unused indexes) [RUNNING → done below]

### Loop 11 — indexes vs queries (done)
- Fixed: admin portal live/history (collectionGroup orders) had ZERO matching composites — added 4 COLLECTION_GROUP indexes (store.id/orderStatus/placedAt × asc/desc).
- Removed dead weight: support_tickets(status,branchReminderSent,createdAt) + orders(petpoojaStatus,petpoojaRetryCount) composites (no producers anywhere); deleted orphan core firestore.indexes.json (unreferenced, divergent).
- Kept (verified producers): tickets ×2, products(branchId,categoryId), orders branchId+createdAt ×2, support_tickets ×3, routeTransfer, coin, notifications, customerId, dev_error.
- Dismissed: userId-vs-customerId and restId-vs-branchId standardizations (no failing query today; renames are migrations, not fixes).
- Gates: rules 18/18 green. Committed locally; pushes still blocked on 403.
- [ ] Loop 12: Logging/observability hygiene (PII leaks, noise, snapshot gaps) [RUNNING → done below]

### Loop 12 — logging/observability (done)
- Fixed functions: PII boundary at captureErrorSnapshot (customer/payment ids masked, forbidden context keys dropped, pay_ ids scrubbed from messages, alerts use masked copy); idempotency-lookup failures + branch/coupon pricing fallbacks snapshot LOUD with pricingDegraded flag; KOT/customer/urgent dispatch failures snapshotted; raw UIDs removed from cleanup/prune/claims logs.
- Fixed partner: QueueMonitor/SystemQueueTab alert()→toast+status (incl. non-OK HTTP); FCM token material out of logs; porter quote errors redacted; useOrder + admin live-stream failures staff-visible; KDS resume documents autoplay policy.
- Fixed core: Firebase errors log codes not phones; profile/device-link floats caught via logger; getOrder denials logged; watchPosition sampled 1/min + UI state; payment/root/tracking floats caught.
- Dismissed: wholesale logger migration of older console.* (low-noise paths; new code uses logger).
- Gates: functions 143 · partner 145 · core 218+18 skipped · all builds green. Committed locally; pushes still blocked on 403.
- [ ] Loop 13: Accessibility (labels, roles, touch targets) [PENDING SET 2]
- [ ] Loop 14: Offline/empty/error resilience [PENDING SET 2]
- [ ] Loop 15: Type safety in money/auth paths [PENDING SET 2]
- [ ] Loop 16: Secrets/transport safety (keys, http, webviews) [PENDING SET 2]
- [ ] Loop 17: Notification copy/topics consistency [PENDING SET 2]
- [ ] Loop 18: Dead code elimination (verified-unreferenced only) [PENDING SET 2]
- [ ] Loop 19: Capacitor/native parity [PENDING SET 2]
- [ ] Loop 20: Final verification + release summary [PENDING SET 2]

### Loop 10 — docs/config drift (done)
- Fixed rules fork (CRITICAL): 3 divergent copies → root canonical + byte-identical mirrors; consolidation EXPOSED a real regression (root messages rule let any staffer read any branch's chats) — fixed to participant/brand gating, proven 18/18 under emulator.
- Fixed runbook: dotenv (not functions:config) mechanism, OTP_HMAC_SECRET row, jq field assertion; assertProductionKeys now refuses mock Porter/Petpooja in prod too.
- Fixed functions README: real route table (23 routes), dotenv flow, burgonomics-7faa8.
- Fixed partner: fake pg_dump/S3 backup relabeled demo (seeds zeroed), maintenance PIN has no default (refuses unset), .env.example split client/server + documents FUNCTIONS_API_URL, README routes/endpoints/commands corrected.
- Fixed core: .env.example regenerated from env.ts (split Firebase vars, VITE_PUSH_* canonical, all readers covered); cart fallback aligned to engine schedule (499/₹40, discount-aware GST); pricing authority documented; mock-transport headers rewritten; addresses subcollection corrected.
- Dismissed: per-item vs flat packing + server whole-₹ rounding (server authoritative at charge; previews converge — product call to unify further).
- Gates: functions 143 · partner 145 · core 218+18 rules green · all builds green. Committed locally; pushes still blocked on 403.

## Log

### Loop 1 — swallowed errors & silent failures (done)
- functions lane (5): F1 dead client class with fake-success fallback → DELETED class, kept API types. F2 catalog-fallback silence → error snapshot added, fallback kept deliberately (availability). F3 /porter/quote unvalidated → porterQuoteSchema + wired. F4 webhook unknown-order silence → loud warns. F5 scheduler batch abort → per-order catch + failedCount.
- partner lane (5): P1 simulate catch → downgraded (explicit dev action) + simulate BUTTON dev-gated. P2 seed CRM → dev-gated. P3 → stale, already gated. P4 → onError toasts on all 4 order mutations. P5 → catch added.
- core lane (5): C1 ok(null) logging → kept (fire-and-forget background sync, already logged). C2 paid-but-no-order celebration → gated on created.success with support copy. C3 → toast added. C4 → catch ends skeleton. C5 → import errors forwarded to onError.
- Gates: functions 121 · partner 130 · core targeted 15 — all green.
