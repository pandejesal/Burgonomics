# QA evidence verification — customer-address-closeout

Verifier session: `ses_ea5c87a64ffecPa7h3J8Zxpw6h` (lane 09 root, model `opencode/deepseek-v4.1-flash-free`).
Stage: `qa_verification` only — this is **not acceptance** and not a redo. Date: 2026-10-22.

## Scope verified

Commit under test: `6e25a0cb6a3ae5883e860ea89fa758c17342664b` in `burgonomics-foundation-core`
(branch `ui-sweep`), parent **`2f47cef1dd9d9b7696898c3c502051df22b7dc2f`** = the stated baseline.
Commit message: `fix(addresses): honest failure closure, session isolation and accessible save errors [lane:customer]`.

## What matched

| Claim | Method | Result |
|---|---|---|
| Base = `2f47cef1…` | `git rev-parse 6e25a0c^` | **MATCH** exact |
| Exactly the 9 declared paths | `git diff-tree --name-status -r` | **MATCH** — 5 M + 4 A, no foreign path |
| 2222 insertions / 138 deletions | `git show --stat` | **MATCH** exact |
| Manifest git-blob ids, 9/9 | `git rev-parse <commit>:<path>` vs `manifest.txt` | **MATCH 9/9** |
| Gate overlay = committed bytes | content compare of the surviving worktree at `Temp/opencode/lane01-addr-closeout/gate-2f47cef` vs commit blobs (CRLF-normalised) | **MATCH 9/9** |
| Committed behaviour | read committed blobs | `AddressRepository`: `if (!res.success) return res;` precedes the session check in all four mutations (:101,:116,:126,:136); `AUTH_CHANGED` is `retryable: false` (:67-71) with the curated reopen copy; `AddressFormModal`: `saveInFlightRef` (:145,:564,:604,:634) + terminal `saveBlocked` (:148,:559,:979-983); `profile.addresses`: `actionError` rendered as `role="alert"` (:85-86) |
| Tests are failure-path, not happy mock | read `tests/address-persistence-failures.test.ts` | substantive: signed-out fail-closed, WRITE_FAILED per mutation, setDefault absent-id, local-state safety on failed saves, A/B cross-account isolation |
| RED evidence | `red-tests.log` | **34 failed / 13 passed (47)**, 4 files — matches the claim |
| GREEN focused | `green-4.log` | **53/53 passed**, 4 files |
| Full gate | `gate-tests.log` | **87 files / 591 tests passed**, exit implied 0 |
| Build | `gate-build.log` | `vite build` transformed 2874 modules, chunks emitted (success line wrapped by ANSI; no error present) |
| Review provenance | runtime DB `session_v2` | DS `ses_e9efb6f73ffeX7EjqhU8MqK50m` → `opencode/deepseek-v4.1-flash-free`, parent `ses_ea5c8a548ffex6hMqeB90XmuF0`, outcome succeeded. GLM `ses_e9eefadd3fferIQBDmrE9QSWfS` → `opencode/glm-5.3-flash-free`, same parent, succeeded |

## Gap closed during verification

The packet claimed `npx --no-install tsc --noEmit` exit 0 but captured no tsc output. I re-ran exactly
that command in the surviving gate worktree (which I first proved byte-equal to the commit):
**exit 0, no diagnostics**. No other gate was re-run.

## Discrepancies found (evidence quality, not code)

1. **Manifest SHA256 column mixes byte representations.** 7/9 entries equal the committed blob bytes,
   but `AddressFormModal.tsx` and `profile.addresses.tsx` list the SHA256 of the **CRLF worktree
   files** (`1D001758…`, `F9822313…`), while the committed blobs hash to `C27B6524…` and `0586F5DB…`.
   Both worktree files equal their blobs after CRLF→LF normalisation, and the git blob ids match, so
   **no content drift** — but the "frozen manifest" is not a uniform commit-byte manifest for those two
   rows. Lane-01's prose claim ("9/9 match, git blob == frozen blob") is accurate as written; the
   SHA256 column is not.
2. **The frozen manifest is not immutable storage.** It exists only as a table in the untracked
   `closeout-20261022/lane-01.md` plus `Temp/opencode/lane01-addr-closeout/manifest.txt`. Nothing pins
   it in git or hashes the manifest itself, so it can be edited later without detection.
3. **Review provenance is session-level only.** `session_v2` proves parent + exact model + succeeded
   outcome for both children, but the per-message "31/31" and "10/10 served" counts are not
   reproducible from the current DB (message rows for those sessions are not retained). Verdicts in
   `lane-01.md` are therefore corroborated, not byte-audited.
4. `routeTree.gen.ts` shows as modified in the gate worktree; `git diff` proves it is **line-endings
   only** (no content change), so nothing generated was wrongly excluded from the commit.

## Could not check

- Live provider/device/E2E behaviour — outside this item and outside the packet's own claim.
- The historical state of the index at commit time ("`git diff --cached` empty before and after");
  the commit's parent + 9-path diff bounds what could have been staged.
- The two reviewers' full transcripts; only session records survive.

## Truth label

`LOCAL CODE VERIFIED` is appropriate for the uncommitted-to-deployed scope: typecheck, 591-test suite,
build and focused 53-test suite all green on an overlay proven equal to the commit. **Not** deployed,
provider, or device E2E.
