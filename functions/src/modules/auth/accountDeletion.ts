import * as admin from "firebase-admin";

/**
 * User-initiated account deletion (Loop 50/120 — DPDP right to erasure).
 *
 * The client called a dead Netlify path, so deletion always failed and the
 * right was unavailable (loudly, but unavailable). This endpoint deletes the
 * Firebase Auth user via Admin SDK; the onAuthUserDeletedCleanup trigger
 * (revoke tokens, delete cart + admins doc, strip profile PII) fires on the
 * deletion event. The route passes the caller through and requires an
 * explicit { confirm: true } body — deletion never happens by accident.
 */
export async function deleteUserAccount(uid: string): Promise<{ success: boolean; uid: string }> {
  if (!uid) {
    const missing: any = new Error("Cannot delete account: no authenticated user.");
    missing.statusCode = 401;
    throw missing;
  }
  await admin.auth().deleteUser(uid);
  return { success: true, uid };
}
