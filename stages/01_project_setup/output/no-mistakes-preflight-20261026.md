# no-mistakes Preflight — 2026-10-26

**Document owner:** documenter worker (`no-mistakes-preflight-20261026.md` is its only deliverable)
**Phase status:** PH4 **PLANNED — NOT STARTED**
**Activity type:** readonly cross-phase planning preflight. No pipeline execution, no `init`, no `abort`, no rebase, no stage/commit/push, no install, no tests/build.
**Verdict:** `checks-passed` does **NOT** exist for this phase — no pipeline ran, so no validation is claimed.

---

## 1. Executive verdict

**BLOCKED at tool availability, before any Phase 4 work.**

The `no-mistakes` CLI is **not resolvable anywhere on this machine**. It was clearly installed and used
around 2026-10-24 → 2026-10-25 (state dir, run logs, and a still-running daemon exist), but the binary is
no longer on `PATH` and is absent from every standard install location probed.

Consequences, all directly measured rather than inferred:

| Phase 4 prerequisite | Result |
| --- | --- |
| CLI available | **NO** — unresolvable |
| Tool version | **UNKNOWN** — no binary to query |
| `axi run --help` reviewed | **NOT POSSIBLE** — binary absent |
| Review/fix worker routing flags known | **UNKNOWN** — see §7; this is the hard gate |
| `doctor` health check | **FAILED TO LAUNCH** — `CommandNotFoundException` |
| Repo initialization per project | **UNVERIFIED** — no CLI, no in-repo marker |
| Active-run state | **NOT CONFIRMED CLEAR** — see §6 |

Phase 4 must not begin until the CLI is restored **and** `axi run --help` has been read to establish the
real routing flag syntax.

---

## 2. Binary discovery — commands and actual results

| # | Command | Actual result | Exit |
| --- | --- | --- | --- |
| 1 | `Get-Command no-mistakes` | not found | — |
| 2 | `where.exe no-mistakes` | no output | **1** |
| 3 | `Get-Command nm / no_mistakes / nomistakes` | all not found | — |
| 4 | `PATH` entries matching `mistake` | **0 matches** | — |
| 5 | `npm root -g` → list `*mistake*` dirs | `C:\Users\DELL\AppData\Roaming\npm\node_modules`, no match | — |
| 6 | Probes: `%APPDATA%\npm\no-mistakes{,.cmd}`, `%USERPROFILE%\.bun\bin\no-mistakes{.exe,}`, `%LOCALAPPDATA%\pnpm\no-mistakes.cmd`, `%USERPROFILE%\AppData\Local\Yarn\bin\no-mistakes.cmd`, `%USERPROFILE%\go\bin\no-mistakes.exe`, `%LOCALAPPDATA%\Programs\no-mistakes\no-mistakes.exe`, `%USERPROFILE%\scoop\shims\no-mistakes.exe`, `C:\ProgramData\chocolatey\bin\no-mistakes.exe`, `%LOCALAPPDATA%\Microsoft\WinGet\Links\no-mistakes.exe`, `C:\Program Files\no-mistakes\no-mistakes.exe`, `%USERPROFILE%\.local\bin\no-mistakes.exe` | **all False** | — |
| 7 | Depth-2 recursive search of `%USERPROFILE%\go\bin` and `%LOCALAPPDATA%\Programs` with `-Filter no-mistakes*` | **no hits** | — |

- **Tool version:** unknown (not queryable).
- **Tool path:** none. No launcher, shim, or package directory found.

### `doctor` attempt — exact failure

```
no-mistakes doctor
  -> CommandNotFoundException:
     The term 'no-mistakes' is not recognized as the name of a cmdlet, function, script file,
     or operable program. Check the spelling of the name, or if a path was included, verify that
     the path is correct and try again.
     FullyQualifiedErrorId: CommandNotFoundException
```

The command never launched, so PowerShell produced **no exit code**. This is the exact blocker: not a
tool-reported health failure, but the tool being absent from the command resolution path.

`no-mistakes axi run --help` was deliberately **not attempted** — with the binary absent it would fail
identically and cannot produce flag documentation. No flag names or syntax were invented to fill the gap.

---

## 3. Toolchain-drift evidence (read-only, non-secret)

`C:\Users\DELL\.no-mistakes\` exists and contains: `eval/`, `evidence/`, `logs/`, `repos/`, `run-inputs/`,
`servers/`, `worktrees/`, plus `config.yaml`, `daemon.lock`, `daemon.pid`, `socket`, `state.sqlite`,
`state.sqlite-shm`, `state.sqlite-wal`, `update-check.json`.

**Not read:** `config.yaml`, `state.sqlite`, `run-inputs/*` contents, any env file, any credential or
provider configuration. Directory and file *names* only.

| Signal | Measured value |
| --- | --- |
| Daemon PID file | `{"pid":16672,"started_at":"2026-10-24T17:25:52.8950952Z"}` |
| Daemon process 16672 alive | **yes** |
| Newest run-log directory | `01M5R1PFQHPTCY694FZBN9PVK1`, mtime **2026-10-25 04:20** |
| Bare mirrors in `repos/` | 3 — `2b819705bd59.git`, `61ccc4ad073a.git`, `7be1a6d3f58c.git` |
| Dirs in `worktrees/` | 3 — same three hashes, each **not a git repository** (`fatal: not a git repository`), mtime 2026-10-25 04:04–04:55 |

**Interpretation:** the tool ran here ~2026-10-24/25 and was subsequently removed from `PATH`. The daemon
from that session is orphaned and still running. The `worktrees/` entries are stale cleanup artifacts, not
live checkouts. Nothing was stopped or cleaned — out of scope and not ours to touch.

---

## 4. Repository readiness — measured, per project

All three planned targets exist under `C:\Users\DELL\Desktop\Burgonomics\.swarm-worktrees` and are real
git working trees on non-default feature branches.

| Project dir | Branch | HEAD | Uncommitted (porcelain lines) | `package.json` | `.no-mistakes` | `no-mistakes.json` |
| --- | --- | --- | --- | --- | --- | --- |
| `polish-core-20261025` | `polish/core-20261025` | `038dff8` | 53 | yes | no | no |
| `polish-partner-data-20261025` | `polish/partner-data-20261025` | `0fa8d1b` | 45 | yes | no | no |
| `polish-backend-20261025` | `polish/backend-20261025` | `ac6cea2` | 7 | yes | no | no |

**Feature-branch precondition:** satisfied for all three (none is on the default branch).

**Uncommitted changes (53 / 45 / 7):** the user stated these are intentional. Recorded as a known
precondition. **Not** staged, committed, stashed, or reverted. Phase 4 must commit only task-owned changes
and preserve the rest.

### Initialization status — as measured, NOT guessed

- No in-repo init marker exists in any of the three worktrees (`.no-mistakes` and `no-mistakes.json` both absent).
- The orchestrator-level `repos/` holds **3** bare mirrors, so **at most three repositories** were initialized
  at some point — but the hash→repo mapping cannot be confirmed without the CLI (or reading `state.sqlite`,
  which is out of scope).
- **Therefore: initialization is UNKNOWN for each of the three projects.** Do not treat any as ready.

`no-mistakes init` was **not** run (explicitly forbidden, and the binary is missing anyway).

---

## 5. Active-run status

- `no-mistakes axi` (home view) **could not be run** — binary absent. This is the authoritative check and it
  did not happen.
- Indirect signals only:
  - newest run-log directory mtime **2026-10-25 04:20** (~2 days stale at time of writing),
  - **no** `*mistake*` run markers in any of the three target worktrees,
  - daemon alive but started 2026-10-24.
- **Conclusion:** no evidence of a live run, but this is **NOT CONFIRMED CLEAR**.

Phase 4's first action after the CLI is restored must be the `axi` home check. No unrelated run was touched,
inspected beyond the metadata above, or resumed.

---

## 6. Model routing — the hard block

The user permits **only** cheap models for review/fix workers:

- DeepSeek Go (current working model), opencode DeepSeek free, Phoenix DeepSeek, GLM free,
  Gemini 3.8 Flash, Iceman free.

Constraints: main GPT-6.1 Sol stays **orchestrator only** — it must not be pushed into the pipeline; and the
pipeline must not silently fall back to a premium adapter (e.g. Opus).

**Finding: no routing flag or option can be established.** `axi run --help` is unavailable, the skill's own
documentation lists only `--skip=<step>`, `--intent`, `--yes`, and `respond`'s `--action/--findings/
--instructions/--add-finding/--step` — **none of which select review or fix worker models**. There is no
documented mechanism to bind those workers to the allowed cheap models.

**Therefore:**
- It must **not** be assumed the pipeline inherits the working model. The default could be an expensive adapter.
- No flag was invented. No `--model`-style syntax is proposed here.
- Routing remains an **open hard blocker** requiring, at Phase 4 entry:
  1. the real `axi run --help` output,
  2. explicit user approval of the exact route setting,
  3. explicit user approval if that setting requires a **config write** (e.g. editing `~/.no-mistakes/config.yaml`).

---

## 7. Permission requirements at Phase 4 (none exercised now)

| Action | Status |
| --- | --- |
| Restore / install the CLI | **Not done** — user must authorize the method; no download or install occurred |
| `no-mistakes doctor` | Allowed once binary exists |
| `no-mistakes axi` home view | Allowed once binary exists; must precede any run |
| `no-mistakes axi run --help` | Allowed once binary exists; required before routing decisions |
| `no-mistakes init` per repo (writes orchestrator state) | **Needs explicit approval**, only if measured uninitialized |
| Commit / push / draft PR on the three polish branches | Pre-authorized by user for Phase 4 only |
| Merge, deploy, `--yes` unattended drives | **Forbidden** |
| Routing config write | **Needs explicit approval** |
| Tests / build / pipeline run | Phase 4 only — not in this preflight |

---

## 8. Blocked steps (explicit)

1. `no-mistakes doctor` — binary missing.
2. `no-mistakes axi` home view — binary missing; active-run status unresolved.
3. `no-mistakes axi run --help` — binary missing; routing flags unresolved.
4. Per-project init confirmation — no CLI, no in-repo marker.
5. Worker-model binding to the allowed cheap list — blocked on (3) and on user approval.
6. Any `axi run`, `respond`, `status`, `logs`, `abort` — all blocked on (1) and forbidden in this preflight.

---

## 9. Recommended next actions (in order)

1. **User restores the `no-mistakes` CLI** and confirms the resulting path/version. This is a tooling decision
   only the user can make; nothing was installed or downloaded here.
2. Run `no-mistakes doctor` and confirm health.
3. Run `no-mistakes axi` in **one** verified target cwd (`polish-backend-20261025` is the smallest surface at
   7 uncommitted lines) to confirm no active run.
4. Run `no-mistakes axi run --help` and record the **actual** routing flag syntax.
5. Bind review/fix workers to allowed cheap models **with user approval**, including approval for any config write.
6. Confirm init per project, then start Phase 4.

Until steps 1–5 complete, Phase 4 remains **PLANNED, NOT STARTED**.

---

## 10. Evidence provenance

Five readonly shell calls on 2026-10-26: (1) binary discovery + doc-absence + worktree listing,
(2) install-location probes + per-project git readiness, (3) `~/.no-mistakes` and skill-dir listing,
(4) targeted binary search + daemon probe, (5) `doctor` attempt + daemon liveness + run-log recency.
Call 4 exited 1 from a local PowerShell integer-cast bug inside the probe script; no repository or tool state
was modified.

Sanitized command log: `C:\Users\DELL\AppData\Local\Temp\opencode\polish-current\no-mistakes-preflight\command-log-20261026.txt`

No credentials, env files, `config.yaml`, or `state.sqlite` were read; no redaction was required.

**Status at close: PH4 PLANNED — NOT STARTED. Root blocker: `no-mistakes` not installed/resolvable.**

---

## 11. UPDATE 2026-10-26 — bounded CLI recovery (supersedes §1–§3 availability findings)

Bounded recovery was authorized and performed. Availability is **RESTORED**; Phase 4 remains **PLANNED, NOT STARTED**.
The §1–§3 "not installed" conclusion is corrected: the binary was **present but PATH-less**, not uninstalled.

**Corrections to earlier sections:**

| Earlier statement | Measured correction |
| --- | --- |
| Binary absent everywhere | Present at `C:\Users\DELL\AppData\Local\Temp\opencode\tools\no-mistakes\bin100\no-mistakes.exe`; simply not on `PATH` |
| Version unknown | **v1.100.1** (`c80c10f`), built 2026-10-23T13:29:08Z, release flagged **prerelease** |
| Daemon "orphaned" | **Live daemon** for this repo — `doctor`/`status` both report running; PID 16672 alive since 2026-10-24 22:55 |
| `worktrees/` artifacts stale | Confirmed stale/unused; unrelated to the three polish branches |

**Source verification (PASS):** official project `github.com/kunchenguid/no-mistakes`. Cached `nm100.zip`
sha256 `6053ebe2…` == GitHub release asset digest for `v1.100.1-windows-amd64.zip`; zip entry and on-disk exe
both `bdb10405…`; local `checksums2.txt` sha256 `26528df7…` == released `checksums.txt` digest. No install,
no download, no PATH change, no admin change; the verified binary was reused in place.

**Commands run (all exit 0):** `--version`, `--help`, `axi --help`, `axi run --help`, `axi` (home),
`doctor`, `status`. No `axi run`/`respond`/`abort`/`answer`, no `init`, no `--yes`.

**Initialization — resolved:** repo is **already initialized** (gate mirror `~/.no-mistakes/repos/2b819705bd59.git`,
`status` exits 0). No `.no-mistakes.yaml` exists in the main checkout or any polish worktree → built-in defaults.
**`init` is not required**, so the user's "ask before init" gate is not reached.

**Active run — resolved:** `no active run`. History: 8 runs, all `failed`, all on `stress-fixes-20261024-final`
(2026-10-24/25). Nothing resumed, cleared, or aborted.

**Pipeline agent — resolved:** `doctor` reports **`gate validation: opencode is runnable`**. Available agents:
codex, opencode, antigravity. Absent: claude, grok, pi, copilot, cursor, devin, acpx, rovodev.

**Routing — still UNBOUND (the remaining Phase 4 gate):** `--model` and `--effort` are **Pi-profile only**
("Requires Pi-only agents; raw native selection flags conflict"), and `pi` is **not installed**, so neither flag
can bind a cheap worker. There is **no `--agent` flag** and no review/fix-specific model flag; agent comes from
trusted config (`.no-mistakes.yaml` / global), and the *model* is chosen by **opencode's own configuration**.
Binding review/fix to DeepSeek Go therefore requires an **opencode config write outside no-mistakes → separate
user approval**. Pins are immutable per run, so this must be settled before any run starts.

> **Superseded by §12–§13.** The sentence above is wrong on one point: the model is *not* chosen by opencode's
> own configuration. It comes from no-mistakes' global `agent_config.opencode.model` and is transmitted in the
> session-creation body (`internal/agent/opencode_v2.go` `runV2`). No opencode config write is involved.

**Phase 4 entry conditions (unchanged):** (1) user decides whether to keep the `%TEMP%` path or make it durable;
(2) user approves the cheap-model binding path (opencode config); (3) only then `axi run --intent …` with
commits/push/draft PR. No merge, no deploy, no `--yes`.

Full recovery report: `%TEMP%\opencode\polish-current\no-mistakes-recovery\report.md`.
**PH4 remains PLANNED — NOT STARTED. No pipeline ran; no `checks-passed`.**

---

## 12. UPDATE 2026-10-26 — READONLY model-routing study (answer to the Phase 4 cost question)

Studied the verified binary's own source at commit `c80c10f` (matching v1.100.1) plus OpenCode V2 docs and the
installed CLI. No config write, no init, no pipeline, no inference, no daemon restart.

**Question:** can the OpenCode backend be forced to `opencode-go/deepseek-v4.1-flash` for pipeline children only,
without changing opencode's global/project model or the main/shared service?

**Answer: isolation YES, no-write NO.** The binding is expressible, but only by writing no-mistakes' **global**
`~/.no-mistakes/config.yaml`. There is no per-run flag for a non-Pi agent.

**Mechanism (source-cited):**

1. **Isolation is structural.** `internal/agent/opencode_http.go` `ensureServer` spawns a *private*
   `opencode serve`: `getAvailablePort()`, `buildOpencodeServeArgs` →
   `["serve", …, "--hostname","127.0.0.1","--port",<ephemeral>,"--print-logs"]`, plus `--stdio`,
   `holdStdin`, and a random per-server `OPENCODE_PASSWORD`/`OPENCODE_SERVER_PASSWORD` in child-only env.
   No `--service` is ever passed, so it is not the shared background service. Confirmed by
   `internal/agent/server.go` `startServerWithOptions` (`exec.Command`, `gitSafeEnvWithOverlay`, managed PID).
2. **Model rides the session body, never argv.** `opencode_v2.go` `runV2` sets
   `body["model"] = {providerID, id, variant}` on `POST /api/session` from `a.profile.Model`;
   V1 does the same in `messageBody` as `{providerID, modelID}`. `agentcfg` maps opencode's knobs as
   `MechanismRequest` because "`opencode serve` rejects model flags".
3. **Profile source is global-only.** `agent_config.opencode.model` must use `provider/model`
   (`requireProviderModel`), and the official global-config reference states `agent_config` and
   `review_agents` are **global-only** — a repository `.no-mistakes.yaml` block is ignored. Global config is
   reloaded at each run setup, so **no daemon restart is needed**.

**Exact proposed values (verified locally, NOT applied):** installed `opencode v2.1.2`; `opencode models`
lists `opencode-go/deepseek-v4.1-flash`.

```yaml
# ~/.no-mistakes/config.yaml   (global-only; repo copy ignored)
agent_config:
  opencode:
    model: opencode-go/deepseek-v4.1-flash
```

Optional hardening: `review_agents.reviewer` / `.fixer` with `agent: opencode` and the same model (they inherit
`agent_config` when empty). Do **not** add `--model` under `agent_args_override.opencode` — those args reach
`opencode serve` and would kill it. Do not use a bare model name (refused at config load).

**Unchanged by this:** main GPT-6.1 Sol session, opencode's global/project config, the shared service, and the
repo `.no-mistakes.yaml` files. **Blast radius:** the binding is machine-wide to no-mistakes, so any other repo
gated here that resolves to `opencode` would also use DeepSeek — the reason it requires approval.

**Why `--model` cannot be used:** `axi run --model/--effort` are Pi-profile only ("Requires Pi-only agents"),
and `pi` is absent. Per-run pinning is therefore unavailable for opencode.

**Rejected alternative:** a separate `NM_HOME` isolates the profile completely, but each `NM_HOME` has its own
state **and daemon** — it would require starting a second daemon and abandoning current state. Service change:
out of scope.

**Residual uncertainties (stated, not resolved):** (a) whether the `opencode-go` provider authenticates inside the
daemon-spawned child — expected via opencode's auth store, not measured (credentials not read); a failure would
fail the run, not silently swap models. (b) no-mistakes validates only the `provider/model` *shape*; a wrong
provider id fails at the API, fail-closed. (c) the per-session model reference is confirmed from adapter source,
not prose docs; installed `opencode 2.1.2` satisfies the adapter's `2.x` gate. (d) `--stdio` + password env is
no-mistakes' private contract with opencode, not a public CLI guarantee.

**Approval needed at Phase 4:** (1) the global `agent_config` write (machine-wide); (2) optional `review_agents`
block; no daemon restart and no `init` required. **PH4 remains PLANNED — NOT STARTED.**

---

## 13. UPDATE 2026-10-26 — gate-only binding VERIFIED (no write needed)

Approval for the global no-mistakes worker binding was exercised. **Outcome: `CONFIGURED_READY_FOR_PHASE4_PREFLIGHT`.
Writes performed: NONE** — the approved binding already existed and was preserved.

**Scoped state of `C:\Users\DELL\.no-mistakes\config.yaml`** (12,145 bytes, mtime 2026-10-24 22:55:28, unchanged
before and after; ACL unchanged: SYSTEM/Administrators/DELL FullControl):

| Scoped key | Value | Action |
| --- | --- | --- |
| `agent` | `opencode` | none — already explicit |
| `agent_config.opencode.model` | `opencode-go/deepseek-v4.1-flash` | none — already the approved literal |
| `review_agents` | absent | none — intentionally not added |

No other value was read; only top-level key **names** were enumerated to prove
`agent_args_override`, `agent_path_override`, `acp_registry_overrides`, `quota_routing` are absent.

**Safety gates (all real exits):** `no-mistakes status` → **0**, `no active run`, daemon running;
`no-mistakes doctor` → **0** with **`✓ gate validation  opencode is runnable`**; `opencode models` exact-match for
`opencode-go/deepseek-v4.1-flash` → **True**. No active run appeared at either check, so nothing was changed under
a live run.

**Why this is a complete binding, not a partial one:**

- `agent: opencode` is an explicit **scalar**. `auto` would have resolved to **codex** (installed, and ahead of
  opencode in the documented order), so the explicit value is what keeps the expensive backend out. An explicit
  agent that is unavailable fails closed before step 1 — there is no fallback chain to Codex/Antigravity.
- `agent_config.opencode.model` is the approved `provider/model` string; `agentcfg` maps opencode's knobs as
  `MechanismRequest`, and `opencode_v2.go` `runV2` sends it as `body["model"]` on `POST /api/session`
  (installed opencode is **v2.1.2**, so the V2 path is live).
- `review_roles.go` `reviewAgents.Run` routes `review` / `review-coverage` / `review-fix` through
  `pick(round, a.primary)`; with no role configured it returns the **primary** agent and its profile. Test,
  document, lint, PR and CI use the primary directly. **No path substitutes another harness.**
- Isolation unchanged: a private `opencode serve` on an ephemeral loopback port with `--stdio` and a random
  per-server password; `buildOpencodeServeArgs` never emits `--service`.

**`review_agents` deliberately not added:** with an explicit scalar `agent` and no fallback, review/fix already
inherit opencode + the model. A role pin would be inert today and would duplicate the model string, breaking
inheritance if the model changes. Documented optional shape (agent-only, model omitted → inherits) recorded in the
TEMP report for later use.

**Untouched, as required:** main GPT-6.1 Sol session, OpenCode global/project config (not read, not hashed),
shared background service, daemon PID 16672 (not killed/restarted), repo `.no-mistakes.yaml` files, git state.
No `init`, no `axi run`, no inference.

**Residual risk:** provider auth inside the daemon-spawned private child is **UNTESTED** until a gated Phase 4 run;
failure there is fail-closed, not a silent model swap. No fake auth was passed.

**This section asserts configuration readiness only — it is not a validation result. PH4 remains PLANNED — NOT STARTED.**

---

## 14. UPDATE 2026-10-26 — DRAFT-PR policy preflight (source-verified)

Readonly study of the pinned v1.100.1 source (`c80c10f`) for PR creation, reuse and the ready transition.
**No config write, no PR, no pipeline run.** **Verdict: `DRAFT_SAFE_APPROACH`** — drafts are native and this build
**cannot** publish a draft to ready.

**Creation** (`internal/scm/github/github.go`): the host carries `draft bool // open created PRs as drafts`
(`NewWithFork(..., draft bool)`), and `CreatePR` appends `--draft` **only** when that flag is set:

```
gh pr create --head <branch> --base <base> [--repo <slug>] [--draft] --title <t> --body-file -
```

The documented control is `providers.github.draft_pull_requests` (default `false`).

**Reuse** (`internal/pipeline/steps/pr.go`): `host.FindPR(ctx, branch, "")` →
`gh pr list --head <branch> --state open …`; when a PR exists the step logs
`pull request already exists: …, updating…` and only updates title/body. A **pre-created open draft PR is reused**,
never duplicated.

**No ready transition** — `UpdatePR` PATCHes `repos/<slug>/pulls/<n>` with **only** `body` and `title`; GitHub's
`draft` field is never sent, so an update cannot publish a draft. A full local scan of both fetched files for
`pr ready` / `MarkReady` / `isDraft` found **zero** matches beyond the create path. The only PR-writing verbs are
`pr create`, `pr list`, `pr view`, `pr edit --base`, and that PATCH. `checks-passed` is a terminal outcome, not a
publish action — it never merges.

**Two routes (both preserve the draft):**

| Route | Mechanism | Permission |
| --- | --- | --- |
| A | global `providers.github.draft_pull_requests: true` → pipeline creates drafts | **NEW write required** (not `agent_config`) |
| B | pre-create the PR manually with `--draft`; pipeline reuses it | already granted (manual draft PR) |

**Phase 4 workflow (no auto-ready, manual release blocker intact):** commit → push → (A or B) →
`axi run --intent "…"` **without `--yes`/`--skip`** → respond to gates manually → `outcome: checks-passed` with the
PR still **draft** → **STOP**; a human decides when to mark ready and merge. Review/lint/CI are never skipped.

**Open verification item:** confirm `.github/workflows/*` does not filter draft PRs
(`if: github.event.pull_request.draft == false`), else checks never post and CI parks until `ci_timeout` (168h).
Drafts run CI by default on GitHub, but this is repo-configurable and unverified here.

**Unverified:** the single wiring line from `draft_pull_requests` to `NewWithFork(..., draft)` was not fetched
(fetch budget capped at 3); field is documented, constructor parameter explicit, wiring unconfirmed.

**PH4 remains PLANNED — NOT STARTED. No PR was created, marked ready, or merged.**
