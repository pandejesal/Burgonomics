# 03 — Delivery design and implementation contracts

**PROPOSED DESIGN — NOT IMPLEMENTED OR VISUALLY APPROVED.** The text wireframes below are planning aids, not screenshot deliverables. A1 must supply labelled visual comps for team approval before app changes.

Repository: `C:\Users\DELL\Desktop\Burgonomics\burgonomics-foundation-core` (independent Git repo). Baseline fingerprint group: **G-DELIVERY** in [10](10-SOURCE-FINGERPRINTS.md); fingerprint any additional owned tests/bootstrap files before editing. Every package inherits [01's execution/recovery contract](01-DECISIONS-AND-OWNERSHIP.md). No new-source build/artifact exists.

## Brief, journeys and layout

Primary goal: select a real outlet/mode, find food, review an understandable bill and place one correctly priced order. Secondary goal: repeat a valid order without overcrowding Home. Success is defined by the acceptance cases below, not a fabricated conversion uplift.

Preserve existing bottom navigation **Home / Menu / Cart / Profile**, routing, store selection, search and legitimate product selections. Do not replace TanStack Router, build a new design-system package or turn four merchandising shortcuts into four POS categories.

1. New/guest customer: selected outlet + supported mode → Home shortcut → matching heading in full Menu → existing supported selection/ADD flow → Cart → authenticated checkout/payment → truthful pending restaurant confirmation if POS is not confirmed.
2. Returning customer: empty Cart → previous order → live outlet/items/options/prices validation → explanation of any changes → add eligible selection → Cart. Order History retains reorder.
3. Stock/network change: unavailable item or changed price → visible reason and revalidation → no silent substitution or stale guaranteed total. Guest browsing must not require OTP.

### Proposed screen skeletons

```text
HOME                          MENU
Logo / outlet / mode           Menu / search
Search                         Kitchen/connection notice when applicable
One modest banner              Sticky category jump strip
Explore menu                   Burgers heading
[ Burgers ] [ Wraps ]           Product rows or existing chosen grid
[ Sides   ] [ Shakes & Drinks ] More/load/error for this section
Real bestsellers/combos         Wraps heading; subsequent sections continue
Awards & Recognition*          ...other real categories...
Upcoming Stores*               Floating cart summary when nonempty
Bottom navigation              Bottom navigation
* Hide if no approved content

EMPTY CART                    POPULATED CART
Your cart is empty             Items / legitimate selections / quantities
Explore menu                   Add cooking instructions [expand]
Previous orders, if eligible   Promo + approved Grill Coins + fees/bill
Reorder outcome/explanation    One primary Continue/Checkout action
No history for guest           No reorder section; no per-line note editors
```

Home section spacing: 24–32 px; ordinary horizontal gutters 16 px on narrow phones and 20 px at 390+; content width 520 px Home/Cart, 720 px Menu (existing shells retained). At 320 px, two shortcut cards are 138 px square with 16 px gutters/12 px gap; at 390 px, 169 px square with 20 px gutters/12 px gap. Use responsive width, not hardcoded square pixels. A stationary opaque semantic-surface caption band sits at the bottom of each square; only the image layer behind it flips. Text contrast never depends on a food photo. Permit card height to expand for two-line labels/200% text rather than clip the label to preserve a decorative square.

Menu sections use visible h2 headings and natural page flow. A sticky strip is a set of jumps, not mutually exclusive tabpanels. Keep horizontal overflow of the shortcut strip distinct from vertical product scrolling. Category focus/selection is visible with text/shape as well as green.

Cart's primary total is 20/28 px Inter 700 with tabular numbers; item price 16/24 px 600; body/instructions/input 16/24 px 400–500; item/section title 20/28 px 600; major title 24/32 px 700; metadata 14/20 px. Avoid all-caps/decorative body headings, 10 px critical prices/instructions, fixed-height text containers and blanket truncation of product names. Do not present delivery drop-off instructions as cooking instructions; preserve an existing legitimate delivery channel rather than inventing another entry system.

## Visual and interaction specification

| Role | Light proposal | Dark proposal | Constraint |
|---|---|---|---|
| Canvas | `#FFFFFF` | `#000000` | Approved requirement; replace grey/near-black canvas declarations |
| Surface / elevated | White, grouping by space/hairline | `#141414` / `#1A1A1A` | Flat product lists, elevation only for sticky bar/dialog |
| Main / secondary text | `#16281D` / `#586B60` | White / accessible neutral token | Compute on every actual surface |
| Primary fill / label | `#0E4825` / white | Forest green / white, with distinguishable state/focus | White label ratio 10.647:1; do not use low-contrast green text/icons on black |
| Primary text | Forest green | `#4ADE80` | Green on black is only 1.972:1; mint on black is 12.051:1 |
| Sparse accent | `#C2410C` text/fill as appropriate | `#FF802B` text; `#C2410C` only with tested label | White/orange fill 5.178:1; no orange checkout dominance |

Computed sRGB ratios are token proposals, not rendered UI conformance. Main text/white 15.493:1, secondary/white 5.695:1. Normal copy ≥4.5:1; large copy ≥3:1; necessary control/state/focus indication ≥3:1 against adjacent colours. Dark focus must be independently visible. Keep accessible red/error and warning roles with icon + meaningful words; brand restraint must not erase errors.

Self-host licensed **Inter WOFF2**, ideally one variable file with needed weights/glyphs; include licence. Proposed new asset names must be verified before creation (`public/fonts/Inter-Variable.woff2`, `public/fonts/Inter-OFL.txt`). No runtime Google Fonts request. Use system sans fallback and `font-display: swap`; verify ₹, numerals and weights offline. Keep decorative lettering only in the existing logo, not `font-display` headings/price/buttons.

Theme: default System on fresh install; persist the user's explicit preference in a validated enum; honour it through cold start/resume/system change and invalid/unavailable storage. Avoid two competing theme authorities. Existing stored light/dark choices should remain explicit; don't guess whether an old stored light value was deliberate. The first-paint/splash/status bar/keyboard surfaces must agree without unreadable flash. Test guest and authenticated entry points; theme must not require a remote account preference.

Touch aim 44×44 CSS px, AA floor 24×24 subject to documented exceptions. Reflow at 320 px; 200% text and text-spacing overrides without lost controls. Visible focus never fully hidden under header/cart bars; return focus from dialogs. Announce concise cart/status changes, not every animation frame. Native TalkBack/VoiceOver checks complement keyboard/browser checks.

### Motion proposal (approval required)

- Four shortcut images briefly flip **once each per Home visit** after visible for 0.8 seconds, staggered 0.15 seconds, each flip 0.36 seconds. Stationary labels do not rotate; only approved image faces are used. No reverse loop. A missing second image stays static. Intersection/visibility changes stop timers; unmount cleans up; reduced motion renders static images and non-animated jumps.
- This bounded ≤5-second proposal satisfies the requested automatic brief flip without a permanent motion loop. If the design team instead wants repeated flips, add a visible pause/stop control; short individual flips do not exempt a loop from pause requirements.
- Existing banner autoplay repeats every 5 seconds. Provide a visible pause/resume control for ongoing autoplay, pause on focus/interaction/offscreen/background, and disable auto-advance with reduced motion. Never rely on hover alone for touch users.
- For banner gestures, prefer browser-native touch scrolling; do not capture a pointer or write `scrollLeft` before horizontal intent. If desktop dragging remains, decide direction after approximately 10 px travel with horizontal dominance, release/cancel cleanly, suppress link activation after a drag, and preserve keyboard link activation. These thresholds are proposals to validate on Android/iOS, not proof of a fixed bug.

## Implementation work packages

### D1 — Inter, global theme and readable tokens (10–16 hours)

Owner: Delivery engineer / `opencode-go/deepseek-v4.1-flash`; independent reviewer GLM Free. Stage 01/08. Prerequisites: A0, A1/B design approval, C implementation approval. Existing owned files: `src/styles.css`, `src/routes/__root.tsx`, `src/routes/profile.settings.tsx`, `src/features/settings/state/settingsStore.ts`, `src/features/settings/models/index.ts`, `src/features/settings/repositories/SettingsRepository.ts`. Source anchors: styles `:112–153`; settings defaults `:11–23`; root resolver `:187–241`; binary settings toggle `:85–97`.

Existing tests to extend: `tests/token-accessibility.test.ts`, `tests/primary-cta-contrast.test.tsx`; proposed new `tests/launch-theme-preference.test.tsx`. New fonts/licence as specified above. Acceptance: three-way preference on guest and signed-in flows, no invalid-storage crash, both canvas values and token roles correct, cold start/resume/OS-change works, no external font request, no decorative UI typography, all changed screens readable. Commands: **C-GATES** and **C-BROWSER** in document 09; native appearance cases on both releases later. Fingerprints: G-DELIVERY plus explicit bootstrap/test/font hashes. Recovery: restore only owned presentation changes in the worktree and retain saved user choices; no cart/auth data reset. External blocker: approved comps/font licence and native device access.

### D2 — Home shortcuts, content and banner gestures (10–16 hours)

Owner: Delivery engineer / Go route; Free route may trace mappings. Stage 08, Stage 10 comparison only. Prerequisites: D1, approved category mapping/images and B/C. Owned existing files: `src/routes/home.tsx`, `src/features/home/components/CategoryGrid.tsx`, `src/features/home/components/BannerCarousel.tsx`, `src/features/home/services/homeService.ts`, `src/features/home/models/index.ts`; explicitly transfer the shared Home route/service/model files to D4 before history-chain removal, serialising all edits and recording the handover hashes. Existing `src/features/home/components/BannerCarousel.a11y.test.tsx`; proposed new `src/features/home/components/CategoryGrid.launch.test.tsx` and `src/features/home/launchContent.ts` (developer-maintained approved content, not CMS).

Review correction: D2 also requires D3's **category-resolution interface** before shortcut acceptance, not completion of the whole continuous-menu implementation. Current `menu.index.tsx:52–75` falls from exact ID/name to the first category sharing any token. D3 owns a deterministic outlet-scoped mapping/approved compatibility-alias resolver with explicit ambiguous/missing states; D2 consumes and tests that contract. Never silently choose a similarly named category. Remove the duplicate `CategoryPills` Home import/render in the already-owned `home.tsx:121–142`; retain the shared `src/features/menu/components/CategoryPills.tsx` unless a separate caller/test review authorises changing it. Removing a Home usage does not require deleting a shared component.

Acceptance: exactly four named shortcut cards with actual mapped category targets (Burgers may target the first verified burger section without merging its POS categories); remove redundant Home category entrances; preserve remaining full Menu categories. If a required mapping is absent, show unavailable with explanation and treat mapping completion as blocked, never invent IDs/items. One tap navigates regardless of flip phase. Awards precede upcoming-store announcements at bottom, empty sections hide, announcements never enter orderable-outlet selection. Banner vertical/horizontal/diagonal/tap/cancel/keyboard/reduced-motion tests pass. Commands: C-GATES/C-BROWSER; targeted `npx vitest run src/features/home/components/BannerCarousel.a11y.test.tsx`, then actual native gesture runs. Fingerprint G-DELIVERY; record new content/assets separately. Recovery: keep real catalog IDs/orderability unchanged, static imagery if motion fails (not cancellation of required final behaviour); revise comps rather than insert fixtures. External blockers: real approved imagery/content/category mapping. Missing optional awards/opening content is handled by the approved hide-empty rule, not a false award.

### D3 — Continuous menu with genuine bounded data loading (20–32 hours)

Owner: Delivery engineer / Go route; backend engineer co-owns B4's catalog contract. Stage 08/02. Prerequisites: A0/B/C, D1, stable branch/category contract, B4 indexes/stock interface when needed. Owned files: `src/routes/menu.index.tsx`, `src/features/menu/state/menuStore.ts`, `src/features/menu/repositories/MenuRepository.ts`, `src/features/menu/services/menuService.ts`, `src/features/menu/components/CategoryNavRail.tsx`, `src/features/menu/utils/categoryScroll.ts`. Inspect/update existing `src/features/menu/utils/categorySwipe.test.ts`, `src/features/menu/utils/categoryScroll.test.ts`, `src/features/menu/components/CategoryNavRail.test.tsx`; proposed new `src/features/menu/state/menuStore.continuous.test.ts`. Remove category-swipe binding from Menu, not unrelated swipe behaviour in other interfaces.

D3's early resolver handover supplies D2 with exact category IDs or reviewed compatibility aliases and missing/ambiguous results. Test duplicate names/token collisions, absent required mappings, outlet changes and preserved legacy deep links explicitly; do not break supported links by blindly deleting every alias fallback. Agree B4's category metadata interface before the query work; no circular requirement to finish D2 first.

**Do not mistake existing local array slicing for network pagination.** `menuService.ts:281–304` fetches a store list then slices; `:557–570` subscribes to a store list then emits only a page; `menuStore.ts:130–135` deletes bucket items absent from that emitted page. Service/repository/store changes are required, not just mapping all buckets to sections.

Proposed loading contract: stable branch-scoped category metadata with unchanged IDs/order; visible and immediately adjacent sections request **20 products/page**, maximum **two in-flight page loads**, initial product budget **40**, scroll-ahead ~600 px. Use stable cursor/order and explicit loaded-window ownership, not offset slicing over a full fetched catalog. Keep section headings in the document; near-section placeholders reserve sensible minimum space without pretending item counts are complete. Expand a section's pages before flowing into its neighbour; explicit “Load more” remains keyboard/network fallback. Jump loads only its target/adjacent sections and aligns the real heading below measured sticky chrome; do not materialise all intervening products. If current category data/indexes cannot meet this safely, B4 must supply the verified index/metadata contract first; this estimate is not permission to fake counts or fetch everything.

Realtime: update loaded product IDs/windows only, distinguish an explicit deletion from disappearance from a limited page; revalidate at add/checkout. Branch/generation tokens discard late prior-outlet responses; dedupe products by immutable ID. Cache bounded pages (proposed 10 resident pages), evict with height/scroll-anchor preservation; test with 1,000 synthetic items in a **test-only** fixture. Do not add production fixture catalog data. Preserve existing list/grid user choice, search links, back/forward and category URLs; active heading follows scroll without URL/focus feedback loops.

Acceptance: scroll from last item in category A to B without swipe/tap; safe sticky jumps; no disappearance of item 41+ after a live event; no cross-branch result race; no eager whole-catalog fetch; bounded queries/memory, errors/empty/retry per section; 86 propagates to already loaded items. Commands C-GATES/C-BROWSER plus B4's emulator/index contracts; native long-scroll tests on Android+iOS. Source group G-DELIVERY and B4 root bytes; runtime network/memory traces become required artifacts. Recovery: preserve scroll/cart state; mark stale and block unverified checkout on failure; revert owned query/UI changes only. No auto fallback to globally unscoped products. External blocker: authoritative category/index shape and QA devices.

### D4 — Empty-cart reorder and one order-level cooking note (12–20 hours)

Owner: Delivery engineer / Go route. Stage 05/06/08. Prerequisites: D1, D2 handover of `home.tsx`, B2 money/reward contract, B3 POS note mapping, B/C. Owned existing files: `src/routes/home.tsx`, `src/routes/cart.tsx`, `src/routes/checkout.tsx`, `src/features/home/components/QuickReorderRail.tsx`, `src/features/home/services/homeService.ts`, `src/features/home/state/homeStore.ts`, `src/features/home/repositories/HomeRepository.ts`, `src/features/home/models/index.ts`, `src/features/orders/hooks/useReorderItems.ts`, `src/features/orders/utils/reorderValidation.ts`, `src/features/orders/repositories/OrderRepository.ts`, `src/features/cart/components/CartItemRow.tsx`, `src/features/cart/state/cartStore.ts`, `src/features/checkout/state/checkoutStore.ts`. Read-only dependent input `src/features/home/index.ts` exports the store/models/repository; include any required export/type edit in the approved diff rather than assuming a barrel must change. `CartItemRow.tsx:177–214` currently has per-item note entry; checkout has another field; `OrderRepository.ts:185` sends `checkout.orderNotes` as `notes`.

Reorder: remove Home history request/rail; fetch limited eligible history only in empty Cart for authenticated users. No history read for guest. Remove `store_default` fallback; validate actual outlet and mode; preserve existing cart until validation succeeds and obtain confirmation before replacing another outlet's basket from Order History. Fetch only needed current product/option data instead of a 1,000-item full-catalog shortcut. Validate price, current variation/add-ons, stock and quantity. Render existing unavailable-item modal/outcome, changed-price summary and failures before adding; never silently substitute. Hide reorder as soon as Cart has any line, retain Order History reorder.

The history removal spans the actual loader chain: `homeStore.ts:47–62` → `HomeRepository.ts:21–22` → `homeService.ts:98–118`, where the user argument triggers `getQuickReorder`. Stop Home's history fetch and review its bundle/model/call signature, not just the rail JSX. Preserve unrelated Home data and any shared reorder API still used by empty Cart/Order History; do not delete it without caller evidence.

D4 owns the history-chain segment of `homeService.ts` and the associated Home route/model changes **only after D2's explicit serialised handover**; there is never a concurrent second writer to another segment of the same file. Record whole-file input/output hashes and any return of ownership. Apply the same transfer to overlapping `home.tsx` and Home model edits; a shared package label is not a substitute for file ownership.

Notes: one expandable labelled **Add cooking instructions** control in populated Cart, one order-level field backed by the existing persisted `checkout.orderNotes` channel; collapsed summary when nonempty. Current `checkoutStore.ts:84,157` slices this field at **240 UTF-16 code units**, so the earlier conditional 300-character proposal is not a safe current limit. Do not widen it without contract review; verify the strictest client/server/POS character/byte limit, show a matching counter and reject/resolve excess visibly without splitting Unicode characters or silently losing text. Remove per-item editors and duplicate Checkout editor; Checkout may show read-only summary + “Edit in Cart”. Do not add a modifier wizard. Existing saved line notes must be surfaced for user review/explicit consolidation into the one field, not silently discarded or duplicated; item selections remain structured. Clear note at the correct completed/new-order/account/outlet lifecycle so one customer's request never leaks into another order.

Also retire/migrate Cart's current instruction-pill writer (`cart.tsx:50–70,95–105,213–223,432–456`), which joins delivery and kitchen requests with ` | ` into `orderNotes`. Explain and explicitly review legacy chip/free-text/line-note consolidation; preserve literal user text and existing delivery preferences, with no automatic destructive split/move or overwrite of a separate preference. The distinct persisted `deliveryInstructions` field exists and is capped at 160 code units, but this review has not established a reachable editor for it; do not invent an existing UI or new duplicate kitchen input. Trace its downstream transport and the approved fulfillment UI before assigning legacy delivery requests to it. Any required payment/dispatch-channel edit needs B2/B3 ownership handover.

Acceptance: guest/no-history/mixed unavailable/repriced/retired options/branch-change/repeated taps; no Home history request through the loader chain; note round trip, back/resume, explicit chip/free-text/line-note consolidation, separate delivery-request preservation, actual limit boundary/Unicode/unsafe markup, logout/order completion; exact final kitchen note reaches server payload and operator-observed KOT. One kitchen entry field only in Cart, no surviving pill writer or duplicated Checkout editor; note requests cannot change price or promise allergy accommodation. Commands C-GATES/C-BROWSER, proposed new `tests/launch-cart-reorder-notes.test.tsx`, existing OrderHistoryCard tests, B3 hermetic note fixture and later scoped operator proof. Source G-DELIVERY plus the newly enumerated Home inputs and B3 root fingerprint; artifacts none until run. Recovery: retain recoverable local draft and previous basket, never replay payment to restore a UI. External blocker: supported option, delivery-channel and vendor note-limit contract.

## Edit-source and design exits

Update `_config/design_system.md`, `references/ui_ux_spec.md`, Stage 08 overlay/tests for D1–D3; `references/order_flow.md` and Stage 05/06 for D4 as applicable. Coordinate root docs through A2; do not edit another lane's dirty spec. Obsolete three-column/circular/Home-reorder/swipe-to-replace tests must be replaced with behavioural regressions, not simply deleted to turn green.

A1 comp checklist: Home both themes; menu top and A→B boundary; empty Cart guest/returning; populated Cart collapsed/expanded note + keyboard; pending-POS tracking state. Include 320/390 widths, 200% text sample and missing-content/failed-fetch examples. No new visual asset is approved by the existing-screen screenshots in document 02.
