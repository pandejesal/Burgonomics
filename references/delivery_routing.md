# BURGONOMICS — Multi-Provider Delivery Dispatch Routing (Layer 3 Constraint)

> **Reference Specification**: Cheapest-serviceable-wins routing across Borzo, Shadowfax, and Porter — parallel quote fan-out, booking failover, Porter manual-hybrid lane, and normalized provider webhooks. Extends (does not replace) [delivery_porter.md](file:///c:/Users/DELL/Desktop/Burgonomics/references/delivery_porter.md).

---

## 0. Research Decisions & Design Constraints (locked)

> Grounding: **Borzo** (`borzodelivery.com`, Business API 1.8: `calculate-order` / `create-order` / webhooks, test env `apitest.borzodelivery.com`) covers Ahmedabad/Surat/Vadodara with restaurants in scope — primary provider. **Shadowfax** covers 100+ hyperlocal cities incl. our branches (restaurants category; per-city API rider-confirmation contract). **Porter** is bike-only, quote-as-coverage (D3/D4), and has **refused food-vertical API access** — hence the manual-hybrid lane. Excluded: Shiprocket Quick (6-city aggregator only), Dunzo (shut down 14 Jan 2025), magicpin/MagicFleet (no public API).

- **DR1 — Cheapest serviceable wins**: routing picks the provider with the **lowest successful quote fare** among providers that pass serviceability. Ties break by fixed priority: `borzo > shadowfax > porter`.
- **DR2 — Per-provider fail-closed (inherits D1/D2)**: a provider's failed quote is recorded as a **provider-level failure**, never a silent fallback to a static rate card. A provider failure only makes *that provider* unavailable; it does not abort the fan-out. Only when **every** eligible provider fails (or none are eligible) does the quote fail closed: delivery unavailable.
- **DR3 — Serviceability is per-provider**: `not_serviced` (address outside that provider's coverage / unsupported pin / branch-radius fail) is distinct from `transient_failure` (timeout / 5xx / network). Only `transient_failure` is retryable; `not_serviced` removes the provider from that address permanently for the session.
- **DR4 — Branch-radius pre-check stays first**: the existing D3 two-stage check (`radius gate → provider-quote gate`) runs once before the fan-out. Radius failure short-circuits: no provider is called, result is `not_serviced`.
- **DR5 — Parallel fan-out**: all eligible providers are quoted **concurrently** (`Promise.allSettled`, per-provider timeout `DISPATCH_QUOTE_TIMEOUT_MS`, default 6000 ms). The slowest provider never serializes the checkout.
- **DR6 — Booking failover is bounded**: `book` books the quoted winner; if its booking fails (`transient_failure` **or** a book-time `not_serviced` — the quote expired between quote and book), the router falls through to the **next-cheapest serviceable provider from the same quote**, in order, until one books or the list is exhausted. Never books a provider that had no successful quote in the session. Every failed attempt is recorded in `dispatchAttempts[]`.
- **DR7 — Re-quote at book time (D6)**: fares live for 10 minutes (`expiresAt`). If the quote expired at booking, the router re-runs the fan-out and books the new cheapest-wins winner; a materially different fare is surfaced to staff before committing (fare delta ≥ ₹20 or ≥ 10% ⇒ confirm step in UI).
- **DR8 — Porter manual-hybrid lane**: when Porter wins (or is the only serviceable provider) but no `PORTER_API_KEY` is configured, booking returns `manual_action_required` — staff books a rider in the Porter app and pastes `porterOrderId` + tracking URL into the KDS paste form (`POST /dispatch/porter-manual`). The lane is also the **exhaustion floor**: when every keyed API provider in the ranked walk fails, an eligible unkeyed Porter quote still ends the walk in `manual_action_required` instead of a dead `dispatch_failed`. On key grant, the same code path books via API with no UI change (lane auto-activates).
- **DR9 — One normalized lifecycle**: regardless of provider, orders converge on the same lifecycle fields (`deliveryStatus`, `status`, rider identity, `needsRebook`). Provider webhooks are normalized to `DRIVER_ALLOCATED / ARRIVED_AT_PICKUP / STARTED_DELIVERY / DELIVERED / RIDER_CANCELLED / NO_RIDERS_FOUND` before touching the order — the existing Porter status semantics, rebook guard (NOT_REBOOKABLE), branch rebook alert, and polling dead-letter worker all apply unchanged.
- **DR10 — Webhooks are fail-closed and provider-scoped**: each provider webhook verifies its **own** secret (`BORZO_WEBHOOK_SECRET` = Borzo Callback Secret Key, HMAC-SHA256 in `X-DV-Signature`; `SHADOWFAX_WEBHOOK_SECRET` = static shared value in the custom `x-shadowfax-signature` header — Shadowfax has no native HMAC, though a body HMAC also verifies; existing Porter secret). Empty secret ⇒ deny (401). A providerOrderId resolves through `dispatch_order_map` first (server binding), echoed ids are hints only; unknown/conflicting/stale events **park** — never flip order state; known-inert lifecycle noise marks processed silently; a late non-terminal event arriving after `delivered` is ignored (no rewind).
- **DR11 — Mocks are explicit and marked**: `MOCK_BORZO_DISPATCH` / `MOCK_SHADOWFAX_DISPATCH` / existing `MOCK_PORTER_DISPATCH`, exact `"true"` only. Mock providers return clearly-marked `[TEST]` riders/fare and can never run in production (`assertProductionKeys`).

---

## 1. Provider Matrix

| Provider | Role | Quote API | Book API | Webhooks | Enable condition |
|---|---|---|---|---|---|
| **Borzo** | Primary | `calculate-order` | `create-order` | HMAC `x-dv-signature`, `BORZO_WEBHOOK_SECRET` | `BORZO_API_KEY` set |
| **Shadowfax** | Secondary | serviceability quote (`PUT /api/v1/order-serviceability/`) | `POST /api/v2/orders/` | static shared secret (custom header, HMAC also accepted) `x-shadowfax-signature`, `SHADOWFAX_WEBHOOK_SECRET` | `SHADOWFAX_API_KEY` + `SHADOWFAX_CLIENT_CODE` set |
| **Porter** | Tertiary / manual-hybrid | `POST /v1/orders/quote` | `POST /v1/orders` or **manual paste** | HMAC `x-porter-signature` | enabled; API path needs `PORTER_API_KEY`, manual lane needs none |

A provider **not keyed** is excluded from the fan-out (not a failure, DR2) — **except Porter**, which quotes from its rate card unkeyed (quote-as-coverage, D3): an unkeyed Porter still participates in cheapest-wins and, when it wins the walk, books through the DR8 manual lane. Priority order (tie-break + failover order after price): `borzo > shadowfax > porter`.

---

## 2. Quote Flow (checkout + partner card)

`POST /dispatch/quote` `{ pickupLat, pickupLng, dropLat, dropLng, orderId? }`:

1. **Radius gate (DR4)** — `checkBranchDeliveryServiceability`; fail ⇒ `{ serviceable: false, reason: "not_serviced" }`, no provider calls.
2. **Eligibility** — providers enabled + keyed (+ mock-flagged ones) minus per-address `not_serviced` cache.
3. **Fan-out (DR5)** — parallel quotes with timeout; each result is `{ provider, outcome: "ok" | "not_serviced" | "transient_failure", fareKm?, fare?, quoteId?, expiresAt?, error? }`.
4. **Winner (DR1)** — min fare among `ok`; ties → priority order.
5. **Response** — winner flattened at top level for back-compat (`estimatedFare`, `estimatedDistanceKm`, `quoteId`, `vehicleType`, `source`, `expiresAt`, `validForSeconds` = 600) **plus** `winner: provider`, `providers: ProviderQuoteOutcome[]`, `serviceable`, `quotedAt`.
6. **No winner** ⇒ HTTP 503 `{ serviceable: false, reason }` — never a static fare (DR2). Customer pays the winner's fare at checkout (or ₹0 free-delivery threshold — unchanged).

---

## 3. Book Flow (Partner POS dispatch)

`POST /dispatch/book` `{ orderId, staffName, preferredProvider? }` (staff-authed, branch-scoped):

1. Load order; existing dispatch claim TTL guard applies (no double-book).
2. Fresh quote via §2 (DR7) unless a non-expired quote is supplied.
3. Book the winner; on `transient_failure` walk the ranked `ok` list (DR6), recording every attempt on the order (`dispatchAttempts[]`).
4. Winner/provider **manual lane** (DR8) ⇒ `manual_action_required` + instructions, no status flip.
5. On book success: persist `dispatchProvider`, `dispatchOrderId` (+ provider-specific alias, e.g. `porterOrderId`), rider identity, `deliveryStatus: "dispatched"`, `dispatch_order_map` binding, dispatch claim release. Status flip to `out_for_delivery` stays a client action after server confirmation (unchanged Loop 16 semantics).
6. All providers fail ⇒ `dispatchStatus: "dispatch_failed"` + `needsRebook: true` (order stays otherwise actionable) + loud 502 staff error (never a fake fulfillment signal).

`POST /dispatch/rebook` mirrors `/porter/rebook` guard (only `needsRebook` / `rider_cancelled` / `needs_review` / `dispatch_failed`) and re-enters §3 with the same failover.

---

## 4. Porter Manual-Hybrid Lane (DR8)

- Response shape: `{ manual_action_required: true, provider: "porter", instructions, pasteEndpoint: "/dispatch/porter-manual" }`.
- `POST /dispatch/porter-manual` `{ orderId, porterOrderId, trackingUrl, staffName }` (staff-authed): validates id shape + porter.in-only https tracking URL, writes the same order fields a successful API book would (rider slot pending), binds `dispatch_order_map` **and** `porter_order_map`, and sets `deliveryStatus: "dispatched"` + `dispatchStatus: "dispatched"` — the Porter poller queries `deliveryStatus ∈ [dispatched, in_transit]` + `porterOrderId`, so a `dispatch_pending` flip would strand the pasted order outside both the poller and the webhook lifecycle.
- Existing Porter webhook + polling worker then track the pasted order exactly like an API-booked one (shared `porterOrderId` field).
- Fallbacks unchanged: in-house rider assignment and `manualBranchDispatch` remain the escape hatches when no provider can serve.

---

## 5. Normalized Webhooks (DR9/DR10)

| Route | Signature | Provider events → normalized |
|---|---|---|
| `/dispatch/webhooks/borzo` | `x-dv-signature` HMAC (legacy `x-borzo-signature` accepted) | Borzo status model: `courier_assigned`/`courier_departed` → `DRIVER_ALLOCATED`, `courier_at_pickup` → `ARRIVED_AT_PICKUP`, `parcel_picked_up`/`courier_arrived`/`active`(delivery scope) → `STARTED_DELIVERY`, `finished` → `DELIVERED`, `canceled` → `RIDER_CANCELLED`; order-scope `active` → `DRIVER_ALLOCATED`; lifecycle noise (`new`/`available`/`planned`/…) marks processed silently |
| `/dispatch/webhooks/shadowfax` | static shared secret (or HMAC) in `x-shadowfax-signature` | `ALLOTTED` → `DRIVER_ALLOCATED`, `ARRIVED` → `ARRIVED_AT_PICKUP`, `DISPATCHED`/`ARRIVED_CUSTOMER_DOORSTEP` → `STARTED_DELIVERY`, `DELIVERED` → `DELIVERED`, `CANCELLED_BY_CUSTOMER`/`RETURNED_TO_SELLER` → `RIDER_CANCELLED` |
| `/porter/webhook` (existing, untouched) | `x-porter-signature` HMAC | existing mapping |

Common pipeline: verify signature → dedup by deterministic park id (`dispatch_webhook_events`) → freshness window (event time from `timestamp`/`event_datetime`/per-status time fields) → resolve order via `dispatch_order_map` (hint-conflict ⇒ park) → known-inert noise ⇒ mark processed; unknown ⇒ park → late non-terminal event after `delivered` ⇒ ignore (no rewind) → apply canonical order fields (rider fields written only when present) → branch rebook FCM alert on cancellation events. Parks land in `unmatched_dispatch_events` with `reason` + `captureErrorSnapshot` (never silent drops).

---

## 6. Data Model

**Order fields** (additive; all existing Porter fields stay):

```
dispatchProvider?: "borzo" | "shadowfax" | "porter"
dispatchOrderId?: string            // provider order id (porterOrderId kept as Porter alias)
dispatchStatus?: "dispatch_pending" | "manual_pending" | "dispatched" | "cancelled_by_store" | "rider_cancelled"
dispatchClaimedAt?: number | null   // local-clock ms claim lease (null when idle)
dispatchQuote?: { winner, providers: ProviderQuoteOutcome[], quotedAt, expiresAt }
dispatchAttempts?: Array<{ provider, outcome, error?, at }>
dispatchGeoSource?: "live_gps" | "fallback_default"
dispatchSource?: "api" | "manual_paste"
deliveryStatus: existing union (manual lane does NOT flip it — dispatchStatus carries manual_pending)
```

**Collections**: `dispatch_order_map/{dispatchOrderId} → { orderId, provider }` (book-time binding), `dispatch_webhook_events/{parkId}` (dedup), `unmatched_dispatch_events/{parkId}` (parked).

---

## 7. API Surface

| Route | Auth | Purpose |
|---|---|---|
| `POST /dispatch/quote` | optionalAuth | Parallel fan-out quote, cheapest wins |
| `POST /dispatch/book` | staff (roles) | Book winner + failover |
| `POST /dispatch/rebook` | staff (roles) | Guarded rebook into §3 |
| `POST /dispatch/porter-manual` | staff (roles) | Paste Porter order id + tracking URL |
| `POST /dispatch/cancel` | staff (roles) | Porter → `cancelPorterBooking`; Borzo/Shadowfax → local release (`rider_cancelled` + `needsRebook`, `dispatchProviderCancel: "manual-required"` — no documented provider cancel API) |
| `POST /dispatch/webhooks/borzo` | HMAC | Borzo lifecycle events |
| `POST /dispatch/webhooks/shadowfax` | HMAC | Shadowfax lifecycle events |
| `POST /porter/quote \| book \| rebook \| webhook` | unchanged | **Back-compat**: Porter-only path, untouched behavior; existing tests must keep passing |

---

## 8. Partner POS UI

- **Quote card** (Delivery queue / Book Rider panel): winner row first — `Cheapest: <Provider> · ₹X · ETA Y min` — with the full ranked provider list underneath (fare each, `Not serviced` / `Unavailable` badges per DR3).
- **Book button** label reflects the winner: `Book Borzo · ₹68`. Booking confirmation shows which provider actually booked and its order id.
- **Failover toast**: when the booked provider failed and the router fell through, the toast names both providers honestly.
- **Manual Porter form**: shown only on `manual_action_required` — Porter app booking steps, then `porterOrderId` + tracking URL inputs, validate + save (§4).
- Cancel / Rebook / In-house rider UI unchanged.

---

## 9. Env & Keys

```
BORZO_API_KEY, BORZO_CUSTOMER_ID?, BORZO_BASE_URL (default https://robot-in.borzodelivery.com,
  test https://robotapitest-in.borzodelivery.com; adapter appends /api/business/1.8),
BORZO_WEBHOOK_SECRET (Personal-cabinet Callback Secret Key), MOCK_BORZO_DISPATCH
SHADOWFAX_API_KEY, SHADOWFAX_CLIENT_CODE, SHADOWFAX_BASE_URL (default https://api.shadowfax.in),
SHADOWFAX_WEBHOOK_SECRET, MOCK_SHADOWFAX_DISPATCH
DISPATCH_QUOTE_TIMEOUT_MS (default 6000), DISPATCH_FARE_CONFIRM_DELTA_INR (default 20)
PORTER_* unchanged
```

Fail-closed conventions unchanged (§env.ts): secrets default `""`, mocks exact `"true"`, empty webhook secret denies, production boot bans mocks. Key requests append Borzo/Shadowfax to [KEYS_REQUEST_FOR_BURGONOMICS.md](file:///c:/Users/DELL/Desktop/Burgonomics/KEYS_REQUEST_FOR_BURGONOMICS.md).

---

## 10. Out of Scope (documented, revisit on demand)

- Shiprocket Quick aggregation (6-city; would replace Borzo/Shadowfax as a single aggregator — revisit if manual provider ops become a burden).
- Per-order size/weight routing (D5 bike-for-all assumption still holds for Porter; Borzo/Shadowfax vehicle classes mapped to bike-only until catering volume justifies upgrades).
- Auto-dispatch on `ready` (dispatch stays staff-triggered per delivery_porter.md §2).
