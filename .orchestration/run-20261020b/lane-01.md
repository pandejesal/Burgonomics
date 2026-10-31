# Lane 01 — Customer app frontend (delivery/takeaway)

Mission: the customer app must genuinely work: browse menu, cart, checkout, pay,
place an order, track it, recover from errors, manage account/addresses/favorites.

Owned:
- `burgonomics-foundation-core/src/routes/**` except `payment.tsx` (lane 08).
- Customer-specific `src/features/**`, services, hooks not under `src/shared/**`.
- Tests colocated with those files, plus customer `tests/**` that are not shared
  design-system tests.

Do not touch: `src/shared/**` (lane 03), `src/routes/payment.tsx`, partner repo,
native dirs, Functions.

First actions:
1. Read CONTRACT, BASELINE, LANES; run `git status` and `git log -5` in the customer
   repo; record the real HEAD.
2. Inventory the customer journey against the actual code: menu -> cart -> checkout ->
   payment -> confirmation -> tracking -> history. Find the highest-impact real defect
   or broken state transition with a reproducible test (route test or Playwright).
3. Claim the exact files on `fresh-run-2-ownership`, then implement one narrow fix.
4. Request DS review, then GLM, then isolate-gate and commit.

Known focus areas from history: orders-list race (already fixed and committed
earlier — verify it survived), tracking truthfulness, guest/account flows, empty and
offline states, double-submit prevention. Do not re-fix already committed work;
verify first, then move to the next real gap.

Constraints: no API contract invention; coordinate menu/pricing changes with lanes
03/04/08. No live payments. E2E claims require a real built app or browser against a
stated backend, otherwise label LOCAL CODE VERIFIED only.
