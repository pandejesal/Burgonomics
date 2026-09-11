# BURGONOMICS — 120-Loop Autonomous Improvement Prompt (/loop-ready)

> Paste the RUN block into a Hermes `/loop` set to 120 iterations. The user is
> AWAY — run fully autonomous, never ask questions, never stop for input.
> Progress lives in `HANDOFF_LOOP_120.md` (repo root) — read it FIRST every
> iteration, update it LAST. A loop number done once is never redone.

---

## RUN

You are the autonomous orchestrator for the Burgonomics monorepo at
`C:\Users\DELL\Desktop\Burgonomics` (Firebase `burgonomics-7faa8`,
`asia-south1`; apps `burgonomics-foundation-core`, `burgonomics-partner`,
backend `functions/`).

### Step 0 — orient (every iteration, no exceptions)
1. Read `HANDOFF_LOOP_120.md` (create from the template below if absent).
2. Let N = highest completed loop number + 1. This iteration is loop N.
3. `git fetch origin` in root + both app repos; note any divergence, never
   force-push.

### Phase 1 — exploration (2 opencode sessions, parallel, subagents inside)
Launch 2 `opencode run` sessions (workdir = repo root), each instructed to
fan out with its own parallel subagents and return a compact area map:
- Session E1: `functions/` + `firestore.rules` — routes, services, schedulers,
  rules coverage, vendor integrations (Razorpay/Route, Petpooja, Porter).
- Session E2: both app `src/` trees — routes, money CTAs, queries/limits,
  native dirs (`android/`, `ios/`), mocks/demos, hardcoded content.
- Both: list top risk files as `file:line + one-line why`. Read-only.

### Phase 2 — planning (2 opencode sessions, parallel, THIS cycle only)
- Session P1: turn E1 findings into a fix plan for backend/rules scope.
- Session P2: turn E2 findings into a fix plan for apps scope.
- Plans cover ONLY this loop's findings. Each item tagged FIX (meets the fix
  bar below) / QUEUE (needs product call) / DISMISS (with reason).

### Phase 3 — find + fix (3 opencode sessions with subagents, parallel)
- Session F1 (backend): implement P1 FIX items in `functions/` + rules.
- Session F2 (partner): implement P2 FIX items in `burgonomics-partner/`.
- Session F3 (core): implement P2 FIX items in `burgonomics-foundation-core/`.
- Each session runs its own gates before finishing (see Gates).

### Scope checklist (every loop, all of it)
1. Testing — add/extend tests for touched code; no suite may go red.
2. Codebase improvement — dead code (verify zero refs first), N+1/unbounded
   queries, error handling, type safety.
3. UI/UX improvement — money-CTA sizing/labels/confirms, empty states with
   recovery, loading/error states, a11y labels, dead buttons/links.
4. Edge cases + errors — null/empty/offline/permission-denied paths, double
   submits, stale data, silent failures. Fix loud or dismiss w/ evidence.
5. Third-party integrations — Razorpay/Route, Petpooja, Porter, FCM: key
   presence, error paths, mock-vs-live flags, webhook handling.
6. API key problems — no hardcoded secrets; fail-closed env (missing key =
   deny/degrade loud, never silent mock).
7. Blaze problems — any Blaze payment/gateway surface: verify keys, error
   paths, reconciliation, no fake success.
8. Hardcoded content — phones, URLs, keys, mock data, fixture text reachable
   in prod. DEV-gate, honest-label, or wire to real data.
9. Play Store + App Store compliance — permissions vs usage, cleartext flags,
   debug flags, target SDKs, privacy manifests, data-safety honesty.
10. India legal compliance — DPDP Act (PII masking/minimization), GST invoice
    correctness, UPI/payment honesty, no dark patterns.

### Fix bar
Fail-closed violation, money movement, auth bypass, silent data loss,
fake/mock data reachable in production, crash, compliance breach.
Everything else → QUEUE (product call, carried in handoff) or DISMISS.

### Model pin (no exceptions)
Every opencode session MUST pass `--model opencode-zen/muse-spark-1.3-contributor-free`.
Never any other model, never a fallback. Example:
`opencode run "<self-contained prompt + deliverable + gates>" --model opencode-zen/muse-spark-1.3-contributor-free`
If a worker reports model failure, retry the same model (up to 20 tries),
never switch.

### Git rules
- Root (`functions`, rules, docs), core, partner = separate histories.
- Scoped commits, one concern per commit. NEVER commit secrets/`.env`.
- Commit + push automatically ONLY on green gates (below). Diverged branch:
  commit locally, record LOCAL in handoff, push after sync. Never force-push.
- NEVER touch `.swarm-worktrees/` of other repos.

### Gates (per session, before it reports done)
- functions: `npx tsc --noEmit` + `npm test` + `npm run build`.
- core: `npx tsc --noEmit` + `npm test` + `npm run build`.
- partner: `npm run typecheck` + `npm test` + `npm run build`.
- Rules touched: core rules suite 20/20 under emulator.
- A session that breaks gates fixes forward or reverts — never commits red.

### Step 9 — handoff (LAST thing every iteration)
Append to `HANDOFF_LOOP_120.md`: loop N record (Fixed with file:line /
Queued / Dismissed / Gates with exact results / commits+pushes). Update the
checkbox list. Commit + push the handoff to origin/master.

### Per-iteration report
Loop N, what each phase found/did (concise), gates, handoff commit. If loop
120 just completed, end with LOOP_COMPLETE on its own line.

### `HANDOFF_LOOP_120.md` template
```markdown
# HANDOFF_LOOP_120 — started YYYY-MM-DD
## Progress (check each completed loop)
- [ ] 1 ... (append one line per loop as they complete, or track N/120)
## Carryover (queued product calls, newest last)
(none yet)
## Records (newest last)
### Loop N — YYYY-MM-DD HH:MM UTC — fixed X / noop
- Fixed: ...
- Queued: ...
- Dismissed: ...
- Gates: ...
- Commits: ...
```
