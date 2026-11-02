# Vendor-approved financial semantics restored

`3c2dafc` records an older `bgx2_*_179317392*` submission, not the latest
`bgx_*_179342364*` round. The latest checked-in receipts and preceding dry-run are
under `stages/08_menu/output/approved-small-ui-20261029/followup/ui-ux-final-audit/`:
`petpooja-submit-round3.log` and `petpooja-dryrun.log` (UTF-16).

Latest-round total / tax_total / collect_cash respectively:

| Case | total | tax_total | collect_cash |
| --- | ---: | ---: | ---: |
| items | 598.50 | 28.50 | 598.50 |
| addons | 419.00 | 19.00 | 419.00 |
| variation | 283.50 | 13.50 | 283.50 |
| discount | 252.00 | 12.00 | 252.00 |
| addon + variation | 312.95 | 13.95 | 312.95 |

All five were takeaway, `tax_inclusive:false`, `gst_liability:"restaurant"`,
`enable_delivery:0`. The latest vendor email accepted calculations but rejected
the modifier identifiers. The preceding dry-run is payload evidence, not a
captured live HTTP request body; the submit receipts corroborate its totals.

The shared financial helpers now follow the written vendor instruction:
every item and delivery/packing GST row is restaurant-liable; COD collects
exactly `total`, including pickup; online collects zero. Captured `gst_type`
remains product metadata and cannot alter the wire. The services/restaurant
discrepancy remains a question for Petpooja, not an excuse to change liability.
Production's inclusive prices retain GST without adding it twice; the exclusive
sandbox adds GST.

> **SUPERSEDED 2026-11-02.** Petpooja's binding ruling on our sandbox orders
> (verbatim in `references/petpooja_save_order_api.md` §23) requires the
> delivery/packing charges — and any GST on them — INSIDE `total`, with COD
> `collect_cash` exactly equal to `total`. The "both exclude third-party courier
> fees from restaurant due" statement below, and every `total` figure in this
> note that omits the fee, are historical: the current wire puts the fee in
> `total`. Tax-inclusive lines also now omit `item_tax` and the bottom `Tax`
> block reports no food GST for them. The exclusive sandbox path is unchanged.

New current wire total / tax_total / collect_cash (all enable_delivery 0):
case 2 = 356/16/356, case 3 = 609/29/609, case 5 = 334/14/334.
Case 3 retains the cloud runner's 49 third-party delivery fee outside `total`;
case 5 retains its 40 packaging fee. The new prices/line composition differ from
round3, but the financial rules agree. Cases 1 and 4 exactly reproduce the
accepted financial tuples 598.50/28.50/598.50 and 252/12/252, with restaurant
liability and enable_delivery 0. Dedicated tests pin those tuples.

## Existing tests corrected (no tests removed or skipped)

- `src/modules/petpooja/testRunner.test.ts`: the three `pins every id and price
  in ... to the real push` cases now expect restaurant liability, exclusive
  total including GST, and COD cash equal to total; `carries the order callback,
  restaurant-only total and no third-party merchant cash instruction` renamed
  to assert COD cash and restaurant-only delivery/packing GST rows.
- `tests/petpooja.financial-contract.test.ts`: `courier delivery: fee is in
  delivery_charges and NOT in the restaurant total`; `takeaway is unaffected:
  no delivery in total, nothing to collect` (renamed); `defines both documented
  GST ownership modes without a default` (renamed); `adds only restaurant-liable
  GST when the caller declares EXCLUSIVE prices` (renamed); `sandbox runner
  declares tax_inclusive false and keeps the captured tax rows`.
- `tests/petpooja.service.test.ts`: `correctly maps order details, items, GST
  tax splits, and order types` (delivery/packing GST rows); `declares
  GST-inclusive prices and the included tax split (R4)` (COD cash).
- `tests/petpooja.structural-contract.test.ts`: both app-order and sandbox
  `emits the sample envelope...` cases (COD cash).
- `tests/petpooja.cash-delivery-quote.test.ts`: `binds a valid quote and charges
  its fee` (COD cash excludes the third-party fee, matching total).

Online-zero-cash tests and inclusive-no-double-tax tests remain enforced.

The existing authenticated staging route selects one case already:
`POST /petpooja/testRunner`, JSON `{ "scenarioId": "addons", "branchId": "31z58ciw0h" }`.
Only cases 2, 3, 5, from PowerShell with the staging base URL and staff ID token
already in `$apiBase` and `$idToken` (NOT executed during this task):

```powershell
foreach ($scenario in @('addons', 'variations', 'addon_variation')) {
  Invoke-RestMethod -Method Post -Uri "$apiBase/petpooja/testRunner" -Headers @{ Authorization = "Bearer $idToken" } -ContentType 'application/json' -Body (@{ scenarioId = $scenario; branchId = '31z58ciw0h' } | ConvertTo-Json -Compress)
}
```

Requires non-production staging, mock POS off, sandbox credentials configured,
authoritative outlet mapping, captured menu/tax metadata, and authorized staff.
Supply the staging App Check header too if staging enforces it.
Do not use `scripts/petpooja-sandbox-5scenarios.mjs` for this resend: although it
has `--only`, it owns separate stale scenario definitions, not the updated ones.
