# Four additional capabilities — 2026-10-27

## Subsequent update — 2026-10-28 (local)

Automatic account switching is now enabled and live quota telemetry verified;
see `AUTOQUOTA-VALIDATION.md`. GitHub still requires user OAuth. The status and
ten-test result below record the earlier extension, not the current quota state.
The toolkit suite has since expanded to eleven tests, plus 45 plugin unit tests.

## Initial status (historical)

Installed/configured; **not fully complete** because GitHub requires user OAuth
and the requested automatic quota threshold policy has no verified telemetry.

| Capability | Verification |
|---|---|
| Playwright MCP 0.0.83 | Connected, 25 tools; isolated Edge opened `about:blank` and closed it |
| GitHub read-only remote | Eight-registration inventory includes it, status `needs_auth` |
| Firebase Crashlytics | Existing Firebase connected, eight Crashlytics tools advertised; no crash-data call made |
| Mobile MCP 1.0.14 | Connected, 33 tools; discovery returned one local Android device, without operating it |

All five original servers remain connected. The final status query used explicit
`location[directory]=C:\Users\DELL\Desktop\Burgonomics` and showed seven connected,
one awaiting authentication. GitHub sign-in must run in the visible `/mcps` UI;
no hidden background OAuth flow was started. Crashlytics SDK/report integration,
application E2E workflows and device UI actions are not proved by connectivity.

## Local verification

```text
node --test C:\Users\DELL\AppData\Local\Temp\opencode\burgonomics-dev-toolkit-20261027\verify-toolkit.test.cjs
10 passed / 0 failed / 0 skipped; exit 0
```

The suite checks all eight enabled registrations, original settings/permissions
and five server definitions (except the approved Firebase scope extension),
read-only GitHub endpoint/toolsets, package versions/entrypoints/lock integrity,
browser isolation, Mobile telemetry opt-out, existing resource hashes and skills.
It does not treat OAuth or account-rotation blockers as passing acceptance gates.

Playwright/Mobile were installed separately under persistent development-tool
storage with exact top-level versions, dependency lockfiles, `--ignore-scripts`,
and no audit/fund commands. Existing Edge avoids another browser download. Neither
system Node/npm nor app dependencies/source/build artifacts were changed.
No app TypeScript/Vitest/build gate was claimed for this config/reference-only
extension. No code was committed, pushed, deployed or merged.

Backup immediately before this extension:
`C:\Users\DELL\AppData\Local\Temp\opencode\burgonomics-dev-toolkit-20261027\opencode.project.before-four-extras.jsonc`

SHA-256: `1847349236E147D70B866609DFF1D19A5AC8EE6FD17A370444E93C0D14061323`.
The earlier backup and all previously downloaded repositories/docs were preserved.

## Account switching blocker

Secret-free integration metadata confirms two saved OpenAI OAuth connections,
labelled `OpenAI` and `OpenAI 2`. No credential-value endpoint/export was invoked.
The current active account and each account's quota were not verified; neither
account was activated or otherwise changed by setup.

Official V2 documentation supports `auth switch` and plugin credential activation,
but no native 10% policy or authoritative per-account remaining-quota source was
verified. The installed OpenAPI path inventory has no quota/usage endpoint.
HTTP hooks can observe native HTTP responses, but force supported providers onto
HTTP; experimental WebSocket hooks see frames, not a documented quota contract.
Neither is sufficient evidence for safe quota measurement/account attribution.

No fake quota monitor, guessed config, token export or old model-fallback plugin
was enabled. Do not claim a synthetic-policy test would prove real telemetry.
The requested rule remains unimplemented pending a supported quota signal and
verified account mapping/freshness. Manual second-label activation is documented
in the README, not executed here.

## Documentation used

- https://opencode.ai/v2/docs/mcp-servers
- https://opencode.ai/v2/docs/providers
- https://opencode.ai/v2/docs/cli/providers
- https://opencode.ai/v2/docs/build/plugins/server
- https://github.com/microsoft/playwright-mcp (Context7 and installed CLI help)
- https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md
- https://github.com/mobile-next/mobile-mcp (README and installed CLI help)
- Existing installed Firebase CLI MCP feature registry/help and advertised catalog

No live provider, Firebase data, GitHub repository or device UI actions were
performed. Mobile discovery, browser blank-page smoke and tool enumeration were
the only new functional checks.
