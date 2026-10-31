# Burgonomics development resources

Downloaded public reference material, not production configuration or permission
to operate a merchant account. The source URLs, retrieval times, file hashes and
repository commits are recorded in `documentation-manifest.json` and
`repositories.json`. Preserve publisher copyrights and each repository's license;
webpage snapshots are for local reference, not a new redistribution license.

## Source checkouts

| Directory | Publisher | Use |
|---|---|---|
| `repos/razorpay-node` | Razorpay | Official Node SDK, payment/order/refund interfaces and examples |
| `repos/razorpay-mcp-server` | Razorpay | Official MCP source and setup reference; downloaded, NOT connected to an account |
| `repos/firebase-agent-skills` | Firebase | Official skill/reference library, including Auth, Firestore and security rules |

All three were cloned without running their code, installing their dependencies,
or registering their own servers. These are nested reference checkouts, not
application dependencies or submodules to add blindly to a release commit.
Existing global Firebase skills were not replaced by duplicate project skills.

## Public documentation snapshots

- Razorpay: [MCP overview](docs/razorpay-mcp.md), [local MCP](docs/razorpay-mcp-local.md),
  [webhook validation](docs/razorpay-webhook-validation.md),
  [webhook practices](docs/razorpay-webhook-practices.md).
- Petpooja: [public V2.1.0 API](docs/petpooja-online-ordering.md),
  [integration overview](docs/petpooja-integrations.md). The Apiary page needed
  browser rendering; its successful rendered snapshot is distinguished from the
  initial insufficient static response in the manifest.
- Borzo India: [Business API](docs/borzo-business-api.md),
  [integration overview](docs/borzo-integration.md).
- Shadowfax: [official platform overview](docs/shadowfax-platform.md). This is
  NOT a delivery API specification, booking contract or verified webhook schema.
- Tooling: [Firebase MCP](docs/firebase-mcp.md), [shadcn MCP](docs/shadcn-mcp.md).

Downloaded text is not guaranteed to reproduce every interactive table or code
block. Consult the linked live source and vendor-issued contract before making a
wire-format change. The existing `references/` specs and stage contracts were
not overwritten. No official Petpooja/Borzo/Shadowfax MCP registration was verified
or invented; request vendor-approved integration material where necessary.

## Enabled development MCPs

`opencode.jsonc` at the Burgonomics root has eight project registrations:
`code-review`, `context7`, `firebase`, `shadcn`, `vera`, `playwright`, `github`,
and `mobile`. Crashlytics extends Firebase; it is not a ninth registration.
Unrelated global servers and model/plugin/permission settings were not changed.
The original project config is backed up under:

`C:\Users\DELL\AppData\Local\Temp\opencode\burgonomics-dev-toolkit-20261027\opencode.project.before-mcp.jsonc`

The later five-server config was separately backed up before adding the four
capabilities as `opencode.project.before-four-extras.jsonc` in the same directory.

- **Code Review:** local diff/review/template tools. PR creation/comments still
  require a separate task and authorization; enabling the server does not post reviews.
- **Context7:** current SDK/framework documentation; never send secrets or
  proprietary source in documentation queries.
- **Firebase:** preserves `core,firestore` and adds `crashlytics`. The current
  authenticated environment is billing-enabled; use read-only metadata or local
  emulators until a specific production action is explicitly approved. Eight
  Crashlytics tools are advertised; SDK integration and actual crash reports
  were not tested. Creating/deleting notes or updating issues needs approval.
- **shadcn:** pinned 4.23.0, installed separately at
  `C:\Users\DELL\AppData\Local\BurgonomicsDevTools\shadcn-4.23.0`.
  Its read-only registry context uses the customer's existing `components.json`.
  No UI component, app dependency, CSS or framework config was installed/changed.
- **Vera:** existing index/connection retained. Its overview warns the index is
  stale; newly downloaded reference repositories are not automatically indexed.
  Do not interpret a search miss as proof that code does not exist.
- **Playwright:** official Microsoft `@playwright/mcp` 0.0.83, installed under
  `C:\Users\DELL\AppData\Local\BurgonomicsDevTools\playwright-mcp-0.0.83`.
  Uses existing Edge, headless and isolated in-memory browser state, not a signed-in
  personal profile. Page-provided WebMCP tools are disabled. Blank-page smoke test
  passed and the page was closed; no application workflow was exercised. Artifacts
  default to `C:\Users\DELL\AppData\Local\Temp\opencode\burgonomics-playwright-mcp`.
  Local/staging use is a workflow restriction, not an enforced network sandbox.
- **GitHub:** official remote `https://api.githubcopilot.com/mcp/readonly`, with
  toolsets `repos,issues,pull_requests,actions`. Configured, **awaiting OAuth**.
  Open `/mcps`, select `github`, and sign in visibly. No token is stored in config,
  no repository/CI data was fetched, and no write tools were requested.
- **Mobile:** community `@mobilenext/mobile-mcp` 1.0.14, installed under
  `C:\Users\DELL\AppData\Local\BurgonomicsDevTools\mobile-mcp-1.0.14`.
  Stdio only; anonymous telemetry disabled. Read-only device discovery succeeded;
  no screenshot, app install/launch, tap, input or other device operation ran.
  Local Android SDK/ADB exists; iOS simulator workflows require macOS/Xcode.
  Cloud-device allocation is not authorized by this setup.

The five local Node-backed servers have startup/catalog allowances for cold
starts. Configuration persists across restarts; a transient failed connection
must still be reported as failed, not called healthy merely because enabled.

## ChatGPT account switching — automatic plugin enabled

The initial telemetry blocker is resolved. A local OpenCode V2.1.2 plugin now
observes first-party Codex quota headers and automatically activates **OpenAI 2**
when **OpenAI** reports less than 10% remaining in either primary or secondary
quota window. Exactly 10% does not trigger. It never changes models or switches
back. No manual account-switch command, token export or private usage API is used.
The old `chatgpt-fallback` model-switching plugin stays disabled.

The auto-discovered adapter is `.opencode/plugins/chatgpt-autoquota.js`; runtime
1.0.1 lives under `C:\Users\DELL\AppData\Local\BurgonomicsDevTools`.
Implementation, tests and build live in `.swarm-worktrees/chatgpt-autoquota-20261027`.
The adapter is an installed development artifact, not part of either app bundle.

Live status confirmed the second account was already active (no forced account
activation was performed). A fresh native model connection exposed real quota
headers: 61% primary / 74% secondary remaining at the recorded observation. This
is a point-in-time observation, not a promise of an unused account or current quota.

The plugin uses HTTP hooks, so newly established OpenAI model connections use HTTP
rather than WebSocket. Already-open requests/connections can finish as before.
It evaluates fresh observed responses, not idle polling; absent/malformed quota
stays unknown and never triggers a guessed switch. In-flight calls are not replayed.
Activation changes OpenCode's integration-wide account, affecting shared sessions.

Read-only diagnostics: `chatgpt_autoquota_status`. See `AUTOQUOTA-VALIDATION.md`
for the 45-test/typecheck/build gates, live telemetry proof, limits and provenance.
`EXTRAS-VALIDATION.md` preserves the earlier MCP-extension evidence.

## Project playbooks

Three locally authored skills live under `.opencode/skills/`:

- `burgonomics-provider-contracts`
- `burgonomics-provider-testing`
- `burgonomics-dev-tools`

They are Burgonomics-specific safety/workflow instructions, not vendor-certified
skills. Use the downloaded official Firebase library as reference without
silently overriding existing skill IDs.

## Boundaries

No live payments/refunds, POS relays, rider bookings, SMS/push sends, data writes,
deployments, secret provisioning, commits, pushes or client/vendor messages were
performed by this setup. Test fixtures, screenshots, SDK examples, downloaded
docs and MCP connectivity do not prove any production integration works.
