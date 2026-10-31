# Setup verification — 2026-10-27

## Initial result (five-server setup)

DONE for the requested development-resource/MCP setup, not for application launch
or live provider integration. Server restarts were handled from saved artifacts;
completed downloads/installations were not repeated.

The subsequent four-capability extension is recorded in `EXTRAS-VALIDATION.md`.
There are now eight registrations, with GitHub waiting for OAuth; automatic
10% remaining-quota account switching is enabled and independently recorded in
`AUTOQUOTA-VALIDATION.md`. The seven-test result below is historical; the toolkit
suite now has eleven tests, with 45 additional plugin tests and live quota proof.

## MCPs

Authenticated OpenCode API status was requested for the explicit Burgonomics
location, not the CLI's default home directory. `mcp-status.json` records all
five as **connected**: Code Review, Context7, Firebase, shadcn and Vera.

Read-only functional checks during setup:

- Code Review read an existing PR template from the downloaded official SDK;
  no PR/comment/review was posted.
- Context7 resolved official Razorpay/shadcn documentation and answered a
  shadcn MCP setup query; no proprietary source or secrets were submitted.
- Firebase returned the existing authenticated environment. It is a
  billing-enabled project, not a newly created sandbox. No collections or
  application records were read/written and no deployment occurred.
- shadcn found the public button registry item without installing it.
- Vera returned its indexed architecture overview. The existing index warns
  that it is stale. A separate semantic CLI lookup timed out; no successful
  semantic-search or comprehensive new-file coverage is claimed from it.

Cold local startup initially timed out. shadcn now uses a persistent, directly
launched 4.23.0 installation, not npx download during startup; the local servers
have documented startup/catalog timeout allowances. Final connections succeeded.

## Resource integrity and local checks

Executed:

```text
node --test C:\Users\DELL\AppData\Local\Temp\opencode\burgonomics-dev-toolkit-20261027\verify-toolkit.test.cjs
7 passed / 0 failed / 0 skipped; exit 0
```

Checks cover JSONC syntax; five enabled overrides; preservation of the original
project settings/permission boundaries; persistent pinned shadcn executable and
existing registry context; three official clean repository origins/commits;
all eleven snapshot byte counts/SHA-256s; skill frontmatter/paths; README links
and explicit vendor-contract limitations.

The new `burgonomics-dev-tools` skill was loaded through OpenCode's skill tool;
all three new skill IDs were also advertised by the running service.

## Scope

- Existing file changed: root `opencode.jsonc`, after an exact backup.
- Added: this resource pack and three uniquely named `.opencode/skills` playbooks.
- Installed: shadcn4.23.0 in isolated local development-tool storage, with
  dependency install scripts disabled. No system Node/npm upgrade.
- No application source/dependency/framework files or existing `references/`
  contracts changed. App TypeScript/Vitest/build gates were not rerun for this
  config/reference-only task; those are separate exact-source evidence.
- No permissions/model/plugin weakening, unrelated global MCP change, keys,
  production writes, live payment/refund/POS/rider/SMS/push action, deploy,
  commit, push or client/vendor send.

The Razorpay MCP source is downloaded only. No merchant account was connected.
Petpooja/Borzo/Shadowfax MCP registrations were not invented from unofficial
search results; Shadowfax's public overview is not an API booking contract.
These tools/resources do not close the already documented launch blockers.
