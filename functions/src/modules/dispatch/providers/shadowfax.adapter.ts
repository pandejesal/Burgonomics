import { assertLiveDispatchContext, config } from "../../../config/env";
import type {
  DispatchBookContext,
  DispatchQuoteContext,
  ProviderAdapter,
  ProviderBookResult,
  ProviderQuoteOk,
} from "../types";
import { ProviderDispatchError } from "../types";
import {
  QUOTE_TTL_MS,
  assertProviderOk,
  dropAddressBlock,
  dropContact,
  fetchProviderJson,
  mockRateFare,
  mockRider,
  pickFiniteNumber,
  pickupAddressBlock,
  pickupContact,
  unparseable,
} from "./shared";

/**
 * Shadowfax adapter — Hyperlocal Marketplace API.
 *
 * CONTRACT STATUS: PARTIALLY DOCUMENTED / UNVERIFIED (2026-10-20). The doc URL
 * this file used to call "doc-confirmed"
 * (https://developer.shadowfax.in/docs/hyperlocal/marketplace) returns HTTP 404,
 * the Postman collection is auth-gated (see the book() note), and
 * references/delivery_routing.md records that no native contract evidence exists
 * locally. Every path/field below is therefore OUR READING of partial evidence —
 * verify each one at key grant. The provider stays behind
 * SHADOWFAX_CONTRACT_VERIFIED until a human confirms the contract; credentials
 * alone never enable live traffic.
 *   - Auth (UNVERIFIED): `Authorization: Token <api_token>`, token issued by the
 *     Shadowfax team.
 *   - Quote = serviceability (UNVERIFIED): `PUT /api/v1/order-serviceability/` →
 *     `{ serviceable, pickup_eta, delivery_cost }`. HTTP 400 (non-serviceable
 *     area) and a 200 body with `serviceable:false` both class not_serviced
 *     (DR3) — no fare is invented (DR2). No distance field → haversine.
 *   - Book (UNVERIFIED): `POST /api/v2/orders/` with `client_code`
 *     (SHADOWFAX_CLIENT_CODE), `order_details` (paid is the STRING
 *     "true"/"false"), pickup/drop details (latitude/longitude as numbers),
 *     `order_items`. Response: `sfx_order_id`, `track_url`. The rider arrives
 *     later via the ALLOTTED callback, so book falls back to a pending rider
 *     identity.
 *   - Retry-window note (UNVERIFIED, our assumption): place the order within
 *     minutes of a successful serviceability check (router quotes immediately
 *     before booking, DR7).
 */

function shadowfaxHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    // Trim HERE as well as in the guard: validate-what-you-send. A token pasted
    // with a trailing newline/space would otherwise pass the guard and reach the
    // wire as `Authorization: Token  abc ` -> 401 -> classified transient -> a
    // silent walk to another courier for a LOCAL config fault.
    Authorization: `Token ${(config.shadowfax.apiKey || "").trim()}`,
  };
}

/**
 * Fail closed on a missing token BEFORE any provider call. `isEligible()`
 * already requires the key, so the router never reaches this — but a direct
 * adapter call (a future caller, a test harness, a refactor) would otherwise
 * send `Authorization: Token ` and get an opaque 401 classified as transient.
 *
 * Deliberately a plain Error, not ProviderDispatchError: a missing credential is
 * not a provider failure. At BOOK time that keeps the router from releasing the
 * claim and walking to another courier (it walks only on ProviderDispatchError);
 * at QUOTE time the fan-out already folds any throw into a `transient_failure`
 * outcome, which can never book a rider — so the guard's no-walk guarantee is a
 * book-path property, and quote() simply never hits the wire unauthenticated.
 */
function assertShadowfaxCredentials(operation: string): void {
  // Trimmed: an env value of "   " is not a token. `isEligible()` only checks
  // truthiness, so a whitespace-only key would otherwise pass the eligibility
  // gate and reach the wire as `Authorization: Token    ` (opaque 401).
  const token = (config.shadowfax.apiKey || "").trim();
  if (!token) {
    const err: any = new Error(
      `Shadowfax ${operation} requires SHADOWFAX_API_KEY - refusing to call the provider with an empty token`
    );
    err.statusCode = 503;
    err.code = "DISPATCH_PROVIDER_UNCONFIGURED";
    throw err;
  }
}

function shadowfaxBaseMisconfigured(operation: string, raw: string): never {
  const snippet = raw ? ` "${redactedBaseSlice(raw)}"` : " (empty)";
  const err: any = new Error(
    `Shadowfax ${operation} requires a usable absolute https:// SHADOWFAX_BASE_URL - got${snippet}, refusing to send the auth token to a misconfigured base`
  );
  err.statusCode = 503;
  err.code = "DISPATCH_PROVIDER_MISCONFIGURED";
  throw err;
}

/**
 * The failure path echoes a config value into staff-visible dispatchError and
 * captureErrorSnapshot alerts. Redact BEFORE slicing: 60-char truncation is
 * truncation, not redaction. Three leak shapes (GLM verify findings):
 *   1. scheme://userinfo@ — redact the userinfo.
 *   2. query/fragment secrets — the guard refuses any ?/# anyway, so the echo
 *      is truncated at the first ?/# and nothing diagnostic is lost.
 *   3. credential-shaped authority with NO @ ("https://key:secret") — the
 *      @-rule cannot match it, so the whole authority is elided; the operator
 *      still sees the value type, the secret never leaves the guard.
 * A plain hostname is kept — it is the one piece a debugging operator needs
 * and never a secret.
 */
function redactedBaseSlice(raw: string): string {
  let echo = raw.split(/[?#]/)[0];
  let redactedAt = false;
  const atForm = /([a-z][a-z0-9+.-]*:\/\/)[^@/\s]*@/i;
  if (atForm.test(echo)) {
    echo = echo.replace(atForm, "$1[redacted]@");
    redactedAt = true;
  }
  const schemeMatch = echo.match(/^([a-z][a-z0-9+.-]*:\/\/)([^\s]*)$/i);
  // Credential-shaped colon only (GLM r2 finding 2): a plain "host:8443"
  // authority must stay visible for the operator — elide when the part after
  // the first colon contains a second colon or any non-digit, i.e. looks like
  // a secret, not a port.
  const authority = schemeMatch ? schemeMatch[2] : "";
  const colonAt = authority.indexOf(":");
  const rest = colonAt >= 0 ? authority.slice(colonAt + 1) : "";
  if (
    schemeMatch &&
    !redactedAt &&
    /[:@]/.test(authority) &&
    (colonAt < 0 || /:.+:/.test(authority) || /[^0-9]/.test(rest))
  ) {
    return `${schemeMatch[1]}[authority elided]`;
  }
  // Scheme-less pastes have no :// anchor for the rules above (DS r2 finding
  // 3): "key:secret@host", "key:secret", "//key:secret@host", "mailto:key:secret".
  // Redact any <token>@ generically (idempotent for the [redacted]@ form
  // already produced), then elide a colon-pair value with no endpoint content.
  echo = echo.replace(/([^@\s]+)@/g, "[redacted]@");
  const deScheme = echo.replace(/^\/\//, "");
  if (!/:\/\//.test(echo) && /^[^\s/]+:[^\s/]+$/.test(deScheme)) {
    return "[value elided]";
  }
  return echo.slice(0, 60);
}

/**
 * Fail closed on a misconfigured SHADOWFAX_BASE_URL BEFORE any provider call.
 * `env.ts` only falls back to the default for EMPTY values, so a truthy-garbage
 * env value (paste whitespace, a scheme-less host, an http:// base) used to
 * reach `fetch` verbatim: URL construction threw `TypeError: Failed to parse
 * URL` inside fetchProviderJson, where classifyThrown() relabels EVERY throw
 * as a provider `transient` — the same defect class the empty-token guard
 * closed (4be553b): a LOCAL config fault indistinguishable from the provider
 * having a bad day (walkable at book time). `http://` additionally sends the
 * bearer token in cleartext. Plain Error, not ProviderDispatchError: a
 * misconfigured base is not a provider failure, so the router cannot release
 * the claim and walk to another courier for it.
 *
 * Refuses: unparseable values; non-https schemes; empty hosts; userinfo,
 * query- or fragment-bearing values; and non-root paths. The endpoints are
 * APPENDED to the base, so a bare query marker ("https://host?" — whatwg-parsed
 * search is the EMPTY string, an empty `hash` for "#") would swallow the
 * appended path into the query string, and a non-root path would join into
 * "/v1/api/v1/…" — both are a guaranteed provider 4xx, i.e. a local typo
 * mislabelled not_serviced. Never checks reachability, port, or host shape:
 * a parseable https:// single-label host still goes out (documented residual).
 * Returns the validated base so guard and wire read the same value and cannot
 * drift around an await (DS r2 finding 7).
 */
function assertShadowfaxBaseUrl(operation: string): string {
  const raw = (config.shadowfax.baseUrl || "").trim();
  let parsed: URL | null = null;
  try {
    parsed = new URL(raw);
  } catch {
    parsed = null;
  }
  if (
    !parsed ||
    parsed.protocol !== "https:" ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    // `https://host?` parses with an EMPTY search (and `#` an empty hash), so
    // the parsed-truthiness checks alone miss the bare markers — test the raw.
    parsed.search ||
    parsed.hash ||
    /[\?#]/.test(raw) ||
    parsed.pathname.replace(/\/+$/, "") !== ""
  ) {
    shadowfaxBaseMisconfigured(operation, raw);
  }
  return parsed.origin;
}

/** Shadowfax `paid` is the string "true"/"false" (never a boolean). */
function paidFlag(ctx: DispatchQuoteContext): string {
  const status = String(ctx.order?.paymentStatus || "").toLowerCase();
  return status === "completed" || status === "paid" ? "true" : "false";
}

/** Order value for serviceability/place-order payloads (INR, number). */
function orderValueInr(ctx: DispatchQuoteContext): number {
  return (
    pickFiniteNumber(
      ctx.order?.pricing?.grandTotal,
      ctx.order?.totals?.grandTotal,
      ctx.order?.grandTotal,
      ctx.order?.total,
      ctx.order?.totalAmount
    ) ?? 0
  );
}

/** Contact numbers are bare 10-digit national format (doc examples). Returns
 * "" when no real number can be derived from either source — never the old
 * invented literal "9876543210" (audit finding 5). */
function contactDigits(raw: string | undefined, fallback?: string): string {
  const strip = (v: string | undefined): string => (v || "").replace(/\D/g, "").slice(-10);
  return strip(raw) || strip(fallback) || "";
}

function serviceabilityPayload(ctx: DispatchQuoteContext): Record<string, any> {
  return {
    pickup_latitude: String(ctx.pickup.lat),
    pickup_longitude: String(ctx.pickup.lng),
    drop_latitude: String(ctx.drop.lat),
    drop_longitude: String(ctx.drop.lng),
    paid: paidFlag(ctx),
    order_value: orderValueInr(ctx),
    ...(ctx.orderId ? { COID: ctx.orderId } : {}),
    stage_of_check: "pre_order",
  };
}

export const shadowfaxAdapter: ProviderAdapter = {
  provider: "shadowfax",

  isEligible(): boolean {
    // Both creds are required: quote needs the token, book needs client_code.
    // A keyed-but-incomplete provider is EXCLUDED (DR2), never walked into a
    // guaranteed book failure.
    // Key grant alone is NOT enough: Shadowfax's native contract is UNVERIFIED,
    // so a keyed provider stays out of the live fan-out until a human records
    // SHADOWFAX_CONTRACT_VERIFIED=true. Without this, "keys granted" would
    // silently send real traffic to an unconfirmed integration the moment
    // DISPATCH_REQUIRE_LIVE was off (GAP 2, readiness gate is opt-in).
    return (
      config.shadowfax.enabled &&
      ((!!config.shadowfax.apiKey &&
        !!config.shadowfax.clientCode &&
        config.shadowfax.contractVerified) ||
        config.mock.shadowfaxDispatch)
    );
    // A garbage SHADOWFAX_BASE_URL is DELIBERATELY not an exclusion here: the
    // adapter refuses it pre-wire with the loud DISPATCH_PROVIDER_MISCONFIGURED
    // plain Error, staff-visible through dispatchQuote.providers[].error, which
    // surfaces the operator typo; silently excluding the provider instead would
    // tuck the misconfiguration behind a clean fan-out miss (DR2 demands
    // exclusion for "not keyed", not for config it can name and refuse).
    // NOTE: dispatch.readiness() currently records only urlHost/TEST-host for
    // shadowfax and adds NO violation for a garbage base — the base-refusal
    // lives solely in this adapter (readiness hunk proposed to lane 04).
  },

  async quote(ctx: DispatchQuoteContext): Promise<ProviderQuoteOk> {
    const { calculateHaversineDistanceKm, estimatePickupMinutes } = await import("../../../core/geo");
    const fallbackKm = calculateHaversineDistanceKm(
      ctx.pickup.lat,
      ctx.pickup.lng,
      ctx.drop.lat,
      ctx.drop.lng
    );

    if (config.mock.shadowfaxDispatch) {
      assertLiveDispatchContext("shadowfax quote");
      const distanceKm = fallbackKm;
      return {
        provider: "shadowfax",
        outcome: "ok",
        fare: mockRateFare("shadowfax", distanceKm),
        distanceKm,
        pickupEtaMinutes: 9,
        quoteId: `QTE-SFX-${Math.floor(10000 + Math.random() * 90000)}`,
        expiresAt: Date.now() + QUOTE_TTL_MS,
        source: "shadowfax_mock_rate_card",
      };
    }

    assertShadowfaxCredentials("quote");
    const shadowfaxBase = assertShadowfaxBaseUrl("quote");

    const res = await fetchProviderJson(
      "shadowfax",
      `${shadowfaxBase}/api/v1/order-serviceability/`,
      {
        method: "PUT",
        headers: shadowfaxHeaders(),
        body: JSON.stringify(serviceabilityPayload(ctx)),
      }
    );
    // HTTP 400 "Order in non-serviceable area" → not_serviced via DR3 classify.
    assertProviderOk(res, "shadowfax");

    // 200-but-not-serviceable (no riders / out of coverage) is not a failure
    // class mixup: it is a clean not_serviced verdict (DR2/DR3).
    if (res.data && res.data.serviceable === false) {
      throw new ProviderDispatchError(
        "shadowfax",
        "not_serviced",
        `shadowfax not serviceable: ${String(
          res.data.reason || "no riders or area uncovered"
        ).slice(0, 160)}`
      );
    }

    const fare = pickFiniteNumber(res.data?.delivery_cost);
    if (fare === null) throw unparseable("shadowfax", "serviceability delivery_cost");

    // Provider ETA when it actually sent one; otherwise a LOCAL estimate that is
    // flagged. The previous bare `?? 9` was a fabricated provider-looking number
    // on a customer-visible quote with nothing distinguishing it from real data.
    const providerEta = pickFiniteNumber(res.data?.pickup_eta);

    return {
      provider: "shadowfax",
      outcome: "ok",
      fare,
      // The serviceability response carries no distance — haversine fallback.
      distanceKm: fallbackKm,
      pickupEtaMinutes: providerEta ?? estimatePickupMinutes(),
      etaEstimated: providerEta === null,
      // No server-side quote id exists; the local id + fare are the proof (DR7).
      quoteId: `QTE-SFX-${Date.now()}`,
      expiresAt: Date.now() + QUOTE_TTL_MS,
      source: "shadowfax_api_live",
    };
  },

  async book(ctx: DispatchBookContext): Promise<ProviderBookResult> {
    if (config.mock.shadowfaxDispatch) {
      assertLiveDispatchContext("shadowfax book");
      const providerOrderId = `SFX-ORD-${Math.floor(100000 + Math.random() * 900000)}`;
      const rider = mockRider("shadowfax", ctx.orderId);
      return {
        kind: "booked",
        provider: "shadowfax",
        providerOrderId,
        riderName: rider.name,
        riderPhone: rider.phone,
        riderVehicleNumber: rider.vehicle,
        trackingUrl: `https://shadowfax.in/track/${providerOrderId}`,
        source: "mock",
        geoSource: "live_gps",
      };
    }

    assertShadowfaxCredentials("book");
    // Before the clientCode check: a base-url config fault must surface as the
    // local MISCONFIGURED Error, not be outrun by the walkable transient that a
    // missing clientCode throws.
    const shadowfaxBase = assertShadowfaxBaseUrl("book");

    // Trimmed like the token (GLM r2 finding 3): a whitespace-pasted
    // SHADOWFAX_CLIENT_CODE is not a code — it would reach the wire verbatim
    // as a guaranteed 4xx mislabelled transient; refuse it as missing instead.
    const clientCode = (config.shadowfax.clientCode || "").trim();
    if (!clientCode) {
      throw new ProviderDispatchError(
        "shadowfax",
        "transient",
        "shadowfax client_code (SHADOWFAX_CLIENT_CODE) not configured"
      );
    }

    const order = ctx.order || {};
    const pickup = pickupContact(order);
    const drop = dropContact(ctx);
    const dropAddr = dropAddressBlock(order);
    const items = Array.isArray(order.items) ? order.items : [];

    // A real contact is required to place an order: the old code fell back to
    // the invented literal "9876543210" (audit finding 5). Fail closed instead
    // of transmitting a fabricated number. (Shadowfax's required-field set is
    // UNVERIFIED — their doc URL 404s and the Postman collection is auth-gated
    // — so an omitted key would be the honest-but-unconfirmed alternative.)
    const pickupContactNumber = contactDigits(pickup.phone);
    const dropContactNumber = contactDigits(drop.phone, ctx.customerPhone);
    if (!pickupContactNumber || !dropContactNumber) {
      // MISSING LOCAL INPUT, not a provider response. The old error blamed
      // Shadowfax ("returned an unparseable contact phone") and was classified
      // transient, which invited a failover for an order no provider can serve.
      // Plain Error => the router aborts without walking to another rider.
      const err: any = new Error(
        !pickupContactNumber
          ? "Shadowfax booking needs a pickup contact phone - add the branch phone to the branch profile, then retry dispatch."
          : "Shadowfax booking needs a delivery contact phone - add the customer's phone to the order, then retry dispatch."
      );
      err.statusCode = 422;
      err.code = "DISPATCH_CONTACT_MISSING";
      throw err;
    }

    const orderItems = items.length
      ? items.slice(0, 50).map((it: any, i: number) => ({
          id: String(it.id || it.productId || `item_${i + 1}`),
          name: String(it.name || "Food item").slice(0, 200),
          price: pickFiniteNumber(it.price) ?? 0,
          quantity: Math.max(1, Math.trunc(pickFiniteNumber(it.quantity) ?? 1)),
        }))
      : [{ id: "order", name: "Food order", price: orderValueInr(ctx), quantity: 1 }];

    const res = await fetchProviderJson("shadowfax", `${shadowfaxBase}/api/v2/orders/`, {
      method: "POST",
      headers: shadowfaxHeaders(),
      body: JSON.stringify({
        client_code: clientCode,
        order_details: {
          order_value: orderValueInr(ctx),
          paid: paidFlag(ctx),
          ...(ctx.orderId ? { client_order_id: ctx.orderId } : {}),
        },
        pickup_details: {
          // No invented locality: an empty city is "unknown", a hardcoded
          // "Ahmedabad" geocodes a branch in another city to the wrong place
          // (audit finding 6, the same defect the drop-side fix removed).
          city: order.branchCity || "",
          contact_number: pickupContactNumber,
          name: (pickup.name || "Burgonomics Branch").slice(0, 120),
          address: (pickupAddressBlock(order) || "Burgonomics Branch").slice(0, 350),
          latitude: ctx.pickup.lat,
          longitude: ctx.pickup.lng,
        },
        drop_details: {
          // No invented locality: an empty city is "unknown", a hardcoded
          // "Ahmedabad" geocodes a drop pin in another city to the wrong place
          // (audit finding 6). Shadowfax's required-field set is UNVERIFIED
          // (their doc URL 404s, the Postman collection is auth-gated).
          city: dropAddr.city || "",
          contact_number: contactDigits(drop.phone, ctx.customerPhone || ""),
          name: (drop.name || "Customer").slice(0, 120),
          address: (dropAddr.line || "Customer Delivery Address").slice(0, 350),
          latitude: ctx.drop.lat,
          longitude: ctx.drop.lng,
        },
        order_items: orderItems,
      }),
    });
    assertProviderOk(res, "shadowfax");

    const rawProviderOrderId = res.data?.sfx_order_id ?? res.data?.id ?? null;
    const providerOrderId =
      typeof rawProviderOrderId === "string" && rawProviderOrderId.trim() !== ""
        ? rawProviderOrderId
        : typeof rawProviderOrderId === "number" && Number.isFinite(rawProviderOrderId)
          ? String(rawProviderOrderId)
          : null;
    if (providerOrderId === null) {
      // The provider ACCEPTED the request (2xx) but returned no usable id. The
      // delivery may already exist, so this is AMBIGUOUS, never transient:
      // walking to the next provider could book a SECOND real rider for the same
      // order (Borzo parity, dbd1626). A PLAIN Error keeps the property that
      // matters — dispatch.router.ts only walks on for ProviderDispatchError, so
      // anything else releases the claim and throws instead of failing over.
      const err: any = new Error(
        "Shadowfax create-order returned no order id (response shape differs from spec) - do not retry blindly; reconcile with the provider"
      );
      err.statusCode = 502;
      err.code = "PROVIDER_BOOK_AMBIGUOUS";
      throw err;
    }

    const rider = res.data?.rider || {};
    return {
      kind: "booked",
      provider: "shadowfax",
      providerOrderId: String(providerOrderId),
      // Rider identity arrives with the ALLOTTED callback — pending placeholder
      // until then (webhook DRIVER_ALLOCATED fills the real rider fields).
      // Real identity, or empty. A fabricated placeholder name would be promoted
      // to a customer-visible `status: "rider_assigned"` (dispatch.router.ts);
      // empty keeps the dispatch `pending` until ALLOTTED fills the real rider.
      riderName: res.data?.rider_name || rider.name || "",
      riderPhone: res.data?.rider_contact || rider.phone || "",
      riderVehicleNumber: res.data?.rider_vehicle || rider.vehicle_number || "",
      trackingUrl: res.data?.track_url || res.data?.track || res.data?.tracking_url || "",
      source: "shadowfax_api_live",
      geoSource: "live_gps",
    };
  },
};
