# v2 coverage and decision checklist

**Design proposals only.** “Covered” below means a planned static composition, not a tested app state. The generated revision index/manifest records which images actually rendered. Every catalog state has a light and dark render; representative extra widths/type/spacing samples are separately identified. v0-r1 remains prior evidence.

Requirements: [Delivery A1 checklist](../../03-DELIVERY-DESIGN.md), [Partner state contract and A1 checklist](../../04-PARTNER-DESIGN.md). This packet does not rewrite those implementation contracts.

| IDs | Proposed coverage | Team decision / remaining evidence |
|---|---|---|
| D01–D02 | Four 2×2 shortcuts; missing Wraps photo; no awards/openings/history rail; unavailable category mapping | Is unavailable-mapping copy clear? Supply approved photo/mapping; no taxonomy changes |
| D03–D06 | Menu top/loading; visible A→B boundary; section error/retry; verified empty section | Headings stay visible; no swipe-only or exclusive tab panels. Bounded loading/network/scroll proof still required |
| D07–D09 | Guest/no-history/returning empty Cart | No history/reorder rail for guest or no-history; returning content explicitly synthetic |
| D10 | Reorder has unavailable item/retired option and changed-price uncertainty | No substitution; current basket unmodified until validation and explicit review. Actual branch/price/options validation outstanding |
| D11–D13 | Populated Cart with collapsed empty/expanded/collapsed nonempty note | One kitchen field only; no per-item/Checkout duplicate or instruction pills; summary remains visible |
| D14 | Note-focused composition with labelled keyboard-space reservation | **Not an actual keyboard capture.** Native focus, IME, safe area, scroll and screen-reader checks remain required |
| D15–D16 | Customer paid/POS-pending and prolonged confirmation states | Payment ≠ accepted/preparing; no KOT/ETA/refund promise. Two-minute alert/five-minute escalation are scenario assumptions |
| D17 / P21 | System/Light/Dark; resolved theme; guest Delivery entry | No persistence/OS-change/first-paint proof or global-theme implementation |
| P01–P04 | Invitation-only entry; uninvited/revoked/cross-outlet denial | No public roles/demo login/secrets or cached orders. Server enforcement and real reviewer provisioning remain open |
| P05 / P14–P15 | Orders + explicit payment/transport/restaurant facts; 2m alert/5m escalation | Certainty-aware review, not blind send/refund. Threshold dedupe and operator procedure remain untested |
| P06–P11 | Current/loading/empty/reconnecting/listener error/offline KDS | Empty follows authorised success; failures retain stale facts, never green “clear”. No real listener/poll/push/terminal-state proof |
| P12–P13 | Muted/unavailable sound with persistent visual warning | Alert acknowledgement is not acceptance. Same-count new-order and native background/permission cases still required |
| P16–P18 | Backend save versus customer propagation versus failed POS sync; denied save; outlet scope guard | Do not claim all customers updated from a backend write; no “All Outlets” mutation or invented POS item mapping |
| P19–P20 | Uncertain booking versus confirmed provider rejection | Preserve request identity; no fabricated booking/rider/fare, no automatic duplicate/fallback booking, Porter not reintroduced |

## Representative layout samples (not an exhaustive cross-product)

The renderer schedules Home at 320/768; Menu boundary at 320 with 200% type; expanded note at 320 with 200% type and at 390 with text-spacing overrides; keyboard-space illustration at 320; Partner queue at 320/390; stock at 320 with 200% type; dispatch at 390 with text-spacing; Partner appearance at 320 with 200% type. Both themes are used across the samples. Full baseline state pairs are 390 px for Delivery/access/appearance and 768 px for Partner operations.

A 768 px Delivery screenshot retains its designed content max-width; this is not a new tablet app layout. Partner operations use lanes at 768 and a single column on phones. Full-page PNG heights may exceed a viewport; they are design sheets, not native screenshots. Menus and navigation strips may have deliberate one-axis internal scrolling. Zoom, Dynamic Type, keyboard focus safety and native safe-area behaviour are not established by setting a CSS font size.

## Review response format

For each change request, name **revision + full image ID + element + requested change + reason**. Example: `v2-r0 / D12-D-320-200 / note helper / shorten the limit explanation / keep field context visible`. An example is not approval of that revision.

Record separately: visual accept/change/hold; exact approved images and approver/date; unresolved finance/vendor/auth decisions; remaining implementation and native tests. A general “looks good” does not approve a release baseline or permission to implement/deploy/submit. No team decision is recorded yet.
