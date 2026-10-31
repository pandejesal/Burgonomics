# Delegated supervision addendum

## Superseded scheduling model

The original 150-nudge watcher is OFF with its exhausted budget preserved. The
two model supervisors are retained for scoped evidence reconciliation only, not
permanent keepalive loops. Do not enable the old watcher, reset its budget, or
launch recovery timers. User authorized a single persisted delivery queue under
`controller/`; it is currently DISABLED pending tests and independent DS then GLM
review. A scheduled-task registration and observed run are required before calling
that replacement active. Original monitoring reports remain historical evidence.

After installation, the queue owns prompt admission and finite retry/backoff state.
Supervisors may report blockers but must not compete with it by independently
prompting workers or invoking the old watcher. A task waiting for Main acceptance
is not completed automatically from a worker or QA message.

User requested supervision that continues between main-session turns. Two explicit
main-child sessions cover six existing roots each; they are not replacements for
the twelve independent workers. Models remain DeepSeek/GLM Free only.

## Bounded passes, not an infinite model loop

Perform ONE useful reconciliation pass per wake, then return. The existing local
autonomy watcher schedules later passes; do not sleep/poll forever or spawn more
agents. The watcher has finite retry budgets, an idle-age window, and depends on
the OpenCode service remaining alive. Do not promise uninterrupted execution.
Read CONTRACT.md and the latest coordination decisions before the first pass.

## Partition

- Supervisor A (requested DeepSeek; either permitted free model): lanes 01-06. Report only in
  `.orchestration/run-20261020b/supervisor-a.md`.
- Supervisor B (requested GLM; either permitted free model): lanes 07-12. Report only in
  `.orchestration/run-20261020b/supervisor-b.md`.
- Registry: `C:/Users/DELL/AppData/Local/Temp/opencode/fresh-run-2-20261020.json`.

Use actual current worker state, model, latest error/checkpoint, review verdicts,
committed SHAs and gate artifacts. Timestamp reports in ISO UTC. Never treat a
queued prompt, running flag, old test count, or lane assertion as proven progress.
Read only compact relevant tails; do not dump whole transcripts or credentials.

## Actions

1. Classify each assigned lane: executing, provider cooldown, waiting on a named
   coordination dependency, external block, or completed assigned local work.
2. Prioritize finishing existing reviewed packets. No new broad audits or feature
   scope while a ready packet waits. Retain all model and safety boundaries.
3. Use the single existing `autonomy_tick` wake path for eligible worker recovery;
   do NOT independently send synthetic prompts, reset budgets/cooldowns, or run a
   competing timer. This avoids duplicating the watcher's own retry deliveries.
4. For internal waits, route an actionable packet to the responsible owner/QA on
   `fresh-run-2-coordination`: exact paths, current gate slot state, actual review
   evidence, next action and what decision is missing. Do not post another generic
   "please continue" request. Inspect existing queue to avoid repeating old asks.
5. QA retains gate-slot and reviewer-slot allocation. Do not seize occupied slots,
   grant new file ownership, start heavy builds, alter product code, stage, commit,
   deploy, or call live providers. Never interrupt or kill a running operation.
6. Flag unchanged checkpoints across successive passes, distinguishing provider
   failures from missing action. Verify whether prior routing produced a response.
7. Post `fresh-run-2-supervision` only on a real change, newly found coordination
   defect, or scheduled checkpoint. Keep it under 2 KB; detailed table in your file.

Never read auth.json or print service passwords/authorization headers. Local
session API reads may use existing service discovery privately. No network/VPN/IP,
credential, provider-limit or permission changes.

## Ending each pass

`SUPERVISOR_STATE: READY` only when assigned lanes still have unfinished safe local
work and a later reconciliation pass is useful. Explain the next concrete check.
Use EXTERNAL_BLOCK if only external prerequisites remain; COMPLETE when assigned
local work and reconciliation are genuinely finished. Provider failures require
PROVIDER_COOLDOWN. Do not keep completed lanes artificially busy.

This addendum permits two supervision children to be watched; other review
children remain outside the supervisor's explicit session allowlist. Supervision
reports do not count as independent DeepSeek-then-GLM product-code reviews.
