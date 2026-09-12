import { db } from "../../core/firebase";
import * as admin from "firebase-admin";

export interface AuditLogInput {
  actorUid?: string | null;
  actorEmail?: string | null;
  /** Machine-readable event, e.g. "refund_processed", "role_assigned". */
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * Readiness-7: server audit writer for admin_audit_logs. The partner dev
 * page showed sample entries as the security log while NOTHING wrote the
 * collection (Loop 54 labeled it honestly). Critical mutations now record
 * real rows here. Best-effort by design: returns false (never throws) so a
 * logging failure can never fail money, RBAC, or invite flows. Rules keep
 * the collection server-write / brand-owner-read.
 */
export async function writeAuditLog(input: AuditLogInput): Promise<boolean> {
  try {
    if (!input || typeof input.action !== "string" || !input.action) return false;
    if (!db || typeof db.collection !== "function") return false;
    const colRef: any = db.collection("admin_audit_logs");
    if (typeof colRef?.add !== "function") return false;
    await colRef.add({
      actorUid: input.actorUid ?? null,
      actorEmail: input.actorEmail ?? null,
      action: input.action,
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
      metadata: input.metadata ?? null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return true;
  } catch (err: any) {
    console.warn("[Audit] write failed:", err?.message || err);
    return false;
  }
}
