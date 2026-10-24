import * as admin from "firebase-admin";

/**
 * Customer-visible states for a payment we could not apply to its order.
 * Adding a state is a customer-facing vocabulary decision, so keep this union
 * small and explicit rather than growing it opportunistically.
 */
export type OrderReconciliationState = "payment_review";

export interface OrderReconciliationInfo {
  state: OrderReconciliationState;
  /** Machine-readable cause (e.g. `confirm_amount_mismatch`) — ops-facing. */
  reason: string;
  razorpayPaymentId?: string | null;
}

/**
 * Marks the ORDER doc with a customer-visible reconciliation state.
 *
 * Why this exists (B5): every parked outcome (`unmatched_payments`,
 * `payment_discrepancies`, `needs_reconciliation`, `awaiting_capture`) is
 * brand-only readable, so a payer whose app was closed after the gateway charge
 * has NO self-serve view of what happened to their money — support reconciles
 * from scratch. The order doc is the one surface they can already read
 * (`firestore.rules`: an order is readable by its own `customerId`/`userId`), so
 * the marker lives there instead of loosening any brand-only collection.
 *
 * Boundaries, deliberately:
 * - Merge-only: it adds one `reconciliation` map and rewrites nothing else, so
 *   an order's own truth is never mutated by a marker.
 * - Fail-open: a marker write must never turn a valid webhook into a 5xx (the
 *   provider would then retry already-captured money forever).
 * - NOT wired for a FOREIGN or SECOND distinct capture: the affected payer need
 *   not be the order's owner (that is the whole point of those parks), so a
 *   customer-visible marker there could mislead the owner. Those stay ops-only.
 * - The marker is not auto-cleared: it is only ever written while the order is
 *   unapplied, and staff resolution clears it explicitly.
 */
export async function markOrderReconciliation(
  orderRef: admin.firestore.DocumentReference,
  info: OrderReconciliationInfo
): Promise<void> {
  try {
    await orderRef.set(
      {
        reconciliation: {
          state: info.state,
          reason: info.reason,
          razorpayPaymentId: info.razorpayPaymentId || null,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
      },
      { merge: true }
    );
  } catch (err: any) {
    console.warn(
      "[payments] reconciliation marker write failed (non-blocking):",
      err?.message || err
    );
  }
}

export interface TerminalCaptureParkParams {
  orderId: string;
  razorpayPaymentId: string;
  razorpayOrderId?: string | null;
  amountPaise?: number | null;
  reason: "capture_on_cancelled_order" | "capture_on_refunded_order" | string;
  orderStatus?: string | null;
  source?: string;
  metadata?: Record<string, any>;
}

export function getTerminalCaptureParkDocId(razorpayPaymentId: string): string {
  return `ump_term_${razorpayPaymentId}`;
}

export function buildTerminalCaptureParkPayload(
  params: TerminalCaptureParkParams
): Record<string, any> {
  const {
    orderId,
    razorpayPaymentId,
    razorpayOrderId,
    amountPaise,
    reason,
    orderStatus,
    source = "route_transfers_retry",
    metadata,
  } = params;

  return {
    eventId: `${source}_${razorpayPaymentId}`,
    event: source,
    razorpayPaymentId,
    razorpayOrderId: razorpayOrderId || null,
    orderId,
    amount: typeof amountPaise === "number" ? amountPaise / 100 : null,
    currency: "INR",
    claimedOrderId: orderId,
    receivedAt: admin.firestore.FieldValue.serverTimestamp(),
    status: "needs_review",
    reason,
    orderStatus: orderStatus || null,
    ...(metadata ? { metadata } : {}),
  };
}

export function buildOrderReconciliationPayload(
  info: OrderReconciliationInfo
): Record<string, any> {
  return {
    reconciliation: {
      state: info.state,
      reason: info.reason,
      razorpayPaymentId: info.razorpayPaymentId || null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
  };
}

/**
 * Deterministically parks a captured payment for a terminal order (cancelled or refunded)
 * into `unmatched_payments` under a single stable document ID (`ump_term_${razorpayPaymentId}`).
 * Non-tx utility: propagates errors so non-durable writes are not silently treated as successful.
 */
export async function parkTerminalPaymentCapture(
  db: any,
  params: TerminalCaptureParkParams
): Promise<void> {
  if (!params.razorpayPaymentId) return;
  const docId = getTerminalCaptureParkDocId(params.razorpayPaymentId);
  const payload = buildTerminalCaptureParkPayload(params);
  await db.collection("unmatched_payments").doc(docId).set(payload, { merge: true });
}


