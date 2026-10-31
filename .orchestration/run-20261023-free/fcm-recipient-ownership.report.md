QUEUE_TASK: fcm-recipient-ownership

**Final scope (4 paths, frozen + reviewed + gated + committed)**
| Path | Blob | SHA-256 |
|---|---|---|
| `functions/src/modules/notifications/fcmClient.ts` | `dea38afc` | `FC4BC40E…25D057` |
| `functions/tests/fcm.recipient-ownership.test.ts` (new) | `e947b2b9` | `3B872F16…192320` |
| `functions/tests/tickets.notify.test.ts` (explicit extension) | `473ddaf5` | `86AA5EF0…B6296A` |
| `references/push_notifications.md` | `0525a5e0` | `864301A6…2124AF4` |

The source withholds every recipient-bound destination that cannot be proven via `device_tokens/{token}.userId` (one bounded batch read per ≤500 chunk), keeps response-index/prune alignment on the filtered list, prunes only the recipient's doc, fails closed on empty UID, preserves the legacy omitted-UID multicast, and throws on critical zero-delivery. The fixture extension models `getAll`, seeds the real ledger in the three positive push fixtures, and adds two negatives (unledgered, foreign-owned) with no existing assertion weakened.

**RED/GREEN** — pristine `d3f3728` + final tests: `fcm.recipient-ownership` 10 failed/1 passed (11) — sole pass is the intentionally preserved generic contract; `tickets.notify` 2 failed/22 passed (24) — exactly the new negatives (previously the three old fixtures also failed composition; fixed by ledger seeds). Frozen bundle GREEN: 35/35. Mutation probe (prune redirected to another doc): exactly 1 failure.

**Reviews** — earlier, on the identical 3-path bytes: DeepSeek `ses_e9edbd023ffe4UhULBL9H5HSJ` (16/16 deepseek rows) APPROVE_WITH_CHANGES → test-only F1 applied; separate GLM `ses_e9ed7e563ffeAuLfI2Gp7IodwQ` (29/29 glm rows) VERIFIED. Final 4-path snapshot: fresh GLM `ses_e99d6b5eeffe4mwWyrNWkuxRef` (read-only, re-ran 35/35) **VERIFIED**. One reviewer spawn failed with transient `ENOTFOUND opencode.ai`; one retry of the same free model succeeded. Gap recorded: the new fixture delta has one independent pass, not two — free-window permits only the non-author model.

**Gate** — isolated worktree at `d3f3728` + only the four paths: `npm run typecheck` exit 0; `npm test -- --maxWorkers=2` → 78 files passed/1 skipped, **952 passed/2 skipped (954)**, exit 0; `npm run build` exit 0.

**Commit** — root **`636b90d`** on `d3f3728`, exactly these four paths; committed blobs verified against the frozen manifest; index reset to HEAD; 103 foreign dirty entries preserved and unstaged. Never pushed.

**Limits** — LOCAL CODE VERIFIED only. No live FCM/device delivery proof; ledger read and send are not atomic (post-read rebinds, client token lifecycle, topic auth and device acceptance remain separate). Single-token `sendFcmMessage` admin sends are out of scope.

SUPERVISOR_STATE: COMPLETE