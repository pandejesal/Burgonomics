import { db } from "../../core/firebase";
import * as admin from "firebase-admin";
import { captureErrorSnapshot } from "../../core/errors";
import { refundUnfulfillableCapture } from "./lateCaptureRefund";

/**
 * P1-I / stale-stock compensation — ONE guarded first-capture path, shared by
 * the two channels that can confirm a capture (client `verifyPayment` and the
 * authoritative `payment.captured` webhook).
 *
 * Two defects this closes, both money-visible:
 *
 *  1. REPLAY REFUND (`razorpay.service.ts`): the availability gate ran on every
 *     verify, so a customer who re-verified an ALREADY-PAID order after the
 *     kitchen 86'd a line got a full automatic refund while the food was being
 *     made. Compensation may only ever run for the FIRST capture of an order
 *     that is not yet confirmed — and that decision must be transactional, not
 *     a stale read, or two concurrent confirms both decide "first".
 *
 *  2. WEBHOOK BYPASS: the webhook confirmed and rang the KOT with no
 *     availability gate at all, so a customer who paid through a
 *     webhook-only capture (app closed) still got food that could not be
 *     cooked. The webhook now runs the SAME gate before confirming.
 *
 * An unreadable catalogue is an OUTAGE, never proof of unavailability: this
 * path only ever refunds a line whose product document explicitly records
 * `inStock === false`. Missing docs are left to the pricing engine's own
 * fail-closed refusal on the fresh-intent path.
 */

export type CaptureFulfillmentOutcome =
  | { outcome: "not_first_capture" }
  | { outcome: "already_compensated" }
  | { outcome: "fulfillable" }
  | { outcome: "refunded"; refundId: string; reused: boolean }
  | { outcome: "refund_failed"; detail: string };

const CONFIRMED_OR_LATER = new Set([
  "CONFIRMED",
  "PREPARING",
  "READY",
  "READY_FOR_PICKUP",
  "READY_TO_SERVE",
  "OUT_FOR_DELIVERY",
  "IN_TRANSIT",
  "DELIVERED",
  "COMPLETED",
  "PICKED_UP",
  "CANCELLED",
  "REFUNDED",
]);

/** How long one channel may hold the first-capture decision before takeover. */
const CAPTURE_GATE_LEASE_MS = 10 * 60_000;

function statusCodeOf(order: any): string {
  const raw = typeof order?.status === "string" ? order.status : order?.status?.code;
  return String(raw || "").toUpperCase();
}

/** Has this order already been confirmed (or moved past confirming)? */
export function isOrderConfirmedOrLater(order: any): boolean {
  const code = statusCodeOf(order);
  return (
    order?.paymentStatus === "completed" ||
    order?.["payment.status"] === "completed" ||
    CONFIRMED_OR_LATER.has(code) ||
    order?.status?.terminal === true ||
    order?.terminal === true
  );
}

type GateClaim =
  | { kind: "first" }
  | { kind: "not_first" }
  | { kind: "already_compensated" };

/**
 * Transactional first-capture decision.
 *
 *  - order already confirmed / terminal → NOT first: no side effects (replay).
 *  - the capture was already compensated (this or another payment) → the order
 *    is never confirmed again.
 *  - a FRESH gate hold by another channel for the SAME payment → that channel
 *    is deciding right now: this one backs off and lets the confirm/suppress
 *    logic settle it.
 *  - otherwise claim the lease and proceed (a stale lease is takeover-able, so
 *    a crashed confirm cannot wedge compensation forever).
 */
async function claimFirstCaptureGate(args: {
  orderRef: any;
  razorpayPaymentId: string;
}): Promise<GateClaim> {
  if (!db || typeof (db as any).runTransaction !== "function") {
    // Without a transaction "first" cannot be proven — never compensate on an
    // unprovable claim. The expiry-cancel lane still owns real late captures.
    return { kind: "not_first" };
  }
  return (await (db as any).runTransaction(async (tx: any) => {
    const snap = await tx.get(args.orderRef);
    if (!snap || !snap.exists) return { kind: "not_first" } as GateClaim;
    const fresh = (snap.data() || {}) as any;
    if (isOrderConfirmedOrLater(fresh)) return { kind: "not_first" } as GateClaim;

    const compensatedFor = fresh?.unfulfillableCapture?.razorpayPaymentId;
    const alreadyRefunded =
      fresh?.refundStatus === "refunded" ||
      (Number(fresh?.refundedTotalPaise) || 0) > 0;
    if (
      (typeof compensatedFor === "string" && compensatedFor) ||
      (alreadyRefunded && fresh?.unfulfillableCapture)
    ) {
      return { kind: "already_compensated" } as GateClaim;
    }

    const prior = fresh?.captureFulfillmentGate;
    const priorPaymentId =
      prior && typeof prior === "object" && typeof prior.paymentId === "string"
        ? prior.paymentId
        : "";
    const priorAtMs = prior && typeof prior === "object" ? Number(prior.atMs) : NaN;
    if (
      priorPaymentId === args.razorpayPaymentId &&
      Number.isFinite(priorAtMs) &&
      Date.now() - priorAtMs < CAPTURE_GATE_LEASE_MS
    ) {
      // A sibling channel holds a live decision for this very capture.
      return { kind: "not_first" } as GateClaim;
    }

    tx.set(
      args.orderRef,
      {
        captureFulfillmentGate: {
          paymentId: args.razorpayPaymentId,
          atMs: Date.now(),
        },
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    return { kind: "first" } as GateClaim;
  })) as GateClaim;
}

/** Every product id in the order that the catalogue explicitly records as 86'd. */
async function unavailableProductIds(items: any[]): Promise<{
  unavailable: string[];
  readFailed: boolean;
}> {
  const unavailable: string[] = [];
  let readFailed = false;
  for (const item of items) {
    const productId = String((item as any)?.productId ?? (item as any)?.id ?? "").trim();
    if (!productId) continue;
    try {
      const snap = await db.collection("products").doc(productId).get();
      if (snap.exists && (snap.data() as any)?.inStock === false) unavailable.push(productId);
    } catch {
      readFailed = true;
    }
  }
  return { unavailable, readFailed };
}

/**
 * Gate a capture before it is confirmed. Returns `not_first_capture` (a replay:
 * nothing may run, the caller's own idempotent confirm logic settles it),
 * `fulfillable` (confirm normally), `already_compensated` (money already came
 * back — never confirm), or the automatic-refund outcome.
 *
 * Never throws: the caller decides how to surface a refund failure (verify
 * raises a typed 409; the webhook parks for ops and still answers 200).
 */
export async function guardCaptureFulfillment(args: {
  orderRef: any;
  orderId: string;
  razorpayPaymentId: string;
  razorpayOrderId?: string | null;
  orderData: Record<string, any>;
  capturedAmountPaise?: number;
}): Promise<CaptureFulfillmentOutcome> {
  if (!args.razorpayPaymentId) return { outcome: "not_first_capture" };

  const claim = await claimFirstCaptureGate({
    orderRef: args.orderRef,
    razorpayPaymentId: args.razorpayPaymentId,
  });
  if (claim.kind === "not_first") return { outcome: "not_first_capture" };
  if (claim.kind === "already_compensated") return { outcome: "already_compensated" };

  const items = Array.isArray(args.orderData?.items) ? args.orderData.items : [];
  if (items.length === 0) return { outcome: "fulfillable" };

  const { unavailable, readFailed } = await unavailableProductIds(items);
  if (readFailed) {
    await captureErrorSnapshot({
      source: "payments",
      severity: "medium",
      message: `Availability recheck could not read the catalogue for order ${args.orderId} — capture NOT compensated (an outage is never unavailability)`,
      orderId: args.orderId,
      razorpayPaymentId: args.razorpayPaymentId,
    }).catch(() => undefined);
    return { outcome: "fulfillable" };
  }
  if (unavailable.length === 0) return { outcome: "fulfillable" };

  const refund = await refundUnfulfillableCapture({
    orderId: args.orderId,
    razorpayPaymentId: args.razorpayPaymentId,
    razorpayOrderId: args.razorpayOrderId || null,
    capturedAmountPaise: args.capturedAmountPaise,
    reason: "item_unavailable",
    detail: unavailable.join(","),
    source: "capture_fulfillment_gate",
  });
  if (!refund.refunded) return { outcome: "refund_failed", detail: refund.detail };
  return { outcome: "refunded", refundId: refund.refundId, reused: refund.reused };
}
