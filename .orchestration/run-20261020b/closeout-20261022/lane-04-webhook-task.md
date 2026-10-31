# Existing backend session: close the dispatch webhook packet

Queue task: `dispatch-boundary-closeout`.
Original root: `ses_ea5c89e34ffeE5jJ0PRSjVSH2k`.
Read `AUTONOMOUS_WINDOW.md`; stop starting new work at 2026-10-22T03:05:59Z.
Only actual DeepSeek V4.1 Flash Free / GLM 5.3 Flash Free, including children.

## Scope and handoff

Main explicitly hands these paths back to you as sole writer:

1. `functions/src/modules/dispatch/dispatch.webhooks.ts` (existing dirty F2/F6/F7 patch)
2. `functions/tests/dispatch.webhook-boundary.fresh.test.ts` (existing new suite)
3. `references/delivery_routing.md` (only this packet's source-contract correction)
4. Evidence `closeout-20261022/lane-04-webhook.md`.

Do NOT reimplement the ticket lease (`5e1777c` is committed) or Porter retirement
(`086b60d` is committed). No index, payments, notifications, adapters, apps, rules,
or unrelated tests. Root07 owns notification source; root01 owns customer addresses.
Preserve all their changes and every foreign path/index entry.

This is the written but uncommitted F2/F6/F7 packet, not a new audit. Main investigated
and froze it at `Temp/opencode/main-dispatch-boundary-v1/manifest.json`, base `086b60d`.
Source blob `a8896af45c830076a246adf586ad06c4eade7947`, test blob
`4ab8a98f81e3ee23249c2e1b754eb657d7e8f1b7` (source paths are relative to root).
Fresh actual DS review `ses_e9efc4eebffejwcRcuTJQQWyeY` returned CHANGES_REQUIRED.
Your previous inline "DS review" comments do not count as final-byte approval.

## Fix the found defects, with discriminating RED then GREEN

1. **Stale map after rebook (HIGH).** Checking `dispatch_order_map.provider` alone
   does not prove the *order* still belongs to that provider/ID. The old Borzo map
   survives a Borzo→Shadowfax rebook. Its late DELIVERED/CANCELLED callback still
   passes and corrupts the new booking. Before any order mutation, validate the
   current order's provider AND bound provider-order ID against the callback,
   including map-first and provider-less legacy map paths. Park mismatches high,
   mutate no order/rider/status/rebook fields, and do not send a rebook FCM.
   Keep genuine same-provider/current-binding controls green. Normalize numeric
   IDs consistently; absent legacy provider metadata is not license to guess.

2. **Cancellation containment not sticky (HIGH).** Customer cancel or returned
   parcel clears needsRebook, but a later NO_RIDERS_FOUND/generic carrier cancel
   on the same booking sets it true again and the worker books another courier.
   Add sequence tests for both causes and subsequent carrier/arrival events.
   Preserve the contained/manual-review state and forbid rebook alerts or flags.
   Do not promise concurrency protection from a nontransactional read/write.

3. **Main's engineering decision on manual review:** do not add unrecognised
   `deliveryStatus` / mirror vocabulary just for these events. Use the existing
   `needs_review` dispatch state with explicit customer/returned cause in the
   existing rebookTrigger/reason. Keep `needsRebook=false`. Preserve the customer's
   order lifecycle/status and refund/payment fields on these two manual-review
   outcomes; the current unconditional `status.code=RIDER_CANCELLED` violates its
   own comment. Ordinary carrier cancel keeps its prior behaviour. Automatic
   redelivery is prohibited; a separate explicit authenticated, branch-scoped staff
   rebook after review remains the already-existing `needs_review` workflow.
   This does not invent refund policy or customer consent. State the limits.

4. **Test fidelity:** missing orders must really be absent, not `exists:true` with
   `defaultOrder()`. Use explicit seeds for positives, real absence for negatives,
   and a merge fake faithful to the nested fields being asserted. The passthrough
   transaction fake is NOT race evidence. Fix misleading fixture comments and the
   test called rider_cancelled that actually seeds customer_cancelled. Prove late
   pickup/arrival does not rewind and legitimate first arrival still records.

Retain an immutable v1 source copy for RED of the new HIGH cases. Also run final
tests over pristine committed source for the original packet's defects; distinguish
those two negative controls. Never mutate production source merely to fake RED.

## Reviews, gate and commit

You may use one fresh read-only actual DS reviewer, then a DIFFERENT actual GLM
verifier on the final snapshot. They must not spawn children. Hash every candidate,
apply findings narrowly and refreeze; don't count an author verdict, a requested pin,
or approval of older bytes. Confirm assistant serving rows via the local session API;
do not scan/edit the entire OpenCode database. On429/transport stop, no retry storm
or paid/Sol/provider substitution.

Focused tests are allowed. ROOT/FUNCTIONS full-gate slot is currently reserved for
lane07's token closeout; after it posts END/release or Main grants it, run one isolated
gate at the actual current root HEAD plus ONLY these source/test/reference paths:
`npm run typecheck`, `npm test`, `npm run build`. Capture real exits/counts/hashes.
Commit only this reviewed bundle locally after green. No push/deploy, vendor/rider/
money calls, secret changes, PII or broad staging. Do not silently add more paths.

Start final report `QUEUE_TASK: dispatch-boundary-closeout`; include exact scope,
commit, hashes, both review IDs/actual models, RED/GREEN/gate evidence and limits.
Only when actually done end with the exact unquoted final line
`SUPERVISOR_STATE: COMPLETE`. Otherwise name the genuinely pending step.
