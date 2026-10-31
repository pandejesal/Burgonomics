# Backend review repairs — Petpooja KOT + Razorpay webhook

Worktree: `.swarm-worktrees/backend-email-contract-20261029` (HEAD `31e82c3c`, staged combined candidate + unstaged email/precision delta).
Scope: the seven defects from the independent review, repaired in code with hermetic tests. No commit, deploy, provider call, Firebase write, dependency, env, secret, or UI change.

Vendor contract kept unchanged: `total` includes GST (350 + 17.50 = 367.50), COD `collect_cash == total`, restaurant GST liability, `final_price` stays a UNIT figure, `pricingVersion: "paise-v1"`, legacy (no marker) and unknown-marker behaviour preserved.

---

## 1. Tender: real order docs read `payment.method`

- `functions/src/modules/petpooja/orderPush.ts:357` — `order?.paymentMethod ?? order?.payment?.method`. Missing tender refuses `PETPOOJA_PAYMENT_TENDER_UNKNOWN`; unknown tender refuses with the same code (never falls back to `ONLINE`).
- COD/cash → `payment_type: "COD"`, `collect_cash == total`; online methods → `ONLINE`, `0.00`.

Tests (all seed `order.payment.method`):
- `tests/petpooja.email-contract.test.ts:233` missing tender (absent / `{}` / blank) refuses.
- `tests/petpooja.email-contract.test.ts:245` unknown tender (`crypto`) refuses.
- `tests/petpooja.email-contract.test.ts:211` legacy flat `paymentMethod` still resolves when `payment.method` is absent.
- `tests/petpooja.kot-race.test.ts:93`, `tests/petpooja.ambiguous-send.test.ts:212` fixtures now carry `payment: { method: ... }`.

## 2. Total fallback + COD without server pricing

- `orderPush.ts:402-470` — candidate chains now include `order.totals.{grandTotal, taxGst, packingCharge, deliveryFee}` after the server `pricing` fields, before the flat client fields.
- `orderPush.ts:415-420` — a COD order with **no** `pricing` object is refused pre-send with `PETPOOJA_PRICING_MISSING_COD`; client totals never reach `collect_cash`.
- New failure class `pre_send_terminal` (`orderPush.ts:886,906,1132-1157,1676`) parks these as `failed` + `petpoojaPayloadInvalidCode`, **not** `pending_retry`, so the retry worker never re-POSTs and never dead-letters them.

Tests:
- `petpooja.email-contract.test.ts:581` ONLINE order with `totals` only → correct total/tax/cash.
- `petpooja.email-contract.test.ts:604` `totals.packingCharge` / `totals.deliveryFee` map onto the fee scalars.
- `petpooja.email-contract.test.ts:620` COD with `totals` + flat client totals refuses.
- `tests/petpooja.ambiguous-send.test.ts:335` end-to-end: 0 POSTs, `petpoojaStatus: "failed"`, code recorded, no `petpoojaRetryCount`, two scheduler ticks still 0 POSTs.

## 3. Stale Razorpay retries are reprocessable

- `functions/src/modules/payments/webhookHandler.ts:69-77` — the 15-minute `created_at` gate is gone. It ran **before** the idempotency claim and answered 401 (terminal for Razorpay), permanently discarding legitimate retries of real money. The event-id claim is now the only dedupe: `done` → 200 `already_processed`, stale-claim takeover → reprocess.

Tests:
- `tests/webhook.replay.test.ts:421` — first delivery 500s after the claim (`completedAt: null`), the **same** event is redelivered 20 minutes later with the same stale `created_at` → 200, order confirmed, claim completed; a third delivery → `already_processed`.
- `tests/webhook.reject.test.ts:167` — a one-hour-old first delivery is no longer 401'd; it is claimed (this harness has no transaction seam, so the confirm itself fails closed).

## 4. `order.paid` never transfers against the order id

- `webhookHandler.ts:564-569` — transfer key is resolved strictly: for `order.paid` only `payments[]` / `payment_id` / `payment.entity.id` count; the order entity's own id is never used.
- `webhookHandler.ts:570-608` — when no payment id resolves, the transfer is **skipped**, a high-severity snapshot is raised, and the delivery is parked in `unmatched_payments` with reason `order_paid_missing_payment_id`. The coin debit and KOT push still run (the payment itself is confirmed).

Test: `tests/webhook.replay.test.ts:463` — 200, park doc asserted, no `payment.routeTransfer` receipt (a transfer POST stamps `trf_mock_*`), `routeTransferStatus` untouched, the order id never recorded as the payment id.

## 5. Add-on reconciliation and add-on tax weight

- `orderPush.ts:516-558` — each line's value is `(unit + Σ add-ons) × qty` in integer paise.
- `orderPush.ts:561-582` — if `pricing.foodSubtotal` is present it must equal the summed line values, paise-exact, or the push refuses `PETPOOJA_ADDON_RECONCILIATION_MISMATCH`. Absent `foodSubtotal` = legacy pricing object, nothing truthful to compare against, so it is skipped.
- `orderPush.ts:590-591` — per-line tax weight is that same add-on-inclusive value.

Tests:
- `petpooja.email-contract.test.ts:372` fixture corrected (was 380 unit + 30 + 40 add-ons = 450 against a declared 419/489 basket); now 330 + 30 + 40 = 400 food subtotal, 20 GST, 20 packing, 440 total, with a wire-level conservation assertion.
- `petpooja.email-contract.test.ts:424` equal line *values* (100 + 300 add-on vs 400) receive equal tax (10.00 each) — unit-price-only weighting would give 4.00/16.00.
- `petpooja.email-contract.test.ts:456` lines summing 450 against `foodSubtotal: 419` refuse.

## 6. Outlet tax rows: no silent 3928/3929

- `orderPush.ts:96-227` — `outletTaxes(branch, resId)`:
  1. `branch.petpoojaTaxes` (validated) with `petpoojaTaxesRestId` provenance; rows captured for another outlet refuse `PETPOOJA_TAXES_OUTLET_MISMATCH`.
  2. Demo rows only behind `branch.petpoojaTaxFallback = { enabled: true, restId, capturedAt }`; requires `restId === branch.petpoojaStoreId === resId` and a parseable `capturedAt`, else refuses.
  3. Otherwise refuses pre-send `PETPOOJA_OUTLET_TAXES_UNKNOWN`.
- `functions/src/modules/petpooja/menuSyncWebhook.ts:624` `extractVendorTaxRows()` reads `taxes[]` (`id|taxid|tax_id`, `name|taxname|tax_name|title`, `rate|tax_percentage|tax_percent|taxrate|percentage`), skipping id-less/invalid rows.
- `menuSyncWebhook.ts:531-548` persists `petpoojaTaxes`, `petpoojaTaxesRestId`, `petpoojaTaxesCapturedAt` on the branch when the body carries rows; a body without `taxes[]` leaves captured rows untouched.

Tests:
- `tests/petpooja.menu-fetch.test.ts:522` vendor `taxes[]` persisted with provenance, unrepresentable rows skipped.
- `tests/petpooja.menu-fetch.test.ts:547` later body without `taxes[]` does not erase captured rows.
- `petpooja.email-contract.test.ts:640-731` no rows and no opt-in refuses; matching opt-in applies 3928/3929; mismatched provenance refuses (both directions); not-enabled / missing `restId` / missing `capturedAt` refuse; declared rows with a foreign `petpoojaTaxesRestId` refuse.
- Fixtures that push now declare their outlet rows: `petpooja.kot-race.test.ts:79`, `petpooja.ambiguous-send.test.ts:242`, `petpooja.service.test.ts:108,169`.

**Operational prerequisite (must be reported as an open gate):** every live branch must either receive a menu push carrying `taxes[]` or be explicitly opted in to the demo rows. Until then, KOT pushes for that branch refuse pre-send with `PETPOOJA_OUTLET_TAXES_UNKNOWN` — deliberately fail-closed rather than borrowing another restaurant's tax liability.

## 7. Parity conservation assertion

- `tests/pricing.parity.test.ts:126` — for all 20 baskets: `grandTotal` in paise equals `taxable + packaging + delivery + GST` in paise. This is not tautological: the previous assertion compared `grandTotal` with the Route legs, and `grandTotal` is now *derived* from those legs. The split identity is kept as a second assertion.
- `tests/pricing.parity.test.ts:243` — golden basket pinned to 916 + 15 + 35 + 45.80 = 1011.80 paise-exact.
- `tests/pricing.parity.test.ts:188` — negative-coupon basket pinned to 99 + 15 + GST.

---

## Red → green

Red proof was produced mechanically: the pre-repair (staged index) `orderPush.ts` and `webhookHandler.ts` were restored into the worktree, the four affected suites were run, then my versions were restored.

| State | Suites | Result |
| --- | --- | --- |
| Pre-repair sources | email-contract, ambiguous-send, webhook.replay, webhook.reject | **4 files failed — 43 failed / 54 passed (97)** |
| Post-repair sources | same four suites | **4 files passed — 97 passed (97)** |
| Full suite, before any repair | 86 files | **2 files failed — 24 failed / 1092 passed (1118)** |
| Full suite, after repair | 86 files | **85 passed / 1 skipped — 1134 passed / 2 skipped (1136)** |

## Gates (run in `functions/`, this worktree)

| Command | Exit | Output |
| --- | --- | --- |
| `npx --no-install tsc --noEmit` | **0** | no diagnostics |
| `npx --no-install vitest run --maxWorkers=1` | **0** | Test Files 85 passed \| 1 skipped (86); Tests 1134 passed \| 2 skipped (1136) |
| `npm run build` (`tsc`) | **0** | no diagnostics |
| `git diff --check` | **0** | no whitespace errors |

`npm run build` emits only to the git-ignored `lib/`; no build artefacts entered the tree.

## Deliberately not done

- No commit, push, deploy, `firebase deploy`, live Petpooja/Razorpay call, or Firestore write.
- `final_price` kept as the UNIT figure (vendor PDF p.5/p.6); no revert.
- No change to `pricing.engine.ts`, `testRunner.ts` or `e2e.flow.test.ts` — their unstaged deltas were already in the tree before this repair and were left as found.
- No new branch field written by anything other than the menu webhook; the demo opt-in is read-only for this relay and must be set deliberately per branch.
- Did not touch `playwright-report`, the root checkout, Delivery/Partner UI, dependencies, env or secrets.

## Remaining external gates

1. **Live Petpooja sandbox confirmation (external, not run here):** unit `final_price` at `quantity > 1`, the outlet `taxes[]` ids captured from a real menu push, and the `collect_cash`/`total` pair for one COD order. No live POS call was made.
2. **Operational prerequisite:** per-branch `petpoojaTaxes` (or opt-in) must exist before KOTs for that branch will transmit — see item 6.
3. **Razorpay retry behaviour:** the 500 → retry-after-20-minutes path is proven against the handler and a mocked datastore, not against a live provider retry schedule.
4. The two behaviour changes are contract changes for operations: a `failed` (not `pending_retry`) KOT row for bad order data, and `unmatched_payments.reason = "order_paid_missing_payment_id"`. Both need a documented ops response before release.
