# Reelo investigation — deferred implementation

## Approved boundary

Keep Petpooja POS. Investigate Reelo CRM/marketing support first. Reelo integration, in-app reward redemption and historical loyalty migration are **not committed launch features**. No account operation, customer export, OTP send, balance transfer or provider call is authorised by this handoff.

## Correction to the original premise

The app does not simply delegate loyalty to Petpooja CRM:

- Parent directly read `functions/src/modules/customers/customerCoins.ts:40-83`: balances live at `customers/{uid}.loyaltyPoints` with `coin_transactions` ledger records and transactional updates.
- Parent directly read `functions/src/modules/payments/pricing.engine.ts:381-389`: the pricing engine treats one point as one rupee and caps redemption at 20% of food subtotal, subject to remaining subtotal.
- Worker traced redemption into payment confirmation. Full earning/redemption correctness, concurrency and production balances were not established in this task.

Replacing that authority is a pricing/ledger migration, not merely renaming a CRM provider. Preserve balances/history. Existing rewards may remain only with business approval and passing safety tests. Do not show two incompatible balances or award the same bill twice.

## Public research, not an approved contract

The Phoenix Grove worker inspected Reelo's public Postman documentation:

`https://documenter.getpostman.com/view/14784368/TzzBov5g`

It reported POS-partner endpoints for customer rewards, earn/redeem OTP, bill capture/update, reversals and sale returns, under a vendor/merchant integration model. It also reported a public Reelo claim that Petpooja bills can sync to Reelo. The parent did not independently re-fetch that marketplace page; obtain the exact current official source before relying on it.

Do not use example development/API-gateway hosts from public samples as production endpoints. Public partner documentation does not establish that Burgonomics or this app is entitled to a vendor ID, an API, a migration facility or a particular SLA.

No approved Reelo adapter/contract was found by the worker's current filesystem search. Root Vera search alone could not establish absence because its index was stale and did not cover both app trees.

## Questions for vendor/account verification in the new plan

1. Is Petpooja → Reelo already enabled for the relevant merchant/outlets, and who owns sending each bill? Verify through a scoped, authorised account review, not a marketing claim.
2. Is this app entitled to an approved direct integration? Obtain authentication, production/sandbox hosts, merchant/outlet identifiers, rate limits, event/retry semantics and support contacts without exposing secret values.
3. Can the app read a balance and reserve/redeem rewards safely? Establish OTP/consent, idempotency, failed/ambiguous redemption and cancellation/refund reversal behaviour.
4. Can existing Firebase balances and transaction history be imported, with reconciliation and rollback? A claim about importing Petpooja billing history does not answer this.
5. Which system owns loyalty? Choose one authority before implementation; no silent mirror/cache treated as spendable truth.
6. Confirm data minimisation, retention, marketing consent and privacy disclosures before any customer sync/export.

## Required investigation output

A contract-backed feasibility report distinguishing: Petpooja-to-Reelo marketing sync, direct app access, in-app loyalty, migration support, costs/entitlement, proof gaps and a recommendation. Unknown or unsupported features stay explicitly unavailable. Do not implement an adapter, change pricing or migrate customers merely to make the investigation look complete.
