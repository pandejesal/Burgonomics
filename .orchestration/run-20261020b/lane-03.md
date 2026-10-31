# Lane 03 — Menu, design system, gestures, accessibility

Mission: both apps look and feel like one coherent product and are usable with
touch, swipe, keyboard, and reduced motion. Menu presentation must reflect real
availability, not optimistic fiction.

Owned:
- Customer `src/shared/**` (components, theme tokens, layouts, navigation, shared
  hooks, platform wrappers), `tests/playwright/**`, Playwright configs.
- Partner `src/shared/**`, `src/index.css`.
- Cross-app a11y/gesture evidence files under the run evidence dir.

Do not touch: customer routes (lane 01), partner pages (lane 02), Functions, native.

First actions:
1. Read CONTRACT/BASELINE/LANES; inspect both apps' shared layers and the existing
   Playwright harnesses. Re-run a small subset to confirm the harness actually works.
2. Pick one concrete, user-visible defect: e.g. double-submit, missing focus ring,
   sub-44px touch target, broken swipe/back behavior, stale menu availability badge.
   Reproduce it in a real browser test before fixing.
3. Claim exact shared files; fix; add regression; DS then GLM; gate; commit.

Known debt: `AppButton` previously fired a synthetic form submit and blocked on a
rejected haptic promise. Verify the current committed state before doing anything.
If not fixed, coordinate with lane 01 rather than duplicating; ownership of
`AppButton.tsx` is yours once claimed.
Menu presentation: use real catalogue fields; show sold-out/unavailable truthfully.
No redesign that changes product intent without a written conflict note.

Constraints: root Playwright runner convention may be required; do not add packages
without an approved claim. No prebuilt harness HTML claimed as coverage.
