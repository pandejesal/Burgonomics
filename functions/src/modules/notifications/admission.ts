import * as admin from "firebase-admin";
import { db } from "../../core/firebase";

/**
 * A2 #1 (preprod audit cycle 11) — exactly-once admission notices.
 *
 * A Firestore trigger is at-least-once, and `handleOrderStatusChanged` is also
 * called directly by tests and by retry paths, so "send it and hope" double-
 * chimes on any redelivery. A receipt document is CLAIMED before the send and
 * RELEASED when the send fails:
 *
 *   - claim wins            -> exactly one send;
 *   - crash after the claim -> one claimed receipt, no duplicate (the failed-send
 *                             snapshot is the operator path, exactly like the
 *                             existing KOT-failure alerts);
 *   - send throws           -> the receipt is deleted, so a retry still delivers.
 *
 * `order_notification_receipts` is unmatched in firestore.rules, i.e. it is
 * default-deny for every client — the Admin SDK writes it, nobody else can.
 */
const ADMISSION_RECEIPTS = "order_notification_receipts";

export type AdmissionNoticeKind = "kitchen_kot" | "customer_confirmed";

/** Order identities that must never receive a customer account notice. */
const NON_CUSTOMER_IDENTITIES =
  /^(?:cust_walkin|walk[_-]?in|guest(?:[_-].*)?|anonymous|system|server)$/i;

/**
 * True only for a real customer account. The walk-in counter sentinel is not a
 * user document; pushing "Order Confirmed!" to `users/cust_walkin` wrote an
 * inbox row nobody owns.
 */
export function isNotifiableCustomer(customerId: unknown): customerId is string {
  if (typeof customerId !== "string") return false;
  const value = customerId.trim();
  if (!value || value !== customerId) return false;
  return !NON_CUSTOMER_IDENTITIES.test(value);
}

function receiptId(orderId: string, kind: AdmissionNoticeKind): string {
  return `${orderId}__${kind}`;
}

/**
 * Claims the right to send one admission notice. True means "you own this
 * send"; false means it was already claimed (so a redelivered event is silent).
 *
 * Datastore unavailable: fails OPEN (true). A broken receipt store must never
 * silence the kitchen — a duplicate chime is recoverable, a missing one is food
 * nobody cooks.
 */
export async function claimAdmissionNotice(
  orderId: string,
  kind: AdmissionNoticeKind,
  meta: Record<string, unknown> = {}
): Promise<boolean> {
  if (!orderId) return false;
  try {
    if (!db || typeof (db as any).runTransaction !== "function") return true;
    return await (db as any).runTransaction(async (tx: any) => {
      const ref = db.collection(ADMISSION_RECEIPTS).doc(receiptId(orderId, kind));
      const snap = await tx.get(ref);
      if (snap?.exists) return false;
      tx.set(ref, {
        orderId,
        kind,
        ...meta,
        claimedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      return true;
    });
  } catch (err: any) {
    console.warn(
      `[Admission] receipt claim failed for ${orderId}/${kind} — sending without dedupe:`,
      err?.message || err
    );
    return true;
  }
}

/** Gives the claim back after a failed send so a retry can still deliver. */
export async function releaseAdmissionNotice(
  orderId: string,
  kind: AdmissionNoticeKind
): Promise<void> {
  if (!orderId) return;
  try {
    await db.collection(ADMISSION_RECEIPTS).doc(receiptId(orderId, kind)).delete();
  } catch (err: any) {
    console.warn(
      `[Admission] receipt release failed for ${orderId}/${kind}:`,
      err?.message || err
    );
  }
}
