# GPT coordination: 22 October 2026

User authorizes all 12 existing sessions, GPT primary workers, and DS/GLM Free as
optional review subagents only when their persisted cooldowns genuinely expire.
Main coordinates; product-code implementation stays delegated.

Window: 2026-10-22T05:25:30Z to 2026-10-22T10:25:30Z. The old expired deadlines and
free-only model restrictions in inherited briefs are superseded for this run ONLY.
File boundaries, safety and final-byte verification requirements remain intact.

## Usage controls

- Default owner/reviewer: `openai/gpt-6.1-sol#low`, the same GPT family currently
  serving the coordinator successfully. The catalogue-listed GPT-5.5 was rejected
  by the ChatGPT OAuth connection on its first call; that failed admission is retained.
  No mini model or Plus quota weights are exposed. Low effort is NOT a guarantee of
  a particular quota cost. OpenAI uses existing OAuth, not new API billing credentials.
- Only ONE root owner runs at a time. Admit each task once; no idle-nudge loops.
  One read-only review child at a time; at most two new children per product packet.
  Each reviewer is independent of the author, works on frozen final blobs, edits
  nothing and spawns no descendants. Existing valid reviews may transfer only when
  their exact scope/blobs match. Two distinct GPT sessions may replace the earlier
  DS-review/GLM-verification pair. Never count a writer as its own reviewer.
- No speculative audits, whole-history dumps or repeated passing gates. Aim for
  16 assistant turns for docs/evidence, 32 for code, with concise reports <=400 words.
  Medium effort only for a narrowly identified payment/security review; no fast/max.
- No auth/429/transport retry loops or automatic provider substitution. Stop new
  admissions on a GPT quota error and save the exact pending step. No promise of
  five hours of capacity or zero defects is possible; never hide a failing gate.
- DS/GLM at startup have persisted cooldowns beyond this window. Do NOT probe/reset
  them or try another free model/IP. Optional use requires actual recovery evidence.

## Quality and safety

Investigate/adopt existing patches, reproduce real failures, make minimal scoped
fixes, add positive/negative tests, freeze Git blobs/SHA256, obtain independent
final-byte review and verification, then run isolated exact-bundle typecheck/tests/build.
Use CURRENT committed HEAD plus ONLY reviewed paths; the shared dirty tree is not
an isolated gate. No weakening assertions or security checks to obtain a pass.

One heavy gate per repo and one shared index writer. The sole admitted owner receives
its required gate slots until its final response; then it releases them. Commit only
reviewed named paths locally after approval and gates. Main accepts separately.

Never push/deploy/open an external PR/send email; make real payments/refunds/rider
bookings; write vendor/production data; change credentials/network; export PII;
weaken auth/rules; use broad staging; reset/stash/overwrite foreign work; force-delete
worktrees or untracked files. Untracked is not synonymous with disposable.

Blaze is enabled; ADB is installed but last saw no device; Porter is cancelled;
intended dispatch is Borzo/Shadowfax or restaurant-selected in-house. Vendor secrets,
official contracts, POS/KOT effects, device acceptance and Mac/iOS builds remain
separate evidence gates. Local mocks/HTTP200/receipt are not fulfilment.

## Reporting

`QUEUE_TASK: <id>`; final paths/blobs; reviewer verdict IDs and ACTUAL serving models;
discriminating RED/GREEN; gate exits/counts; local SHA(s); exact remaining limits.
Write logs to files rather than lengthy prompts. `SUPERVISOR_STATE: COMPLETE` is
allowed only for a really finished scoped packet; it is not Main acceptance or live
success. The dispatcher records evidence as UNACCEPTED for Main/QA inspection.

Old accepted records, spent counters and cooldowns are never reset. Disable the old
prompt queue while this separate bounded run owns admission. No duplicate watchers.
