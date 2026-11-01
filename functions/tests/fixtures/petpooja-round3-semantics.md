# Sandbox resend gate: accepted-round semantics differ from merged runner

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

The merged runner cannot reproduce those semantics unchanged: pickup COD
`collect_cash` is 0, `gst_type:"services"` maps to vendor rather than restaurant,
total excludes vendor-liable GST, and delivery total excludes third-party delivery fees. Case 3 is delivery with
49 delivery fee in the cloud runner, whereas the accepted script used takeaway.
Case 5 cloud runner retains its 40 packaging fee (accepted script used 20).
No financial helper or sandbox override was changed in the real-id fix.
New current wire total / tax_total: case 2 = 340/16, case 3 = 580/29,
case 5 = 320/14. With captured services metadata these all retain vendor
liability, collect_cash 0, enable_delivery 0. Do not represent these as a
reproduction of the approved financial round; reconcile before resending.

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
