import { db } from "../../core/firebase";
import * as admin from "firebase-admin";

/**
 * Cleanup worker that purges stale guest carts older than 7 days.
 */
export async function cleanupExpiredGuestSessionsWorker(): Promise<{
  cleanedCartsCount: number;
}> {
  const sevenDaysAgo = admin.firestore.Timestamp.fromMillis(
    Date.now() - 7 * 24 * 60 * 60 * 1000
  );

  let cleanedCartsCount = 0;

  try {
    const staleCartsSnap = await db
      .collection("carts")
      .where("updatedAt", "<", sevenDaysAgo)
      .limit(100)
      .get();

    if (!staleCartsSnap.empty) {
      const batch = db.batch();
      staleCartsSnap.docs.forEach((doc: any) => {
        // Only purge guest / anonymous cart records
        if (doc.id.startsWith("guest_") || doc.id.startsWith("anon_")) {
          batch.delete(doc.ref);
          cleanedCartsCount++;
        }
      });
      await batch.commit();
    }
  } catch (err) {
    console.warn("[Auth Cleanup Worker] Error cleaning expired guest sessions:", (err as any)?.message || err);
  }

  return { cleanedCartsCount };
}

/**
 * Cleans up user-related state upon user account deletion. Wired as a real
 * Auth blocking trigger (beforeUserDeleted) in index.ts — previously dead
 * code that never ran.
 */
export async function onUserDeletedCleanup(uid: string): Promise<boolean> {
  if (!uid) return false;

  try {
    // Belt-and-braces: deletion destroys Auth tokens, but revoke anyway in
    // case this ever runs pre-deletion.
    try {
      const { auth } = await import("../../core/firebase");
      await auth.revokeRefreshTokens(uid);
    } catch {
      // User already gone — the point of this trigger.
    }

    const batch = db.batch();

    // 1. Delete active cart
    const cartRef = db.collection("carts").doc(uid);
    batch.delete(cartRef);

    // 2. Delete the admins-registry doc — otherwise requireRole()'s fallback
    // keeps treating the deleted account as staff if the UID is ever reused.
    batch.delete(db.collection("admins").doc(uid));

    // 3. Mark user document deleted AND strip PII (phone/email/name/
    // addresses). Order history keeps customerId for accounting; the person
    // must not remain identifiable in the profile doc.
    const userRef = db.collection("users").doc(uid);
    batch.set(
      userRef,
      {
        active: false,
        isDeleted: true,
        phone: admin.firestore.FieldValue.delete(),
        email: admin.firestore.FieldValue.delete(),
        name: "Deleted User",
        addresses: [],
        role: "customer",
        branchIds: [],
        cityIds: [],
        deletedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    await batch.commit();
    return true;
  } catch (err) {
    console.warn(`[Auth Cleanup] Error cleaning up deleted user ${uid}:`, (err as any)?.message || err);
    return false;
  }
}
