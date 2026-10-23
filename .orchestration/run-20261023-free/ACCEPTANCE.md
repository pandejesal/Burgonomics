# Free-run acceptance record — 23 October 2026

Main verified these local commits against the frozen evidence. Nothing was pushed.

## Accepted locally

| Lane | Repo | Commit | Paths | Gate | Independent review |
|---|---|---|---|---|---|
| 07 FCM ownership | root | `636b90d` | 4 | 952 passed / 2 skipped; build 0 | OpenCode GLM + Antigravity `gemini-3.8-flash-high` APPROVE |
| 08 customer payments | customer | `98c8dc4` | 8 | 93 files / 695 tests; build 0 | DS APPROVE → GLM VERIFIED; all 8 blobs match manifest |
| 04 dispatch teardown | root | `20c4600` | 3 | 959 passed / 2 skipped; build 0 | 2× GLM + Antigravity APPROVE |
| 01 customer addresses | customer | `ea1bc3f` | 5 | 94 files / 721 tests; build 0 | GLM APPROVE_WITH_NOTES |
| 02 restaurant dispatch | partner + root | `6da19bc` + `81e20d1` | 6 + 1 doc | 85 files / 574 passed / 1 skipped; build 0 | DS PASS after fixes + GLM VERIFIED |
| 11 release infra | root | `2b3824d` | 7 | 22/22 focused tests; preflight red/green | GLM APPROVE + Antigravity APPROVE |
| 03 customer menu/a11y | customer | `7affdf6` | 15 | tsc 0; 12 files/89 focused (bundle 6/41); full 104 files/820; build 0; RED 5 files/21 tests | GLM APPROVE_WITH_NOTES (prettier-only notes) |
| 06 Petpooja zero-fabrication | partner + root | `7374d3e` + `ed3bca0` | 2 + 2 | partner 11/11 focused, 649 passed/3 skipped full, build 0; functions 7/7 | Antigravity `gemini-3.8-flash-low` APPROVE |
| 05 Porter references | root | `3f38a76` | 10 | docs-only: 9 full files + 2 Porter hunks; no heavy gate | `big-pickle` APPROVE_WITH_CHANGES → findings closed |
| 05b Porter quote guard | root | `870c548` | 2 | 36/36 focused, 6/6 e2e, full 969 passed/2 skipped, build 0 | `big-pickle` confirmed CLOSED |
| 10 Shadowfax evidence | root | `b6c9269` | 1 | 90/90 focused, tsc 0 | Main read directly; no reviewer child per brief |
| QA 09 reconciliation | root | `91fd901` | 1 | 13/13 commits PASS; staged clean; local-only push evidence | Gemini 3.8 Flash high independent QA |
| QA 12 production handoff | root | `0bc8cec` | 1 | 205-line handoff; functions 969/2, customer 104/820, partner 649/3 | `big-pickle` APPROVE_WITH_CHANGES → fixes applied |

### Residuals

- Lane 07: local code only; no live FCM/device delivery proof. Ledger read and send are not atomic.
- Lane 08: root Phase B two test pins ran 8/8, but the review child hit the 429 and no Phase B root commit was made.
- Lane 01: seed runs on saved-addresses mount; tombstone pruning and route loading/error branches remain limited.
- Lane 02: backend atomic assignment hardening is a separate packet; no live rider booking.
- Lane 11: iOS is BLOCKED (Mac + Xcode + real Apple Team ID); `functions-ci.yml` was inspected, not executed; AABs left untracked because provenance is unstated.
- Lane 03: menu/a11y closeout is local-only; no live device, screen-reader, or app-store pass. Prettier-only review notes were left unapplied so reviewed blobs equal committed blobs.
- Lane 06: production now refuses the built-in demo catalog before any batch write, but there is no live Petpooja credential or vendor round-trip. The reference pin proves wording, not vendor confirmation.
- Lane 05: `stages/10_branches/CONTEXT.md` still describes branch-level `features.porterEnabled` as a live toggle; it is outside this packet and no code reads that field. The unrelated palette/typography/menu-a11y edits in `references/ui_ux_spec.md` remain uncommitted and are not approved by lane 05.
- Lane 05b: the direct `/porter/quote` guard is local code; it does not prove a deployed Cloud Function was rebuilt or that live Porter keys are absent from the deployed environment.
- Lane 10: Shadowfax is `LOCAL CODE VERIFIED` only. The callback signature scheme, declared-value/COD policy, sandbox rider exclusion, live credentials, and vendor contract remain unverified or BLOCKED.
- No deployed/provider/device/store readiness is claimed.

## Antigravity subagent channel

Direct OpenCode models work with the fixed ids
`google/antigravity-gemini-3.8-flash-high`, `-medium`, and `-low` (cost 0).
`antigravity-gemini-3.8-flash-low` replied **OK** in a normal session. The base id with
`variant: default` returns 404, which was the earlier failure.

The authenticated Antigravity CLI remains available as a secondary read-only reviewer:

`agy --model gemini-3.8-flash-high --effort high --output-format json --mode plan
--dangerously-skip-permissions --print-timeout 600s --print "<prompt>"`

Read-only reviews completed:

- `636b90d` (lane 07): APPROVE — conversation `9ad12c48-796d-4ae2-9bcc-bf4a474cadac`
- `20c4600` (lane 04): APPROVE — conversation `9cc0834b-16ea-44fd-afb2-d42b012f27e2`
- `2b3824d` (lane 11): APPROVE — conversation `6009bdba-fe61-4270-98ae-6d41d31c884c`

The CLI is used only as a read-only reviewer in plan mode; no Google API-key billing
model was called.

## Free-model workaround

- One heavy OpenCode worker at a time.
- Auto-compaction reduces context.
- After a 429: retry DeepSeek once after 4 minutes, then use the independent free
  rungs `opencode/big-pickle` and `opencode/mimo-v2.6-flash-free`, then GLM.
- OpenRouter key returns `401 User not found` and is not used.
- Google/Vercel paid API-key routes are not used.
- Server-restart recovery waits for an active owner, classifies the final state, and
  only then starts the next lane.

## Closed

All packets accepted in this window are recorded above. QA 09 reconciled 13/13
accepted commits against the real history; QA 12 produced `PRODUCTION_HANDOFF.md`.
The OpenCode serial dispatcher is stopped so it cannot double-prompt a closed packet.

No push, deploy, real payment/refund, rider booking, vendor write, PII export, secret
change, auth/rule weakening, or foreign staging was performed.
