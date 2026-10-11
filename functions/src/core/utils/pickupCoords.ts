import { db } from "../firebase";
import { isSafeDocId } from "../security";

/**
 * REAL pickup (store) coordinate resolution for dispatch — ZERO-FAKE / H-R19.
 *
 * A courier must never be booked against a fabricated pickup: a made-up store
 * pin sends the rider to the wrong place while the food goes cold. Resolution
 * order (first REAL pair wins, nothing is ever defaulted):
 *   1. `order.branchCoordinates` — the store GPS snapshotted onto the order at
 *      placement (customer app writes it from the outlet registry).
 *   2. `order.store.lat/lng` — legacy orders carrying the store record inline.
 *   3. `branches/{branchId}.coordinates.{lat,lng}` — the canonical branch
 *      document (references/firestore_schema.md Branch.coordinates) so an
 *      older order without a snapshot still dispatches to the RIGHT store.
 *
 * Every candidate must be a finite, in-range, non-null-island pair; anything
 * else is treated as "no coordinate" and the caller fails closed (422) instead
 * of routing to (0,0) or a default city pin.
 */

export interface PickupCoordinates {
  lat: number;
  lng: number;
}

/** Numeric-string tolerant: Firestore occasionally stores "23.0131". */
function toFiniteNumber(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  return n;
}

/** Real, in-world coordinate pair — rejects (0,0) null island and garbage. */
export function isRealCoordinatePair(lat: unknown, lng: unknown): boolean {
  return pair(lat, lng) !== null;
}

function pair(lat: unknown, lng: unknown): PickupCoordinates | null {
  const la = toFiniteNumber(lat);
  const ln = toFiniteNumber(lng);
  if (la === null || ln === null) return null;
  if (Math.abs(la) > 90 || Math.abs(ln) > 180) return null;
  if (la === 0 && ln === 0) return null; // null island placeholder
  return { lat: la, lng: ln };
}

/**
 * Resolves the store pickup GPS for an order, or null when no REAL coordinate
 * exists anywhere (caller must fail closed). The branch-document read only
 * happens when the order snapshot carries none, and a failed read degrades to
 * null (422, retryable) — never to a default pin.
 */
export async function resolvePickupCoordinates(
  order: Record<string, any> | null | undefined
): Promise<PickupCoordinates | null> {
  const o = order || {};

  const snapshot = pair(o.branchCoordinates?.lat, o.branchCoordinates?.lng);
  if (snapshot) return snapshot;

  const inlineStore = pair(o.store?.lat, o.store?.lng);
  if (inlineStore) return inlineStore;

  const branchId = typeof o.branchId === "string" ? o.branchId : "";
  if (!branchId || !isSafeDocId(branchId)) return null;
  try {
    const snap = await db.collection("branches").doc(branchId).get();
    const coords = snap.data?.()?.coordinates;
    return pair(coords?.lat, coords?.lng);
  } catch (err: any) {
    // Fail closed: an unreadable branch doc must not become a default pin.
    console.warn(
      `[Pickup Geo] branch ${branchId} read failed:`,
      err?.message || err
    );
    return null;
  }
}

/** Typed, retryable 422 — staff pins the outlet GPS (or uses an in-house rider). */
export function pickupGpsMissingError(): Error {
  const err: any = new Error(
    "Store pickup coordinates are missing on this order — set the outlet GPS pin on the store record, then retry dispatch (or assign an in-house rider)."
  );
  err.statusCode = 422;
  err.code = "DISPATCH_PICKUP_GPS_MISSING";
  return err;
}

/** Typed, retryable 422 for a drop address without a real map pin. */
export function dropGpsMissingError(): Error {
  const err: any = new Error(
    "Delivery location is missing map coordinates — pin the customer address on the map, then retry dispatch."
  );
  err.statusCode = 422;
  err.code = "DISPATCH_GPS_MISSING";
  return err;
}
