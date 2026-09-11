import * as admin from "firebase-admin";
import { db } from "../../core/firebase";
import { serviceError } from "../../core/errors";

export interface ResolveDiscrepancyParams {
  discrepancyId: string;
  resolution: string;
  note?: string;
  decidedBy?: string;
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
  const { discrepancyId, resolution, note, decidedBy } = params;
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
