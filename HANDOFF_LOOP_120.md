# HANDOFF_LOOP_120 — started 2026-09-11
## Progress (check each completed loop)
- [x] 1 (2026-09-11 — workers-down, home-mock queued, tsc green)
- [ ] 2-120
## Carryover (queued product calls, newest last)
- (none yet — seeded from HANDOFF_100 if still open; checked Loop 1)
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
