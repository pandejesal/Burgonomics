# Owner follow-up — implemented and checked

**Latest source:** the owner then requested the promised lower-Home Best sellers
and Make it a meal sections. Their data path is corrected, an owner-approved
UI/UX audit fixed four further issues, and the delivery branch is committed and
pushed. See [Home sections](home-sections/README.md) and the
[final UI/UX audit](ui-ux-final-audit/README.md). Fresh full tests/builds pass
(**150 files / 1,293 tests**; rules **115**); the existing payment-key console
guard remains unresolved, not suppressed or counted as green.

**Last verified installed build:** final-trim `78fcda40…`, updated with `install -r`
at **30 October 05:15:20**, with first install unchanged. The Cart pill and branch
subtitle/control-strip/divider removals were visually verified; native swipe/
rotation acceptance remained incomplete when the owner moved to the Home request.
See [the final-trim report](final-trim/README.md). No phone data was cleared/restored.

**Earlier Menu-grid phone result:** the compact Menu product grid was installed and phone-checked
in build `035f6596…`, with **148 files / 1,276 tests** and web/mobile builds passing.
Four complete cards fit above the retained one-item Cart. See
[the Menu-grid report](menu-grid/README.md). Home cards remain large. The real
phone basket may change externally; preserve whatever is present on reconnection.

**Final review update:** the verification below identifies the `d61afb91…` build.
Three later corrections (dark CTA contrast, reorder account scope and reachable
pickup mode selection) passed focused review in `review-fixes/`. The owner's
compact **Menu product grid** request is tracked in `menu-grid/`; the final trim
is tracked separately above. No later source slice inherits an earlier APK's
passing phone result.

Latest request supersedes shrinking Home shortcuts to fit the first viewport.
Restore large, full-width square shortcuts and enlarge the top banner/wordmark;
let the page scroll naturally while retaining bottom-navigation clearance.
Keep the old continuous Menu layout and the MonstroSolid / Montserrat roles.

Also requested: compact Awards/photo/description spacing; remove branch counters;
no cooking-note editor in an empty Cart (keep real authenticated past reorders);
Home favourites only when populated; truthful initial store loading and radius
filtering; a rounded search focus boundary rather than an inner rectangle.

Owner-authorised implementation stays in the existing isolated Delivery candidate.
No backend/rules/Partner edits, provider operations, commits, pushes or deploys.
No local data clearing or synthetic phone Cart/favourite/history records.

## Earlier `d61afb91…` verification

- **146 files / 1,251 Delivery tests passed**, with typecheck clean. The unit gate
  excludes `tests/rules/**`; deployed rules and release Firebase were not accepted.
- Web/mobile builds, Capacitor sync, offline debug assembly and package/signer/
  version/asset compatibility passed. See `build-gates.json` and the individual logs.
- All **625 captured inputs** remained unchanged through tests, builds and phone
  checks. All **45 Menu files** remain unchanged from the earlier bounded baseline.
- Browser checks passed Dine-in/Delivery at 320/390px, populated/empty/cleared
  favourites, empty Cart, compact awards, counter removal and rounded focus.
  An explicitly simulated **isolated browser** public-outlet position loaded stores
  without Retry and hid all 11 out-of-radius outlets. It was not phone GPS.
- Actual-code light/dark Home and sampled Cart snapshots were regenerated and
  checked for correct themes, local assets, no actions/scripts and no overflow.

Preview: **http://127.0.0.1:48244/followup/index.html**. It is loopback-only and
inert, not an interactive provider demonstration. The sampled filled Cart is not
phone state and must never be restored onto the phone. Native evidence, APKs and private logs are not
served by the preview whitelist.

## Earlier `d61afb91…` installed build and phone checks

Target `RZCX51TXRKB`, package `com.burgonomics`, SHA-256:

```text
d61afb91dff7483c3307ce67306eb9f29e9ca5c60df1a8e07cdc24fc3fc8cd12
```

Installed with **`adb install -r` only**, same package/signer/version code. Update
time: **29 October 2026, 22:34:02**. First-install time remains **27 October 2026,
11:32:45**. Installed bytes were verified again after phone QA. No uninstall,
downgrade, data clear, account change, basket seeding or favourite mutation.

Both **Dine-in and Delivery were visually confirmed after relaunch**: complete
first-banner title, enlarged wordmark/banner, large 477×480 physical-pixel cards,
no empty Wraps shortcut, and the lower row fully clear of navigation after scrolling.
The real populated favourites rail appeared. Empty Cart had no notes editor.
Compact Awards, counter-free horizontal branches (including working pause), and
rounded search focus were checked on the phone.

The native directory loaded without Retry using existing usable location state;
three inspected selection rows had distances within 7 km. This is a bounded
observation, **not an independent full per-store/GPS boundary test**. No phone
coordinates were injected or permissions changed. An existing recents entry named
`Burgonomics DEMO` was observed and left untouched; published/cached outlet
eligibility still needs data-owner validation before production acceptance.

The first pending capture was found to show **Takeaway**, despite its provisional
Dine-in filename. It was not counted as a pass. After two no-op reference taps,
a fresh physical-centre tap selected Dine-in; the corrected cold-launch evidence
then confirmed it. See `phone-results.json` for cases and evidence filenames.
Status/notification areas, address rows, keyboard and search history were removed
or masked **before** image review; owned raw captures were then removed.

## Limits

This is bounded UI verification, **not user design approval or production launch
approval**. Native empty/account-switch favourites and authenticated past-reorder
acceptance were not forced by altering the phone's data or sending OTPs; those
behaviours have unit/isolated-browser coverage. Saved notes/filled-Cart editing
were verified by tests without creating a new phone basket.

Real payment/POS/printer/courier acceptance is still unrun. Native App Check/FCM
are intentionally unavailable in this QA build; real Auth, deployed rules/Storage
and release readiness remain unverified. See `../integration-readiness.md`.

No backend/rules/Partner changes, financial/provider operations, SMS/push,
production writes/deployments, commits or pushes were performed by this task.
The dirty isolated candidate and unrelated user changes remain preserved.
