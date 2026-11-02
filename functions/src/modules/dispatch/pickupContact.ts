import { db } from "../../core/firebase";
import { isSafeDocId } from "../../core/security";
import * as admin from "firebase-admin";
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
 * Resolution order (first PRESENT value wins, nothing is ever defaulted):
 *   1. `branches/{order.branchId}.phone` — the CANONICAL branch record.
 *   2. `order.store.phone` / legacy `order.branchPhone` — the order's own
 *      snapshot, for pre-branch-document orders.
 * A present-but-invalid canonical number does NOT fall through to the client
 * snapshot: a stale/cached (or tampered) snapshot must never decide where a
 * courier is told to call. The customer's number is NEVER a candidate — the
 * courier would be told to ring a different person to find the store.
 *
 * The returned value is provider-ready (`91` + 10 digits), because every
 * adapter would otherwise re-normalise and refuse mid-walk.
 */

export type PickupPhoneSource = "branch_document" | "order_snapshot";

export interface ResolvedPickupContact {
  /** Normalised `+91XXXXXXXXXX`, suitable for persisting/display. */
  phone: string;
  /** `91` + 10-digit national form every provider adapter documents. */
  providerPhone: string;
  /** Store name from the order snapshot, else the canonical branch record. */
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
function toContact(
  raw: string,
  source: PickupPhoneSource,
  name: string
): ResolvedPickupContact | null {
  const providerPhone = phoneFormats.borzo(normalizePhone(raw));
  if (!providerPhone) return null;
  return { phone: `+${providerPhone}`, providerPhone, name, source };
}

/**
 * Resolves the store pickup contact for an order, or null when nothing usable
 * exists (caller must fail closed with `pickupPhoneMissingError`).
 */
export async function resolvePickupContact(
  order: Record<string, any> | null | undefined
): Promise<ResolvedPickupContact | null> {
  const o = order || {};
  const snapshotPhone = firstNonEmptyString(o.store?.phone, o.branchPhone);
  const orderName =
    firstNonEmptyString(o.store?.name, o.branchName) || "Burgonomics Branch";

  const branchId = typeof o.branchId === "string" ? o.branchId : "";
  if (branchId && isSafeDocId(branchId)) {
    try {
      const snap = await db.collection("branches").doc(branchId).get();
      const branch = (snap?.data?.() || {}) as any;
      const canonicalPhone = firstNonEmptyString(branch.phone);
      const branchName = firstNonEmptyString(branch.name);
      if (canonicalPhone) {
        // Present ⇒ canonical. An invalid value is a typed refusal, not a
        // licence to fall back to whatever the client cached.
        return toContact(canonicalPhone, "branch_document", orderName || branchName || "");
      }
      // The canonical record exists but carries no number: the order's own
      // real snapshot is the only remaining real candidate.
      return snapshotPhone
        ? toContact(snapshotPhone, "order_snapshot", orderName)
        : null;
    } catch (err: any) {
      // Fail closed on the branch read, but never discard a REAL snapshot the
      // order already carries — that is not a guess.
      console.warn(
        `[Pickup Contact] branch ${branchId} read failed:`,
        err?.message || err
      );
      return snapshotPhone
        ? toContact(snapshotPhone, "order_snapshot", orderName)
        : null;
    }
  }

  return snapshotPhone ? toContact(snapshotPhone, "order_snapshot", orderName) : null;
}

/**
 * Typed, retryable 422 — staff fixes the store record (or assigns an in-house
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

/**
 * Fills the order's own `store.phone` ONLY when it holds no usable number
 * (never overwrites a real snapshot the customer/staff entered). This is what
 * makes the canonical number durable for the rest of the booking path —
 * notably the Porter leg, which re-reads `orders/{orderId}` and gates its own
 * payload on `store.phone`. Best-effort by design: a failed write must not
 * fail a dispatch whose contact is already resolved in memory.
 */
export async function persistResolvedStorePhone(
  docRef: any,
  order: Record<string, any> | null | undefined,
  resolved: ResolvedPickupContact | null
): Promise<void> {
  if (!resolved || resolved.source !== "branch_document") return;
  const o = order || {};
  if (phoneFormats.borzo(normalizePhone(o.store?.phone)) !== null) return;
  if (phoneFormats.borzo(normalizePhone(o.branchPhone)) !== null) return;
  const store =
    o.store && typeof o.store === "object" ? o.store : { name: resolved.name };
  try {
    await docRef.set(
      {
        store: { ...store, phone: resolved.phone },
        storePhoneSource: "branch_document",
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  } catch (err: any) {
    console.warn(
      "[Dispatch] could not persist the resolved store phone:",
      err?.message || err
    );
  }
}
