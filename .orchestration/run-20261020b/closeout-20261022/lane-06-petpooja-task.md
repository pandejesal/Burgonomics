# Existing session: close the Petpooja zero-fabrication + evidence-truth packet

Queue task: `petpooja-zero-fabrication`. Owner: original root06
`ses_ea5c885c0ffeujhkJzdpAtUFJb` (GLM 5.3 Flash Free). No replacement writer.
Read `AUTONOMOUS_WINDOW.md`. Deadline 2026-10-22T03:05:59Z. Main is coordinator only.

## What already exists (adopt the existing packet, do not restart an audit)

Partner repo `burgonomics-partner` at HEAD `6f81fba`:

- `src/services/petpoojaSync.ts` — the mock branch (the DEFAULT whenever the live
  gateway is absent, including production builds) writes the built-in demo catalog
  with invented `PP-BRG-*` item ids into `menu/{branchId}/…`. The pending hunk refuses
  that write outside `import.meta.env.DEV` (`!import.meta.env.DEV` throws) while keeping
  the dev offline demo.
- `src/services/petpoojaSync.test.ts` — pending test delta for that refusal.

Root repo:

- `functions/tests/petpooja.evidence-truth.test.ts` — new pin that the reference
  provenance cites surviving evidence and not machine-local paths.
- `references/petpooja_save_order_api.md` — already-edited reference whose provenance
  wording must satisfy that pin.

No new vendor calls, no live catalog writes, no credentials.

## Exact sole-writer scope

1. `burgonomics-partner/src/services/petpoojaSync.ts`
2. `burgonomics-partner/src/services/petpoojaSync.test.ts`
3. `references/petpooja_save_order_api.md`
4. `functions/tests/petpooja.evidence-truth.test.ts`
5. Your evidence `closeout-20261022/lane-06.md`

OUT of scope: partner `MenuPage`/`useMenu` (lane02's parked packet), `src/services/*`
other than petpoojaSync, all Functions source, rules, payments, native, other tests.

## Required outcome

- A production build must REFUSE to persist demo catalog data and must surface an
  honest, non-fabricated error; a dev build keeps the offline demo. Prove both, and
  prove the refusal happens before any batch write (no partial write).
- Consumers must not present the refusal as success. Check the existing badge/hook
  behaviour read-only and report it; do not expand scope to fix unrelated UI.
- The reference must describe only what the surviving evidence supports: received
  callbacks are not fulfilment, the five-case evidence is 0/5 verified, provenance
  lives outside the repo, and it is not independent vendor confirmation. No invented
  vendor turnaround, contacts or policy.
- Keep `petpoojaSync.test.ts` assertions meaningful: the previous version failed under
  another lane's typecheck, so confirm the file is type-clean and the new case fails
  without the guard and passes with it.

## Reviews, gate, commit

Freeze the final changed paths with immutable copies + Git blobs + SHA256. ONE fresh
read-only actual DeepSeek Free reviewer, THEN a DIFFERENT fresh read-only actual GLM
Free verifier; verify actual serving models via the local session API. No child
spawning by reviewers. Apply findings, refreeze. On 429/transport stop and record it.

Gates (one heavy gate per repo, and PARTNER is currently occupied by lane02):
- Functions: the `functions/tests/petpooja.evidence-truth.test.ts` change is test-only;
  run it focused now, and include it in the Functions full gate only if Main grants the
  slot. Do not start a second Functions full gate.
- Partner: focused vitest for petpoojaSync now. The PARTNER full gate
  (`npm run typecheck`, `npm test -- --maxWorkers=2`, `npm run build`) only after lane02
  posts END/release or Main grants it; ask via bus rather than idling.
- Root reference-only change needs no build; the functions test currently reads it.

Commit each repo's reviewed paths locally and separately (partner commit, root commit);
never mix, never stage foreign work, never push/deploy. Report
`QUEUE_TASK: petpooja-zero-fabrication` with both commits (or BLOCKED + exact pending
gate), hashes, RED/GREEN, review IDs + actual models, and limits
("LOCAL CODE VERIFIED" max). End with the exact unquoted final line
`SUPERVISOR_STATE: COMPLETE` only when actually done.
