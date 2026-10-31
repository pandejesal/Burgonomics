QUEUE_TASK: dispatch-teardown-binding

**Defect reproduced first.** Against pristine `636b90d`, the new suite was 6 failed / 1 passed: after `releaseClaimFailed`, `dispatchCancel` (and, found in review, `dispatchBook`'s manual-paste lane) the order still presented the dead booking as owner, so a late `DELIVERED`/`RIDER_CANCELLED` flipped it or re-armed `carrier_cancelled` over `staff_cancelled`. Log: `evidence/lane-04-teardown-red-final.txt`.

**Representation chosen:** teardown atomically retires the ACTIVE binding into bounded `dispatchReleasedBindings` (newest 5, plain values; `releasedAt` ms) and nulls `dispatchProvider`/`dispatchOrderId` + provider aliases. History is kept because staff cancel is a LOCAL release, not proof of remote cancellation, and Porter reconciliation needs the id. The webhook parks such callbacks HIGH as `order_binding_released` with zero order mutation and no FCM (a human reconciles a possibly fulfilled booking). `excludedProvidersFor()` reads history; same-binding re-releases dedupe; a fresh book/paste writes a live binding without resurrecting history.

**Reviews (frozen bytes, serving-proven via local session API):**
- GLM `ses_e9959e39bffe` — 31/31 rows actual `glm-5.3-flash-free` — APPROVE_WITH_CHANGES. Applied: manual-lane teardown (MED), loud release-write log, dedupe, released label at mismatch parks. MED-2 (Porter `cancelPorterBooking`/porter webhook, outside packet paths) disclosed.
- Fresh GLM `ses_e994ca103ffe` — 20/20 actual `glm-5.3-flash-free` — APPROVE, all four closed, independent re-run.

**Gate** (detached worktree at `636b90d` + ONLY the 3 reviewed paths, in-worktree blobs verified): `npm run typecheck` 0; `npm test -- --maxWorkers=2` → 79 files passed/1 skipped, **959 passed/2 skipped (961)**, exit 0; `npm run build` 0.

**Commit:** root `20c4600` on `636b90d`, exactly 3 paths (+622/−10), never pushed:
- `dispatch.router.ts` blob `5e0d576a` sha `743CEC87…`
- `dispatch.webhooks.ts` blob `8137c214` sha `2B49DC01…`
- `tests/dispatch.teardown-binding.test.ts` blob `4931e491` sha `3CA29ACB…`

All committed blobs equal the frozen manifest; 104 foreign dirty entries untouched, index clean.

**Remaining limits:** Porter lane lacks the fence (out of scope, Porter retired/opt-in); concurrent-teardown history lost-update (fields still nulled); legacy superseded binding not ledgered on a successful book; no live Firestore/provider verification. Evidence: `closeout-20261022/lane-04-teardown.md`.

SUPERVISOR_STATE: COMPLETE