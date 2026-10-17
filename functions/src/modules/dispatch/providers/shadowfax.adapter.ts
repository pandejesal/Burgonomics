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
 * Shadowfax adapter — Hyperlocal Marketplace API, doc-confirmed
 * (https://developer.shadowfax.in/docs/hyperlocal/marketplace):
 *   - Auth: `Authorization: Token <api_token>` (shared by the Shadowfax team).
 *   - Quote = serviceability: `PUT /api/v1/order-serviceability/` →
 *     `{ serviceable, pickup_eta, delivery_cost }`. HTTP 400 (non-serviceable
 *     area) and a 200 body with `serviceable:false` both class not_serviced
 *     (DR3) — no fare is invented (DR2). No distance field → haversine.
 *   - Book: `POST /api/v2/orders/` with `client_code` (SHADOWFAX_CLIENT_CODE),
 *     `order_details` (paid is the STRING "true"/"false"), pickup/drop details
 *     (latitude/longitude as numbers), `order_items`. Response: `sfx_order_id`,
 *     `track_url`. The rider arrives later via the ALLOTTED callback, so book
 *     falls back to a pending rider identity.
 *   - Retry-window note: place the order within minutes of a successful
 *     serviceability check (router quotes immediately before booking, DR7).
 */

function shadowfaxHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Token ${config.shadowfax.apiKey}`,
  };
}

function base(): string {
  return (config.shadowfax.baseUrl || "").replace(/\/+$/, "");
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
    return (
      config.shadowfax.enabled &&
      ((!!config.shadowfax.apiKey && !!config.shadowfax.clientCode) ||
        config.mock.shadowfaxDispatch)
    );
  },

  async quote(ctx: DispatchQuoteContext): Promise<ProviderQuoteOk> {
    const { calculateHaversineDistanceKm } = await import("../../../core/geo");
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

    const res = await fetchProviderJson(
      "shadowfax",
      `${base()}/api/v1/order-serviceability/`,
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

    return {
      provider: "shadowfax",
      outcome: "ok",
      fare,
      // The serviceability response carries no distance — haversine fallback.
      distanceKm: fallbackKm,
      pickupEtaMinutes: pickFiniteNumber(res.data?.pickup_eta) ?? 9,
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

    if (!config.shadowfax.clientCode) {
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
      throw unparseable("shadowfax", "contact phone");
    }

    const orderItems = items.length
      ? items.slice(0, 50).map((it: any, i: number) => ({
          id: String(it.id || it.productId || `item_${i + 1}`),
          name: String(it.name || "Food item").slice(0, 200),
          price: pickFiniteNumber(it.price) ?? 0,
          quantity: Math.max(1, Math.trunc(pickFiniteNumber(it.quantity) ?? 1)),
        }))
      : [{ id: "order", name: "Food order", price: orderValueInr(ctx), quantity: 1 }];

    const res = await fetchProviderJson("shadowfax", `${base()}/api/v2/orders/`, {
      method: "POST",
      headers: shadowfaxHeaders(),
      body: JSON.stringify({
        client_code: config.shadowfax.clientCode,
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

    const providerOrderId = res.data?.sfx_order_id ?? res.data?.id ?? null;
    if (!providerOrderId) throw unparseable("shadowfax", "place-order id");

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
