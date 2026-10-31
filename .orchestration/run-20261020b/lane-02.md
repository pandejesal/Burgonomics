# Lane 02 — Partner app frontend (restaurant operations)

Mission: the partner app must genuinely run restaurant operations: live orders, KDS,
tickets, dispatch queue, menu visibility, settings, payments state, tablet/touch UX.

Owned:
- `burgonomics-partner/src/**` except `src/shared/**` (lane 03),
  `src/features/branches/components/RazorpayRouteAccountCard.tsx` (lane 08), and the
  Petpooja sync services (lane 06).
- Tests colocated with those files.

Do not touch: customer repo, Functions, native dirs, other lanes' exact files.

First actions:
1. Read CONTRACT/BASELINE/LANES; `git status`, `git log -5` in partner repo; preserve
   all dirty files.
2. Walk the operator path with real code: login -> dashboard -> orders -> KDS ->
   order detail -> tickets -> delivery queue -> menu -> settings. Identify one real
   broken/lying state (stale status, wrong totals, silent failure, touch target).
3. Claim exact paths; fix narrowly; add positive/negative tests; request DS then GLM;
   isolated gate; local commit.

Known focus areas: truthful payment/sync status, KDS audio/timer, delivery queue
state, branch scoping, manual-payment policy boundary, Oct-14 dirty work provenance.
Never claim a partner action updated the backend unless a captured response proves it.

Constraints: no live orders/refunds/riders; no vendor writes. Coordinate API changes
with lane 04 before they are needed, not after.
