# Audit Loop Report — started 2026-09-10
## Progress
- [x] 1 swallowed-errors
- [ ] 2 rules-queries-indexes
- [ ] 3 money-paths
- [ ] 4 webhooks
- [ ] 5 notifications
- [ ] 6 menu-pipeline
- [ ] 7 auth-rbac-session
- [ ] 8 mock-deadcode-census
- [ ] 9 perf-native-parity
- [ ] 10 logging-pii-secrets
- [ ] 11 a11y-ux-deadends
- [ ] 12 adversarial-final-matrix
## Carryover (queued product calls, newest last)
- Loop 1 → Loop 4: porter.service.ts:556/:571 best-effort dedup/markProcessed — fail-closed vs best-effort call.
- Loop 1 → Loop 7: partner authStore.ts:207/223 cached-claims fallthrough, adminAuthService.ts:136 resolve(null) — session strictness call.
## Records
### Loop 1 — swallowed-errors — 2026-09-10 12:30 UTC — result: fixed 2
- Fixed: functions/src/modules/payments/webhookHandler.ts:98-125 — idempotency lease-read failure returned true → 200 already_processed (silent money drop). Now snapshots high-severity + throws → 500 so Razorpay retries. Root commit 7f28af8.
- Fixed: burgonomics-partner/src/features/orders/components/OrderCancelRefundModal.tsx:32,60-70,171-178 — cancel/refund failure was console-only, modal gave zero feedback on money path. Now sets submitError + role=alert banner. Partner commit 9d903e6 (branch feat/partner-device-smoke).
- Dismissed: tickets.service.ts:451, webhookHandler.ts:212/273, core ordersService 252-280 notifies — post-success push best-effort, documented non-blocking, no money/data loss (loop 5 owns notify UX). routeTransfers.ts:180 null-account → visible failed write owned by retry worker. pricing.engine.ts:139 partial catalog fallback bounded by client-price validation (101-109), total outage throws 503 (165-169). adminPaymentsService resolveDiscrepancy/processManualRefund boolean swallows unreachable — zero callers in src (loop 8 census). middleware.ts:153 resolveOrderBranchId deny is fail-closed correct direction (loop 7 owns auth). dashboardService return-[] scans are read-only admin views, no state change.
- Queued: porter.service.ts:556 dedup-read + :571 markProcessed best-effort → duplicate-dispatch risk; needs product call on fail-closed vs best-effort → carried to Loop 4 (webhooks fuzz). partner authStore.ts:207/223 cached-claims fallthrough + adminAuthService.ts:136 resolve(null) → carried to Loop 7 (auth session).
- Gates: functions npm test 23 files/230 passed, tsc --noEmit clean, build clean. partner typecheck clean, npm test 30 files/151 passed. Root master in sync with origin/master before change (fetch verified, no divergence).
