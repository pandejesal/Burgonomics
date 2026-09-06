import { z } from "zod";
import { auth, db } from "../../core/firebase";
import * as admin from "firebase-admin";

export const APP_USER_ROLES = [
  "brand_owner",
  "developer",
  "support",
  "regional_manager",
  "branch_owner",
  "branch_staff",
  "driver",
  "customer",
] as const;

export type AppUserRole = (typeof APP_USER_ROLES)[number];

export const ROLE_ALIASES: Record<string, AppUserRole> = {
  superadmin: "brand_owner",
  branch_manager: "branch_owner",
  cashier: "branch_staff",
  kitchen: "branch_staff",
  kitchen_staff: "branch_staff",
  support_agent: "support",
};

export const AssignRoleSchema = z.object({
  targetUid: z.string().min(1, "Target UID is required"),
  role: z.string().min(1, "Role is required"),
  branchIds: z.array(z.string()).optional().default([]),
  cityIds: z.array(z.string()).optional().default([]),
});

export type AssignRoleInput = z.infer<typeof AssignRoleSchema>;

export interface CustomClaimsPayload {
  role: AppUserRole;
  branchIds: string[];
  cityIds: string[];
  isStaff: boolean;
  isBrandAdmin: boolean;
}

export interface CustomClaimsInput {
  uid?: string;
  targetUid?: string;
  role: AppUserRole | string;
  branchIds?: string[];
  cityIds?: string[];
}

/**
 * Validates and normalizes role strings against the 8-tier hierarchy and known aliases.
 */
export function validateAndNormalizeRole(rawRole: string): AppUserRole {
  const normalizedKey = rawRole?.trim().toLowerCase();

  if (ROLE_ALIASES[normalizedKey]) {
    return ROLE_ALIASES[normalizedKey];
  }

  if (APP_USER_ROLES.includes(normalizedKey as AppUserRole)) {
    return normalizedKey as AppUserRole;
  }

  throw new Error(
    `Invalid role: '${rawRole}'. Valid roles: ${APP_USER_ROLES.join(", ")}`
  );
}

/**
 * Asserts that the caller has sufficient superadmin / brand privileges to assign RBAC roles.
 */
export function assertCallerCanAssignRole(
  callerClaims?: admin.auth.DecodedIdToken | { role?: string; isBrandAdmin?: boolean } | null
): void {
  if (!callerClaims) {
    throw new Error("Caller authorization required: Missing authentication token.");
  }

  const callerRole = callerClaims.role;
  const isBrandAdmin =
    callerClaims.isBrandAdmin === true ||
    callerRole === "brand_owner" ||
    callerRole === "developer" ||
    callerRole === "superadmin";

  if (!isBrandAdmin) {
    throw new Error("Permission denied: Only Superadmins / Brand Owners can assign RBAC roles.");
  }
}

export interface SetClaimsResult {
  success: boolean;
  targetUid: string;
  role: AppUserRole;
  claims: CustomClaimsPayload;
}

/**
 * Sets custom user claims in Firebase Auth, revokes existing refresh tokens to force
 * immediate client token re-issuance, and synchronizes the user profile in Firestore.
 */
export async function setUserCustomClaims(input: {
  uid?: string;
  targetUid?: string;
  role: string;
  branchIds?: string[];
  cityIds?: string[];
}): Promise<SetClaimsResult> {
  const targetUid = input.targetUid || input.uid;
  if (!targetUid) {
    throw new Error("Target UID is required to set custom claims.");
  }

  const validatedRole = validateAndNormalizeRole(input.role);
  const branchIds = input.branchIds || [];
  const cityIds = input.cityIds || [];

  const claims: CustomClaimsPayload = {
    role: validatedRole,
    branchIds,
    cityIds,
    isStaff: validatedRole !== "customer",
    isBrandAdmin: validatedRole === "brand_owner" || validatedRole === "developer",
  };

  // 1. Inject Firebase Auth custom claims
  await auth.setCustomUserClaims(targetUid, claims);

  // 2. Invalidate refresh tokens to force client re-authentication with fresh claims
  try {
    await auth.revokeRefreshTokens(targetUid);
  } catch (err) {
    console.warn("[Auth] Could not revoke refresh tokens:", (err as any)?.message || err);
  }

  // 3. Synchronize with Firestore `users/{uid}` collection
  await db
    .collection("users")
    .doc(targetUid)
    .set(
      {
        role: validatedRole,
        branchIds,
        cityIds,
        isStaff: claims.isStaff,
        isBrandAdmin: claims.isBrandAdmin,
        claimsUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

  // 4. Keep the `admins/{uid}` registry in lockstep with claims. requireRole()
  // falls back to this doc when claims are stale, so a demotion that leaves
  // the doc behind would keep working as a backdoor pass. Operators get a
  // mirrored doc; customers (revocations) get the doc deleted.
  const adminRef = db.collection("admins").doc(targetUid);
  if (claims.isStaff) {
    await adminRef.set(
      {
        role: validatedRole,
        branchIds,
        cityIds,
        claimsUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  } else {
    await adminRef.delete().catch(() => {
      // No doc to delete — already clean.
    });
  }

  return {
    success: true,
    targetUid,
    role: validatedRole,
    claims,
  };
}

/**
 * Full RBAC role assignment workflow with caller privilege verification and Zod validation.
 */
export async function assignUserRole(
  callerClaims: admin.auth.DecodedIdToken | { role?: string; isBrandAdmin?: boolean } | null | undefined,
  input: unknown
): Promise<SetClaimsResult> {
  // 1. Check caller privilege
  assertCallerCanAssignRole(callerClaims);

  // 2. Validate payload
  const parsed = AssignRoleSchema.parse(input);

  // 3. Set custom claims and sync Firestore
  return setUserCustomClaims({
    targetUid: parsed.targetUid,
    role: parsed.role,
    branchIds: parsed.branchIds,
    cityIds: parsed.cityIds,
  });
}

/**
 * Revokes all elevated RBAC privileges, resetting the user to default 'customer' claims.
 */
export async function revokeUserRole(
  callerClaims: admin.auth.DecodedIdToken | { role?: string; isBrandAdmin?: boolean } | null | undefined,
  targetUid: string
): Promise<SetClaimsResult> {
  assertCallerCanAssignRole(callerClaims);

  if (!targetUid) {
    throw new Error("Target UID is required for role revocation.");
  }

  return setUserCustomClaims({
    targetUid,
    role: "customer",
    branchIds: [],
    cityIds: [],
  });
}
