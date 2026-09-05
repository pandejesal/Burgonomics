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
- [ ] Loop 6: Auth/session/RBAC (claims, guards, login flows, OTP)
- [ ] Loop 7: Performance (N+1 queries, bundle weight, re-renders, pagination)
- [ ] Loop 8: UX dead-ends (dead buttons, empty states, broken routes/links)
- [ ] Loop 9: Test quality (mock-assertions, skipped tests, untested critical paths)
- [ ] Loop 10: Docs/config drift (env examples vs code, runbook accuracy, stale .md)

## Log

### Loop 1 — swallowed errors & silent failures (done)
- functions lane (5): F1 dead client class with fake-success fallback → DELETED class, kept API types. F2 catalog-fallback silence → error snapshot added, fallback kept deliberately (availability). F3 /porter/quote unvalidated → porterQuoteSchema + wired. F4 webhook unknown-order silence → loud warns. F5 scheduler batch abort → per-order catch + failedCount.
- partner lane (5): P1 simulate catch → downgraded (explicit dev action) + simulate BUTTON dev-gated. P2 seed CRM → dev-gated. P3 → stale, already gated. P4 → onError toasts on all 4 order mutations. P5 → catch added.
- core lane (5): C1 ok(null) logging → kept (fire-and-forget background sync, already logged). C2 paid-but-no-order celebration → gated on created.success with support copy. C3 → toast added. C4 → catch ends skeleton. C5 → import errors forwarded to onError.
- Gates: functions 121 · partner 130 · core targeted 15 — all green.
