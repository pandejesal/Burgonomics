# Restore the promised lower-Home sections — 30 October 2026

The owner checked the installed final-trim build `78fcda40…` and explicitly asked
for the promised Home from “On the menu” downward, including Best sellers and
Make it a meal, before backend/integration work. This authorises the bounded
Home data/composition fix, not a new header, Menu redesign or provider operation.

## Root cause and implementation boundary

The route already renders both rails when supplied. Home reads bestsellers by
`products.branchId` plus one legacy flag and meals from a separate `combos`
collection; the working customer Menu reads normalized `products.restId` data.
Use one full, verified selected-store catalog for Home categories and both rails.
Do not truncate meal selection to the first page, query another store or invent
products/prices/stock/savings. Prefer real bestseller signals, then the specific
food picks shown in the owner-referenced proposal when actually present and in
stock. This is editorial merchandising, not a verified sales ranking; do not add
fake Bestseller badges. Meal cards open their actual product IDs, not a guessed
`prd_` prefix, and use compare-at savings only when supplied by the catalog.

Keep the accepted large Home shortcuts, header/promo, typography, compact Menu,
conditional real favourites, awards, branch trim and Cart protections. Loading,
empty, failure, offline, account/store scoping, 44px actions, keyboard focus and
wrapping copy remain required. No reordered history on Home, phone basket seeding,
account/Grill Coins/Reelo operations, backend/rules/Partner changes, financial or
provider operations, commits, pushes or deployments. Phone control is paused
while the owner uses the device.

## Verification plan

1. Reproduce the missing-rail and meal-navigation defects with hermetic tests.
2. Add the canonical catalog/data selection path; retain real-store error states.
3. Verify route section order, card actions and actual-code light/dark rendering.
4. Run typecheck, full unit gate and web/mobile/debug build for this exact source.
5. Treat the installed `78fcda40…` APK as the preceding build, not this new fix.

The two pending regression edits already found in this dirty candidate are
preserved: `homeService.merchandising.test.ts` and the numeric meal-ID test in
`HomeReadability.test.tsx`. `delivery-source-home-sections-before.json` records
the starting inputs. No prior build's tests or native evidence cover new source.

## Implemented and bounded checks

- `listHomeCatalog` reads one complete, verified `restId` scope and returns its
  categories and normalized products together. Unlinked/failing stores fail closed.
- Home now derives both rails from that snapshot, preferring genuine bestseller
  signals before the proposal's six existing in-stock product picks. Real meal
  products lead other combo-category bundles; only real compare-at prices create
  savings. Product IDs, prices, images and availability are never supplied by the
  editorial name list. Customizable bestseller Add opens its options instead of
  silently adding a base item, and numeric meal IDs open their actual product.
- Initial RED reproduced **12 failures** across the missing rails/new catalog API,
  heading, configurable Add and meal navigation. Catalog GREEN: **3 files / 23
  tests**; aggregate/scope GREEN: **4 / 19**; route/card GREEN: **4 / 23**. Meal-first
  ordering was separately reproduced and its seven-test suite then passed.
- The initial `source-scope.json` permits six product files and six test files.
  The full run then exposed a missing `useNavigate` export in an older dietary
  test mock. Adding that one fixture export preserves every dietary assertion;
  its focused **15 tests passed**. `source-scope-final.json` records **six product
  files and seven test files** versus the installed final-trim capture, with no
  product changes since browser checks. Menu UI, Cart, the branch trim and all
  other captured inputs stay unchanged. Frozen revision-two source: **629 inputs**.
- Actual Mansi Circle guest-browser observations cover light/dark, 320/390px and
  Delivery/Dine-in: **six product picks and five meal/combo products** match its
  actual 56-product catalog, with correct order, 44px Add targets and no page
  overflow. A real meal opens its actual detail page without changing the empty
  isolated browser Cart. No Home rail fixture was inserted.
- **The strict runtime gate is still FAIL**, solely for the existing fail-closed
  Razorpay test/missing-key console guard. It was not silenced or configured away.
  `scoped-ui-assessment.json` records the narrower successful UI observations, not
  clean-console, payment, provider or production acceptance. The initial report
  and an invalidated hot-reload state-read attempt are retained; the fresh owned
  QA-server run in `verified-source/` resolves the state-read issue and retains
  the same payment blocker.
- The exporter no longer seeds Home rails. Actual Gota Home/Menu plus an explicitly
  isolated sample Cart were exported, with the preview scope/inertness checks
  passing. `inert-section-results.json` verifies both rails' prices are clear of
  navigation when centred, at 320/390px in light/dark; safe screenshots use the
  `static-*.png` prefix. This is an inert preview, not a phone/provider test.
- Parent-only bounded source review found no further substantiated issue; this
  is not independent review or merge approval. The first full gate stopped at
  **149 passed / 1 failed file, 1,289 passed / 3 failed tests** because of the mock
  export above. Its log and `build-gates.json` remain failed; no tests were skipped
  or removed to get green. The revision-two typecheck passed; its full forks run
  then stopped with **1,290 passed / 2 timed-out tests** in the unchanged Menu
  suite. All **15 Menu tests** passed unchanged in isolation. Both failed full
  logs are retained. `build-gates-r3.json` is rerunning all 150 files with the
  documented threads pool, **per-file isolation still enabled**, one worker and
  the original 5,000ms timeout. No assertions, timeouts or test counts were reduced.
  The unchanged-source typecheck log is reused, not silently rerun or replaced.

The last installed APK remains `78fcda40…`; the Home correction needs its own new
artifact identity and fresh-phone compatibility check. Do not present these source
changes or preview exports as already installed or owner-approved.

The phone subsequently reconnected. `phone-identity-before.json` records a fresh
pull matching the expected installed `78fcda40…` baseline and the unchanged first
install. This was limited to APK bytes/package metadata: no app-data read or UI
action. Installation still waits for the full clean gate and new artifact; recheck
the phone APK immediately before any update. No remote device was allocated.
