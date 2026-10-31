# Burgonomics provider toolkit — 2026-10-29 refresh

> **Start here:** [`MASTER-REFERENCE.md`](MASTER-REFERENCE.md) — one document
> that references every doc snapshot, repo, CLI/MCP state and internal spec
> in (and around) this toolkit.

Public reference material only, gathered by scripts stored alongside it. This is
not production configuration and not permission to operate any merchant
account. Source URLs, retrieval times, methods, file hashes and repository
commits are recorded in `documentation-manifest.json` and `repositories.json`.
Preserve publisher copyrights and each repository's license; snapshots are for
local reference, not a redistribution license.

## What changed vs provider-toolkit-20261027

| Area | 2026-10-27 | 2026-10-29 |
|---|---|---|
| Shadowfax | Marketing pages only; native dispatch docs assumed unavailable | **Official developer portal discovered** (`developer.shadowfax.in`): Hyperlocal Marketplace API spec pages for orders, serviceability, authentication, sandbox simulation, JSON schemas, plus a callbacks guide and product quickstarts |
| Reelo CRM | Not covered | **Official POS Integration API captured**: verbatim Postman collection JSON (`raw/`) + rendered Markdown contract (10 endpoints); no official Reelo MCP exists |
| Razorpay | MCP + webhook pages | plus **Orders API** and **Payments API** official pages |
| Firebase | MCP page only | plus **CLI**, **Cloud Functions get-started**, **Firestore security rules**, **FCM server** official pages |
| Petpooja | Apiary + integrations page | plus **third-party API profile repo** (api-evangelist/petpooja) with OpenAPI + Postman cross-check material |
| Porter | Not covered | Official marketing overview snapshot; no public REST contract exists (vendor-gated) |
| Firebase CLI | 15.32.1 (global npm) | **updated to 15.34.2** (global npm; `firebase --version` verified) |
| MCPs | 8 registrations | **No config change needed**: `firebase` MCP launches the global firebase-tools (new version picked up at next MCP restart), `razorpay-docs` remote MCP already registered |

## Source checkouts (repos/)

All cloned `--depth 1` with the recorded commit, never executed, dependencies
never installed, private servers never registered. These are nested reference
checkouts, not application dependencies or submodules to add blindly to a
release commit.

| Directory | Publisher | Use |
|---|---|---|
| `repos/razorpay-node` @ `b9e8527` | Razorpay | Official Node SDK, payment/order/refund interfaces and examples |
| `repos/razorpay-mcp-server` @ `5b87a0f` | Razorpay | Official MCP source and setup reference; downloaded, NOT connected to any account |
| `repos/firebase-agent-skills` @ `629709b` | Firebase | Official skill/reference library, including Auth, Firestore and security rules (moved ahead of the 2026-10-27 snapshot `92eed24`) |
| `repos/petpooja-profile` @ `700a211` | API Evangelist (third party) | Independent profile of Petpooja's public API surface (Menu/Catalog, Orders/save_order, Stores) with OpenAPI + Postman artifacts; useful for contract shape checks, NOT vendor-issued |

## Documentation snapshots (docs/ + raw/)

Every file has a provenance header (source URL, retrieval time, method) and a
manifest entry with `sha256`.

**Razorpay (official):** `razorpay-mcp.md`, `razorpay-mcp-local.md`,
`razorpay-webhook-validation.md`, `razorpay-webhook-practices.md`,
`razorpay-orders-api.md` (new), `razorpay-payments-api.md` (new).

**Firebase (official):** `firebase-mcp.md`, `firebase-cli.md` (new),
`firebase-functions-get-started.md` (new), `firebase-security-rules.md` (new),
`firebase-fcm-server.md` (new; the `/docs/cloud-messaging/server` URL 301-redirects
to `/docs/cloud-messaging/server-environment` — the redirect logged at fetch time,
saved under the page's content).

**Shadowfax (official developer portal, new):**
`shadowfax-dev-hyperlocal.md`, `shadowfax-dev-root.md`,
`shadowfax-api-hyperlocal-authentication.md`, `shadowfax-api-hyperlocal-orders.md`,
`shadowfax-api-hyperlocal-serviceability.md`, `shadowfax-api-hyperlocal-sandbox.md`,
`shadowfax-api-hyperlocal-schemas.md`, `shadowfax-callbacks.md`,
`shadowfax-hyperlocal-overview.md`, `shadowfax-api-reference.md`,
`shadowfax-reference-authentication.md`, `shadowfax-exchange-quickstart.md`,
`shadowfax-forward-logistics-quickstart.md`,
`shadowfax-reverse-logistics-quickstart.md`, `shadowfax-quick-commerce-overview.md`,
plus the marketing pages `shadowfax-hyperlocal-web.md`, `shadowfax-platform.md`.
The captured host list shows a staging host (`hlbackend.staging.shadowfax.in`) and
production host (`api.shadowfax.in`); contract labels/staging values must be
validated against the vendor-issued integration packet before any wiring replaces
the current native adapter assumptions.

**Borzo (official):** `borzo-business-api.md` (Business API 1.8 — identical page text to the 2026-10-27 snapshot; only the provenance header/hash differ), `borzo-integration.md`.

**Petpooja (official):** `petpooja-online-ordering.md` (V2.1.0 Apiary; rendered via
ephemeral browser because the static page is a JS shell),
`petpooja-integrations.md`. The vendor-issued contract in `references/` remains
the authority for payloads.

**Reelo (official, new):** `reelo-pos-integration-api.md` — rendered from the
official public Postman documenter JSON; `raw/reelo-pos-integration-api.json` —
the verbatim collection JSON (54,314 bytes; sha256 in manifest). Endpoints include
customer capture, loyalty details, OTP-authenticated earning/redemption and reward
redemption under `/v1/pos/integrations/{{vendor_id}}/...`. Reelo publishes no
official MCP server and no additional public developer docs as of this snapshot;
the loyalty program configuration happens on Reelo's dashboard side.

**Porter (official marketing only),** `porter-website.md`: claims easy API
integration but no public REST contract was verified to exist. The existing
`references/delivery_porter.md` remains the vendor-provided material.

**Tooling:** `shadcn-mcp.md`.

## CLI and MCP

- **Firebase CLI**: updated in place globally via `npm install -g
  firebase-tools@latest`; verified `firebase --version` → `15.34.2`. Two
  dependency install scripts (`protobufjs` postinstall, `re2` install) were
  reported as "not yet covered by allowScripts" by npm's allow-scripts policy and
  were not force-permitted; the CLI binary itself works. The local `firebase`
  MCP registration in `opencode.jsonc` points at the global install path, so it
  picks up 15.34.2 at its next connection.
- No other official CLIs exist for Razorpay, Borzo, Shadowfax, Petpooja, Reelo or
  Porter as verified at collection time (each vendor's site documents API/MCP
  access, not CLIs). Nothing beyond reference material was installed for them.
- **Razorpay**: the official MCP server [source](repos/razorpay-mcp-server) is
  downloaded but NOT running or connected to an account; the remote
  `razorpay-docs` MCP remains the connected documentation server.
- **Reelo**: no official MCP exists publicly; nothing was invented.

## Reproducibility

- `collect_provider_docs.py` — round 1 static pass (Scrapling `Fetcher`, 3
  workers) with automatic dynamic fallback (Scrapling `DynamicFetcher`, ephemeral
  headless browser) for JS-gated pages; refuses to overwrite any existing file.
- `collect_round2.py` — Shadowfax subpage pass + Reelo Postman JSON snapshot and
  Markdown render; merges into the same manifest.
- `probe_round2.py` — link/asset discovery outputs preserved.
- `documentation-manifest.json` — one record per captured file: url, retrieval
  time, method, HTTP status, text characters, bytes, sha256 (Reelo renders also
  reference their verbatim raw file by hash).

## Boundaries

No live payments/refunds, POS relays, rider bookings or sandbox bookings, SMS/
push/email sends through any provider, Firestore writes, deployments, secret
provisioning, commits or pushes were performed. Downloading pages, cloning
public repos and running one public `GET` to the anonymous Postman documenter
asset are all public read operations. Nothing in this toolkit proves any
production integration works, and nothing here replaces each vendor's signed
integration agreement or vendor-issued credential provisioning.
