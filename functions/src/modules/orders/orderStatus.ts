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
 * cancels via 'cancelled') are 403. Recall (backward moves) is allowed —
 * recency, not direction, is enforced; the KDS UI owns the workflow.
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
  const snap = await orderRef.get();
  if (!snap.exists) {
    throw serviceError("ORDER_NOT_FOUND", `Order ${orderId} not found`, 404);
  }
  const order = (snap.data() || {}) as any;
  if (caller) await assertOrderBranchAccess(caller, order);

  let finalMeta = { ...meta };
  const fulfillment = (order.fulfillmentType || order.orderType || order.fulfillment || "delivery").toLowerCase();
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
  await orderRef.set(payload, { merge: true });
  return { orderId, status: meta };
}
