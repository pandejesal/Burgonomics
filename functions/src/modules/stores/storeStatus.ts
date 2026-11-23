import * as admin from "firebase-admin";
import { db } from "../../core/firebase";
import { assertBranchAccess, type StaffCaller } from "../../core/middleware";

/**
 * Staff open/close for an outlet — owner rule C (fix wave 2026-11-20).
 *
 * TWO documents matter and only one of them stops ordering:
 *
 *   `branches/{id}.acceptingOrdersStatus` — what operators read. Not a gate;
 *   no ordering path consults it.
 *
 *   `stores/{id}.isOpen` (or `admin_stores/{id}.isOpen` where the customer
 *   directory falls back to that collection) — the gate
 *   `storesService.mapStoreDoc` surfaces and `PaymentRepository` refuses to
 *   open the gateway for.
 *
 * Firestore rules deny branch roles that gate: `stores/{id}` is brand-owner
 * only, and the `admin_stores` branch arm allows eight metadata keys (`isOpen`
 * is not among them). A client-side save can therefore only move the branch
 * flag — which is exactly the reported bug where staff "closed" the outlet and
 * customers kept ordering. This route is the only honest path.
 *
 * PRECEDENCE (rule C): a staff close stamps `storeStatusOverride: true`, and a
 * Petpooja "open" is refused while it is set. Only a staff reopen clears it;
 * from then on the POS owns open/closed again (rule A).
 */

export interface StorefrontMatch {
  storeId: string;
  /** Which collection the doc lives in: that is the doc the customers read. */
  collection: "stores" | "admin_stores";
  data: Record<string, any>;
}

/**
 * Finds the storefront document(s) for an outlet.
 *
 * `stores/*` is authoritative; the customer directory falls back to
 * `admin_stores/*` when `stores` is empty, so an outlet whose entry is
 * `admin_stores`-only is NOT "unlinked". `stores` wins when both exist.
 *
 * Ambiguity (two docs in the SAME collection claiming the branch) is reported,
 * never guessed: closing the wrong outlet is worse than a failed call.
 */
export async function resolveStorefrontForBranch(
  branchId: string,
  restId: string,
  reader?: {get: (reference: any) => Promise<any>}
): Promise<{ match: StorefrontMatch | null; ambiguous: boolean }> {
  for (const collection of ["stores", "admin_stores"] as const) {
    const col = db.collection(collection) as any;
    if (!col || typeof col.where !== "function") continue;

    const seen = new Map<string, StorefrontMatch>();
    for (const [field, value] of [
      ["partnerBranchId", branchId],
      ["petpoojaRestId", restId],
    ] as Array<[string, string]>) {
      if (!value) continue;
      try {
        const query = col.where(field, "==", value).limit(5);
        const snap = reader ? await reader.get(query) : await query.get();
        for (const doc of snap?.docs || []) {
          if (!doc?.id) continue;
          seen.set(String(doc.id), {
            storeId: String(doc.id),
            collection,
            data: doc.data() || {},
          });
        }
      } catch (err: any) {
        console.warn(
          `[Store Status] storefront lookup in ${collection} by ${field} failed:`,
          err?.message || err
        );
        throw err;
      }
    }
    if (seen.size > 1) return { match: null, ambiguous: true };
    if (seen.size === 1) return { match: [...seen.values()][0], ambiguous: false };
  }
  return { match: null, ambiguous: false };
}

/**
 * Is a staff close still in force? `storeStatusOverride` is stamped by
 * `setStaffStoreStatus` on both the storefront and the branch, and cleared
 * only by a staff reopen.
 */
export function staffCloseOverrideInForce(
  storefront: any,
  branch: any
): boolean {
  const store = storefront && typeof storefront === "object" ? storefront : null;
  const br = branch && typeof branch === "object" ? branch : null;
  return store?.storeStatusOverride === true || br?.storeStatusOverride === true;
}

export interface SetStaffStoreStatusInput {
  branchId: string;
  status: "open" | "closed";
  reason?: string;
  caller: StaffCaller | undefined;
}

export interface SetStaffStoreStatusResult {
  success: true;
  branchId: string;
  status: "open" | "closed";
  storeId: string;
  storeStatusOverride: boolean;
}

/**
 * Writes the customer gate + override for a staff open/close.
 *
 * Resolves the storefront BEFORE any write, so an unlinked or ambiguous outlet
 * fails cleanly instead of half-applying the branch flag. Throws on refusal —
 * the route maps the message to 401/403/409 — because a silent success here is
 * the very bug this fixes.
 */
export async function setStaffStoreStatus(
  input: SetStaffStoreStatusInput
): Promise<SetStaffStoreStatusResult> {
  const { branchId, status, reason, caller } = input;

  // Only roles allowed to manage that branch may flip it. Brand admins pass
  // by design (the console legitimately manages every outlet).
  assertBranchAccess(caller, branchId);

  const branchRef = db.collection("branches").doc(branchId);
  const branchSnap = await branchRef.get();
  const branchData = branchSnap?.exists ? branchSnap.data() || {} : {};
  const restId =
    typeof branchData.petpoojaStoreId === "string" ? branchData.petpoojaStoreId : "";

  const resolved = await resolveStorefrontForBranch(branchId, restId);
  if (resolved.ambiguous) {
    throw new Error(
      "This outlet resolves to more than one storefront — nothing was saved. Ask a brand admin to fix the store links."
    );
  }
  if (!resolved.match) {
    throw new Error(
      "This outlet is not linked to a storefront — nothing was saved. Customers are served from the store directory, so there is no gate to open or close."
    );
  }

  const storefront = resolved.match;
  const desiredOpen = status === "open";
  // A staff reopen is the ONLY thing that releases the POS again (rule C).
  const override = !desiredOpen;
  const boundedReason =
    typeof reason === "string" && reason.trim() ? reason.trim().slice(0, 500) : null;

  const storeRef = db.collection(storefront.collection).doc(storefront.storeId);
  await storeRef.set(
    {
      isOpen: desiredOpen,
      storeStatusSource: "manual",
      storeStatusOverride: override,
      storeStatusReason: boundedReason,
      storeStatusUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  // The flag operators read on the outlet screens — kept in step so a stale
  // "open" there can never be what a human trusts over the real gate.
  await branchRef.set(
    {
      acceptingOrdersStatus: status,
      active: desiredOpen ? true : branchData.active === false ? false : true,
      storeStatusSource: "manual",
      storeStatusOverride: override,
      storeStatusReason: boundedReason,
      storeStatusUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  // The Partner directory mirror, when one exists. Only an EXISTING doc is
  // touched: creating a partial `admin_stores` record from a status flip would
  // fabricate a directory entry the operator never created.
  if (storefront.collection !== "admin_stores") {
    try {
      const adminRef = db.collection("admin_stores").doc(storefront.storeId);
      const adminSnap = await adminRef.get();
      if (adminSnap?.exists) {
        await adminRef.set(
          {
            isOpen: desiredOpen,
            storeStatusSource: "manual",
            storeStatusOverride: override,
            storeStatusUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
      }
    } catch (err: any) {
      // Mirror only: the gate write above is what stops ordering.
      console.warn(
        `[Store Status] admin_stores mirror update failed for ${storefront.storeId}:`,
        err?.message || err
      );
    }
  }

  return {
    success: true,
    branchId,
    status,
    storeId: storefront.storeId,
    storeStatusOverride: override,
  };
}
