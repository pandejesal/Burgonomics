# Lane 03 — customer menu / gesture / search / a11y closeout

Status: CLOSED locally. `SUPERVISOR_STATE: COMPLETE` reported in
`run-20261023-free/customer-menu-a11y-closeout.report.md`.

## Commit

- Repo: `burgonomics-foundation-core` (customer), branch `ui-sweep`
- Base: `ea1bc3f14990f2a484c0480043d786f3e632c4c7`
- Commit: `7affdf698576110a64e008a492f2d8380abe2d58` (`7affdf6`)
- 15 paths, 1045 insertions, 87 deletions
- Not pushed. Upstream `origin/ui-sweep` untouched.
- Foreign work preserved: 22 dirty/untracked entries remain after the commit.

## Paths and blobs (frozen; also in `run-20261023-free/evidence/manifest.txt`)

Production (9):

| path | blob |
| --- | --- |
| src/features/menu/components/MenuProductCard.tsx | a80d45c0881c |
| src/features/menu/components/CategoryPills.tsx | 77e76e4173a1 |
| src/features/menu/components/CategoryNavRail.tsx | a51e246f4356 |
| src/features/menu/components/QuantityStepper.tsx | 01efcd975822 |
| src/features/menu/repositories/MenuRepository.ts | 5e1827ad1df5 |
| src/features/menu/services/menuService.ts | 39ac54848c1c |
| src/features/menu/state/searchStore.ts | efd07d0799a1 |
| src/features/home/components/CategoryGrid.tsx | 4e5b3098b3e0 |
| src/features/favorites/components/FavoriteHeart.tsx | 555be1feb48c |

Tests (6):

| path | blob |
| --- | --- |
| src/features/menu/components/MenuProductCard.test.tsx | 9d3207d05ad3 |
| src/features/menu/components/CategoryNavRail.test.tsx | d4f5e3df0800 |
| src/features/menu/components/QuantityStepper.test.tsx | 203b9c194e46 |
| src/features/menu/utils/categorySwipe.test.ts | ad301740c65a |
| src/features/favorites/components/FavoriteHeart.test.tsx | 40677f8362f3 |
| tests/search-state-races.test.ts | c1c7a00670b3 |

Parity: all 15 `HEAD:` blobs, the working-tree blobs, the gate worktree copies and
the manifest agree (`parity_failures=0`).

## Excluded on purpose

- `src/features/menu/utils/probe-import.test.ts` — user scratch smoke test, left
  untracked (not deleted, not committed).
- `src/styles.css`, `tests/token-accessibility.test.ts`,
  `tests/primary-cta-contrast.test.tsx` — out of the reviewed packet, left dirty.
- `AddressFormModal.a11y.test.tsx` — lane 01 owns it; untouched.

## RED control

Pristine `ea1bc3f` in `%LOCALAPPDATA%\Temp\opencode\lane03-red-ea1bc3f` with only
the 6 bundle test files overlaid, production untouched:

- 5 of 6 files failed, 21 of 41 tests failed, exit 1
- MenuProductCard 9/17, CategoryNavRail 1/1, QuantityStepper 1/4,
  FavoriteHeart 1/5, search-state-races 9/9
- `categorySwipe.test.ts` passed at base by design: the repaired test is a
  regression guard for refusal behaviour that already worked; the production fix
  it protects is in `CategoryNavRail.tsx`.
- Log: `run-20261023-free/evidence/lane-03-red.txt`

## Isolated gate

Worktree at `ea1bc3f` + exactly the 15 paths (`git status --porcelain` = 15
entries, every blob identical to the candidate):

- `npx tsc --noEmit` → exit 0 (`evidence/lane-03-gate-typecheck.txt`)
- `npx vitest run --no-file-parallelism <6 bundle files> src/features/menu`
  → 12 files / 89 tests passed, exit 0 (`evidence/lane-03-gate-test.txt`);
  the bundle alone is 6 files / 41 tests
- `npm run build` → exit 0, built in 7.21s (`evidence/lane-03-gate-build.txt`)

## Independent review

- Model: `opencode/glm-5.3-flash-free` (author was DeepSeek V4.1 Flash Free, so the
  reviewer is a different zero-cost model)
- Session: `ses_e98eed815ffeBkrSwhVsiM4mKM`, foreground, read-only, no descendants
- Verdict: **APPROVE_WITH_NOTES** — no blocker, no major
- Earlier pass returned APPROVE_WITH_CHANGES; all four findings applied before the
  commit (per-list last-wins guards, two extra race tests, corrected CategoryPills
  comment) and re-verified by the final reviewer.
- Remaining notes are prettier-only and were deliberately left unapplied so that
  reviewed bytes stay identical to committed bytes:
  - `searchStore.ts` two `set({...})` calls exceed `printWidth: 100`
  - `search-state-races.test.ts` uses single quotes against `singleQuote: false`
  - `categorySwipe.test.ts` final `});` has a stray two-space indent
  The reviewer confirmed the repo is not prettier-clean at base, so this is not a
  new merge-blocking condition.

## Remaining limits (honest)

1. Clicking a search kind tab still does not re-run the search. Pre-existing at
   `ea1bc3f`, unchanged by this commit; the new sequence guard only discards the
   in-flight response sooner.
2. During a store switch with a typed query, the previous store's rows stay on
   screen for up to ~300ms until the debounce fires. The guards prevent the late
   response from *overwriting* the new store's data, which is what was promised.
3. `CategoryGrid` now passes `?category=` to `/menu`; that the route consumes it is
   inferred from `CategoryNavRail`'s deep-link effect, not asserted by a test.
4. No browser/Playwright leg was executed for this packet; the touch-target and
   refusal proofs are unit/DOM-level.
5. `lane03-gate-ea1bc3f` and `lane03-red-ea1bc3f` are still registered at
   `ea1bc3f` as evidence. No forced worktree deletion was used, per policy.

## Resumable snapshot

Everything needed to continue is committed plus the three evidence logs and the
manifest. Remaining optional work is the prettier pass (and gate + review rerun if
that is taken), the kind-tab re-search defect, and the browser legs.
