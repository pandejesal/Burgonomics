# Approved decisions

Approved through three interview rounds, ending with the user's “Recommended” on 2026-10-28. This is a decision record, not evidence that any feature is implemented.

## Scope and timing

| ID | Decision |
|---|---|
| D01 | Both Delivery and Partner target both stores. Ready app/platform submissions may proceed independently, with Burgonomics approval. |
| D02 | Original targets remain November 3 for tested release candidates/submission readiness and November 8 for public launch. Store review is external; report submitted versus live separately. |
| D03 | Delivery gets the substantial redesign. Partner gets readability, spacing, navigation and critical operations polish without unnecessary workflow restructuring. |
| D04 | Protect real ordering, payments, POS/KOT, security, readability and scrolling. Defer optional animation polish first if necessary. Reelo implementation can wait. Do not silently drop requirements or bypass quality gates to meet a date. |
| D05 | Only individually verified outlets may accept orders at launch; do not infer readiness for every branch from one pilot. |
| D06 | Delivery, Takeaway and Dine-in remain only if each passes complete pricing/payment/POS/fulfilment acceptance. Do not expose a merely decorative or unverified mode. |

## Delivery experience

| ID | Decision |
|---|---|
| D07 | Home Explore Menu has exactly four featured shortcuts for now: **Burgers, Wraps, Sides, Shakes & Drinks**. Full menu categories are not limited to four. |
| D08 | Use a spacious 2×2 arrangement of large square cards. Cards briefly flip automatically between approved food images; labels stay stationary and a single tap opens the category. Do not require tap-to-flip followed by another tap to navigate. Stop motion offscreen and honour reduced motion. |
| D09 | Menu categories form one continuous vertical list. Sticky shortcuts jump to headings and track the visible category. Remove swipe-to-replace-category behaviour; preserve native vertical scrolling. |
| D10 | Move Home's quick reorder section to empty Cart. Hide that section once Cart has items; retain reorder in Order History. Revalidate branch, current prices, availability and supported options, with visible explanations of failures. |
| D11 | One optional expandable **Add cooking instructions** control in Cart. Remove per-item cooking-note inputs and avoid duplicate entry in Checkout. Keep existing legitimate item selections; this is not permission to invent a new modifier builder. |
| D12 | Add **Awards & Recognition** and **Upcoming Stores** at the bottom of Home. User supplies approved content; developers maintain it. No new CMS or notification signup for this release. Hide empty sections; never invent awards, dates or locations. |
| D13 | Fix vertical scrolling that starts over the banner while preserving intentional horizontal swiping, safe taps, keyboard access and reduced-motion handling. |

## Appearance and Partner

| ID | Decision |
|---|---|
| D14 | **White canvas in light mode; black canvas in dark mode.** Green is primary; orange is sparse highlighting. Keep accessible error/warning signals. Exact surface hierarchy and tokens require contrast testing and visual approval. |
| D15 | Default theme follows the phone; persist a System / Light / Dark override. This applies to both apps. |
| D16 | Use self-hosted Inter for readable interface typography. Retain distinctive Burgonomics lettering only in the logo. Do not use decorative faces for interface headings, prices, buttons or instructions. |
| D17 | Partner is publicly downloadable but staff access is invite-only, authorised server-side. No self-registration into privileged roles. |
| D18 | Prioritise Partner orders/KDS, menu availability, dispatch, navigation and actionable failure states. Preserve operational state visibility and safe transitions. |

## CRM, money and operations

| ID | Decision |
|---|---|
| D19 | Retain Petpooja POS. Investigate Reelo CRM/marketing integration first. In-app Reelo loyalty and historic balance migration are not launch commitments. |
| D20 | Preserve existing Grill Coins balances/history. Existing earning/redemption may remain only if the programme is approved and financial safety tests pass. Never translate balances to Reelo automatically or operate two divergent reward authorities. |
| D21 | A paid order awaiting POS must show honest pending restaurant confirmation. Alert staff after **2 minutes** and escalate after **5 minutes**. Threshold acceptance came in the final interview answer. |
| D22 | Keep a durable retry/reconciliation record. Do not falsely claim restaurant acceptance, blindly resend an ambiguously accepted order, or automatically refund without an agreed policy and authorised action. Alert thresholds are not necessarily retry intervals. |
| D23 | Petpooja acceptance requires operator confirmation of the actual order, instructions, correct outlet and printed/displayed KOT. HTTP ACK alone is insufficient; physical-print proof is separate where printing is used. |
| D24 | Supervised live acceptance may be scheduled only after offline/emulator/sandbox exits. The exact outlet, test order, amount, operator, printer/KDS checks and any refund/cancel/delivery actions need separate approval before execution. |

## Ownership and next-session boundary

| ID | Decision |
|---|---|
| D25 | Burgonomics' team approves design screenshots that the user forwards. Do not substitute the agent's preference for team approval. Proposed mockups first, clearly labelled; implemented-build screenshots and functional proof later. |
| D26 | Burgonomics owns Apple/Google account access. Credentials remain under its control; submission needs its approval. Account ownership does not prove account verification, signing readiness or production access. |
| D27 | User approved UI inspection of the connected phone, including Martinoz, La Pino'z, Delivery and Partner. This does not authorise financial/operational side effects or unrestricted private-data extraction. No paid cloud device is approved. |
| D28 | Project-local registration of the installed REA server was approved and completed. Unrelated MCPs/global configuration were to be preserved. |
| D29 | **Write this self-contained handoff now; create the detailed implementation plan in a fresh session with empty conversation context. Stop for approval before application implementation.** |
| D30 | No fake promises: evidence must match the claim, source and artifact. Unverified work stays blocked; previous builds and historical green tests do not validate new source. |

## Numbering corrections resolved

- The user's “Q17” dark-mode exception concerned the theme question (Q16). It explicitly replaced light-only with white/light and black/dark. The all-three-modes recommendation remains accepted.
- The user's “Q26” screenshot-approval response concerned the approver question (Q25). Team design approval replaced individual approval. POS-delay handling was re-asked and then explicitly accepted with the final “Recommended”.
- The initial “plan now / execute later” suggestion was replaced by D29. Do not write or execute a detailed implementation plan as if it had already been approved here.
