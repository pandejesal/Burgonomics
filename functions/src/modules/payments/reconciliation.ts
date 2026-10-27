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

// ---------------------------------------------------------------------------
// T3.3 — SHARED claim-lease TTL (Phase 3 MONEY).
//
// Both money side-effect lanes on one order (the refund claim and the Route
// transfer claim) use a 10-minute lease. The cross-lane serialization guards
// must agree on "fresh" vs "stale" with the lanes' own takeover windows, so
// the constant lives here ONCE (a divergent copy would let one lane treat the
// other's still-live lease as expired — the exact race the guards exist to
// close). razorpay.service.ts and routeTransfers.ts already keep their local
// lease constants at the same value; their new cross-guards read THIS one.
// ---------------------------------------------------------------------------

export const MONEY_CLAIM_TTL_MS = 10 * 60_000;

export function activeMoneyClaimAgeMs(
  claimedAt: unknown,
  nowMs: number = Date.now()
): number | null {
  if (typeof claimedAt === "number" && Number.isFinite(claimedAt) && claimedAt > 0) {
    return Math.max(0, nowMs - claimedAt);
  }
  // Firestore Timestamp sentinel support (toMillis) for serverTimestamp-based leases.
  if (claimedAt && typeof (claimedAt as any).toMillis === "function") {
    return Math.max(0, nowMs - (claimedAt as any).toMillis());
  }
  return null;
}

/** Fresh (< TTL) means the other lane's side effect may be on the wire NOW. */
export function isMoneyClaimFresh(claimedAt: unknown, nowMs: number = Date.now()): boolean {
  const age = activeMoneyClaimAgeMs(claimedAt, nowMs);
  return age !== null && age < MONEY_CLAIM_TTL_MS;
}

// ---------------------------------------------------------------------------
// T3.2 — ATOMIC CAPTURED-PAYMENT CLAIM (Phase 3 MONEY).
//
// The per-order foreign-payment guards (recordedPaymentId read inside each
// order's own confirm transaction) cannot see ANOTHER order's doc, so two
// internal orders with equal stored totals both confirmed on the same
// captured payment — reproduced by
// tests/payment-capture-cross-order-binding.test.ts (RED: confirmedCount 2).
//
// The claim is a `payment_captures/{razorpayPaymentId}` ownership record
// created INSIDE the confirm transaction (same optimistic-retry domain as the
// CONFIRMED write). Concurrent cross-order confirmations conflict on the
// claim read and retry against the winner's binding; a second capture of the
// same payment delivered for a DIFFERENT order is suppressed and parked
// `suppressed_reused_capture` for ops review — never a blind confirm, never a
// second split/OTP/coin debit for money another order already owns.
//
// Backward compatible: an order already confirmed before this record existed
// still re-verifies idempotently when the claim's orderId matches; a claim
// doc with no orderId (corrupt/legacy) is treated as UNRESOLVED and refuses
// a new order fail-closed (manual claim repair is the cure) — never guessed.
// ---------------------------------------------------------------------------

export interface CaptureClaimParams {
  razorpayPaymentId: string;
  orderId: string;
  razorpayOrderId?: string | null;
  amountPaise?: number | null;
  eventId?: string | null;
  /** Deterministic clock seam for tests; defaults to Date.now(). */
  nowMs?: number;
}

export type CaptureClaimTxOutcome =
  | { kind: "claimed" }
  | { kind: "owned_by_order" }
  | { kind: "reused_by_other_order"; recordedOrderId: string | null };

export function getCaptureClaimDocId(razorpayPaymentId: string): string {
  return String(razorpayPaymentId);
}

/**
 * Claims the captured payment for ONE internal order inside the caller's
 * confirm transaction. All inputs must be gateway/server-truth (never a
 * client-asserted value); the caller decides suppression policy on the
 * `reused_by_other_order` outcome.
 */
export async function claimCapturedPaymentInTx(
  tx: any,
  db: any,
  params: CaptureClaimParams
): Promise<CaptureClaimTxOutcome> {
  const { razorpayPaymentId, orderId, razorpayOrderId, amountPaise, eventId, nowMs } = params;
  if (!razorpayPaymentId) {
    // No payment id (e.g. an order.paid with no listed payment anywhere):
    // there is nothing to allow or refuse — the caller's own order-level
    // guards apply. The claim cannot attest what it cannot name.
    return { kind: "claimed" };
  }
  const claimRef = db.collection("payment_captures").doc(getCaptureClaimDocId(razorpayPaymentId));
  const snap = await tx.get(claimRef);
  const existing = snap && snap.exists ? snap.data() : undefined;
  if (existing) {
    const recordedOrderId = typeof existing?.orderId === "string" && existing.orderId ? existing.orderId : null;
    if (recordedOrderId && recordedOrderId === orderId) return { kind: "owned_by_order" };
    // Fail CLOSED on a different-order claim and on a claim that names no
    // order (unresolved): both are owned by nobody provable — never a blind
    // confirm against ambiguity.
    return { kind: "reused_by_other_order", recordedOrderId };
  }
  tx.set(
    claimRef,
    {
      razorpayPaymentId,
      razorpayOrderId: razorpayOrderId || null,
      orderId,
      amountPaise: typeof amountPaise === "number" ? amountPaise : null,
      eventId: eventId || null,
      claimedAt: typeof nowMs === "number" ? nowMs : Date.now(),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: false }
  );
  return { kind: "claimed" };
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


