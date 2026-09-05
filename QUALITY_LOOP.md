# Quality Loop — 10 × 3 parallel find-and-fix sweeps

> Each loop: 3 parallel finder lanes (functions / partner / core) return top
> findings with file:line + evidence → architect verifies → fixes → gates.
> Status: `pending` | `running` | `done`. Lanes are READ-ONLY; fixes by architect.

- [ ] Loop 1: Swallowed errors & silent failures (unhandled rejections, missing toasts, empty catches)
- [ ] Loop 2: Firestore rules vs actual queries (denied reads/writes, missing indexes, offline behavior)
- [ ] Loop 3: Money paths re-verify (totals, caps, rounding, refunds, loyalty)
- [ ] Loop 4: Notification pipeline end-to-end (topics, channels, tokens, triggers)
- [ ] Loop 5: Menu pipeline (sync, 86-ing both directions, images, categories)
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
