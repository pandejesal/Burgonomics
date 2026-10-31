# Payment/POS backend results — refund disposition CAS + `order.paid` payment selection

Date: 2026-10-29
Worktree: `.swarm-worktrees/backend-email-contract-20261029` (HEAD `31e82c3c415757064e3b33010ade4d2b0d8ebd6f`)
Scope: `functions/` only. No commit, push, deploy, provider HTTP call, live payment, refund,
SMS/push, production Firestore write, env or secret change.

Two defects were implemented to a verified state in this pass. A third set of payment/POS
hypotheses was **recorded only** and is listed at the end so it is not mistaken for work done.

---

## 1. Refund disposition was a check-then-update (double disposition)

**File:** `functions/src/modules/payments/refundRequests.ts`
Before: `refunds` was `get()`-ed at line 26, the branch check ran against a separately read order
(`:41`), and the decision was written with `update()` at `:52`. Two concurrent rejects both read
`PENDING` and both wrote, so the second overwrote the first reviewer's `disposition.reason`.

**Repair:** the whole decision is one `runTransaction` (`:46`):
- read 1 — the request (`tx.get`), 404 when absent;
- read 2 — the linked order **inside the same transaction** (`:60-66`), then
  `assertOrderBranchAccess` (:66) so ownership is decided against the snapshot that commits;
- compare-and-set on `status === "PENDING"` (`:69-79`), 409 otherwise;
- one write (`tx.update`, `:81`), preserving any existing decision untouched.
Reads precede writes as Firestore requires. A datastore without `runTransaction` fails closed
(503 `REFUND_DISPOSAL_UNAVAILABLE`, `:36`) instead of silently reverting to check-then-update.

## 2. `order.paid` keyed the payout to `payments[0]`

**File:** `functions/src/modules/payments/webhookHandler.ts`
Before: `:169-185` took `payments[0]` and accepted whatever it was — the failed attempt when an
order had several. That id becomes `payment.razorpayPaymentId` and the Route transfer key, so a
failed attempt's id was recorded as the captured payment (refund binding, coin-ledger dedupe and
the foreign-attempt guard all read it).

**Repair:**
- `selectOrderPaidPayment()` (`:1097`) resolves one id, strictly:
  explicit `payload.payment.entity` only when order-bound + `captured` + INR + amount-matched;
  `payments[]` objects must not contradict `captured`, must belong to this gateway order, be INR
  and amount-matched when an amount is stated; bare ids carry no status, so a **lone** bare id is
  still accepted (the legacy shape the existing suites pin) while two are ambiguous;
  a flat `payment_id` is a third reference.
  One distinct id resolves; zero is `none` (unchanged `order_paid_missing_payment_id` parking);
  anything else is `ambiguous`.
- An ambiguous `order.paid` parks at `:166-195` as `unmatched_payments.reason =
  "order_paid_payment_id_ambiguous"` with `candidates` + `detail`, and does **not** confirm, debit
  coins, push a KOT or transfer. The claim still completes, so redelivery answers
  `already_processed` instead of re-parking (asserted).
- `:216-221` now uses the resolved id only. `payment.captured` is untouched.

Preserved: webhook signature/idempotency/claim semantics, earlier `order.paid` no-id parking,
`payment.failed` handling, KOT and Route-split dedupe.

---

## RED → GREEN

| Stage | Command | Result |
|---|---|---|
| RED (webhook, 4 suites) | `vitest run tests/refundDisposition … webhook.replay … webhook.reject … payments.route-splits` | **5 failed / 42 passed (47)** |
| RED (refund only, after harness fix) | `vitest run tests/refundDisposition.test.ts` | **2 failed / 5 passed (7)** |
| GREEN (refund only) | same | **7 passed (7)** |
| GREEN (webhook replay) | `vitest run tests/webhook.replay.test.ts` | **26 passed (26)** |
| GREEN (required 4 suites) | see below | **47 passed / 4 files** |

Honest note on the first RED: the refund harness originally returned a live view of the document
map, so the second reader observed the first write and the old check-then-update passed by
accident. The harness now returns an immutable snapshot (like the SDK) and logs each operation
with its transaction depth; only then did the race reproduce. The first RED count is therefore
discarded, not cited as evidence.

New coverage (synthetic fixtures driving the real handlers):

- concurrent rejects: exactly one fulfils, the loser 409s, the winner's reason survives;
- order read + refund write occur inside the same transaction, order after refund read, write last;
- cross-branch caller 403s with the row still `PENDING` and no `disposition`;
- terminal `REJECTED` row keeps its original reason on a second reject;
- multi-attempt `order.paid` (A failed, B captured) records **B** and completes the payout;
- two bare ids → park, order untouched (no CONFIRM, no `razorpayPaymentId`, no transfer, no KOT);
- two `captured` -entries → park;
- explicit payment entity bound to another gateway order → park;
- order-bound + captured + INR + amount-matched explicit entity → used;
- redelivery of a parked event → `already_processed`, order still `pending`.

## Gates (exact)

```
cd .swarm-worktrees/backend-email-contract-20261029/functions
npx --no-install vitest run tests/refundDisposition.test.ts tests/webhook.replay.test.ts tests/webhook.reject.test.ts tests/payments.route-splits.test.ts --maxWorkers=1
  -> Test Files 4 passed (4); Tests 47 passed (47); exit 0

npx --no-install tsc --noEmit
  -> no diagnostics; exit 0
```

Adjacent regression check (not requested, run because both files also drive `order.paid`):

```
npx --no-install vitest run tests/captured-payment-binding.test.ts tests/payment-confirmation-webhook-concurrency.test.ts tests/payment-confirmation-concurrency.test.ts --maxWorkers=1
  -> Test Files 3 passed (3); Tests 47 passed (47)
```

`npm run build`, the full suite and `firebase emulators:exec` were **not** run — the parent
serializes them. This work does not establish a full-suite pass.

## Files touched (hashes are post-change, SHA-256)

| File | Lines | SHA-256 |
|---|---|---|
| `functions/src/modules/payments/refundRequests.ts` | 94 | `83925354bb6323e79edbaefe56533668b159d66b018184b137689ca1047da285` |
| `functions/src/modules/payments/webhookHandler.ts` | 1232 | `0ffed94c83e62c485509a0aebdac47130c38e05fe756726e36805e316485656d` |
| `functions/tests/refundDisposition.test.ts` | — | `dc3c52d75ac227f49e5995e6bf88106063da3708db5d590cc6a3f411609b7a01` |
| `functions/tests/webhook.replay.test.ts` | — | `5d6c09bc039160fd99821396e7987239da0c676fec99b9a171f8f77364e6bf50` |

`webhookHandler.ts` was already `MM` before this pass (staged candidate + unstaged precision
delta), so its diff stat mixes prior work with this change; the regions above are this pass's.
No other file was modified: `pricing.engine.ts` still shows its pre-existing unstaged delta and
was not touched.

Limitation of the transfer assertion: in mock mode a Route receipt does not record the payment id
it was keyed with, so "the payout used B" is evidenced by the recorded
`payment.razorpayPaymentId === "pay_bare…/pay_attempt_b"` (the same value passed to
`executeRouteSplit`), not by a provider-side receipt.

## Deliberately not done

Payment/POS hypotheses observed in the same sources but **not** implemented (they change pricing,
tax or stock policy and belong to the parent's other session):

1. `pricing.engine.ts:348` / `:242` still take `deliveryFee` / `packagingFee` from the request
   body (`validation.ts:61-62`, `index.ts:346-350`), so a client can zero a delivery fee.
2. `orderPush.ts:651` emits the full outlet rate in `tax_percentage` while the tax amounts are
   allocated from the discounted GST base — the two disagree on any discounted basket.
3. `menuSyncWebhook.ts:411-431` merge-sets `inStock` from the vendor feed, so a scheduled menu push
   can resurrect an item the partner 86-ed minutes earlier (`item86ingSync.ts:139-148` keeps no
   monotonic marker to compare).
4. No Reelo billing code exists in `functions/src` (zero matches), so any "no duplicate bills to
   Reelo" claim is unproven here rather than satisfied.
