# Handoff to original Firebase session: recipient-bound FCM sends

Queue task: `fcm-recipient-ownership`. Owner is original root
`ses_ea5c88140ffeqstoAT9sWrRWFE`; no replacement writer/session.
The user explicitly corrected Main's role to DELEGATION ONLY. Take over Main's
unfinished candidate; Main will not keep implementing alongside you.
Read `AUTONOMOUS_WINDOW.md`. Deadline 2026-10-22T03:05:59Z.

## Exact sole-writer handoff

1. `functions/src/modules/notifications/fcmClient.ts` — Main's uncommitted candidate
2. `functions/tests/fcm.recipient-ownership.test.ts` — Main's new tests
3. `references/push_notifications.md` — source-contract correction
4. Your evidence `closeout-20261022/lane-07-fcm-send.md`.

Main has investigated these exact files and explicitly transfers the existing
changes to you. Inspect/adopt/rework rather than rubber-stamp. Preserve all other
working/index entries. Do NOT reopen the accepted token-detach packet `4b6e4f6` or
the accepted client rules; no extra notification/auth/index/dispatch/app changes.
Current root includes `086b60d` and `4b6e4f6`; inspect actual HEAD before freezing.

## Concrete risk and candidate, with honest current evidence

`users/{A}.fcmTokens` may retain a token now bound to B after re-registration,
best-effort cleanup, the cap, or the safe rebind-skip in the detach packet.
`pushToCustomer(A)` reads A's profile list, and the committed `sendMulticastFcm`
passes it to the transport without checking current `device_tokens/{token}.userId`.
Thus a completed rebind can send A's private notification to B's device.

Main reproduced this against the real PRODUCTION function path with a completely
mocked Firebase/messaging transport: `Temp/opencode/fcm-recipient-red.log` reports
9 failed / 1 passed (10 tests). It is not a real send or a provider test. `NODE_ENV`
is stubbed to production and `VITEST` empty INSIDE the test, specifically to avoid
the existing test-mode shortcut fabricating a success.

Candidate implementation:
- Verify current token owners with one bounded `db.getAll` before each <=500-token
  multicast chunk. Missing/ownerless/foreign/read-failed destinations are withheld.
- Keep SDK response indexes/pruning aligned with the FILTERED destinations.
- Do not mutate a newly rebound user's token/profile. Return honest failure counts;
  no owned destination for a critical message must not report success.
- Explicit empty UID is rejected. Omitted UID retains the existing trusted-server
  generic multicast API, not a claim that private sends without UID are authorized.
- Existing test-mode shortcut is not redesigned here. Production-path tests are
  mandatory, not a false-green NODE_ENV=test test.
- Read + external FCM send cannot be atomic. Do not claim that this eliminates a
  rebind AFTER the read, client token-lifecycle issues, topic authorization or device
  privacy acceptance. These limits are written in the candidate/reference.

Focused GREEN was 10/10 (`fcm-recipient-green.log`) BEFORE Main's last edits. Since
then the test fake captures immutable snapshots, has a typed send response, and
adds an ownership-read timeout case: final file now has 11 tests and WAS NOT rerun.
No review, frozen final manifest, full gate or commit exists for this candidate.
Do not report the earlier 10/10 as verification of the current eleven-test bytes.

## Your required closeout

1. Inspect and test current candidate; fix any genuine defect in scope, including
   fixture errors, time bounds, empty UID and chunk/index correctness. Prove real
   production-path transport calls only use verified targets. Keep all transport/DB
   operations fake in tests; never read live tokens or send a real notification.
2. Freeze final three paths immutably with Git blobs and SHA256. Prove final tests
   RED over pristine committed source and GREEN over the candidate; no artificial
   weakening of production source to manufacture RED.
3. Use a FRESH read-only actual `opencode/deepseek-v4.1-flash-free` child, THEN a
   DIFFERENT fresh read-only actual `opencode/glm-5.3-flash-free` verifier. Reviewers
   spawn no children. Verify every assistant's actual model through the local API;
   pins alone are not proof. Do not scan all SQLite tables or count old detach
   reviewers as review of this NEW packet. Apply findings, refreeze material deltas.
4. Focused tests are allowed now. ROOT/FUNCTIONS full-gate slot is assigned to
   root04's webhook closeout. Wait for its END/release or Main's explicit grant,
   check coordination before starting, then isolate the exact three-path bundle at
   current HEAD and run `npm run typecheck`, `npm test -- --maxWorkers=2`,
   `npm run build`. Capture actual exits/counts/hashes, no dirty-tree gate shortcut.
5. If green, commit only your final reviewed paths LOCALLY, verify every committed
   blob against manifest, and preserve all foreign work. No push/deploy, real DB/
   FCM/provider action, credentials/network changes, auth/rule weakening or broad staging.

Only DeepSeek/GLM Free may serve writer/reviewer turns. On429/transport STOP and
record timestamp/pending step; no model/provider/IP workaround or retry storm.
No new timer/watcher. This is ONE explicit Main handoff, not an idle continuation.
The old delivery counters stay intact; another prompt is not guaranteed. Finish
the packet from this brief or leave exact resumable evidence if blocked.

Start final response `QUEUE_TASK: fcm-recipient-ownership`; state actual commit or
BLOCKED, final hashes, RED/GREEN, real serving proof and gate evidence/limits.
Only when actually reviewed/gated/committed end with the exact unquoted final line
`SUPERVISOR_STATE: COMPLETE`.
