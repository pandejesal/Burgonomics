import * as admin from "firebase-admin";
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

/** Loads the quote already bound to an order (server-side single source). */
export async function findDeliveryFeeQuoteForOrder(
  orderId: string
): Promise<any | null> {
  if (!db || typeof db.collection !== "function" || !orderId) return null;
  try {
    const snap = await db
      .collection(DELIVERY_FEE_QUOTES)
      .where("usedByOrderId", "==", orderId)
      .limit(1)
      .get();
    if (!snap || snap.empty || !snap.docs?.length) return null;
    return snap.docs[0].data() as any;
  } catch (err: any) {
    console.warn("[Checkout] bound delivery quote lookup failed:", err?.message || err);
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
  /**
   * When set, expiry is judged at THIS moment (the order's server-readable
   * createdAt) plus a small grace, instead of "now". A cash order can be
   * accepted by staff long after the quote's TTL — the fee was quoted while
   * the customer was checking out, which is what must be proven.
   */
  expiryAtMs?: number;
}

/** Grace on the cash-order expiry rule (clock/latency slack, not a price decision). */
export const CASH_QUOTE_GRACE_MS = 5 * 60 * 1000;

/**
 * Enforces R6's binding rules on a persisted quote. Returns the fee to charge
 * (never a default). Throws 409 DELIVERY_QUOTE_REQUIRED when there is no
 * usable quote and 409 DELIVERY_QUOTE_EXPIRED for any binding mismatch —
 * expired, other uid, other branch, another address, or another order.
 */
export function assertDeliveryQuoteBindable(input: DeliveryQuoteBinding): number {
  const { quote, orderId, uid, branchId, dropLat, dropLng, expiryAtMs } = input;
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
  const expiresAt = Number(quote.expiresAt);
  if (!Number.isFinite(expiresAt)) {
    throw deliveryQuoteError(
      "DELIVERY_QUOTE_INVALID",
      "The attached delivery price has no expiry — get a new delivery fee and retry."
    );
  }
  if (expiryAtMs !== undefined) {
    // R6b: was it valid when the order was placed (plus grace)?
    if (!(expiresAt + CASH_QUOTE_GRACE_MS > expiryAtMs)) {
      throw deliveryQuoteError(
        "DELIVERY_QUOTE_EXPIRED",
        "The delivery price had already expired when this order was placed — get a new one."
      );
    }
  } else if (isDeliveryQuoteExpired(quote)) {
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

/**
 * The order's server-readable creation moment, in ms, or null when the doc
 * carries nothing trustworthy. `createdAtMs` (numeric) is preferred because a
 * serverTimestamp sentinel has no toMillis on a later read.
 */
export function orderCreatedAtMs(order: any): number | null {
  const numeric = Number(order?.createdAtMs);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const stamp = order?.createdAt;
  if (typeof stamp === "number" && Number.isFinite(stamp) && stamp > 0) return stamp;
  if (stamp && typeof stamp.toMillis === "function") {
    const ms = Number(stamp.toMillis());
    if (Number.isFinite(ms) && ms > 0) return ms;
  }
  if (stamp && typeof stamp === "object" && typeof stamp.seconds === "number") {
    const ms = stamp.seconds * 1000;
    if (Number.isFinite(ms) && ms > 0) return ms;
  }
  if (typeof stamp === "string") {
    const ms = Date.parse(stamp);
    if (Number.isFinite(ms) && ms > 0) return ms;
  }
  return null;
}

export interface BindDeliveryQuoteInput {
  quoteId?: string | null;
  orderId: string;
  uid: string;
  branchId: string;
  /**
   * "orderCreated" judges expiry at the order's creation time + grace (R6b,
   * cash orders accepted later); "now" is the checkout-time rule (R6).
   */
  expiryMode: "now" | "orderCreated";
}

/**
 * Loads the persisted quote and binds it to the order inside ONE transaction
 * (R6/R6b): validates every binding and claims the quote atomically, so two
 * concurrent accepts cannot both spend it. Returns the fee, never a default.
 *
 * The order document supplies the drop pin and (for expiryMode
 * "orderCreated") the creation time — both server-written, never request data.
 */
export async function bindDeliveryQuote(input: BindDeliveryQuoteInput): Promise<number> {
  const { quoteId, orderId, uid, branchId, expiryMode } = input;
  if (!quoteId) {
    throw deliveryQuoteError(
      "DELIVERY_QUOTE_REQUIRED",
      "A delivery checkout needs a delivery price — get one and retry."
    );
  }
  if (!db || typeof db.collection !== "function") {
    const err: any = new Error("Delivery pricing is temporarily unavailable — please retry checkout.");
    err.statusCode = 503;
    err.code = "DELIVERY_QUOTE_UNAVAILABLE";
    throw err;
  }

  const quoteRef = db.collection(DELIVERY_FEE_QUOTES).doc(quoteId);
  const orderRef = db.collection("orders").doc(orderId);

  const runTx: (fn: (tx: any) => Promise<number>) => Promise<number> =
    typeof (db as any).runTransaction === "function"
      ? (fn) => (db as any).runTransaction(fn)
      : async (fn) =>
          fn({
            get: (ref: any) => ref.get(),
            set: (ref: any, data: any, opts?: any) => ref.set(data, opts),
          });

  return runTx(async (tx) => {
    const quoteSnap = await tx.get(quoteRef);
    const orderSnap = await tx.get(orderRef);
    const orderData = orderSnap?.exists ? orderSnap.data() || {} : {};
    const dropLat = orderData?.deliveryAddress?.lat ?? orderData?.address?.lat;
    const dropLng = orderData?.deliveryAddress?.lng ?? orderData?.address?.lng;

    let expiryAtMs: number | undefined;
    if (expiryMode === "orderCreated") {
      const createdAt = orderCreatedAtMs(orderData);
      if (createdAt === null) {
        throw deliveryQuoteError(
          "DELIVERY_QUOTE_INVALID",
          "This order has no server-readable creation time — the delivery price cannot be verified."
        );
      }
      expiryAtMs = createdAt;
    }

    const fee = assertDeliveryQuoteBindable({
      quote: quoteSnap?.exists ? quoteSnap.data() : null,
      orderId,
      uid,
      branchId,
      dropLat,
      dropLng,
      expiryAtMs,
    });

    const current = (quoteSnap.data() as any) || {};
    if (current.usedByOrderId !== orderId) {
      await tx.set(
        quoteRef,
        {
          usedByOrderId: orderId,
          usedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    }
    return fee;
  });
}
