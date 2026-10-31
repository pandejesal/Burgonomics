# Burgonomics proposed v2-r1 — team review

**PROPOSED — NOT IMPLEMENTED. Internal only. Synthetic data; product controls are disconnected.**

38 states, 89 PNGs including representative layout/type/spacing studies, and 10 boards.

Artifact render checks: **passed within the recorded scope**. No app/security/native/provider/store gate is run or passed.

## How to review

1. Scan the relevant board, then open its full-resolution PNG. Boards are scaled previews, not cropped replacements.
2. Reply with `v2-r1 / full image ID / element / accept, change or hold / requested change and reason`.
3. Record exact image IDs, approver and date. Visual approval is separate from implementation permission, baseline/signing custody and operator acceptance.

Focus: guest/no-history versus returning Cart; one 240-UTF-16-unit client-ceiling note; calm paid/POS-pending copy; stale versus empty feeds; invitation denials; stock/POS and courier certainty.

Missing verified Wraps photo and prices stay placeholders. Awards/openings are hidden. No KOT, refund, rider, booking, fare, successful login or real-time feed is fabricated as live.

The keyboard view is reserved-space artwork only. 200% CSS type and text-spacing samples are not native keyboard, Dynamic Type, actual browser zoom or WCAG conformance proof. Full-page image heights may exceed a viewport.

No team approval has been recorded. No application implementation, account/provider mutation, store action or public creative use is authorised by these files.

## Boards

- [discovery](screenshots-r1/board-discovery.png)
- [cart](screenshots-r1/board-cart.png)
- [notes](screenshots-r1/board-notes.png)
- [confirmation](screenshots-r1/board-confirmation.png)
- [appearance](screenshots-r1/board-appearance.png)
- [access](screenshots-r1/board-access.png)
- [orders pos](screenshots-r1/board-orders-pos.png)
- [feed](screenshots-r1/board-feed.png)
- [stock dispatch](screenshots-r1/board-stock-dispatch.png)
- [layout studies](screenshots-r1/board-layout-studies.png)

## State pairs — full-resolution PNGs

| ID | Proposed state | Light | Dark |
|---|---|---|---|
| D01 | Home / optional content hidden | [D01-L](screenshots-r1/D01-L.png) | [D01-D](screenshots-r1/D01-D.png) |
| D02 | Home / required mapping unavailable | [D02-L](screenshots-r1/D02-L.png) | [D02-D](screenshots-r1/D02-D.png) |
| D03 | Menu / top and section loading | [D03-L](screenshots-r1/D03-L.png) | [D03-D](screenshots-r1/D03-D.png) |
| D04 | Menu / A to B continuous boundary | [D04-L](screenshots-r1/D04-L.png) | [D04-D](screenshots-r1/D04-D.png) |
| D05 | Menu / section fetch failed | [D05-L](screenshots-r1/D05-L.png) | [D05-D](screenshots-r1/D05-D.png) |
| D06 | Menu / verified empty section | [D06-L](screenshots-r1/D06-L.png) | [D06-D](screenshots-r1/D06-D.png) |
| D07 | Empty Cart / guest, no history | [D07-L](screenshots-r1/D07-L.png) | [D07-D](screenshots-r1/D07-D.png) |
| D08 | Empty Cart / signed in, no history | [D08-L](screenshots-r1/D08-L.png) | [D08-D](screenshots-r1/D08-D.png) |
| D09 | Empty Cart / returning customer | [D09-L](screenshots-r1/D09-L.png) | [D09-D](screenshots-r1/D09-D.png) |
| D10 | Reorder / changes need review | [D10-L](screenshots-r1/D10-L.png) | [D10-D](screenshots-r1/D10-D.png) |
| D11 | Populated Cart / note collapsed | [D11-L](screenshots-r1/D11-L.png) | [D11-D](screenshots-r1/D11-D.png) |
| D12 | Populated Cart / one expanded note | [D12-L](screenshots-r1/D12-L.png) | [D12-D](screenshots-r1/D12-D.png) |
| D13 | Populated Cart / collapsed note summary | [D13-L](screenshots-r1/D13-L.png) | [D13-D](screenshots-r1/D13-D.png) |
| D14 | Kitchen note / keyboard-space illustration | [D14-L](screenshots-r1/D14-L.png) | [D14-D](screenshots-r1/D14-D.png) |
| D15 | Customer / paid, confirmation delayed | [D15-L](screenshots-r1/D15-L.png) | [D15-D](screenshots-r1/D15-D.png) |
| D16 | Customer / confirmation escalated | [D16-L](screenshots-r1/D16-L.png) | [D16-D](screenshots-r1/D16-D.png) |
| D17 | Delivery / guest appearance settings | [D17-L](screenshots-r1/D17-L.png) | [D17-D](screenshots-r1/D17-D.png) |
| P01 | Staff / invitation-only sign in | [P01-L](screenshots-r1/P01-L.png) | [P01-D](screenshots-r1/P01-D.png) |
| P02 | Staff / invitation required | [P02-L](screenshots-r1/P02-L.png) | [P02-D](screenshots-r1/P02-D.png) |
| P03 | Staff / access removed | [P03-L](screenshots-r1/P03-L.png) | [P03-D](screenshots-r1/P03-D.png) |
| P04 | Staff / outlet not permitted | [P04-L](screenshots-r1/P04-L.png) | [P04-D](screenshots-r1/P04-D.png) |
| P05 | Orders / paid and POS pending | [P05-L](screenshots-r1/P05-L.png) | [P05-D](screenshots-r1/P05-D.png) |
| P06 | KDS / current authorised feed | [P06-L](screenshots-r1/P06-L.png) | [P06-D](screenshots-r1/P06-D.png) |
| P07 | KDS / initial authorised load | [P07-L](screenshots-r1/P07-L.png) | [P07-D](screenshots-r1/P07-D.png) |
| P08 | KDS / verified empty feed | [P08-L](screenshots-r1/P08-L.png) | [P08-D](screenshots-r1/P08-D.png) |
| P09 | KDS / reconnecting, snapshot stale | [P09-L](screenshots-r1/P09-L.png) | [P09-D](screenshots-r1/P09-D.png) |
| P10 | KDS / listener or index failure | [P10-L](screenshots-r1/P10-L.png) | [P10-D](screenshots-r1/P10-D.png) |
| P11 | KDS / offline and resume safety | [P11-L](screenshots-r1/P11-L.png) | [P11-D](screenshots-r1/P11-D.png) |
| P12 | KDS / sound muted, visual alert | [P12-L](screenshots-r1/P12-L.png) | [P12-D](screenshots-r1/P12-D.png) |
| P13 | KDS / audio or permission unavailable | [P13-L](screenshots-r1/P13-L.png) | [P13-D](screenshots-r1/P13-D.png) |
| P14 | POS / two-minute staff alert | [P14-L](screenshots-r1/P14-L.png) | [P14-D](screenshots-r1/P14-D.png) |
| P15 | POS / five-minute escalation, uncertain send | [P15-L](screenshots-r1/P15-L.png) | [P15-D](screenshots-r1/P15-D.png) |
| P16 | Stock / saved, POS sync failed | [P16-L](screenshots-r1/P16-L.png) | [P16-D](screenshots-r1/P16-D.png) |
| P17 | Stock / save denied, unchanged | [P17-L](screenshots-r1/P17-L.png) | [P17-D](screenshots-r1/P17-D.png) |
| P18 | Stock / select one permitted outlet | [P18-L](screenshots-r1/P18-L.png) | [P18-D](screenshots-r1/P18-D.png) |
| P19 | Dispatch / booking outcome uncertain | [P19-L](screenshots-r1/P19-L.png) | [P19-D](screenshots-r1/P19-D.png) |
| P20 | Dispatch / confirmed request rejection | [P20-L](screenshots-r1/P20-L.png) | [P20-D](screenshots-r1/P20-D.png) |
| P21 | Partner / three-way appearance | [P21-L](screenshots-r1/P21-L.png) | [P21-D](screenshots-r1/P21-D.png) |

## Representative layout studies

| Full image ID | Width / type / spacing | PNG |
|---|---|---|
| D01-L-320 | 320 CSS px / 100% type / normal spacing | [Open](screenshots-r1/D01-L-320.png) |
| D01-D-768 | 768 CSS px / 100% type / normal spacing | [Open](screenshots-r1/D01-D-768.png) |
| D01-L-320-200 | 320 CSS px / 200% type / normal spacing | [Open](screenshots-r1/D01-L-320-200.png) |
| D04-D-320-200 | 320 CSS px / 200% type / normal spacing | [Open](screenshots-r1/D04-D-320-200.png) |
| D12-D-320-200 | 320 CSS px / 200% type / normal spacing | [Open](screenshots-r1/D12-D-320-200.png) |
| D12-L-390-spacing | 390 CSS px / 100% type / spacing override | [Open](screenshots-r1/D12-L-390-spacing.png) |
| D14-L-320 | 320 CSS px / 100% type / normal spacing | [Open](screenshots-r1/D14-L-320.png) |
| D17-D-320-200 | 320 CSS px / 200% type / normal spacing | [Open](screenshots-r1/D17-D-320-200.png) |
| P05-L-320 | 320 CSS px / 100% type / normal spacing | [Open](screenshots-r1/P05-L-320.png) |
| P06-D-390 | 390 CSS px / 100% type / normal spacing | [Open](screenshots-r1/P06-D-390.png) |
| P16-L-320-200 | 320 CSS px / 200% type / normal spacing | [Open](screenshots-r1/P16-L-320-200.png) |
| P19-D-390-spacing | 390 CSS px / 100% type / spacing override | [Open](screenshots-r1/P19-D-390-spacing.png) |
| P21-L-320-200 | 320 CSS px / 200% type / normal spacing | [Open](screenshots-r1/P21-L-320-200.png) |

## Evidence limits

These are isolated local HTML/Chromium renders. Every state is a designed scenario, not observed application behaviour. Native gestures, bounded network queries, note persistence/Unicode boundaries, real keyboard/safe area, auth/rules, payment/POS reconciliation, stock propagation, alerts/push, courier contracts and store review remain separate unexecuted gates.

Petpooja stays in scope, Borzo/Shadowfax contracts remain owner-controlled, Porter is retired, and Reelo is investigation-only. Original 3 November RC / 8 November public targets are unchanged and are not guaranteed.

The font licence is retained in `assets/Inter-OFL.txt`. The mascot and selected photos remain internal-review assets, not approved store creative.
