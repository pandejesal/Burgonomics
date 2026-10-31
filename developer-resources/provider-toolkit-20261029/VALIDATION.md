# VALIDATION — developer-resources/provider-toolkit-20261029

All evidence below was observed live at collection time (2026-10-29 UTC
afternoon, IST evening). Review-only task: downloads plus one global npm CLI
update. No production actions, secrets, or writes to provider systems.

## Statuses from documentation-manifest.json

- Records: **37** (36 `docs/*.md` snapshots + 1 verbatim JSON under `raw/`)
- Statuses: `DOWNLOADED_TEXT` ×32, `DOWNLOADED_DYNAMIC_TEXT` ×3
  (`shadowfax-dev-root`, `reelo-website`, `petpooja-online-ordering`),
  `DOWNLOADED_FROM_JSON` ×1 (Reelo rendered contract), `DOWNLOADED_JSON` ×1
  (Reelo verbatim collection)
- Bytes: **531,992** total; **37 unique sha256** values (one per record)
- Zero records ended in error status. The failed first attempt for
  `reelo-pos-integration-api` (static 21 chars / dynamic 143 chars — Postman
  documenter is a client-rendered page) was replaced by the successful
  verbatim-JSON snapshot + Markdown render in round 2.

## Retrieval methods observed

- Static passes: Scrapling `Fetcher` (HTTP/1.1 with browser-masked headers),
  `main`/`article` text extraction; Log shows plain `200` responses plus the
  logged `403` first attempt for `reelo.io` (recovered via dynamic fallback).
- Dynamic fallbacks: Scrapling `DynamicFetcher` ephemeral headless browser for
  Apiary (Petpooja), `developer.shadowfax.in/docs` (301 → `/docs/home`),
  `documenter.getpostman.com` (attempt), and `reelo.io`.
- Reelo Postman capture: single anonymous `GET` of
  `https://documenter.gw.postman.com/api/collections/14784368/TzzBov5g?segregateAuth=true&versionTag=latest`,
  which is the same public asset the public documenter page loads. Parsed,
  saved verbatim, and rendered read-only to Markdown. Scripts were not
  executed; no Postman/account access was used.

## Content spot-checks (read back after download)

- `docs/shadowfax-api-hyperlocal-orders.md` contains real API content:
  `Place an order › POST /api/v2/orders/` with `PlaceOrderRequest` schema and
  the two documented hosts (staging `hlbackend.staging.shadowfax.in`,
  production `api.shadowfax.in`).
- `docs/reelo-pos-integration-api.md` contains 10 rendered request definitions
  (`{{domain}}/v1/pos/integrations/{{vendor_id}}/rewards/customer`,
  `/points/authenticate`, `/redeem/coupon`, ...) with headers and sample bodies,
  matching the verbatim `raw/reelo-pos-integration-api.json` (54,314 bytes,
  sha256 `8c93f191...`).

## Firebase CLI update (the only environment mutation)

- Before: `firebase --version` → `15.32.1` (npm global)
- Latest published at check time: `npm view firebase-tools version` → `15.34.2`
- Performed: `npm install -g firebase-tools@latest` (completed in ~2m; npm
  reported 2 deprecated/transitive warnings and 2 install scripts left
  blocked by npm's allow-scripts policy: `protobufjs` postinstall and `re2`
  native build. Not force-permitted.)
- After: `firebase --version` → `15.34.2` (verified)
- The `firebase` MCP entry in the project `opencode.jsonc` launches the global
  `firebase-tools/lib/bin/firebase.js`, so it inherits 15.34.2 at its next
  connection. No config file was edited.

## Repository clones (repos/)

| Repo | URL | HEAD commit | git status |
|---|---|---|---|
| razorpay-node | github.com/razorpay/razorpay-node | `b9e8527225a7322ba2671a3bc0b848fd019d2d8c` | clean (fresh shallow clone) |
| razorpay-mcp-server | github.com/razorpay/razorpay-mcp-server | `5b87a0f962449c2e6c35f0d7d6ce0dc4db109f9d` | clean |
| firebase-agent-skills | github.com/firebase/agent-skills | `629709b2d1193043d5508f6f1f3aa9993021da0f` | clean; moved ahead of the 2026-10-27 snapshot `92eed24` |
| petpooja-profile (APIDEVANGELIST, third party) | github.com/api-evangelist/petpooja | `700a211dd7bdeeeebe74d2932ab0b5190df5c9eb` | clean; new import |

None of the checkouts were executed, their dependencies were never installed,
and none of their programs/servers were started.

## Version drift vs provider-toolkit-20261027 (context checks)

- razorpay-node and razorpay-mcp-server are unchanged at the same commit as the
  2026-10-27 snapshot (`b9e8527…`, `5b87a0f…`) — no upstream movement.
- firebase-agent-skills moved (`92eed24…` → `629709b…`).
- Borzo Business API page text for 1.8 is unchanged from 2026-10-27 except the
  provenance header (the pre-change changelog note still applies).
- Petpooja's public Apiary still documents V2.1.0; no newer public API
  documentation surface was found (searches checked).
- Shadowfax now has a public developer portal that did not exist in the
  2026-10-27 snapshot; the ~2,000-char and ~900-char index pages
  (`shadowfax-dev-hyperlocal.md`, `shadowfax-dev-root.md`) are only entry
  points; the substantive pages are the 13 subpage snapshots.

## Workspace hygiene

- File writes were confined to
  `developer-resources/provider-toolkit-20261029/**` (all untracked) plus the
  global npm prefix outside the repository.
- The pre-existing dirty root checkout (34 tracked modified files, +2843/−867,
  e.g. `functions/src/modules/*`, `firestore.rules`, `stages/*`) was left
  untouched throughout; no tracked file was modified or reverted by this task,
  and nothing was committed, pushed, or staged.
- `opencode.jsonc` was read but never modified.
- No production provider action occurred: no payment, refund, webhook test hit,
  KOT push, 86ing toggle, rider booking/sandbox booking, SMS/push/email/outbox
  send, Firestore write, deploy, or secret provisioning.
