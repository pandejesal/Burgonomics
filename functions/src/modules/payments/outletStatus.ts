import { db } from "../../core/firebase";

/**
 * F2 (staging 2026-11-21, Test 9): the staff "close" was only a shop window.
 *
 * `stores/{id}.isOpen = false` made the customer card read "Closed" and stopped
 * the store list from opening a menu, but the SERVER still answered
 * `POST /checkout/fees` with `serviceable: true` and a live COD offer, still
 * minted a fresh Razorpay order, and still created the cash order (and told the
 * kitchen about it). A customer who reached checkout by any other route — a
 * deep link, a restored cart, a retry — could pay a closed outlet.
 *
 * This module is the server-side answer to the same document the customer
 * storefront reads. It covers the three NEW ONLINE CUSTOMER order paths:
 *
 *   POST /checkout/fees        (fee + COD offer)
 *   createPaymentOrder         (gateway order minted)
 *   createCashOrder            (COD / pay-at-counter order created)
 *
 * A staff WALK-IN counter sale (`createWalkIn`) is deliberately NOT gated: it is
 * tendered at the counter, not an online customer order, and a branch keeps
 * billing walk-in customers while it winds the shopfront down.
 *
 * Absent or unreadable state is handled honestly:
 *   - no storefront document        → nothing has been closed (allowed),
 *   - `isOpen` not a boolean        → not a close signal (allowed),
 *   - a READ FAILURE                → 503, fail closed (a quote/mint that
 *                                     cannot prove the outlet is open must
 *                                     not proceed on a guess).
 */

export const STORE_CLOSED = "STORE_CLOSED";
export const STORE_CLOSED_MESSAGE =
  "This outlet is closed right now, so online orders can't be placed. Please try again during opening hours.";
export const STORE_STATUS_UNAVAILABLE = "STORE_STATUS_UNAVAILABLE";

export interface OutletStatusQuery {
  /** The customer-facing storefront id (`stores/{id}`). */
  storeId?: string | null;
  /** Fallback when the caller only names the branch. */
  branchId?: string | null;
}

function storeClosedError(): Error & { code: string; statusCode: number } {
  const err = new Error(STORE_CLOSED_MESSAGE) as Error & {
    code: string;
    statusCode: number;
  };
  err.code = STORE_CLOSED;
  err.statusCode = 409;
  return err;
}

function unavailableError(cause: unknown): Error & { code: string; statusCode: number } {
  const err = new Error(
    "We couldn't check whether this outlet is open just now — please retry in a moment."
  ) as Error & { code: string; statusCode: number };
  err.code = STORE_STATUS_UNAVAILABLE;
  err.statusCode = 503;
  if (cause instanceof Error) err.stack = cause.stack;
  return err;
}

/**
 * The storefront's `isOpen` flag, or null when nothing defines it.
 *
 * `stores/*` is authoritative and `admin_stores/*` is the fallback the customer
 * directory already uses when `stores` is empty — the same precedence
 * `storeStatus.resolveStorefrontForBranch` applies, so the gate and the staff
 * toggle can never disagree about which document stops ordering.
 */
async function readIsOpenFromDoc(collection: string, id: string): Promise<boolean | null> {
  const snap = await db.collection(collection).doc(id).get();
  const data = snap?.exists ? snap.data() || {} : null;
  if (!data) return null;
  return typeof (data as any).isOpen === "boolean" ? (data as any).isOpen : null;
}

async function findStoreIdForBranch(branchId: string): Promise<string | null> {
  for (const collection of ["stores", "admin_stores"] as const) {
    const col: any = db.collection(collection);
    // A datastore shim without `where` cannot answer this; the storeId path
    // (the one the customer app always uses) is then the only way to tell.
    if (typeof col?.where !== "function") return null;
    const snap = await col.where("partnerBranchId", "==", branchId).limit(5).get();
    const docs = Array.isArray(snap?.docs) ? snap.docs : [];
    if (docs.length === 0) continue;
    // Ambiguity is not guessed here: two storefronts for one branch is a data
    // problem the staff toggle already refuses on, and no close is proven.
    if (docs.length > 1) return null;
    return String(docs[0]?.id ?? "") || null;
  }
  return null;
}

/**
 * Resolves the customer-facing open state for an outlet.
 *
 * `true` = open, `false` = closed, `null` = nothing on record (allowed). Throws
 * a typed 503 when a read fails, because "could not check" is not "open".
 */
export async function readOutletOpenState(
  query: OutletStatusQuery
): Promise<boolean | null> {
  const storeId = typeof query.storeId === "string" ? query.storeId.trim() : "";
  const branchId = typeof query.branchId === "string" ? query.branchId.trim() : "";

  try {
    if (storeId) {
      const direct = await readIsOpenFromDoc("stores", storeId);
      if (direct !== null) return direct;
      // `stores` has no `isOpen`; the directory fallback is the real storefront.
      return await readIsOpenFromDoc("admin_stores", storeId);
    }
    if (branchId) {
      const found = await findStoreIdForBranch(branchId);
      if (!found) return null;
      const viaStores = await readIsOpenFromDoc("stores", found);
      if (viaStores !== null) return viaStores;
      return await readIsOpenFromDoc("admin_stores", found);
    }
    return null;
  } catch (err: any) {
    console.warn("[OutletStatus] storefront read failed, refusing online order:", err?.message || err);
    throw unavailableError(err);
  }
}

/**
 * Refuses a NEW ONLINE CUSTOMER order for a closed outlet. No-op when the
 * outlet is open, or when no storefront document defines the state.
 */
export async function assertOutletOpenForOnlineOrders(
  query: OutletStatusQuery
): Promise<void> {
  const open = await readOutletOpenState(query);
  if (open === false) throw storeClosedError();
}

/**
 * Same question, answered from documents the caller has ALREADY read inside its
 * own transaction (cash orders read `stores/{id}` for the branch link). Keeping
 * the predicate pure means the rule is identical without a second round trip.
 */
export function isStorefrontOpen(storefront: any): boolean | null {
  if (!storefront || typeof storefront !== "object") return null;
  return typeof storefront.isOpen === "boolean" ? storefront.isOpen : null;
}

export function outletClosedError(): Error & { code: string; statusCode: number } {
  return storeClosedError();
}
