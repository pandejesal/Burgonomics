import * as admin from "firebase-admin";
import { db } from "../../core/firebase";
import { writeAuditLog } from "../audit/auditLog";

/**
 * SEC-11 (A3 finding 3, owner decision 2026-11-25 #2): deleting an account
 * must ANONYMISE the personal details on everything we keep.
 *
 * The deletion flow already erases `users/{uid}`, `customers/{uid}`, the cart
 * and the device tokens. What it never touched was the retained business
 * record: every past order kept the customer's name, phone and delivery
 * address, and those documents stay readable to support, brand admins and the
 * branch. Keeping the MONEY is a legitimate tax obligation; keeping the person
 * is not.
 *
 * What is REMOVED (personal data):
 *   - orders: customerName / customerPhone / customerEmail, the address and
 *     deliveryAddress maps (and the contact fields dispatch copies out of
 *     them), free-text order notes, per-line notes, and any PII an older
 *     `cashReceipt` snapshot may carry.
 *   - delivery_fee_quotes: the drop coordinates and the owning uid.
 *   - support_tickets: customerName / customerPhone.
 *   - chats/*\/messages: senderName.
 *
 * What is KEPT (tax / accounting): ids, branch, store, order type, items and
 * their prices, every totals/pricing map, cash due, payment status, POS state,
 * settlement stamps, and all timestamps.
 *
 * The scrub is IDEMPOTENT (a document that already carries
 * `piiAnonymisedAt` is skipped, and every patch writes the same final values)
 * and AUDITED (one `admin_audit_logs` row plus a per-uid ledger document with
 * the counts that were changed).
 */

export const ANONYMISATION_LEDGER = "account_pii_anonymisation";

/** Non-PII placeholder written where a human name used to be. */
export const ANONYMISED_NAME = "Deleted User";

/** Address map placeholder: the shape stays a map, the person is gone. */
const ANONYMISED_ADDRESS = { anonymised: true } as const;

/** Order fields that are personal data by name and are deleted outright. */
export const ORDER_PII_FIELDS = [
  "customerName",
  "customerPhone",
  "customerEmail",
  "customerPhoneSource",
  "customerPhoneResolvedAt",
  "deliveryContact",
  "deliveryContactName",
  "deliveryContactPhone",
  "recipient",
  "recipientName",
  "recipientPhone",
  "deliveryInstructions",
  "fulfillmentInstructions",
  "notes",
  "customerNote",
  "specialInstructions",
] as const;

/** Nested contact keys that may appear inside address-like maps. */
export const CONTACT_MAP_KEYS = [
  "contactName",
  "contactPhone",
  "contactEmail",
  "name",
  "phone",
  "email",
  "mobile",
] as const;

export interface AnonymisationCounts {
  orders: number;
  quotes: number;
  tickets: number;
  messages: number;
  skipped: number;
  failed: number;
  remaining: number;
}

const ZERO: AnonymisationCounts = {
  orders: 0,
  quotes: 0,
  tickets: 0,
  messages: 0,
  skipped: 0,
  failed: 0,
  remaining: 0,
};

const DELETED = () => admin.firestore.FieldValue.delete();

function isPlainObject(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** True when a map still carries any contact key with a non-empty value. */
function mapHasContact(map: any): boolean {
  if (!isPlainObject(map)) return false;
  return CONTACT_MAP_KEYS.some((key) => {
    const value = map[key];
    return typeof value === "string" ? value.trim().length > 0 : value != null;
  });
}

/** Line items keep their name/price; only the free-text note is personal. */
function scrubLineNotes(items: unknown): { changed: boolean; items: unknown } {
  if (!Array.isArray(items)) return { changed: false, items };
  let changed = false;
  const next = items.map((item) => {
    if (!isPlainObject(item)) return item;
    const keys = Object.keys(item).filter((k) => k === "notes" || k === "note" || k === "specialInstructions");
    if (keys.length === 0) return item;
    changed = true;
    const copy: Record<string, any> = { ...item };
    for (const key of keys) delete copy[key];
    return copy;
  });
  return { changed, items: next };
}

/**
 * The merge patch that anonymises ONE order.
 *
 * Returns `{}` when the document is already anonymised, so callers can treat
 * an empty patch as "nothing to do" and the whole job is re-runnable.
 */
export function orderAnonymisationPatch(order: any): Record<string, any> {
  if (!isPlainObject(order)) return {};
  if (order.piiAnonymisedAt != null) return {};

  const patch: Record<string, any> = {};

  for (const field of ORDER_PII_FIELDS) {
    if (field in order) patch[field] = DELETED();
  }

  for (const field of ["address", "deliveryAddress", "dropAddress", "customerAddress"] as const) {
    if (field in order) patch[field] = { ...ANONYMISED_ADDRESS };
  }

  // A `customer` snapshot map (older paid orders) keeps only nothing personal.
  if (isPlainObject(order.customer)) {
    patch.customer = { anonymised: true };
  }

  const lines = scrubLineNotes(order.items ?? order.customerLines);
  if (lines.changed) {
    // Both spellings exist in the retained history; rewrite whichever is there
    // so a legacy reader cannot find the note in the copy it reads.
    if (Array.isArray(order.items)) patch.items = lines.items;
    if (Array.isArray(order.customerLines)) patch.customerLines = lines.items;
  }

  // The receipt is amounts only in the current writer, but an older snapshot
  // must not smuggle a name/phone/address through the tax record. The map is
  // REWRITTEN without those keys rather than patched with nested delete
  // sentinels, so the stored shape never depends on a nested-delete rule.
  if (isPlainObject(order.cashReceipt)) {
    const receipt = { ...order.cashReceipt };
    for (const field of ["customerName", "customerPhone", "customerEmail", "address", "deliveryAddress"] as const) {
      delete (receipt as any)[field];
    }
    patch.cashReceipt = receipt;
  }

  // Consent is personal: a deleted account cannot be opted in.
  if (order.whatsappOptIn === true || "whatsappOptInAt" in order) {
    patch.whatsappOptIn = false;
    if ("whatsappOptInAt" in order) patch.whatsappOptInAt = DELETED();
  }

  patch.piiAnonymisedAt = admin.firestore.FieldValue.serverTimestamp();
  patch.updatedAt = admin.firestore.FieldValue.serverTimestamp();
  return patch;
}

/** Same contract for a support ticket: who is gone, the case stays. */
export function ticketAnonymisationPatch(ticket: any): Record<string, any> {
  if (!isPlainObject(ticket)) return {};
  if (ticket.piiAnonymisedAt != null) return {};
  const patch: Record<string, any> = {};
  if ("customerName" in ticket) patch.customerName = ANONYMISED_NAME;
  for (const field of ["customerPhone", "customerEmail"] as const) {
    if (field in ticket) patch[field] = DELETED();
  }
  if (isPlainObject(ticket.diagnostics) && typeof ticket.diagnostics?.deviceInfo === "string") {
    patch.diagnostics = { ...ticket.diagnostics, deviceInfo: DELETED() };
  }
  patch.piiAnonymisedAt = admin.firestore.FieldValue.serverTimestamp();
  patch.updatedAt = admin.firestore.FieldValue.serverTimestamp();
  return patch;
}

/** A quote keeps fee/expiry/branch for accounting; the pin and owner go. */
export function quoteAnonymisationPatch(quote: any): Record<string, any> {
  if (!isPlainObject(quote)) return {};
  if (quote.piiAnonymisedAt != null) return {};
  const patch: Record<string, any> = {
    uid: ANONYMISED_NAME,
    dropLat: DELETED(),
    dropLng: DELETED(),
    dropAddress: DELETED(),
    piiAnonymisedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  if (mapHasContact(quote.dropContact)) patch.dropContact = DELETED();
  return patch;
}

function hasContactValue(value: unknown): boolean {
  return typeof value === "string" ? value.trim().length > 0 : value != null;
}

/**
 * Anonymises every retained copy of a deleted account's personal data.
 *
 * Guarded per collection: one failure is logged and the rest still runs, and
 * the result marks the run incomplete so the caller reports honestly.
 */
export async function anonymiseDeletedUserPii(
  uid: string,
  options: { now?: () => number; budgetMs?: number; pageSize?: number } = {}
): Promise<AnonymisationCounts> {
  if (!uid || typeof uid !== "string") return { ...ZERO };
  const counts: AnonymisationCounts = { ...ZERO };
  const now = options.now ?? (() => Date.now());
  const budgetMs = options.budgetMs ?? 45_000;
  const pageSize = Math.max(1, Math.min(500, options.pageSize ?? 200));
  const deadline = now() + budgetMs;

  const seen = new Set<string>();
  const commit = async (ref: any, patch: Record<string, any>) => {
    try {
      await ref.set(patch, { merge: true });
      return true;
    } catch (err: any) {
      counts.failed += 1;
      console.warn(`[AccountDeletion] PII scrub failed for ${ref?.path || "(unknown)"}:`, err?.message || err);
      return false;
    }
  };

  // ---- orders (also `customerLines`, the address copies and the receipt) ----
  const orderQueries = [
    () => db.collection("orders").where("customerId", "==", uid),
    () => db.collection("orders").where("userId", "==", uid),
  ];
  for (const build of orderQueries) {
    try {
      let cursor: any = null;
      for (;;) {
        if (now() > deadline) {
          counts.remaining += 1;
          break;
        }
        let query: any = build();
        if (typeof query?.orderBy === "function") query = query.orderBy(admin.firestore.FieldPath.documentId());
        if (typeof query?.limit === "function") query = query.limit(pageSize);
        if (cursor && typeof query?.startAfter === "function") query = query.startAfter(cursor);
        const snap = await query.get();
        const docs = snap?.docs || [];
        if (docs.length === 0) break;
        for (const doc of docs) {
          const id = String(doc.id);
          if (seen.has(id)) continue;
          seen.add(id);
          const data = typeof doc.data === "function" ? doc.data() : null;
          const patch = orderAnonymisationPatch(data);
          if (Object.keys(patch).length === 0) {
            counts.skipped += 1;
            continue;
          }
          if (await commit(doc.ref, patch)) counts.orders += 1;
        }
        if (docs.length < pageSize) break;
        cursor = docs[docs.length - 1];
      }
    } catch (err: any) {
      counts.failed += 1;
      console.warn(`[AccountDeletion] order scrub query failed for ${uid}:`, err?.message || err);
    }
  }

  // ---- delivery fee quotes (the customer's own home pin) ----
  try {
    const snap = await db.collection("delivery_fee_quotes").where("uid", "==", uid).limit(500).get();
    for (const doc of snap?.docs || []) {
      const patch = quoteAnonymisationPatch(typeof doc.data === "function" ? doc.data() : null);
      if (Object.keys(patch).length === 0) {
        counts.skipped += 1;
        continue;
      }
      if (await commit(doc.ref, patch)) counts.quotes += 1;
    }
  } catch (err: any) {
    counts.failed += 1;
    console.warn(`[AccountDeletion] quote scrub failed for ${uid}:`, err?.message || err);
  }

  // ---- support tickets (name/phone on the retained case) ----
  try {
    const snap = await db.collection("support_tickets").where("customerId", "==", uid).limit(500).get();
    for (const doc of snap?.docs || []) {
      const patch = ticketAnonymisationPatch(typeof doc.data === "function" ? doc.data() : null);
      if (Object.keys(patch).length === 0) {
        counts.skipped += 1;
        continue;
      }
      if (await commit(doc.ref, patch)) counts.tickets += 1;
    }
  } catch (err: any) {
    counts.failed += 1;
    console.warn(`[AccountDeletion] ticket scrub failed for ${uid}:`, err?.message || err);
  }

  // ---- chat messages (the sender name the other party still sees) ----
  try {
    const threads = await db.collection("chats").where("participantIds", "array-contains", uid).limit(100).get();
    for (const thread of threads?.docs || []) {
      const messages = await thread.ref.collection("messages").limit(500).get();
      for (const message of messages?.docs || []) {
        const data = typeof message.data === "function" ? message.data() : null;
        if (!data || data.senderId !== uid) continue;
        if (data.piiAnonymisedAt != null) {
          counts.skipped += 1;
          continue;
        }
        if (
          await commit(message.ref, {
            senderName: ANONYMISED_NAME,
            ...(hasContactValue(data.senderEmail) ? { senderEmail: DELETED() } : {}),
            piiAnonymisedAt: admin.firestore.FieldValue.serverTimestamp(),
          })
        ) {
          counts.messages += 1;
        }
      }
    }
  } catch (err: any) {
    counts.failed += 1;
    console.warn(`[AccountDeletion] chat scrub failed for ${uid}:`, err?.message || err);
  }

  return counts;
}

/**
 * Runs the scrub, writes the per-uid ledger and the audit row, and returns the
 * counts. Never throws: a cleanup trigger must report, not crash, because the
 * Auth user is already gone by the time this runs.
 */
export async function anonymiseAndAuditDeletedUser(
  uid: string,
  options: { now?: () => number; budgetMs?: number; pageSize?: number } = {}
): Promise<AnonymisationCounts> {
  let counts: AnonymisationCounts = { ...ZERO };
  try {
    counts = await anonymiseDeletedUserPii(uid, options);
  } catch (err: any) {
    counts.failed += 1;
    console.warn(`[AccountDeletion] anonymisation crashed for ${uid}:`, err?.message || err);
  }

  const complete = counts.failed === 0 && counts.remaining === 0;

  try {
    await db
      .collection(ANONYMISATION_LEDGER)
      .doc(uid)
      .set(
        {
          uid,
          completedAt: complete ? admin.firestore.FieldValue.serverTimestamp() : null,
          lastRunAt: admin.firestore.FieldValue.serverTimestamp(),
          complete,
          ...counts,
        },
        { merge: true }
      );
  } catch (err: any) {
    console.warn(`[AccountDeletion] ledger write failed for ${uid}:`, err?.message || err);
  }

  await writeAuditLog({
    action: "account_deletion_pii_anonymised",
    targetType: "user",
    targetId: uid,
    metadata: { ...counts, complete },
  });

  if (!complete) {
    console.warn(
      `[AccountDeletion] PII anonymisation INCOMPLETE for ${uid}:`,
      JSON.stringify(counts)
    );
  }
  return counts;
}
