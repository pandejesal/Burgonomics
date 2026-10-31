QUEUE_TASK: restaurant-dispatch-choice

**Committed (local only, never pushed)**
- Partner `6da19bc` — exactly six paths:
  - `PorterDispatchCard.tsx` blob `528629c5` (sha256 `4bc85d16…`)
  - `RiderAssignmentModal.tsx` blob `ed294fd9` (`2562a4cc…`)
  - `usePorterLogistics.ts` blob `827c0a9e` (`4802b4d7…`)
  - `DeliveryQueuePage.tsx` blob `7496adcb` (`575896ad…`)
  - `OrderTableList.tsx` blob `0c34c828` (`66aa62a9…`)
  - `tests/restaurant-dispatch-choice.test.tsx` blob `9bd90ccb` (`4c0dea83…`)
  Committed blobs re-read via `git rev-parse HEAD:<path>` and equal the reviewed frozen bytes.
- Root `81e20d1` — evidence `closeout-20261022/lane-02-delivery.md` (one file).

**Review (free models only; serving rows via local session API)**
- DeepSeek child `ses_e9ed17bc1ffe6rTcoMO07AFE8z`: FAIL (stale cancelled rider blocked in-house fallback; false zero counters; vacuous assertion; encoding; paste-lane pin). All material findings applied.
- DeepSeek re-review `ses_e9ebc97f0ffejP2pl2dc1vVofl`: PASS (23 assistant rows, all `opencode/deepseek-v4.1-flash-free`).
- GLM final-blob verifier `ses_e99c6c49effeoOMi1axE5JZJeV`: **VERIFIED** (16 assistant rows, all `opencode/glm-5.3-flash-free#default`; re-checked hashes, tsc, suites). Three follow-up fixes landed after the DeepSeek re-review, so GLM on the final bytes is the authoritative review.

**RED/GREEN**
- RED over pristine `6f81fba`: 22 failed / 4 passed (the 4 are regression guards). Failures trace to real defects: server `manual_branch_terminal/dispatched` read as Porter with a cancel-money action; Porter inferred from bare riderName; needs_review rendered as rebook/cooking; paid Porter row action; modal closed on failed async assignment; client `out_for_delivery` fabrications; Porter-branded queue copy/false zero counters.
- GREEN: new suite 30/30; committed `DeliveryQueuePage.test.tsx` unchanged and passing.

**Isolated gate** (detached worktree at `6f81fba` + only the six paths; junctions + in-memory `.env`): `npm run typecheck` exit 0 · `npm test -- --maxWorkers=2` exit 0 (85 files, 574 passed, 1 skipped) · `npm run build` exit 0. Worktree removed without force.

**Remaining limits** — backend atomic assignment hardening is a separate Main-owned packet (documented in-hook); `OrdersPage.tsx` dead handler is out of sole-writer scope and unreachable from the table; Escape/focus-trap, queue deep-link, input height, and `cancelPorter`'s `ready` revert were reviewed notes, not packet defects. No deploy, push, provider call, booking, or production write.

SUPERVISOR_STATE: COMPLETE