import * as admin from "firebase-admin";
import { db } from "../../core/firebase";

/**
 * SEC-11 (A3 finding 1): the branch document used to carry its POS/payment
 * identifiers directly.
 *
 * `firestore.rules` admits `branches/*` reads to EVERY operator role
 * (`isStaff()`), because the Partner app renders the outlet directory, the
 * dispatch quote pickup pin and the settlement branch list from it. Firestore
 * rules cannot mask individual fields, so any secret left on `branches` is
 * readable by any active `branch_staff` in any outlet. The payment/POS
 * identifiers therefore move to `branch_secrets/{branchId}`, which is
 * brand-only (rules: `allow read, write: if isBrandOwner()`).
 *
 * What counts as a secret (and is therefore NEVER valid on `branches`):
 *   - `petpooja`            the vendor credential map (appKey/appSecret/accessToken/restId)
 *   - `petpoojaStoreId`     the outlet binding a KOT/cancel is addressed to
 *   - `restIDs`             the legacy outlet id list
 *   - `razorpayAccountId`   RETIRED: Razorpay Route per-order transfers are gone
 *                           (`routeTransfers.attemptRouteTransfer` is a stub and
 *                           `src/` has no reader), so this is dropped rather
 *                           than moved. The key is still stripped so a legacy
 *                           write cannot re-plant it.
 *
 * Nothing in this module is dev-only: every branch read on the KOT, cancel,
 * menu-sync, stock and store-status paths goes through it, so a missing secret
 * doc is a configuration refusal (callers already fail closed on a missing
 * `petpoojaStoreId`), never a silent wrong-outlet send.
 */

export const BRANCH_SECRETS = "branch_secrets";

/** Keys that must never be present on a `branches/*` document. */
export const BRANCH_SECRET_FIELDS = [
  "petpooja",
  "petpoojaStoreId",
  "restIDs",
  "razorpayAccountId",
] as const;

/**
 * Keys MOVED into `branch_secrets` (the union with the dropped
 * `razorpayAccountId` above is what the mirror trigger strips).
 */
export const BRANCH_SECRET_FIELDS_MOVED = ["petpooja", "petpoojaStoreId", "restIDs"] as const;

export interface BranchSecrets {
  petpoojaStoreId: string;
  /** The vendor credential map, exactly as stored (never logged). */
  petpooja: Record<string, unknown> | null;
  restIDs: unknown[] | null;
  /** Where the answer came from, for logs and migration evidence. */
  source: "branch_secrets" | "branches_legacy" | "none";
}

const EMPTY: BranchSecrets = {
  petpoojaStoreId: "",
  petpooja: null,
  restIDs: null,
  source: "none",
};

function normalise(data: any): BranchSecrets {
  if (!data || typeof data !== "object") return { ...EMPTY };
  const storeId =
    typeof data.petpoojaStoreId === "string" ? data.petpoojaStoreId.trim() : "";
  return {
    petpoojaStoreId: storeId,
    petpooja:
      data.petpooja && typeof data.petpooja === "object" ? (data.petpooja as any) : null,
    restIDs: Array.isArray(data.restIDs) ? (data.restIDs as unknown[]) : null,
    source: "none",
  };
}

function hasAnySecret(data: any): boolean {
  if (!data || typeof data !== "object") return false;
  return BRANCH_SECRET_FIELDS.some((key) => key in data);
}

/**
 * Reads a branch's POS/payment identifiers.
 *
 * Order: `branch_secrets/{branchId}` first (the canonical home), then the
 * legacy copy still on `branches/{branchId}` for documents the migration has
 * not reached yet. A read failure on the canonical doc falls through to the
 * legacy copy; a failure on both returns `source: "none"` and callers refuse
 * (they already do for an unlinked outlet).
 */
export async function loadBranchSecrets(branchId: string): Promise<BranchSecrets> {
  if (!branchId || typeof branchId !== "string") return { ...EMPTY };

  try {
    const snap = await db.collection(BRANCH_SECRETS).doc(branchId).get();
    if (snap?.exists) {
      const parsed = normalise(snap.data());
      if (parsed.petpoojaStoreId) return { ...parsed, source: "branch_secrets" };
      // Present but empty: still the canonical doc; fall through to legacy so a
      // half-written mirror cannot unlink a live outlet.
    }
  } catch (err: any) {
    console.warn(
      `[BranchSecrets] canonical read failed for ${branchId}:`,
      err?.message || err
    );
  }

  try {
    const snap = await db.collection("branches").doc(branchId).get();
    const data = snap?.exists ? snap.data() : null;
    if (!hasAnySecret(data)) return { ...EMPTY };
    const parsed = normalise(data);
    return parsed.petpoojaStoreId ? { ...parsed, source: "branches_legacy" } : { ...EMPTY };
  } catch (err: any) {
    console.warn(`[BranchSecrets] legacy read failed for ${branchId}:`, err?.message || err);
    return { ...EMPTY };
  }
}

/** Just the outlet binding every KOT/cancel/menu path needs. */
export async function loadPetpoojaStoreId(branchId: string): Promise<string> {
  return (await loadBranchSecrets(branchId)).petpoojaStoreId;
}

/**
 * Reverse lookup: Petpooja identifies outlets by restID, we key everything by
 * branchId. Canonical source is `branch_secrets.petpoojaStoreId`; the legacy
 * `branches.petpoojaStoreId` field is still searched while the migration is
 * unapplied. Both are indexed single-field equality queries (limit 1).
 */
export async function findBranchIdByPetpoojaStoreId(restId: string): Promise<string | null> {
  const wanted = typeof restId === "string" ? restId.trim() : "";
  if (!wanted) return null;

  for (const collection of [BRANCH_SECRETS, "branches"] as const) {
    try {
      const col = db.collection(collection) as any;
      if (typeof col?.where !== "function") continue;
      const snap = await col.where("petpoojaStoreId", "==", wanted).limit(1).get();
      const docs = snap?.docs || [];
      if (docs.length > 0 && docs[0]?.id) return String(docs[0].id);
    } catch (err: any) {
      console.warn(
        `[BranchSecrets] reverse lookup failed in ${collection} for rest ${wanted}:`,
        err?.message || err
      );
    }
  }
  return null;
}

/** The secret half of a branch document, for the mirror trigger and migration. */
export function extractBranchSecrets(data: any): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!data || typeof data !== "object") return out;
  for (const key of BRANCH_SECRET_FIELDS_MOVED) {
    if (data[key] !== undefined) out[key] = data[key];
  }
  return out;
}

/** FieldValue.delete() for every secret key present on the document. */
export function branchSecretStripPatch(data: any): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!data || typeof data !== "object") return out;
  for (const key of BRANCH_SECRET_FIELDS) {
    if (key in data) out[key] = admin.firestore.FieldValue.delete();
  }
  return out;
}

/**
 * MIRROR + STRIP, run on every `branches/{branchId}` write.
 *
 * A legacy client (an older Partner build, an ops script, a console paste)
 * can still write `petpoojaStoreId`/`petpooja` straight onto the branch. The
 * rules already refuse those keys, so this trigger is the SAFETY NET for
 * documents and callers that predate the rule: it copies the moved fields onto
 * `branch_secrets` and deletes them from the branch doc. It terminates after
 * one pass because the second write has no secret keys left.
 *
 * `razorpayAccountId` is stripped and NOT copied (retired, no reader).
 */
export async function mirrorAndStripBranchSecrets(
  branchId: string,
  before: any,
  after: any
): Promise<{ mirrored: string[]; stripped: string[] }> {
  const carried = extractBranchSecrets(after);
  const mirrored = Object.keys(carried);
  if (mirrored.length > 0) {
    await db
      .collection(BRANCH_SECRETS)
      .doc(branchId)
      .set(
        {
          ...carried,
          branchId,
          mirroredAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
  }

  const strip = branchSecretStripPatch(after);
  const stripped = Object.keys(strip);
  if (stripped.length > 0) {
    await db.collection("branches").doc(branchId).update(strip);
  }

  // A delete of the branch retires its secrets too (nothing else can read
  // them once the branch is gone, and keeping them would outlive the outlet).
  if (before && !after) {
    try {
      await db.collection(BRANCH_SECRETS).doc(branchId).delete();
    } catch (err: any) {
      console.warn(
        `[BranchSecrets] could not retire secrets for deleted branch ${branchId}:`,
        err?.message || err
      );
    }
  }

  return { mirrored, stripped };
}
