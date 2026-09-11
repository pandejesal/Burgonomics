import * as admin from "firebase-admin";
import { db } from "../../core/firebase";
import { serviceError } from "../../core/errors";

export interface DisposeRefundParams {
  refundId: string;
  reason: string;
  decidedBy?: string;
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
  const { refundId, reason, decidedBy } = params;
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
