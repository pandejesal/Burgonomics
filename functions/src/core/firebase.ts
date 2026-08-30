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
      console.warn("[Firebase Admin] Could not parse FIREBASE_SERVICE_ACCOUNT json, using default init", e);
      admin.initializeApp();
    }
  } else {
    admin.initializeApp();
  }
}

export const db = typeof admin.firestore === "function" ? admin.firestore() : ({} as any);
export const auth = typeof admin.auth === "function" ? admin.auth() : ({} as any);
export const messaging = typeof admin.messaging === "function" ? admin.messaging() : ({} as any);

export { admin };
