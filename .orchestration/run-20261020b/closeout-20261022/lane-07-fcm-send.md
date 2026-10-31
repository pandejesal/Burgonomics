# Lane 07 — FCM recipient ownership (fcm-recipient-ownership)

Truth label: **LOCAL CODE VERIFIED**. No live FCM send, no Firestore/provider
access, no credentials or token values. Base `d3f3728`, local commit `636b90d`.

## Risk

`users/{uid}.fcmTokens` is a fan-out index, not delivery authority: after a
completed token rebind it can still list a token now owned by another UID.
Committed `sendMulticastFcm` passed the profile list straight to the transport,
so `pushToCustomer(A)` could deliver A's private notification to B's device.

## Final frozen bytes (4 paths)

Dir `%TEMP%\opencode\lane07-fcm-freeze\` (+ `manifest.json`).

| Path | SHA-256 | Blob |
|---|---|---|
| `functions/src/modules/notifications/fcmClient.ts` | `FC4BC40EDF0EEA31DC5454BA6739F0E8126E794894FB212762EAC57AEE25D057` | `dea38afc5f5b3770f3e15ebaf15d01d0f50c928c` |
| `functions/tests/fcm.recipient-ownership.test.ts` (new) | `3B872F16C406D06696679525EEFCDF42286C059A6B6E624CA8C2D2901E192320` | `e947b2b90580a18cee7941a6c7f1571c026a3588` |
| `functions/tests/tickets.notify.test.ts` (scope extension) | `86AA5EF034545B1DF09D8795592F32E6907CD87D78446B94E80B1BE8AAB6296A` | `473ddaf5e01089ad2d30d1dc1581fe9fe4a89e76` |
| `references/push_notifications.md` | `864301A6424801EB09C456C28E0DC724EEA7A93385E6AAD24BC23894A2124AF4` | `0525a5e053d98270d3c54c3040dde939cc04a10f` |

## Implementation

Per-chunk `device_tokens/{token}.userId` verification (one bounded `db.getAll`
inside the existing 10 s `withTimeout`) for recipient-bound sends; missing /
ownerless / foreign / read-failed destinations withheld and counted as failures;
response indexes and pruning aligned to the FILTERED destinations; prune writes
only the recipient's doc; empty-string UID fails closed; omitted UID keeps the
legacy generic multicast contract; critical zero-delivery throws. Honest limits
in code/doc: ledger read and send are not atomic; rebinds after the read,
client token lifecycle, topic auth and device acceptance remain outside.

`tickets.notify.test.ts` extension (requested after the first gate exposed the
composition gap): `getAll` shim modelling the real API, `device_tokens` ledger
seeds in the three positive push fixtures, and two new negative tests
(unledgered token, foreign-owned token) asserting no transport call, unmutated
owner profiles and recipient inbox fallback. No existing assertion changed.

## Evidence

- RED — pristine `d3f3728` source + final tests: `fcm.recipient-ownership`
  **10 failed / 1 passed (11)** (sole pass = preserved omitted-UID contract);
  `tickets.notify` **2 failed / 22 passed (24)** — exactly the two new
  negatives (unledgered and foreign tokens were sent). Logs:
  `evidence/lane-07/fcm-red.log`, `fcm-tickets-red.log`.
- GREEN — frozen bundle: **35 passed (35)** (24 + 11);
  log `evidence/lane-07/fcm-green4.log`.
- Mutation probe: redirecting the prune target to another doc → exactly 1
  failure (prune-target assertion falsifiable).
- Gate (isolated worktree at `d3f3728` + only the four paths):
  `npm run typecheck` 0 · `npm test -- --maxWorkers=2` → 78 files passed /
  1 skipped, **952 passed / 2 skipped (954)**, exit 0 · `npm run build` 0.
  Log `evidence/lane-07/fcm-gate3.log`.

## Reviews

- Earlier on the 3-path snapshot (bytes unchanged in this commit): DeepSeek
  `ses_e9edbd023ffex4UhULBL9H5HSJ` (16/16 deepseek rows)
  APPROVE_WITH_CHANGES → test-only F1 applied; GLM `ses_e9ed7e563ffeAuLfI2Gp7IodwQ`
  (29/29 glm rows) VERIFIED with independent RED/GREEN + mutation re-run.
- Final four-path snapshot: fresh GLM `ses_e99d6b5eeffe4mwWyrNWkuxRef`
  **VERIFIED** — hashes/blobs, diff scope (only shim + seeds + negatives), the
  production path re-derived, and 35/35 re-run in the gate worktree.
- One reviewer spawn failed first with `getaddrinfo ENOTFOUND opencode.ai`
  (transport, not quota); one retry of the same free reviewer succeeded. **Gap
  per free-window policy**: only the new fixture delta lacks a second
  independent-model pass (author is DeepSeek, so the only permitted reviewer
  model is GLM).

## Commit

Root `636b90d` on `d3f3728`, exactly the four reviewed paths, committed blobs
verified against the manifest; real index reset to HEAD; 103 unrelated dirty
paths preserved and unstaged. No push/deploy/provider/credential action.

## Limits

LOCAL CODE VERIFIED only. No real device delivery proof; read/send
non-atomicity and post-read rebinds remain by design. Single-token
`sendFcmMessage` admin sends are out of scope (no private customer caller).
