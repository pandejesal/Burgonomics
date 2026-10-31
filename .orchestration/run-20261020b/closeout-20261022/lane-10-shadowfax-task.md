# Existing session: Shadowfax fail-closed verification (read-only evidence packet)

Queue task: `shadowfax-fail-closed-verification`. Owner: original root10
`ses_ea5c878abffemS4Xy9icDiSjo8` (DeepSeek V4.1 Flash Free). No replacement writer.
Read `AUTONOMOUS_WINDOW.md`. Deadline 2026-10-22T03:05:59Z. Main is coordinator only.

You have been WAITING_OWNER since 2026-10-21T04:16Z. Here is the owner decision.

## Decision

Your Shadowfax work is committed (`3c8c7c7`, `4be553b`, `a5549fc`) and the Borzo and
Shadowfax adapters are NOT being re-implemented. Because no verified official
Shadowfax contract and no credentials exist, the deliverable is **fail-closed
behaviour proven locally**, plus an exact list of the questions only the vendor can
answer. This packet is READ-ONLY VERIFICATION: you may read code, run the existing
local test suites with fakes/signed fixtures, and WRITE one evidence document.

## Exact scope

READ: `functions/src/modules/dispatch/providers/shadowfax.adapter.ts` and any
Shadowfax-only helpers, `functions/tests/dispatch.shadowfax*`, the committed
fail-closed work, `references/delivery_routing.md` (read-only: lane04 owns it
right now — do not edit), and `references/delivery_porter.md` if it describes the
shared dispatch contract.

WRITE (the only writable path): `.orchestration/run-20261020b/closeout-20261022/lane-10-shadowfax-verification.md`
plus, only if you find a genuine defect that the current tests do NOT catch, propose
the exact minimal fix in that document — **do not apply it**, do not edit source, do
not create test files. If a defect is real, report file:line, the failing scenario
and the missing negative test so Main can route it.

## What to verify and prove

1. **Fail closed without configuration.** With no Shadowfax credentials (and with
   partial/blank ones), the adapter must be ineligible for quoting and must refuse to
   book. No silent default, no "book anyway" path, no mock mode leaking into a
   non-test environment. Prove it with the existing suite and, if needed, a small
   read-only probe that does not write files.
2. **Signature handling has no invented contract.** If the implementation expects a
   signature scheme, state exactly what it verifies today and flag clearly that the
   official Shadowfax callback authentication scheme is NOT confirmed by a vendor
   document. Do not upgrade "we wrote something" into "the vendor requires it".
3. **Error mapping and retry semantics.** Show which provider errors are retried,
   which are terminal, and that a retry cannot double-book. If the code cannot prove
   it, say so.
4. **Declared-value / amount handling.** Report what the adapter sends today and mark
   the value-0 / declared-value policy as UNRESOLVED (a human/company decision).
5. **Interaction with the retired-Porter path and the in-house path.** Confirm the
   Shadowfax adapter is independent of Porter (Porter is retired and opt-in, see
   root `086b60d`) and that the restaurant's in-house route does not depend on any
   provider quote.
6. **Idempotency/status mapping.** Show how a duplicate or out-of-order callback is
   handled at the adapter level, and be explicit that end-to-end webhook behaviour is
   owned by lane04's in-flight `dispatch-boundary-closeout` packet — do not duplicate
   or contradict that work.

## Output you must produce

- The evidence document above: what you verified (with the exact commands and their
  real output/counts), what is static reasoning, what remains BLOCKED.
- A precise vendor question list for Shadowfax (official callback/authentication
  specification, retry/signing behaviour, sandbox mode and whether a test booking can
  dispatch a real rider, serviceability/pricing schema, declared-value rules,
  cancellation and idempotency guarantees, settlement/ETA endpoints, credentials
  channel). This list feeds the human production handoff, so it must be something a
  human can send without further editing.
- An explicit truth label: at most `LOCAL CODE VERIFIED`. There is no provider-test
  evidence and you must not imply any.

## Rules

No source edits, no test-file edits, no commits, no provider/network calls, no
credentials, no real booking, no push/deploy. Use ONE fresh read-only actual
DeepSeek Free reviewer child and THEN a DIFFERENT fresh read-only actual GLM Free
verifier child on your findings document if you want a second pair of eyes — verify
their actual serving models via the local session API; reviewers write nothing and
spawn no children. On 429/transport stop and report.

Report `QUEUE_TASK: shadowfax-fail-closed-verification` with the document path, the
verified/unverified split, the vendor question list, review IDs + actual models, and
the honest limits. End with the exact unquoted final line `SUPERVISOR_STATE: COMPLETE`
only when the evidence document is really finished.
