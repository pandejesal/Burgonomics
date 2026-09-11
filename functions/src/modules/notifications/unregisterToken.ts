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
 */
export async function unregisterDeviceToken(params: {
  token: string;
  uid?: string;
}): Promise<{ success: boolean; removedFromUsers: number }> {
  const { token, uid } = params;
  let removedFromUsers = 0;

  const tokenRef = db.collection("device_tokens").doc(token);
  const tokenSnap = await tokenRef.get();
  if (tokenSnap.exists) {
    await tokenRef.delete();
  }

  const refs = new Map<string, FirebaseFirestore.DocumentReference>();
  if (uid) {
    refs.set(`users/${uid}`, db.collection("users").doc(uid));
  }
  const holders = await db
    .collection("users")
    .where("fcmTokens", "array-contains", token)
    .limit(20)
    .get();
  holders.forEach((d: any) => refs.set(d.ref.path, d.ref));

  for (const ref of refs.values()) {
    try {
      await ref.update({
        fcmTokens: admin.firestore.FieldValue.arrayRemove(token),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      removedFromUsers += 1;
    } catch {
      // Best-effort per doc: one locked/missing profile must not fail logout.
    }
  }

  return { success: true, removedFromUsers };
}
