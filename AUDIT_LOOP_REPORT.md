# Audit Loop Report — started 2026-09-10
## Progress
- [x] 1 swallowed-errors
- [x] 2 rules-queries-indexes
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
- Loop 2 → Loop 5: core updateNotificationPreferences + partner link/unlink user-token direct device_tokens writes still denied — needs server prefs/link endpoint (product call).
## Records
### Loop 2 — rules-queries-indexes — 2026-09-10 13:20 UTC — result: fixed 5
- Fixed: core scripts/test-rules.mjs — added --hookTimeout=120000 (cold JVM init exceeds vitest 10s default; suite previously failed with 18 skipped). NOTE: first suspected a JBR path bug — byte-level od check proved the path was correct (JS double-backslash = single literal). No JBR change made. Core commit fe31ee9.
- Fixed: core notificationsService.ts registerDeviceToken — client setDoc to device_tokens denied by rules (server-owned), push never registered. Now POSTs server /notifications/registerToken with ID-token Bearer. Core commit 825a6e0. tsc clean, 221/221 green.
- Fixed: partner pushNotifications.ts — same denied device_tokens write → now via new partnerFunctionsApi.registerDeviceToken. Partner commit 7e761bc.
- Fixed: partner adminAuthService.ts login — setDoc admins/{uid}/sessions denied by rules (create:false) propagated as login failure. Now best-effort try/catch, login continues (server mint queued batch 4Z/5). Same commit.
- Fixed: partner useTickets.ts buildConstraints — status filter unshifted before orderBy(createdAt); pushed after so composite index (status,branchId,createdAt) applies. Same commit.
- Gates: rules suite 18/18 green under emulator (Java 21 JBR). functions untouched this loop. partner typecheck clean, 151/151 green. core 221/221 green.
- Dismissed: functions missing rule paths (payment_intents, porter_order_map, porter_webhook_events, carts, coin_transactions, app_config) — Admin SDK bypasses rules; harmless unless clients adopt them (flagged for loop 8 census). functions index shapes all covered incl branches(active,__name__). core petpooja log reads denied for non-admin — PetpoojaTab is demo/superadmin surface (loop 6/11 to confirm audience). core orders userId-only query — coverage gap not denial (client sorts in memory). partner adminOrdersService collectionGroup(orders) + admin dashboard queries — denied reads for non-brand roles are RBAC-correct per rules (money ledgers brand-only); dashboard return-[] swallows already dismissed in loop 1. core offline (no persistence) — architecture call, not fix-bar.
- Queued: porter duplicate-dispatch + partner cached-claims items already carried (loop 1). Partner push prefs updateNotificationPreferences still direct-writes device_tokens (denied) — same family, needs server prefs endpoint (product call) → carry to Loop 5.
- Pushes: root report commit pushed. Core + partner commits left LOCAL — both branches diverged with other lanes' active work (core main behind 7, partner branch behind 6 + dirty UI-sweep tree); merge refused to avoid tangling. Next loop to push after sync.
### Loop 1 — swallowed-errors — 2026-09-10 12:30 UTC — result: fixed 2
- Fixed: functions/src/modules/payments/webhookHandler.ts:98-125 — idempotency lease-read failure returned true → 200 already_processed (silent money drop). Now snapshots high-severity + throws → 500 so Razorpay retries. Root commit 7f28af8.
- Fixed: burgonomics-partner/src/features/orders/components/OrderCancelRefundModal.tsx:32,60-70,171-178 — cancel/refund failure was console-only, modal gave zero feedback on money path. Now sets submitError + role=alert banner. Partner commit 9d903e6 (branch feat/partner-device-smoke).
- Dismissed: tickets.service.ts:451, webhookHandler.ts:212/273, core ordersService 252-280 notifies — post-success push best-effort, documented non-blocking, no money/data loss (loop 5 owns notify UX). routeTransfers.ts:180 null-account → visible failed write owned by retry worker. pricing.engine.ts:139 partial catalog fallback bounded by client-price validation (101-109), total outage throws 503 (165-169). adminPaymentsService resolveDiscrepancy/processManualRefund boolean swallows unreachable — zero callers in src (loop 8 census). middleware.ts:153 resolveOrderBranchId deny is fail-closed correct direction (loop 7 owns auth). dashboardService return-[] scans are read-only admin views, no state change.
- Queued: porter.service.ts:556 dedup-read + :571 markProcessed best-effort → duplicate-dispatch risk; needs product call on fail-closed vs best-effort → carried to Loop 4 (webhooks fuzz). partner authStore.ts:207/223 cached-claims fallthrough + adminAuthService.ts:136 resolve(null) → carried to Loop 7 (auth session).
- Gates: functions npm test 23 files/230 passed, tsc --noEmit clean, build clean. partner typecheck clean, npm test 30 files/151 passed. Root master in sync with origin/master before change (fetch verified, no divergence).
