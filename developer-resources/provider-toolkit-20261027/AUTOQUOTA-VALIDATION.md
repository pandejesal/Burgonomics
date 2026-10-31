# Automatic ChatGPT account switching — 2026-10-28 (local)

## Result

Enabled and loaded as `burgonomics.chatgpt-autoquota` through the native project
plugin discovery path `.opencode/plugins/chatgpt-autoquota.js`. Its read-only
`chatgpt_autoquota_status` tool is available and has returned real quota data.
This supersedes the initial quota-telemetry blocker in the earlier setup notes.

Rule: **OpenAI → OpenAI 2 when either reported window has <10% remaining**.
No manual switch, model/provider change, automatic return, token export, private
usage endpoint, speculative quota estimate or replay of an in-flight call.

## Verification

Isolated source/worktree:
`C:\Users\DELL\Desktop\Burgonomics\.swarm-worktrees\chatgpt-autoquota-20261027`.

```text
npx tsc --noEmit                                      exit 0
npx vitest run --maxWorkers=1 --no-file-parallelism     45 passed, 0 failed
npm run build                                        exit 0
```

Two test files cover fractional/strict 10% boundaries, primary and secondary
windows, invalid/absent/stale headers, reset expiry, first-party origin checks,
429 versus server errors, source-account attribution, simultaneous responses
across location instances, cooldown on activation failure, one-way behavior,
OAuth mapping validation, deferred resource readiness and unread response bodies.
Synthetic below-threshold tests call the supported credential activation adapter.
No real account was intentionally exhausted to force a threshold crossing.

Runtime 1.0.1:
`C:\Users\DELL\AppData\Local\BurgonomicsDevTools\chatgpt-autoquota-1.0.1`.
Type-only SDK dependency is pinned to installed OpenCode 2.1.2; compiled runtime
has no npm imports. Existing app dependencies/source and all eight MCP server
definitions are unchanged. The old model-fallback plugin stays disabled.

The first package-directory registration did not appear in the live catalog.
The verified deployment uses a native auto-discovered JS adapter instead. It
imports the tested built runtime and injects only the two nonsecret credential IDs.
The obsolete, tiny runtime 1.0.0 is retained but not registered. No reinstall of
the MCP packages or previous resource downloads occurred.

## Live proof and current account

The second account was already active. Setup did not activate it or switch back
to the first. A temporary, tool-denied session issued a minimal native OpenAI
generation solely to establish a fresh connection; that session was then removed.
Afterward the status tool reported:

```json
{
  "enabled": true,
  "thresholdRemainingPercent": 10,
  "direction": "first_to_second_only",
  "activeAccount": "second",
  "observedResponses": 1,
  "quotaResponses": 1,
  "lastQuotaAccount": "second",
  "lastQuota": [
    { "window": "primary", "usedPercent": 39, "remainingPercent": 61 },
    { "window": "secondary", "usedPercent": 26, "remainingPercent": 74 }
  ],
  "lastObservedAt": 1793126252564
}
```

Those are point-in-time percentages, not a guarantee of current quota or a fully
unused account. This proves live header observation and account mapping; the
source-threshold activation path is covered by hermetic tests, not a deliberate
live quota exhaustion. Header semantics come from OpenAI's official client:

https://github.com/openai/codex/blob/50379197779be0e5afcbddb014a34cd1fc08af53/codex-rs/codex-api/src/rate_limits.rs

OpenCode interfaces: https://opencode.ai/v2/docs/build/plugins/server and
https://opencode.ai/v2/docs/plugins, plus the installed 2.1.2 SDK declarations.

## Operational boundaries

- HTTP hooks make newly established OpenAI connections use HTTP instead of
  WebSocket. Already-open requests/connections can finish without new observation.
- Quota is checked on observed responses, not polled while idle. A large request
  may cross the threshold before the next observation. Unknown data does not switch.
- The primary and secondary default Codex windows are read. Unrelated named
  model-specific quota pools and API rate-limit token counters are not substituted.
- Saved-account activation is integration-wide in the OpenCode server, even
  though this trigger is project-local. Parallel in-flight requests are not replayed.
- No automatic fallback from the second account if it becomes exhausted, and no
  automatic return to the first after reset. Native credential errors remain visible.
- No app deployment, payment/POS/delivery action, GitHub write, commit or push.

Backup before the account plugin:
`C:\Users\DELL\AppData\Local\Temp\opencode\chatgpt-autoquota-20261027\opencode.project.before-autoquota.jsonc`.
Disabling/removing the single project adapter stops this automation; it does not
log out accounts, change models, or remove the MCP setup.

## Separate security incident

A configuration diagnostic accidentally printed an unrelated Phoenix Grove key
from pre-existing config. The user was notified to rotate it. No value is repeated
here or in the validation manifest, and no rotation was performed without approval.
ChatGPT credential-value endpoints/export were not invoked.
