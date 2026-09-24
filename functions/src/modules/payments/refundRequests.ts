import * as admin from "firebase-admin";
import { db } from "../../core/firebase";
import { serviceError } from "../../core/errors";
import { assertOrderBranchAccess, type StaffCaller } from "../../core/middleware";

export interface DisposeRefundParams {
  refundId: string;
  reason: string;
  decidedBy?: string;
  /** Authenticated staff caller — branch-scoped when present. */
  caller?: StaffCaller;
}

/**
 * Records a staff rejection of a refund request (Loop 7/120 — closes the
 * Loop 5 carryover that left the partner reject path with no server API).
 *
 * Fail-closed: the request must exist (404) and be PENDING (409 on anything
 * else — no double disposition, no rewriting COMPLETED/FAILED rows).
 * Approval never flows through here; money release is autoRefund only.
 * Writes via Admin SDK — client rules deny all direct writes to `refunds`.
 */
export async function disposeRefundRequest(params: DisposeRefundParams) {
  const { refundId, reason, decidedBy, caller } = params;
  const ref = db.collection("refunds").doc(refundId);
  const snap = await ref.get();
  if (!snap.exists) {
    const missing: any = serviceError(
      "REFUND_REQUEST_NOT_FOUND",
      `Cannot dispose refund request ${refundId}: not found.`,
      404
    );
    throw missing;
  }
  const data = (snap.data() || {}) as any;
  // Staff boundary: resolve the linked order and confine the decision to
  // the caller's branches. Docs without a resolvable order fail closed for
  // scoped roles (brand admins pass).
  if (caller) {
    const orderId = typeof data.orderId === "string" ? data.orderId : null;
    const orderSnap = orderId ? await db.collection("orders").doc(orderId).get() : null;
    await assertOrderBranchAccess(caller, orderSnap && orderSnap.exists ? orderSnap.data()! : {});
  }
  if (data.status !== "PENDING") {
    const conflict: any = serviceError(
      "REFUND_REQUEST_NOT_PENDING",
      `Cannot dispose refund request ${refundId}: status is ${data.status || "unknown"}, only PENDING requests can be rejected.`,
      409
    );
    throw conflict;
  }
  await ref.update({
    status: "REJECTED",
    disposition: {
      decision: "rejected",
      reason,
      decidedBy: decidedBy || "staff",
      decidedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return { id: refundId, status: "REJECTED" as const };
}
