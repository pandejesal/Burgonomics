import { db } from "../../core/firebase";

/**
 * Delivery-fee quotes (owner decision 2026-10-31, R5/R6).
 *
 * `POST /checkout/fees` persists the winning courier fare here and gives the
 * client an opaque id. `createPaymentOrder` then charges THAT fee instead of
 * any client-supplied number, and binds the quote to the order it paid for.
 *
 * Access model: `delivery_fee_quotes` has NO Firestore rule and there is no
 * catch-all in firestore.rules, so clients cannot read or write it (default
 * deny). Every read/write goes through the Admin SDK in a Cloud Function.
 */

export const DELIVERY_FEE_QUOTES = "delivery_fee_quotes";

/** Coordinate match tolerance (~0.11 m) for quote ↔ order address equality. */
export const DROP_COORD_TOLERANCE = 1e-6;

export interface DeliveryFeeQuote {
  uid: string;
  branchId: string;
  storeId: string | null;
  dropLat: number;
  dropLng: number;
  fee: number;
  provider: string;
  providerQuoteId: string | null;
  createdAt: unknown;
  createdAtMs: number;
  expiresAt: number;
  usedByOrderId: string | null;
}

export function deliveryQuoteError(
  code: "DELIVERY_QUOTE_REQUIRED" | "DELIVERY_QUOTE_EXPIRED" | "DELIVERY_QUOTE_INVALID",
  message: string
): Error {
  const err: any = new Error(message);
  err.statusCode = 409;
  err.code = code;
  return err;
}

/** True when the persisted quote's expiry has passed (numeric ms). */
export function isDeliveryQuoteExpired(quote: any, nowMs: number = Date.now()): boolean {
  const expiresAt = Number(quote?.expiresAt);
  return !Number.isFinite(expiresAt) || expiresAt <= nowMs;
}

/** True when a coordinate pair matches within the stored-quote tolerance. */
export function sameDropCoordinates(
  quote: { dropLat: unknown; dropLng: unknown },
  lat: unknown,
  lng: unknown
): boolean {
  const qLat = Number(quote?.dropLat);
  const qLng = Number(quote?.dropLng);
  const oLat = Number(lat);
  const oLng = Number(lng);
  if (![qLat, qLng, oLat, oLng].every((n) => Number.isFinite(n))) return false;
  return (
    Math.abs(qLat - oLat) <= DROP_COORD_TOLERANCE &&
    Math.abs(qLng - oLng) <= DROP_COORD_TOLERANCE
  );
}

/** Loads a persisted quote by id. Never fabricates one. */
export async function loadDeliveryFeeQuote(quoteId: string): Promise<any | null> {
  if (!db || typeof db.collection !== "function") return null;
  try {
    const snap = await db.collection(DELIVERY_FEE_QUOTES).doc(quoteId).get();
    return snap?.exists ? (snap.data() as any) : null;
  } catch (err: any) {
    console.warn("[Checkout] delivery quote read failed:", err?.message || err);
    return null;
  }
}

export interface DeliveryQuoteBinding {
  quote: any;
  orderId?: string;
  uid: string;
  branchId: string;
  dropLat: unknown;
  dropLng: unknown;
}

/**
 * Enforces R6's binding rules on a persisted quote. Returns the fee to charge
 * (never a default). Throws 409 DELIVERY_QUOTE_REQUIRED when there is no
 * usable quote and 409 DELIVERY_QUOTE_EXPIRED for any binding mismatch —
 * expired, other uid, other branch, another address, or another order.
 */
export function assertDeliveryQuoteBindable(input: DeliveryQuoteBinding): number {
  const { quote, orderId, uid, branchId, dropLat, dropLng } = input;
  if (!quote) {
    throw deliveryQuoteError(
      "DELIVERY_QUOTE_REQUIRED",
      "No delivery price is attached to this checkout — get a delivery fee and retry."
    );
  }
  const fee = Number(quote.fee);
  if (!Number.isFinite(fee) || fee <= 0) {
    throw deliveryQuoteError(
      "DELIVERY_QUOTE_INVALID",
      "The attached delivery price is invalid — get a new delivery fee and retry."
    );
  }
  if (isDeliveryQuoteExpired(quote)) {
    throw deliveryQuoteError(
      "DELIVERY_QUOTE_EXPIRED",
      "The delivery price expired — get a new delivery fee and retry."
    );
  }
  if (typeof quote.uid !== "string" || quote.uid !== uid) {
    throw deliveryQuoteError(
      "DELIVERY_QUOTE_EXPIRED",
      "The attached delivery price belongs to another checkout — get a new one."
    );
  }
  if (typeof quote.branchId !== "string" || quote.branchId !== branchId) {
    throw deliveryQuoteError(
      "DELIVERY_QUOTE_EXPIRED",
      "The attached delivery price is for another outlet — get a new one."
    );
  }
  if (!sameDropCoordinates(quote, dropLat, dropLng)) {
    throw deliveryQuoteError(
      "DELIVERY_QUOTE_EXPIRED",
      "The delivery address changed — get a new delivery price."
    );
  }
  // Single use: bound to this order already is a retry (allowed); bound to a
  // different order is reuse (refused).
  if (quote.usedByOrderId != null && quote.usedByOrderId !== orderId) {
    throw deliveryQuoteError(
      "DELIVERY_QUOTE_EXPIRED",
      "That delivery price was already used for another order — get a new one."
    );
  }
  return Math.round(fee * 100) / 100;
}
