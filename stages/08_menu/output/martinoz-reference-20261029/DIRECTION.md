# Martinoz-grounded Delivery correction — candidate, not team approval

## Evidence used

`home-native.png`, `menu-native.png`, `menu-chooser-native.png`, plus Mobile MCP
native element geometry on the same 1080×2340 / 480dpi phone. Martinoz is the
layout/interaction reference, not an asset or business-data source.

shadcn MCP successfully returned `@shadcn/sheet`, `tabs`, `scroll-area` metadata
and the complete Sheet/Tabs examples. Reuse the existing Radix/shadcn primitives;
do not install a generic dashboard block or replace fulfilment semantics with tabs.

REA calls were interrupted without Evidence. `rea doctor` was run through the
configured local launcher: Node 24.18.0 is below REA's supported 24.22.1 floor;
additional disassembler/global-registration checks are irrelevant to screenshots.
No global runtime/configuration was changed. Mobile captures are not REA captures.

## What was wrong, and the exact correction

1. **Stacked controls obscure food.** The current header has a boxed outlet,
   icon-over-label fulfilment tiles and a separate full-width search before a tall
   template hero. Replace with a compact brand strip, unboxed outlet row, 48px
   single-row mode control, then the short promo. Move Search beside Menu below
   the promo. Preserve notifications, location selection and all mode semantics.
2. **Template hero instead of a food poster.** Replace the small 96px framed
   food thumbnail/ambient gradient/card CTA treatment with a short, image-led
   promo around 2.65:1, 132–148px at normal text sizes. No fixed height that clips
   200% text. Use the actual banner data; never invent prices or discounts.
3. **Square cards are mostly a container.** Like the reference, make the photo
   fill the entire square. Stationary labels sit over a readable bottom scrim,
   outside the image-flip subtree. Four equal 2×2 targets only. Missing Wraps
   remains honestly unavailable, with no invented image/category.
4. **Generic app-shell navigation.** Use the reference's inset floating white/
   black bar with a modest radius, solid surface and restrained shadow. Keep
   Home/Menu/Cart/Profile routes; do not substitute Offers for the user's Menu
   entrance. Hit areas remain at least 44×44 and safe-area/cart offsets cannot
   overlap content or focused controls.

## Keep

White/black canvases; Burgonomics green and sparse orange; Inter for interface
copy; the company's existing display lettering for its wordmark/awards, not body
copy. Awards/Upcoming content, 15 real menu sections and geometric sticky-heading
repairs, empty-Cart reorder and the one order-level cooking note all survive.

Menu keeps the user's continuous-page behaviour even though Martinoz replaces
category pages. Its spacious text-left/image-right product rows and menu chooser
are reference observations, not permission to regress pagination or add flow.

## Acceptance

- At 390×844 and 360×780 the first Home category row is visible without scrolling;
  compare the same screen, not just isolated cards. At 320px no horizontal overflow.
- Exactly four square shortcuts with stationary labels and bounded image-only
  flips; no repeat animation, reduced-motion remains static.
- Search is present in the Menu heading row, not duplicated above the banner.
- Keyboard modes/navigation work; no nested interactive controls; body and control
  text contrast ≥4.5:1, focus/control indication ≥3:1, 200% text remains readable.
- Focused tests, full customer unit/type/web build after source freeze, styled
  Playwright comparisons and an updated native replay before acceptance.

This is a correction to the isolated candidate, not a production deployment or a
claim that the team has approved the replacement screenshots.
