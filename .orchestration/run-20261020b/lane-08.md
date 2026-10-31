# Lane 08 — Razorpay payments

Mission: test-mode payment lifecycle is correct end to end in code: order creation,
signature verification, webhook idempotency/ordering, capture/refund state, Route
split, and honest client states. No real money.

Owned:
- `functions/src/modules/payments/**`, `functions/tests/payments.*`.
- Customer `src/routes/payment.tsx` + its tests.
- Partner `src/features/branches/components/RazorpayRouteAccountCard.tsx` (coordinate
  with lane 02 before touching).

Do not touch: other Functions modules, other app routes, deployment.

First actions:
1. Read CONTRACT/BASELINE/LANES; inspect current payment code and committed fixes
   (intent reuse binding, stale-claim handling, route transfer lease).
2. Identify one real gap with a failing test: duplicate webhook side effects, event
   reordering, expired processing lease recovery, signature failure path, amount/
   currency mismatch, refund idempotency, route account state.
3. Claim exact files; fix; add positive/negative tests; DS then GLM; gate; commit.

Known external blockers: `RAZORPAY_WEBHOOK_SECRET` missing; dashboard error recorded.
Any real webhook/signature test requires the secret — otherwise prove behavior with
locally signed fixtures that match the documented algorithm, and label it LOCAL CODE
VERIFIED, not PROVIDER TEST VERIFIED. Refund/late-transfer pricing policy is a human
decision; do not invent it. Never call live payment/refund APIs, never print keys.

Constraints: test mode only; no money movement; no credential changes/dashboard edits.
