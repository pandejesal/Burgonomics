# QA — Run 2026-10-20b (Lane 12)

Session: `ses_ea5c87413ffeBOyHpHeVPuHIoW` (parentID null, model opencode/glm-5.3-flash-free).
Owned glob: `.orchestration/run-20261020b/qa/**` — QA writes evidence only; no product source.

## Files
| File | Purpose |
|---|---|
| `evidence-matrix.md` | Field-by-field truth matrix re-computed from verifiable evidence |
| `gate-log.md` | Per-repo gate serialization: one heavy gate at a time (root/customer/partner) |
| `review-queue.md` | Global review slots (cap 6 concurrent, max 1 active child/lane) |
| `spot-checks.md` | Independent verification records: claim / method / result / label |

## Policy
- A lane report is a **claim**, not evidence. Every matrix cell needs: method + result + truth label
  (LOCAL CODE VERIFIED / DEPLOYED CONFIG VERIFIED / PROVIDER TEST VERIFIED / ACTUAL APP E2E VERIFIED / BLOCKED).
- No inherited greens: BASELINE.md test counts are historical claims to re-run, never cited as new proof.
- Review order per change: DeepSeek V4.1 Flash Free first, then a separate GLM 5.3 Flash Free
  verification. Author's own model never counts. Verify child model from session record.
- Gates are isolated exact-bundle snapshots. Never `git stash` foreign dirty/untracked files.
  Gate slot is occupied only with verifiable process/artifact evidence.
- Spot-check method: targeted test re-run or commit-diff inspection on an isolated snapshot
  (detached worktree/temp tree), never mutating foreign worktrees.

## Calibration standard
Smallest committed fix with a test => re-run its test in an isolated snapshot + inspect the exact
diff. First calibration target: customer `29fd0e6` (`fix(appbutton)` + Playwright B02 harness).
