import { db } from "../../core/firebase";
import * as admin from "firebase-admin";
import { captureErrorSnapshot } from "../../core/errors";
import { refundUnfulfillableCapture } from "./lateCaptureRefund";

/**
 * One guarded FIRST-CAPTURE path, shared by the two channels that can confirm a
 * capture (client `verifyPayment` and the authoritative `payment.captured`
 * webhook).
 *
 * Why it is a LOCK and not a hint. The previous version let a racing sibling
 * read "not first" and go straight on to confirm and ring the KOT while the
 * owner was still deciding availability; when the owner then refunded, the
 * customer got food AND a refund. So the decision is written down on the order
 * (`captureFulfillment`) and BOTH confirmation transactions refuse to confirm
 * unless that record says `fulfillable` for THIS payment:
 *
 *   checking       → someone is deciding. Nobody may confirm.
 *   fulfillable    → confirmed by the owner. Safe to confirm (idempotent).
 *   refunded       → the capture was compensated. NEVER confirm, never KOT.
 *   refund_failed  → compensation was attempted and failed. NEVER confirm;
 *                    park for a human and make the provider retry.
 *
 * A crashed owner is recoverable: `checking` carries a lease (`atMs`), and a
 * stale lease is taken over by the next caller. The channel that finds a live
 * `checking` lease returns a RETRYABLE signal (webhook: non-2xx so Razorpay
 * redelivers; verify: 202) instead of confirming.
 *
 * An unreadable catalogue is an OUTAGE, never proof of unavailability: only a
 * product document that explicitly records `inStock === false` is refunded.
 */

export type CaptureFulfillmentState =
  | "checking"
  | "fulfillable"
  | "refunded"
  | "refund_failed";

export interface CaptureFulfillmentRecord {
  state: CaptureFulfillmentState;
  paymentId: string;
  atMs: number;
}

export type CaptureFulfillmentOutcome =
  /**
   * Nothing to decide: the order is already confirmed/later/terminal, or the
   * document is gone. Confirmation logic (which suppresses replays) decides.
   */
  | { outcome: "already_confirmed" }
  /** Duty to decide is OURS: proceed (the record says fulfillable). */
  | { outcome: "fulfillable" }
  /** Another channel is deciding right now: DO NOT confirm; retry. */
  | { outcome: "pending" }
  /** A compensation was recorded for this order: NEVER confirm. */
  | { outcome: "already_compensated"; state: CaptureFulfillmentState }
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

/** How long one channel may hold the decision before a takeover is allowed. */
export const CAPTURE_GATE_LEASE_MS = 5 * 60_000;

function statusCodeOf(order: any): string {
  const raw = typeof order?.status === "string" ? order.status : order?.status?.code;
  return String(raw || "").toUpperCase();
}

/** Has this order already been confirmed (or moved past confirming)? */
export function isOrderConfirmedOrLater(order: any): boolean {
  const code = statusCodeOf(order);
  return (
    order?.paymentStatus === "completed" ||
    CONFIRMED_OR_LATER.has(code) ||
    order?.status?.terminal === true ||
    order?.terminal === true
  );
}

function gateRecordOf(order: any): CaptureFulfillmentRecord | null {
  const raw = order?.captureFulfillment;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const state = String((raw as any).state || "");
  const paymentId =
    typeof (raw as any).paymentId === "string" ? (raw as any).paymentId : "";
  if (!paymentId) return null;
  if (
    state !== "checking" &&
    state !== "fulfillable" &&
    state !== "refunded" &&
    state !== "refund_failed"
  ) {
    return null;
  }
  return {
    state: state as CaptureFulfillmentState,
    paymentId,
    atMs: Number((raw as any).atMs) || 0,
  };
}

/**
 * May THIS capture confirm this order? Exported for BOTH confirmation
 * transactions: it is the single shared rule that keeps a compensated capture
 * from ever becoming a CONFIRMED, rung order.
 *
 * Deliberately permissive in exactly two cases, both of which never write a
 * confirmation:
 *  - the order is already confirmed / later / terminal (the caller's own
 *    later-status guard preserves it and performs no confirm), and
 *  - the order doc does not exist (the caller's ghost refusal handles it).
 * Every OTHER state must carry a `fulfillable` record for this payment; a
 * missing record means the fulfilment decision was never made, so confirming
 * could produce food plus refund.
 */
export function captureGateAllowsConfirm(order: any, razorpayPaymentId: string): boolean {
  if (!order || typeof order !== "object") return true;
  // COMPENSATION OUTRANKS EVERYTHING. A compensated capture stamps payment
  // truth on the order (so `paymentStatus` reads "completed"), which is exactly
  // why this must be checked BEFORE the already-confirmed allowance below —
  // otherwise a later `order.paid` confirms refunded food.
  const record = gateRecordOf(order);
  if (record && (record.state === "refunded" || record.state === "refund_failed")) {
    return false;
  }
  if (isOrderConfirmedOrLater(order)) return true;
  if (!record) return false;
  return record.state === "fulfillable" && record.paymentId === razorpayPaymentId;
}

/**
 * Transactional decision. Exactly one caller wins `checking`; every other
 * caller learns the state that is on record.
 */
async function claimGate(args: {
  orderRef: any;
  razorpayPaymentId: string;
}): Promise<
  | { kind: "already_confirmed" }
  | { kind: "claimed" }
  | { kind: "fulfillable" }
  | { kind: "pending" }
  | { kind: "compensated"; state: CaptureFulfillmentState }
> {
  if (!db || typeof (db as any).runTransaction !== "function") {
    // Without a transaction there is no way to prove "first" — never compensate
    // and never confirm on an unprovable claim. The caller parks (retryable).
    return { kind: "pending" };
  }
  return (await (db as any).runTransaction(async (tx: any) => {
    const snap = await tx.get(args.orderRef);
    if (!snap || !snap.exists) {
      // A deleted order has nothing to decide and nothing to confirm: let the
      // caller's own ghost/not-found refusal handle it (verify: 404; webhook:
      // parked). Returning "pending" here would hide a real error behind a
      // retry loop.
      return { kind: "already_confirmed" } as const;
    }
    const fresh = (snap.data() || {}) as any;

    // A later lifecycle state (staff already bumped it) is NOT a replay to
    // re-decide: the caller's confirmation logic preserves the status. Running
    // the availability decision here could refund an order in the kitchen, so
    // it is left alone entirely.
    if (isOrderConfirmedOrLater(fresh)) return { kind: "already_confirmed" } as const;

    // COMPENSATION OUTRANKS CONFIRMATION. A compensated capture stamps payment
    // truth on the order (so a naive "is it paid?" read says yes); that must
    // never let a later `order.paid` confirm refunded food.
    const record = gateRecordOf(fresh);
    if (record && record.paymentId === args.razorpayPaymentId) {
      if (record.state === "refunded" || record.state === "refund_failed") {
        return { kind: "compensated", state: record.state } as const;
      }
      if (record.state === "fulfillable") return { kind: "fulfillable" } as const;
      // state === "checking"
      const age = Date.now() - record.atMs;
      if (Number.isFinite(record.atMs) && record.atMs > 0 && age < CAPTURE_GATE_LEASE_MS) {
        return { kind: "pending" } as const;
      }
      // Stale lease (crashed owner): take over below.
    } else if (record && record.paymentId !== args.razorpayPaymentId) {
      // A DIFFERENT capture already owns the decision for this order. A
      // compensation for another payment still forbids confirming this one; a
      // second live capture is the existing foreign-capture guards' business.
      if (record.state === "refunded" || record.state === "refund_failed") {
        return { kind: "compensated", state: record.state } as const;
      }
      if (record.state === "checking") return { kind: "pending" } as const;
      return { kind: "pending" } as const;
    }

    tx.set(
      args.orderRef,
      {
        captureFulfillment: {
          state: "checking",
          paymentId: args.razorpayPaymentId,
          atMs: Date.now(),
        },
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    return { kind: "claimed" } as const;
  })) as any;
}

/** Writes the decided state. Merge-only; never touches payment truth. */
async function recordGateState(args: {
  orderRef: any;
  razorpayPaymentId: string;
  state: CaptureFulfillmentState;
  detail?: string;
}): Promise<boolean> {
  try {
    await args.orderRef.set(
      {
        captureFulfillment: {
          state: args.state,
          paymentId: args.razorpayPaymentId,
          atMs: Date.now(),
          ...(args.detail ? { detail: args.detail.slice(0, 300) } : {}),
        },
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    return true;
  } catch (err: any) {
    // A failure to record leaves "checking", which ages out and is retried.
    console.warn(
      `[Payments] capture-gate state write failed for ${args.razorpayPaymentId}:`,
      err?.message || err
    );
    return false;
  }
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
 * Gate a capture before it is confirmed.
 *
 * `fulfillable` / `already_confirmed` → the caller may run its confirm logic
 * (which re-checks the record transactionally). `pending` → DO NOT confirm: the
 * caller must return a retryable signal. `refunded` / `already_compensated` →
 * never confirm, never KOT. `refund_failed` → never confirm; park and retry.
 */
export async function guardCaptureFulfillment(args: {
  orderRef: any;
  orderId: string;
  razorpayPaymentId: string;
  razorpayOrderId?: string | null;
  orderData: Record<string, any>;
  capturedAmountPaise?: number;
}): Promise<CaptureFulfillmentOutcome> {
  if (!args.razorpayPaymentId) return { outcome: "pending" };

  const claim = await claimGate({
    orderRef: args.orderRef,
    razorpayPaymentId: args.razorpayPaymentId,
  });

  if (claim.kind === "already_confirmed") return { outcome: "already_confirmed" };
  if (claim.kind === "fulfillable") return { outcome: "fulfillable" };
  if (claim.kind === "pending") return { outcome: "pending" };
  if (claim.kind === "compensated") {
    if (claim.state === "refunded") return { outcome: "already_compensated", state: claim.state };
    return { outcome: "refund_failed", detail: "previously recorded compensation failure" };
  }

  // We own the decision now.
  const items = Array.isArray(args.orderData?.items) ? args.orderData.items : [];
  if (items.length === 0) {
    await recordGateState({
      orderRef: args.orderRef,
      razorpayPaymentId: args.razorpayPaymentId,
      state: "fulfillable",
    });
    return { outcome: "fulfillable" };
  }

  const { unavailable, readFailed } = await unavailableProductIds(items);
  if (readFailed) {
    await captureErrorSnapshot({
      source: "payments",
      severity: "medium",
      message: `Availability recheck could not read the catalogue for order ${args.orderId} — capture NOT compensated (an outage is never unavailability)`,
      orderId: args.orderId,
      razorpayPaymentId: args.razorpayPaymentId,
    }).catch(() => undefined);
    // The customer paid and the cart is not proven bad: fulfil. The payment is
    // real money and an outage must never refund a good order.
    await recordGateState({
      orderRef: args.orderRef,
      razorpayPaymentId: args.razorpayPaymentId,
      state: "fulfillable",
      detail: "catalogue_read_failed",
    });
    return { outcome: "fulfillable" };
  }
  if (unavailable.length === 0) {
    await recordGateState({
      orderRef: args.orderRef,
      razorpayPaymentId: args.razorpayPaymentId,
      state: "fulfillable",
    });
    return { outcome: "fulfillable" };
  }

  // Proven unfulfillable: record the verdict BEFORE moving money, so no sibling
  // can confirm while the refund is on the wire.
  await recordGateState({
    orderRef: args.orderRef,
    razorpayPaymentId: args.razorpayPaymentId,
    state: "refunded",
    detail: unavailable.join(","),
  });

  const refund = await refundUnfulfillableCapture({
    orderId: args.orderId,
    razorpayPaymentId: args.razorpayPaymentId,
    razorpayOrderId: args.razorpayOrderId || null,
    capturedAmountPaise: args.capturedAmountPaise,
    reason: "item_unavailable",
    detail: unavailable.join(","),
    source: "capture_fulfillment_gate",
  });
  if (!refund.refunded) {
    // The pre-recorded "refunded" was optimistic: correct it so ops (and the
    // retry path) see the truth instead of a silent success.
    await recordGateState({
      orderRef: args.orderRef,
      razorpayPaymentId: args.razorpayPaymentId,
      state: "refund_failed",
      detail: refund.detail,
    });
    return { outcome: "refund_failed", detail: refund.detail };
  }
  return { outcome: "refunded", refundId: refund.refundId, reused: refund.reused };
}
