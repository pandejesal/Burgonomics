# Existing session follow-up: torn-down dispatch bindings still own the order

Queue task: `dispatch-teardown-binding`. Owner: original root04
`ses_ea5c89e34ffeE5jJ0PRSjVSH2k` (GLM 5.3 Flash Free). No replacement writer.
Read `AUTONOMOUS_WINDOW.md`. Deadline 2026-10-22T03:05:59Z. Main is coordinator only.
This is the residual follow-up you disclosed in `d3f3728`; it is now the packet.

## The defect (verified by Main in the committed source)

Your new ownership proof in `functions/src/modules/dispatch/dispatch.webhooks.ts`
(committed `d3f3728`) compares the callback's provider and provider-order id against
the order's CURRENT `dispatchProvider` / `dispatchOrderId` before mutating anything.
That is correct — but two teardown paths leave those two fields pointing at a booking
that no longer exists:

1. `releaseClaimFailed()` — `dispatch.router.ts` ~191–225 — sets
   `dispatchStatus: "dispatch_failed"`, `dispatchClaimedAt: null`, `needsRebook: true`,
   `rebookTrigger`, but does **not** clear or retire `dispatchProvider` /
   `dispatchOrderId`.
2. `dispatchCancel()` — `dispatch.router.ts` ~1258–1315 — sets
   `deliveryStatus: "rider_cancelled"`, `dispatchStatus: "cancelled_by_store"`,
   `needsRebook: true`, `rebookTrigger: "staff_cancelled"`, but does **not** clear or
   retire `dispatchProvider` / `dispatchOrderId` either.

Consequence: after a failed booking or a staff cancellation, the order still *claims*
the torn-down booking, so a late callback from that dead booking still satisfies the
new ownership proof. A late `DELIVERED`/`RIDER_CANCELLED` from a cancelled booking can
mutate the order (terminal flip, rebook flag, rider fields) even though the restaurant
already released it. That is exactly the class of bug the ownership proof was added to
stop, one step earlier in the lifecycle.

Prove it first: a router-side unit test that performs a teardown and then shows the
order's `dispatchProvider`/`dispatchOrderId` still match the dead booking; then a
webhook test that sends a late callback for that dead booking and shows the order
mutates today. Keep both RED before the fix.

## Required fix (narrow, no redesign)

- Make a teardown retire the binding atomically with the teardown write: the order
  must no longer present the dead booking as its current owner. Either clear the
  active fields and move the values into an explicit released/dead-binding record
  (preferred: a small `dispatchReleasedBindings` array or equivalent, so the audit
  trail and Porter reconciliation are preserved), or add an explicit
  `dispatchBindingReleased: true` marker that the webhook ownership proof honours.
  Choose one and state why. Do NOT lose the historical binding — reconciliation of a
  real delivered/cancelled provider booking still needs it.
- The webhook proof must treat a released binding as NOT owning the order: park the
  late callback HIGH with a distinct reason (e.g. `order_binding_released`) and mutate
  nothing. A callback for the CURRENT live booking must still work normally.
- Keep the shipped containment rules intact: customer-cancel / returned-parcel stay
  `needs_review` with `needsRebook: false`; carrier cancels keep auto-rebook; staff
  cancels keep `rebookTrigger: "staff_cancelled"` and never auto-rebook.
- `dispatchRebook` must write a fresh binding and must not resurrect a released one.
  If a rebook happens, the old released binding stays released history.
- Porter historical compatibility and the staff paste lane must not regress
  (`PORTER_ENABLED` is opt-in, retired by default — root `086b60d`).
- No provider calls, no real bookings, no environment or credential changes.

## Exact sole-writer scope

`functions/src/modules/dispatch/dispatch.router.ts`,
`functions/src/modules/dispatch/dispatch.webhooks.ts`,
`functions/tests/dispatch.*` (existing suites may be adapted; add the new regression
file), `references/delivery_routing.md` only if a documented invariant changes, and
your evidence `closeout-20261022/lane-04-teardown.md`.

OUT of scope: every other Functions module, payments, notifications, config/env, apps,
rules, native. Preserve all foreign dirty paths.

## Reviews, gate, commit

Freeze final bytes with immutable copies + Git blobs + SHA256, and prove RED over the
committed source (`d3f3728`) then GREEN on the candidate. ONE fresh read-only actual
DeepSeek Free reviewer child, THEN a DIFFERENT fresh read-only actual GLM Free verifier
child; verify actual serving models through the local session API (a reused mixed
session is not a valid leg — you already learned that this window); reviewers write
nothing and spawn no children. On 429/transport stop and report.

FUNCTIONS heavy-gate slot: lane07 is currently running its FCM gate at `d3f3728`.
Wait for its END/release (or Main's explicit grant) before starting yours — do not run
a second Functions gate concurrently. Then isolate at the then-current root HEAD plus
ONLY your reviewed paths and run `npm run typecheck`, `npm test -- --maxWorkers=2`,
`npm run build`, capturing real exits/counts.

Commit only reviewed paths locally, verify committed blobs against the manifest,
never stage foreign work, never push or deploy.

Report `QUEUE_TASK: dispatch-teardown-binding` with the commit (or BLOCKED), the RED
reproduction, the teardown representation you chose and why, hashes, review IDs +
actual models, gate exits, and the remaining limit. End with the exact unquoted final
line `SUPERVISOR_STATE: COMPLETE` only when the packet is really closed.
