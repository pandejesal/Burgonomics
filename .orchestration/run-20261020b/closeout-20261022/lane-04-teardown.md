# lane 04 — `dispatch-teardown-binding` closeout (run 20261023-free)

Owner: lane04. Author model: `opencode/deepseek-v4.1-flash-free`.
Base: root `636b90d`. **Commit: `20c4600`** (local only, never pushed).

## Defect (reproduced before the fix)

The webhook ownership proof (`d3f3728`) compares a callback's provider/provider-order-id
against the order's CURRENT `dispatchProvider`/`dispatchOrderId`. Three write paths left
those fields pointing at a booking the system had already released:

1. `releaseClaimFailed()` — failed booking/rebook,
2. `dispatchCancel()` — staff cancel (Borzo/Shadowfax: LOCAL release only),
3. `dispatchBook()`'s Porter manual-paste lane (`manual_pending`) — found in review.

A late `DELIVERED`/`RIDER_CANCELLED` from the dead booking then satisfied the proof and
mutated a released order: terminal flip, or `rebookTrigger: "staff_cancelled"` overwritten
with a carrier trigger (auto-rebook of a job staff had released).

## Representation (chosen, and why)

Teardown retires the ACTIVE binding **atomically in the same write**:
`dispatchProvider`/`dispatchOrderId`/`porterOrderId`/`borzoOrderId`/`shadowfaxOrderId` →
null, and the values move to `dispatchReleasedBindings` (bounded newest-5, plain values;
`releasedAt` is local-clock ms because Firestore rejects serverTimestamp sentinels inside
arrays — same precedent as `dispatchClaimedAt`). `excludedProvidersFor()` reads the ledger
too, so "never rebook the provider that cancelled" survives the active-field nulling.
Same-binding re-releases dedupe (provider+providerOrderId) so the bound cannot evict a
distinct provider.

Webhook: a callback naming a released booking parks HIGH as `order_binding_released`
(carries `releasedReason`) with zero order mutation and no FCM — parked, not processed,
because a staff cancel is NOT proof of remote cancellation: a late `DELIVERED` may be a
real fulfilment and a human must reconcile. A fresh book/paste writes a fresh binding and
preserves (never resurrects) released history.

## RED (final v2 test bytes vs committed base)

`functions/tests/dispatch.teardown-binding.test.ts` against pristine `636b90d`:
**6 failed / 1 passed (7), exit 1** — `expected 'borzo' to be null`,
`expected 'delivered' to be 'rider_cancelled'`,
`expected 'carrier_cancelled' to be 'staff_cancelled'`.
Log: `evidence/lane-04-teardown-red-final.txt` (worktree
`%TEMP%\opencode\lane04-teardown-red`, detached at `636b90d`, `functions/src` clean).

## Review (frozen v2 blobs; two fresh read-only legs, serving-proofed)

Frozen manifest: `.orchestration/run-20261023-free/frozen/lane-04-teardown/MANIFEST.json`
(immutable copies alongside; sha256 verified against the working tree).

- Leg 1 — `ses_e9959e39bffe1GFuEe0kZ13EoK`, **31/31 assistant rows actual
  `opencode/glm-5.3-flash-free`**, verdict `APPROVE_WITH_CHANGES` on v1. Applied:
  MED-1 (manual-paste lane teardown), LOW-3 (loud log when the release write throws),
  LOW-4 (same-binding dedupe), LOW-5 (released reason at mismatch park sites).
  Disclosed not fixed: MED-2.
- Leg 2 — `ses_e994ca103ffeL4bks1xhFqXEFJ`, **20/20 rows actual
  `opencode/glm-5.3-flash-free`**, verdict `APPROVE` on v2; all four findings CLOSED;
  independent re-run 7/7 new + 228 passed/2 skipped across the other dispatch suites +
  `tsc --noEmit` 0.
Author is DeepSeek, so both review legs are GLM (the required non-author model).

## GREEN + gate

- Focused: 7/7 new; 105/105 seven dispatch neighbour suites; `tsc --noEmit` exit 0.
- **Isolated gate** — detached worktree `%TEMP%\opencode\lane04-teardown-gate` at
  `636b90d` + ONLY the 3 reviewed paths (in-worktree blob ids verified:
  `5e0d576a`, `8137c214`, `4931e491`; `git status` shows nothing else):
  - `npm run typecheck` → exit 0
  - `npm test -- --maxWorkers=2` → exit 0; **79 files passed / 1 skipped (80)**,
    **959 passed / 2 skipped (961)**
  - `npm run build` → exit 0
  Logs: `evidence/lane-04-gate-{typecheck,test,build}.txt`.

## Commit + blob verification

`20c4600` on `636b90d`, exactly 3 paths (+622/−10). Committed blobs:

| path | blob | sha256 |
|---|---|---|
| `functions/src/modules/dispatch/dispatch.router.ts` | `5e0d576a` | `743CEC87…04B2CD3` |
| `functions/src/modules/dispatch/dispatch.webhooks.ts` | `8137c214` | `2B49DC01…2841A3C` |
| `functions/tests/dispatch.teardown-binding.test.ts` (new) | `4931e491` | `3CA29ACB…99FC7F67` |

All three equal the frozen manifest. 104 foreign dirty/untracked entries preserved; index
empty apart from the commit; nothing pushed, deployed, or staged outside scope.

## Remaining limits / disclosed residuals

1. **Porter lane has no released fence** (MED-2): `porter.service.ts`
   `cancelPorterBooking` also releases locally without a ledger, and Porter webhooks do not
   route through `handleDispatchWebhook`. Out of this packet's paths; Porter is
   retired/opt-in (`086b60d`). Needs its own follow-up.
2. Concurrent teardowns can lose one history entry (array replacement under `merge:true`);
   the fencing fields are nulled by both writers, so ownership is still retired.
3. A successful fresh book over a legacy stale binding still overwrites it without
   appending to history (base semantics): a late callback parks `order_id_conflict`
   instead of `order_binding_released` — fail-closed either way.
4. No dedicated test pins the same-binding dedupe / 5-slot bound (code-verified only).
5. No live Firestore, no provider call, no real booking, no deployment: local code
   verification only. HTTP 200/mocks/tests are not live fulfilment.
