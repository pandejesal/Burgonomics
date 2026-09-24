import * as admin from "firebase-admin";
import { db } from "../../core/firebase";
import { serviceError } from "../../core/errors";
import { assertOrderBranchAccess, type StaffCaller } from "../../core/middleware";

export interface ResolveDiscrepancyParams {
  discrepancyId: string;
  resolution: string;
  note?: string;
  decidedBy?: string;
  /** Authenticated staff caller — branch-scoped when present. */
  caller?: StaffCaller;
}

/**
 * Records staff resolution of a payment discrepancy (Loop 25/120 — the
 * reconciliation page resolved local fixtures while server-parked
 * discrepancies sat unread).
 *
 * Fail-closed: the doc must exist (404) and be awaiting review (409 on
 * anything else — no rewriting RESOLVED rows, no double resolution).
 * Writes via Admin SDK — client rules deny all direct writes.
 */
export async function resolveDiscrepancy(params: ResolveDiscrepancyParams) {
  const { discrepancyId, resolution, note, decidedBy, caller } = params;
  const ref = db.collection("payment_discrepancies").doc(discrepancyId);
  const snap = await ref.get();
  if (!snap.exists) {
    throw serviceError(
      "DISCREPANCY_NOT_FOUND",
      `Cannot resolve discrepancy ${discrepancyId}: not found.`,
      404
    );
  }
  const data = (snap.data() || {}) as any;
  // Staff boundary: confine the resolution to the caller's branches via the
  // parked order. Unresolvable linkage fails closed for scoped roles.
  if (caller) {
    const orderId = typeof data.orderId === "string" ? data.orderId : null;
    const orderSnap = orderId ? await db.collection("orders").doc(orderId).get() : null;
    await assertOrderBranchAccess(caller, orderSnap && orderSnap.exists ? orderSnap.data()! : {});
  }
  if (data.status !== "needs_review") {
    throw serviceError(
      "DISCREPANCY_NOT_PENDING",
      `Cannot resolve discrepancy ${discrepancyId}: status is ${data.status || "unknown"}, only needs_review rows can be resolved.`,
      409
    );
  }
  await ref.update({
    status: "resolved",
    resolution: {
      decision: resolution,
      note: note || null,
      decidedBy: decidedBy || "staff",
      decidedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return { id: discrepancyId, status: "RESOLVED" as const };
}
