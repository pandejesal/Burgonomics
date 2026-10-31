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
    // Oldest-stale-first (single-field range + same-field orderBy needs no
    // composite). Window raised to the 500-write batch ceiling so a large
    // backlog drains instead of re-cleaning the same head each tick.
    const staleCartsSnap = await db
      .collection("carts")
      .where("updatedAt", "<", sevenDaysAgo)
      .orderBy("updatedAt", "asc")
      .limit(500)
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
 * Deletes a document and everything beneath it. Production uses the Admin
 * SDK's recursive delete; the shim fallback removes subcollection documents
 * first, then the document itself.
 */
async function purgeDocumentTree(ref: any): Promise<void> {
  if (typeof (db as any).recursiveDelete === "function") {
    await (db as any).recursiveDelete(ref);
    return;
  }
  if (typeof ref.listCollections === "function") {
    for (const collection of await ref.listCollections()) {
      const snap = await collection.get();
      const batch = db.batch();
      for (const doc of snap.docs || []) batch.delete(doc.ref);
      await batch.commit();
    }
  }
  await ref.delete();
}

/**
 * Purges every subcollection under a document that itself is retained (the
 * sanitized `users/{uid}` profile). Guarded per collection so one failure does
 * not abort the rest.
 */
async function purgeSubcollections(parentRef: any, label: string): Promise<boolean> {
  if (typeof parentRef.listCollections !== "function") return true;
  let collections: any[] = [];
  try {
    collections = await parentRef.listCollections();
  } catch (err: any) {
    console.warn(`[Auth Cleanup] cannot list subcollections of ${label}:`, err?.message || err);
    return false;
  }
  let ok = true;
  for (const collection of collections) {
    try {
      if (typeof (db as any).recursiveDelete === "function") {
        await (db as any).recursiveDelete(collection);
      } else {
        const snap = await collection.get();
        const batch = db.batch();
        for (const doc of snap.docs || []) batch.delete(doc.ref);
        await batch.commit();
      }
    } catch (err: any) {
      ok = false;
      console.warn(
        `[Auth Cleanup] cannot delete subcollection ${collection?.path || "(unknown)"} of ${label}:`,
        err?.message || err
      );
    }
  }
  return ok;
}

/** Removes the device-token identity docs bound to a deleted account. */
async function deleteDeviceTokensForUser(uid: string): Promise<boolean> {
  try {
    const snap = await db.collection("device_tokens").where("userId", "==", uid).get();
    let ok = true;
    for (const doc of snap.docs || []) {
      try {
        await doc.ref.delete();
      } catch (err: any) {
        ok = false;
        console.warn(
          `[Auth Cleanup] cannot delete device token ${doc.id}:`,
          err?.message || err
        );
      }
    }
    return ok;
  } catch (err: any) {
    console.warn(`[Auth Cleanup] device token lookup failed for ${uid}:`, err?.message || err);
    return false;
  }
}

/**
 * Cleans up user-related state upon user account deletion. Wired as the
 * `functionsV1.auth.user().onDelete` trigger in index.ts (post-deletion) —
 * previously dead code that never ran.
 *
 * SEC-02: erasure now covers the customer profile and its subcollections,
 * the retained user profile's subcollections, and the account's device tokens.
 * Order documents are deliberately retained for tax/accounting and live in the
 * top-level `orders` collection, which this never touches. Every step is
 * independently guarded: a partial failure is logged and the remaining deletes
 * still run.
 */
export async function onUserDeletedCleanup(uid: string): Promise<boolean> {
  if (!uid) return false;

  let ok = true;

  // Belt-and-braces: deletion destroys Auth tokens, but revoke anyway in
  // case this ever runs pre-deletion.
  try {
    const { auth } = await import("../../core/firebase");
    await auth.revokeRefreshTokens(uid);
  } catch {
    // User already gone — the point of this trigger.
  }

  try {
    const batch = db.batch();

    // 1. Delete active cart
    const cartRef = db.collection("carts").doc(uid);
    batch.delete(cartRef);

    // 2. Delete the admins-registry doc — otherwise requireRole()'s fallback
    // keeps treating the deleted account as staff if the UID is ever reused.
    batch.delete(db.collection("admins").doc(uid));

    // 3. Mark user document deleted AND strip PII (phone/email/name/
    // addresses/fcmTokens). Order history keeps customerId for accounting; the
    // person must not remain identifiable in the profile doc.
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
        fcmTokens: admin.firestore.FieldValue.delete(),
        role: "customer",
        branchIds: [],
        cityIds: [],
        deletedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    await batch.commit();
  } catch (err: any) {
    ok = false;
    console.warn(`[Auth Cleanup] Error cleaning up deleted user ${uid}:`, (err as any)?.message || err);
  }

  // 4. Device tokens: stop push delivery to the deleted account.
  if (!(await deleteDeviceTokensForUser(uid))) ok = false;

  // 5. Customer profile + its PII (addresses live in subcollections too).
  try {
    await purgeDocumentTree(db.collection("customers").doc(uid));
  } catch (err: any) {
    ok = false;
    console.warn(
      `[Auth Cleanup] Error deleting customer profile ${uid}:`,
      (err as any)?.message || err
    );
  }

  // 6. The retained user profile keeps its subcollections nowhere — purge
  // addresses/notifications while keeping the sanitized parent doc.
  if (!(await purgeSubcollections(db.collection("users").doc(uid), `users/${uid}`))) {
    ok = false;
  }

  return ok;
}
