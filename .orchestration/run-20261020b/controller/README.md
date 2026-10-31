# Delivery queue controller — run-20261020b

Small, durable, single-item delivery queue for one orchestration item at a time. It
replaces the 12-way fan-out: the controller reads one session's latest **actual**
assistant message, decides one action, and either does nothing or posts exactly one
queued prompt.

Node builtins only. No dependencies, no daemon, no autostart.

## Files

| File | Purpose |
|---|---|
| `controller.cjs` | CLI + pure tick (`buildPlan`) + lease, atomic state, native API client |
| `controller.test.cjs` | Mock-only `node:test` suite; no network, no real sessions |
| `queue.json` | Queue declaration. **Ships with `"enabled": false`.** |
| `register-task.ps1` | Current-user Task Scheduler install/remove/status |
| `state.json` | Runtime state (created by `--apply`; not in the repo initially) |
| `status.json` | Runtime JSON heartbeat, rewritten each `--apply` tick |
| `events.log` | Append-only JSONL event log; one line per Main acceptance notification |
| `controller.lock` | Exclusive process lease (created/removed per `--apply` run) |

`state.json`, `status.json`, `events.log`, `controller.lock` are runtime artifacts. Do
not delete `state.json` to "reset" the queue: delivery counters are persisted on
purpose and are never reset by the controller.

## Modes

```powershell
# Dry run (default). May read the opencode API. Writes nothing, POSTs nothing.
node controller.cjs --once

# Apply. Takes the lease, reserves durably, POSTs only if due, persists state.
node controller.cjs --once --apply
```

Unknown flags exit `2`. A tick that requires a human exits `3`. Normal ticks exit `0`,
including "waiting", "active", and "backoff".

The tick prints one JSON status object. Under `--apply` with the queue enabled, the
same object is written to `status.json`. Fields include `polledAt`, `mode`, `itemId`,
`phase`, `executing`, `idle`, `evidencePending`, `providerError`, `retryAt`, `budget`,
`decision`, and `needsAttention`/`attention` when a human is needed. `executing` always
reflects the observed session, including when the budget is exhausted — an active
worker is never reported as idle.

## Phases

`owner` → `qa` → `awaiting_main_acceptance` → (`accepted`, set by Main only).

- `owner` → `qa` happens only when the latest **actual** assistant message
  (a) is newer than the last successful delivery in the current phase,
  (b) contains `QUEUE_TASK: <item-id>` (the correlation marker every prompt asks the
  worker to echo), and
  (c) has not already been consumed. The controller then queues an
  evidence-verification prompt to the QA session. That prompt is explicitly *not*
  acceptance and *not* a redo.
- `qa` → `awaiting_main_acceptance` happens only on QA's own observed `COMPLETE` under
  the same freshness/correlation/consumption rules (so an old QA `COMPLETE` can never
  trigger it). The controller then sends **one** bounded notification to
  `mainSessionID` (manifest.orchestrator). The notification asks Main to inspect and
  accept or reject; it does not ask Main to do the work. Main is not a worker: the
  free-model check is exempt for this one final notification only (owner and QA are
  still checked).
- The `COMPLETE`/`EXTERNAL_BLOCK` line must be the **final non-empty line** and
  unquoted: `SUPERVISOR_STATE: COMPLETE` or `SUPERVISOR_STATE: EXTERNAL_BLOCK <reason>`.
  `SUPERVISOR_STATE: "COMPLETE"`, `SUPERVISOR_STATE: COMPLETE <anything>`, an inline
  mention, or a non-final line is ignored.
- The notification counts against the same finite attempt budget (6/item, 12/run). If
  it is spent, the item stops with `notification_budget_exhausted`; nothing is sent.
- `awaiting_main_acceptance` is a hold: while any item is in that phase, no other item
  is activated and no session is read. Main accepts by setting that item's phase to
  `"accepted"` in `state.json`. The controller never sets `accepted` and never advances
  on message text. **Deleting the item record is not acceptance**: a missing record is
  a stop (`unseeded_item`), not a re-delivery with a fresh budget.
- The transition is durable only after the notification POST succeeds. A crash or
  unknown outcome leaves the moved reservation pending and the item becomes
  `needs_attention` (`delivery_uncertain`); the notification is never blindly resent.
- `EXTERNAL_BLOCK` is terminal-ish: the item stops (`external_block`) and is not
  prompted again. `main` can move the phase by editing `state.json` after inspection.

An accepted prompt is **not** execution and **not** progress. After a prompt delivery
the status reports `delivered_awaiting_evidence` and `evidencePending: true` until a
newer assistant message exists. For the Main notification the status reports
`awaiting_main_acceptance`, `phase: awaiting_main_acceptance`,
`evidencePending: false`, and `mainNotification`.

## Safety rules encoded in the controller

- **Active actor:** if the target session is running, nothing is posted (no wake, no
  interrupt), even if a delivery is otherwise due.
- **Root and model validation:** the session's `location.directory` must match the
  item/queue root, and its model must be exactly `opencode/deepseek-v4.1-flash-free`
  or `opencode/glm-5.3-flash-free`. Anything else stops the item with
  `needs_attention`; the controller never switches a model.
- **Provider 429/error:** the observed provider status/type/message is reported.
  Exponential backoff, base 30 min, doubled per consecutive error, capped at 4 h. The
  persisted `retryAt` is enforced unconditionally — with or without an assistant error,
  across restarts, and after a POST 429 — so no request is made before it. A **200
  admission is not provider health**: the counter is only cleared by a *newer* assistant
  message with no error. So the real cycle (admission accepted, model then hits a quota
  error) escalates 30 → 60 → 120 → 240 min instead of restarting at 30 min forever.
- **Attention latch:** `needs_attention` stays until Main clears it. To clear, set
  `items["<item-id>"].needsAttention` to `null` in `state.json`; the next tick resumes.
  Nothing clears it from message text.
- **Budgets:** max **6 attempts** per item, 12 per run, persisted in `state.json`,
  never reset by the controller. An attempt is charged and persisted **before every
  POST**, including 429s and uncertain outcomes, and the Main notification counts. At
  the cap the item stops with `attempt_budget_exhausted`, `continuation_cap_reached`,
  or `notification_budget_exhausted` (explicit attention, not a quiet loop).
- **Clean idle continuation:** when the session is idle and at least 15 minutes have
  passed since the last successful delivery, one continuation is queued with the same
  packet context. This repeats every 15 idle minutes until the attempt cap, then the
  item stops with `continuation_cap_reached` (explicit attention).
- **Durable reservation:** the attempt is charged and a single pending reservation is
  written atomically to `state.json` *before* the POST. If the reservation write fails,
  there is **no POST** and the old state is retained. If the process dies or the POST
  outcome is unknown, the item becomes `needs_attention` with `delivery_uncertain` and
  is never resent. After an accepted POST, the sent state is persisted **before** any
  best-effort `getActive`/`getSession` observation, so an observation failure cannot
  lose the delivery (status reports `observation: "unavailable"`).
- **Lease:** one exclusive `controller.lock` per apply run. A live PID is **never**
  stolen, however old the lock is; an old live lock is reported as
  `lock_held`/`live_lock_stale` attention. Only a dead PID plus a lease older than
  30 minutes is reclaimed. Lock-held and lock-error ticks still write a status
  heartbeat.
- **Atomic writes:** tmp file + `fsync` + rename for `state.json` and `status.json`.
  There is no unlink-old fallback: a failed rename keeps the previous file and the
  tick fails closed.
- **Validation:** queue, item, phase, root, session IDs, limits, and state timestamps
  are validated before any API read or POST (`invalid_config`/`invalid_state`, exit 2).
  State item phases are restricted to the known set; one session may not serve two items
  or both roles; `retryAt`/`lastSentAt`/`lastDeliveryAt`/`mainNotifiedAt` must be epoch
  numbers (an ISO string would silently disable the retry gate, so it is rejected).
- **Deletion is not acceptance:** every item that was seeded is remembered in
  `state.seededItemIds`. If its record later disappears, the queue stops with
  `unseeded_item` instead of re-delivering it with a fresh budget. A missing
  `state.json` after a heartbeat that recorded `stateSeen: true` (or next to an
  `events.log`) stops with `state_missing_but_history_exists` (exit 3) for the same
  reason. A heartbeat from a pre-state failure (`stateSeen: false`) does **not** block
  a legitimate first run.
- **No side effects:** no service start/reload, no deletion, no worktree, no git, no
  provider or network configuration changes. `--once --apply` only reads the native
  API, posts the one due prompt, and writes its own four files (`state.json`,
  `status.json`, `events.log`, `controller.lock`).
- **Finite timeouts:** each native HTTP request aborts after 20 s; the scheduled task
  has a 10-minute `ExecutionTimeLimit`. There is no unbounded wait.

## Native API

Basic auth is discovered fresh from `service.json` on **every** request, in this order:

1. `%USERPROFILE%\.local\state\opencode\service.json` (canonical, `{ url, password|token }`)
2. `%USERPROFILE%\.local\share\opencode\service.json`
3. `%USERPROFILE%\.config\opencode\service.json`
4. `%LOCALAPPDATA%\opencode\service.json`
5. `%APPDATA%\opencode\service.json`

The first existing file wins and is validated: the canonical `url` form and the legacy
`{ hostname, port }` form are both accepted, but a non-loopback host, an embedded
credential, or a missing/invalid port is rejected rather than silently skipped. The
`/api/session/active` response must be `{ data: { <session-id>: … } }`; any other shape
is an error. The password is used only in the `Authorization` header and is never
printed, logged, or written to status. Endpoints used:

- `GET /api/session/active`
- `GET /api/session/{id}`
- `GET /api/session/{id}/message?limit=12&order=desc&type=assistant`
- `POST /api/session/{id}/synthetic` with `{ text, description, delivery: "queue" }`

If `service.json` is missing, the tick fails with an error and writes nothing.

## Prerequisites (not provided by this code)

- A **logged-in user**. The task is Interactive + LIMITED; it does not run while the
  user is logged out.
- **Task Scheduler service (`Schedule`) running.**
- The **opencode server running** as that user, with a valid `service.json`.
- `node.exe` at an explicit path (default `C:\Program Files\nodejs\node.exe`).

## Install (Main only, after review)

`queue.json` ships with `"enabled": false`, so an installed task does nothing until the
queue is enabled. Main reviews this directory, runs the tests, enables the queue, then:

```powershell
# current user, LIMITED, Interactive; every 5 min + AtLogOn; IgnoreNew
.\register-task.ps1 -Install

# inspect
.\register-task.ps1 -Status

# remove only this exact task
.\register-task.ps1 -Remove
```

The installer refuses to overwrite a task named `BurgonomicsDeliveryQueue` that it did
not create (it compares the exact controller path and working directory), and
`-Remove` refuses to delete a foreign task. It never starts the task, and it refuses to
run when `BURGONOMICS_QUEUE_CHILD=1` (i.e. from a delivery child).

## Tests

```powershell
node --check controller.cjs
node --check controller.test.cjs
node --test controller.test.cjs
```

The suite is mock-only. It covers: canonical/quoted state parsing, correlation
matching, busy sessions, assistant 429 backoff, a persisted `retryAt` blocking POSTs
without an assistant error, POST 429 attempt-charging and no early retry, per-item and
per-run attempt caps, repeated 15-minute continuations up to the cap, wrong model,
wrong root, fresh/correlated/consumed `EXTERNAL_BLOCK` and `COMPLETE` (including a
stale QA `COMPLETE` never advancing), owner `COMPLETE` → QA, QA `COMPLETE` → one Main
notification, notification once across restart, the awaiting-main hold, paid-worker
rejection with Main exempt, notification budget exhaustion, single-item serialization,
dry-run with no writes/no POST/no attempt, disabled queue, attempt+reservation before
POST, reservation-write failure (no POST, old state retained), post-send persist
failure (no resend), crash/unknown POST → `needs_attention`, observation failure after
send (delivery retained), queue/state validation before API, lease (live PID never
stolen, stale dead reclaim, lock-held heartbeat), atomic writes, service.json
canonical/legacy/rejection forms, active-map shape rejection, phase-entry retry, and
old-state budget migration. Also: the real backoff cycle (200 admission then assistant
429, three times → 30/60/120 min), health-based decay, rejection re-completion, clearing
the attention latch, session reuse, epoch-timestamp validation, deletion of a seeded
item record, a deleted `state.json` after `stateSeen: true`, and a pre-state heartbeat
that must not block a first run. 43 tests.

## Limitations

- No hard guarantee: the controller reasons from message text and timestamps, and
  `COMPLETE`/`EXTERNAL_BLOCK` are conventions, not proof.
- The worker must echo `QUEUE_TASK: <item-id>` in its final message. If it does not,
  the signal is ignored: the queue sends bounded 15-minute continuations and then stops
  at `continuation_cap_reached` rather than guessing.
- Attempts, not successes, consume the budget. A run of provider errors can exhaust an
  item without any work being done; that is deliberate and surfaces as attention.
- Not E2E verified against the real orchestration. Verification so far is the mock
  suite plus a read-only dry-run against the native API. The Main notification has not
  been delivered to the real Main session.
- The Main notification is one queued synthetic message. If its POST outcome is
  uncertain, the item becomes `needs_attention` and the notification is not resent;
  Main may or may not have received it. That is deliberate (no duplicate prompts).
- Main acceptance is manual: edit `state.json` to set the item phase to `"accepted"`.
  Nothing accepts from message text.
- Task Scheduler can skip ticks while the machine sleeps or the user is logged out;
  the next run reports the truth, it does not replay missed work.
- The installer is strict by design: a task is treated as ours only when the node path,
  arguments, working directory, principal (current user, Interactive, Limited), both
  triggers (5-minute repetition + AtLogOn for this user), and settings
  (`IgnoreNew`, 10-minute limit) all match. Anything else is foreign and is neither
  overwritten nor removed. `-NodePath` must be a file, not a directory.
- No hard guarantee and no E2E: needs a logged-in user, running Task Scheduler service,
  running opencode server with `service.json`, and node at an explicit path.
