# Delivery UI/UX audit — 30 October 2026

Bounded audit of the customer app's reachable screens, requested by the owner
after the final Home/trim work. It is a code-and-browser review plus phone
install evidence, **not** design approval, provider acceptance or production
readiness.

## Method

- Real application source at 320×844 and 390×844 CSS px, isolated guest browser,
  public Mansi Circle outlet coordinates (not device GPS), reduced motion,
  light and dark.
- 17 routes × 2 widths = **34 samples**: Home, Menu (grid), Search, Cart, Offers,
  Stores, Orders, Profile, Settings, Favourites, Addresses, Sign in, Support,
  About, Privacy, Terms, 404.
- Each sample records page errors, console errors, horizontal page overflow,
  main-landmark count, visible heading order, clipped text, and every visible
  interactive target's size.
- 14-step keyboard tab sweep on Home, focus-outline presence, and a light/dark
  Cart comparison.
- Rules suite run with the Firestore emulator; no production writes.

## Fixes applied

| Finding | Severity | Fix |
|---|---|---|
| Coupon “Apply” label clipped to 44px on a 320px screen | High (unreadable control) | `CouponInput` Apply is now `shrink-0 whitespace-nowrap`; the input yields space instead |
| Store names truncated to one line at 320px, losing the branch identity | Medium | `StoreCard` name wraps to two lines (`line-clamp-2 break-words`) |
| Home had no level-1 heading and promo titles were `h3` before any `h2` | Medium (heading structure) | One visually hidden `h1` on Home; promo titles are `h2`; visual typography unchanged |
| Brand/branch tenant fields and server-owned order fields were not pinned by regression tests | High (security) | Added rules tests 50–56: no self-assigned `branchIds`/`cityIds`/`active`/`isDeleted`, no brand-owner refund-ledger/OTP writes, no direct DELIVERED bypass, workflow updates still allowed |

Rules result: **115 tests / 4 files passed**. Unit result: **150 files / 1,293
tests passed**; typecheck clean; web/mobile builds and offline Android assembly
are recorded in `final-build-gates.json`.

## Accepted / documented exceptions

- **Best-seller product-title links** measure ~22px tall. The product image in
  the same card is a 200px control for the identical destination, which is the
  WCAG 2.5.8 *equivalent control* exception; not changed.
- **Legal links inside sentences** (“Privacy Policy”, “Terms”) are inline text
  links, covered by the *inline* exception.
- **44px aim vs 15px root**: the app scales rem-based controls to roughly
  40–41 CSS px at phone widths. That still clears the **24×24 AA floor**
  (SC 2.5.8); the stricter 44px is the project's aim and is recorded, not
  silently redefined.
- **Menu category chip “Big Bang Series”** truncates with an ellipsis at 320px.
  It is a redundant descriptor; the product name and price are untruncated.
- **Guest-gated routes** (Orders, Settings, Favourites, Addresses) correctly
  redirect to `/auth/login?redirect=…`. Classified as expected, not broken.

## Results after fixes

- Broken/blank pages: **0**
- Horizontal page overflow: **0** instances across 34 samples
- Uncaught page errors: **0**
- Undersized-but-AA-failing targets (&lt;24px, no exception): **0**
- Keyboard: focus outline present on every focused control; no off-screen focus

## Remaining blocker (not fixed here)

Every page logs the existing fail-closed guard:

```text
[burgonomics] FATAL: Production build is using a Razorpay TEST key or has no key configured.
```

That is a **configuration/provider** problem, not a styling bug. The UI audit
does not suppress it, and no payment/provider acceptance is claimed. Until a
live key is configured, this build is not production-ready.

Other unverified areas: authenticated screens behind a real account, checkout/
payment, POS/KOT, courier dispatch, Grill Coins/Reelo data and real-device
gesture acceptance. See `../../integration-readiness.md`.

## Verified artifact and preview

- Final APK `33615bd9e26797f4ddde61fa6f91c9bec5efcacf4047de445976301d5453a576`
  (`burgonomics-final-ui-debug.apk`), package `com.burgonomics`, debug version 1,
  original signer, 179 byte-identical bundled web files. Its source commit is
  `d65c36c`.
- Inert preview rebuilt from that commit: `http://127.0.0.1:48244/followup/index.html`.
  Home is the real Mansi Circle catalogue (no rail fixture); Cart is explicitly
  sampled. The whitelist rejects APKs, private reports and directory listings.
- **Install state:** the phone was online only for the earlier Home build
  `c0448c3234c031cd9a25b68b96f799d5f26ec25533b9660353f1cee19d36499b`
  (installed with `install -r`, first install unchanged). It disconnected before
  this final UI-fix APK could be installed, so the four audit fixes are **not on
  the phone yet**. No `adb reconnect` recovered it: `adb devices` is empty.
  Install `33615bd9…` on reconnection with `install -r` only.

## Source control

Delivery worktree `launch/delivery-ui-20261028` is **clean** and pushed to
`origin`, at `d65c36c`:

1. `7673081` — pin tenant and server-owned order fields (+ rules tests).
2. `f819c84` — drop superseded OTP sessions; zero legacy loyalty redemption.
3. `d65c36c` — refresh Home, Menu, Cart and account surfaces.

The root workspace repo also has a docs commit for this work. Its other dirty
files are pre-existing work from other sessions and were not touched.

## Evidence files

- `route-results.json` — full per-sample data (latest run)
- `route-*.png` — screenshots per route/width (browser-rendered, sample state)
- `rules-tests.log` — emulator rules suite
- `final-build-gates.json` — typecheck/unit/build results
- `final-unit.log`, `final-typecheck.log`, build logs
- `home-build-gates.json` — the Home-sections gate copied from that slice
