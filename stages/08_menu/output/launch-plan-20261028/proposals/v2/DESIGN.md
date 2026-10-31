# Phase A v2 — missing-state extension

**PROPOSED — NOT IMPLEMENTED. Internal design review only.** The user's “Start next” continues the Phase A screenshot packet, not app implementation, final design approval or release activity. v0-r1 under `../v1/` is preserved byte-for-byte. v2 IDs are a new namespace; D01 here is not v0 D01.

## Design read and protected system

Mode: **Extension of the settled proposal**, not another redesign. Delivery remains food-led QSR ordering; Partner remains restrained kitchen operations. No route, role, category, pricing or provider contract is changed by a composition.

| Dial | Delivery / Partner | Consequence |
|---|---|---|
| Visual variance | 4 / 2 | Existing 2×2 shortcuts and flat operational hierarchy retained |
| Motion | 1 / 1 | Static images; no flips, live timers, sound or animated skeletons |
| Information density | 5 / 7 | Air around customer decisions; explicit compact operational facts |
| Asset dependence | 8 / 3 | Existing mascot and verified photos; honest missing Wraps photo |
| Brand fidelity | 10 / 10 | Same Inter, semantic roles, corners and navigation vocabulary as v0-r1 |

Preserve: four Home shortcuts, Home/Menu/Cart/Profile, all-category vertical Menu, empty-Cart-only reorder, existing staff destinations, invitation-only entry, Petpooja and Borzo/Shadowfax boundaries. Improve: states missing from v0, alert certainty, narrow layouts and readable text. Do not invent optional marketing content, quotes, staff identities, payment receipts, KOT confirmation or rider progress.

## Positioning by state family

| Family | Narrative role / viewing distance | Temperature / capacity decision |
|---|---|---|
| Discovery + Menu | Find food; handheld | Warm, image-led; four shortcuts only, persistent section headings, no phantom counts |
| Empty/reorder Cart | Choose the next safe action; handheld | Helpful, not promotional; no history rail for guest/no-history |
| Notes + keyboard | Review one kitchen request; handheld | Careful; one field, expanding text boxes, labelled reserved keyboard space |
| Customer confirmation | Explain paid versus accepted; handheld | Calm and candid; no preparing/ETA until restaurant confirmation |
| Partner access | Explain the boundary; handheld | Direct; no cached orders, outlet data or privilege picker on denied screens |
| Feed + KDS | Notice uncertainty and urgent work; phone/tablet | Operational; no false “clear kitchen” while loading/offline/error |
| Stock + dispatch | Distinguish known facts; phone/tablet | Precise; save/customer/POS and request/booking identities separated |
| Appearance | Choose a local preference; handheld | Quiet; System/Light/Dark plus the resolved composition, no persistence claim |

## Tokens carried forward

| Role | Light | Dark |
|---|---|---|
| Canvas / surface / elevated | `#FFFFFF` / `#F5F7F5` / `#FFFFFF` | `#000000` / `#141414` / `#1A1A1A` |
| Main / secondary text | `#16281D` / `#586B60` | `#FFFFFF` / `#B4BFB8` |
| Primary fill / label | `#0E4825` / `#FFFFFF` | Same |
| Primary text + focus | `#0E4825` | `#4ADE80` |
| Sparse accent | `#C2410C` | `#FF802B` text |
| Warning background / text | `#FFF3E9` / `#81360D` | `#26190F` / `#FFB98D` |
| Positive background / text | `#EDF6EF` / `#0E4825` | `#102219` / `#4ADE80` |
| Essential control boundary | `#718177` | `#84948A` |

Known token ratios: primary label 10.647:1, light main/canvas 15.493:1, light secondary/canvas 5.695:1, dark primary-text/canvas 12.051:1. The render manifest computes the actual declared pairs without rounding into a pass. It is not an accessibility certification.

Inter body/input 16/24, metadata 14/20, section 20/28, page 24/32; tabular ages/amounts. Spacing 4/8/12/16/20/24/32 px. Ordinary lists use whitespace/rules, not equal shadowed cards. Controls 8 px corners, images 12 px, switches rounded; only genuinely floating chrome may cast a shadow. Text grows vertically. 320 px uses 16 px gutters, 390 px uses 20 px. Delivery shell stays 520 px (Menu 720 px); Partner lanes become single-column on phones.

Normal text ≥4.5:1, large ≥3:1, essential controls/focus ≥3:1 against adjacent colours. Aim 44×44 CSS px targets (AA floor 24×24 with exceptions); visible 3 px focus. Every status has words, not colour alone. No fixed-height critical text. Samples include 200% root type and SC 1.4.12-style line/paragraph/letter/word spacing; these demonstrate isolated layouts, not browser zoom or native Dynamic Type. No motion is added.

## Data and control honesty

- All outlet, basket, queue, history, payment, feed, timer and dispatch content is **synthetic design data**, labelled on each image. `₹—` is an unavailable amount, never a price, fare or receipt.
- All product actions are disconnected, including support, login, retry, stock, acknowledgement, payment and dispatch. Review-only links may change the local proposal view. No SDK, account/profile, storage, device permissions, external fonts or app imports.
- Static composition positions the selected item inside a horizontally scrolling navigation strip after the local font loads. No destinations are reordered/removed; this is not proof of route changes, scroll-driven selection, focus or native category jumps.
- The one read-only kitchen-note field is backed by no state. Counter uses JavaScript string length (UTF-16 units); **240 is the current persisted client ceiling**, not a verified vendor allowance. Strictest server/POS limit remains open. Delivery instructions are not merged into it. No new delivery editor or legacy migration behaviour is invented.
- Keyboard composition reserves labelled space; it does not show an actual iOS/Android keyboard or prove focus/IME/safe-area behaviour.
- “Feed current”, “captured”, “saved”, “rejected” and elapsed ages are **scenario assumptions**, not observed facts. Transport acknowledgement, restaurant acceptance and payment remain separate. Pending-POS alert/escalation thresholds are 2/5 minutes; no blind resend, automatic refund or imagined KOT.
- Access denial contains no cached order/outlet details. Stock does not equate a saved backend value with confirmed customer propagation or POS sync. Dispatch ambiguity retains a synthetic request reference, with booking ID/fare unknown and alternative booking blocked pending reconciliation. Porter stays retired; Reelo remains investigation-only.

## Evidence and exits

[Coverage and review questions](COVERAGE.md) maps states to the corrected Delivery/Partner plans. Rendering produces revision-labelled PNGs, boards, hashes, an exact image index and bounded artifact checks. Earlier planning validations remain historical and are not rewritten to match later documents.

Neither a state checklist nor a clean screenshot is team approval, baseline selection, security/provider acceptance, a native test, store metadata approval or permission to implement. Exact screenshot ID/revision feedback is the next human decision. The original 3 November RC / 8 November public targets remain unchanged, not guaranteed.
