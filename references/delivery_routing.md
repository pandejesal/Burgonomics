# BURGONOMICS — Multi-Provider Delivery Dispatch Routing (Layer 3 Constraint)

> **Reference Specification**: Cheapest-serviceable-wins routing across Borzo and Shadowfax, with the branch's own in-house rider as the restaurant-chosen path — parallel quote fan-out, booking failover, normalized provider webhooks. Extends (does not replace) [delivery_porter.md](file:///c:/Users/DELL/Desktop/Burgonomics/references/delivery_porter.md).

> **Provider status (2026-10-22, business decision):** **Porter is retired** — the
> contract was cancelled. Live dispatch partners are **Borzo** and **Shadowfax**;
> a branch may instead hand the order to **its own in-house rider**
> (`POST /orders/manualDispatch` → `deliveryStatus: dispatched` with
> `dispatchType: "manual_branch_terminal"`, the Partner app's "Assign In-House
> Delivery Staff" modal). `manually_assigned` is NOT a value this backend writes. Porter is now
> **opt-in** (`PORTER_ENABLED` must be exactly `"true"`); an unset value keeps it
> out of the quote fan-out. The adapter remains for compatibility with historical
> orders; the paste lane remains open for staff-recorded bookings and makes no
> provider call. **There is no history-only mode:** `PORTER_ENABLED=true` re-arms
> Porter for new quotes, paid bookings and rebookings too. While false/unset,
> DR1's Porter tie-break and the automatic DR8 fallback are dormant.

---

## 0. Research Decisions & Design Constraints (locked)

> Grounding: **Borzo** (`borzodelivery.com`, Business API 1.8: `calculate-order` / `create-order` / webhooks, test env `robotapitest-in.borzodelivery.com`) covers Ahmedabad/Surat/Vadodara with restaurants in scope — primary provider. **Shadowfax** covers 100+ hyperlocal cities incl. our branches (restaurants category; per-city API rider-confirmation contract). **Porter** is bike-only, quote-as-coverage (D3/D4), and has **refused food-vertical API access** — hence the manual-hybrid lane. Excluded: Shiprocket Quick (6-city aggregator only), Dunzo (shut down 14 Jan 2025), magicpin/MagicFleet (no public API).

- **DR1 — Cheapest serviceable wins**: routing picks the provider with the **lowest successful quote fare** among providers that pass serviceability. Ties break by fixed priority: `borzo > shadowfax > porter`.
- **DR2 — Per-provider fail-closed (inherits D1/D2)**: a provider's failed quote is recorded as a **provider-level failure**, never a silent fallback to a static rate card. A provider failure only makes *that provider* unavailable; it does not abort the fan-out. Only when **every** eligible provider fails (or none are eligible) does the quote fail closed: delivery unavailable.
- **DR3 — Serviceability is per-provider**: `not_serviced` (address outside that provider's coverage / unsupported pin / branch-radius fail) is distinct from `transient_failure` (timeout / 5xx / network). Only `transient_failure` is retryable. *Deviation recorded 2026-10-17: the per-address `not_serviced` exclusion "for the session" is **not implemented** — `runQuoteFanOut` re-attempts every eligible provider on every quote, so nothing is cached or remembered. Documented intent, owner decision pending (`audit-results/integrations-2026-10-17/audit-dispatch.md` finding 7).*
- **DR4 — Branch-radius pre-check stays first**: the existing D3 two-stage check (`radius gate → provider-quote gate`) runs once before the fan-out. Radius failure short-circuits: no provider is called, result is `not_serviced`.
- **DR5 — Parallel fan-out**: all eligible providers are quoted **concurrently** (`Promise.allSettled`, per-provider timeout `DISPATCH_QUOTE_TIMEOUT_MS`, default 6000 ms). The slowest provider never serializes the checkout.
- **DR6 — Booking failover is bounded**: `book` books the quoted winner; if its booking fails (`transient_failure` **or** a book-time `not_serviced` — the quote expired between quote and book), the router falls through to the **next-cheapest serviceable provider from the same quote**, in order, until one books or the list is exhausted. Never books a provider that had no successful quote in the session. Every failed attempt is recorded in `dispatchAttempts[]`.
- **DR7 — Re-quote at book time (D6)**: fares live for 10 minutes (`expiresAt`). If the quote expired at booking, the router re-runs the fan-out and books the new cheapest-wins winner; a materially different fare is surfaced to staff before committing (fare delta ≥ ₹20 or ≥ 10% ⇒ confirm step in UI).
- **DR8 — Porter manual-hybrid lane (DORMANT — Porter retired 2026-10-22)**: this lane only arms when a deployment deliberately sets `PORTER_ENABLED=true`. While armed, the behaviour below applies; while retired (the default) it is *not* the exhaustion floor — the walk ends in `dispatch_failed`, whose copy already points staff at in-house assignment. Armed behaviour: when Porter wins (or is the only serviceable provider) but no `PORTER_API_KEY` is configured, booking returns `manual_action_required` — staff books a rider in the Porter app and pastes `porterOrderId` + tracking URL into the KDS paste form (`POST /dispatch/porter-manual`). The lane is also the **exhaustion floor**: when every keyed API provider in the ranked walk fails, an eligible unkeyed Porter quote still ends the walk in `manual_action_required` instead of a dead `dispatch_failed`. On key grant, the same code path books via API with no UI change (lane auto-activates).
- **DR9 — One normalized lifecycle**: regardless of provider, orders converge on the same lifecycle fields (`deliveryStatus`, `status`, rider identity, `needsRebook`). Provider webhooks are normalized to `DRIVER_ALLOCATED / ARRIVED_AT_PICKUP / STARTED_DELIVERY / DELIVERED / RIDER_CANCELLED / NO_RIDERS_FOUND` before touching the order — the existing Porter status semantics, rebook guard (NOT_REBOOKABLE), branch rebook alert, and polling dead-letter worker all apply unchanged.
- **DR10 — Webhooks are fail-closed and provider-scoped**: each provider webhook verifies its **own** secret (`BORZO_WEBHOOK_SECRET` = Borzo Callback Secret Key, HMAC-SHA256 in `X-DV-Signature`; `SHADOWFAX_WEBHOOK_SECRET` = static shared value in the custom `x-shadowfax-signature` header — Shadowfax has no native HMAC, though a body HMAC also verifies; existing Porter secret). Empty secret ⇒ deny (401). A providerOrderId resolves through `dispatch_order_map` first (server binding), echoed ids are hints only; unknown/conflicting/stale events **park** — never flip order state; known-inert lifecycle noise marks processed silently; a late non-terminal event arriving after `delivered` is ignored (no rewind).
- **DR11 — Mocks are explicit and marked**: `MOCK_BORZO_DISPATCH` / `MOCK_SHADOWFAX_DISPATCH` / existing `MOCK_PORTER_DISPATCH`, exact `"true"` only. Mock providers return clearly-marked `[TEST]` riders/fare and can never run in production (`assertProductionKeys`).
- **DR12 — Test-window readiness gate (opt-in)**: `DISPATCH_REQUIRE_LIVE` (exact `"true"` only) makes `dispatchQuote` and `dispatchBook` refuse **before any provider traffic** unless the readiness preflight passes: no dispatch mock active, the configured courier host is the agreed **TEST** host (`borzo` ⇒ `BORZO_TEST_HOST`, `shadowfax` ⇒ `SHADOWFAX_TEST_HOST`), no unverified-contract Shadowfax eligible, no Porter eligible. Any other value (unset/false) ⇒ inert, so dev and production behaviour is unchanged. At staging boot the secret assert requires a capability's secrets **only when that integration is enabled** (`PORTER_ENABLED=false` never demands `PORTER_*`). Production requires the core payment/OTP secrets plus every enabled capability; because Porter is retired it is no longer in the unconditional production set — its secrets become mandatory only when `PORTER_ENABLED=true`. No signature check is relaxed. Operational note: **no poll fallback exists for Borzo** (only `pollActivePorterDeliveries`), so without a registered callback + `BORZO_WEBHOOK_SECRET` the Borzo **status** leg is BLOCKED — quote/book evidence only.

---

## 1. Provider Matrix

| Provider | Role | Quote API | Book API | Webhooks | Enable condition |
|---|---|---|---|---|---|
| **Borzo** | Primary | `calculate-order` | `create-order` | HMAC `x-dv-signature`, `BORZO_WEBHOOK_SECRET` | `BORZO_API_KEY` set |
| **Shadowfax** | Secondary | serviceability quote (`PUT /api/v1/order-serviceability/`) | `POST /api/v2/orders/` | static shared secret (custom header, HMAC also accepted) `x-shadowfax-signature`, `SHADOWFAX_WEBHOOK_SECRET` | `SHADOWFAX_API_KEY` + `SHADOWFAX_CLIENT_CODE` set |
| **Porter** | RETIRED (dormant) | `POST /v1/orders/quote` | `POST /v1/orders/create` or **manual paste** | HMAC `x-porter-signature` | **`PORTER_ENABLED=true` required** (retired 2026-10-22); API path also needs `PORTER_API_KEY`, manual paste lane needs none |

A provider **not keyed** is excluded from the fan-out (not a failure, DR2) — **except Porter while explicitly armed** (`PORTER_ENABLED=true`), which quotes from its rate card unkeyed (quote-as-coverage, D3): an armed, unkeyed Porter still participates in cheapest-wins and, when it wins the walk, books through the DR8 manual lane. With the retired default it never enters the fan-out. Priority order (tie-break + failover order after price) while armed: `borzo > shadowfax > porter`; while retired: `borzo > shadowfax`.

---

## 2. Quote Flow (checkout + partner card)

`POST /dispatch/quote` `{ pickupLat, pickupLng, dropLat, dropLng, orderId? }`:

1. **Radius gate (DR4)** — `checkBranchDeliveryServiceability`; fail ⇒ `{ serviceable: false, reason: "not_serviced" }`, no provider calls.
2. **Eligibility** — providers enabled + keyed (+ mock-flagged ones). *(No per-address `not_serviced` cache exists — see DR3.)*
3. **Fan-out (DR5)** — parallel quotes with timeout; each result is `{ provider, outcome: "ok" | "not_serviced" | "transient_failure", fareKm?, fare?, quoteId?, expiresAt?, error? }`.
4. **Winner (DR1)** — min fare among `ok`; ties → priority order.
5. **Response** — winner flattened at top level for back-compat (`estimatedFare`, `estimatedDistanceKm`, `estimatedPickupMinutes`, `pickupEtaEstimated`, `quoteId`, `vehicleType`, `source`, `expiresAt`, `validForSeconds` = 600) **plus** `winner: provider`, `providers: ProviderQuoteOutcome[]`, `serviceable`, `quotedAt`. `pickupEtaEstimated: true` means the ETA is our local estimate because that provider sent none — surface it as an estimate, never as the courier's own promise.
6. **No winner** ⇒ HTTP 503 `{ serviceable: false, reason }` — never a static fare (DR2). Customer pays the winner's fare at checkout (or ₹0 free-delivery threshold — unchanged).

---

## 3. Book Flow (Partner POS dispatch)

`POST /dispatch/book` `{ orderId, staffName, preferredProvider? }` (staff-authed, branch-scoped):

1. Load order; existing dispatch claim TTL guard applies (no double-book).
2. Fresh quote via §2 (DR7) unless a non-expired quote is supplied.
3. Book the winner; on `transient_failure` walk the ranked `ok` list (DR6), recording every attempt on the order (`dispatchAttempts[]`).
   - **Ambiguous is never transient.** A provider returning 2xx with no usable order id has *accepted* the request; the delivery may already exist. That case throws a **plain** (non-`ProviderDispatchError`) `502 PROVIDER_BOOK_AMBIGUOUS`, so the router releases the claim and stops instead of walking to the next rider and booking a second real courier for one order. `dispatch.router.ts` implements exactly that: it walks on only for `ProviderDispatchError` (`isProviderDispatchError`), any other throw releases the claim and rethrows.
     - **Implemented for Borzo and Shadowfax.** Both adapters throw the plain tagged error when it would otherwise look like a retryable fault — `borzo.adapter.ts` covers four book-time shapes (timeout/abort without a usable id, `order_is_duplicate` refusals, a non-success body that still names an order id, and accepted-with-no-usable-order-id) through one `borzoBookAmbiguous()` helper [committed `b4d43ed` "never walk to a second courier on an ambiguous Borzo create-order"], and `shadowfax.adapter.ts` guards the accepted-with-no-usable-order-id shape inside its create-order response handling. Cite these two files by behaviour or symbol, never by line number: they are being edited concurrently by other lanes.
     - **KNOWN DEVIATION — Porter does not satisfy this rule today (owner: lane 04, dispatch).** `porter.service.ts` *does* tag the no-order-id condition as `code = "PROVIDER_BOOK_AMBIGUOUS"` (the same tag `porter.service.ts` later reads back for `porterDispatchStatus: "needs_reconciliation"`), but `porter.adapter.ts` re-wraps every Porter failure that is not 404/422 into `ProviderDispatchError("porter", "transient")`, and wraps the missing-`porterOrderId` return the same way. The router therefore treats a Porter ambiguous book as a walkable transient fault and can fail over to the next provider for an order Porter may already hold — the second-courier risk this rule exists to prevent. The tag is currently dead from the router's perspective. Proposed fix (source hunk, lane 04 to claim): in the adapter's catch, detect `err?.code === "PROVIDER_BOOK_AMBIGUOUS"` and rethrow it *unchanged* (plain, `statusCode: 502`), and do the same instead of a transient wrap at the no-order-id return; add a router/worker-level test that an ambiguous Porter book does not book another provider. Until that lands, do not rely on the no-failover guarantee when Porter is in the ranked walk.
     - **The guarantee is per request, not per order.** Even for a compliant provider, the plain ambiguous throw goes through `dispatch.router.ts`'s `releaseClaimFailed`, which sets `needsRebook: true` and `rebookTrigger: "dispatch_failed"`. The scheduled auto-rebook worker then re-enters the ranked walk with `excludedProvidersFor(order)`, and that exclusion set is built only from `dispatchProvider` / `porterOrderId` / `borzoOrderId` / `shadowfaxOrderId` — none of which an ambiguous book writes. So a *later* automatic attempt can still produce a duplicate or second courier unless staff reconcile the ambiguity before approving a rebook. Treat the within-request no-failover rule as the guarantee that exists; treat cross-request rebooking as an open reconciliation gap for all three providers.
     - The ambiguous-book rule itself lives in the adapters, not in `providers/shared.ts` (that module holds HTTP classification, address assembly, fare-delta math and mock riders) — an earlier revision of this bullet pointed at `shared.ts` incorrectly.
   - **Missing local input is never transient either.** A missing pickup/drop contact phone is *our* gap, not a provider failure: `422 DISPATCH_CONTACT_MISSING` (plain error), no failover, because no provider can serve that order.
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

**Retry signalling (why a park is not always a 200).** Binding rows are written *after* the provider's book response, so a callback can legitimately arrive first. For the one park class a retry can still resolve — an event naming a real provider order that is not bound *yet* (`unbound_order`, `no_matching_order`) — the handler parks the event and then answers **503 `DISPATCH_WEBHOOK_RETRY`** (`DispatchWebhookRetryRequested`), keeping the provider's documented retry schedule alive (Borzo retries with increasing intervals for 24h until it gets a 2XX). Terminal parks (id conflict, unsafe hint, unknown event, no reference at all) still answer **2XX**, because retrying cannot change them and 24h of retries would be noise. Redelivery stays idempotent: only `processed` dedups, a parked row is re-parked with one review row and no second alert.

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
| `POST /porter/quote \| book \| rebook \| webhook` | optionalAuth (quote) · staff (book, rebook) · HMAC (webhook) | **Back-compat**: quote and webhook unchanged; `book`/`rebook` return **409 `PORTER_RETIRED`** unless `PORTER_ENABLED=true`. Existing Porter tests keep passing because they opt in explicitly. |

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
SHADOWFAX_WEBHOOK_SECRET, SHADOWFAX_CONTRACT_VERIFIED (human-set `"true"` only after the
  native contract is confirmed — keys alone must not enable live traffic), MOCK_SHADOWFAX_DISPATCH
DISPATCH_QUOTE_TIMEOUT_MS (default 6000), DISPATCH_FARE_CONFIRM_DELTA_INR (default 20)
PORTER_ENABLED=false (retired 2026-10-22; `"true"` re-arms FULL dispatch including
  new-order fan-out, paid book and rebook — NOT a history-only switch;
  while false, PORTER_* are NOT required at boot)
```

Fail-closed conventions unchanged (§env.ts): secrets default `""`, mocks exact `"true"`, empty webhook secret denies, production boot bans mocks. Key requests append Borzo/Shadowfax to [KEYS_REQUEST_FOR_BURGONOMICS.md](file:///c:/Users/DELL/Desktop/Burgonomics/KEYS_REQUEST_FOR_BURGONOMICS.md).

---

## 9b. Borzo callback contract (DOC VERIFIED 2026-10-20)

Source: the official Borzo Business API 1.8 doc (`https://borzodelivery.com/in/business-api/doc`) — sections "Notification about order changes", "Notification about delivery changes", "How to track order/delivery", "Status model". This is the vendor's own documentation, read directly; it is not our SDK or a mirror.

DOC VERIFIED:
- The Callback URL is set per account in the Personal cabinet → **"Integration" tab**; delivery callbacks must additionally be **enabled** there. Registration is SELF-SERVICE — it is not a support ticket we must wait for.
- **One** Callback Secret Key is shared by the order and delivery callbacks. That key is what our `BORZO_WEBHOOK_SECRET` names.
- The header is **`X-DV-Signature`** = HMAC-SHA256 of the request data with that key. This confirms the header name our code requires is the vendor's own — it supersedes the earlier "scheme unverified" wording in the conclusive report.
- A non-2xx response is retried at increasing intervals for up to 24h, then the event is dropped and emailed.
- Order callback shape: `{event_datetime, event_type: order_created|order_changed, order: {…status, status_description…}}`; order.status ∈ {new, available, active, completed, reactivated, draft, canceled, delayed}.
- Delivery callback shape: `{event_datetime, event_type: delivery_created|delivery_changed, delivery: {delivery_id, order_id, client_order_id, status, status_description, status_datetime…}}`; delivery.status ∈ {invalid, draft, planned, active, finished, canceled, delayed, courier_assigned, courier_departed, courier_at_pickup, parcel_picked_up, courier_arrived, deleted, return_*, reattempt_*}.
- `active` is scoped and our `SCOPED_EVENT_ALIASES` matches it exactly (order-level = courier assigned and working; delivery-level = courier on the way).
- `courier_departed` = "Courier departed to the pick-up point" — the parcel is NOT moving; `parcel_picked_up` is the handover event; `courier_arrived` = waiting for the customer; `finished` = delivered. Mapping `courier_departed` → `DRIVER_ALLOCATED` is a deliberate under-claim, not a truth error.
- A documented status-query fallback exists: `GET /api/business/1.8/orders?order_id=&status=` (count ≤ 50; `order_id` also accepts a list) plus the courier route/location method (`GET …/courier`, courier location while `active`). The "no poll fallback in code" gap therefore HAS a documented alternative; a poll worker remains unbuilt (next-action, needs a scheduler decision).
- DOUBLE-SOURCED 2026-10-20: an independent second lane-sourced read of the same doc plus the Postman collection (`data/json/business-api/postman_collection_in.json`, cabinet path `borzodelivery.com/in/cabinet/integration`) confirmed every claim above verbatim, including the three absences. One Postman nuance: its retry wording accepts "2xx-3xx" as success where the doc text says 2xx — our webhook endpoint returns 200, satisfying either. Retries mean the SAME event can be delivered more than once, which the status-gated dedup exists for.

STILL UNDOCUMENTED — asks, never asserted:
- The exact encoding of `X-DV-Signature` (hex vs base64). This ambiguity is exactly why the verifier now accepts both representations of the same digest.
- The exact bytes hashed ("request data" — assumed raw body; verify with a real TEST callback).
- Whether the apitest (TEST) account exposes the Integration-tab Callback URL + Callback Secret Key, and whether delivery callbacks can be enabled there.
- Whether a TEST order can ever dispatch a real courier. `DISPATCH_ALLOW_TEST_BOOKING` stays `false` until this is confirmed in writing.

Shadowfax unchanged: no native contract evidence exists locally.

---

## 10. Out of Scope (documented, revisit on demand)

- Shiprocket Quick aggregation (6-city; would replace Borzo/Shadowfax as a single aggregator — revisit if manual provider ops become a burden).
- Per-order size/weight routing (D5 bike-for-all assumption still holds for Porter; Borzo/Shadowfax vehicle classes mapped to bike-only until catering volume justifies upgrades).
- Auto-dispatch on `ready` (dispatch stays staff-triggered per delivery_porter.md §2).
