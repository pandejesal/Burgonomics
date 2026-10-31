# Residual release blockers — source review, 29 October 2026

These are **VERIFIED at source-review level only**, not executed exploits,
provider acceptance or deployed-state findings. The independent reviewer made no
edits, ran no additional tests and contacted no provider. Passing package gates
do not resolve these gaps. The parent re-read the fee and stock write blocks.

Candidate: `.swarm-worktrees/backend-email-contract-20261029`, base `31e82c3`.
Reviewed SHA-256 prefixes: `pricing.engine.ts` `6c2ca3cea9c3`,
`razorpay.service.ts` `f45c0c19057e`, `menuSyncWebhook.ts` `734877205d04`,
`item86ingSync.ts` `ada0ffcc320b`.

## 1. High — fees still accept client authority

`functions/src/modules/payments/pricing.engine.ts:242,274-275,347-348` seeds
packaging from `input.packagingFee` and replaces it only when the branch has a
numeric `packagingFee`. Delivery pricing uses `input.deliveryFee` directly.
The existing-branch/missing-field case does not set `pricingDegraded`.

The reviewer traced the payment-create route through `optionalAuth`, its request
schema and `createPaymentOrder`: these fees enter the server-stamped pricing and
Razorpay amount. Later capture comparisons against that same pricing do not
independently validate the original fee. This is a source trace, not a submitted
payment request. Production branch fields were not inspected.

Counterexample to reproduce hermetically: an otherwise legitimate caller uses
zero delivery/packaging fees for its unpaid delivery order at a branch missing
packaging configuration. The pricing path accepts those amounts even if the
merchant intended nonzero charges.

**BLOCKED:** name the authoritative delivery tariff/zone/threshold and packaging
policy, then replace client authority and test tampering. No tariff, default or
production branch value was invented, and no checkout policy was silently changed.

## 2. Medium, potentially High — tax declaration and discount allocation

The reviewer compared `pricing.engine.ts:406-407` with
`modules/petpooja/orderPush.ts:611-651`: tax amounts are allocated from discounted
GST while line prices remain undiscounted and `tax_percentage` is the sum of the
outlet tax rows. The emitted order discount may be important to how Petpooja
interprets these fields; the provider's recomputation semantics remain unverified.

For the existing 290-price / 50-discount / 11-GST fixture, the declared 5% does
not reproduce 11 from the undiscounted line alone. Outlet rows totalling a rate
other than the engine's 5% add another inconsistency risk. This is not evidence
that a real POS necessarily prints the wrong total.

**BLOCKED:** merchant sandbox evidence for discounted COD/online bills and the
applicable per-item/outlet GST policy. Do not invent an effective rate or flatten
all outlet taxes merely to make local arithmetic agree.

## 3. High — later menu sync can reverse an 86 stock update

`modules/petpooja/menuSyncWebhook.ts:426-448` always merges feed-derived
`inStock`. `modules/petpooja/item86ingSync.ts:134-148` merges stock-event-derived
`inStock` into the same document. Both stamp current timestamps. `pushInStock`
is recorded by menu ingestion but supplies no conflict resolution here.

A stock event setting false followed by a stale menu feed reporting true leaves
true. The reviewer did not inspect the Partner toggle route or measure vendor
cache propagation; therefore the precise Partner-origin sequence is not claimed
as runtime-reproduced. The two backend writer blocks have no source precedence.

**BLOCKED:** decide whether an explicit stock event/local override wins, and how
it may be cleared or expire. Then reproduce the stale-feed sequence and implement
that policy. No availability opt-in was enabled and no production stock was changed.

## Other separately tracked gates

- Partner offline cached-profile UID/role binding and route-policy gaps remain
  unrepaired; server rules remain the data boundary, not a substitute for the fix.
- Storage rules are absent from the inspected configuration.
- Reelo is not implemented; preserve Grill Coins and D31–D33, with no migration
  or duplicate bill export.
- Actual provider, printer, courier, native App Check/FCM and deployment acceptance
  remain separate from local replay and unit results.

None of these findings changes the recorded passing backend/Partner gate results
or turns them into a launch-ready verdict.
