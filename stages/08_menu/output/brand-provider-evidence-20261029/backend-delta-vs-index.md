# Backend delta vs staged input (INDEX)

HEAD: `31e82c3c415757064e3b33010ade4d2b0d8ebd6f`
Measure: **working tree vs index only**. The parent-owned staged combined backend baseline
(23 files) is preserved as received; nothing in it was edited by this task.

## Delta summary

- 6 modified-unstaged files
- 2 untracked (new) files, deliberately **not** `git add`ed
- Total: **8 files**

## Modified (on top of the index)

| File | SHA-256 |
|---|---|
| `functions/src/modules/payments/pricing.engine.ts` | `6C2CA3CEA9C311F3B9632D4AF71BD6ABA45A0FDE9ED3403E2D3583F6749B7F39` |
| `functions/src/modules/petpooja/orderPush.ts` | `52EA39C65BFED8B0D0F70B26884AA867A8D3D604D5323F696FDA6FF54A2B70D0` |
| `functions/src/modules/petpooja/testRunner.ts` | `0AC6A75B4BA82A0123F56ABBF2C05BE16981200762145B6EC77E823097CD839A` |
| `functions/tests/e2e.flow.test.ts` | `2FE313098AD573C76A14906A78ADC0B73CCF8E840CD87A7CD99281142DF83D41` |
| `functions/tests/petpooja.service.test.ts` | `ECBB56BED7155657B4B7EDBF2B8A140AE5A30C95ACED3C785C6AB1A4F405B682` |
| `functions/tests/pricing.parity.test.ts` | `162DE571A3A540D13CE4C048527DE9D65AFA0672D7CC2E0378DB455BEA67C90B` |

## New (untracked)

| File | SHA-256 |
|---|---|
| `functions/tests/petpooja.email-contract.test.ts` | `D066E9BA627C1F3B7CD06B15B53159BD87FFFCAE2E064A98AD3586BE69C533DB` |
| `functions/tests/pricing.email-rounding.test.ts` | `9A8EF1192BB5D905640B45CE18BF5D93388F7670B74B1B5533842DBD339F312C` |

## Verified untouched by this delta

| File | Evidence |
|---|---|
| `functions/src/modules/payments/razorpay.service.ts` | SHA-256 `F45C0C19057EFFBC9C48CA172B7A6FCD2A775585E4AD564B2E1E047C88F93617` (recorded before the pause; no write after) |
| `functions/src/modules/payments/webhookHandler.ts` | Not in `git diff --name-only`; inspected read-only. Binds against the STORED `pricing.grandTotal` / intent amount, so legacy captures are unaffected |
| `functions/src/modules/petpooja/menuSyncWebhook.ts` | Not in delta |
| `functions/src/modules/dispatch/*`, `petpooja.scheduler.ts`, `item86ingSync.ts`, `orders/orderStatus.ts`, `index.ts` | Staged baseline only; not modified by this task |
| `playwright-report/` | **Not touched after the incident below; state left for the parent** |

## Per-file purpose

1. `pricing.engine.ts` — grand total derived from the exact integer-paise components whose
   royalty + branch legs sum; stamps `pricingVersion: "paise-v1"`; reprice selects exact-paise for
   marked pricing, recomputed legacy whole-INR law for unmarked pricing, and fails closed
   (`422 UNKNOWN_PRICING_VERSION`) for any other marker.
2. `orderPush.ts` — email contract representation: `tax_inclusive:false`, `collect_cash`,
   restaurant liability with paise-exact row allocation, derived legacy `tax_details`, coupon +
   loyalty discount total, zero fee-tax scalars, declared-outlet-row validation, pre-send refusal
   on unrepresentable money, and **unit `final_price`**.
3. `testRunner.ts` — same money contract for the pure sandbox builder (COD `collect_cash`,
   paise-exact CGST/SGST, zero fee-tax scalars, unit `final_price`).
4. `petpooja.email-contract.test.ts` — new focused suite (34 tests) importing the production
   formatter and the pure runner builder.
5. `pricing.email-rounding.test.ts` — new focused engine suite (9 tests), RED then GREEN.
6. `petpooja.service.test.ts` — qty-2 `final_price` pin 498 → 249; four payload-incomplete
   fixtures given explicit pricing, each with an inline reason.
7. `pricing.parity.test.ts` — whole-INR pins at lines 126/175/218 replaced with the
   split-conservation property; all other invariants retained.
8. `e2e.flow.test.ts` — 577 → 576.85 and split conservation for the 497 + fees + 24.85 basket.

## Not in the delta

`functions/dist` (gitignored build output), `%TEMP%` artifacts, and every file of the delivery UI /
Partner work. No commit, no push, no stage operation.
