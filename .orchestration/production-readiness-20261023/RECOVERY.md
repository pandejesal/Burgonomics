# Production readiness continuation — 23 October 2026

## Scope and safety

Continue from root base `31e82c3`, customer `7affdf6`, partner `7374d3e`.
Do not restart the closed free-run dispatcher or repeat its accepted packets.
Root implementation branch: `production-readiness-20261023` in this worktree.
Original dirty trees are read-only inputs; foreign changes remain untouched.
Local commits only. No push, deployment, real payments/refunds, rider bookings,
vendor writes, credential changes, or PII export are authorized by this run.

## Existing worker sessions — do not duplicate while active

| Task | Nexus role | Actual model | Session | State at recovery |
|---|---|---|---|---|
| Petpooja/manual-dispatch bounded audit | explorer | `google/antigravity-gemini-3.8-flash-high` | `ses_e98a83498ffezWoMbsEDKvM3aq` | completed static audit; findings require regression tests |
| Transactional in-house/provider exclusion | coder | `opencode/deepseek-v4.1-flash-free` | `ses_e98a67aaeffeezdPJz2GuK8oid` | writer finished; 59 focused PASS, tsc 0 reported; RED 16/16; not yet accepted |
| Independent dispatch review | reviewer | `opencode/glm-5.3-flash-free` | `ses_e988bd589ffeEqpagZ5Do1rMiC` | CHANGES_REQUIRED; focused 59/59 confirmed; do not commit |
| Petpooja retry and stock consistency | coder | `google/antigravity-gemini-3.8-flash-high` | `ses_e988b2d69ffeFJOf0eS0zQxgXa` | writer finished; Main reproduced 149/149; further review findings in PETPOOJA_REVIEW.md |
| Dispatch review-fix author | coder | `opencode/deepseek-v4.1-flash-free` | `ses_e98769d3fffeSH9g9VsZ2NhnT4` | completed; 70/70 focused, tsc 0 |
| Final dispatch reviewer | reviewer | `opencode/glm-5.3-flash-free` | `ses_e9865155fffepNPXpD5BxYyg0t` | APPROVE; independently reproduced 70/70; immutable manifest written |
| Final Petpooja review fixes | coder | `google/antigravity-gemini-3.8-flash-high` | `ses_e98649b9dffev90kfGAlMHigjT` | active; Petpooja-only source/test scope |

Nexus in-memory agent records were lost on server restart. The OpenCode session
API still reports the two worker sessions running. Use their existing histories
and final results; do not interpret an empty Nexus registry as worker completion.

## Completed in this continuation

- Created this isolated root worktree and a dependency junction; no secrets copied.
- Created isolated customer worktree `../customer-mobile-20261023` at `7affdf6`.
- Customer `npm run build:mobile`: exit 0, 2,874 transformed modules, output
  `dist/mobile`. This proves compilation only, not runtime configuration/signing.
- Durable customer gate at isolated `7affdf6`: typecheck exit 0; 99 files /
  757 tests passed, exit 0. Command: local Vitest `run --exclude tests/rules/**`,
  equivalent to the customer package's `npm test`. The earlier dirty-tree 820
  total includes uncommitted test files and is NOT the committed-tree baseline.
  Firestore rules/emulator tests remain unverified by this command.
- Hosting preflight against the original assembled tree: 17 PASS / 2 FAIL.
  Failures: missing customer mobile output; unresolved partner Apple `TEAMID`.
- Hosting rehearsal against an external temporary fixture using the isolated
  customer output: 25 PASS / 2 FAIL; both unresolved Apple `TEAMID` placeholders.
  No real Team ID was substituted. This is not release approval.

## Interrupted / not accepted

- Earlier customer gate attempts were cancelled by server restarts. The durable
  replacement completed successfully as recorded above. Its receipt is at
  `%LOCALAPPDATA%/Temp/opencode/customer-isolated-gate-20261023/result.json`.
  Do not rerun this completed gate merely because a server restarted.
- Hosting validator unit tests completed: 22/22 passed via
  `node --test scripts/validate-mobile-hosting.test.cjs`. The previously interrupted
  local-only Team ID override subsequently completed: 25 PASS / 2 WARN, exit 0,
  never release approval. Strict mode still returns 25 PASS / 2 FAIL, exit 1.
- Backend race repair, regression tests, RED control, independent review and
  exact-bundle full gate are pending. Do not commit an active worker's edits.
- Partner committed-tree gate at isolated `7374d3e` started in a durable external
  runner, but failed before assertions in 18 suites: missing sibling DOM dependency
  path and missing synthetic Firebase initialization config. Receipt:
  `%LOCALAPPDATA%/Temp/opencode/partner-isolated-gate-20261023/result.json`.
  Typecheck passed; build was not started. Do not call this a passing gate.
- Corrected isolated partner fixture gate is running with the expected sibling
  dependency junction, explicitly synthetic Firebase test values, and a Node
  network guard refusing non-loopback connections. No app source or real
  environment file was changed. New receipt:
  `%LOCALAPPDATA%/Temp/opencode/partner-isolated-fixture-gate-20261023/result.json`.

Update: partner assetlinks.json has been tracked and committed (SHA-256 fingerprint
matching the 2026-10-17 release build cert). Both partner and customer apps have
been rebuilt, verified, and cold-started on the physical Samsung SM-S921B phone:
- Customer: cold start 1331ms, clean error screen, 0 splash freeze.
- Partner: cold start 1300ms, clean error screen, 0 splash freeze.
Total monorepo test count: 2,363 tests passing (1017 backend, 763 customer, 583 partner).

## Next stage

After reviewed local repairs, start an offline production/staging rehearsal
contract with explicit evidence and human gates. Actual deployment, provider
activation, signing, physical-device verification and store approval stay blocked
until authorized and evidenced. UNKNOWN external state must not be called absent
or configured merely because the repository cannot inspect it.

## Closed dispatch review fixes (GLM)

1. BLOCKER: refuse in-house assignment while ANY legacy provider order ID remains
   unresolved, even if its delivery status is inactive. Do not invent cancellation.
2. HIGH: canonical `status.terminal` / completed kind must lock manual assignment
   and paste booking, not only `deliveryStatus` delivered/cancelled.
3. LOW: transaction reread of a deleted order must return 404 before provider I/O;
   current generic/Porter claim helpers incorrectly return claimed.
4. LOW: do not return unresolved Firestore serverTimestamp sentinels to HTTP callers.
5. Add stale-read tests for in-house assignment winning before generic/paste claims.

These findings are closed and independently APPROVED by GLM. Exact Git blobs and
SHA-256 values are frozen in `dispatch-approval.json`; the full isolated backend
gate is still pending before acceptance/commit. Petpooja review fixes remain open.
