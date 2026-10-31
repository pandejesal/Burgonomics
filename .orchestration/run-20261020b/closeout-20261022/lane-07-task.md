# Queue task: token-unregister-closeout

Existing owner: `ses_ea5c88140ffeqstoAT9sWrRWFE`. Continue your existing packet,
do not redo the accepted rules work. Read `AUTONOMOUS_WINDOW.md` in this directory.
Window ends 2026-10-22T03:05:59Z; no new work after that time.

## Sole-writer grant

1. `functions/src/modules/notifications/unregisterToken.ts` (existing dirty source)
2. `functions/tests/notifications.token-ownership.test.ts` (existing new regression suite)
3. `functions/tests/unregisterToken.test.ts` (original committed tests now fail)
4. Your evidence `.orchestration/run-20261020b/closeout-20261022/lane-07.md`

No rules, registerToken, auth, shared config, dispatch, Porter or app changes.
Main owns the concurrent frozen Porter bundle. Do not adopt any other dirty tests.

## Reproduce and close, not a new audit

The current full working-tree gate reports two failures in the original
`unregisterToken.test.ts`: its fake lacks `db.runTransaction`; it also returns
`forEach` rather than `docs/size`, and its arrayRemove fake does not remove tokens.
Preserve the security ownership gate rather than deleting it to satisfy old tests.
Adapt the original fixture faithfully; assert exact remaining tokens and unrelated
holders unchanged. Explain which failures are fixture gaps vs any real source defect.

Use a transaction fake with buffered writes/versioned retry if claiming race safety.
Prove own-token detach, foreign/missing owner no-delete, unknown idempotence,
ownerless fail-closed, identical non-owner response, and concurrency ownership flip.
Inspect whether the post-delete holders scrub can erase a newly registered owner's
list during a rebind; do not claim transaction protection of writes outside that
transaction. Any genuine bug needs a narrow reproduction and correction in your scope.

Freeze only your three paths at current committed root HEAD, with immutable candidate
files, Git blobs and SHA256 manifest. Review exact bytes in a read-only actual
DeepSeek child then a separate actual GLM child, one at a time. Verify each assistant
message model; no author/self verdict as substitute. On 429 STOP and report timestamp,
no model/IP retry workaround. Never create a new watcher.

Focused tests are allowed now. Do not run a full root/functions gate while Main has
that slot: post a gate request with base/paths/hashes. Main authorizes one isolated
full gate on final reviewed bytes (`npm run typecheck`, `npm test`, `npm run build`).
No source commit before final approvals and gate; do not stage foreign work.
If you reach the gate wait, give READY_FOR_GATE with hashes and review IDs rather
than spending a new continuation on another audit. Main can gate/commit your frozen
packet if the model/provider becomes unavailable.

## Completion contract

Begin every final report with `QUEUE_TASK: token-unregister-closeout`.
State RED/GREEN results, immutable snapshot/manifest, DS and GLM reviewer IDs,
actual serving models, exact gate and local commit if completed, remaining limits.
Write no secrets or live token/user identifiers. No live Firebase/provider writes,
pushes/deploys or rule weakening. Only LOCAL CODE VERIFIED can be earned.

Only when the reviewed/gated/committed packet is actually finished, end with the
unquoted exact final line `SUPERVISOR_STATE: COMPLETE`. Otherwise report the actual
pending step. Do not use COMPLETE for a frozen candidate or a mere accepted prompt.
