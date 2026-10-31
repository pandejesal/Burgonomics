# Home candidate: Martinoz-grounded correction (implementation slice)

Date: 2026-10-29. Worktree: `.swarm-worktrees/delivery-launch-ui-20261028`.
Base: `7affdf6` dirty (integrated UI/notes/awards/auth). Candidate, not team approval.
No assets added, no dependency installed, no reference art copied, no auth/backend/menu/
styles/nav/cart edits. Phone/browser QA remains with the parent.

## Changed files

| File | sha256 (16) | Change |
|---|---|---|
| `src/routes/home.tsx` | `9C6B2634BCD7B91F` | Menu heading + Search in one row below the promo; `Explore Menu` SectionHeader replaced; header no longer receives a search callback |
| `src/features/home/components/BrandHeader.tsx` | `33A9AAAFA7E33305` | Brand strip + unboxed outlet row + 48px mode control; search block removed; wordmark/mascot/notifications unchanged |
| `src/features/home/components/ModeSegmentedSwitch.tsx` | `1D2D7EDE5C1F12CD` | One 48px text row, no icons, same radiogroup/keyboard/roving-tabindex contract |
| `src/features/home/components/BannerCarousel.tsx` | `1C9ACBF294E41EEC` | Slide becomes a short image-led promo (~2.65:1, 132px min); 96px thumbnail and card CTA removed; gestures/autoplay/reduced-motion/dots untouched |
| `src/features/home/components/CategoryGrid.tsx` | `5FFF5EB9D1CE932A` | Photo is the full-bleed tile; stationary label over a bottom scrim outside the flip subtree; 2x2 equal squares |
| `src/features/home/components/martinoz-home.contract.test.tsx` | `ECA8946F0A8CEF95` | NEW structural contract test |
| `src/features/home/components/HomeReadability.test.tsx` | `3BAB24DC30E39632` | One conflicting assertion revised (header search click); all other invariants kept |

`CategoryGrid.css` was **not** changed: the existing flip/backface/reduced-motion rules
already target `.home-shortcut-photo` and still apply to the full-bleed layer.

## What the direction required, and what the code now does

1. Header carries brand, outlet and mode only. Search is not in the header
   (`tests` assert zero search controls above the promo).
2. Outlet row is unboxed (`a[href="/stores"]` no longer carries a `bg-bg-secondary`
   pill), city line above, outlet name below, wraps instead of clipping, `min-h-11`.
3. Mode control: single row, `min-h-12` (48px), text-only segments, green fill for
   the active mode. No icon-over-label, so it cannot double in height.
4. Promo: image fills the slide behind a bottom scrim; `aspect-[2.65/1]` with
   `min-h-[132px]`. Height is a minimum and the ratio is preferred, so 200% text
   grows the slide rather than clipping it (the photo layer is what clips).
5. `Menu` heading and `Search` share one row after the promo; the four shortcuts
   follow. Search is a 44px-target button with an accessible name.
6. Shortcuts: four equal `aspect-square` tiles, photo layer `absolute inset-0`,
   label + "Not listed for this store" in a `pointer-events-none` scrim layer that
   sits outside `.home-shortcut-photo`. Missing Wraps stays disabled with no image.
7. Banners still use real data only; no price or discount is generated anywhere in
   the changed code.

## Verification

```
npx --no-install vitest run src/features/home src/routes/home.scope.test.tsx \
  tests/home-landing.test.ts tests/theme-foundation.contract.test.ts --maxWorkers=1
=> Test Files 15 passed (15) | Tests 96 passed (96) | VITEST_EXIT=0

npx --no-install tsc --noEmit
=> TSC_EXIT=0 | 0 diagnostic lines
```

RED before the fix: the new contract test failed 2/3 (no `[data-testid="banner"]`
in the ready body until the banner fixture existed; header still owned Search) and
`HomeReadability` still encoded the old header-search click. Both were structural
assertions against the new direction, not cosmetic diffs.

Behaviour invariants retained (all still asserted by the existing suites):

- `CategoryGrid.shortcuts`: exactly four labels, first real member ID, no eager
  menuStore fetch, Wraps neutral + disabled, verified photo paths, empty data
  renders nothing.
- `CategoryGrid.motion`: one flip after visibility, per-card stagger, offscreen
  cancel, no background timer, reduced-motion static, both photos required,
  observer cleanup on unmount.
- `BannerCarousel.a11y`: carousel/slide roles, keyboard focus, tablist selection,
  drag-vs-scroll axis rules, `overscrollBehaviorY`/`touchAction` preserved.
- `home.scope`: store/user scoping, no cross-account paint, explicit failure and
  empty states unchanged.
- Theme contract + landing theme tests unchanged.

## Remaining visual validation (not claimed here)

- No browser or device run in this slice. The 390x844 / 360x780 "first category row
  visible without scrolling" check, 200% text growth, real-outlet-name wrapping and
  dark mode are unverified visually.
- Shortcut labels over photography assume the scrim holds >=4.5:1 for white text;
  measured screenshots are needed before this is called accepted.
- The 2.65:1 slide on a 320px viewport computes ~109px and is floored at 132px, so
  the narrowest reference ratio is not reproduced exactly by design.

## Not done

Full build (parent serializes), Playwright comparison, native replay, any visual
restyle outside the five owned files, awards/upcoming changes, or navigation edits.

---

## Second UI pass: nav, rhythm, label flow (before final freeze)

Triggered by the parent's 390x844 screenshot and the 360/320/200% checks.
Reference is the observed native app, not a template.

### Changed

| File | sha256 (16) | Change |
|---|---|---|
| `src/shared/navigation/BottomTabBar.tsx` | `48DD76DCFFB97CCA` | Inset floating bar: `mx-3`-equivalent gutter, 16px radius, solid `bg-surface`, `shadow-medium`, bottom safe-area + 8px. Glass (blur/translucency) and the full-width active indicator line removed; active tab carried by colour + weight. Routes, 44px targets, focus ring and cart badge preserved. Publishes measured `--bottom-nav-height` / `--bottom-nav-offset` (height + 16px) through a `ResizeObserver`, so a rem-grown bar at 200% text keeps the same clearance. |
| `src/shared/layouts/AppShell.tsx` | `30CE82970156AC58` | Content padding only: fixed `72px` becomes `calc(var(--bottom-nav-offset, 86px) + safe-area)`. |
| `src/features/cart/components/FloatingCartBar.tsx` | `E2E1CACCDC039156` | Offset only: `64px + safe + 8px` becomes the same measured variable, removing the 6px overlap with the nav when the cart is non-empty. No cart logic touched. |
| `src/routes/home.tsx` | `DDAB017B6CF3BB6F` | Body rhythm `mt-6 space-y-8` -> `mt-3 space-y-6`. |
| `src/features/home/components/BannerCarousel.tsx` | `228C9A665601E987` | Indicators moved into a reserved 28px band under the poster; buttons keep 44px hit areas that overflow the band invisibly, so nothing overlaps the CTA or the Menu row. |
| `src/features/home/components/CategoryGrid.tsx` | `61C8BC3128DBAF40` | Label layer moved from `absolute inset-x-0 bottom-0` into normal flow (`mt-auto`, `relative z-10`), so it grows instead of clipping at 200%. Scrim padding `pt-12` -> `pt-4`. Unavailable card is solid `bg-bg-secondary` with `text-text-primary` and no "Photo unavailable" claim where no photo was ever expected. |
| `src/routes/auth.otp.tsx` | `0D46FE4B71EDB6B6` | Verify gate is `code.length === OTP_LENGTH && /^\d+$/` instead of length alone, so a holed positional value cannot enable it. |
| `tests/auth.otp-gate.test.tsx` (new) | `58B53EFA03E71922` | Regression: "12 456" (six characters, five digits) keeps Verify disabled; six real digits enables it. Proved red against the old length-only gate (1 failed / 1 passed), then green. |

Conflicting assertions revised, invariants kept: `CategoryGrid.shortcuts` now expects
Wraps **not** to claim "Photo unavailable" and expects the three photo tiles to claim
it after an image error; `martinoz-home.contract` expects white-on-scrim only where a
photo exists and `text-text-primary` on the neutral card.

### Accessibility decisions

- 200% root text: the label is in flow, so the tile grows. The `aspect-square`
  shape is the normal-size appearance, not a clip. This is an explicit exception:
  legibility wins over the square at enlarged text.
- 44px targets: nav tabs `min-h-14`, indicator buttons `h-11 w-11`.
- Contrast: white label only over the photo scrim; the neutral card uses
  `text-text-primary` on `bg-bg-secondary`.
- No motion change: image flip stays bounded, one per visit, static under
  reduced motion, labels stationary.

### Final gates (run separately)

```
npx --no-install vitest run src/features/home src/routes/home.scope.test.tsx \
  tests/home-landing.test.ts tests/theme-foundation.contract.test.ts --maxWorkers=1
=> 15 files passed | 96 tests passed | exit 0

npx --no-install vitest run tests/auth.login.test.ts tests/auth.login.test.tsx \
  tests/auth.bootstrap.test.ts tests/auth-error-copy.integration.test.tsx \
  tests/order-service-auth-isolation.test.ts tests/auth.races.test.ts \
  tests/auth.service.discard.test.ts tests/auth.otp-gate.test.tsx \
  src/features/auth/components/OTPInputGrid.races.test.tsx --maxWorkers=1
=> 9 files passed | 72 tests passed | exit 0

npx --no-install tsc --noEmit
=> exit 0 | 0 diagnostics
```

### Still unverified (parent QA)

- Non-empty cart vs floating nav at 200% text on a device (offset is now measured,
  not assumed).
- 320px Wraps card stack and the 200% label growth in a real browser.
- Dark mode on the new nav surface.
- Full web/mobile build (parent runs once).
