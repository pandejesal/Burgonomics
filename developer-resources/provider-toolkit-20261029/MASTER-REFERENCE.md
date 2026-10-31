# MASTER-REFERENCE — every provider resource in one place

Generated 2026-10-29 for `provider-toolkit-20261029`. This single document
references **all** downloaded material, source checkouts, CLI/MCP state and the
workspace's own vendor specs. File-level provenance (URL, retrieval time,
method, HTTP status, bytes, sha256) lives in `documentation-manifest.json`;
repo commits in `repositories.json`; live evidence in `VALIDATION.md`.

Everything below is **public reference material** — never production
configuration, never vendor approval, and no authenticated provider action was
taken to obtain it. Respect each publisher's copyright and license.

Paths in this doc are relative to the toolkit root
(`developer-resources/provider-toolkit-20261029/`) unless marked otherwise.

---

## 1. Razorpay — payments

### Downloaded snapshots (official, docs/)
| File | Covers | Source |
|---|---|---|
| `docs/razorpay-orders-api.md` | Official Orders API | https://razorpay.com/docs/api/orders |
| `docs/razorpay-payments-api.md` | Official Payments API | https://razorpay.com/docs/api/payments |
| `docs/razorpay-webhook-validation.md` | Webhook signature validation & testing | https://razorpay.com/docs/webhooks/validate-test |
| `docs/razorpay-webhook-practices.md` | Webhook best practices | https://razorpay.com/docs/webhooks/best-practices |
| `docs/razorpay-mcp.md` | Official MCP server overview | https://razorpay.com/docs/mcp-server |
| `docs/razorpay-mcp-local.md` | Local MCP setup guide | https://razorpay.com/docs/mcp-server/local |

### Checkout (repos/)
| Path | Commit | Purpose |
|---|---|---|
| `repos/razorpay-node` | `b9e8527` | Official Node SDK (payments/orders/refunds interfaces + examples) |
| `repos/razorpay-mcp-server` | `5b87a0f` | Official MCP **source** — downloaded only, never run/account-connected |

### Live tooling
- Remote MCP **`razorpay-docs`** registered in `opencode.jsonc`
  (`https://razorpay.com/docs/mcp`) — the connected documentation server.

### Workspace internal spec
- `../references/razorpay_payments.md` (authoritative Burgonomics notes)

---

## 2. Firebase — backend + CLI + MCP

### Downloaded snapshots (official, docs/)
| File | Covers | Source |
|---|---|---|
| `docs/firebase-cli.md` | CLI commands & guides | https://firebase.google.com/docs/cli |
| `docs/firebase-mcp.md` | Official MCP server setup/tools | https://firebase.google.com/docs/ai-assistance/mcp-server |
| `docs/firebase-functions-get-started.md` | Cloud Functions get-started | https://firebase.google.com/docs/functions/get-started |
| `docs/firebase-security-rules.md` | Firestore security rules | https://firebase.google.com/docs/firestore/security/get-started |
| `docs/firebase-fcm-server.md` | FCM server integration (URL 301-redirects to `/cloud-messaging/server-environment`) | https://firebase.google.com/docs/cloud-messaging/server |

### Checkout (repos/)
| Path | Commit | Purpose |
|---|---|---|
| `repos/firebase-agent-skills` | `629709b` (was `92eed24` on 2026-10-27) | Official Firebase skill/reference library (Auth, Firestore, security rules) |

### CLI + MCP state
- **Firebase CLI `firebase-tools` 15.34.2** — global npm install updated in
  place this run (`15.32.1` → `15.34.2`, verified via `firebase --version`).
  Two transitive install scripts (`protobufjs` postinstall, `re2`) remain
  blocked by npm's allow-scripts policy; not force-permitted.
- Local MCP **`firebase`** registered in `opencode.jsonc`, launched from the
  global firebase-tools with `--only core,firestore,crashlytics`; it inherits
  15.34.2 at its next connection.
- Also registered (enabled, dev-shared): `context7` (docs MCP), `shadcn`,
  `vera`, `playwright`, `github` (readonly remote), `mobile`, `rea`,
  `code-review`.

### Workspace internal specs
- `../references/firebase_security.md`, `../references/firestore_schema.md`,
  `../references/push_notifications.md` (FCM), `../firestore.rules`,
  `../firestore.indexes.json` (live project config)

---

## 3. Borzo — delivery

### Downloaded snapshots (official, docs/)
| File | Covers | Source |
|---|---|---|
| `docs/borzo-business-api.md` | Business API **1.8** — matches the 2026-10-27 snapshot text; hosts `robotapitest-in.borzodelivery.com` (test) and `robot-in.borzodelivery.com` (production), `X-DV-Auth-Token` auth, `X-DV-Signature`/HMAC-SHA256 callbacks (24 h retry) | https://borzodelivery.com/in/business-api/doc |
| `docs/borzo-integration.md` | Integration overview | https://borzodelivery.com/in/api-integration |

No official Borzo CLI or MCP exists (verified 2026-10-29).

### Workspace internal specs
- `../references/delivery_porter.md` (Porter), `../references/delivery_routing.md`
  and `../references/order_flow.md` (dispatch flow), plus the vendor-supplied
  Borzo review in the temp folder
  `%TEMP%\opencode\courier-docs-20261028\provider-docs-review.md` (volatile path).

---

## 4. Shadowfax — hyperlocal delivery (BIG refresh this run)

The 2026-10-27 toolkit only had marketing pages. Shadowfax now runs an official
developer portal (`developer.shadowfax.in`) and the Marketplaces API is technical:

### Downloaded snapshots (official, docs/)
| File | Covers | Source |
|---|---|---|
| `docs/shadowfax-dev-hyperlocal.md` | Hyperlocal Marketplace API entry page | https://developer.shadowfax.in/docs/api/hyperlocal-marketplace |
| `docs/shadowfax-dev-root.md` | Developer docs index | https://developer.shadowfax.in/docs |
| `docs/shadowfax-api-hyperlocal-authentication.md` | Auth: token + OAuth2 (`POST /oauth/token/`, 24 h OAuth expiry; IP whitelisting for production) | …/hyperlocal-marketplace/authentication |
| `docs/shadowfax-api-hyperlocal-orders.md` | Orders API: `POST /api/v2/orders/` (place, returns delivery cost + `track_url`), edit, get details, cancel, MDND | …/hyperlocal-marketplace/orders |
| `docs/shadowfax-api-hyperlocal-serviceability.md` | Pre-order serviceability check | …/hyperlocal-marketplace/serviceability |
| `docs/shadowfax-api-hyperlocal-sandbox.md` | Sandbox simulation endpoints (rider allotment, arrivals, delivery, returns) | …/hyperlocal-marketplace/sandbox |
| `docs/shadowfax-api-hyperlocal-schemas.md` | JSON schemas (`PlaceOrderRequest`, `OrderDetails`, `LocationDetails` …) | …/hyperlocal-marketplace/~schemas |
| `docs/shadowfax-callbacks.md` | Callbacks guide: webhook URL, status/rider-location payloads, retry policy, idempotency rules | …/docs/hyperlocal/marketplace/callbacks |
| `docs/shadowfax-hyperlocal-overview.md` | Hyperlocal product overview | …/docs/hyperlocal/overview |
| `docs/shadowfax-api-reference.md` | All-apis reference index | …/docs/api-reference |
| `docs/shadowfax-reference-authentication.md` | Generic auth reference | …/docs/reference/authentication |
| `docs/shadowfax-exchange-quickstart.md` | Exchange quickstart | …/docs/exchange/quickstart |
| `docs/shadowfax-forward-logistics-quickstart.md` | Forward logistics quickstart | …/docs/forward-logistics/quickstart |
| `docs/shadowfax-reverse-logistics-quickstart.md` | Reverse logistics quickstart | …/docs/reverse-logistics/quickstart |
| `docs/shadowfax-quick-commerce-overview.md` | Quick commerce overview | …/docs/quick-commerce/overview |
| `docs/shadowfax-hyperlocal-web.md` *(marketing)* | Public hyperlocal landing page | https://www.shadowfax.in/hyperlocal |
| `docs/shadowfax-platform.md` *(marketing)* | Platform overview | https://www.shadowfax.in/innovation |

**Captured hosts:** staging `hlbackend.staging.shadowfax.in`, production
`api.shadowfax.in`. Treat those labels as captured values and validate against
Shadowfax's vendor-issued integration packet before replacing the current
native adapter assumptions. The AfterShip-style file reviewed on 2026-10-28 is
**tracking-only** and is NOT this native contract.

No official Shadowfax CLI/MCP exists (verified 2026-10-29).

---

## 5. Petpooja — POS

### Downloaded snapshots (official, docs/)
| File | Covers | Source |
|---|---|---|
| `docs/petpooja-online-ordering.md` | Online Ordering API **V2.1.0** (Apiary) — menu/catalog sync, `save_order` push, store on/off; browser-rendered snapshot | https://onlineorderingapisv210.docs.apiary.io/ |
| `docs/petpooja-integrations.md` | Partner integrations overview | https://www.petpooja.com/poss/restaurant-integrations |

### Checkout (repos/)
| Path | Commit | Publisher |
|---|---|---|
| `repos/petpooja-profile` | `700a211` | **api-evangelist** (independent third party) — OpenAPI + Postman artifacts for Petpooja's public surface (Menu/Catalog, Orders `save_order`, Stores); useful for shape checks, not vendor-issued |

The workspace's own vendor-issued Petpooja contracts remain authoritative for
payloads: `../references/petpooja_pos.md` and
`../references/petpooja_save_order_api.md` (with the `functions/tests/fixtures/`
samples and the `functions/src/modules/petpooja/*` code they cover). No
official Petpooja CLI or MCP exists.

---

## 6. Reelo — restaurant CRM/loyalty (NEW this run)

No official MCP server and no other public developer docs exist as of this
snapshot; the loyalty program/rewards are configured on Reelo's dashboard.

### Captured material (official Rendered + verbatim)
| File | Covers | Source |
|---|---|---|
| `docs/reelo-pos-integration-api.md` | Rendered contract from the official public Postman documenter: 10 requests under `/v1/pos/integrations/{{vendor_id}}/...` — customer capture, loyalty details (points + redeemable rewards), OTP-authenticated earning/redemption, `redeem/coupon` with OTP, wallet/cashback balancing; `customer_key`/`merchant_id` branch key model | https://documenter.getpostman.com/view/14784368/TzzBov5g (linked from the reelo.io footer as "POS Integration API") |
| `raw/reelo-pos-integration-api.json` | **Verbatim** official Postman collection JSON (54,314 bytes; sha256 `8c93f191…`) | https://documenter.gw.postman.com/api/collections/14784368/TzzBov5g?segregateAuth=true&versionTag=latest |
| `docs/reelo-website.md` | Official marketing overview (reaches Petpooja, Restroworks, Dotpe, AllPOS integrations per FAQ) | https://reelo.io |

### Workspace internal spec
- None yet — Reelo has no entry in `../references/`; this is the only Reelo
  material in the workspace.

---

## 7. Porter — companion delivery provider in this workspace

| File | Covers | Source |
|---|---|---|
| `docs/porter-website.md` *(marketing)* | Marketing overview; claims easy API integration. **No public REST contract was verified to exist** — vendor-gated | https://porter.in |

Vendor-issued internal material stays at `../references/delivery_porter.md`.
No official Porter CLI/MCP exists.

---

## 8. Tooling (shadcn)

| File | Covers | Source |
|---|---|---|
| `docs/shadcn-mcp.md` | shadcn MCP docs (server runs locally, pinned 4.23.0 under `%LOCALAPPDATA%\BurgonomicsDevTools`) | https://ui.shadcn.com/docs/mcp |

---

## 9. How everything fits together (source matrix)

| Vendor | Docs `docs/` | Repo `repos/` | CLI | MCP | Internal spec |
|---|---|---|---|---|---|
| Razorpay | 6 | 2 (`razorpay-node`, `razorpay-mcp-server`) | none | `razorpay-docs` (live) + local source | `references/razorpay_payments.md` |
| Firebase | 5 | 1 (`firebase-agent-skills`) | `firebase-tools@15.34.2` | `firebase` (live) | `references/firebase_security.md`, `firestore_schema.md`, `push_notifications.md` |
| Borzo | 2 | — | none | none | `references/delivery_porter.md`, `delivery_routing.md`, `order_flow.md` |
| Shadowfax | 17 | — | none | none | vendor file review in temp (2026-10-28) |
| Petpooja | 2 | 1 (`petpooja-profile`, third party) | none | none | `references/petpooja_pos.md`, `petpooja_save_order_api.md` |
| Reelo | 3 (2 + raw JSON) | — | none | none (none exists) | none yet |
| Porter | 1 (marketing) | — | none | none | `references/delivery_porter.md` |
| shadcn | 1 | — | — | shadcn (live, local) | — |

Also preserved from the earlier run: `../provider-toolkit-20261027/`
(2026-10-27 snapshots + `SDK-download` notes + MCP extension evidence,
`EXTRAS-VALIDATION.md`, `AUTOQUOTA-VALIDATION.md`). Project safety playbooks:
`../../.opencode/skills/burgonomics-provider-contracts`,
`burgonomics-provider-testing`, `burgonomics-dev-tools`.

## 10. Reproducibility & provenance scripts

- `collect_provider_docs.py` — round 1: static fetch of 23 official pages with
  automatic ephemeral-browser fallback for JS-gated pages; refuses overwrites.
- `collect_round2.py` — round 2: 13 Shadowfax subpages + Reelo Postman verbatim
  JSON + Markdown render; merges into the manifest.
- `probe_round2.py` — link/asset discovery outputs (preserved).
- `documentation-manifest.json` — 37 records, every one `DOWNLOADED_*`, each
  with URL/time/method/status/bytes/sha256.
- `repositories.json` — 4 clones with HEAD commits; never executed.
- `VALIDATION.md` — scripts, statuses, CLI before/after, spot-checks, hygiene.

## 11. Hard boundaries (unchanged)

No live payments/refunds, POS relays or webhook test hits, rider bookings or
sandbox bookings, SMS/push/WhatsApp/email sends, Firestore writes, deployments,
secret provisioning, commits or pushes were performed by or enabled by this
toolkit. Public page downloads, public repo clones and one anonymous public
GET (Postman documenter asset) are the entirety of the network use. Nothing
here proves any production integration works or replaces any vendor's signed
agreement and credential provisioning.
