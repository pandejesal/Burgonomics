import * as admin from "firebase-admin";
import { db } from "../../core/firebase";

/**
 * Detaches a device token on logout (Loop 37/120).
 *
 * The client-side unlink this replaces wrote device_tokens directly, which
 * rules ALWAYS deny (server-owned collection) — so logged-out devices kept
 * their token identity and any fan-out list membership. This endpoint runs
 * the same detach via Admin SDK while the caller is still authenticated
 * (clients must call it BEFORE signing out):
 *   1. delete device_tokens/{token} (kills the token identity + any
 *      ownership binding a future user would inherit), and
 *   2. arrayRemove the token from every users doc still listing it
 *      (bounded fan-out cleanup, 20 docs max).
 * Unknown tokens succeed silently (idempotent logout path — a missing doc
 * is already the desired end state).
 *
 * Loop120 ownership hardening (fresh-team DS-review resolved):
 *   - AUTHENTICITY: the stored doc owner (userId) must equal the
 *     authenticated caller uid for the delete AND the holders fan-out
 *     scrub. The read-check-delete runs in ONE transaction so a concurrent
 *     re registration cannot race a stale ownership decision past the gate
 *     (TOCTOU). If the transaction observes a foreign/unowned doc, nothing
 *     is deleted and the holders scan never runs.
 *   - ORACLE-FREE non-owner response: every path the caller cannot prove
 *     ownership of answers the SAME body { success: true,
 *     removedFromUsers: 0 }. In particular the caller's own profile scrub
 *     on unknown-token paths is deliberately NOT counted, so the count can
 *     never distinguish "token unknown" from "token registered to someone
 *     else". (GLM verify note: the unknown/ownerless self-scrub write vs
 *     the foreign zero-write path remains a mandated low-signal LATENCY
 *     asymmetry - accepted in the ratified contract; no body-level oracle
 *     exists.)
 *   - UNKNOWN token: the identity cannot be proven, so the holders query is
 *     skipped entirely — no other user's list may be purged on the strength
 *     of an unowned string. The caller's own profile IS still scrubbed
 *     (self-service logout), it is just not surfaced in the count.
 *   - Legacy ownerless docs (no userId) are fail-closed: no caller can
 *     destroy them; a distinct warning makes the backlog visible without
 *     echoing the token (store-only prefix, no full-token logging).
 *   - REBIND RACE (close-out): the delete and the holders scrub are two
 *     transactions. The scrub transaction re-reads device_tokens/{token}
 *     first: a token that was re-registered between the delete and the scrub
 *     makes the scrub a no-op (warn), so a new owner's fresh list membership
 *     can never be arrayRemove'd by the previous owner's logout. No claim is
 *     made that writes outside these two transactions are protected.
 *   - Holder scrub failures remain best-effort (logout must never fail):
 *     a holders-query failure or transaction failure after the delete is
 *     warn-logged and the call still answers the constant body. Holder docs
 *     returned by the array-contains query exist by construction, so
 *     concurrent deletion retries the transaction rather than failing it.
 */
const HOLDERS_PAGE_LIMIT = 20;

function stripPrefix(token: string, seen = 8): string {
  return token.length <= seen ? token : `${token.slice(0, seen)}...`;
}

export async function unregisterDeviceToken(params: {
  token: string;
  uid?: string;
}): Promise<{ success: boolean; removedFromUsers: number }> {
  const { token, uid } = params;

  const tokenRef = db.collection("device_tokens").doc(token);

  // Atomic ownership gate: compare stored owner != uid BEFORE the delete,
  // inside the same transaction that performs the delete. A token doc being
  // re-registered concurrently flips the in-transaction snapshot, not a
  // stale pre-read.
  type Gate = "deleted" | "unknown" | "foreign" | "ownerless";
  const gate: Gate = await db.runTransaction(async (tx: FirebaseFirestore.Transaction) => {
    const snap = await tx.get(tokenRef);
    if (!snap.exists) return "unknown" as const;
    const owner = ((snap.data() ?? {}) as { userId?: string }).userId;
    if (typeof owner !== "string") {
      console.warn(`unregisterToken: token doc has no owner stored (${stripPrefix(token)}) - fail-closed, no caller may detach it until it is re-registered`);
      return "ownerless" as const;
    }
    if (!uid || owner !== uid) return "foreign" as const;
    tx.delete(tokenRef);
    return "deleted" as const;
  });

  if (gate === "deleted") {
    // Bounded holders cleanup — ONLY under a transaction-confirmed
    // ownership. An unowned string must never reach other users' lists.
    //
    // REBIND RACE (Loop120 close-out): the scrub used to run as unprotected
    // writes AFTER this transaction. A concurrent register that rebound the
    // token to a new account between the delete and the scrub had its fresh
    // users-list membership arrayRemove'd again. The scrub therefore runs in
    // ITS OWN transaction that FIRST re-reads device_tokens/{token}:
    //   - token doc exists again  -> a rebind won the race; skip the scrub
    //     wholesale (warning). Stale holders keep the token until an owner
    //     refresh prunes their list: registerDeviceToken only scans on its
    //     refreshed path, so a fresh claim does not clean them itself,
    //   - concurrent holder mutations -> Firestore retries the transaction
    //     instead of writing through a stale snapshot.
    // Nothing is claimed about writes outside these transactions: the delete
    // and the scrub are two commits, and the rebind-skip is what keeps the
    // window closed semantically (a rebind lands either before the re-read —
    // scrub skipped — or after the scrub commit — untouched by it).
    // Scrub failures stay best-effort: a transient holders-scan failure must
    // not 500 a logout AFTER the token identity was already destroyed.
    let removedFromUsers = 0;
    try {
      removedFromUsers = await db.runTransaction(async (tx: FirebaseFirestore.Transaction) => {
        const rebind = await tx.get(tokenRef);
        if (rebind.exists) {
          console.warn(`unregisterToken: token re-registered during detach (${stripPrefix(token)}) - holders scrub skipped, stale lists prune on the next owner refresh`);
          return 0;
        }
        const holders = await tx
          .get(
            db
              .collection("users")
              .where("fcmTokens", "array-contains", token)
              .limit(HOLDERS_PAGE_LIMIT),
          );
        if (holders.size >= HOLDERS_PAGE_LIMIT) {
          console.warn(`unregisterToken: holders fan-out hit the ${HOLDERS_PAGE_LIMIT}-doc cap (${stripPrefix(token)}) - older profiles may retain the expired token until re-registration prunes them`);
        }
        for (const d of holders.docs) {
          tx.update(d.ref, {
            fcmTokens: admin.firestore.FieldValue.arrayRemove(token),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        }
        return holders.size;
      });
    } catch (err: unknown) {
      const code = (err as { code?: string | number; message?: string })?.code ??
        (err as { message?: string })?.message ?? "unknown";
      console.warn(`unregisterToken: holders scrub failed after token delete (${String(code)}) - logout continues`);
      return { success: true, removedFromUsers: 0 };
    }
    return { success: true, removedFromUsers };
  }

  // Non-owner paths: constant caller-visible response — no existence
  // oracle. The only permissive act is a self-service scrub of the
  // caller's OWN profile on paths where the token identity cannot be
  // proven (unknown token / legacy ownerless doc), deliberately excluded
  // from the returned count so ownership state stays indistinguishable.
  // The foreign-registered path mutates NOTHING (not even the caller's own
  // doc): the binding belongs to another live account and the registered
  // doc itself is the store of truth the owner re-claims at next register.
  if (uid && (gate === "unknown" || gate === "ownerless")) {
    try {
      await db
        .collection("users")
        .doc(uid)
        .update({
          fcmTokens: admin.firestore.FieldValue.arrayRemove(token),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
    } catch (err: unknown) {
      const code = (err as { code?: string | number; message?: string })?.code ??
        (err as { message?: string })?.message ?? "unknown";
      console.warn(`unregisterToken: self-service scrub skipped for ${uid} (${String(code)})`);
    }
  }

  return { success: true, removedFromUsers: 0 };
}
