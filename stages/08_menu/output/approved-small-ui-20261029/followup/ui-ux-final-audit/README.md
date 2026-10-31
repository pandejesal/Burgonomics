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
- **Install state:** `33615bd9…` is installed on `RZCX51TXRKB` with `install -r`
  only, verified by pulling the installed bytes back (`phone-install-final.json`);
  first install remains 27 October 11:32:45. No uninstall, data clear or basket
  change. The USB preview route `tcp:48244` is reversed, so the phone can open
  `http://127.0.0.1:48244/followup/index.html`.

## Test-mode build (owner is testing payments)

Because **every `vite build` is a production bundle**, `rzp_test_*` keys are
refused by the guard and by `razorpayAdapter` (`allowsTestKeys()` is false when
`PROD === true`). Test checkout therefore needs a **development-mode bundle**.
Verified with a probe build:

| Build command | `import.meta.env.PROD` | Test key allowed |
|---|---|---|
| `vite build` | `true` | No |
| `vite build --mode development` | `true` | No |
| `NODE_ENV=development vite build --mode development` | `false` | **Yes** |

Built `burgonomics-testmode-debug.apk`
(`760a170ede644150086d89ab40e070bf3b7c7a486cf10ceffb5551f26e36eef3`) with
`NODE_ENV=development`, `VITE_APP_ENV=development` and the existing
`rzp_test_*` publishable key from `functions/.env` (read at build time, never
printed or committed). Serving the bundle and loading it produced **zero console
errors** — the FATAL Razorpay line is gone.

This artifact is explicitly **not release-representative**: a development bundle
also enables the dev-only order-status tick and the tracking screen's “advance
status” control. Do not ship it.

Not installed yet: the phone disconnected immediately before installation, so
`33615bd9…` (release-style) is still on the device. Install `760a170e…` with
`install -r` when it reconnects.



## Why the Razorpay key warning fires

`src/core/config/env.ts:119` asserts on every production/release bundle:

```ts
if (ENV_NAME === "production" || IS_RELEASE_BUILD) {
  if (!rzpKey || rzpKey.startsWith("rzp_test_")) console.error("…TEST key or has no key configured…");
}
```

The QA build is a real `vite build` (`import.meta.env.PROD === true`), so the
assertion always runs. Checked configuration as of 30 October: **no
`VITE_RAZORPAY_KEY_ID` / `VITE_RAZORPAY_KEY` exists** in `Burgonomics/.env`,
`burgonomics-foundation-core/.env`, `.env.production` or `.env.sweep`. The only
occurrence is the placeholder in `.env.example`. So the message is accurate —
it is the “no key configured” branch, not a stale test key.

To clear it, set a **live** publishable key where the build reads it, e.g.
`burgonomics-foundation-core/.env.production`:

```dotenv
VITE_RAZORPAY_KEY_ID=rzp_live_xxxxxxxxxxxxxxxx
```

Then rebuild. A `rzp_test_…` value is refused by design, and the **secret**
(`RAZORPAY_KEY_SECRET`, webhook secret) is server-side and must never use a
`VITE_` prefix. Setting the key only clears the warning; it does not prove
payments work — that needs a real capture test.

## Source control

Delivery worktree `launch/delivery-ui-20261028` is **clean** and pushed to
`origin`, at `d65c36c`:

1. `7673081` — pin tenant and server-owned order fields (+ rules tests).
2. `f819c84` — drop superseded OTP sessions; zero legacy loyalty redemption.
3. `d65c36c` — refresh Home, Menu, Cart and account surfaces.

The root workspace repo also has a docs commit for this work. Its other dirty
files are pre-existing work from other sessions and were not touched.

## Petpooja sandbox — round 3 submitted (31 October 2026)

The 28 October review asked for three payload corrections. The builder already
had them (`total` includes `tax_total`, `collect_cash = total` for COD,
`gst_liability: "restaurant"` with no delivery/packing GST). A dry run confirmed
the numbers before sending.

All five scenarios were resubmitted to `.../V1/save_order` for outlet
Burgonomics DEMO [135148], mapping code `31z58ciw0h`. Every request returned
HTTP 200 and “Your order is saved.”

| Case | Reference | Total incl. GST | GST |
|---|---|---:|---:|
| Items + Tax | `bgx_items_tax_1793423643684` | 598.50 | 28.50 |
| Addons + Tax | `bgx_addons_tax_1793423647086` | 419.00 | 19.00 |
| Variation + Tax | `bgx_variation_tax_1793423647558` | 283.50 | 13.50 |
| Discount + Tax | `bgx_discount_tax_1793423647838` | 252.00 | 12.00 |
| Addon + Variation + Tax | `bgx_addon_variation_tax_1793423648138` | 312.95 | 13.95 |

Log: `petpooja-submit-round3.log`; reply draft: `petpooja-reply-round3.eml.txt`.
The draft has **not** been sent — no mail client was reachable in the
debug-enabled browser. Petpooja still has to confirm the orders and issue
production credentials; nothing here proves live KOT or 86-ing.



## Dashboard verification (31 October 2026)

Read directly from the logged-in dashboards:

- **Petpooja** — all five round-3 orders are present in Order Listing for
  `5439 - Burgonomics DEMO [135148]` with the expected totals (598.50, 419.00,
  283.50, 252.00, 312.95), status “Waiting For Acceptance”. Vendor confirmation
  is the only outstanding step.
- **Razorpay** — the live webhook is already registered and enabled:
  `https://asia-south1-burgonomics-7faa8.cloudfunctions.net/api/payments/webhook`
  (51 events, added 29 Oct). A stale Netlify webhook is also enabled. The account
  is **10% activated and in Test Mode**; live keys cannot be generated until the
  website/app and KYC are approved. Test key: `rzp_test_…` (23 chars).
- **Borzo** — logged in, ₹0 balance. The “Get API token” action is **disabled**:
  Borzo requires registering on their test server and sending at least two test
  orders before they issue a real API token. No token or webhook secret exists
  yet.
- **Backend** — `GET /api/health` returns `{"status":"healthy"}`.

So the remaining payment/partner work is gated by account processes, not by
missing code: Razorpay activation, Borzo test-server onboarding, Petpooja vendor
confirmation.



## Test payment attempt (31 October 2026) — blocked before Razorpay

On the installed test-mode build (`760a170e…`), a real checkout was attempted on
`RZCX51TXRKB` with the signed-in account:

1. Added one item (2 Jr. Hero Burger, ₹109) and opened Checkout.
2. Checkout showed “Checkout price locked” and the address selected.
3. Tapping **Pay ₹164.00 securely** failed with:
   “Couldn’t initiate online payment — We couldn’t save your order, so the
   kitchen never received it.”
4. `ordersService` reports that as `PERSIST_FAILED` — the **client Firestore
   write** of `orders/{id}` failed. A Firestore read confirms **no new order
   document was created** (latest order is `ord_qa_e2e_1793290867250` from
   29 Oct). The Razorpay modal never opened, so no payment was attempted.
5. After the failure the Pay button stopped responding, suggesting the busy flag
   is not cleared on that failure path.

The deployed Firestore rules were read and match the local file, including
`orderCreateInitialStatus` and `orderCreateForbiddenKeys`; the client payload
shape (both uid fields, PLACED status, no forbidden keys) satisfies them on
inspection. The leading suspect is **App Check**: this QA build deliberately
removes the native Firebase initialisation, and Firestore rejects writes when
App Check is enforced for a client that cannot mint a token.

Next step to unblock payment testing: build without the QA manifest overlay (or
register a debug App Check token) so the client can write the order, then repeat
this checkout. This is a QA-build limitation, not evidence about Razorpay itself.



## Evidence files

- `route-results.json` — full per-sample data (latest run)
- `route-*.png` — screenshots per route/width (browser-rendered, sample state)
- `rules-tests.log` — emulator rules suite
- `final-build-gates.json` — typecheck/unit/build results
- `final-unit.log`, `final-typecheck.log`, build logs
- `home-build-gates.json` — the Home-sections gate copied from that slice
