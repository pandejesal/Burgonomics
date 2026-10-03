import { config } from "../../../config/env";
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

/** Borzo phone format: `91` + 10 digits (doc example "918880000001"). */
function borzoPhone(raw: string | undefined, fallback: string): string {
  const norm = (v: string | undefined): string => {
    let d = (v || "").replace(/\D/g, "");
    if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
    if (d.length === 10) d = `91${d}`;
    return d;
  };
  const digits = norm(raw);
  if (digits.length >= 12) return digits.slice(0, 12);
  const fb = norm(fallback);
  if (fb.length >= 12) return fb.slice(0, 12);
  return "919876543210";
}

function buildPoints(ctx: DispatchQuoteContext): any[] {
  const pickup = pickupContact(ctx.order);
  const drop = dropContact(ctx);
  const clientOrderId = ctx.orderId ? ctx.orderId.slice(0, 32) : undefined;
  return [
    {
      address: (pickupAddressBlock(ctx.order) || "Burgonomics Branch").slice(0, 350),
      contact_person: {
        name: (pickup.name || undefined)?.slice(0, 350),
        phone: borzoPhone(pickup.phone, ctx.customerPhone || ""),
      },
      client_order_id: clientOrderId,
      latitude: String(ctx.pickup.lat),
      longitude: String(ctx.pickup.lng),
    },
    {
      address: (dropAddressBlock(ctx.order).line || "Customer Delivery Address").slice(0, 350),
      contact_person: {
        name: (drop.name || undefined)?.slice(0, 350),
        phone: borzoPhone(drop.phone, ctx.customerPhone || ""),
      },
      client_order_id: clientOrderId,
      latitude: String(ctx.drop.lat),
      longitude: String(ctx.drop.lng),
    },
  ];
}

function buildOrderPayload(ctx: DispatchQuoteContext): Record<string, any> {
  return {
    // standard = bike-class work (D5: bike-for-all until catering volume).
    type: "standard",
    matter: "Food order delivery",
    vehicle_type_id: 8, // Motorbike — types 1/2/3/5 forbidden for new orders
    total_weight_kg: 1,
    points: buildPoints(ctx),
  };
}

/** 200-with-failure bodies: Borzo reports `is_successful:false` without an HTTP error. */
function assertBorzoSuccessful(res: { data: any }, what: string): void {
  if (res.data?.is_successful === false) {
    const detail =
      res.data?.error ||
      res.data?.error_description ||
      res.data?.errors?.[0] ||
      res.data?.status_description ||
      "is_successful=false";
    throw new ProviderDispatchError(
      "borzo",
      "transient",
      `borzo ${what} failed: ${String(detail).slice(0, 200)}`
    );
  }
}

export const borzoAdapter: ProviderAdapter = {
  provider: "borzo",

  isEligible(): boolean {
    return config.borzo.enabled && (!!config.borzo.apiKey || config.mock.borzoDispatch);
  },

  async quote(ctx: DispatchQuoteContext): Promise<ProviderQuoteOk> {
    const { calculateHaversineDistanceKm } = await import("@burgonomics/shared/geo");
    const fallbackKm = calculateHaversineDistanceKm(
      ctx.pickup.lat,
      ctx.pickup.lng,
      ctx.drop.lat,
      ctx.drop.lng
    );

    if (config.mock.borzoDispatch) {
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
      body: JSON.stringify(buildOrderPayload(ctx)),
    });
    assertProviderOk(res, "borzo");
    assertBorzoSuccessful(res, "calculate-order");

    const fare = pickFiniteNumber(
      res.data?.order?.payment_amount,
      res.data?.order_price,
      res.data?.calculation?.order_price,
      res.data?.price,
      res.data?.total_price
    );
    if (fare === null) throw unparseable("borzo", "calculate-order fare");

    // calculate-order returns no distance/ETA — haversine fallback, fixed ETA 8.
    const distanceKm =
      pickFiniteNumber(res.data?.distance_km, res.data?.calculation?.distance_km) ?? fallbackKm;

    return {
      provider: "borzo",
      outcome: "ok",
      fare,
      distanceKm,
      pickupEtaMinutes:
        pickFiniteNumber(res.data?.pickup_eta_minutes, res.data?.eta) ?? 8,
      quoteId: String(res.data?.quote_id || res.data?.calculation_id || `QTE-BORZO-${Date.now()}`),
      expiresAt: Date.now() + QUOTE_TTL_MS,
      source: "borzo_api_live",
    };
  },

  async book(ctx: DispatchBookContext): Promise<ProviderBookResult> {
    if (config.mock.borzoDispatch) {
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

    const res = await fetchProviderJson("borzo", `${borzoApiBase()}/create-order`, {
      method: "POST",
      headers: borzoHeaders(),
      body: JSON.stringify(buildOrderPayload(ctx)),
    });
    assertProviderOk(res, "borzo");
    assertBorzoSuccessful(res, "create-order");

    const order = res.data?.order || {};
    const providerOrderId =
      order.order_id ?? res.data?.order_id ?? res.data?.id ?? null;
    if (!providerOrderId) throw unparseable("borzo", "create-order id");

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
    const riderName =
      [courier.surname, courier.name].filter(Boolean).join(" ") ||
      res.data?.courier_name ||
      "Borzo Courier";

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
