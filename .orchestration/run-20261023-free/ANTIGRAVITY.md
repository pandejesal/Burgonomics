# Antigravity subagent channel — 23 October 2026

## Direct OpenCode route (preferred)

The fixed Antigravity model ids work directly as OpenCode session/subagent models:

- `google/antigravity-gemini-3.8-flash-high`
- `google/antigravity-gemini-3.8-flash-medium`
- `google/antigravity-gemini-3.8-flash-low`

Live probe on 2026-10-23: `antigravity-gemini-3.8-flash-low` replied **OK** in a normal
OpenCode session and as an OpenCode subagent (session
`ses_e98f3062fffeVqdu3Sv9rV7f3t`, pinned to the same model), cost 0. Use the fixed
`-low`/`-medium`/`-high` id. The base id `google/antigravity-gemini-3.8-flash` with
`variant: default` returns HTTP 404 on this connection; that is the form that failed
earlier.

These are now part of the scheduler's free pool after DeepSeek's cooldown retry, before
`big-pickle`/`mimo`.

## Antigravity CLI (secondary read-only reviewer)

`agy` 1.4.5 is installed at `C:\Users\DELL\AppData\Local\agy\bin\agy.exe` and authenticated.
Read-only review command:

```powershell
$prompt = Get-Content -LiteralPath <prompt-file> -Raw
agy --model gemini-3.8-flash-high --effort high --output-format json `
  --mode plan --dangerously-skip-permissions --print-timeout 600s --print $prompt
```

Use `workdir` set to the repository. Plan mode plus the prompt's read-only instruction
prevents edits. Do not use `--mode accept-edits` or `auto` unless Main explicitly
authorizes an isolated worktree write.

## Reviews completed

| Commit | Packet | Verdict | Conversation |
|---|---|---|---|
| `636b90d` | lane 07 FCM ownership | APPROVE | `9ad12c48-796d-4ae2-9bcc-bf4a474cadac` |
| `20c4600` | lane 04 dispatch teardown | APPROVE | `9cc0834b-16ea-44fd-afb2-d42b012f27e2` |
| `2b3824d` | lane 11 release infra | APPROVE | `6009bdba-fe61-4270-98ae-6d41d31c884c` |

Each review inspected the final commit bytes, checked scope, tests and the claimed
failure mode, and returned file:line findings. These are independent review legs, not
Main acceptance by themselves.

## Limits

- Antigravity is a separate engine; its quota and model behavior are not the same as
  the OpenCode Zen free allowance.
- A read-only review is not a live provider/device/store proof.
- Do not pass secrets, PII, or production credentials in prompts.
- Do not let Antigravity edit the shared dirty tree. For implementation work, create a
  detached worktree at the current committed HEAD plus only the packet's paths, run
  `agy` there, then review the diff and commit exact paths locally.
