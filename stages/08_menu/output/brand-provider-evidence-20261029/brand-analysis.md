# Burgonomics brand language — extracted from the owner PDF and website

Source: `Burgonomics Franchise PPT (6).pdf` (21 image-based slides, SHA-256
`5cc429e1465fbe9b9a2cc41c4e2a8c2735f8ff53a3403b4b0ce8c397448cf528`) and the
owner-designated website source at
`C:\Users\DELL\Desktop\BURGONOMICS WEBSITE\burgonomics final ebsite - Copy`
(`src/index.css` hash `...` recorded in `source-manifest.json` where applicable).

## What the deck actually does

| Trait | Observed in the PDF | App decision |
|---|---|---|
| Canvas | Deep forest green full-bleed fields behind white display type | Use green as a **section field**, not the whole app canvas. The app stays white/black for readability. |
| Display face | Heavy, condensed, slightly irregular uppercase display type ("REWARDS AND RECOGNITION") | Keep **MonstroSolid** for one brand headline per screen at 28px+; every other role stays Inter. |
| Accent | Gold/lime rule and confetti shards, orange food photography | Gold hairline + one orange accent only; no gold body text. |
| Photography | Large, warm, high-saturation food and ceremony photos, rounded corners | Full-bleed image blocks with 20–28px radius; no small decorative thumbnails for food. |
| Layout | Centred hero statement, then symmetric certificate/photo pairs | Awards read as a certificate + ceremony pair per award. |
| Voice | Confident, short, celebratory | Sentence case in the app; no all-caps body copy. |

## Non-negotiable balance

The deck is a **presentation**, not an interface. Its uppercase display type,
tight leading and gold-on-green decoration would fail app readability at 14–16px.
The app therefore borrows the *field, photography, rule and display moment* while
holding these lines:

- Body and metadata stay Inter at 16px/14px minimum, `1.5`–`1.65` leading.
- Body text on the green field is `#FFFFFF` or `#D8E8DE` (≥ 11:1 on `#0B2E1D`).
- Gold `#E9B949` is used for a 1px rule and small marks, never for prose.
- Display face is restricted to headings ≥ 28px; never for buttons, prices or
  instructions.
- Section headings keep sentence case in the accessible name even when the
  display face is uppercase by design.

## Website corroboration

The local site uses `#0d4429` green, `#E05D26` orange, Montserrat body and
MonstroSolid display, on a warm off-white canvas with large radii and soft green
shadows. The app's tokens already converge on the same family (`#0E4825`,
`#C2410C`), so the deck's language can be expressed with existing semantic tokens
rather than new raw colours.

## Measured contrast (WCAG 2.2, AA thresholds)

Computed from the shipped tokens, not estimated:

| Foreground | On `#0B2E1D` (light field) | On `#082415` (dark field) |
|---|---|---|
| `#FFFFFF` title | 14.76:1 | 16.49:1 |
| `#D8E8DE` supporting | 11.61:1 | 12.97:1 |
| `#B9CEC1` muted | 8.90:1 | 9.94:1 |
| `#E9B949` gold mark | 8.08:1 | 9.03:1 |

Body copy needs 4.5:1, large text 3:1. Every pairing in the awards panel is above
7:1, so the green field never trades brand for legibility. The gold is used for the
rule and the year beside a 16px title, never for a paragraph.

## Rejected

- All-green app background: fails the white-canvas direction the owner approved
  and reduces long-form readability.
- Gold body copy: contrast and legibility both worse than white on green.
- Certificate-only awards (no people): the deck pairs award proof with the team
  receiving it; both are kept, with descriptive alt text.
