# Free-model coordination — 23 October 2026

Latest user instruction: use the free models and prompt every existing session.
This supersedes the earlier GPT-primary policy for this run only. Safety, exact
scope, independent review and local-only commit rules remain in force.

## Models

- Primary: `opencode/deepseek-v4.1-flash-free`.
- On a real 429/free-limit: wait 4 minutes, retry the primary once. Then use the
  zero-cost OpenRouter pool below, which has a separate free quota. Then try
  `opencode/glm-5.3-flash-free` after another 4 minutes.
- Direct OpenCode route for Google Antigravity Gemini 3.8 Flash (cost 0),
  verified by a live probe on 2026-10-23: use the fixed ids
  `google/antigravity-gemini-3.8-flash-high`,
  `google/antigravity-gemini-3.8-flash-medium`, or
  `google/antigravity-gemini-3.8-flash-low`. The base id with a `default`
  variant returns 404 on this connection.
- Additional zero-cost OpenCode rungs: `opencode/big-pickle` and
  `opencode/mimo-v2.6-flash-free`.
- OpenRouter is not used: its configured key returns `401 User not found`. Paid
  Google API-key and Vercel routes are not used.
- No GPT, OpenAI, or paid model is authorized.
- Attempts are bounded: one primary, one primary cooldown retry, one attempt per
  OpenRouter free model, one GLM fallback. No loop and no counter reset.
- Independent review uses a different zero-cost model from the author. If the
  author is on OpenRouter, use OpenCode DeepSeek or GLM for the review.
- Main is the coordinator and acceptance authority. An owner's
  `SUPERVISOR_STATE: COMPLETE` is evidence, never automatic acceptance.

## Scheduling

- One heavy worker at a time (serial), to stay under the shared free concurrency
  and token limits. Auto-compaction is expected; it reduces the context sent to
  the free models. Do not run a second owner while one is active.
- The Petpooja lane runs after the root and partner lanes are idle.
- QA lanes run last; QA is read-only except for the two named report files.
- Each session is prompted once per task. There are no idle nudges, repeated
  continuations, or automatic re-admissions after a pending report.
- Stop new admissions at `2026-10-23T12:15:00Z`. A running session may finish;
  unfinished work is left as a resumable snapshot and reported honestly.
- Every session gets the explicit free-model instruction and a durable
  instruction entry replacing the old GPT window entry.

## Quality

- Reproduce the actual failure before fixing it; do not invent a cause.
- Minimal scoped changes, positive and negative tests, no weakened assertions.
- Freeze final Git blobs/SHA256 before review. The reviewer is independent,
  read-only, works on the final bytes, and spawns no descendants.
- High-risk packets (FCM ownership, payments, dispatch teardown, Petpooja) use
  two independent reviews when free quota allows; otherwise record the gap.
- Run the isolated exact-bundle typecheck/tests/build for the affected repo.
  One heavy gate per repo at a time. Current committed HEAD plus only reviewed
  paths is the gate base; never use the shared dirty tree as an isolated gate.
- Commit only reviewed named paths locally, after review and gate. Never push.

## Safety

No deploy, external PR, email, real payment/refund, rider booking, vendor or
production write, PII export, secret/credential change, auth/rule weakening,
broad staging, foreign staging, reset/stash of foreign work, or forced worktree
deletion. Untracked files are not disposable.

Blaze is enabled; ADB is installed but last saw no device; Porter is cancelled;
Borzo/Shadowfax or restaurant-selected in-house dispatch are the intended
choices. Vendor contracts/secrets, live POS/KOT effects, device acceptance and
iOS/Mac builds remain separate evidence gates. HTTP 200, a mock, a receipt, or a
local test is not live fulfilment.

## Report format

`QUEUE_TASK: <id>`, final paths and blobs, actual reviewer models and verdicts,
discriminating RED/GREEN results, gate exit codes, exact local SHA(s), and
remaining limits. Maximum 400 words; write detailed logs to the run directory.
