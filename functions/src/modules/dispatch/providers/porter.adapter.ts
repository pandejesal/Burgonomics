import { assertLiveDispatchContext, config } from "../../../config/env";
import {
  ProviderDispatchError,
  type DispatchBookContext,
  type DispatchQuoteContext,
  type ProviderAdapter,
  type ProviderBookResult,
  type ProviderQuoteOk,
} from "../types";
import { QUOTE_TTL_MS } from "./shared";

/**
 * Porter adapter — reuses the existing, heavily-tested porter.service path
 * verbatim (quote semantics, mock marking, live fail-closed). Two dispatch-
 * specific behaviors on top:
 *
 * 1. QUOTE without a key: Porter is "quote-as-coverage" (delivery_porter.md
 *    D3/D4) — an unkeyed Porter still prices the route from the standard rate
 *    card so it can win / be the last serviceable provider (DR8 manual lane).
 *    This is a documented primary quote, NOT a fallback after a failure (DR2).
 * 2. BOOK without a key: returns manual_action_required (DR8) — staff books in
 *    the Porter app and pastes the id via /dispatch/porter-manual. On key
 *    grant the same branch books via API with no UI change.
 */

/** API path is ready when mock is on OR the full key triple is configured. */
function porterApiReady(): boolean {
  return (
    config.mock.porterDispatch ||
    (!!config.porter.apiKey && !!config.porter.customerId && !!config.porter.webhookSecret)
  );
}

export const porterAdapter: ProviderAdapter = {
  provider: "porter",

  isEligible(): boolean {
    // Enabled Porter is ALWAYS quote-eligible (coverage quote when unkeyed) —
    // excluding it unkeyed would silently delete the manual lane (DR8).
    return config.porter.enabled;
  },

  async quote(ctx: DispatchQuoteContext): Promise<ProviderQuoteOk> {
    const { getDeliveryQuote } = await import("../../porter/porter.service");
    const { calculateHaversineDistanceKm, calculatePorterFare, estimatePickupMinutes } =
      await import("../../../core/geo");

    if (porterApiReady()) {
      assertLiveDispatchContext("porter quote");
      try {
        const q = await getDeliveryQuote({
          pickupLat: ctx.pickup.lat,
          pickupLng: ctx.pickup.lng,
          dropLat: ctx.drop.lat,
          dropLng: ctx.drop.lng,
          customerName: ctx.customerName,
          customerPhone: ctx.customerPhone,
        });
        return {
          provider: "porter",
          outcome: "ok",
          fare: q.estimatedFare,
          distanceKm: q.estimatedDistanceKm,
          pickupEtaMinutes: q.estimatedPickupMinutes,
          quoteId: q.quoteId,
          expiresAt: q.expiresAt,
          source: q.source,
        };
      } catch (err: any) {
        if (err instanceof ProviderDispatchError) throw err;
        // Live Porter quote failing (missing key piece / 5xx) is transient for
        // THIS provider only — the fan-out continues (DR2).
        throw new ProviderDispatchError(
          "porter",
          "transient",
          `porter quote failed: ${err?.message || err}`
        );
      }
    }

    // Unkeyed coverage quote (D3/D4): deterministic rate card, clearly sourced.
    const distanceKm = calculateHaversineDistanceKm(
      ctx.pickup.lat,
      ctx.pickup.lng,
      ctx.drop.lat,
      ctx.drop.lng
    );
    return {
      provider: "porter",
      outcome: "ok",
      fare: calculatePorterFare(distanceKm),
      distanceKm,
      pickupEtaMinutes: estimatePickupMinutes(),
      quoteId: `QTE-PRTR-${Math.floor(10000 + Math.random() * 90000)}`,
      expiresAt: Date.now() + QUOTE_TTL_MS,
      source: "porter_standard_rate_card",
    };
  },

  async book(ctx: DispatchBookContext): Promise<ProviderBookResult> {
    if (!porterApiReady()) {
      // DR8 manual lane: no key configured — staff books in the Porter app.
      return {
        kind: "manual_action_required",
        provider: "porter",
        instructions:
          "No Porter API key configured. Open the Porter enterprise app, book a 2-Wheeler for this order, then paste the Porter order id + tracking link below.",
        pasteEndpoint: "/dispatch/porter-manual",
      };
    }

    assertLiveDispatchContext("porter book");
    const { bookPorterRider } = await import("../../porter/porter.service");
    let result: any;
    try {
      // preclaimed: the router already holds the generic per-order claim —
      // porter's own claim would double-guard (and 202) the same tap.
      result = await bookPorterRider(ctx.orderId, ctx.staffName, ctx.caller, {
        preclaimed: true,
      });
    } catch (err: any) {
      if (err?.statusCode === 404 || err?.statusCode === 422) {
        // Order-level aborts (missing order / missing GPS) — surfaced as-is;
        // they are NOT provider failures and must not be walked past.
        throw err;
      }
      // Everything else from the porter book path is a provider/booking
      // failure: walk to the next serviceable provider (DR6).
      throw new ProviderDispatchError(
        "porter",
        "transient",
        `porter booking failed: ${err?.message || err}`
      );
    }

    if (!result?.porterOrderId) {
      throw new ProviderDispatchError(
        "porter",
        "transient",
        "porter booking returned no order id"
      );
    }

    return {
      kind: "booked",
      provider: "porter",
      providerOrderId: String(result.porterOrderId),
      riderName: result.riderName || "Porter Driver",
      riderPhone: result.riderPhone || "",
      riderVehicleNumber: result.riderVehicleNumber || "",
      trackingUrl: result.trackingUrl || "",
      source: result.dispatchSource || "porter_api_live",
      geoSource: result.geoSource,
      reused: result.reused === true,
    };
  },
};
