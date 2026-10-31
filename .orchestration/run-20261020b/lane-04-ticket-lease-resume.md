# Lane 04: finish the existing ticket-resolution lease packet

Owner: `ses_ea5c89e34ffeE5jJ0PRSjVSH2k` (existing top-level session, not a replacement).
Queue item: `backend-ticket-resolution-lease`.
This is a bounded continuation of your written seven-path packet, NOT a new audit.

## Context to load

Read this brief, your existing packet notes, and `CONTRACT.md`. Load only the ticket
stage/specs and implementation needed. Do not load every lane or restart finished work.

- Current root base: `d5f8c0dee2c8f23ec4ebc5c199d461a6087fca1d`.
- Customer: `2f47cef1dd9d9b7696898c3c502051df22b7dc2f` (prerequisite `8123bbc`).
- Partner: `6f81fbafa4ba907d8c6cd770a6f332ebd6222af2`.
- Main has accepted the client rules correction. All mirrors contain blob
  `32238e8b1a46eb84622cbfcf20cdc124a060d963`. Do not redo or edit them.
- Evidence: `evidence/main-ticket-workflow-status.md`. The rules freeze terminal
  client outcomes but do NOT prove your uncommitted server lease is finished.

## Existing owned packet

1. `functions/src/core/errors.ts`
2. `functions/src/core/validation.ts`
3. `functions/src/index.ts` (only your ticket route/error hunks)
4. `functions/src/modules/tickets/tickets.service.ts`
5. `functions/src/modules/tickets/ticketRouteErrors.ts` (new)
6. `functions/tests/tickets.resolve-race.test.ts` (new)
7. `functions/tests/tickets.route-errors.test.ts` (new)

These files are already written. Inspect the diff and your existing evidence before
changing anything; do not reimplement the packet from scratch. Other dirty files,
including notification/auth/dispatch files and `tickets.notify.test.ts`, are NOT
implicitly part of this bundle. Identify ownership and declare a necessary extra
fixture change before adopting it. No rules, app, native, or provider-adapter edits.

## The exact unresolved blocker

QA SC-024 found your prior signoff chain invalid: the cited second "DS" review
actually served GLM. The valid first DS review covered an earlier revision; typecheck
fixes also moved the final bytes. No previous approval or 76-test claim closes this.
Main explicitly authorizes the fresh SC-024 review chain below for this same packet;
this supersedes older no-new-review holds. First confirm there is no active child to
interrupt. Do not reuse an ended, wrong-model verdict as the required DeepSeek approval.

1. Freeze a filtered candidate at the current root HEAD plus ONLY your packet. Write
   the exact paths, blob IDs, and SHA256 values to an immutable snapshot/manifest.
   Preserve all foreign working files and index entries; no stash or broad staging.
2. Fresh independent child on actual `opencode/deepseek-v4.1-flash-free`, read-only.
   Verify its session AND assistant-message serving model, not just the requested pin.
3. After its final approval, a separate fresh independent child on actual
   `opencode/glm-5.3-flash-free`, also read-only. One active child at a time. Reviewers
   must not create children. Wrong serving model is BLOCKED, not signoff.
4. Apply findings, refreeze/review material changes, then one isolated root/functions
   gate on the final exact bundle. Post START/END with base, commands, counts and hashes.
   Run typecheck, full unit suite, and build. Assert positive AND negative concurrency
   outcomes; do not confuse mocks with actual Razorpay/refund/provider verification.
5. On pass, commit only the reviewed packet locally. Never push. Report the SHA and
   verify every committed blob against the reviewed manifest; leave foreign work alone.

Review the existing race tests, especially one winning resolution, a loser with no
money side effect, stale-claim handling, token-fenced release/late completion, and
note-versus-money interleavings. These are checks of your existing packet, not permission
to invent new product policy or make real financial calls.

## Safety and admission

Only the permitted free pair may serve worker/review turns. Never switch to Sol,
paid models, another provider, or an IP/VPN workaround. On HTTP 429 stop, record the
timestamp, and respect at least the controller's 30-minute backoff. Do not issue
retry storms. The controller owns continuations; do not start another timer/watcher.
Main's exhausted 150-nudge watcher stays OFF and its counters stay unchanged.

No deploy, live refunds/transfers, rider booking, vendor writes, PII, credential or
network changes. LOCAL CODE VERIFIED is the maximum label for this packet.

## Final response format

Start with the plain line `QUEUE_TASK: backend-ticket-resolution-lease`.
COMPLETE means final reviews, exact gate, local commit and evidence are all finished.
If not, report the actual pending reviewer/gate or external prerequisite honestly.
Do not call an internal review wait an external prerequisite or a completion.

For completion, the last nonempty line must be EXACTLY the following plain text,
with no Markdown backticks, quotation marks, suffix, or sentence afterwards:

SUPERVISOR_STATE: COMPLETE
