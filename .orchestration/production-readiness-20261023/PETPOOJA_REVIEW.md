# Main review of first Petpooja patch — not accepted

Gemini author `ses_e988b2d69ffeFJOf0eS0zQxgXa` reports 149 focused tests and
typecheck passing. These results do not close the following static findings;
add discriminating regression tests before repair and independent acceptance.

1. **Stock acknowledgement TOCTOU.** `item86ingSync.ts` reads the product after
   the response then calls unconditional `update`. A newer client write can land
   between those operations. Wall-clock `updatedAt > requestInitiatedAt` also
   misses same-millisecond and client clock-skew cases. Use a real Firestore
   snapshot version precondition or transaction, not local-clock ordering.
2. **Stale acknowledgement claims success.** The skipped-overwrite path returns
   true while canonical stock and remotely acknowledged state disagree. Preserve
   newer local truth, return false/reconciliation warning; never fabricate rollback.
3. **Quarantine write validity.** The unmatched-stock ID interpolates unvalidated
   outlet input, and `rawInStock: undefined` is not a valid Firestore write. Use
   bounded safe identity (e.g. a deterministic hash) and defined scalar values.
   Refuse cross-branch/cross-item product ownership, including inbound events.
4. **Transaction read ordering.** Scheduler claim loop interleaves `tx.get` and
   `tx.set` for multiple pending docs. Real Firestore rejects reads after writes;
   the one-order fake misses this. Read all snapshots before any claim writes.
5. **KOT truth.** Both mock and relay ACK paths set `kotPrinted: true` and
   `kotPrintedAt`. A relay response is not physical-printer proof. Preserve ACK
   deduplication and relay timestamps but do not manufacture printing evidence;
   replace comments that overclaim past fulfilment. Prove this for ID/no-ID ACKs.
6. **Crashed processing visibility.** Current scan reads only pending_retry;
   crashed processing orders remain invisible indefinitely. Do not blindly retry
   an ambiguous POST. Detect stale processing with fresh rechecks and park/alert
   for manual reconciliation without provider I/O; never reset a live competitor.

These findings are in the existing Petpooja scope, not a new live integration or
authorization to call vendors. Dispatch files remain independently scoped.
