# 07 — Reelo feasibility: CRM sync is live; app loyalty is not

Decision D19/D20 remains unchanged: **Petpooja stays the POS**. Reelo is the restaurant's **existing CRM/marketing CRM** and, per the outlet owner on 28 October 2026, **Petpooja bills already sync into Reelo for these outlets**. That answers the connector question; it does not answer direct app access, reward authority or historic balance migration. None of those is a launch implementation commitment.

## Owner-reported fact and what it does and does not change

| Statement | Status | Consequence |
|---|---|---|
| "They use Reelo and Petpooja both" | Owner-reported, 28 October 2026 | Two production systems already exist; the app must integrate, not replace |
| "Petpooja bills already sync into Reelo" | **Owner-reported; not independently verified by this session** | Do **not** build a second bill-upload path from the app. One bill producer (Petpooja) is the working assumption until account evidence says otherwise |

This is material progress: the earlier plan treated the connector as unknown. It is still not proof of per-outlet coverage, sales/return handling, duplicate policy or customer matching. Those remain account-side checks, not source-code questions.

## The decision this creates

Because bills already reach Reelo, Reelo is very likely already **awarding loyalty on those bills**. The app also currently holds real `customers/{uid}.loyaltyPoints` balances and a `coin_transactions` ledger. Running both without an explicit owner produces a customer who can be credited twice, or shown two balances that disagree — the "dual-programme operation" row below.

There is no safe default. One authority must be chosen before any loyalty UI ships:

| Option | What it means | Requires |
|---|---|---|
| **A. Reelo owns loyalty** | App reads/redeems Reelo rewards; Firebase Grill Coins frozen, then migrated or retired | Direct API entitlement, balance read, redemption reservation, migration/reconciliation, privacy approval |
| **B. Firebase Grill Coins owns app loyalty** | Keep current ledger; treat Reelo as marketing/CRM only, with POS-driven points suppressed for app orders | Confirmation that Reelo will not double-award; reconciliation rule; clear customer-facing explanation of two programmes |
| **C. Launch with no app loyalty UI** | Show neither balance nor redemption; keep existing balances intact | Product decision only; safest for the current deadline |

**Recommendation for the 12-day window: C, moving to B or A after vendor evidence.** A direct Reelo integration cannot be responsibly built, tested and financially reconciled in the remaining time, and the existing plan already defers it. This is a recommendation, not an approval.

**Decision 28 October 2026:** the release lead accepted C. The launch app ships with **no loyalty balance or redemption UI**; existing Grill Coins balances stay untouched; Reelo keeps receiving Petpooja bills and remains the CRM. Recorded as D31–D33 in [the decision ledger](01-DECISIONS-AND-OWNERSHIP.md). Reelo awarding is owner-configurable, so the remaining control is to ensure one bill cannot credit the customer twice. One financial item is **not** covered by D31–D33: whether new Grill Coins earning stops at launch or continues while the UI is hidden. It is recorded as **OPEN-EARN-1** in [the decision ledger](01-DECISIONS-AND-OWNERSHIP.md) and remains open; this packet does not assume a default.

## Evidence quality

- Direct source: `functions/src/modules/customers/customerCoins.ts:40–83` uses Firebase `customers/{uid}.loyaltyPoints` and `coin_transactions`; `:109–140` starts capture-time redemption logic with a deterministic ledger reference. `functions/src/modules/payments/pricing.engine.ts:381–389` treats one point as ₹1 with the stated subtotal cap. These establish current source authority, not correctness/production balances.
- Exact case-insensitive regex search for `reelo|Reelo` returned no matches in **functions/src**, **Delivery/src**, **Partner/src**, and **shared**. No app-side Reelo adapter exists in those trees. Account-side POS connector configuration is outside this search.
- Reelo's public [Petpooja integration page](https://reelo.io/petpooja) and its 2026 restaurant-tools guide advertise Petpooja compatibility, consistent with the owner's statement. Public marketing is still not a merchant contract, API schema or SLA.
- No Reelo credential, OTP, customer record or provider API was accessed. The owner's statement is recorded as reported, not as this session's observation.

## Feasibility matrix

| Capability | What may be feasible | Missing evidence / decision | Launch treatment |
|---|---|---|---|
| Petpooja → Reelo CRM/marketing sync | **Owner reports this is already live for these outlets** | Per-outlet coverage, consent, bill owner, returns/partial refunds, duplicate policy, costs | Treat as existing; do not duplicate from the app |
| Direct app customer/rewards read | Partner API may expose customer rewards | App/vendor entitlement, merchant/outlet auth, approved sandbox/prod hosts, scope/rate limits/schema, ownership/consent | No UI promises or balance display yet |
| Earn/redeem in app | Vendor partner workflows may support OTP and bill capture | Reservation vs final debit, expired OTP, ambiguous timeout, failed payment, capture/retry identity, returns/reversal and support | Separate post-launch design/financial decision |
| Existing Grill Coins migration | Unknown | Import semantics/history support, units/expiry/value, identity/consent, full reconciliation/rollback, merchant approval | Explicitly not authorised; preserve Firebase ledger |
| Dual-programme operation | Already plausible **today**, not just during migration | One spendable authority, prevent duplicate awards and race conditions, reconcile cancellations/partial refunds | Must be resolved before exposing any balance |

## C1 — Contract/entitlement investigation (4–8 hours; vendor waiting separate)

Owner: integration owner / `phoenix-grove/deepseek-v4.1-flash-1017`, human merchant/finance/privacy owners; NIM route may synthesise the approved evidence after route recovery. Stage 06 + Stage 05 contract comparison. Prerequisites: gate A for investigation; specific read-only account scope before viewing merchant configuration. Read-only owned source: root `functions/src/modules/customers/customerCoins.ts`, `functions/src/modules/payments/pricing.engine.ts`, `functions/src/modules/petpooja/orderPush.ts`, `references/petpooja_pos.md`, Stage 06 contract and packet 05. Fingerprint G-ROOT plus verified reference/source-search coverage; no integration artifact exists. Proposed output: a dated contract/feasibility addendum in this plan's later approved evidence area; no source/price/balance/config edits.

Acceptance requires a vendor/account evidence checklist, each item marked **verified / unsupported / awaiting owner/vendor**, with date/version/provenance and secrets redacted:

1. Merchant subscription/contract, eligible vendor/app ID and named integration/support owner; costs/limits/support hours and sandbox availability.
2. Per-outlet Petpooja/Reelo mapping and proof whether existing POS bills already sync — **owner reports yes for these outlets; obtain dated account-side confirmation and per-outlet scope**; designate **one** bill producer. Do not send the same app sale directly and again through Petpooja.
3. Approved auth/host/API version/schemas; data fields, required identifiers, idempotency and event correlation; capture/update/return/partial refund and out-of-order delivery semantics. A local key is not provider deduplication proof.
4. Customer matching/consent, OTP/marketing triggers and permitted channels; minimisation, retention, opt-out/deletion, legal/privacy owner approval before any export/sync.
5. Direct read/reserve/redeem support and failure/timeout/expiration reconciliation, including failed capture and cancelled/partially refunded bill. Do not trigger a real OTP as a documentation probe.
6. Migration support for Firebase balances **and historical ledger**, units/liabilities/expiry, reconciliation totals, exception handling, shadow verification and rollback. Importing Petpooja bill history does not establish reward-balance import.
7. Decision: keep Firebase Grill Coins authority for launch; if later migrating, define approved single-authority cutover and ability to stop new rewards while preserving balances/history. No spendable parallel mirror.

Commands/verification: repeat scoped `rg -n -i reelo functions/src shared` and separately each verified app `src` if source changed; `Get-FileHash -LiteralPath <approved-public-contract-export> -Algorithm SHA256`; manually review vendor evidence with finance/privacy owner. Any API test command is **not defined/authorised** until hosts/auth/approved sandbox/actions are known. No customer export, production lookup or financial/OTP/provider call is part of C1.

Failure/rollback: leave app/POS/pricing/ledger unchanged, mark unsupported features unavailable, retain a redacted question/answer record. Vendor response delay does not block launch if Reelo remains deferred, but B2's existing Grill Coins safety/approval still does. Do not retask C1 into unapproved implementation to fill idle time.

## Decision after C1

- **Recommended for this release:** retain Petpooja and current approved/verified Firebase rewards; do not add Reelo-dependent UI or migration work to the critical path. Since POS bills already reach Reelo, launch with **no app loyalty balance UI** (option C) until one authority is chosen.
- The live POS-led marketing sync means the app must not publish bills to Reelo again; assess consent, matching and bill ownership with its owner. Avoid new app billing side effects.
- Any direct in-app loyalty or migration proposal needs a new architecture/financial/privacy plan, sandbox evidence and separate implementation approval. Add verified decisions to Stage 06/05 references so future agents cannot infer that “Reelo CRM” meant “replace the POS” or that two reward balances may both be spendable.
