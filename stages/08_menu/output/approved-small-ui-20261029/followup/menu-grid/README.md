# Compact Menu grid — latest owner request

Make Menu **product cards**, not Home category shortcuts, smaller so a normal
phone viewport can show two rows of two products. Preserve continuous categories,
list view, real product data, detail links, favourites, customisation, prices,
availability and 44px Add/quantity controls. Do not shrink type/touch targets or
force fixed clipped heights to obtain a four-card screenshot.

The prior no-Menu-edit constraint is superseded only for this bounded grid-density
change. Home retains its large cards. Grid uses the existing compact floating Cart
variant so a populated basket does not occupy the whole lower product row.

Phone state is live: the latest Menu capture contains a one-item basket; do not
restore the earlier empty basket or infer that the agent created the current item.
Preserve whatever basket is present during the update and verification.

Three final review fixes are carried forward: dark promo contrast, UID-keyed
reorders, and reachable Stores fulfilment choice.

## Completed verification — 30 October 2026

- **148 files / 1,276 tests passed**, typecheck clean. Unit scope excludes
  `tests/rules/**`; no deployed-rules/Firebase release claim follows.
- Web/mobile builds, Capacitor sync, offline debug assembly and APK compatibility
  all passed. All **627 captured inputs** stayed unchanged through the gates and
  phone check. See `build-gates.json` and the frozen-source comparison reports.
- Browser: four complete cards in two rows at **320/360×780 and 390×844**, with
  empty and explicitly local filled sample Carts. Prices, 14px titles and 44px
  Add/stepper targets stay visible. Price/favourite rectangles do not overlap;
  real favourite hit-tests pass. The fixture at 200% root text size reflows to
  one column, with no horizontal overflow, clipped compare price or heart overlap.
- Independent bounded source review found no remaining substantiated issue.
  List markup, catalog flow and Add/customisation handlers remain intact. Only
  seven explicitly authorised Menu source/test paths changed; the rest remain
  protected in `preview-scope-validation.json`.
- Actual-code light/dark Menu snapshots are included in the inert
  [preview](http://127.0.0.1:48244/followup/index.html), alongside Home/Cart.

## Installed phone result

Exact installed `com.burgonomics` SHA-256:

```text
035f65964391ac73f8ab84a5b8daf5a35dcb7f3147422a937f32a61dbb098f1a
```

Updated on `RZCX51TXRKB` using **`adb install -r` only**, after checking the fresh
`d61afb91…` baseline, signer, package, version and bundled assets. First install
remains **27 October 11:32:45**; update time is **30 October 00:17:55**. Pulled
installed bytes and the post-QA hash match the candidate. No uninstall/data clear.

**Four complete Menu cards were visually confirmed on the phone with the current
real one-item basket retained.** Their lower edge is y=1806 physical pixels;
the compact Cart starts at y=1827 and navigation at y=2082. All four prices and
Add/quantity actions are visible. The normal category jump scrolls the retained
kitchen-closed notice above the products. The phone is left on this Menu grid.

Evidence: `phone-results.json`, `phone-identity-final.json`, and the privacy-cropped
`../phone-menu-grid-final.png`. Raw status/notification/system-navigation pixels
were removed before review; owned raw captures were removed after saving.

No basket/favourite mutation, account/store switch, GPS injection, permission
change, payment/provider operation, backend/rules/Partner edit, commit, push or
deployment was performed for this grid slice. This is bounded UI verification,
not user design approval or production/provider acceptance. Earlier limitations
in `../../integration-readiness.md` still apply.
