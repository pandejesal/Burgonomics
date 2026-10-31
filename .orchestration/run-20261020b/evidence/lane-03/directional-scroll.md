# Lane 03 evidence — `useDirectionalScroll` vertical-axis hijack

Session `ses_ea5c8a0adffeoN03VVsv7saRMK` (lane 03, model `opencode/deepseek-v4.1-flash-free`,
parentID null). Repo `burgonomics-foundation-core`, branch `ui-sweep`, base HEAD `29fd0e6`.

## Defect

`src/shared/hooks/useDirectionalScroll.ts` (tracked, clean before this change) cancelled the
vertical axis:

```ts
} else if (locked === "y") {
  if (e.cancelable) e.preventDefault();
  window.scrollBy({ top: -moveDy, left: 0, behavior: "auto" });   // + rAF inertia on release
}
```

Its only live consumer, `features/home/components/HorizontalRail.tsx`, sets `touch-action: pan-y`
and documents "native momentum scroll-snap": the CSS already hands the vertical axis to the
browser. The hook overrode that and drove `window` directly, so

- the nearest scrollable ancestor was ignored (a 300px `overflow-y` panel / sheet body stayed put
  while the page behind it moved), and
- native momentum, overscroll and scroll chaining were replaced by a hand-rolled rAF loop.

Git history confirms this was a regression of the hook's own original contract: `6e2ccb5` shipped
it with "native vertical/diagonal pan gestures bubble cleanly to the document"; `19f85ac` added the
vertical hijack.

## Repro at HEAD (before the fix)

`npx --no-install playwright test -c tests/playwright/playwright.directional-scroll.config.ts`
(run from the customer app dir; Playwright resolves from the workspace root, the app declares no
Playwright dependency; Chromium, file:// fixture, shipped hook bundled at test time with esbuild,
CDP touch):

```
x  1 ... a vertical drag that starts on the rail scrolls the panel, not the window
      Error: panel must consume the vertical drag — Expected: > 0, Received: 0
x  2 ... the rail never cancels a vertical touchmove
      Error: vertical touchmove must stay native — Expected: 0, Received: 6
ok 3 ... horizontal drags still belong to the rail
ok 4 ... a vertical drag outside the rail still scrolls the page natively
2 failed, 2 passed
```

Drag `(200,110) -> (204,30)` starts inside a 120px rail nested in a 300px scrollable panel:
6/6 vertical `touchmove`s were `defaultPrevented` and `panel.scrollTop` never moved. Tests 1 and 2
carry their own liveness anchor first (a horizontal drag that only the shipped hook can satisfy),
so they cannot pass on a page where the hook is absent. Red control was captured by bundling the
HEAD blob from `git show HEAD:...` into a throwaway copy of the spec; the real files were never
mutated.

Same pin under vitest against the pre-fix source (throwaway copy, folder deleted):

```
src/shared/hooks/.tmp-head-check/head.test.ts (5 tests | 3 failed)
  x leaves a vertical drag to the browser instead of cancelling it
  x does not replay a vertical drag as manual scrolling on release  (window.scrollBy called 2x, top:-60)
  x keeps the axis lock for the rest of the gesture
  ok still drives the rail horizontally, including cancelling the browser's pan
  ok resets the axis lock for the next gesture
```

## Fix

`src/shared/hooks/useDirectionalScroll.ts`, one behavioral hunk plus dead-state removal:

- vertical touchmoves are no longer cancelled and no longer replayed on `window`;
- the vertical `rAF` inertia branch is gone; `lastY` / `moveDy` / `vy` / the `y` field of the
  sample ring are gone (nothing read them any more);
- the axis lock and the horizontal drag + horizontal inertia are unchanged;
- multi-touch guards (found by the GLM verifier / DS delta review, pre-existing hole): a new `touchstart`
  cancels a running animation and clears the axis lock before the multi-touch bail-out; `touchend`
  returns while another finger is still down; `touchcancel` always disarms (lock, samples and any
  armed inertia) even when a touch point is still reported; and the hook re-bases on the finger that
  is actually moving (`activeId`), because after a pinch the remaining finger used to be measured
  against the finger that started the gesture. Consequence: after a pinch the remaining finger's
  first move is consumed by the re-base before it can drive the rail — intended.

No API, prop or signature change. `HorizontalRail.tsx` untouched.

## After the fix

- Playwright: `4 passed (41.1s)` — including the two that failed at HEAD.
- `npx vitest run src/shared/hooks/useDirectionalScroll.test.ts` -> `9 passed` (2 absence pins,
  3 liveness/axis pins, 4 multi-touch pins).
- `npx vitest run src/shared` -> `4 files / 39 tests passed`.
- `npx tsc --noEmit` -> exit 0.
- Red control with the FINAL unit file against the HEAD blob: `6 failed | 3 passed` (the three
  survivors are the horizontal pins that legitimately hold at HEAD too).

## Reviews

- DS (independent child `ses_ea4b83a53ffeINkd4gcDSRGTkS`, model `opencode/deepseek-v4.1-flash-free`,
  read-only): **APPROVE_WITH_CHANGES**, 0 blockers, 0 majors. Findings applied: dead `y` sample
  state and the no-op vertical branch in `onEnd`; absence-only browser assertions (added liveness
  drags + docblock split); invisible rAF exceptions (page-error and console-error collection
  asserted per test); unused `preventedHorizontal` probe field; the false "see README for the run
  command" pointer (corrected in the config and in this file — `tests/playwright/README.md` at
  `29fd0e6` documents only the AppButton and gesture suites).
- GLM (independent child `ses_ea4a63b22ffeFLYfWI3vQCT7PW`, model `opencode/glm-5.3-flash-free`,
  read-only): **VERIFIED_WITH_RESIDUALS**, commit-safe; one Medium (stale gesture origin after a
  pinch — see the multi-touch guards above), two Low (no red control for the pinch pins; armed
  inertia on a partial `touchcancel`) and Infos. All applied.
- DS delta re-check after the above: **MAJOR** — three of the new multi-touch tests were green
  against the pre-delta source, because jsdom dispatches in one tick (`dt <= 10` means the settle
  path can never arm inertia) and the chosen re-base coordinates could not mislock. Rewritten: the
  settle/cancel tests now wait 25 ms so `dt > 10` and spy `requestAnimationFrame`; the re-base test
  now asserts the exact `scrollLeft` that differs between stale and re-based origins. Re-verified
  red at HEAD (`6 failed | 3 passed`).

## Gate + commit

- Base: prepared at `29fd0e6`; lane07 (`355ba9f`) and lane01 (`530dd20`) landed while gating, so the
  bundle was re-gated at the new tip `530dd20` before committing.
- Method: detached worktree `Temp/opencode/lane03-cust-530dd20` at `530dd20`, `node_modules`
  junction, overlay of exactly the four paths (`git status` inside == those four), byte parity
  SHA256 verified, no stash, shared tree untouched, worktree removed afterwards.
- Counts in the snapshot: `npx tsc --noEmit` -> 0; `npx vitest run src/shared` -> 2 files /
  13 passed; `npx vitest run --exclude 'tests/rules/**'` -> 537 passed / 1 failed / 538, the single
  failure (`tests/payments-contract.test.ts`) reproducing at a pristine `29fd0e6` worktree;
  `npm run build` -> clean in 16.75s.
- Browser leg: the root Playwright runner cannot resolve `@playwright/test` from a Temp worktree
  (ESM ignores `NODE_PATH`), so the four Chromium tests ran in the shared tree against the
  byte-identical hook (`E9A527CB...DDA219F`): 4 passed. Same spec against the pre-fix blob: 2 failed.
- Commit: `2801d17cb91e15fc523d768c2d2fbee8961ed69d` on `ui-sweep`, parent `530dd20`, exactly four
  paths, local only, never pushed. (The first attempt `0d04306` carried a UTF-8 BOM at the start of
  the subject from PowerShell and was amended to strip it; identical tree.)

## Labels

LOCAL CODE VERIFIED for the pre-fix repro and the post-fix rerun on the dirty working tree at
`29fd0e6`. Not yet an isolated exact-bundle gate, not committed, not deployed, no device/emulator
E2E. Android/iOS behaviour is inferred from Chromium touch semantics + `touch-action: pan-y`;
`19f85ac` had claimed a device check for the removed branch, so one real-device swipe remains the
honest remaining gap before any device-level claim.
