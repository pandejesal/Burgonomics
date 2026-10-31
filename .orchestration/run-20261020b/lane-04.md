# Lane 04 — Backend API, order lifecycle, webhooks

Mission: Functions API is correct, authorized, idempotent, and truthful. Orders,
tickets, customers, and webhook events must have exactly-once effects and clear error
codes.

Owned:
- `functions/src/index.ts` (sole writer of route wiring).
- `functions/src/core/**`, `modules/orders/**`, `modules/tickets/**`,
  `modules/customers/**`, `modules/audit/**`.
- `modules/dispatch/dispatch.webhooks.ts`, `dispatch.router.ts`, `dispatch/index.ts`,
  `dispatch/readiness.ts`.
- Matching tests under `functions/tests/**`.

Do not touch: payments, petpooja, auth/notifications (their lanes), provider adapters
(lanes 09/10), app repos, native dirs.

First actions:
1. Read CONTRACT/BASELINE/LANES; `git status`, `git log -8` in root; do not disturb
   dirty files.
2. Identify one real backend gap with a failing test: e.g. duplicate webhook effect,
   late event rewinding state, authorization gap, wrong status transition, ambiguous
   provider 2xx. Verify existing fixes before redoing them.
3. Claim exact files; fix; add positive/negative tests (race/interleaving where
   relevant); DS then GLM; isolated gate; local commit.

Known focus: dispatch webhook terminality (no rewinds), customer-cancel no auto
re-book, provider-mismatch parking, payment/order idempotency boundaries (coordinate
lane 08), register-token route wiring (lane 07 owns service, you own index.ts hunk).
The FCM register-token ownership fix is a standing claim: authenticated uid only,
foreign/ownerless binding refuses, race-safe. Check whether it is already implemented
before starting.

Constraints: no deploy; no live provider calls; no auth weakening. HTTP 200 alone is
not proof; assert stored state and side-effect counts.
