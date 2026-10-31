# Backend and payment status after review repairs — 29 October 2026

Read this with `backend-review-repairs.md`, `backend-gate-log.md` and
`backend-open-gates.md`. This file is the plain-language status, not a second copy
of the evidence.

## What was wrong behind the earlier green tests

The independent review found the first patch was green on tests that invented the
production order shape. Concrete failures:

1. Cash orders were serialized to Petpooja as `ONLINE` with `collect_cash: 0.00`,
   because the code read a field no backend path writes.
2. The Razorpay webhook rejected any event older than 15 minutes **before** checking
   its idempotency claim, so a valid retry after a transient 500 was lost for good.
3. `order.paid` without a payment id fell back to the **order** id and posted
   `payments.transfer(order_…)`.
4. Add-on value was excluded from line totals and per-line tax weights; a fixture
   accepted lines summing ₹489 against a declared ₹419.
5. Tax rows `3928/3929` were applied to every branch, and nothing wrote per-branch
   tax rows.
6. The parity suite's total assertion was true by construction.

## What is now implemented

- Tender comes from `order.paymentMethod ?? order.payment?.method`. Unknown or
  missing tender refuses pre-send instead of defaulting to online. COD/cash sends
  `COD` and `collect_cash` equal to `total`.
- Totals fall back through `pricing.*` then `totals.*`. COD without server pricing
  is refused pre-send (`pre_send_terminal`, parked `failed`, never `pending_retry`
  or dead-letter).
- The webhook resolves the idempotency claim before any age logic; the pre-claim
  15-minute 401 is gone. A 500 can be retried later; a completed event still 200s.
- `order.paid` with no payment id parks in `unmatched_payments`
  (`order_paid_missing_payment_id`) and never posts a transfer.
- Every line is reconciled against `pricing.foodSubtotal` in paise, including
  add-ons × quantity; per-line tax weights include add-on value.
- Tax rows come from `branches.petpoojaTaxes`, written from the vendor menu push;
  an explicit opt-in fallback records its provenance; otherwise the KOT refuses.
- The parity suite asserts `grandTotal == taxable + packaging + delivery + GST`
  paise-exact for every basket.

## Gates (in `functions/`)

| Gate | Result |
|---|---|
| `npx --no-install tsc --noEmit` | exit 0 |
| `npx --no-install vitest run --maxWorkers=1` | exit 0, **85 passed / 1 skipped files**, **1134 passed / 2 skipped tests** |
| `npm run build` | exit 0 |
| `git diff --check` | exit 0 |
| Red→green | pre-repair sources produced **43 failed / 54 passed** in the four affected suites; repaired sources **97 passed** |

The two skips are the pre-existing live Borzo wire probes, not enabled.

## What is NOT done, and cannot be claimed

- **No live Petpooja call.** Unit `final_price` at quantity > 1, real outlet
  `taxes[]` ids and a COD `collect_cash`/`total` pair still need one merchant
  sandbox run. The owner PDF documents unit `final_price`; runtime confirmation
  does not exist yet.
- **Operational prerequisite:** every live branch must receive a menu push with
  `taxes[]`, or be explicitly opted in to the demo rows. Until then its KOT pushes
  refuse with `PETPOOJA_OUTLET_TAXES_UNKNOWN`. That is deliberate fail-closed
  behaviour, not a bug.
- **Ops must define a response** for two new states: terminal `failed` KOT rows
  from bad order data, and `unmatched_payments` with
  `order_paid_missing_payment_id`.
- **Razorpay merchant acceptance** (live keys, webhook registration, Route
  accounts, refund policy) is external. No keys, secrets or live payment were used.
- **No deployment.** The patch lives only in
  `.swarm-worktrees/backend-email-contract-20261029` at `31e82c3c…`; nothing is
  committed, pushed or deployed.

## Honest verdict

The payment/POS code is materially safer and internally consistent, and the
previously false "done" claims are now backed by tests that use the real order
shape. It is **not** production-accepted until the sandbox run, branch tax data and
ops procedures above exist.
