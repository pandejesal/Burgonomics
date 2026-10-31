import * as admin from "firebase-admin";
import { db } from "../../core/firebase";
import { serviceError } from "../../core/errors";
import { assertOrderBranchAccess, type StaffCaller } from "../../core/middleware";

/**
 * Server-side KDS order-status bump. Mirrors the partner
 * PARTNER_TO_DELIVERY table (burgonomics-partner/src/utils/orderContract.ts)
 * so writes keep the Delivery-compatible object form customer tracking
 * resolves. Legacy aliases (placed, ready_for_pickup) normalize to their
 * canonical partner status first.
 *
 * Every bump is branch-checked: cross-branch status flips (including silent
 * cancels via 'cancelled') are 403. Recall (backward moves) between non-terminal
 * states is allowed — the KDS UI owns the workflow — but every bump now runs in
 * a transaction that (a) freezes terminal orders (delivered/cancelled/…) and
 * (b) honours the client's `expectedStatus` precondition, so a stale screen or
 * a delayed second tap can no longer reverse a newer status.
 */

export type BumpStatus =
  | "pending"
  | "accepted"
  | "preparing"
  | "ready"
  | "out_for_delivery"
  | "delivered"
  | "cancelled"
  | "placed"
  | "ready_for_pickup";

const ALIAS_TO_CANONICAL: Record<string, string> = {
  placed: "pending",
  ready_for_pickup: "ready",
};

interface DeliveryStatusMeta {
  code: string;
  label: string;
  kind: "upcoming" | "in_progress" | "completed" | "cancelled" | "failed" | "unknown";
  terminal: boolean;
}

const PARTNER_TO_DELIVERY: Record<string, DeliveryStatusMeta> = {
  pending: { code: "PLACED", label: "Order placed", kind: "upcoming", terminal: false },
  accepted: { code: "CONFIRMED", label: "Order confirmed", kind: "upcoming", terminal: false },
  preparing: { code: "PREPARING", label: "Preparing your order", kind: "in_progress", terminal: false },
  ready: { code: "READY_FOR_PICKUP", label: "Ready for pickup", kind: "in_progress", terminal: false },
  out_for_delivery: { code: "OUT_FOR_DELIVERY", label: "Out for delivery", kind: "in_progress", terminal: false },
  delivered: { code: "DELIVERED", label: "Delivered", kind: "completed", terminal: true },
  cancelled: { code: "CANCELLED", label: "Cancelled", kind: "cancelled", terminal: true },
};

/**
 * Normalizes an `expectedStatus` into the set of Delivery codes that count as
 * THE SAME visible state (G1): the raw value when the caller already speaks
 * canonical Delivery vocabulary (case-insensitively), plus the fulfillment-
 * specific code for that state via the EXISTING partner tables (pending->PLACED,
 * ready->READY_FOR_PICKUP, dinein ready->READY_TO_SERVE, takeaway/dinein
 * delivered->PICKED_UP/COMPLETED). Unknown vocabulary is empty-safe: it only
 * matches if it happens to be the order's literal current code.
 */
function allowedExpectedCodes(expected: string, fulfillment: string): Set<string> {
  const raw = expected.trim();
  if (!raw) return new Set();
  const codes = new Set<string>([raw.toUpperCase()]);
  // Vocabulary tables are lowercase-keyed, normalized before the lookups so
  // "ACCEPTED" still resolves to CONFIRMED and "READY" to the dinein fork.
  const lower = raw.toLowerCase();
  const canonical = ALIAS_TO_CANONICAL[lower] ?? lower;
  const meta: DeliveryStatusMeta | undefined = (PARTNER_TO_DELIVERY as Record<string, DeliveryStatusMeta>)[canonical];
  if (meta) {
    codes.add(meta.code);
    if (canonical === "ready" && fulfillment === "dinein") codes.add("READY_TO_SERVE");
    // delivered forks (PICKED_UP/COMPLETED) are corruption-tolerance only:
    // those states are terminal (terminal guard throws before this compare),
    // so a matching expectation can never be consultable on healthy docs.
  }
  return codes;
}

export interface BumpOrderStatusParams {
  orderId: string;
  status: BumpStatus;
  /** Status.code the caller's screen currently shows; mismatch → 409 STALE_ORDER_STATUS. */
  expectedStatus?: string;
  cancellationReason?: string;
  timelineEvent?: { title: string; actor?: string; description?: string };
  caller?: StaffCaller;
}

export async function bumpOrderStatus(params: BumpOrderStatusParams) {
  const { orderId, status, cancellationReason, timelineEvent, caller } = params;
  const canonical = ALIAS_TO_CANONICAL[status] ?? status;
  const meta = PARTNER_TO_DELIVERY[canonical];
  if (!meta) {
    throw serviceError("ORDER_STATUS_UNKNOWN", `Unknown order status: ${status}`, 400);
  }

  const orderRef = db.collection("orders").doc(orderId);
  const preSnap = await orderRef.get();
  if (!preSnap.exists) {
    throw serviceError("ORDER_NOT_FOUND", `Order ${orderId} not found`, 404);
  }
  const preOrder = (preSnap.data() || {}) as any;
  if (caller) await assertOrderBranchAccess(caller, preOrder);

  let finalMeta = { ...meta };
  const fulfillment = (preOrder.fulfillmentType || preOrder.orderType || preOrder.fulfillment || "delivery").toLowerCase();
  if (fulfillment === "dinein") {
    if (canonical === "ready") {
      finalMeta = { code: "READY_TO_SERVE", label: "Ready to serve", kind: "in_progress", terminal: false };
    } else if (canonical === "delivered") {
      finalMeta = { code: "COMPLETED", label: "Completed", kind: "completed", terminal: true };
    }
  } else if (fulfillment === "takeaway") {
    if (canonical === "delivered") {
      finalMeta = { code: "PICKED_UP", label: "Picked up", kind: "completed", terminal: true };
    }
  }

  const payload: Record<string, any> = {
    status: finalMeta,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  // Narrow: a reason is a CANCELLATION attribute. The previous unconditional
  // write stamped a cancel reason onto a live cooking order (the scheme let
  // cancellationReason ride any bump).
  if (canonical === "cancelled" && cancellationReason) {
    payload.cancellationReason = cancellationReason;
  }
  if (timelineEvent) {
    payload.timeline = admin.firestore.FieldValue.arrayUnion({
      ...timelineEvent,
      timestamp: new Date().toISOString(),
    });
  }

  // Optimistic-concurrency + terminal guard, enforced inside a transaction so
  // two staff racing on the same order cannot both win (last-write-wins used to
  // let a delayed second tap silently reverse a newer state).
  const expectedRaw = params.expectedStatus;
  const expected = expectedRaw?.trim();
  if (expectedRaw !== undefined && !expected) {
    // An empty precondition is a client bug: refusing is honest, silently
    // dropping the stale-screen guard is not.
    throw serviceError("STALE_ORDER_STATUS", "Order: expectedStatus was empty", 400);
  }
  await db.runTransaction(async (tx) => {
    const live = await tx.get(orderRef);
    if (!live.exists) {
      throw serviceError("ORDER_NOT_FOUND", `Order ${orderId} not found`, 404);
    }
    const current = ((live.data() || {}) as any).status || {};
    // A terminal order (delivered/cancelled/completed/picked up) is frozen:
    // stale taps must never regress it, and a delivered order is not
    // cancellable from a KDS screen.
    if (current.terminal === true) {
      throw serviceError(
        "ORDER_STATUS_CONFLICT",
        `Order ${orderId} is already ${current.code || "closed"}; status can no longer be changed`,
        409,
      );
    }
    // The client told us which state its screen was showing. If the stored
    // state has moved on (another staff member acted, a webhook landed), this
    // bump is stale and must not be applied.
    // G1: the Partner app sends ITS vocabulary (pending/accepted/ready//...) in
    // expectedStatus; the server stores uppercase Delivery codes like
    // READY_TO_SERVE/PICKED_UP, so the raw compare rejected nearly every
    // accompanied bump. Compare through the canonical vocabulary tables.
    if (expected && !allowedExpectedCodes(expected, fulfillment).has(String(current.code || "").toUpperCase())) {
      throw serviceError(
        "STALE_ORDER_STATUS",
        `Order ${orderId} moved to ${current.code || "unknown"} since the screen loaded; refresh before acting`,
        409,
      );
    }
    tx.update(orderRef, payload);
  });

  // Return the meta we actually WROTE (fulfillment-specific), not the generic
  // delivery meta - the KDS response is a state artifact and dinein/takeaway
  // bumps must not claim DELIVERED/READY_FOR_PICKUP the doc does not carry.
  return { orderId, status: finalMeta };
}
