import { createHash } from "node:crypto";
import * as admin from "firebase-admin";
import { db } from "../../core/firebase";

/**
 * A2 #4 (preprod audit cycle 11) — the order's human-readable code.
 *
 * `shortCode` used to be `BG-${orderId.slice(-6).toUpperCase()}`. The order id is
 * CALLER-CHOSEN, so two ids (`ord_1234_ABC123` and `ord_999_abc123`) produced the
 * same `BG-ABC123`. Support, the POS pending-alert list and the kitchen ticket
 * then named two different orders identically, and the customer picked the
 * suffix.
 *
 * The code is now derived on the SERVER from a hash of the order id, and every
 * code is RESERVED in `shorts/{code}` in the SAME transaction that creates the
 * order, so a collision takes the next candidate instead of writing a duplicate.
 * Derivation is deterministic, so an idempotent replay of the same order keeps
 * one code. The alphabet omits the characters people misread aloud (0/O, 1/I).
 *
 * `shorts` is unmatched in firestore.rules: default-deny for every client; the
 * Admin SDK writes it and nobody else can.
 */
export const SHORT_CODE_COLLECTION = "shorts";
export const SHORT_CODE_PREFIX = "BG-";
export const SHORT_CODE_LENGTH = 6;
/** Candidates tried before the create is refused (never a silent duplicate). */
export const SHORT_CODE_MAX_CANDIDATES = 8;

const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

function candidateFor(orderId: string, salt: number): string {
  const digest = createHash("sha256")
    .update(`burgonomics.orders.shortcode\u0000${orderId}\u0000${salt}`)
    .digest("hex");
  let body = "";
  for (let i = 0; i < SHORT_CODE_LENGTH; i += 1) {
    const byte = parseInt(digest.slice(i * 2, i * 2 + 2), 16);
    body += ALPHABET[byte % ALPHABET.length];
  }
  return `${SHORT_CODE_PREFIX}${body}`;
}

/**
 * The deterministic candidate list for one order, in the order they are tried.
 * Exported so a test can reason about which code an order will take without
 * duplicating the hash.
 */
export function shortCodeCandidates(orderId: string): string[] {
  const id = String(orderId ?? "");
  const seen = new Set<string>();
  const out: string[] = [];
  for (let salt = 0; salt < SHORT_CODE_MAX_CANDIDATES; salt += 1) {
    const code = candidateFor(id, salt);
    if (seen.has(code)) continue;
    seen.add(code);
    out.push(code);
  }
  return out;
}

function reservationId(code: string): string {
  return code.slice(SHORT_CODE_PREFIX.length);
}

/**
 * Picks a unique code for this order INSIDE the caller's transaction and returns
 * it together with the write that must record the claim.
 *
 * Split in two on purpose: Firestore requires all reads to precede all writes,
 * and every order creator reads more documents after this point (the coupon
 * authority, the quote claim). So the READS happen here — before any write — and
 * the returned `reserve()` is called together with the order create.
 *
 * An existing reservation owned by the SAME order is ours — a retried create
 * keeps the code it already published. Any other reservation sends us to the
 * next candidate; if every candidate is taken the create is refused (503) rather
 * than reusing somebody's code.
 */
export async function planShortCodeReservation(
  tx: any,
  orderId: string,
  meta: { branchId?: string | null } = {}
): Promise<{ code: string; reserve: () => void }> {
  if (!orderId) throw new Error("A short code needs an order id");
  const candidates = shortCodeCandidates(orderId);
  const branchId = typeof meta.branchId === "string" && meta.branchId ? meta.branchId : null;

  // All reads first: this is the transaction's last read-only step by contract.
  const refs = candidates.map((code) =>
    db.collection(SHORT_CODE_COLLECTION).doc(reservationId(code))
  );
  const snaps: any[] = [];
  for (const ref of refs) snaps.push(await tx.get(ref));

  for (let i = 0; i < candidates.length; i += 1) {
    const snap = snaps[i];
    if (!snap?.exists) continue;
    const data = snap.data() || {};
    if (data.orderId === orderId) {
      // Our own retry: the claim already exists, nothing left to write.
      return { code: candidates[i], reserve: () => undefined };
    }
  }

  for (let i = 0; i < candidates.length; i += 1) {
    if (snaps[i]?.exists) continue;
    const code = candidates[i];
    const ref = refs[i];
    return {
      code,
      reserve: () =>
        tx.create(ref, {
          code,
          orderId,
          ...(branchId ? { branchId } : {}),
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        }),
    };
  }

  const err: any = new Error("No unique order code is available right now.");
  err.code = "SHORT_CODE_UNAVAILABLE";
  err.statusCode = 503;
  throw err;
}

/**
 * Convenience for a transaction whose ONLY write is the order create: plans the
 * reservation now and commits it immediately.
 */
export async function reserveShortCodeInTransaction(
  tx: any,
  orderId: string,
  meta: { branchId?: string | null } = {}
): Promise<string> {
  const plan = await planShortCodeReservation(tx, orderId, meta);
  plan.reserve();
  return plan.code;
}

/**
 * The code a display path must render: the stored one, never a fresh guess. A
 * legacy order (created before this change) already carries its own code.
 */
export function shortCodeOf(order: any, orderId: string): string {
  const stored = typeof order?.shortCode === "string" ? order.shortCode.trim() : "";
  if (stored) return stored;
  const number = typeof order?.orderNumber === "string" ? order.orderNumber.trim() : "";
  if (number) return number;
  return String(orderId ?? "").slice(0, 6).toUpperCase();
}
