# Existing session: close the customer payment truth/recovery packet

Queue task: `customer-payment-truth`. Owner: original root08
`ses_ea5c87df5ffe7Vjpzr9yv5VLpA` (DeepSeek V4.1 Flash Free). No replacement writer.
Read `AUTONOMOUS_WINDOW.md`. Deadline 2026-10-22T03:05:59Z. Main is coordinator
only: it will not edit this packet.

## What already exists (investigate and adopt, do not restart)

Customer repo `burgonomics-foundation-core` at HEAD `2f47cef`, base for your packet.
Dirty and uncommitted, matching lane08's earlier review chain:

- `src/features/payment/hooks/useRazorpayPayment.ts` (+164/−45 region)
- `src/features/payments/repositories/PaymentRepository.ts` (+64/−…)
- new tests: `tests/server-payment-truth-guards.test.ts` (484), `tests/paid-order-finalization.test.ts` (483), `tests/payment-response-wire.test.ts` (583), `tests/order-service-auth-isolation.test.ts` (298), `src/features/payment/hooks/useRazorpayPayment.test.tsx` (206), `src/features/payments/components/PaymentRecoveryPanel.test.tsx` (180)

These describe a coherent theme: a verified-but-unfinalized payment must never be
reported as failed, must never clear the cart, must never navigate, and must not be
re-paid; server truth (not client cache, not a client-written `paid` literal) decides
paid/declined; recovery is explicit and idempotent. Commit `980ef3e` and the other
committed payment fixes are NOT reopened.

## Exact sole-writer scope

1. `src/features/payment/hooks/useRazorpayPayment.ts` + its `.test.tsx`
2. `src/features/payments/repositories/PaymentRepository.ts`
3. `src/features/payments/components/PaymentRecoveryPanel.tsx` if it exists/needed + its `.test.tsx`
4. The four new `tests/*payment*|*order-service-auth-isolation*` files above
5. Only if a test genuinely needs a production seam: the specific payment route/component
   file, reported in your final scope list.

Phase B (ROOT repo, only after Phase A is committed): two untracked money-safety pins
written by an earlier payments owner and never reviewed, never committed —
`functions/tests/payments.webhook-stale-claim.test.ts` (webhook claim idempotency,
stale-claim takeover, D1 TOCTOU double-settle containment) and
`functions/tests/routeTransfers.lease-race.test.ts` (route-transfer retry-worker
lease race: exactly one claim, loser makes zero gateway calls). Treat them as
untrusted input: read them, decide whether each pin matches the CURRENT committed
source, fix the pin if it encodes a stale reading, and fix the source only if a real
money-safety defect is proven. The Functions full gate for these two files is
serialized by Main after lane04/lane07 release the Functions slot — run them
focused now and say so honestly.

Explicitly OUT of scope: `firestore.rules`, `tests/rules/firestore.rules.test.ts`
(rules are lane07's ownership — Main will route that separately), other Functions
modules, `burgonomics-partner`, native, menu, address, shared UI, any unrelated
dirty path.

## Required engineering outcome

- Enumerate the client states that follow a gateway/auth/server/network outcome and
  prove each one: verified+finalized, verified+unfinalized (paid but no order),
  pending/unknown (money may have moved), server-proven decline (retryable),
  AUTH_CHANGED mid-flow, duplicate submit, timeout.
- A failure to finalize must surface a recoverable, accessible state with the payment
  id/selection preserved; it must not say "payment failed", must not re-charge, must
  not clear the cart silently, must not double-navigate, must not mint an order id.
- `PaymentRepository` must hydrate the order store only from server-confirmed truth,
  refuse another owner's doc, refuse terminal/cancelled docs, and never treat a cache
  entry as paid proof.
- Prove the no-false-success property with a negative control over pristine committed
  source, then the candidate. Do not weaken production code to create RED.
- State plainly what cannot be proven without the Razorpay webhook secret or a real
  dashboard (no provider-test claim). No live payment/refund calls, no key printing,
  no real money.

## Reviews, gate, commit

Freeze the final changed paths with immutable copies + Git blobs + SHA256. Use ONE
fresh read-only actual `opencode/deepseek-v4.1-flash-free` reviewer, THEN a DIFFERENT
fresh read-only actual `opencode/glm-5.3-flash-free` verifier; verify each assistant's
actual serving model through the local session API (pins are not proof). Reviewers
spawn no children and edit nothing. Apply findings and refreeze material deltas.
On 429/transport stop: record timestamp and stop; no model/provider substitution.

CUSTOMER heavy-gate slot is free now (lane01 closed `6e25a0c`), and Main grants it to
this packet after final reviews. Isolated worktree at `2f47cef` plus ONLY the reviewed
paths: `npx --no-install tsc --noEmit`, `npm test -- --maxWorkers=2`, `npm run build`.
Capture real exits/counts. Then commit only reviewed paths locally; verify committed
blobs against the manifest; preserve all foreign work; no push/deploy.

Report `QUEUE_TASK: customer-payment-truth` with commit or BLOCKED, hashes, RED/GREEN,
both review IDs + actual models, gate exits, and limits ("LOCAL CODE VERIFIED" max).
End with the exact unquoted final line `SUPERVISOR_STATE: COMPLETE` only when done.
