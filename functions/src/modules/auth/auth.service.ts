import { auth, db } from "../../core/firebase";
import * as admin from "firebase-admin";

export type AppUserRole =
  | "brand_owner"
  | "developer"
  | "support"
  | "regional_manager"
  | "branch_owner"
  | "branch_staff"
  | "customer";

export interface CustomClaimsInput {
  uid: string;
  role: AppUserRole;
  branchIds?: string[];
  cityIds?: string[];
}

/**
 * Sets custom claims for RBAC, invalidates existing refresh tokens, and updates user profile in Firestore.
 */
export async function setUserCustomClaims(input: CustomClaimsInput): Promise<boolean> {
  const { uid, role, branchIds, cityIds } = input;

  const claims = {
    role,
    branchIds: branchIds || [],
    cityIds: cityIds || [],
    isStaff: role !== "customer",
    isBrandAdmin: role === "brand_owner" || role === "developer",
  };

  // Set Firebase Auth custom claims
  await auth.setCustomUserClaims(uid, claims);

  // Revoke refresh tokens to force client re-authentication with fresh claims (Check 25)
  try {
    await auth.revokeRefreshTokens(uid);
  } catch (err) {
    console.warn("[Auth] Could not revoke refresh tokens for user:", uid, err);
  }

  // Sync to users collection
  await db
    .collection("users")
    .doc(uid)
    .set(
      {
        role,
        branchIds: branchIds || [],
        cityIds: cityIds || [],
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

  return true;
}
