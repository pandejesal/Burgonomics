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
  /**
   * Raw inbound body, used ONLY to derive `restId` when the caller did not
   * supply one (`extractPetpoojaWebhookRestId`). Transient — never persisted,
   * so the PII boundary below still holds: the audit stores ids and handler
   * messages only.
   */
  payload?: unknown;
  /** Order id / item id from the payload — operational refs only. */
  orderId?: string | null;
  itemId?: string | null;
  /** Menu webhook: how many SKUs were re-ingested. */
  itemCount?: number;
  /** Handler error text (already a system message, capped defensively). */
  detail?: string;
}

/**
 * Extracts the Petpooja outlet id from an inbound webhook body, mirroring the
 * exact field order the ORDER-STATUS handler reads in
 * `item86ingSync.handlePetpoojaWebhook`:
 *
 *   payload.rest_id ?? payload.restId ?? payload.restID ?? payload.restaurantid
 *
 * A real order-status callback (2026-10-17T11:30:22Z) carried the outlet id as
 * `restID` (capital D). The route's audit call read only `rest_id` / `restId`,
 * so it recorded `restId: null` while the SAME payload parked correctly as
 * `unmatched_petpooja_orders/upo_bgx_variation_tax_1792168825392` with
 * `restId: "31z58ciw0h"` — leaving inbound calls unattributable to an outlet.
 * Returns null for a malformed body or an absent/unusable id; never throws.
 */
export function extractPetpoojaWebhookRestId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const raw = p.rest_id ?? p.restId ?? p.restID ?? p.restaurantid;
  if (typeof raw === "number") return Number.isFinite(raw) ? String(raw) : null;
  if (typeof raw === "string") return raw.length > 0 ? raw : null;
  return null;
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
    // An explicitly supplied `restId` still wins (menu-sync resolves a nested
    // sharing code elsewhere). Otherwise derive it from the raw body the same
    // way the handler does, so an order-status callback that carries its outlet
    // id under `restID` is attributed instead of recorded as `null`.
    const restId = entry.restId ?? extractPetpoojaWebhookRestId(entry.payload);
    await db.collection("pos_webhook_audits").doc().set({
      source: "petpooja",
      endpoint: entry.endpoint,
      outcome: entry.outcome,
      restId: restId ?? null,
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
