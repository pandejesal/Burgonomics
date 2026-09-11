# HANDOFF_LOOP_120 — started 2026-09-11
## Progress (check each completed loop)
- [ ] Loops 1-120 (N/120 — append one line per completed loop below)
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
