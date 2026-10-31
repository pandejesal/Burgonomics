QUEUE_TASK: customer-menu-a11y-closeout

Closed the menu/search/a11y packet in local commit `7affdf6` (base `ea1bc3f`), 15 paths, 1045+/87-. 22 foreign dirty entries untouched; nothing pushed.

**Production (9).** `MenuProductCard.tsx` shows real servings-left availability and suppresses ADD when sold out; `CategoryNavRail.tsx` gives the rail real end space and stops fighting manual scroll; `CategoryPills.tsx` takes the 44px floor (`a80d45c`, `a51e246`, `77e76e4`). `QuantityStepper.tsx`, `FavoriteHeart.tsx` (44px wrapper, 36px disc), `CategoryGrid.tsx` meet the same floor (`01efcd9`, `555be1f`, `4e5b309`). `searchStore.ts` adds last-wins guards for search, trending and suggestions plus store-scope invalidation (`efd07d0`); `MenuRepository.search`/`menuService` move page/pageSize to an opts object (`5e1827a`, `39ac548`).

**Tests (6).** `MenuProductCard.test.tsx` (17), `CategoryNavRail.test.tsx`, `QuantityStepper.test.tsx`, `FavoriteHeart.test.tsx`, repaired `categorySwipe.test.ts` (refused-swipe click suppression replaces the vacuous stale-URL test) and new `search-state-races.test.ts` (9) — 41 tests.

**RED.** Pristine `ea1bc3f` with only those 6 test files overlaid: 5 files / 21 tests failed (MenuProductCard 9, CategoryNavRail 1, QuantityStepper 1, FavoriteHeart 1, search races 9/9), exit 1. `categorySwipe` passes at base by design: it is a regression guard for existing refusal behaviour. `evidence/lane-03-red.txt`.

**GREEN.** Isolated gate worktree at `ea1bc3f` + exactly these 15 paths (`git status` 15 entries, blobs byte-identical): `tsc --noEmit` 0; `vitest --no-file-parallelism` 12 files / 89 tests passed (bundle 6/41 included); `npm run build` 0 (7.21s). `evidence/lane-03-gate-{typecheck,test,build}.txt`.

**Blob parity.** All 15 `HEAD:` blobs and working-tree blobs equal `evidence/manifest.txt` (refreshed after the review edits); `parity_failures=0`.

**Review.** Ran after the commit, read-only, on `opencode/glm-5.3-flash-free` (author is DeepSeek), child `ses_e98eed815ffeBkrSwhVsiM4mKM` — **APPROVE_WITH_NOTES**, no blocker, no major. `HEAD:` blobs were re-checked against the manifest afterwards, so the reviewed bytes are the committed bytes. Four earlier findings (per-list sequence guards, two race tests, corrected CategoryPills comment) verified applied. Notes are prettier-only (`searchStore.ts:76,173` line width, single quotes in `search-state-races.test.ts`, one stray indent) and deliberately not applied so reviewed blobs stay identical to committed blobs; the reviewer confirms the repo is not prettier-clean at base.

**Remaining limits.** (1) Kind-tab click still does not re-search — pre-existing at base, unchanged here. (2) A store switch with a typed query shows the old store's rows for ~300ms until the debounce fires; the guards only stop the late response from overwriting the new one. (3) `CategoryGrid` now passes `?category=` on `/menu`; the route read is inferred, not asserted. (4) `probe-import.test.ts` is user scratch and stays untracked. (5) My gate and red worktrees are left registered at `ea1bc3f` as evidence (no forced removal used).

SUPERVISOR_STATE: COMPLETE
