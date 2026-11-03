import { db } from "../../core/firebase";
import { isSafeDocId } from "../../core/security";
import { normalizePhone, phoneFormats } from "./dropContact";

/**
 * REAL pickup (store) CONTACT resolution for dispatch — sibling of
 * `core/utils/pickupCoords.ts`, same zero-fake rule.
 *
 * WHY. Live demo order `ord_1793619336679_6okyas` (branchId `demo`, paid,
 * READY_FOR_PICKUP) had a `store` snapshot written by an installed client that
 * cached the branch record BEFORE its phone existed: `store.phone` was empty.
 * The canonical `branches/demo.phone` was present and normalises to a valid
 * Indian number. Dispatch resolved the pickup GPS from the branch document but
 * took the pickup contact ONLY from the order snapshot, so Borzo's
 * `buildPoints` refused with "borzo returned an unparseable branch phone" —
 * AFTER the per-order claim was taken (dispatch_pending → transient_failure,
 * needsRebook, generation bumped) and shaped like a provider fault although no
 * create-order ever left the process.
 *
 * AUTHORITY: the canonical `branches/{order.branchId}.phone` ONLY.
 *
 * `orders.store` is CLIENT-WRITABLE — it is an allowed key of the customer
 * order-create allowlist (firestore.rules `orderCreateAllowedKeys`), so any
 * customer can stamp any `store.phone` at placement. A courier sent a
 * customer-chosen number would ring a stranger to find the store, which is
 * exactly the wrong-recipient defect this module exists to prevent. The order
 * snapshot is therefore NOT an authority for a new booking: an absent branch
 * document, an unsafe/absent branchId, a branch read failure, and a
 * missing/invalid canonical number all resolve to null → typed 422 BEFORE the
 * per-order claim and BEFORE any provider request. A hostile-but-valid
 * snapshot can never rescue that.
 *
 * The customer's own number is NEVER a candidate either. Nothing is invented,
 * coerced or truncated.
 *
 * The returned value is provider-ready (`91` + 10 digits), because every
 * adapter would otherwise re-normalise and refuse mid-walk.
 */

export type PickupPhoneSource = "branch_document";

export interface ResolvedPickupContact {
  /** Normalised `+91XXXXXXXXXX`, suitable for display. */
  phone: string;
  /** `91` + 10-digit national form every provider adapter documents. */
  providerPhone: string;
  /** Canonical branch name (falls back to the order's display name). */
  name: string;
  source: PickupPhoneSource;
}

function firstNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

/**
 * Normalises a candidate and requires the Indian `91` + 10-digit wire form.
 * Anything else is "not a usable store number" (null) — never coerced, never
 * truncated into a different line.
 */
function toContact(raw: string, name: string): ResolvedPickupContact | null {
  const providerPhone = phoneFormats.borzo(normalizePhone(raw));
  if (!providerPhone) return null;
  return { phone: `+${providerPhone}`, providerPhone, name, source: "branch_document" };
}

/**
 * Resolves the store pickup contact for an order from the CANONICAL branch
 * record, or null when no usable canonical number exists (caller must fail
 * closed with `pickupPhoneMissingError`).
 */
export async function resolvePickupContact(
  order: Record<string, any> | null | undefined
): Promise<ResolvedPickupContact | null> {
  const o = order || {};
  const displayName =
    firstNonEmptyString(o.store?.name, o.branchName) || "Burgonomics Branch";

  const branchId = typeof o.branchId === "string" ? o.branchId : "";
  if (!branchId || !isSafeDocId(branchId)) return null;

  try {
    const snap = await db.collection("branches").doc(branchId).get();
    // A missing document is "no canonical contact", never an invitation to
    // trust the client-supplied snapshot.
    if (!snap?.exists) return null;
    const branch = (snap.data?.() || {}) as any;
    const canonicalPhone = firstNonEmptyString(branch.phone);
    if (!canonicalPhone) return null;
    return toContact(canonicalPhone, firstNonEmptyString(branch.name) || displayName);
  } catch (err: any) {
    // Fail closed: an unreadable branch document must not promote a
    // client-writable snapshot into authority.
    console.warn(
      `[Pickup Contact] branch ${branchId} read failed:`,
      err?.message || err
    );
    return null;
  }
}

/**
 * Typed, retryable 422 — staff fixes the branch record (or assigns an in-house
 * rider). Never a 502 "provider returned an unparseable branch phone": no
 * provider was ever called.
 */
export function pickupPhoneMissingError(): Error {
  const err: any = new Error(
    "The store phone number is missing or invalid for this order's branch — add a valid 10-digit store phone to the branch profile, then retry dispatch (or assign an in-house rider)."
  );
  err.statusCode = 422;
  err.code = "DISPATCH_PICKUP_PHONE_MISSING";
  return err;
}
