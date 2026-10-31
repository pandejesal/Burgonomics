# Existing customer session: address packet closeout

Task ID: customer-address-closeout. Original root `ses_ea5c8a548ffex6hMqeB90XmuF0`.
Read `AUTONOMOUS_WINDOW.md`. End time 2026-10-22T03:05:59Z. Finish existing work;
no new audit, replacement worker, timer/watcher or unbounded retry.

## Exact sole-writer scope: customer repository

- `src/features/addresses/repositories/AddressRepository.ts`
- `src/features/addresses/services/addressService.ts`
- `src/features/profile/components/AddressFormModal.tsx`
- `src/routes/addresses.create.tsx`
- `src/routes/profile.addresses.tsx`
- `src/features/profile/components/AddressFormModal.test.tsx`
- `src/routes/addresses.create.test.tsx`
- `src/routes/profile.addresses.test.tsx`
- `tests/address-persistence-failures.test.ts`
- Your evidence `closeout-20261022/lane-01.md` in the ROOT repo.

These are existing dirty/new files, not permission to replace them with a new
implementation. Inspect and explicitly adopt the old patch after investigation.
Preserve its useful behavior; identify any real defect with a regression test.
Do not touch menu, shared/design, payment, native, other tests or any other repo.

Current customer HEAD `2f47cef1dd9d9b7696898c3c502051df22b7dc2f`. Completed
typecheck/scroll/Android/rules packets are NOT reopened. All foreign working-tree
changes stay untouched. Main owns root dispatch and lane07 owns notification code.

## Required outcome and evidence

Remote save/delete/default-address failures must not be reported as success or
silently become permanent local-only addresses. Account A's delayed response/cache
must not populate account B. UI must retain/recover entered data and show an honest,
accessible error without navigating away or emitting a success toast on failure.
Tests must cover failures as well as successful saves, not just mock a happy promise.

First reproduce with the existing focused tests, then compare pristine HEAD plus
ONLY final tests to prove the failure. Frozen immutable manifest must list all
reviewed Git blobs and SHA256s. No fallback to the dirty-tree whole build as proof.

You are explicitly authorized to use one actual DeepSeek V4.1 Flash Free READ-ONLY
review child, THEN a DIFFERENT actual GLM 5.3 Flash Free READ-ONLY child on final bytes.
Verify assistant serving models, not merely pins, and never count your own verdict.
Reviewers must not spawn children. No paid/Sol/other provider fallback. If 429 or
transport failure: stop new requests, record timestamp/pending step, no retry storm.

Main grants the CUSTOMER heavy-gate slot to this packet (no other customer owner
currently runs). After reviews, an isolated worktree at the actual base with ONLY
these nine paths must pass `npx --no-install tsc --noEmit`, `npm test -- --maxWorkers=2`,
and `npm run build`. Capture per-command exit records and final hashes. Restore only
your isolated build-generated route tree if it affects diff scope; never main's
foreign edits. Native/device or provider acceptance cannot be inferred from this.

On green final reviews/gate, commit ONLY reviewed nine paths locally (and only
changed ones). Check no foreign staged paths, verify committed blobs match manifest.
Never push/deploy or stage runtime artifacts, env/secrets, binaries or other work.
If blocked after freezing, return the manifest and exact pending step, so Main can
finish deterministic validation rather than duplicate the implementation.

Begin final reports with `QUEUE_TASK: customer-address-closeout`, truthful status, exact commit/scope,
RED/GREEN counts, DS and separate GLM IDs/actual models, isolated gate results,
foreign work preserved, and only LOCAL CODE VERIFIED label if earned.
Only after reviews, gate, commit and evidence are complete, end with the unquoted
exact final line `SUPERVISOR_STATE: COMPLETE`. Otherwise name the pending step.
