# Burgonomics Phase A — proposed v0 design

**PROPOSED — NOT IMPLEMENTED.** Internal design review only; not store screenshots, current-build evidence, functional proof or design-team approval. User confirmed the settled system and existing local brand/verified food-photo reuse for these comps. Stop at this v0 for feedback before expanding to the complete A1 state set.

## Design read

| Dial | Delivery | Partner | Visible consequence |
|---|---|---|---|
| Artifact / audience | Phone ordering-screen comps / customers | Operational-screen comps / invited staff | Food discovery versus queue/status hierarchy |
| Mode | Redesign, preserving navigation and agreed journeys | Redesign-preserve | No routing, taxonomy, staff workflow or state-authority rewrite |
| Visual language | Food-led, spacious QSR ordering | Restrained kitchen operations | Large square photos; flat tickets with explicit payment/POS facts |
| Visual variance | 4/10 | 2/10 | New 2×2 merchandising, familiar navigation; stable operational lanes |
| Motion | 1/10 in static comps | 1/10 | No screenshot can prove flips, gestures or live alerts |
| Density | 5/10 | 7/10 | Comfortable phone rhythm; denser tablet queue without tiny text |
| Asset dependence | 8/10 | 3/10 | Genuine existing photo/mascot assets, no decorative fabricated imagery |
| Brand fidelity | 9/10 | 9/10 | Existing mascot and forest green; no new wordmark |

## Screen positioning before tokens

- Home: choose food; viewed at phone distance; warm and food-led. Four named shortcuts must fit without redundant category rails or reorder. The wrap tile deliberately exposes the missing approved photo.
- Menu: find the next section; phone distance; calm and scannable. Sections flow vertically; the strip is navigation, not mutually exclusive tabs. The v0 is representative, not a live complete catalog.
- Empty Cart: discover or reorder; phone distance; helpful, not promotional. Synthetic history is clearly labelled; guest history is absent in the eventual guest state.
- Populated Cart: review items and one optional kitchen note; phone distance; clear and careful. Unknown prices remain unknown. No invented bill/tax/discount/loyalty resolution.
- Partner KDS: see unresolved paid/POS work first; tablet distance; operational and restrained. Payment, restaurant confirmation, feed freshness and sound availability are independent facts.
- Partner sign-in: understand invitation-only access; phone distance; direct and non-privileged. No demo PIN, public role picker or functioning login.

## Confirmed v0 system

| Role | Light | Dark |
|---|---|---|
| Canvas | `#FFFFFF` | `#000000` |
| Surface | `#F5F7F5` | `#141414` |
| Elevated | `#FFFFFF` | `#1A1A1A` |
| Main text | `#16281D` | `#FFFFFF` |
| Secondary text | `#586B60` | `#B4BFB8` |
| Primary fill / label | `#0E4825` / `#FFFFFF` | Same; necessary focus/selected outline uses mint |
| Primary text/focus | `#0E4825` | `#4ADE80` |
| Sparse accent | `#C2410C` | `#FF802B` text; `#C2410C` fill only with white |

Inter is self-hosted from the pinned official `rsms/inter` source with its SIL OFL. No runtime font/CDN/API requests. Existing logo remains an image; the adjacent plain product-name text is not a new decorative wordmark. Body 16/24, secondary 14/20, section 20/28, title 24/32; tabular amounts/ages. Spacing 4/8/12/16/20/24/32 px. Ordinary surfaces are flat; 8 px controls, 12 px image containers, fully rounded segmented switches; shadows only on floating cart/navigation chrome.

Normal text ≥4.5:1; large text ≥3:1; necessary control/focus indication ≥3:1 against adjacent colours. Aim at 44×44 touch targets, never below the 24×24 AA floor without a documented exception. State information includes words/shape, not colour alone. Text containers can grow. Screenshot reflow/200% checks apply only to these isolated comps, not actual app accessibility. Static controls do not claim keyboard/screen-reader/native acceptance.

## Assets and data honesty

[Brand and asset provenance](brand-spec.md). The genuine logo and three confirmed local food assets are copied into this non-production directory without altering their sources. There is no verified wrap photo: show a placeholder. Food prices, real outlets, stock, history, order IDs, payments and queue records are not loaded. Example order/history/timer content is synthetic and labelled. `₹—`/“Price pending” are placeholders, not quotes.

No awards, upcoming locations, discounts, delivery ETAs, ratings, bestseller rank or production availability are invented. Awards/Upcoming Stores hide when no approved content exists. The representative menu does not collapse Petpooja's real categories into four.

## v0 screenshot IDs

| ID | Screen | Theme / size |
|---|---|---|
| D01 | Home, four shortcuts | Light / 390 px |
| D02 | Home, same hierarchy | Dark / 390 px |
| D03 | Continuous menu / section boundary | Light / 390 px |
| D04 | Empty Cart / synthetic returning-user history | Light / 390 px |
| D05 | Populated Cart / one expanded cooking note | Dark / 390 px |
| P01 | KDS / paid-POS-pending, stale/muted example | Dark / 768 px |
| P02 | Staff sign-in / invitation-only copy | Light / 390 px |

Supplemental v0 layouts: D01 at 320 and 768 px; D05 at 320 px with 200% type; P01 at 320 px. All image hashes/dimensions and render limits belong to the generated image manifest. Every image carries “PROPOSED — NOT IMPLEMENTED” and its ID. No animation or real software keyboard is simulated as proof.

## Deliberately not complete at v0

Complete A1 coverage remains pending feedback: all critical screens in both themes; guest/no-history Cart; collapsed note and real-keyboard-safe composition; menu missing-content/fetch errors; paid-POS customer tracking; live/loading/empty/reconnecting/muted KDS alternatives; stock POS-sync failure; dispatch ambiguity; invite denial/revocation; System/Light/Dark settings; broader 320/390/768, 200% and text-spacing coverage. No missing case is marked passed.

The later A1 state set does not authorise app implementation. Exact screenshot/revision approval belongs to Burgonomics' design team through the user. Pricing/vendor/security decisions remain in the launch plan and cannot be resolved by drawing a prettier bill.
