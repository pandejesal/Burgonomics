# Design reset — three proposals, v1

**PROPOSED. NOT APPROVED. NOT SHIPPED.**

**Latest owner decision:** keep the current app design; small refactors only.
Only the Cart comp is approved for a bounded visual cleanup, not the adjacent
Menu or a full-app rewrite. Home from “On the menu” downward was liked as a
direction, but is not automatically approved for implementation. Keep the current
Home header/hero and Partner design. See `REVIEW-STATUS.md` for the current scope;
the full-overhaul brief below describes the historical v1 proposals only.

These standalone design boards answer the owner's reset request. They are not
application code, an approved design system, a release candidate, or evidence of
working payments/POS/dispatch. No app source, `functions/**` or Firestore rules
are changed. The previous UI candidates are preserved and rejected as final;
the just-built debug APK was **not installed** after the reset.

The owner-supplied
`developer-resources/provider-toolkit-20261029/MASTER-REFERENCE.md` was read.
It is a public provider-documentation index, not acceptance evidence or authority
to reconnect services. The backend remains owned by the other session.

## Three boards

1. **Delivery Home:** a large food hero; exactly four square shortcuts; one
   bestsellers rail; one combos rail; Awards & Recognition; Upcoming Stores.
2. **Delivery Menu + Cart:** adjacent continuous menu sections with sticky jump
   chips and two-column food cards; a separate clean Cart with one cooking-note
   field, a readable sample bill and one checkout action.
3. **Partner Kitchen + Orders:** a new operational hierarchy, large tickets,
   payment and POS statuses shown separately, an exception queue and a switch
   to the all-orders table. All tickets are explicitly synthetic design samples.

Open `index.html` through the local proposal server. The review toolbar switches
boards and light/dark canvases; it is not proposed application chrome. Prototype
actions have no network or server effects. Approval of these boards is required
before app implementation starts.

## Design read

- Mode: **redesign / overhaul**, not a polish pass.
- Delivery: food-led QSR ordering; familiar app navigation, generous section
  spacing, photography doing the visual work. Dials: variance 4, motion 1,
  density 4, assets 9, brand fidelity 8.
- Partner: kitchen-floor operations, not an executive dashboard. Tickets and
  exceptions outrank totals and charts. Dials: variance 3, motion 1, density 7,
  assets 3, brand fidelity 8.
- Viewing distance: phone at arm's length; Partner tablet/desktop on a counter.
- Hierarchy: one dominant job per screen. No decorative Home category strip,
  nested card stacks, KPI-card grid, chart filler or deck-styled app chrome.

## Proposed system

- Inter is self-hosted, including its unchanged OFL file. Interface text only;
  the actual Burgonomics mascot is an image, not a recreated illustration.
- Light canvas `#ffffff`; dark canvas `#000000`. Forest green `#0e4825`
  primary; orange is reserved for attention/limited emphasis, not every CTA.
- Deep green, actual ceremony photography and a thin restrained gold line are
  confined to Awards and small brand moments.
- Body 16px, supporting copy 14px, section headings 24px; large Partner ticket
  identifiers and item quantities. Touch controls aim for 44px or larger.
- 4/8/12/16/24/32/48 spacing scale. Food frames 12px corners; control corners
  8px; operational tickets 8px. Elevation is reserved for floating navigation.
- Text contrast target 4.5:1; large text/control/focus indication 3:1. Colour
  is paired with text for paid, pending and failed states. No motion is required
  to understand a state. These are design targets, not a WCAG certification.

## Content provenance and limits

- Logo, food photographs and ceremony assets are copied read-only from the
  existing Delivery candidate's `public/` directory. `asset-manifest.json`
  records exact source paths and SHA-256 identities. See `brand-spec.md`.
- Menu names/prices were observed in the public Gota preview on 29 October:
  Cheese Burst Burger ₹199, Super Hero Burger ₹219, Great Indian Burger ₹169,
  Tandoori Paneer Burger ₹209, American Burger ₹159, Gochuchang Burger ₹179;
  Any Big Bang Burger Meal ₹299 and Any Classic Burger Meal ₹199.
- This is a visual snapshot, not a live price/stock guarantee. The bestsellers
  rail's selection is proposed, not verified sales ranking. Descriptive copy is
  proposed copy, not a verified ingredient list.
- There is no genuine Wraps photo/category in the inspected outlet. Its shortcut
  stays neutral and unavailable; no burger image is relabelled as a wrap.
- Award titles/issuers and the eight announced locations come from the
  owner-approved `approvedHomeContent.ts` / franchise-deck evidence. Announcements
  cannot be selected for ordering; unconfirmed opening dates are not promised.
- The Cart uses real item-name/price examples with an **illustrative** bill.
  All fees/tax policy remain the backend's responsibility, not this prototype's.
- All Partner ticket IDs, ages, counts, notes, payment/POS/dispatch statuses and
  operators are **synthetic**. No real customer or order data is accessed.

## Contracts to preserve after approval

Keep working auth, data/state, catalogue taxonomy, stock/customisation guards,
continuous section loading/jumps, Cart/reorder and note persistence. Keep
server-side invite-only Partner access. Do not migrate loyalty, rewrite the
backend, change pricing policy or infer deployment permission from design approval.

Empty/loading/offline/error states still need their own implementation acceptance.
The Menu board is a labelled layout excerpt, not a replacement four-category menu.
The remaining real sections stay in the continuous production flow.
