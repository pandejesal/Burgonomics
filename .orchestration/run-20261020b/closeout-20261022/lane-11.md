# Lane 11 — release-infra-closeout (root repo) — evidence

Run: `run-20261023-free` · Owner: `ses_ea5c87669ffeLD1vE6kugwmFVm`
Window: 2026-10-23 (deadline 12:15Z) · Repo scope: **root only**

## Committed (local only, never pushed)

Commit `2b3824d` — `chore(release): harden mobile hosting preflight, close release readiness gaps [run:20261023-free lane11]`
Base HEAD at gate time: `81e20d1`

| path | git blob | sha256 (LF-normalised) |
|---|---|---|
| scripts/validate-mobile-hosting.cjs | d74374f0fd | 5dc174da… |
| scripts/validate-mobile-hosting.test.cjs | 47ae4db022 | 4a7e9d30… |
| .github/workflows/functions-ci.yml | 26884f3ed8 | 9e073a07… |
| .gitignore | 1a2f0… (see note) | 9ec6f407… |
| firebase.json | … | 1c50faa3… |
| R15-android-release-signing-repair.md | 1907409506 | 1479ffe5… |
| R18-ios-release-preparation.md | 885c0a42aa | 44b4c8f4… |

Frozen manifest: `lane-11-manifest-root.json` (sha256 of working-tree bytes). Post-commit
verification: all 7 committed blobs reproduce the frozen sha256 after CRLF→LF
normalisation; `.gitignore` and `firebase.json` are the only two paths where git's
`text=auto` converts the working-tree CRLF to LF on commit. Content identity proven, no
other difference.

## Defects reproduced before fixing (independent DeepSeek review, previous round)

1. `readBundleId()` returned `null` whenever a project had more than one
   `PRODUCT_BUNDLE_IDENTIFIER`, which downgraded the AASA check to **SKIP** — a project
   with a `.debug` target silently stopped checking universal-link bundle ids.
2. `checkWellKnownNotIgnored()` turned an unmodellable ignore glob into a **WARN plus an
   early `return`**, which also skipped the `.well-known` existence check, so a
   release-breaking config could exit 0.
3. (doc) R18's "current output" block and test counts were stale.

## Fixes

1. `readBundleIds()` returns every distinct id; AASA appIDs must end with one of them.
   Added primary-bundle coverage: an AASA that authorises only an extension id FAILs.
2. Unmodellable glob → `ignore-unsupported` **FAIL**, evaluation continues, existence is
   still checked, and overlap reports **SKIP** (never PASS) when unknown.
3. `functions-ci.yml` node-version 20 → 22 to match `functions/package.json` `engines.node`.
4. R18 counts refreshed to the measured reality (PASS 25 / FAIL 2 / 22 tests).

`firebase.json` hunk (permitted scope): hosting `ignore` for both sites replaced
`**/.*` with the explicit list, plus `Content-Type: application/json` +
`Cache-Control` header rules for `/.well-known/apple-app-site-association` and
`/.well-known/assetlinks.json`. No functions/firestore/rewrites change.

## Gates (all node-only; no build, no Mac, no device)

| gate | result |
|---|---|
| `node --check` validator + test file | exit 0 / 0 |
| `node --test scripts/validate-mobile-hosting.test.cjs` (main tree) | **22 pass, 0 fail** |
| same suite in isolated worktree at `81e20d1` + only the 7 frozen files | **22 pass, 0 fail** |
| RED discrimination: pre-fix temp copy of the validator | **4 of the new tests fail** |
| `node scripts/validate-mobile-hosting.cjs` (main tree, built dist) | PASS 25 / WARN 0 / **FAIL 2** / exit 1 — both FAILs are the literal `TEAMID` placeholder (user-only Apple Team ID) |
| same preflight in the isolated worktree | PASS 9 / FAIL 2 — both `publish-dir-exists` because `dist/` is gitignored and absent in a clean worktree |

## Reviews

| step | id | model (local session record) | verdict |
|---|---|---|---|
| independent review | `ses_e99113369ffeEptLt5B6rgg2tX` | `opencode/glm-5.3-flash-free` | APPROVE (2 MINOR, both applied) |
| re-check of the two deltas | same child | same | APPROVE |

Limit: this host does not persist per-message serving metadata (`message` table returns 0
rows for the child), so the model evidence is the session record plus the pinned request,
not message-level proof.

## Not done / limits (explicit)

- **iOS remains BLOCKED**: archive/TestFlight/signing need macOS + Xcode + a real Apple
  Team ID. `TEAMID` placeholders are deliberately not invented; the preflight exits 1.
- `functions-ci.yml` is a GitHub Actions file: syntax/working-directory/node version were
  inspected, it was **not executed** here.
- The two `client-handover/release-builds/*v1.0.0-20261017.aab` files were **not
  committed**: their commit/toolchain provenance cannot be stated from available
  evidence, and they remain untracked.
- No emulator/device run, no store upload, no signed-release claim, no push/deploy.
