# Backend contract proof — vendor email 28 Oct 2026 16:01 + PDF p.5/p.6

Authoritative inputs used (local, verified):
- Sanitised intake: `…\Temp\opencode\petpooja-email-contract-20261029\SOURCE-NOTES.md`.
  Vendor reply lines 276–278: `total` includes `tax_total`; example 350 + 17.50 = 367.50;
  COD `collect_cash` equals the order total; GST liability is the restaurant.
- `C:\Users\DELL\Desktop\PETPOOJA API Docs.txt`: wire names `collect_cash` (line 5381),
  item `gst_liability` (5391), `dc_gst_details` / `pc_gst_details` with `gst_liable`
  (5341–5361), `Tax.restaurant_liable_amt` (5500–5532), `tax_inclusive` boolean (5744).
- `C:\Users\DELL\Downloads\API Guide for Placing Orders on Petpooja POS.pdf`
  SHA-256 `b6a59c830185f33e93ab0c405a727ca2bc7dc23d3426ab50ac2fe873f776f247` (9 pages).
  p.5: price 250 / final_price 250 / quantity 2. p.6: final_price =
  “Item Price - Item level discount if any”.

No credential, real outlet id, or order reference is copied into code or these notes.

## 1. Total already contains GST

Producer proof: `functions/src/modules/payments/pricing.engine.ts` computes 5% GST on the
discounted food subtotal and adds GST + fees into the total. `pricing.grandTotal` is therefore
the amount the customer pays and already contains `gst`.

- `Order.total` = serialized stored `grandTotal` verbatim.
- `Order.tax_total` = `Order.tax` = serialized stored `gst`.
- No GST is added a second time anywhere in the formatter. Test asserts `total` is `367.50`
  and explicitly not `385.00`.

Vendor arithmetic covered by the production formatter:
- 350 food + 17.50 GST, no fees → `total 367.50`, `tax_total 17.50`.

## 2. COD cash collection

- `payment_type` remains the documented COD/ONLINE (legacy CASH also maps to COD).
- `collect_cash`:
  - COD: exactly `Order.total` (same serialized string).
  - Prepaid/ONLINE: `0.00` — no second cash request; `total` is unchanged.
- The legacy `orderinfo.Order` mirror references the same object, so no alias can disagree.

## 3. GST liability = restaurant

- Every `OrderItem.details[]` line: `gst_liability: "restaurant"`.
- `item_tax[]` amounts are allocated over (line × outlet tax row) in integer paise with a
  largest-remainder split, so per-line amounts sum exactly to `tax_total` and per-row amounts
  also sum exactly to it.
- `Tax[]`: `tax` and `restaurant_liable_amt` are the same paise-exact row total.
- Legacy `orderinfo.tax_details` is DERIVED from the same rows (previously hardcoded CGST/SGST
  2.5 regardless of outlet or zero-GST order).

## 4. `tax_inclusive`

The item `price`/`final_price` we send is ex-GST (catalog price; the engine adds GST on top),
so each line declares `tax_inclusive: false`. The previous `true` told the POS the item price
already contained the tax, which backs the GST out a second time.

## 5. Fees

The engine charges no GST on delivery/packing/service. Therefore:
- `dc_tax_percentage` / `pc_tax_percentage` = `"0"`;
- `dc_tax_amount` / `pc_tax_amount` / `sc_tax_amount` = `"0.00"` (documented required scalars);
- **no** `dc_gst_details` / `pc_gst_details` arrays are invented: there is no fee tax to split,
  and a rate would be a fabricated liability. Test asserts the keys are absent.

If a future pricing change ever charges fee GST, this contract requires populating those
arrays with the restaurant share; that is an explicit gate, not assumed support.

## 6. `final_price` is a UNIT figure

- `orderPush.ts`: `final_price: money(unit)`; `price: money(unit)`; `quantity` carries the
  multiplier. Vendor tuple reproduced: price 250 / final_price 250 / quantity 2.
- `testRunner.ts`: same unit convention for the pure builder.
- Totals, quantities and add-on emission are unchanged. Add-on price aggregation into `price`
  remains UNKNOWN (missing sample attachment) and was not invented.

## 7. `pricingVersion: "paise-v1"` (future pricing only)

New server-computed pricing returns:
`grandTotal = (brandRoyaltyPaise + branchTransferPaise) / 100`, where the legs are computed from
`foodSubtotalPaise − totalDiscountPaise + packagingPaise + deliveryPaise + gstPaise`.

Proof points from the real engine (Firestore mocked, not handwritten arrays):
| Basket | GST | Grand total | Legs sum |
|---|---|---|---|
| catalog 350 | 17.50 | **367.50** | 36750 paise |
| 350 + coupon 20 | 16.50 | **346.50** | 34650 paise |
| catalog 350.33 | 17.52 | **367.85** | 36785 paise |
| catalog 400 (control) | 20.00 | **420.00** | 42000 paise |

GST basis (5% of discounted food), fee, coupon, loyalty and rounding policies are otherwise
unchanged. `Math.round(taxableFoodAmount * 0.05 * 100)/100` remains the GST law.

## 8. Legacy comparison law (not downgraded)

`repriceOrderForVerification`:
- stored pricing with `pricingVersion === "paise-v1"` → exact paise comparison;
- stored pricing with **no** marker → recompute the OLD law
  `Math.round(rawTaxable + rawFees + gst)` and compare in whole rupees. A legacy order stored as
  368 for this basket still matches; it is not silently rewritten to 367.50;
- any other marker → `422 UNKNOWN_PRICING_VERSION` (fail closed, no guessing).

A legacy order stored at 367.50 (never a legacy outcome) does not match the legacy law.

## 9. Pre-wire refusals (default deny)

The formatter throws before `pushOrderToPetpooja` marks transmission as attempted, so the
failure is classified `pre_send`:
- no stored total; non-finite total; negative total;
- positive total with no stored tax component (zero GST is allowed only when `gst: 0` is present);
- negative tax, or tax greater than total;
- negative delivery/packaging fee or discount;
- no item lines; missing/negative/non-finite unit price; non-integer/zero quantity;
- negative add-on price;
- declared `petpoojaTaxes` with no id, duplicate id, empty array, or invalid/negative rate;
- GST charged with zero-rate rows, zero item value, or no rows.

## 10. Limits that remain open

Hardcoded outlet tax ids 3928/3929 (CGST/SGST 2.5) are still the fallback because nothing writes
`branch.petpoojaTaxes`. Those ids belong to the verified outlet and may be WRONG for another
outlet — this is NOT production-ready and is recorded as an open gate. No fail-closed switch was
added because it would block every KOT until menu sync writes real tax metadata.
