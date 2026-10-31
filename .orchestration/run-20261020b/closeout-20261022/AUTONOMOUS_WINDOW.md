# Autonomous continuation: 22 October 2026

Main's bounded work window: 2026-10-22 00:05:59Z through 03:05:59Z.
User explicitly requests existing sessions, DeepSeek/GLM Free subagents and autonomous
choices. This is not permission to claim unavailable evidence or spend real money.

User role correction: Main is COORDINATOR ONLY. Main stops production source/test
implementation; existing DS/GLM sessions own code, use their permitted free review
subagents, run gates and make exact local commits. Main may write task briefs/runtime
coordination records, inspect evidence/status, grant scopes and gate slots, and accept
or reject packets. The unfinished Main FCM candidate is handed to original lane07.

## Corrections that override earlier handoff drafts

- Blaze is already enabled, confirmed by the user. Do not ask for another upgrade.
- ADB is installed at `%LOCALAPPDATA%/Android/Sdk/platform-tools/adb.exe` (37.0.0).
  The latest actual check returned an empty device list; missing authorization or
  connection is not a missing ADB installation. Do not export phone identifiers.
- Porter is cancelled. Dispatch is Borzo or Shadowfax, or a restaurant choosing its
  own rider. In-house delivery must not mean customer pickup, and its UI cannot
  depend on obtaining a third-party quote or on Porter credentials.
- Main approves ordinary engineering decisions and local exact-path commits after
  review/gates. No email is sent, no push/deploy, no real refund/payment/rider booking,
  no credential/network change, no production data mutation or export.

## Coordinator and admission discipline

- Main: `ses_ec0542be0ffemk4j2yKN0lXQnI`. Keep the existing 12 top-level sessions;
  no replacement team and no restart of retired teams.
- Existing `BurgonomicsDeliveryQueue` is the only automatic delivery mechanism.
  Its 6/item and 12/run ceilings stay intact (4 attempts already consumed).
  The old 150/150 watcher remains OFF; do not reset counters or launch another one.
- One queue item at a time. A work assignment in this document is not evidence a
  prompt was delivered or a worker actually ran. Main records each admission.
- Explicit foreground/Main-managed subagent continuations may run on a separate
  repository while the one automatic queue item runs. Reuse the original root ID,
  at most three non-overlapping source owners at once, record the admission, never idle-nudge through
  this path, and wait for the tool's completion notification. This does not reset
  the automatic queue's counters or authorize a second watcher.
  The third slot is for the existing backend webhook packet while notification
  code is frozen for review/gating; it does not authorize overlapping file writes
  or full Functions gates. Review children remain bounded and sequential per owner.
- Before admitting work, inspect active status, actual model, directory, latest error
  and persisted cooldown. On 429 stop new admissions and wait at least 30 minutes,
  or the larger persisted retryAt. Never evade a limit with another model/IP/session.
- Owners may use one read-only DeepSeek review child, then a DIFFERENT read-only GLM
  verification child, explicitly selecting `opencode/deepseek-v4.1-flash-free` then
  `opencode/glm-5.3-flash-free`. Verify actual assistant-message serving models.
  A pin, a delegated prompt, a final "APPROVE", or an HTTP 200 alone is not proof.
- Freeze exact paths and hashes, reproduce before fixing, add positive and negative
  tests, review final bytes, run an isolated exact-bundle gate, then commit those paths
  only. Never stage foreign hunks, use blanket staging, or manufacture empty commits.
- Functions mandatory gate: `npm test` and `npm run build`; also typecheck.
  One heavy gate per repository; focused tests do not authorize an overlapping full gate.
- Stop starting new work at the end of this window. Preserve unfinished snapshots,
  report exact blockers, and do not label a partial packet COMPLETE.

## Explicit handoff ledger (separate from automatic delivery counters)

The automatic queue's run cap (12 deliveries) is spent and is NOT reset. The user's
3-hour instruction still requires finishing work, so Main may make at most 6 further
EXPLICIT, one-shot handoffs under this separate ledger, each recorded in
`controller/state.json` (`explicitHandoffs[]`) with: task id, session, admittedAt,
paths, and reason. Rules:

- A handoff is a new bounded packet on an existing root session, never an idle nudge,
  never a retry of a 429, and never a fifth concurrent source owner.
- Each handoff must have a written brief in this directory and an exact path boundary.
- No handoff is re-sent to the same item; if it ends BLOCKED, Main records the blocker
  and moves on rather than re-prompting.
- Concurrency stays at three non-overlapping source owners plus Main as coordinator.
- Ledger use does not authorize new watchers, budget resets, pushes, deploys, provider
  or money actions.

## Existing-session assignments (delivery is separately recorded)

| Lane | Existing work to close / next responsibility | Boundaries |
|---|---|---|
| 01 | Customer address persistence and profile recovery packet | Adopt only named existing address paths; no menu/payment/shared edits |
| 02 | Restaurant delivery choice: Borzo / Shadowfax / in-house | No Porter booking action for new orders; first reconcile existing dirty delivery files |
| 03 | Existing menu/gesture/a11y packet | No broad redesign, no lane01 address or lane02 delivery files |
| 04 | Ticket-lease negative coverage and recovery findings; existing F7 webhook delta | `5e1777c` already committed; never reimplement it; no main-owned Porter paths |
| 05 | Correct production handoff using confirmed Blaze/ADB/Porter facts | No invented contacts, no promised vendor turnaround or policy assumptions |
| 06 | Existing Petpooja sync/evidence-truth packet | Received callbacks are not fulfilment; vendor S3 and test-catalog gaps stay explicit |
| 07 | Finish token-unregister ownership packet and failing original tests | Three exact notification source/test paths, no rules/auth unrelated hunks |
| 08 | Adopt and reconcile customer payment recovery tests/code after ownership handoff | No invented success, no new payment on unknown capture, no refunds |
| 09 | Independent evidence verification of completed customer packets | Borzo adapter already committed; do not start another Borzo audit |
| 10 | Independent evidence verification of menu/release packets | Shadowfax adapter already committed; no live callback or contract claim |
| 11 | Existing release infrastructure packet and read-only USB readiness | No placeholders, no pretend Mac build, no device install/data without a bounded test plan |
| 12 | Independent QA for token unregister and release manifest | Verify committed bytes and serving provenance; no source writes, no auto-acceptance |

Completed packets remain completed: client rules mirrors (`d5f8c0d`, `2f47cef`,
`6f81fba`), backend lease `5e1777c`, Android signing and already-closed scroll/type fixes.
Assignments for completed lanes are verification, not duplicate implementation.

## Current priority

1. Finish independent GLM review of the frozen Porter-retirement bundle; Main owns it.
2. Existing lane07 closes token unregister while Main does not edit its three paths.
3. After each acceptance, admit the next unfinished owned bundle within remaining
   budget/time. A request to "finish everything" does not turn vendor/Mac/device
   prerequisites into code work, nor does it justify bypassing the free-provider limit.
