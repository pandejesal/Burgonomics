import { db } from "../../core/firebase";
import { resolveStorefrontForBranch, staffCloseOverrideInForce } from "../stores/storeStatus";

/**
 * F2 (staging 2026-11-21, Test 9): the staff "close" was only a shop window.
 *
 * `stores/{id}.isOpen = false` made the customer card read "Closed" and stopped
 * the store list from opening a menu, but the SERVER still answered
 * `POST /checkout/fees` with `serviceable: true` and a live COD offer, still
 * minted a fresh Razorpay order, and still created the cash order (and told the
 * kitchen about it). A customer who reached checkout by any other route â€” a
 * deep link, a restored cart, a retry â€” could pay a closed outlet.
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
 *   - no storefront document        â†’ nothing has been closed (allowed),
 *   - `isOpen` not a boolean        â†’ not a close signal (allowed),
 *   - a READ FAILURE                â†’ 503, fail closed (a quote/mint that
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
  /** Petpooja outlet id â€” the second key the canonical resolver accepts. */
  restId?: string | null;
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
    "We couldn't check whether this outlet is open just now â€” please retry in a moment."
  ) as Error & { code: string; statusCode: number };
  err.code = STORE_STATUS_UNAVAILABLE;
  err.statusCode = 503;
  if (cause instanceof Error) err.stack = cause.stack;
  return err;
}

function storefrontMismatchError(): Error & { code: string; statusCode: number } {
  const err = new Error(
    "This outlet is not linked to the outlet you are ordering from â€” please refresh and try again."
  ) as Error & { code: string; statusCode: number };
  err.code = "STOREFRONT_BRANCH_MISMATCH";
  err.statusCode = 409;
  return err;
}

/** A4: an outlet with no verified storefront link must never admit an order. */
export function storefrontLinkError(): Error & { code: string; statusCode: number } {
  const err = new Error(
    "This outlet isn't taking orders yet â€” please choose a live outlet."
  ) as Error & { code: string; statusCode: number };
  err.code = "STORE_NOT_LINKED";
  err.statusCode = 409;
  return err;
}

/** A storefront document the gate and every order path agree on (A4). */
export interface CanonicalStorefront {
  storeId: string;
  collection: "stores" | "admin_stores";
  data: Record<string, any>;
  /** The branch the storefront is linked to, when it records one. */
  branchId: string | null;
}

/**
 * The ONE verified resolver for the customer-facing storefront (A4).
 *
 * An explicit `storeId` is read directly (`stores` then `admin_stores`, the
 * customer directory's precedence) and REJECTED when the caller's `branchId`
 * disagrees with the document's own `partnerBranchId`. When only a branch is
 * named we delegate to `storeStatus.resolveStorefrontForBranch`, the same
 * resolver the staff open/close toggle uses â€” so the gate, the cash order and
 * the online intent all read the same document and can never disagree about
 * which close signal stops ordering.
 */
export async function resolveCanonicalStorefront(
  query: OutletStatusQuery,
  restId?: string | null,
  reader?: {get: (reference: any) => Promise<any>}
): Promise<CanonicalStorefront | null> {
  const storeId = typeof query.storeId === "string" ? query.storeId.trim() : "";
  const branchId = typeof query.branchId === "string" ? query.branchId.trim() : "";

  if (storeId) {
    for (const collection of ["stores", "admin_stores"] as const) {
      const ref = db.collection(collection).doc(storeId);
      const snap = reader ? await reader.get(ref) : await ref.get();
      if (!snap?.exists) continue;
      const data = (snap.data() || {}) as Record<string, any>;
      const linked = typeof data.partnerBranchId === "string" && data.partnerBranchId
        ? data.partnerBranchId
        : null;
      // A storefront that exists but carries NO verified branch link must not
      // admit an order: a missing link is not permission to order (A4).
      if (!linked) throw storefrontLinkError();
      if (branchId && linked && linked !== branchId) throw storefrontMismatchError();
      return { storeId, collection, data, branchId: linked };
    }
    throw storefrontLinkError();
  }
  if (branchId) {
    const { match, ambiguous } = await resolveStorefrontForBranch(branchId, restId ?? "", reader);
    if (ambiguous) throw storefrontMismatchError();
    if (!match) return null;
    return { storeId: match.storeId, collection: match.collection, data: match.data, branchId };
  }
  return null;
}

/**
 * Pure form of the gate for a storefront doc ALREADY read inside a caller's
 * transaction (cash create reads it for the branch link). Rejects a
 * storefront/branch mismatch and a closed outlet with the same typed codes the
 * async gate uses (A4).
 */
export function assertStorefrontOpenAndMatching(
  storefront: any,
  expectedStoreId: string | null,
  expectedBranchId: string | null
): void {
  if (!storefront || typeof storefront !== "object") return;
  const linked =
    typeof storefront.partnerBranchId === "string" && storefront.partnerBranchId
      ? storefront.partnerBranchId
      : null;
  if (expectedStoreId && typeof storefront.id === "string" && storefront.id &&
      storefront.id !== expectedStoreId) {
    throw storefrontMismatchError();
  }
  if (expectedBranchId && !linked) throw storefrontLinkError();
  if (expectedBranchId && linked !== expectedBranchId) throw storefrontMismatchError();
  if (isStorefrontOpen(storefront) === false) throw storeClosedError();
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
    const resolved = await resolveCanonicalStorefront(query, query.restId);
    // No storefront document means no close signal has been recorded (the
    // documented default). A storefront that EXISTS without a verified branch
    // link is already refused by resolveCanonicalStorefront (A4).
    if (!resolved) return null;
    return isStorefrontOpen(resolved.data);
  } catch (err: any) {
    // A genuine mismatch/close/missing-link is a typed decision, not a read
    // failure â€” pass it through so callers answer 409, not a misleading 503.
    if (
      err?.code === STORE_CLOSED ||
      err?.code === "STOREFRONT_BRANCH_MISMATCH" ||
      err?.code === "STORE_NOT_LINKED"
    ) throw err;
    console.warn("[OutletStatus] storefront read failed, refusing online order:", err?.message || err);
    throw unavailableError(err);
  }
}

/**
 * Refuses a NEW ONLINE CUSTOMER order for a closed outlet. No-op when the
 * outlet is open, or when no storefront document defines the state.
 */
export async function assertOutletOpenForOnlineOrders(
  query: OutletStatusQuery,
  reader?: {get: (reference:any)=>Promise<any>}
): Promise<CanonicalStorefront & {branchId:string}> {
  try {
    const store = await resolveCanonicalStorefront(query, query.restId, reader);
    // No storefront document is the documented "nothing closed" default. Keep
    // the caller's branch binding without inventing a link error.
    if (!store) {
      if (!query.branchId) throw storefrontLinkError();
      const branchRef = db.collection('branches').doc(query.branchId);
      const snap = reader ? await reader.get(branchRef) : await branchRef.get();
      if (staffCloseOverrideInForce(null,snap.data())) throw storeClosedError();
      return { storeId: "", collection: "stores", data: {}, branchId: query.branchId ?? "" };
    }
    if (!store.branchId) throw storefrontLinkError();
    const ref = db.collection("branches").doc(store.branchId);
    const branch = reader ? await reader.get(ref) : await ref.get();
    if (staffCloseOverrideInForce(store.data, branch.data()) || isStorefrontOpen(store.data) === false) throw storeClosedError();
    return {...store,branchId:store.branchId};
  } catch (err:any) {
    if (err?.statusCode === 409) throw err;
    throw unavailableError(err);
  }
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
