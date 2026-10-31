# Final review corrections — addressed, carried into Menu-grid build

The first follow-up build (`d61afb91…`) passed its bounded phone checks. Final
independent review then found three gaps requiring another source/build gate:

1. Keep dark-mode promo CTA text dark on its fixed white badge.
2. Key the empty-Cart reorder rail by account UID so already-loaded history cannot
   appear in a different account's first commit.
3. Expose the existing fulfilment switch on Stores: a first-time customer outside
   delivery radius must still be able to explicitly choose eligible pickup.

No new phone records, provider operations, production writes, or backend/Partner
edits are authorised. Prior follow-up reports remain historical evidence for their
exact APK, not acceptance of these later sources. A further update must reconcile
the installed `d61afb91…` baseline and preserve app data.

Independent recheck cleared all three findings: **3 files / 40 tests passed**.
Runtime browser checks measured promo-badge contrast at **16.67:1 light** and
**18.76:1 dark** (conservative black/white image backdrops), above 4.5:1.
The 20 km isolated-browser entry case passed Takeaway and Dine-in selection while
leaving `activeStore` null and Cart empty. No provider writes or phone GPS changes.

The owner then requested compact Menu grid items. These review corrections are
included in the next combined source freeze; complete gates/build/phone results
are tracked in `../menu-grid/`, not inferred from the old APK.
