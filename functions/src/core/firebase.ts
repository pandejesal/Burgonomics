import * as admin from "firebase-admin";

if (typeof admin.initializeApp === "function" && (!admin.apps || !admin.apps.length)) {
  const serviceAccountRaw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (serviceAccountRaw) {
    try {
      const serviceAccount = JSON.parse(serviceAccountRaw);
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
      });
    } catch (e) {
      // Fail-fast: invalid service account must not silently fall back to default init
      // which would run with wrong project/permissions and mask the real config error.
      throw new Error(
        `[Firebase Admin] Invalid FIREBASE_SERVICE_ACCOUNT json: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  } else {
    admin.initializeApp();
  }
}

// Fail-fast: if any admin SDK method is unavailable, throw instead of returning empty object
// which would mask real Firebase outages and cause silent failures downstream.
function requireAdminSdk<T>(fn: () => T, name: string): T {
  if (typeof fn !== "function") {
    throw new Error(`[Firebase Admin] ${name} is not available — Firebase Admin SDK not properly initialized`);
  }
  return fn();
}

export const db = requireAdminSdk(() => admin.firestore(), "admin.firestore");
export const auth = requireAdminSdk(() => admin.auth(), "admin.auth");
export const messaging = requireAdminSdk(() => admin.messaging(), "admin.messaging");

export { admin };
