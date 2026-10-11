import { db } from "../../core/firebase";
import * as admin from "firebase-admin";

/** The three inbound Petpooja endpoints that must leave an audit trail. */
export type PetpoojaWebhookEndpoint =
  | "/petpooja/webhook"
  | "/petpooja/stockWebhook"
  | "/petpooja/menu-sync";

export interface PetpoojaWebhookAuditEntry {
  endpoint: PetpoojaWebhookEndpoint;
  outcome: "ok" | "error";
  /** Petpooja's outlet id (rest_id) — never a customer field. */
  restId?: string | null;
  /** Order id / item id from the payload — operational refs only. */
  orderId?: string | null;
  itemId?: string | null;
  /** Menu webhook: how many SKUs were re-ingested. */
  itemCount?: number;
  /** Handler error text (already a system message, capped defensively). */
  detail?: string;
}

/**
 * Structured audit trail for INBOUND Petpooja webhook invocations, written to
 * Firestore `pos_webhook_audits` (server SDK — clients cannot write here).
 *
 * Scope decisions:
 * - Audits cover AUTHENTICATED invocations only. Rejected requests never
 *   reach this function (verifyPetpoojaAuth logs a structured console line
 *   instead), so an unauthenticated caller cannot amplify into Firestore
 *   writes.
 * - PII boundary: rest/order/item ids and handler messages only — never
 *   phone numbers, addresses, or raw payload bodies.
 * - Best-effort: an audit write must never turn a valid webhook into a 5xx
 *   (Petpooja would retry the same event forever).
 */
export async function auditPetpoojaWebhook(entry: PetpoojaWebhookAuditEntry): Promise<void> {
  try {
    await db.collection("pos_webhook_audits").doc().set({
      source: "petpooja",
      endpoint: entry.endpoint,
      outcome: entry.outcome,
      restId: entry.restId ?? null,
      orderId: entry.orderId ?? null,
      itemId: entry.itemId ?? null,
      ...(entry.itemCount !== undefined ? { itemCount: entry.itemCount } : {}),
      detail: entry.detail ? String(entry.detail).slice(0, 500) : null,
      receivedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (err: any) {
    console.warn(
      "[Petpooja Webhook Audit] persist failed (non-blocking):",
      err?.message || err
    );
  }
}
