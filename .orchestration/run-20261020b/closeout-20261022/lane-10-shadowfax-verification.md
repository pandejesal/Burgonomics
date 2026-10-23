# Lane 10 — Shadowfax fail-closed verification (read-only evidence packet)

Task: `shadowfax-fail-closed-verification` · Owner: root10 `ses_ea5c878abffemS4Xy9icDiSjo8`
· Date: 2026-10-22 / 2026-10-23 · Repo root HEAD at verification: `ed3bca0` (adapter last changed by
`3c8c7c7`; earlier fail-closed work `4be553b`, `a5549fc`, `7ee1685`, `08ec278`).
Truth label: **LOCAL CODE VERIFIED**. No provider call, no credential, no sandbox
response exists. Nothing below is PROVIDER TEST VERIFIED.

Frozen file identities (working tree == committed, `git status` clean for both):

| Path | SHA256 |
|---|---|
| `functions/src/modules/dispatch/providers/shadowfax.adapter.ts` | `A19603446A66EA905B3A5FF459561E6A835AB87F537CD55C7A84F584FC26719F` |
| `functions/tests/dispatch.shadowfax-contract-gates.test.ts` | `E854F146EAAD83291B8149C62F5E21AF6E9EAD8A3FD7F835172D1C8B275F3C5B` |

## Commands actually run (real counts)

Working directory: `functions`
1. `npx vitest run tests/dispatch.shadowfax-contract-gates.test.ts tests/dispatch.provider-contract.test.ts tests/dispatch.readiness.test.ts`
   → **3 files passed, 90 tests passed, 0 failed** (re-run verified).
   The shadowfax contract gate test file alone is **29/29 passed** (`npx vitest run tests/dispatch.shadowfax-contract-gates.test.ts`).
2. `npx tsc --noEmit`
   → **Exit 0** (clean compilation, 0 errors).

No other test processes were started; no full-suite gate was run (this packet does not
have a gate grant and writes no product change).

---

## Verified / Unverified / BLOCKED Split

| Category | Status | Scope / Evidence |
|---|---|---|
| **Fail-closed on missing/partial config** | **VERIFIED** | Local code & tests prove 0 wire calls on missing/blank token or bad base URL (`shadowfax.adapter.ts:77-90, 175-199, 244-269`; `dispatch.shadowfax-contract-gates.test.ts` 29/29). |
| **Fail-closed on production mock leak** | **VERIFIED** | `assertLiveDispatchContext` throws fatal in declared production if `config.mock.shadowfaxDispatch` is true (`env.ts:319-335`). |
| **Error mapping & retry failover bounds** | **VERIFIED** | Router walks only on `isProviderDispatchError`; plain Errors (`DISPATCH_PROVIDER_UNCONFIGURED`, `DISPATCH_PROVIDER_MISCONFIGURED`, `DISPATCH_CONTACT_MISSING`, `PROVIDER_BOOK_AMBIGUOUS`) abort and release claim (`dispatch.router.ts:718-738`). |
| **Independence from Porter & In-House** | **VERIFIED** | Porter retired by default (`env.ts:71`); in-house `manualBranchDispatch` (`porter.service.ts:1511-1548`) operates with zero provider dependencies. |
| **Adapter webhook isolation** | **VERIFIED** | Adapter has no webhook surface; webhook verification and lifecycle handling isolated in `dispatch.webhooks.ts` (lane 04 boundary). |
| **Callback signature scheme** | **UNVERIFIED** | Implementation accepts static secret or HMAC-SHA256 (`dispatch.webhooks.ts:141-169`), but official vendor scheme is not documented. |
| **Declared value & Value-0 policy** | **UNVERIFIED** | Adapter sends `orderValueInr` (fallback `0`) and `paidFlag` ("true"/"false"); business/carrier liability policy remains unresolved. |
| **Live API endpoints & network reachability** | **BLOCKED** | Vendor credentials, sandbox endpoint reachability, official contract docs, and real-rider exclusion guarantees are absent. |

---

## 1. Fail closed without configuration — PROVEN (local)

Adapter (`functions/src/modules/dispatch/providers/shadowfax.adapter.ts`):

- `isEligible()` (lines 244–269):
  `config.shadowfax.enabled && ((!!config.shadowfax.apiKey && !!config.shadowfax.clientCode && config.shadowfax.contractVerified) || config.mock.shadowfaxDispatch)`.
  With **no** credentials it returns `false`. With **partial** credentials (token + client code set, but `SHADOWFAX_CONTRACT_VERIFIED=false`) it returns `false` — keys alone can never put Shadowfax into the live quote fan-out. A whitespace-only token is truthy for eligibility (same caveat as the original token guard) but **refused before any wire call** (below).
- `assertShadowfaxCredentials` (lines 77–90):
  Trimmed token empty → throws plain `Error`, `statusCode 503`, `code DISPATCH_PROVIDER_UNCONFIGURED`. Deliberately **not** a `ProviderDispatchError`, so `dispatch.router.ts` cannot walk the ranked list on it.
- `assertShadowfaxBaseUrl` (lines 175–199):
  Trimmed base must be a parseable absolute `https://` URL, non-empty host, **no** userinfo/query/fragment (bare `?`/`#` included, tested on the raw because WHATWG parses those as empty `search`/`hash`), **root path only**; refuses pre-wire as plain `Error 503 DISPATCH_PROVIDER_MISCONFIGURED`, and returns the validated origin that both wire URLs are built from (no second config read). `http://`, scheme-less hosts, and credential-shaped echoes are refused/redacted (`redactedBaseSlice`, lines 115–149).
- `book()` (lines 345–495):
  Token guard (line 363) → base guard (line 367) → trimmed `clientCode` guard (lines 372–379, walkable `ProviderDispatchError("transient")` by design) → contact-phone guard (lines 392–407, plain `Error 422 DISPATCH_CONTACT_MISSING`) → provider call (lines 418–453). No "book anyway" branch exists.
- Mock path:
  `config.mock.shadowfaxDispatch === true` (exact `"true"` only, `src/config/env.ts` line 144), and the mock branch calls `assertLiveDispatchContext("shadowfax quote/book")` which **throws fatal in a declared production process** if any dispatch mock is active (`src/config/env.ts` lines 319–335). Mock quotes are labelled `source: "shadowfax_mock_rate_card"`; mock riders are `[TEST]`-prefixed.

Pinned by tests (`functions/tests/dispatch.shadowfax-contract-gates.test.ts`):
- Empty token refuses quote/book pre-wire (0 fetch calls).
- Whitespace token treated as missing (0 fetch calls).
- Padded token sent trimmed (`Authorization: Token <trimmed>`).
- Credentials alone cannot enable; explicit `contractVerified: true` required.
- Empty token stays ineligible even with contract flag.
- Mock flag is the only keyless path and disabled provider stays out.
- Whitespace base / scheme-less host / `http://` / bare `?`/`#` / non-root path refuse with 0 fetch calls.
- Base paste-damage repair reaches the wire with the exact validated origin.
- Guard ordering pinned both ways (token → base → clientCode).
- Mock branch indifferent to a garbage base.

**Residual (honest):** A parseable-but-unreachable or exotic host (`https://hk`, `https://host:0`, `https://.`) is NOT rejected by syntax parsing — network/DNS failure then surfaces as a provider `transient` inside `fetchProviderJson`. This is documented in the adapter docstring and is not a credential leak or a propagation of a book claim; it is reachable only via a config value that already passed the syntactic guard.

---

## 2. Signature handling — what exists, what is NOT confirmed

In `functions/src/modules/dispatch/dispatch.webhooks.ts` (`verifyDispatchWebhookSignature`, lines 141–169):
- Empty or missing secret always denies (`return false` → 401).
- For `shadowfax`, the implementation accepts **either**:
  - (a) the configured secret as a static shared value in the custom `x-shadowfax-signature` header (timing-safe compare, trimmed), **or**
  - (b) a body HMAC-SHA256 in hex/base64 (`sha256=` prefix tolerated), verified against `SHADOWFAX_WEBHOOK_SECRET`.

**UNCONFIRMED VENDOR CONTRACT:** No official Shadowfax document in this repository confirms a callback authentication scheme, header name, signing algorithm, or replay window. The code comments record this as an arrangement to be confirmed with the vendor; the code accepts both forms so either arrangement verifies locally. This is **our reading**, not an authenticated vendor requirement.

---

## 3. Error mapping and retry semantics — PROVEN (local, static + tests)

In `functions/src/modules/dispatch/providers/shared.ts`:
- `classifyHttpStatus` (lines 21–39): 401, 403, 429, ≥500 → `transient`; every other non-2xx → `not_serviced`.
- `classifyThrown` (lines 42–46): network / abort / DNS → `transient`.
- `unparseable` → `transient`.
- Every provider network call is bounded (`AbortSignal.timeout(15_000)` in `fetchProviderJson`).

In `functions/src/modules/dispatch/dispatch.router.ts`:
- **Quote fan-out** (`quoteWithTimeout` & `runQuoteFanOut`, lines 344–393):
  Folds any throw into `{ outcome: "transient_failure" | "not_serviced" }` and records it; a failed quote can never book (only `outcome === "ok"` entries are admitted into `ranked`).
- **Book walk** (lines 705–739):
  The `for (const quote of walk)` loop catches errors and executes `continue` **only** when `isProviderDispatchError(err)` is true (lines 718–728).
  Therefore:
  - `transient` and book-time `not_serviced` provider errors retry by walking to the next ranked serviceable provider (DR6).
  - **Plain Errors** — `PROVIDER_BOOK_AMBIGUOUS` (HTTP 2xx without usable `sfx_order_id`, lines 456–476), `DISPATCH_CONTACT_MISSING` (lines 392–407), `DISPATCH_PROVIDER_UNCONFIGURED` (lines 77–90), and `DISPATCH_PROVIDER_MISCONFIGURED` (lines 175–199) — execute `await releaseClaimFailed(...)` and **abort** (`throw err`, lines 731–737); they never walk.
- **Double-book:**
  Within one `book()` invocation, the adapter issues at most one provider POST. If the provider returns 2xx but no order ID, `PROVIDER_BOOK_AMBIGUOUS` halts failover immediately.
  *Limit:* The adapter sends `order_details.client_order_id = ctx.orderId` (line 426), which is the provider-side correlation handle if Shadowfax supports idempotent deduplication (unconfirmed by vendor). This does not prove the absence of a delayed second booking via the auto-rebook worker after `releaseClaimFailed` (that boundary is owned by lane 04's `dispatch-boundary-closeout`).

---

## 4. Declared value / amount handling — what is sent today; policy UNRESOLVED

Payload construction (`functions/src/modules/dispatch/providers/shadowfax.adapter.ts`):
- **Serviceability (quote)** (`serviceabilityPayload`, lines 228–239):
  ```json
  {
    "pickup_latitude": "<string>",
    "pickup_longitude": "<string>",
    "drop_latitude": "<string>",
    "drop_longitude": "<string>",
    "paid": "true" | "false",
    "order_value": "<number>",
    "COID": "<orderId>",
    "stage_of_check": "pre_order"
  }
  ```
- **Create order (book)** (lines 421–452):
  - `client_code`: trimmed `SHADOWFAX_CLIENT_CODE`
  - `order_details`: `{ order_value, paid, client_order_id: orderId }`
  - `pickup_details` / `drop_details`: numeric lat/lng, stripped 10-digit national contact numbers, address blocks
  - `order_items`: real item array (lines 409–416; synthetic single line fallback only when `items` is empty)
- `paid`: string `"true"` iff `order.paymentStatus` is `"completed"` or `"paid"` (`paidFlag`, lines 202–205).
- `order_value`: first finite number among `pricing.grandTotal`, `totals.grandTotal`, `grandTotal`, `total`, `totalAmount`; **falls back to `0`** when absent (`orderValueInr`, lines 208–218).

**UNRESOLVED (human/company policy):**
What declared value Shadowfax requires for:
1. Cash-on-delivery (COD) orders versus prepaid orders.
2. Orders where totals are temporarily missing or 0 (today transmitted as 0).
3. Whether declared value impacts carrier insurance, lost-item liability, or service fee surcharges under the commercial contract.

---

## 5. Porter retirement and the in-house path — INDEPENDENT (verified)

- **Porter retirement:**
  In `functions/src/config/env.ts` (lines 71–85), `config.porter.enabled` is `process.env.PORTER_ENABLED === "true"` (defaults to `false`). Direct Porter booking/rebooking paths reject with `409 PORTER_RETIRED` prior to I/O. Shadowfax shares only generic provider utility types and HTTP plumbing (`shared.ts`), not Porter state, keys, or endpoints.
- **In-house path:**
  `manualBranchDispatch` (`functions/src/modules/porter/porter.service.ts` lines 1511–1548; routed via `/dispatch/manual-branch` in `functions/src/index.ts`) requires only `orderId`, `riderName`, and `riderPhone`. It sets `dispatchType: "manual_branch_terminal"`, `deliveryStatus: "dispatched"`, and clears `needsRebook`/`rebookTrigger`. It makes **zero provider calls and requests zero provider quotes**.
  When external dispatch providers fail, the router's exhausted error messages explicitly direct staff to in-house assignment (`functions/src/modules/dispatch/dispatch.router.ts` lines 543 and 779).

---

## 6. Idempotency / status mapping — boundary stated

At the **adapter level**, there is no callback surface: no deduplication store, no signature verification, and no status transition logic.
Status normalization, deduplication by deterministic park ID (`eventDocId`), freshness windows, `dispatch_order_map` resolution, late-event suppression after `delivered`, and retry signalling are implemented in `functions/src/modules/dispatch/dispatch.webhooks.ts`. That lifecycle management is owned by lane 04's in-flight `dispatch-boundary-closeout` packet (DR9/DR10 rules in `references/delivery_routing.md` §5).
This packet records only that the adapter transmits `client_order_id = ctx.orderId` during create-order, providing the provider-side correlation handle.

---

## Observations (not applied; routing suggestions only)

1. **`order_items` capped at 50:**
   In `shadowfax.adapter.ts` line 410: `items.slice(0, 50)`. Orders exceeding 50 items are truncated without a warning log. The vendor's maximum item limit is unverified.
2. **`serviceable === "false"` string typing:**
   If the vendor returns string `"false"` instead of boolean `false`, the check `res.data.serviceable === false` does not catch it; the flow continues to `delivery_cost` extraction which fails with a transient parse error.
3. **Residual host-shape class:**
   Syntactically valid hosts that are non-resolvable (e.g. `https://hk`) pass `assertShadowfaxBaseUrl` and fail at DNS resolution as a transient fetch failure.

---

## Vendor Question List (Human-Sendable Verbatim)

1. Please provide the official Shadowfax Hyperlocal Marketplace API specification (production base URL, sandbox/staging base URL, authentication headers, serviceability/quote endpoint, create-order endpoint, and tracking/ETA endpoints) as a standalone document or public Postman collection.
2. For the order serviceability (`/api/v1/order-serviceability/`) endpoint: what is the complete request and response JSON schema? Does the quote response provide distance, pickup ETA, drop ETA, quote ID, and quote expiration? How are unserviceable areas or absence of riders indicated (HTTP 400 vs 200 with specific body flags)?
3. For the create-order (`/api/v2/orders/`) endpoint: what is the complete set of mandatory versus optional fields and data types? What are the maximum length constraints for address fields and item array length limits? What is the exact response schema and field name for the canonical provider order ID?
4. What is the declared value (`order_value`) policy? What value must be sent for prepaid versus cash-on-delivery (COD) orders? Does declared value affect transit insurance or liability, and does a value of 0 trigger rejection or penalty?
5. What are the official webhook/callback specifications for order status updates: endpoint registration method, authentication mechanism (custom header with shared secret versus HMAC-SHA256 signature), retry backoff schedule, and payload schema with all possible `order_status` enumeration values?
6. Do callbacks guarantee per-order FIFO delivery ordering, at-least-once delivery, and consistent order identifiers? What deduplication key should be used to prevent duplicate webhook processing?
7. Is a dedicated sandbox environment available, and does test booking in the sandbox guarantee that no real rider will be dispatched? We require written confirmation before performing end-to-end sandbox booking tests.
8. Does the create-order API support an idempotency key (e.g., `client_order_id`), and what is the behavior if a request with an existing key is received (HTTP 409, cached 200, or duplicate order creation)?
9. What are the cancellation rules and APIs for customer-initiated or branch-initiated cancellations? What cancellation charges apply at each order stage, and what callback events are triggered upon cancellation?
10. What are the official credentials provisioning channels, API key rotation procedures, and technical support SLAs for live operations?

---

## BLOCKED / Not Verifiable Locally

- Official Shadowfax API documentation, staging credentials, and webhook registration portal: absent.
- Real provider wire interactions (quote, booking, callback): none attempted or recorded.
- Declared-value liability and cancellation fee schedule: business decision pending commercial terms.
- End-to-end webhook persistence and state machine lifecycle: owned by lane 04.
- Production host network reachability: unprobed (fail-closed constraint).

---

## Truth Label

**LOCAL CODE VERIFIED** — verified against focused local suites (90/90 passing; `dispatch.shadowfax-contract-gates.test.ts` 29/29 passing; `tsc --noEmit` exit 0) and static analysis of committed code. No provider test, sandbox traffic, or production credentials exist.

Review status: Main coordinator review directly (no subagent reviewer children spawned).
