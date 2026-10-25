import { assertLiveDispatchContext, config, isDeclaredProduction } from "../../../config/env";
import type {
  DispatchBookContext,
  DispatchFailureKind,
  DispatchQuoteContext,
  ProviderAdapter,
  ProviderBookResult,
  ProviderId,
  ProviderQuoteOk,
} from "../types";
import { ProviderDispatchError } from "../types";
import {
  QUOTE_TTL_MS,
  classifyHttpStatus,
  dropAddressBlock,
  dropContact,
  fetchProviderJson,
  mockRateFare,
  mockRider,
  pickFiniteNumber,
  pickupAddressBlock,
  pickupContact,
  unparseable,
  type ProviderHttpResponse,
} from "./shared";

/**
 * Borzo adapter — Business API 1.8, doc-confirmed
 * (https://borzodelivery.com/in/business-api/doc):
 *   - `calculate-order` / `create-order`, header `X-DV-Auth-Token`.
 *   - Money fields are JSON strings ("190.00") — pickFiniteNumber parses.
 *   - Quote fare lives at `order.payment_amount`; distance/ETA are NOT
 *     returned, so distance is haversine (fallbackKm) and ETA is a fixed 8.
 *   - Points use `latitude`/`longitude` (coordinate strings) + point-level
 *     `client_order_id` (≤32 chars, echoed in callbacks as
 *     delivery.client_order_id) + required `contact_person.phone`
 *     (`91` + 10 digits); address max 350 chars.
 *   - `vehicle_type_id` 8 = Motorbike — types 1/2/3/5 are FORBIDDEN for new
 *     orders. Book response: `order.order_id`, `order.points[].tracking_url`.
 */

const BORZO_API_VERSION_PATH = "/api/business/1.8";

/** Bare base (`https://robot-in.borzodelivery.com`) or full versioned base both work. */
function borzoApiBase(): string {
  const raw = (config.borzo.baseUrl || "").replace(/\/+$/, "");
  if (/\/api\/business\/[\d.]+$/.test(raw)) return raw;
  return `${raw}${BORZO_API_VERSION_PATH}`;
}

function borzoHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "X-DV-Auth-Token": config.borzo.apiKey,
  };
}

/**
 * Borzo phone format: `91` + 10 digits (doc example "918880000001").
 * Returns null when no real national number can be derived — a missing contact
 * must BLOCK the booking, never be invented (audit finding 5: the old
 * last-resort literal was a fabricated phone sent on live requests).
 */
function borzoPhone(raw: string | undefined): string | null {
  let digits = (raw || "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
  // A 10-digit value that still starts with 0 is an STD/trunk form, not a
  // national mobile number: prefixing "91" to it invents the same wrong
  // recipient this function refuses to truncate. Unknown => null.
  if (digits.length === 10) return digits.startsWith("0") ? null : `91${digits}`;
  // Exactly 12 digits is the documented `91` + 10-digit national form — and only
  // that prefix qualifies. A 12-digit value starting with anything else (e.g. a
  // trunk 0: "098250012345") is sent as-is by neither form; refuse it. Anything
  // LONGER used to be silently sliced to 12, which turns "+91 098250 12345"
  // into "910982501234" — a plausible-looking, WRONG recipient handed to a
  // live courier. A number we cannot normalise unambiguously must block the
  // booking (null), never be truncated into a different person's line.
  if (digits.length === 12) return digits.startsWith("91") ? digits : null;
  return null;
}

/**
 * Failure codes that GENUINELY mean "this address is outside Borzo's coverage"
 * — the only codes allowed to produce `not_serviced` (DR3). Everything else
 * (unexpected_error, service_unavailable, requests_limit_exceeded,
 * insufficient_balance, insufficient_balance_for_buyout,
 * buyout_amount_limit_exceeded, insufficient_funds, card_payment_failed,
 * unapproved_contract, the *_auth_token / api_version / api_upgrade codes,
 * tax_retension_limit, impossible_delivery_fee_calculation, invalid_parameters,
 * order_is_duplicate, total_payment_amount_limit_exceeded, …) is a
 * provider/account-side fault: transient, so the walk retries the NEXT provider
 * and Borzo stays eligible.
 *
 * CLASS SEMANTICS ONLY: this table is read by classifyBorzoError (quote path
 * and every non-duplicate code). At create-order an `order_is_duplicate` is
 * ACCEPTANCE AMBIGUITY, not a walkable fault — the book-time guard in book()
 * turns it into a plain PROVIDER_BOOK_AMBIGUOUS error so the router can never
 * fail over into a second real courier.
 */
const BORZO_NOT_SERVICED_CODES = new Set([
  "route_not_found",
  "invalid_region",
  "different_regions",
  "coordinates_out_of_bounds",
  "address_not_found",
]);

/** Borzo codes live in `errors:[code,…]` / `parameter_errors:{field: code|code[]}`. */
function collectBorzoCodes(codes: unknown, parameterCodes: unknown): string[] {
  const out: string[] = [];
  const push = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string" && item.trim()) out.push(item.trim());
      }
    } else if (typeof value === "string" && value.trim()) {
      out.push(value.trim());
    }
  };
  push(codes);
  if (parameterCodes && typeof parameterCodes === "object" && !Array.isArray(parameterCodes)) {
    for (const value of Object.values(parameterCodes)) push(value);
  }
  return out;
}

/** Borzo failure codes from a 400 / `is_successful:false` body. */
export function borzoErrorCodes(data: any): string[] {
  return collectBorzoCodes(data?.errors, data?.parameter_errors);
}

/**
 * `calculate-order` warnings. Borzo's contract: "You will receive these
 * warnings as error codes if you try to create an order with the same data you
 * calculated it with" — a non-empty list therefore predicts a book-time 400.
 */
export function borzoWarningCodes(data: any): string[] {
  return collectBorzoCodes(data?.warnings, data?.parameter_warnings);
}

/** Human-readable text carried by the parsed body (never the raw JSON blob). */
function borzoBodyMessage(data: any): string | undefined {
  const raw =
    data?.error_description ?? data?.status_description ?? data?.message ?? data?.error;
  return typeof raw === "string" && raw.trim() ? raw.trim().slice(0, 200) : undefined;
}

/** Raw response text — the last resort, so a body is never silently dropped. */
function borzoRawText(rawBody?: string): string | undefined {
  const raw = (rawBody || "").trim();
  return raw ? raw.slice(0, 200) : undefined;
}

export interface BorzoErrorContext {
  /** Classify THESE codes instead of the body's (used for quote warnings). */
  codes?: string[];
  /** Raw response body, used only when nothing better explains the failure. */
  rawBody?: string;
}

/**
 * Borzo response → failure class, Borzo-specifically (DR3).
 *
 * EVERY documented Borzo error is HTTP 400 with `is_successful:false` +
 * `errors:[code,…]`, and a 200 body can also carry `is_successful:false`, so
 * the HTTP status alone cannot choose the class. Routing 400 through the
 * generic `classifyHttpStatus` classified an exhausted balance, an unapproved
 * contract or an outage as `not_serviced` — read to staff as "address not
 * covered" and permanently excluding our primary provider (audit D1/D2/D3,
 * finding 14). The CODE decides; 401/403/429/5xx/network stay transient.
 */
export function classifyBorzoError(
  provider: ProviderId,
  httpStatus: number,
  data: any,
  context: BorzoErrorContext = {}
): ProviderDispatchError {
  const bodyMessage = borzoBodyMessage(data);
  // Provider/account-side HTTP faults are unchanged (DR3): retry the next
  // provider, keep this one eligible.
  if (httpStatus === 401 || httpStatus === 403 || httpStatus === 429 || httpStatus >= 500) {
    return classifyHttpStatus(provider, httpStatus, bodyMessage ?? borzoRawText(context.rawBody));
  }
  const codes = context.codes ?? borzoErrorCodes(data);
  // The raw body is echoed only when the code list cannot explain the failure;
  // with codes present the message stays `borzo HTTP 400 <code> (kind)`.
  const detail =
    bodyMessage ?? (codes.length === 0 ? borzoRawText(context.rawBody) : undefined);
  const kind: DispatchFailureKind = codes.some((code) => BORZO_NOT_SERVICED_CODES.has(code))
    ? "not_serviced"
    : // No usable code is NOT an address verdict: a body we cannot read is a
      // provider-side fault, so it stays retryable. `not_serviced` must never
      // again be the default for a 400 (that is exactly the old bug).
      "transient";
  const codeLabel = codes.length > 0 ? ` ${codes.join(", ")}` : "";
  return new ProviderDispatchError(
    provider,
    kind,
    `${provider} HTTP ${httpStatus}${codeLabel} (${kind})${detail ? `: ${detail}` : ""}`
  );
}

/** Borzo failure gate: HTTP error status OR a 200 body with `is_successful:false`. */
function assertBorzoResponse(res: ProviderHttpResponse): void {
  if (res.ok && res.data?.is_successful !== false) return;
  throw classifyBorzoError("borzo", res.status, res.data, { rawBody: res.text });
}

/**
 * Book-time acceptance ambiguity: the order MAY exist at Borzo. Deliberately a
 * PLAIN error (no `kind`), so dispatch.router.ts cannot treat it as a walkable
 * provider fault and book a second real courier. The router releases the claim
 * and surfaces it for reconciliation by `client_order_id`.
 */
function borzoBookAmbiguous(message: string): Error {
  const err: any = new Error(message);
  err.statusCode = 502;
  err.code = "PROVIDER_BOOK_AMBIGUOUS";
  return err;
}

function buildPoints(ctx: DispatchQuoteContext, forBooking: boolean): any[] {
  const pickup = pickupContact(ctx.order);
  const drop = dropContact(ctx);
  const clientOrderId = ctx.orderId ? ctx.orderId.slice(0, 32) : undefined;
  // The pickup contact must be the REAL branch number — never the customer's
  // phone (audit finding 4). A missing contact must BLOCK a booking, but it
  // must not block a QUOTE: `buildOrderPayload` is shared with quote(), and
  // the /dispatch/quote context carries no order (hence no branchPhone), so
  // requiring a phone there broke live Borzo quoting. Quote OMITS the key;
  // book fails closed. The drop point legitimately falls back to the customer
  // — they are the person at the door — but it must still be a real number.
  const pickupPhone = borzoPhone(pickup.phone);
  if (!pickupPhone && forBooking) throw unparseable("borzo", "branch phone");
  const dropPhone = borzoPhone(drop.phone) ?? borzoPhone(ctx.customerPhone);
  if (!dropPhone && forBooking) throw unparseable("borzo", "contact phone");
  return [
    {
      address: (pickupAddressBlock(ctx.order) || "Burgonomics Branch").slice(0, 350),
      // `phone` is present only when a real number exists — an omitted key is
      // honest; a substituted or invented number is not.
      contact_person: {
        name: (pickup.name || undefined)?.slice(0, 350),
        ...(pickupPhone ? { phone: pickupPhone } : {}),
      },
      client_order_id: clientOrderId,
      latitude: String(ctx.pickup.lat),
      longitude: String(ctx.pickup.lng),
    },
    {
      address: (dropAddressBlock(ctx.order).line || "Customer Delivery Address").slice(0, 350),
      contact_person: {
        name: (drop.name || undefined)?.slice(0, 350),
        ...(dropPhone ? { phone: dropPhone } : {}),
      },
      client_order_id: clientOrderId,
      latitude: String(ctx.drop.lat),
      longitude: String(ctx.drop.lng),
    },
  ];
}

function buildOrderPayload(ctx: DispatchQuoteContext, forBooking: boolean): Record<string, any> {
  return {
    // standard = bike-class work (D5: bike-for-all until catering volume).
    type: "standard",
    matter: "Food order delivery",
    vehicle_type_id: 8, // Motorbike — types 1/2/3/5 forbidden for new orders
    total_weight_kg: 1,
    points: buildPoints(ctx, forBooking),
  };
}

export const borzoAdapter: ProviderAdapter = {
  provider: "borzo",

  isEligible(): boolean {
    if (!config.borzo.enabled) return false;
    // Mock mode mints a local [TEST] rider and receives no vendor callbacks.
    if (config.mock.borzoDispatch) return true;
    if (!config.borzo.apiKey) return false;
    // F2 runtime half: in a declared-production process a keyed Borzo with no
    // callback secret can book a real rider whose status callbacks the (empty
    // secret) verifier must deny — an order that can never be tracked or
    // closed. Boot already fails closed (assertWebhookSecrets); this also
    // covers a runtime flag/key mutation after a clean boot. Scoped to
    // production so dev/test fan-outs that intentionally key a fake token
    // without a callback secret keep working.
    if (isDeclaredProduction() && !(config.borzo.webhookSecret || "").trim()) return false;
    return true;
  },

  async quote(ctx: DispatchQuoteContext): Promise<ProviderQuoteOk> {
    const { calculateHaversineDistanceKm, estimatePickupMinutes } = await import(
      "../../../core/geo"
    );
    const fallbackKm = calculateHaversineDistanceKm(
      ctx.pickup.lat,
      ctx.pickup.lng,
      ctx.drop.lat,
      ctx.drop.lng
    );

    if (config.mock.borzoDispatch) {
      assertLiveDispatchContext("borzo quote");
      const distanceKm = fallbackKm;
      return {
        provider: "borzo",
        outcome: "ok",
        fare: mockRateFare("borzo", distanceKm),
        distanceKm,
        pickupEtaMinutes: 8,
        quoteId: `QTE-BORZO-${Math.floor(10000 + Math.random() * 90000)}`,
        expiresAt: Date.now() + QUOTE_TTL_MS,
        source: "borzo_mock_rate_card",
      };
    }

    const res = await fetchProviderJson("borzo", `${borzoApiBase()}/calculate-order`, {
      method: "POST",
      headers: borzoHeaders(),
      body: JSON.stringify(buildOrderPayload(ctx, false)),
    });
    assertBorzoResponse(res);

    // Quote-time warnings (D2): Borzo returns these same codes as errors if the
    // identical data is booked, so a non-empty list predicts a book-time 400 —
    // withhold the fare instead of presenting one we know will be rejected.
    const warnings = borzoWarningCodes(res.data);
    if (warnings.length > 0) {
      throw classifyBorzoError("borzo", res.status, res.data, { codes: warnings });
    }

    const fare = pickFiniteNumber(
      res.data?.order?.payment_amount,
      res.data?.order_price,
      res.data?.calculation?.order_price,
      res.data?.price,
      res.data?.total_price
    );
    if (fare === null) throw unparseable("borzo", "calculate-order fare");

    // calculate-order returns no distance/ETA — haversine fallback for distance.
    const distanceKm =
      pickFiniteNumber(res.data?.distance_km, res.data?.calculation?.distance_km) ?? fallbackKm;

    // The ETA is provider data only when Borzo actually sent one. The previous
    // bare `?? 8` was a fixed number presented as the provider's own ETA on a
    // customer-visible quote; same class as the Shadowfax `?? 9` (GAP 4).
    const providerEta = pickFiniteNumber(res.data?.pickup_eta_minutes, res.data?.eta);

    return {
      provider: "borzo",
      outcome: "ok",
      fare,
      distanceKm,
      pickupEtaMinutes: providerEta ?? estimatePickupMinutes(),
      // TRUE => that number is ours, not Borzo's; the router surfaces it.
      etaEstimated: providerEta === null,
      quoteId: String(res.data?.quote_id || res.data?.calculation_id || `QTE-BORZO-${Date.now()}`),
      expiresAt: Date.now() + QUOTE_TTL_MS,
      source: "borzo_api_live",
    };
  },

  async book(ctx: DispatchBookContext): Promise<ProviderBookResult> {
    if (config.mock.borzoDispatch) {
      assertLiveDispatchContext("borzo book");
      const providerOrderId = `BRZ-ORD-${Math.floor(100000 + Math.random() * 900000)}`;
      const rider = mockRider("borzo", ctx.orderId);
      return {
        kind: "booked",
        provider: "borzo",
        providerOrderId,
        riderName: rider.name,
        riderPhone: rider.phone,
        riderVehicleNumber: rider.vehicle,
        trackingUrl: `https://borzo.in/track/${providerOrderId}`,
        source: "mock",
        geoSource: "live_gps",
      };
    }
    let res: ProviderHttpResponse;
    try {
      res = await fetchProviderJson("borzo", `${borzoApiBase()}/create-order`, {
        method: "POST",
        headers: borzoHeaders(),
        body: JSON.stringify(buildOrderPayload(ctx, true)),
      });
    } catch (err: any) {
      // A create-order that produced no response is NOT safely retryable: the
      // request may already have reached Borzo, and an abort/timeout fires
      // AFTER the request is in flight (the canonical "we may have booked it"
      // case this whole guard exists for). Re-classify that class as acceptance
      // ambiguity so the ranked walk cannot book a second real courier.
      // The test is on the ABORT CLASS, not on transmission state: we cannot
      // observe whether bytes reached Borzo (a stalled DNS/TLS handshake aborts
      // the same way and is reported as ambiguous too — safe direction, at the
      // cost of a reconciliation ticket). Fast pre-send failures (DNS,
      // connection refused) do not match and stay transient/walkable.
      const message = String(err?.message || "");
      if (/timed?\s?out|abort/i.test(message)) {
        throw borzoBookAmbiguous(
          "Borzo create-order timed out with no response: the request may already have created an order - do not book another courier; reconcile by client_order_id before any rebook"
        );
      }
      throw err;
    }

    const order = res.data?.order || {};
    const rawProviderOrderId =
      order.order_id ?? res.data?.order_id ?? res.data?.id ?? null;
    const providerOrderId =
      typeof rawProviderOrderId === "string" && rawProviderOrderId.trim() !== ""
        ? rawProviderOrderId
        : typeof rawProviderOrderId === "number" && Number.isFinite(rawProviderOrderId)
          ? String(rawProviderOrderId)
          : null;
    // Order-scoped id evidence ONLY (never the loose `res.data.id`, which can be
    // a request/echo id on a failure body). This is what makes a failed
    // create-order ambiguous rather than retryable.
    const rawNamedOrderId = order.order_id ?? res.data?.order_id ?? null;
    const namedOrderId =
      typeof rawNamedOrderId === "string" && rawNamedOrderId.trim() !== ""
        ? rawNamedOrderId
        : typeof rawNamedOrderId === "number" && Number.isFinite(rawNamedOrderId)
          ? String(rawNamedOrderId)
          : null;
    const accepted = res.ok && res.data?.is_successful !== false;
    // DUPLICATE-ORDER AMBIGUITY (book-time only). A duplicate signal is
    // provider evidence that an order for OUR client_order_id may already
    // exist (an earlier accepted create-order, e.g. one whose response timed
    // out client-side). It can never be a walkable transient fault: the DR6
    // ranked walk would then book a SECOND real courier while Borzo may still
    // dispatch the first. Checked BEFORE assertBorzoResponse so BOTH delivery
    // shapes are covered — a 400 body, a 200 `is_successful:false` body, and a
    // warnings-carried duplicate — and shape-independently of res.status.
    // The check is on the duplicate CODE, not on a missing id: an id-carrying
    // duplicate is the STRONGEST evidence the order exists, so it must make
    // this guard stricter, never bypass it (same plain-error contract: release
    // claim, no failover, reconcile by client_order_id). The classification
    // table stays intact for the quote path and every other code/shape.
    const duplicateCode =
      borzoErrorCodes(res.data).includes("order_is_duplicate") ||
      borzoWarningCodes(res.data).includes("order_is_duplicate");
    if (duplicateCode && !accepted) {
      throw borzoBookAmbiguous(
        "Borzo create-order was refused as order_is_duplicate: Borzo may already hold an order for this client_order_id - do not book another courier; reconcile by client_order_id before any rebook"
      );
    }
    // A NON-SUCCESS create-order that still names an order is the same
    // ambiguity without the duplicate label: Borzo created something (that id
    // is real) but the response is not a success we can bind. Failing over
    // here would book a second courier for an order that may already exist.
    if (!accepted && namedOrderId !== null) {
      throw borzoBookAmbiguous(
        `Borzo create-order did not succeed but named order ${namedOrderId}: the order may already exist - do not book another courier; reconcile by client_order_id before any rebook`
      );
    }
    // A duplicate-ECHO response that IS a success and names the EXISTING order
    // id skips the guard and binds truthfully below: the dedupe question was
    // answered by Borzo itself.
    assertBorzoResponse(res);

    if (providerOrderId === null) {
      // The provider ACCEPTED the request (2xx and is_successful !== false) but
      // returned no usable order id. The order may exist on their side, so this
      // must NOT be treated as a retryable provider fault: failing over would
      // book a SECOND real rider. Surface it loudly for reconciliation instead.
      throw borzoBookAmbiguous(
        "Borzo create-order returned no order id (response shape differs from spec) - do not retry blindly; reconcile by client_order_id"
      );
    }

    // Tracking link arrives on the destination point (drop point is last).
    const points = Array.isArray(order.points) ? order.points : [];
    const trackingUrl =
      [...points]
        .reverse()
        .find((p: any) => typeof p?.tracking_url === "string" && p.tracking_url)
        ?.tracking_url ||
      res.data?.tracking_url ||
      "";

    const courier = order.courier || res.data?.courier || order.performer || res.data?.performer || {};
    // Real identity only. Borzo's create-order response commonly carries no
    // courier (the contract exposes it via `order.courier` or GET /courier), and
    // a fabricated placeholder name here is promoted to a customer-visible
    // `status: "rider_assigned"` at dispatch.router.ts — an empty name keeps the
    // dispatch `pending` until real identity lands via the callback.
    const riderName =
      [courier.surname, courier.name].filter(Boolean).join(" ") ||
      res.data?.courier_name ||
      "";

    return {
      kind: "booked",
      provider: "borzo",
      providerOrderId: String(providerOrderId),
      riderName,
      riderPhone: courier.phone || res.data?.courier_phone || "",
      riderVehicleNumber: courier.vehicle_number || res.data?.courier_vehicle || "",
      trackingUrl,
      source: "borzo_api_live",
      geoSource: "live_gps",
    };
  },
};
