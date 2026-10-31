import * as admin from "firebase-admin";
import { db } from "./firebase";

/**
 * Transactional ownership gate for FCM token REGISTRATION (the register seam
 * of the Loop 120 device-token ownership pair; unregisterToken.ts mirrors it
 * for logout).
 *
 * The register route in index.ts previously merged device_tokens/{token}
 * with an unconditional `userId: uid`. That silently REBOUND a token owned by
 * another account (a push token is far from secret — it is a stranger's live
 * notification channel disappearing mid-flight), raced concurrent registers
 * with last-write-wins, and let anyone claim legacy ownerless docs. This seam
 * closes all three:
 *
 *   1. UNKNOWN token  -> claim: the ownership write, the metadata stamp, and
 *                        the caller's fcmTokens arrayUnion happen in ONE
 *                        transaction (TOCTOU-safe in real Firestore: the SDK
 *                        tracks the read doc version, so a concurrent register
 *                        that commits first forces this closure to re-execute
 *                        against the committed owner and refuse).
 *   2. FOREIGN owned  -> refuse with ZERO mutation (not even the caller's own
 *                        list is touched). The binding belongs to another
 *                        live account.
 *   3. OWNERLESS legacy doc (userId absent/non-string) -> refuse, fail-closed,
 *                        same as unregisterToken's stance; a post-gate warn
 *                        (deduped across transaction retries) makes the
 *                        backlog visible (docs amassed by the old unguarded
 *                        handler or pre-hardening clients).
 *   4. OWN token      -> idempotent refresh: the doc re-stamps
 *                        platform/appVersion/updatedAt, ownership unchanged,
 *                        the caller's list unconditionally re-secured via
 *                        arrayUnion.
 *
 * Stale-holder prune runs ONLY on the refreshed path (DS review of this run):
 * the arrayRemove of the token from OTHER accounts' fan-out lists requires
 * PROVEN, pre-existing ownership (this doc already named this caller before
 * the write). On a fresh claim the caller is self-granted; the sibling
 * contract's rule "an unowned string must never reach other users' lists"
 * applies to purges in exactly the same way, so a fresh claim never scans.
 * Historic stale lists naming an unclaimed token stay until their holders
 * re-register or the owner's lifecycle prunes them.
 *
 * The prune itself is a snapshot scan: docs found between the query and each
 * arrayRemove are removed untransactionally. If ownership legitimately moves
 * in that millisecond window, the new holder's list self-heals on its next
 * register. Accepted deliberately (same posture as the unregister holders
 * cleanup), so future editors do not fold the two phases into one — skipping
 * the scan on a refusal is what prevents registerToken becoming a push-DoS
 * primitive (a foreign refusal must not strip the real owner's list).
 *
 * Result asymmetry with unregisterToken is intentional: registration's
 * `success` means "you now hold this token" (refused = false → 409), while
 * logout's success is "desired end state reached" (always true). Say so if
 * harmonising later.
 *
 * Every warning strips the token (fixed log-only prefix, never the full
 * credential). Holder doc paths may appear in logs — identical to the
 * ratified unregisterToken.ts behavior.
 */

export type DeviceTokenRegisterOutcome =
  | "claimed"
  | "refreshed"
  | "refused_foreign"
  | "refused_ownerless";

export interface DeviceTokenRegisterResult {
  success: boolean;
  outcome: DeviceTokenRegisterOutcome;
  /** Stale OTHER-account fan-out lists pruned after a committed owner refresh. */
  prunedStaleHolders: number;
}

const HOLDERS_PAGE_LIMIT = 20;

function stripPrefix(token: string, seen = 8): string {
  return token.length <= seen ? token : `${token.slice(0, seen)}...`;
}

export async function registerDeviceToken(params: {
  token: string;
  uid: string;
  platform?: string;
  appVersion?: string | null;
}): Promise<DeviceTokenRegisterResult> {
  const { token, platform, appVersion } = params;
  const uid = params.uid;
  // Reusable core seam: a non-string uid must never reach the wire — legacy
  // docs with a non-string userId are permanently fail-closed, so writing one
  // would brick the token for every future caller, including the true owner.
  if (typeof uid !== "string" || uid.length === 0) {
    throw new Error("registerDeviceToken: authenticated uid is required");
  }

  /** The doc shape the route wrote since the endpoint existed — kept stable. */
  const claimDoc = (): Record<string, unknown> => ({
    token,
    userId: uid,
    platform: platform || "unknown",
    appVersion: appVersion ?? null,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  type Gate = "claimed" | "refreshed" | "foreign" | "ownerless";
  const gate: Gate = await db.runTransaction(async (tx: FirebaseFirestore.Transaction) => {
    const tokenRef = db.collection("device_tokens").doc(token);
    const snap = await tx.get(tokenRef);
    if (snap.exists) {
      const owner = ((snap.data() ?? {}) as { userId?: unknown }).userId;
      if (typeof owner !== "string") return "ownerless" as const;
      if (owner !== uid) return "foreign" as const;
      // Owner re-registering: idempotent metadata refresh, ownership intact.
      tx.set(tokenRef, claimDoc(), { merge: true });
      tx.set(
        db.collection("users").doc(uid),
        {
          fcmTokens: admin.firestore.FieldValue.arrayUnion(token),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      return "refreshed" as const;
    }
    // Fresh claim: ownership + metadata + caller list in the same transaction,
    // so two racing registers cannot both win (the loser re-executes against
    // the committed owner and refuses).
    tx.set(tokenRef, claimDoc(), { merge: true });
    tx.set(
      db.collection("users").doc(uid),
      {
        fcmTokens: admin.firestore.FieldValue.arrayUnion(token),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    return "claimed" as const;
  });

  if (gate === "ownerless") {
    // Warn lives OUTSIDE the closure: Firestore re-executes the closure under
    // contention, which would duplicate the log per retry.
    console.warn(
      `registerToken: token doc has no owner stored (${stripPrefix(token)}) - refusing automatic claim (fail-closed)`
    );
    return { success: false, outcome: "refused_ownerless", prunedStaleHolders: 0 };
  }
  if (gate === "foreign") {
    return { success: false, outcome: "refused_foreign", prunedStaleHolders: 0 };
  }

  // Prune is proven-ownership-only (see header): a fresh claim has no
  // pre-existing ownership to purge another account's list by.
  const prunedStaleHolders = gate === "refreshed" ? await pruneStaleHolders(token, uid) : 0;
  return {
    success: true,
    outcome: gate === "claimed" ? "claimed" : "refreshed",
    prunedStaleHolders,
  };
}

/**
 * Route-level response mapping, exported so the exact wire contract
 * (200 body, refusal bodies and codes) is pinned by the seam's unit tests
 * without importing the whole index.ts app. The refusal body is ONE generic
 * message: register cannot be fully oracle-free (200 vs 409 is inherent),
 * but the live-on-another-account vs ownerless-legacy distinction buys the
 * caller nothing and would leak token state — the detail is distinguishable
 * only in server logs (the ownerless warn above).
 */
export function httpResponseFor(
  result: DeviceTokenRegisterResult
): { status: number; body: Record<string, unknown> } {
  if (result.success) {
    return { status: 200, body: { success: true } };
  }
  return {
    status: 409,
    body: { error: "device token cannot be registered by this account" },
  };
}

/**
 * Bounded best-effort scrub of OTHER accounts' fan-out lists naming this
 * token (the mirror image of unregisterToken's holders cleanup, gated on
 * proven ownership by the caller above). The caller's own doc is explicitly
 * excluded; failures warn and never fail registration.
 */
async function pruneStaleHolders(token: string, uid: string): Promise<number> {
  const holders = await db
    .collection("users")
    .where("fcmTokens", "array-contains", token)
    .limit(HOLDERS_PAGE_LIMIT)
    .get()
    .catch((err: unknown) => {
      const code =
        (err as { code?: string | number })?.code ??
        (err as { message?: string })?.message ??
        "unknown";
      console.warn(
        `registerToken: holders query failed (${String(code)}) - stale lists stay until their own re-register prunes them`
      );
      return null;
    });
  if (holders === null) return 0;
  if (holders.size >= HOLDERS_PAGE_LIMIT) {
    console.warn(
      `registerToken: holders fan-out hit the ${HOLDERS_PAGE_LIMIT}-doc cap (${stripPrefix(token)}) - older profiles may keep the pointer`
    );
  }

  let pruned = 0;
  for (const d of holders.docs) {
    if (d.id === uid) continue; // the owner's own list is the intended holder
    try {
      await d.ref.update({
        fcmTokens: admin.firestore.FieldValue.arrayRemove(token),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      pruned += 1;
    } catch (err: unknown) {
      const code =
        (err as { code?: string | number })?.code ??
        (err as { message?: string })?.message ??
        "unknown";
      console.warn(`registerToken: holder scrub failed for ${d.ref.path} (${String(code)})`);
    }
  }
  return pruned;
}
