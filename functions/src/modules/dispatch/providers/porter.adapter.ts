import { assertLiveDispatchContext, config } from "../../../config/env";
import {
  ProviderDispatchError,
  type DispatchBookContext,
  type DispatchQuoteContext,
  type ProviderAdapter,
  type ProviderBookResult,
  type ProviderQuoteOk,
} from "../types";
import { QUOTE_TTL_MS, isProvenPreSendFailure, bookAmbiguous } from "./shared";
import { isCourierCashDelivery } from "./cashCollection";

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

/**
 * Uncertain-acceptance classifier — the F08/F1 double-rider guard.
 *
 * Only a PROVEN non-creation may fail over. Everything else about a create-
 * order failure is uncertainty (the request may already have reached Porter):
 *   - `PROVIDER_BOOK_AMBIGUOUS` (2xx without an order id — the delivery may
 *     already exist),
 *   - a timeout/abort while the request was in flight,
 *   - an HTTP 5xx / gateway fault (`httpStatus` >= 500), and
 *   - an unknown throw with no HTTP status and no pre-send transport code.
 * All of these park for reconciliation instead of walking to another paid courier.
 */
function isUncertainPorterBooking(err: any): boolean {
  if (err?.code === "PROVIDER_BOOK_AMBIGUOUS") return true;
  // Proven pre-send failures (DNS / refused connection) never reached Porter.
  if (isProvenPreSendFailure(err)) return false;
  if (/timed?\s?out|abort/i.test(String(err?.message || ""))) return true;
  // A 4xx the provider actually returned is a DEFINITE rejection (auth, rate
  // limit, bad payload): safe to walk, exactly as before. 5xx is a gateway/
  // provider fault after the request was accepted -> uncertainty.
  const httpStatus = err?.httpStatus ?? err?.statusCode;
  if (typeof httpStatus === "number") return httpStatus >= 500;
  // No status at all: conservative default is uncertainty (F08).
  return true;
}

function porterBookAmbiguous(message: string, cause?: unknown): Error {
  return bookAmbiguous("porter", message, cause);
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
          // Pass the provenance through: a local estimate must not reach the
          // partner card looking like Porter's own ETA.
          etaEstimated: q.etaEstimated === true,
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
      // The rate card is ours end to end, so the ETA is unambiguously local.
      etaEstimated: true,
      quoteId: `QTE-PRTR-${Math.floor(10000 + Math.random() * 90000)}`,
      expiresAt: Date.now() + QUOTE_TTL_MS,
      source: "porter_standard_rate_card",
    };
  },

  async book(ctx: DispatchBookContext): Promise<ProviderBookResult> {
    // Porter has no documented COD cash-collection contract, so it must never
    // be the direct or fallback courier for a cash delivery.
    if (isCourierCashDelivery(ctx.order)) {
      throw new ProviderDispatchError(
        "porter",
        "not_serviced",
        "Porter cannot carry a cash-on-delivery order. Cash delivery needs a courier enabled for cash collection."
      );
    }
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
      // F08 (double-rider guard): an unknown create-order outcome means Porter
      // may ALREADY hold this booking — a 5xx/gateway fault, a reset, a timeout
      // or any throw we cannot prove was pre-send. Failing over here would book
      // a second real rider for one delivery, so re-throw the SAME shape the
      // router treats as "release the claim, park needs_reconciliation, zero
      // further POSTs" (parity with borzo.adapter/shadowfax.adapter). The
      // service-level message is kept verbatim when it already explains the
      // acceptance state; the original cause rides along.
      if (isUncertainPorterBooking(err)) {
        throw porterBookAmbiguous(
          err?.code === "PROVIDER_BOOK_AMBIGUOUS"
            ? String(err?.message || "Porter booking hit an ambiguous acceptance state")
            : String(err?.message || "") ||
              "Porter create-order failed without a usable response: the request may already have created an order - do not book another courier; reconcile the Porter booking before any rebook",
          err
        );
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
      // Accepted-but-no-id is the SAME ambiguity, never a walkable fault: a
      // fallback carrier here would put two riders on one delivery. (The
      // service layer already raises PROVIDER_BOOK_AMBIGUOUS for its own
      // 2xx-without-id shape; this keeps the adapter contract even if a
      // future caller returns an empty result.)
      throw porterBookAmbiguous(
        "Porter create-order returned no order id (response shape differs from spec) - do not retry blindly; reconcile with Porter"
      );
    }

    return {
      kind: "booked",
      provider: "porter",
      providerOrderId: String(result.porterOrderId),
      // No fabricated identity: an empty name keeps the router's dispatch
      // status `pending` (dispatch.router.ts) until a real rider callback or
      // poll fills it, instead of reporting a made-up "Porter Driver" as
      // assigned (audit 2026-10-17, D4 class).
      riderName: result.riderName || "",
      riderPhone: result.riderPhone || "",
      riderVehicleNumber: result.riderVehicleNumber || "",
      trackingUrl: result.trackingUrl || "",
      source: result.dispatchSource || "porter_api_live",
      geoSource: result.geoSource,
      reused: result.reused === true,
    };
  },
};
