# R25 — Read-Only Device Menu UX Review (menu products only)

Scope: visual-density / product-truncation / CTA-legibility / sticky-rail / state-affordances judged ONLY from the six allowed screenshots. No other device images, env, or private info inspected. No code edits, tests, browser, adb, or provider actions taken.

Allowed evidence set (all under `audit-results/device/`):
- `readiness-menu-before.png` (Combos, list/row, 4 items)
- `readiness-menu-right-clean.png` (Combos, list/row, 4 items)
- `readiness-menu-swipe-left.png` (Big Bang Burgers, list/row, 6 items)
- `readiness-menu-grid.png` (Combos, 2-col grid, top of list)
- `readiness-grid-swipe-left.png` (Big Bang Burgers, 2-col grid, top of list)
- `readiness-menu-vertical.png` (Big Bang Burgers, 2-col grid, scrolled)

Note: images predate latest source fixes. Source refs below describe what the CURRENT source already does about each symptom; screenshots show the older rendering the fix addresses. Model: zero-priced contributor-free endpoint (no paid fallback used).

Cross-sourced (read-only): `burgonomics-foundation-core/src/features/menu/components/MenuProductCard.tsx`, `burgonomics-foundation-core/src/features/menu/components/CategoryNavRail.tsx`, `burgonomics-foundation-core/src/routes/menu.index.tsx`.

---

## F1 — Row-layout product title truncation

- Evidence: `readiness-menu-before.png` + `readiness-menu-right-clean.png` row 2 shows "Any Big Bang Burg…"; row 3 shows "Any Classic Burger …". `readiness-menu-swipe-left.png` row 2 shows "Cheese Burst Burg…". Row 1 titles ("2 Jr. Hero Burger", "American Burger", "Gochuchang Burger", "Great Indian Burger") fit. Descriptions ("Big Bang Burger + Fries + Coke") wrap to 2 lines and are fully legible.
- Severity: medium (combo names — the differentiating words — are the part cut off).
- Direction: keep single-line row titles; do not expand card height for full names (density constraint below). Full name remains one tap away on the product detail route.
- Constraints: row card keeps `h-24 w-24` image + price/ADD bottom row; widening text column is not available.
- States: in-stock list state only; no sold-out / stepper / empty state visible in these shots.
- Acceptance: row title uses single-line truncate (current source `MenuProductCard.tsx:421-425` `Text variant="titleMedium" className="truncate"`); description uses `line-clamp-2` (`:427-431`). Observed ellipsis matches that behavior — no new truncation bug to file from these shots.

## F2 — Grid-layout title truncation is heavier + uneven description whitespace

- Evidence: `readiness-menu-grid.png`: "2 Jr. Hero B…", "Any Big Ba…". `readiness-grid-swipe-left.png`: "American B…", "Cheese Bur…", "Gochuchan…" (row 2 cut by bottom tab bar). `readiness-menu-vertical.png`: "Super Hero …", "Tandoori Pa…", "Great India…". Right-column grid cards render a 2-line description ("Big Bang Burger + Fries + Coke") while left-column combo cards render none, leaving a blank gap between "15m" meta and the price/ADD row.
- Severity: medium (grid shows ~12–14 visible title chars; identity relies on image + price).
- Direction: keep 2-col grid truncate; do not add a second title line (would stagger the price/ADD row across the pair). Optional follow-up is description-or-nothing alignment, not title wrapping.
- Constraints: `grid grid-cols-2 gap-3.5` (`menu.index.tsx:400`); card body `p-3`, price/ADD `justify-between` in a narrow column (`MenuProductCard.tsx:380-390`).
- States: grid/in-stock/qty-0 state; stepper, sold-out overlay, skeleton not visible here.
- Acceptance: current source grid title is `truncate` (`MenuProductCard.tsx:367-371`), description `line-clamp-2` (`:373-377`), meta/badge/price stacked as seen. Screenshots predate this exact file but show the same single-line-truncate outcome — behavior confirmed, no additional grid-typography change directed by this review.

## F3 — ADD CTA legibility good; grid CTA is smaller by design

- Evidence: all six shots: row ADD is a large orange-outline pill, fully legible ("ADD", ₹109.00–₹299.00 left-aligned, no overlap). Grid ADD (`readiness-grid-swipe-left.png`, `readiness-menu-vertical.png`) is a smaller pill in the same price row; still legible, no clipping against ₹159.00–₹219.00 prices even at 2-col width.
- Severity: low (pass; note only).
- Direction: keep row/grid CTA size split; do not enlarge grid CTA to row size (would squeeze price or wrap the row).
- Constraints: current source row CTA `min-h-[44px] min-w-[72px]` vs grid `min-h-[32px] min-w-[50px]` (`MenuProductCard.tsx:300-303`); grid stepper `h-7`, row stepper `h-8` (`:254-257`).
- States: only qty-0 "ADD" state visible; `quantity > 0` stepper, `customizable → "ADD +"`, `disabled → "Sold Out"` (`:294-311`) are not exercised in these shots and are not judged here.
- Acceptance: row CTA ≥44px target, grid CTA compact but uncrowded, `disabled:opacity-40` + `aria-label="Add {name} to cart"` present in current source (`:294-304`). Screenshots confirm the qty-0 branch renders as specified.

## F4 — Category rail neighbor-chip clipping signals scrollability, weakly

- Evidence: `readiness-menu-before.png` / `readiness-menu-right-clean.png`: active "Combos 4" pill fully visible, right neighbor cut to "Big Bang…" at frame edge. `readiness-menu-swipe-left.png`: active "Big Bang Burgers 6" centered, left neighbor cut to "os 4", right neighbor cut to "Pas". Active pill (dark forest green + count badge) vs inactive (light outline) contrast is strong.
- Severity: low (peeking works, but a first-time user gets only the clipped chip as the swipe hint).
- Direction: keep rail as-is; the in-page hint line (F6) is the discoverability mechanism, not a rail redesign.
- Constraints: rail chips `flex-none shrink-0 … min-h-[44px]` (`CategoryNavRail.tsx:168-173`); rail strip `overflow-x-auto … touch-pan-x` (`:151-157`).
- States: `aria-selected` active vs inactive + count badge (`:159-201`) visible; deep-link/first-mount centering not determinable from stills.
- Acceptance: current source `CategoryNavRail.tsx:59-85 centerOn` + end-padding centering (`:89-103`) + `handleSelect` center-then-select (`:138-142`) produces exactly the centered-active / clipped-neighbor pattern in the swipe-left shots. Pre-fix images show the pattern working; no rail-geometry change directed.

## F5 — Sticky rail + count row present at top; scrolled shots show products only

- Evidence: `readiness-menu-before.png`, `readiness-menu-swipe-left.png`, `readiness-menu-grid.png`, `readiness-grid-swipe-left.png` (top states): MENU header → category rail → "4/6 pure veg items" + list/grid toggle row all visible. `readiness-grid-swipe-left.png` (lower half) and `readiness-menu-vertical.png`: full-bleed product grid with no rail/header in frame (scrolled position, bottom tab bar persists).
- Severity: low (informational; stills cannot prove stickiness during scroll).
- Direction: no sticky-behavior change from this review; judge only that the rail + count + toggle grouping matches the specified sticky block.
- Constraints: sticky block is `sticky top-[calc(3.5rem+env(safe-area-inset-top,0px))] z-20 bg-surface/95 backdrop-blur-md` wrapping `CategoryNavRail` + count/toggle row (`menu.index.tsx:335-380`); rail root itself is `sticky top-0 z-20` (`CategoryNavRail.tsx:144-150`).
- States: count text branch `bucket?.total ? "{total} pure veg items"` (`menu.index.tsx:346-348`) matches "4/6 pure veg items" in shots; the alternate "{n} categories • swipe to browse" branch is not shown.
- Acceptance: top-state screenshots match the specified sticky-block content order (rail → count + view toggle). Scrolled-state absence of the rail in-frame is consistent with a cropped/scrolled capture, not evidence of a sticky failure — no finding filed against stickiness.

## F6 — View-toggle + swipe-hint affordances are legible; density trade-off is explicit

- Evidence: list shots show the list-toggle as filled dark circle, grid-toggle as outline icon; grid shots show the inverse. Toggle pair sits right-aligned on the count row in all top-state shots. Product container hint "Swipe left/right to switch category • Tap pills above to jump" is specified in current source but its rendered presence cannot be confirmed inside these six frames (bottom tab bar overlaps lower content in `readiness-menu-swipe-left.png` / `readiness-menu-vertical.png`).
- Severity: low.
- Direction: keep the toggle + hint-line mechanism; no icon redesign or hint repositioning from this review.
- Constraints: toggle buttons `h-9 w-9 rounded-xl`, active `bg-[#0E4825] text-white`, `aria-pressed` (`menu.index.tsx:349-378`); product list container `touch-pan-y` + `attachCategorySwipe` direction-locked horizontal switch (`:191-202, 385-388`); hint line (`:437`).
- States: `viewMode === "list"|"grid"` active styling visible; swipe mid-gesture state visible only as the centered-category outcome (F4), not as motion.
- Acceptance: `aria-label="List view"/"Grid view"` + `aria-pressed` + `role="group" aria-label="View mode"` present in current source; screenshots show the correct active-fill side for each mode. Density note: row cards (~3 visible + bottom bar) vs grid cards (~2 visible + bottom bar) — grid shows fewer purchasable units per viewport in exchange for larger imagery; accepted as the intended mode trade-off, not a defect.

## F7 — Image badge + favorite-heart overlays stay inside the image

- Evidence: row shots: "BIG BANG SERIES" orange badge bottom-left of the 96px thumb + heart top-right; badge text wraps to 2 lines ("BIG BANG / SERIES") on narrow thumbs but stays inside the image bounds. Grid shots: badge single-line, fully legible over larger `aspect-square` imagery; heart top-right never covers price/ADD/title.
- Severity: low (pass; note only).
- Direction: keep overlay positions; do not move badge below the image (would cost a text line in grid).
- Constraints: badge `absolute bottom-1.5 left-1.5 … text-[9px] font-black uppercase` with tone map (`MenuProductCard.tsx:212-225`); badge content from `getDistinctiveOverlayBadge` — explicit badge → "Big Bang" series match → first tag (`:58-80`); heart `absolute right-1.5 top-1.5` (`:226-234`); discount badge `absolute left-1.5 top-1.5` (`:200-204`, not triggered in these shots).
- States: "Big Bang Series" orange tone only state observed; emerald/amber/neutral tones, discount %, and sold-out dim overlay (`:205-211`) not present in these six shots.
- Acceptance: overlays are image-bounded with no text/CTA collision in any of the six shots. Current-source badge resolver explains the "BIG BANG SERIES" label on Big Bang rows without a per-product explicit badge.

---

## Source-fix mapping (images predate source; which current source addresses which symptom)

| Symptom in screenshots | Current source that governs it |
|---|---|
| Row/grid title ellipsis, 2-line description clamp | `MenuProductCard.tsx:367-377` (grid), `:421-431` (row) |
| Row ADD large / grid ADD compact, both legible | `MenuProductCard.tsx:238-314` (esp. `:300-303` sizes) |
| Clipped neighbor chips + centered active pill | `CategoryNavRail.tsx:59-103` center + `:144-157` scroll strip + `:168-173` chip sizing |
| Rail + "N pure veg items" + toggle grouping | `menu.index.tsx:335-380` sticky block |
| Swipe-left category outcome (Combos ↔ Big Bang Burgers) | `menu.index.tsx:191-202 attachCategorySwipe` + `:385-388 touch-pan-y` + `:437` hint line |
| BIG BANG SERIES overlay + heart inside image | `MenuProductCard.tsx:58-80` resolver + `:167-236` image/overlay stack |
| Veg dot, 15m meta, count badge, price formatting | `VegIndicator` + `:316-329` meta + `CategoryNavRail.tsx:190-201` count + `formatINR` price lines |

## Not covered (explicitly out of scope for this review)

- Sold-out, stepper (qty>0), customizable "ADD +", skeleton, empty-category, pagination-sentinel, offline, stale-menu, kitchen-closed, and search-highlight states: not visible in the six allowed shots; not judged.
- Full-site QA is not claimed. Findings above apply only to the device menu list/grid evidence set.
