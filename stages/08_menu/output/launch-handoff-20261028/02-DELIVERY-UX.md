# Delivery UX requirements and source leads

Status: approved behavioural requirements; visual composition still needs Burgonomics screenshot approval. No redesigned screen or phone comparison was produced in this task.

## Required experience

### Home

- Replace competing Home category entrances with a clear Explore Menu section: four large square shortcuts in a spacious 2×2 layout, for Burgers, Wraps, Sides, Shakes & Drinks.
- The four are merchandising shortcuts, not new POS category IDs and not a restriction on the complete menu. Resolve the actual category mapping; never fabricate IDs, products or stock.
- Brief automatic flip between approved food images, stationary readable labels, single-tap category navigation. Reduced-motion users see static imagery. A missing second image must not block browsing.
- Remove Home's quick reorder rail. Retain useful Bestsellers/Combos only when backed by legitimate data; they must not recreate the cramped hierarchy.
- Append Awards & Recognition, then Upcoming Stores, using user-supplied approved content. Hide empty sections. Upcoming-store announcements must not become orderable outlets accidentally.
- Vertical swipes that begin on a banner must scroll the page. Intentional horizontal banner swipes must work without accidentally activating links. Account for pointer cancellation, autoplay, focus and reduced motion.

### Menu

- Stack all categories in one continuous vertical menu: category B follows the end of category A.
- Sticky category shortcuts jump to headings with a safe header offset and update as the user scrolls. Do not filter other categories away or replace the list on horizontal product swipes.
- Plan bounded loading/pagination and real-time updates across category buckets. Do not eagerly load every item merely to make the screen appear continuous.
- Preserve selected-store isolation, search behaviour, availability, URLs/deep links and stable POS identifiers. Handle empty categories, missing images, long names and network errors honestly.

### Cart and reorder

- Empty Cart offers Explore Menu plus previous-order reorder for eligible returning users. Guests and users without order history get an honest empty state.
- Once items exist, the empty-cart reorder section disappears. Order History still offers reorder.
- Reorder must use live branch/catalog/pricing truth. If old items/options are unavailable, explain what cannot be added rather than silently doing nothing or substituting items.
- One expandable order-level cooking-instructions field, not per-item inputs or duplicate Checkout fields. Keep the canonical order-note channel through persistence, checkout, order creation and POS/KOT.
- Preserve real item selections already supported; do not add new paid options or an unapproved modifier wizard. Cooking notes are requests, not guaranteed allergy accommodation or a way to alter prices.
- Revisit cramped bill, quantity controls, keyboard/safe-area behaviour and the primary checkout action in both themes.

## Shared visual constraints

- White light-mode canvas, black dark-mode canvas, restrained green primary actions and orange highlights; semantic tokens rather than scattered raw colours.
- System theme default plus persisted System / Light / Dark setting, including cold start and resume without an unreadable flash.
- Self-hosted Inter for the interface; decorative brand lettering confined to the logo. Check rupee glyphs, numerals, long names, price hierarchy and large text settings.
- Normal text contrast at least 4.5:1; large text 3:1; essential controls/focus indicators 3:1 against adjacent colours. Aim for 44×44 CSS-pixel touch targets; WCAG AA's minimum is 24×24 with exceptions, not 44×44.
- Preserve visible focus, text resizing, 320px reflow and distinguishable non-colour status/error signals. Sticky elements must not cover focused controls or category headings.
- Motion must honour reduced motion. If any automatic movement lasts more than five seconds, provide the required pause/stop/hide mechanism rather than claiming reduced-motion support alone is sufficient.

## Source map — customer repo relative

| Concern | Source lead | Evidence level |
|---|---|---|
| Home sections and duplicate category entrances | `src/routes/home.tsx:117-240` | Directly read |
| Banner gesture capture and scroll writes | `src/features/home/components/BannerCarousel.tsx:151-175,215-237` | Directly read; device reproduction pending |
| Empty Cart and line/order notes | `src/routes/cart.tsx:166-223` | Directly read |
| Current typography/theme | `src/styles.css:112-249` | Recon worker read; recheck before edit; file already dirty |
| Category image/grid and Home data | `src/features/home/components/CategoryGrid.tsx`; `src/features/home/services/homeService.ts` | Paths verified; worker source findings |
| Single-category menu and sticky navigation | `src/routes/menu.index.tsx:213-224,295,364-464`; `src/features/menu/components/CategoryNavRail.tsx` | Paths verified; worker source findings |
| Per-category loading | `src/features/menu/state/menuStore.ts` | Path verified; worker found bucket-based loading |
| Reorder validation | `src/features/orders/hooks/useReorderItems.ts` | Path verified; worker found availability handling not rendered by Home |
| Per-line notes and final payload | `src/features/cart/components/CartItemRow.tsx`; `src/features/orders/repositories/OrderRepository.ts` | Paths verified; worker found order-level `checkout.orderNotes` becomes `notes` |
| Customer store model | `src/features/stores/models/Store.ts` | Path verified; upcoming-store UI substrate not established |

## Approval and verification exits to put in the new plan

1. Compare the named apps on an approved connected device; record app versions, device and actual inspected screens. Do not copy competitors' assets or reverse-engineer private APIs for this design task.
2. Submit clearly labelled proposed Home, Menu, empty/populated Cart and theme screenshots to the user for Burgonomics team approval.
3. After implementation approval, verify actual styled app screens, gesture behaviour, live-data failures, order notes and reorder against source-bound test results.
4. Verify the built Android and iOS artifacts independently. A browser viewport is useful but is not native acceptance.

The new session must specify exact layout, type scale, loading strategy, motion timing and test ownership. These requirements are not permission to guess the implementation or claim the UI is already approved.
