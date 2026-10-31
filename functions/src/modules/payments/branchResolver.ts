import { db } from "../../core/firebase";

export interface BranchResolutionInput {
  branchId?: string;
  storeId?: string;
}

/**
 * Resolves the branch for pricing, transfers, and KOT routing. Explicit
 * `branchId` wins; otherwise the delivery store record's linked branch.
 *
 * Shared by `createPaymentOrder` and `POST /checkout/fees` (R5: "resolve the
 * branch the same way"), so the fee the client is shown is quoted for exactly
 * the branch the order will be priced against.
 */
export async function resolveBranchId(params: BranchResolutionInput): Promise<string> {
  if (params.branchId) return params.branchId;
  if (params.storeId && db && typeof db.collection === "function") {
    let snap: any;
    try {
      snap = await db.collection("stores").doc(params.storeId).get();
    } catch (err) {
      // A failed READ is transient; it must never be reported as "unlinked".
      console.warn("[Payments] store→branch resolution failed:", (err as any)?.message || err);
      const unavailable: any = new Error(
        "We couldn't check this outlet just now — please retry.",
      );
      unavailable.statusCode = 503;
      unavailable.code = "STORE_LOOKUP_UNAVAILABLE";
      throw unavailable;
    }
    const linked = snap && snap.exists ? (snap.data() as any)?.partnerBranchId : undefined;
    if (typeof linked === "string" && linked) return linked;
  }
  const notLinked: any = new Error("This outlet isn't taking online orders yet.");
  notLinked.statusCode = 409;
  notLinked.code = "STORE_NOT_LINKED";
  throw notLinked;
}
