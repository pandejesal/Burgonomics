# HANDOFF_LOOP_120 — started 2026-09-11
## Progress (check each completed loop)
- [x] 1 (2026-09-11 — workers-down, home-mock queued, tsc green)
- [x] 2 (2026-09-11 — rules dead-block fix, 22/22 gates)
- [x] 3 (2026-09-11 — partner store honesty, 154 green)
- [x] 4 (2026-09-11 — FCM topic authz, 240 green)
- [ ] 5-120
## Carryover (queued product calls, newest last)
- Loop 5: server endpoint for refund-request DISPOSITION (reject path has no
  API; page fails loud until it lands). Also core home-mock backend (Loop 1).
## Baseline divergence (noted Loop 1 Step 0)
- root `master`: in sync with origin/master
- core `main`: ahead 29, behind 7 vs origin/main — DIVERGED, LOCAL commits only, never force-push
- partner `feat/partner-device-smoke`: ahead 36, behind 6 vs origin — DIVERGED, LOCAL commits only
## Records (newest last)
### Loop 1 — 2026-09-11 06:15 UTC — fixed 0 / workers-down, direct exploration only
- Workers: E1+E2 opencode sessions failed 5x with opencode-zen `UnknownError`
  server errors (same pinned model, serialized + 170s backoff; tries 5/20).
  Phase 2/3 skipped — no exploration output to plan from. Will keep retrying.
- Direct exploration (read-only): functions routes hardened (fail-closed env,
  webhook secret verify, caller passthrough on tickets); no unbounded
  `.collection().get()` in functions/src; core input-placeholder hits benign.
- Queued (product call): core home screen serves MOCK data unconditionally —
  `homeService.ts` (MOCK_BANNERS/OFFERS/etc.) <- `HomeRepository.ts` <-
  `homeStore.ts:62`. No live path, no DEV gate. Fix needs backend /v1/home
  endpoint or DEV-gate/honest-label decision. Not in HANDOFF_100 (new).
- Dismissed: `/porter/webhook` route-level no-auth — service verifies
  x-porter-signature with fail-closed secret (porter.service.ts:527); by design.
- Gates: functions `npx tsc --noEmit` GREEN (exit 0). Full suites deferred.
- Commits: handoff only (root master in sync; core/partner diverged, untouched).
### Loop 2 — 2026-09-11 06:25 UTC — fixed 1 (rules dead block) / workers still down
- Workers: E1 retry-5 + trivial smoke prompt both failed, same opencode-zen
  `UnknownError` (auth creds present, github.com reachable). Endpoint-wide
  outage, not prompt-specific. Tries 6/20. Direct implementation fallback.
- Fixed: `petpooja_webhook_logs` rules block sat at top level OUTSIDE
  `match /databases/{database}/documents` (root firestore.rules:256) — dead
  rule, admin reads default-denied. Live callers broken: core
  httpGateway.ts:563,589 (get/subscribeWebhookLogs), partner
  httpGateway.ts:525,552. Re-indented inside documents block in root + both
  mirrors (all 3 byte-identical). Fix bar: silent admin-path failure.
- Tests added (core suite 20->22): 21 brand-owner read ALLOWED, 22 anon read
  DENIED (+ wh_rules_01 seed). Test 21 fails pre-fix (default deny).
- Gates: core rules 22/22 green (emulator) + tsc clean + unit 221/221 (38
  files) + build clean. Functions untouched (tsc+234 green from Loop 1/2).
- Commits: root 189f229 PUSHED (rules fix); handoff pushed. Core d9d6990
  LOCAL + partner 5422d25 LOCAL (both diverged — push after sync, never force).
  NOTE: core/partner commits show whole-file line-ending stat churn vs their
  HEADs; content verified byte-identical to root fix.
### Loop 3 — 2026-09-11 06:40 UTC — fixed 1 (partner store honesty) / workers down
- Workers: smoke probe failed again, same opencode-zen UnknownError. Tries 7/20.
- Fixed (partner, meets bar — mock data reachable in prod): `getStores`
  served INITIAL_RICH_STORES fixtures silently when admin_stores empty/unreadable
  (dashboardService.ts:616), rendered as live in StoreOverview with hash-fabricated
  "Today's Sales" figures, POS LINK / Cache HIT badges, no demo label anywhere.
  Fix: `StoreResponse.isDemoFallback` flag (types/index.ts) set on fallback rows;
  UNBOUNDED `getDocs(collection(admin_stores))` bounded with limit(100);
  StoreOverview "Demo store" badge + "Demo metrics" caption under card figures.
- Dismissed: simulateOrder sample names/items (useOrders.ts:436+) — DEV-gated
  with loud throw, unreachable in prod. Petpooja gateway factory mock default —
  explicit env-flagged pattern (VITE_PETPOOJA_ENABLED), product posture, QUEUE-adjacent.
- Gates: partner typecheck clean + 31 files/154 tests green (30/151 + 3 new
  store-overview-honesty) + build clean.
- Commits: partner LOCAL (diverged, push after sync). NOTE pre-existing
  `M src/types/index.ts` in partner tree left untouched (not mine).
### Loop 4 — 2026-09-11 06:55 UTC — fixed 1 (FCM topic authz) / workers down
- Workers: smoke probe failed again, same opencode-zen UnknownError. Tries 8/20.
- Fixed (functions, meets bar — authz bypass): /notifications/subscribe let ANY
  authed caller (incl. customers) attach ANY branch's orders/tickets topics to
  their own token — filter checked topic shape, never caller role. Branch pushes
  carry order numbers/totals/flow (KOT alerts, templates.ts:105,276). Fix:
  pure filterSubscribableTopics() (topics.ts, barrel-exported) — branch topics
  staff-only, other topics keep existing checks; both subscribe + unsubscribe
  routes use it. Plus unsubscribe gained subscribe's token-ownership 403
  (previously anyone could detach anyone's token from kitchen alerts).
- Gates: functions tsc clean + 24 files/240 tests green (23/234 + 6 new
  fcm.topics) + build clean.
- Commits: root PUSHED (fix + tests). Handoff pushed below.
### Loop 5 — 2026-09-11 07:00 UTC — fixed 1 (refund fake-success) / workers down
- Workers: smoke probe failed again, same opencode-zen UnknownError. Tries 9/20.
- Fixed (partner, meets bar — fake money movement): AdminRefundsPage approve /
  retry mutated LOCAL paymentStorage seeds + toast.success while Razorpay +
  Firestore stayed untouched (live list comes from Firestore listener, so the
  row never even changed). Approve + retry now POST /payments/refund via new
  partnerFunctionsApi.releaseRefund (staff-only, server-idempotent); failures
  toast loud with dialog kept open; isReleasing blocks double-submit. Reject
  has NO server endpoint → honest fail-closed loud toast, nothing recorded.
  QUEUED: disposition endpoint (carryover).
- Gates: partner typecheck clean + 31 files/155 tests green (+1 gateway test)
  + build clean.
- Commits: partner bc77d03 LOCAL (diverged, push after sync).
