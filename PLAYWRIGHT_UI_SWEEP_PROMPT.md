# UI/UX Screenshot Sweep Campaign — Hermes-driven, opencode-executed

## 0. Constants (Hermes: edit these, nothing else)

- `OUTER_ITERATIONS = 10` — run the worker loop this many times (change to run more/fewer).
- `STOP_EARLY_AFTER = 2` — stop early if this many consecutive iterations return zero new flaws.
- `STATE_FILE = <repo-root>/UI_SWEEP_STATE.md` — ban list + iteration log; committed every loop.
- `VIEWPORT_MOBILE = 390x844`, `VIEWPORT_TABLET = 768x1024` (tablet sweep in iteration 8 only).
- `SHOT_DIR = <Temp>/ui-shots/<iteration>/` — PNGs live here; **never commit screenshots**.
- Repos: root `functions/` (untouched by this campaign), `burgonomics-partner` (branch `feat/partner-device-smoke`), `burgonomics-foundation-core` (branch `main`). Push each touched repo separately via gh auth. Never push with embedded tokens. Never commit unrelated dirty files — scoped commits only.

## 1. Hermes driver protocol (outer loop — Hermes runs this, NOT the worker)

1. Read `STATE_FILE` (create it on iteration 1 with an empty ban list).
2. Open a **fresh** opencode session. Send it Part 2 (worker protocol) with this header filled in: `ITERATION = <n> | FOCUS_SCREENS = <from the rotation below> | BAN_LIST = <verbatim list> | PRIOR_SUMMARIES = <last 2 iteration summaries>`.
3. Iteration focus rotation: 1 = splash kill + harness + baselines (both apps) · 2 = core home+menu · 3 = core cart+checkout · 4 = core payment+support+offers+stores · 5 = core auth+about+privacy · 6 = partner login+admin-login · 7 = shared components (both apps, fix at source) · 8 = tablet re-sweep top screens · 9 = full re-sweep verify · 10 = final verify + handoff.
4. Collect the worker's HANDOFF summary. Append it + any new ban entries to `STATE_FILE`.
5. Stop when `n == OUTER_ITERATIONS`, or `STOP_EARLY_AFTER` consecutive zero-flaw iterations, or the worker reports an unfixable gate failure (then stop and report to the human with the worker's evidence).
6. Never run two worker sessions concurrently on the same repo.

## 2. Opencode worker protocol (inner loop — 15 steps, same every iteration)

You are the UI/UX sweep worker for **ITERATION = <n>**. Follow exactly 15 steps. **Step 1 plans and delegates; steps 2–15 execute. One agent per delegation; wait for each result. Do NOT start iteration n+1 yourself.**

**Step 1 — PLAN.** Read `STATE_FILE`. Restate iteration number, focus screens, and ban list. Form 1–3 flaw hypotheses per focus screen. Declare exact file scope for any coder delegation. Delegate the next steps. If a step has nothing to do (e.g., no second flaw), log `SKIP with reason` — never invent work.

**Step 2 — HARNESS.** If `scripts/ui-shots/capture.mjs` is missing, create it (Playwright, system Chrome via `executablePath`, mobile viewport; it takes base URLs + route list and writes PNGs + console errors to `SHOT_DIR`). Install once: `npm i @playwright/test` with `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` in a Temp scratch dir, never inside a repo. If the registry is unreachable: log the environment block verbatim with evidence and stop (do not fake screenshots).

**Step 3 — BUILD.** `vite build` the app(s) holding your focus screens (iteration 1: both apps).

**Step 4 — SERVE.** `vite preview --port <5191 partner / 5192 core>` per built app. Verify HTTP 200 before capturing.

**Step 5 — CAPTURE.** Screenshot every focus route (core public routes: `/ /menu /stores /offers /support /cart /checkout /payment /auth/login /about /privacy`; partner: `/login`, `/admin/login` — authed routes are OUT OF SCOPE without a session, log as skipped). Record console errors per route.

**Step 6 — ANALYZE (yourself, with your own eyes).** Open every PNG. List candidate flaws (layout breaks, jank risks, dead buttons, empty states without recovery, contrast, touch targets under 44px, dishonest copy, console errors). Discard anything on the ban list or fixed in a prior summary. Keep the top 1–2 NEW flaws with file:line hypotheses. If zero new flaws: skip to step 14 (log a no-op iteration).

**Step 7 — FIX #1.** One coder delegation, one task, exact change spec. Then read the diff yourself to confirm.

**Step 8 — FIX #2 (conditional).** Only if a second verified flaw exists; else `SKIP with reason`.

**Step 9 — ITERATION 1 ONLY: kill the Capacitor launch logo.** Verified ground truth (re-verify bytes before touching): partner Android `res/drawable*/splash.png` files ARE the Capacitor logo (blue mark on white); partner+core iOS `Splash.imageset/*.png` (3 files each, 1x/2x/3x universal slots) ARE the white/blue template glyph; core Android `drawable/splash.png` (320x480) IS the brand mascot on deep green `#0E4825` (reference art — keep it). Compose 2732x2732 brand masters (green `#0E4825` background + scaled mascot) and overwrite all 6 iOS PNGs (keep filenames and `Contents.json`) + all partner Android `splash.png` density/port variants. No config changes (`androidSplashResourceName: 'splash'` and the `Splash` imageset names stay). Rollback = `git checkout` the asset paths. (Other iterations: SKIP this step.)

**Step 10 — RE-SCREENSHOT** fixed screens; confirm each flaw visually fixed, no regressions elsewhere in frame.

**Step 11 — GATES** per touched repo. Partner: `npm run typecheck` + `npm test` + `npm run build`. Core: `npx tsc --noEmit` + `npx vitest run` + `npm run build`. Stop and report on any gate failure you cannot fix cleanly with the same one-task discipline.

**Step 12 — A11Y spot-check** on changed screens: labels associated, live regions where content changes, 44px targets, contrast sane.

**Step 13 — COMMIT + PUSH.** Scoped commits per repo (fix files only + state file), push each touched repo, record SHAs. Pre-existing dirty files are never yours — leave them alone.

**Step 14 — LOG.** Append to `STATE_FILE`: iteration number, screens shot, flaws fixed (file:line + before/after), flaws dismissed with reason, gates output, push SHAs, and new BAN entries (every fixed flaw's signature so later iterations never re-fix it).

**Step 15 — HANDOFF + STOP.** Output a compact summary (fixed / dismissed / gates / SHAs / ban deltas) and stop. Do not begin another iteration.

## 3. Standing rules (every iteration, no exceptions)

- Same instruction every loop on purpose: the ban list is what forces novelty — iteration N may only fix flaws absent from all prior summaries.
- Fail closed on money/auth; no mock/sample data in prod paths; no secrets in code or bundles.
- Screenshots and harness installs stay out of git. Only source fixes + `STATE_FILE` get committed.
- If Playwright/Chrome/serving is unavailable: log the environment block verbatim with evidence and stop (do not fake screenshots).
