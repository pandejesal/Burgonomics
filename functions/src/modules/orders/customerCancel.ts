import * as admin from "firebase-admin";
import { db } from "../../core/firebase";
import { serviceError } from "../../core/errors";
import { applyCancelSideEffects } from "./cancelSideEffects";

/**
 * F24 — the server-owned CUSTOMER cancellation path.
 *
 * Why this exists: the Customer app used to write
 * `{status:{code:'CANCELLED'}, completedAt}` straight to `orders/{id}` (the
 * rules arm admitted it). That write performed NONE of the cancellation's
 * obligations — no durable rider-cancel intent and no redeemed-coins restore —
 * because those lived only in the staff transition. The staff route cannot be
 * reused: it is `requireRole(brand/branch)`-gated and branch-scoped.
 *
 * Owner product decision (18 Nov 2026): a customer may cancel while the order
 * is "being prepared or earlier" — non-terminal and no later than PREPARING —
 * and only BEFORE a rider is assigned. Once a rider is assigned, or the order
 * is ready / picked up / out for delivery, the cancel is refused (409). A
 * courier BOOKING without an assigned rider stays cancellable, and the shared
 * side-effect helper records the durable provider-cancel intent for it.
 *
 * Design rules enforced here:
 *   - ownership and cancellability are re-checked on the FRESH document INSIDE
 *     the status transaction (the pre-read is only a fast 404);
 *   - the write is one atomic status update, so a concurrent staff tick or a
 *     second device serializes instead of double-cancelling;
 *   - a retry converges: `alreadyCancelled` short-circuits the write and
 *     re-runs only the idempotent side effects;
 *   - side effects run strictly post-commit and never fail the cancel.
 */

/**
 * Rank of the statuses an order passes through, used to express the owner's
 * "preparing or earlier" window without listing every legacy alias as a special
 * case. Anything absent is NOT cancellable (fail closed).
 */
const STATUS_RANK: Record<string, number> = {
  PLACED: 0,
  ORDER_PLACED: 0,
  PENDING: 0,
  CONFIRMED: 1,
  ACCEPTED: 1,
  PREPARING: 2,
  READY: 3,
  READY_FOR_PICKUP: 3,
  PICKED_UP: 4,
  OUT_FOR_DELIVERY: 5,
};

/** The highest rank a customer may still cancel: PREPARING. */
const CUSTOMER_CANCEL_MAX_RANK = 2;

const TERMINAL_CODES = ["CANCELLED", "DELIVERED", "COMPLETED", "PICKED_UP", "REFUNDED", "FAILED"];

/** Delivery legs that mean a rider is already committed to the order. */
const RIDER_ASSIGNED_LEGS = ["dispatched", "driver_allocated", "rider_assigned", "in_transit"];

/** Legacy docs may store `status` as a plain string; new docs store a map. */
function statusCodeOf(order: any): string {
  const raw =
    typeof order?.status === "object" && order?.status !== null ? order.status.code : order?.status;
  return String(raw ?? "")
    .trim()
    .toUpperCase();
}

function isTerminalOrder(order: any): boolean {
  if (typeof order?.status === "object" && order?.status?.terminal === true) return true;
  return TERMINAL_CODES.includes(statusCodeOf(order));
}

/**
 * True when a rider already owns the delivery leg. Rider identity is the
 * definitive signal (the provider assigns it); a moving delivery status is the
 * belt-and-braces equivalent for a booking whose rider patch has not landed.
 */
function hasAssignedRider(order: any): boolean {
  const hasRiderIdentity =
    Boolean(String(order?.riderName ?? "").trim()) || Boolean(String(order?.riderPhone ?? "").trim());
  if (hasRiderIdentity) return true;
  return RIDER_ASSIGNED_LEGS.includes(String(order?.deliveryStatus ?? "").toLowerCase());
}

export interface CustomerCancelInput {
  orderId: string;
  /** The ID-token uid. NEVER a body-supplied identity. */
  uid: string;
  reason?: string;
}

export interface CustomerCancelResult {
  orderId: string;
  status: { code: string; label: string; kind: string; terminal: boolean };
  /** True when the order was already CANCELLED and only side effects re-ran. */
  alreadyCancelled: boolean;
}

const CANCELLED_STATUS = {
  code: "CANCELLED",
  label: "Cancelled",
  kind: "cancelled",
  terminal: true,
};

export async function cancelOrderAsCustomer(
  input: CustomerCancelInput
): Promise<CustomerCancelResult> {
  const orderId = String(input.orderId || "").trim();
  const uid = String(input.uid || "").trim();
  if (!orderId) {
    throw serviceError("ORDER_ID_REQUIRED", "orderId is required", 400);
  }
  if (!uid) {
    throw serviceError("UNAUTHORIZED", "Authentication required", 401);
  }

  const orderRef = db.collection("orders").doc(orderId);
  // Fast 404 only. Every security decision below is re-made on the FRESH
  // transactional snapshot, so a stale pre-read cannot authorize a write.
  const preSnap = await orderRef.get();
  if (!preSnap.exists) {
    throw serviceError("ORDER_NOT_FOUND", `Order ${orderId} not found`, 404);
  }

  const alreadyCancelled = await db.runTransaction(async (tx) => {
    const live = await tx.get(orderRef);
    if (!live.exists) {
      throw serviceError("ORDER_NOT_FOUND", `Order ${orderId} not found`, 404);
    }
    const fresh = (live.data() || {}) as any;

    // 1. Ownership on the FRESH doc (the pre-read may be stale).
    const owned = fresh.customerId === uid || fresh.userId === uid;
    if (!owned) {
      throw serviceError(
        "ORDER_NOT_OWNED",
        "This order does not belong to the signed-in account.",
        403
      );
    }

    // 2. Terminal handling: a cancellation RETRY converges (idempotent); any
    // other closed order is a refusal.
    if (isTerminalOrder(fresh)) {
      if (statusCodeOf(fresh) === "CANCELLED") return true;
      throw serviceError(
        "ORDER_NOT_CANCELLABLE",
        "This order is already closed and cannot be cancelled.",
        409
      );
    }

    // 3. Owner window: non-terminal and no later than PREPARING.
    const code = statusCodeOf(fresh);
    const rank = STATUS_RANK[code];
    if (typeof rank !== "number" || rank > CUSTOMER_CANCEL_MAX_RANK) {
      throw serviceError(
        "ORDER_NOT_CANCELLABLE",
        "The store has already moved past preparation — please contact the store to cancel this order.",
        409
      );
    }

    // 4. The rider guard: a live rider is cancelled by staff/dispatch, never by
    // the customer's one-tap app cancel. A BOOKING with no assigned rider is
    // still cancellable and gets the durable provider intent post-commit.
    if (hasAssignedRider(fresh)) {
      throw serviceError(
        "ORDER_NOT_CANCELLABLE",
        "A delivery partner is already assigned — please contact the store to cancel this order.",
        409
      );
    }

    const payload: Record<string, any> = {
      status: CANCELLED_STATUS,
      completedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    const reason = typeof input.reason === "string" ? input.reason.trim() : "";
    if (reason) payload.cancellationReason = reason.slice(0, 500);
    tx.update(orderRef as any, payload);
    return false;
  });

  // Post-commit, non-throwing, idempotent (retries converge on one intent and
  // one coin restore ledger row). `applyCancelSideEffects` is contracted never
  // to throw; the extra guard keeps that promise even if a future helper edit
  // regresses, because the status write is already durable.
  try {
    await applyCancelSideEffects({
      orderId,
      requestedBy: `customer:${uid}`,
      reason: "order_cancelled",
    });
  } catch (err: any) {
    console.warn(
      `[CustomerCancel] cancellation side effects failed for ${orderId}:`,
      err?.message || err
    );
  }

  return { orderId, status: CANCELLED_STATUS, alreadyCancelled };
}
