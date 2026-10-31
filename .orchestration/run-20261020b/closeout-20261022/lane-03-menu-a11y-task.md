# Existing session: close the customer menu / gesture / accessibility packet

Queue task: `customer-menu-a11y-closeout`. Owner: original root03
`ses_ea5c8a0adffeoN03VVsv7saRMK` (DeepSeek V4.1 Flash Free). No replacement writer.
Read `AUTONOMOUS_WINDOW.md`. Deadline 2026-10-22T03:05:59Z. Main is coordinator only.

## What already exists (adopt the existing work; do not start a fresh sweep)

CUSTOMER repo `burgonomics-foundation-core` at HEAD `2f47cef` (the address packet
`6e25a0c` is already committed on top of it). Uncommitted lane03 work:

- menu truth: `src/features/menu/repositories/MenuRepository.ts` (+5),
  `src/features/menu/services/menuService.ts` (+81),
  `src/features/menu/components/MenuProductCard.tsx` (+80),
  `src/features/menu/components/MenuProductCard.test.tsx` (+223),
  `src/features/menu/components/CategoryPills.tsx` (+6)
- search state: `src/features/menu/state/searchStore.ts` (+81)
- gestures: `src/features/menu/components/CategoryNavRail.tsx` (+56),
  `src/features/menu/components/QuantityStepper.tsx` (+10),
  `src/features/home/components/CategoryGrid.tsx` (+5),
  `src/features/favorites/components/FavoriteHeart.tsx` (+9)
- shared/a11y: `src/shared/components/common/ConsumerRouteTransition.tsx` (+40),
  `src/styles.css` (+87)
- new tests: `CategoryNavRail.test.tsx` (39), `QuantityStepper.test.tsx` (85),
  `src/features/menu/utils/categorySwipe.test.ts` (78),
  `src/features/menu/utils/probe-import.test.ts` (12),
  `FavoriteHeart.test.tsx` (127), `AppButton.test.tsx` (265),
  `ConsumerRouteTransition.test.tsx` (201), `tests/primary-cta-contrast.test.tsx` (329),
  `tests/token-accessibility.test.ts` (263), `tests/search-state-races.test.ts` (99),
  `src/features/profile/components/AddressFormModal.a11y.test.tsx` (492)

`src/features/menu/utils/categorySwipe.ts` may already be committed; verify before
assuming. `tests/playwright/**` harnesses exist but a prebuilt harness HTML file is
NOT coverage — do not claim browser coverage you did not execute.

## Exact sole-writer scope (CUSTOMER repo only)

Every path listed above, plus `src/features/menu/utils/categorySwipe.ts` if it is still
uncommitted, plus `tests/playwright/ui-a11y-gestures.spec.ts` and
`tests/playwright/ui-a11y-gestures.config.ts` ONLY if you actually run them.
Evidence: `closeout-20261022/lane-03.md`.

Explicitly OUT of scope: the PARTNER repo (lane02 currently owns partner delivery and
has a parked partner MenuPage/useMenu honesty diff — do not touch partner files, not
even `src/index.css`), payment files (lane08 owns them now), address files (already
committed in `6e25a0c`; `AddressFormModal.a11y.test.tsx` may be included only if it
passes against the committed address code), Functions, rules, native.

## Required outcome

- Menu presentation must reflect REAL availability: sold-out / unavailable items are
  shown truthfully and cannot be ordered or quick-added; no optimistic fiction, no
  fabricated catalogue fields. Prove the unavailable path and the available path.
- Search state must not race: a slow response for a previous query must not overwrite
  a newer result set; stale results must not be displayed as current. Prove both
  orders with a delayed-response test.
- Gestures: swipe category navigation must not steal or break the native back
  gesture, must be reversible, and must respect `prefers-reduced-motion`.
- Accessibility: the primary CTA label contrast, focus visibility and touch-target
  size must be measured against WCAG 2.2 AA numbers in the test (4.5:1 body text,
  3:1 large text and control boundaries, 24x24 minimum target with its exceptions).
  A test that asserts "has a class" is not an accessibility proof — assert the
  computed value or the token value.
- `AppButton` must not fire a synthetic form submit or swallow a rejected haptic
  promise; `ConsumerRouteTransition` must not trap focus or announce incorrectly.
- If any existing test in this set fails against committed source, that is a finding:
  reproduce it, fix it in scope, and keep it as a regression. Do not delete or weaken a
  test to get green, and do not weaken production code to manufacture RED.
- If a test cannot be made meaningful within scope, say so and report it as an open
  item instead of committing a hollow assertion.

## Reviews, gate, commit

Freeze the final changed paths with immutable copies + Git blobs + SHA256. Prove the
final tests RED over pristine committed source and GREEN over the candidate.
ONE fresh read-only actual DeepSeek Free reviewer child, THEN a DIFFERENT fresh
read-only actual GLM Free verifier child; verify actual serving models via the local
session API; reviewers spawn no children and write nothing. Apply findings, refreeze.
On 429/transport stop and report the timestamp.

CUSTOMER heavy-gate slot: currently held by lane08 (payments). Do not run a second
CUSTOMER heavy gate; ask on the bus and use the waiting time for focused tests and
review prep. When granted, run in an isolated worktree at `2f47cef` plus ONLY your
reviewed paths: `npx --no-install tsc --noEmit`, `npm test -- --maxWorkers=2`,
`npm run build`, and capture real exits/counts.

Commit only reviewed paths locally; verify committed blobs against the manifest;
preserve all foreign work (90+ dirty paths exist); no push/deploy.

Report `QUEUE_TASK: customer-menu-a11y-closeout` with commit or BLOCKED, hashes,
RED/GREEN, both review IDs + actual models, gate exits, and the honest list of what
you could not close. End with the exact unquoted final line
`SUPERVISOR_STATE: COMPLETE` only when the packet is really closed.
