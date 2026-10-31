# Existing session: reconcile the authoritative references with the retired-Porter reality

Queue task: `references-porter-drift`. Owner: original root05
`ses_ea5c88b2fffeMMzjFL6tYZzs5W` (GLM 5.3 Flash Free). No replacement writer.
Read `AUTONOMOUS_WINDOW.md`. Deadline 2026-10-22T03:05:59Z. Main is coordinator only.
This is a DOCS-ONLY packet: no product source, no Functions, no rules, no apps.

## Business facts you must reflect (already decided by the company, confirmed)

- **Porter is cancelled.** Dispatch is **Borzo** or **Shadowfax**, or the restaurant
  assigns its **own in-house rider** via `POST /orders/manualDispatch`
  (`deliveryStatus: dispatched`, `dispatchType: "manual_branch_terminal"`).
- `PORTER_ENABLED` must be exactly `"true"` to re-arm Porter; it re-arms FULL dispatch
  (new quotes, paid book, rebook) — there is **no history-only mode**. Committed as
  root `086b60d` with reference `references/delivery_routing.md` already corrected.
- Blaze is already enabled. ADB is installed but no phone is attached right now.
- Shadowfax has NO verified official contract yet; Borzo has no confirmed sandbox
  guarantee; Petpooja menu ingestion returned an S3 fetch error. Do not soften any of
  these into "supported".

## The drift you must fix

13 reference files still mention Porter; `references/backend_upgrade_spec.md` alone
mentions it 33 times and is described as the authoritative backend spec, so it very
likely still presents Porter as the live logistics path. Several other files
(`changelog.md`, `known_issues.md`, `order_flow.md`, `demo_presentation_script.md`,
`firestore_schema.md`, `rbac.md`, `ui_ux_spec.md`, `verification/7.3.md`) may repeat
the same assumption in smaller ways.

## Exact sole-writer scope (docs only)

ROOT `references/backend_upgrade_spec.md`, `references/delivery_porter.md`,
`references/changelog.md`, `references/known_issues.md`, `references/order_flow.md`,
`references/demo_presentation_script.md`, `references/firestore_schema.md`,
`references/rbac.md`, `references/ui_ux_spec.md`, `references/verification/7.3.md`.
Evidence: `closeout-20261022/lane-05-references.md`.

STRICTLY OUT OF SCOPE — these three files are owned by other sessions RIGHT NOW and
must not be touched, staged or "aligned":
`references/delivery_routing.md` (lane04), `references/push_notifications.md`
(lane07), `references/petpooja_save_order_api.md` (lane06). No `stages/**`, no
`functions/**`, no app repos, no `docs/**` outside `references/`.

## Required outcome

- Every statement that presents Porter as a live dispatch provider, a required
  integration, a credential to configure, or a menu/action in the product is
  corrected to the retired reality, with the same honesty level used in the already
  corrected `delivery_routing.md`: retired, opt-in, no history-only mode, in-house
  delivery is the restaurant's own path and is NOT customer pickup.
- `references/delivery_porter.md` stays as the historical/compatibility record (its
  webhook signature verification, the paste lane and reconciliation notes are still
  real code paths) but must be labelled as a retired integration with the current
  opt-in rule, so a reader cannot mistake it for an active contract.
- Do NOT delete history: changelog entries and verification records are evidence.
  Annotate them instead of rewriting them.
- Do not invent policy, vendor turnaround times, contacts, endpoints or credentials.
  Do not claim Petpooja/Borzo/Shadowfax/Razorpay provider verification. Keep the
  existing "BLOCKED / unknown / local code verified" labels where they are correct.
- Keep the repo's document conventions: the 60-30-10 palette and role vocabulary
  stay as they are; only logistics-provider truth changes.
- Cross-check every statement you change against the actual committed code
  (`functions/src/modules/dispatch/**`, `functions/src/modules/porter/**`,
  `functions/src/config/env.ts`) so the docs match behaviour, not the other way round.
  A doc edit never licenses a code edit; if the code contradicts the business fact,
  report the exact file:line to Main instead of changing code.

## Reviews and commit

Freeze the final changed documents with immutable copies + Git blobs + SHA256. ONE
fresh read-only actual DeepSeek Free reviewer child, THEN a DIFFERENT fresh read-only
actual GLM Free verifier child; verify actual serving models via the local session API;
reviewers write nothing and spawn no children. Apply findings, refreeze. On
429/transport stop and report the timestamp.

No heavy build gate is needed for documentation, but run whatever repository-provided
doc checks exist (if any) and report the real result. Commit only your listed
reference files locally; verify committed blobs against the manifest; never stage
foreign paths; never push/deploy.

Report `QUEUE_TASK: references-porter-drift` with the commit, hashes, per-file
summary, review IDs + actual models, and any code/doc contradiction you found (with
file:line) that Main must route to the owning lane. End with the exact unquoted final
line `SUPERVISOR_STATE: COMPLETE` only when the packet is really closed.
