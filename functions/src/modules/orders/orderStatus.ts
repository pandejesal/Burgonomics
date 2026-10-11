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
  if (cancellationReason) payload.cancellationReason = cancellationReason;
  if (timelineEvent) {
    payload.timeline = admin.firestore.FieldValue.arrayUnion({
      ...timelineEvent,
      timestamp: new Date().toISOString(),
    });
  }

  // Optimistic-concurrency + terminal guard, enforced inside a transaction so
  // two staff racing on the same order cannot both win (last-write-wins used to
  // let a delayed second tap silently reverse a newer state).
  const expected = params.expectedStatus?.trim();
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
    if (expected && current.code !== expected) {
      throw serviceError(
        "STALE_ORDER_STATUS",
        `Order ${orderId} moved to ${current.code || "unknown"} since the screen loaded; refresh before acting`,
        409,
      );
    }
    tx.update(orderRef, payload);
  });

  return { orderId, status: meta };
}
