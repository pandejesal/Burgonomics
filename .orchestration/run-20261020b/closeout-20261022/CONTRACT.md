# User-requested commit closeout: all 12 existing sessions

The user requests: first each session commits its work, then a report of the human
steps needed for final production. A phone is connected by USB; Main's read-only
ADB check currently sees no Android device. This is NOT authorization to install,
reset, collect phone data, use real money/providers, or deploy.

## This is closeout, not another audit

- Keep the existing 12 top-level sessions. Do not create replacement workers,
  supervisors, new product tasks, timers, or keepalive machinery.
- Stop starting new work. Finish only your current owned packet and report it.
- If already committed, verify the actual SHA/path scope and say ALREADY_COMMITTED;
  do not create an empty or cosmetic commit merely to make a new SHA.
- Never stage another lane's, Main's, or unidentified dirty work. No broad staging,
  stash, reset, cleanup of merge files, or inclusion of unrelated evidence/binaries.
- Keep runtime controller state/status/locks, credentials/env files, phone identifiers,
  private keys, APK/AAB build outputs and test-results out of source commits.
- Every remaining source change still needs actual independent DeepSeek review then
  separate GLM verification, exact-bundle gates, and a local exact-path commit.
  A commit request does not waive those gates. At most one active review child/lane.
- One heavy gate per repository at a time. Obtain Main's slot before starting a new
  gate. No pushes, deployments, PR publication, vendor writes, money/rider actions,
  PII access/export, network/credential changes, model substitutions, or limit evasion.
- Use only `opencode/deepseek-v4.1-flash-free` or `opencode/glm-5.3-flash-free` for
  worker/review turns. Verify actual serving models; a pin alone is not proof.
- On 429 stop and report the exact blocked step. Preserve persisted cooldowns and
  budgets. Do not repeatedly prompt other models to evade a provider limit.

## Per-session closeout report

Write only your report at `closeout-20261022/lane-XX.md` and return its path. Include:

1. Full session ID, actual model, lane, repository, timestamp.
2. Status: COMMITTED / ALREADY_COMMITTED / NO_OWNED_CHANGES / BLOCKED.
3. Exact commit SHAs and paths. Main verifies them against git; a claimed SHA is not enough.
4. DS and separate GLM reviewer IDs, verdicts, and the bytes they reviewed.
5. Exact gate base/overlay, commands, counts, exit codes, and evidence paths.
6. Owned work still dirty, ownership ambiguities, uncommitted evidence, and why it
   cannot yet be safely committed. Do not describe blocked code as complete.
7. Remaining HUMAN actions, each with owner/account/console, concrete action,
   prerequisite, pass evidence, and whether it blocks production.
8. Remaining ENGINEERING work separately: do not offload unfinished code to humans
   or imply that secrets alone will make an unverified integration work.
9. Preserve truth labels: LOCAL CODE VERIFIED is not deployed/provider/device E2E.

Use existing artifacts and prior approved commits rather than rerunning finished
gates. New or changed bundles must pass fresh gates; old green is not transferable.

Main will consolidate these reports into a production decision/checklist after
reconciling actual commits. A BLOCKED lane must remain visible in that report.
