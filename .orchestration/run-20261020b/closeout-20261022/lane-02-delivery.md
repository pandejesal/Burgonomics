# lane-02 — restaurant-dispatch-choice (delivery dispatch choice)

Task `restaurant-dispatch-choice` (brief: `lane-02-delivery-task.md`), run
`20261020b` closeout. Partner repository. Base `6f81fbafa4ba907d8c6cd770a6f332ebd6222af2`.

Porter is cancelled. Restaurants choose a Borzo/Shadowfax courier or their own
in-house rider; in-house is a first choice (not customer pickup, not dependent
on a third-party quote, no Porter credentials).

## Result

Partner local commit **`6da19bc`** — exactly six paths, nothing else staged or
committed, never pushed:

| path | sha256 | git blob (HEAD:path) |
|---|---|---|
| `src/features/delivery/components/PorterDispatchCard.tsx` | `4bc85d16319bcd5a38bfdfbe8633367b1551d18bd2e2752b7567c9cd95e95bce` | `528629c5bc0270fb5bad276978704f3fec5f6b27` |
| `src/features/delivery/components/RiderAssignmentModal.tsx` | `2562a4cc9f112a29fa566b10e4a01350131de3b4a67211891134c7daec25062c` | `ed294fd9220e553d910749c12cea1feb6d2e2112` |
| `src/features/delivery/hooks/usePorterLogistics.ts` | `4802b4d73c415aef5ddd82ed2fc06d775617bf3ced18386c48cf447795e581e0` | `827c0a9e738c909b7cbc493d3bc8b3aa25f3e6b4` |
| `src/pages/DeliveryQueuePage.tsx` | `575896addd06d2c3b9a810b5023fe057f5c4293604e4e7dfbc877ca9dc661376` | `7496adcbe431c527a9de1340bc701d7bfbc393a3` |
| `src/features/orders/components/OrderTableList.tsx` | `66aa62a9771f23d1c7e6c7f8bf55c0f9b3c7106a856876cc8f3113185011258e` | `0c34c82f56ad1e9443f1904b1e5149b87a18ac8b` |
| `tests/restaurant-dispatch-choice.test.tsx` (new) | `4c0dea83f3717f860050b3e9d9670e2c536bc68e8776f7e3b7cf203f8e8c293e` | `9bd90ccb8ce7e49c0e9b38f78fc7610e2ee4ba27` |

Committed blobs were re-read with `git rev-parse HEAD:<path>` and equal the
reviewed frozen blobs above. Existing dirty `usePorterLogistics.ts` /
`DeliveryQueuePage.tsx` patches (`deriveDeliveryFeedState`, feed-error panel)
were inspected and adopted, not rewritten. `tests/porter-logistics.test.ts`
needed no adaptation. No root Functions, native, menu, mapper, shared-UI or
unrelated test edits.

## Defects reproduced (RED) then fixed (GREEN)

RED: `tests/restaurant-dispatch-choice.test.tsx` over pristine `6f81fba` →
**22 failed / 4 passed** (the 4 passing are regression guards: legacy
`manually_assigned`, in-house CTA without quote, session-scoped reachability,
success-closes-once). Failures mapped to real committed defects, not weakened
production code:

1. `getRiderStatusMeta` keyed in-house only on `deliveryStatus
   'manually_assigned'`; the real server writes `dispatchType
   'manual_branch_terminal'` + `deliveryStatus 'dispatched'`, so a real
   in-house rider was labelled Porter with a Cancel-Porter money action.
2. Porter label inferred from a bare `riderName`; Borzo/Shadowfax allocations
   had no provider label.
3. `needs_review` (customer_cancelled / returned_to_seller, needsRebook=false)
   rendered a stale Porter pill / cooking copy instead of manual review.
4. Orders table exposed a paid direct Porter row action
   (`onDispatchPorter → bookPorterRider`).
5. `RiderAssignmentModal` invoked the async assignment as void and closed
   immediately: failure produced no error, false close, no duplicate guard.
6. `assignInHouseRider` (and, narrowly, `applyDispatchResult` /
   `savePorterManual`) wrote client-side `out_for_delivery` after a saved
   rider — assignment/booking is NOT pickup proof.
7. Queue copy claimed Porter as the dispatcher and "Porter API Status";
   errored feed showed false zero counters.

GREEN after fix: new suite **30/30**; committed `src/pages/DeliveryQueuePage.test.tsx`
byte-identical to HEAD and passing (historical `driver_allocated` carve-out
kept deliberately). Full isolated gate: **574 passed / 1 skipped**.

## Independent review (free models only)

- Author session model: `opencode/deepseek-v4.1-flash-free`.
- DeepSeek review child `ses_e9ed17bc1ffe6rTcoMO07AFE8z` — FAIL (1 MAJOR +
  minors; stale cancelled rider would block the in-house fallback; false
  counters; vacuous assertion; encoding damage; missing paste-lane pin). All
  material findings applied. DeepSeek re-review `ses_e9ebc97f0ffejP2pl2dc1vVofl`
  — PASS (23 assistant rows, all `opencode/deepseek-v4.1-flash-free`).
- Final frozen blobs reviewed by a DIFFERENT model: GLM verifier
  `ses_e99c6c49effeoOMi1axE5JZJeV` — **VERIFIED** (16 assistant rows, all
  `opencode/glm-5.3-flash-free#default`; hashes re-checked by the reviewer,
  `DeliveryQueuePage.test.tsx` byte-identical, tsc clean, 30/30 + 13/13).
  Serving models read from the local session API (`opencode session export`),
  not from pins.
- Three follow-up fixes landed after the DeepSeek re-review (BOM/encoding,
  unhandled-rejection guard on the paste lane, live-booking refusal test), so
  the GLM verification of the final bytes is the authoritative review.

## Isolated exact-bundle gate

Detached worktree at `6f81fba` + ONLY the six paths above (node_modules
junction, sibling customer DOM junction, `.env` copied, never tracked):

- `npm run typecheck` → **exit 0**
- `npm test -- --maxWorkers=2` → **exit 0**, 85 files, 574 passed, 1 skipped
- `npm run build` → **exit 0** (built in ~11 s)

Logs: `%TEMP%\opencode\partner-gate-dispatch*.log`. Worktree removed without
force after junctions were removed and the copy restored.

## Honest limits

- Backend atomic assignment hardening (a UI snapshot check cannot stop a
  concurrent server booking over a live claim) is a separate Main-owned
  packet; the limitation is documented in the hook.
- `OrdersPage.tsx` retains an unreachable dead `handleDispatchPorter` because
  it is outside the packet's sole-writer scope; the table can no longer call
  it.
- `category`-style deep-link context for the queue link, Escape/focus-trap for
  the modal, input height below the 44px aim, and `cancelPorter` reverting
  order status to `ready` after a server-confirmed cancel were reviewed as
  notes, not defects of this packet.
- No live provider call, booking, deploy, push or production write was made.
