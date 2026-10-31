# Prepared task: restaurant delivery choice (admit only when a writer slot frees)

Task ID `restaurant-dispatch-choice`. Original Partner root
`ses_ea5c8a2daffekU3r3U5bPrJspn`. This brief is an assignment, NOT a claim that a
prompt was delivered. Read `AUTONOMOUS_WINDOW.md`; deadline 2026-10-22T03:05:59Z.

## Confirmed requirement

Porter is cancelled. Restaurants can choose a Borzo/Shadowfax courier or their
own in-house rider for an eligible delivery order. In-house is a first choice,
not customer pickup and not dependent on a successful third-party quote.
Keep existing naming/export compatibility where renaming would create unrelated
churn; users must not see a new-order action that books Porter.

## Sole-writer scope on admission: Partner repository

1. `src/features/delivery/components/PorterDispatchCard.tsx`
2. `src/features/delivery/components/RiderAssignmentModal.tsx`
3. `src/features/delivery/hooks/usePorterLogistics.ts` (existing dirty patch; inspect/adopt)
4. `src/pages/DeliveryQueuePage.tsx` (existing dirty patch; inspect/adopt)
5. `src/features/orders/components/OrderTableList.tsx`
6. `tests/restaurant-dispatch-choice.test.tsx` (new focused regressions)
7. `tests/porter-logistics.test.ts` only if existing assertions need truthful adaptation
8. Your evidence `closeout-20261022/lane-02-delivery.md` in root.

No root Functions, native, menu, types/mapper, shared UI or unrelated test edits.
If a real mapping seam drops a necessary server field, report its exact path and
minimal required change to Main BEFORE silently adopting it. Preserve foreign work.
Current Partner base `6f81fbafa4ba907d8c6cd770a6f332ebd6222af2`.

## Known concrete defects to reproduce, not a new broad UI audit

- `getRiderStatusMeta` checks `deliveryStatus === manually_assigned`; the real
  server writes `dispatchType: manual_branch_terminal`, `deliveryStatus: dispatched`.
  Therefore an in-house rider is labelled Porter and gets a Cancel Porter action.
  Recognize real server shape, respect terminal states, and show actual provider
  labels for Borzo/Shadowfax. Do not infer Porter merely from a rider name; only
  explicit historical Porter evidence may use that label.
- The Orders table still has a paid direct Porter row action. Replace it with
  navigation to the EXISTING correct delivery queue route (including `/admin`
  prefix where appropriate), not a renamed button that calls `/porter/book`.
  Changing all module names is not the task.
- Delivery page heading/connectivity copy says Porter even though quotes are
  multi-provider. Quote presence is not proof of either provider's health.
- `RiderAssignmentModal` invokes an async callback as void and closes immediately.
  Failed assignment must retain name/phone/vehicle, expose an accessible error,
  stay open, and permit a safe retry. Pending submission must disable duplicate
  submits. Close/reset only after confirmed success, with no fake rider fallback.
- `assignInHouseRider` currently makes a second order-status write after the server
  saves assignment. **Assignment/booking is not pickup proof.** Do not fabricate
  out-for-delivery merely because a rider name was saved. Backend manual assignment
  owns rider/dispatched fields; actual handover uses the existing order lifecycle.
  Check external booking paths in this same hook for the same false claim, narrowly.
  Never retry a successful server assignment as if it had failed due to a later
  unrelated client write. A failed/false server response is not success.
- The pending webhook packet uses existing `needs_review` plus explicit cause for
  customer-cancelled/returned parcels, with needsRebook=false. Do not render those
  as automatic carrier rebook or as kitchen cooking; show manual-review text.
  No automatic refund or redelivery is implied.

Keep in-house available when a third-party quote is loading, fails or is absent,
without invoking book/rebook/cancel provider callbacks. A live courier booking or
unresolved claim must not be silently switched by a UI-only check; backend atomic
assignment hardening is a separate Main-owned packet. Report that limit honestly.

## Acceptance, accessibility and test gates

Load `nexus-interface-a11y` and `nexus-design-taste` before changing markup. This is
a focused functional correction, not a redesign: existing semantic design tokens,
44x44 touch targets, visible keyboard focus, labelled form fields and dialog controls,
and non-colour error/status text. Reuse existing patterns; no speculative UI kit.

Prove negatives and positives with real component/hook boundaries: no quote still
permits in-house; click never books Porter; server-shaped in-house status is shown;
pending double-click makes one call; failed assignment retains input/no success or
close; successful assignment closes only after response; assignment does not claim
pickup/out-for-delivery; manual-review outcomes do not auto-book.

Freeze exact changed paths and SHA256/Git blobs. Prove RED over pristine committed
source with final tests; do not generate RED by weakening production code. Fresh
read-only actual DeepSeek review child THEN a separate actual GLM verifier, one
active child per owner; reviewers spawn no children. On429/transport STOP, no model
substitution or automatic retry loop. Verify actual assistant serving rows via API,
not an all-table database scan or the requested model name alone.

Main grants the PARTNER heavy-gate slot after admission and final reviews. Use an
isolated exact bundle: `npm run typecheck`, `npm test -- --maxWorkers=2`, `npm run build`.
Existing tests may require the sibling customer DOM dependency and existing public
Firebase client settings IN MEMORY; no dummy keys, secret printing or tracked .env.
Capture actual per-step exits and final hashes. No overlapping Partner heavy gate.

On valid final reviews/gate, exact local commit only. Never push/deploy or touch
phone/customer/provider accounts. Begin final report
`QUEUE_TASK: restaurant-dispatch-choice`; include commit, manifest, serving proof,
RED/GREEN/gates and source-only limits. End `SUPERVISOR_STATE: COMPLETE` only when
actually finished, otherwise name the pending step.
