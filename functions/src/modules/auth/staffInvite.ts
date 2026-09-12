import { z } from "zod";
import { auth, db } from "../../core/firebase";
import * as admin from "firebase-admin";
import {
  setUserCustomClaims,
  validateAndNormalizeRole,
  assertCallerCanAssignRole,
} from "./claimsManager";

export const InviteStaffSchema = z
  .object({
    name: z.string().trim().min(1, "Name is required").max(120),
    email: z.string().trim().toLowerCase().email("Valid email is required"),
    phone: z
      .string()
      .trim()
      .regex(/^\+[1-9]\d{7,14}$/, "Phone must be E.164 (+country code, digits only)")
      .optional(),
    role: z.string().min(1, "Role is required"),
    branchIds: z.array(z.string().min(1)).max(50).optional().default([]),
    cityIds: z.array(z.string().min(1)).max(50).optional().default([]),
  })
  // Strict: a client PIN (or any unknown credential) must fail LOUD, never
  // be silently dropped — staff set their own PIN at first sign-in.
  .strict();

export type InviteStaffInput = z.infer<typeof InviteStaffSchema>;

export interface InviteStaffResult {
  success: boolean;
  uid: string;
  email: string;
  role: string;
  /** True when a new Auth account was created; false when claims were applied to an existing one. */
  invited: boolean;
}

type Caller =
  | admin.auth.DecodedIdToken
  | { role?: string; isBrandAdmin?: boolean }
  | null
  | undefined;

/**
 * Readiness-6: server staff-invite endpoint backing. The partner UsersPage
 * invite wrote users/partner_* docs directly (rules-deny by design) and
 * failed loudly with nowhere to go. This mints (or reuses) the Auth account,
 * applies role claims through the same guarded setter as every other path
 * (in-function authz, claims+admins registry lockstep), and writes the
 * staff profile. Idempotent per email: re-invites update claims instead of
 * duplicating accounts. Staff-only callers (brand_owner/developer enforced
 * at route AND inside setUserCustomClaims).
 */
export async function inviteStaffMember(
  rawInput: unknown,
  caller: Caller
): Promise<InviteStaffResult> {
  const input = InviteStaffSchema.parse(rawInput);
  // Authorize FIRST, before any Auth lookup or user creation: a rejected
  // caller must not trigger (or observe) account-existence side effects.
  assertCallerCanAssignRole(caller ?? null);
  const role = validateAndNormalizeRole(input.role);
  if (role === "customer") {
    const err: any = new Error(
      "Invite is staff-only — customers self-register in the app."
    );
    err.statusCode = 400;
    throw err;
  }

  let uid: string;
  let invited: boolean;
  try {
    const existing = await auth.getUserByEmail(input.email);
    uid = existing.uid;
    invited = false;
  } catch (err: any) {
    if (err?.code !== "auth/user-not-found") throw err;
    const created = await auth.createUser({
      email: input.email,
      displayName: input.name,
      ...(input.phone ? { phoneNumber: input.phone } : {}),
    });
    uid = created.uid;
    invited = true;
  }

  await setUserCustomClaims(
    { targetUid: uid, role, branchIds: input.branchIds, cityIds: input.cityIds },
    caller ?? null
  );

  await db
    .collection("users")
    .doc(uid)
    .set(
      {
        name: input.name,
        email: input.email,
        phone: input.phone ?? null,
        role,
        branchIds: input.branchIds,
        cityIds: input.cityIds,
        active: true,
        invitedBy: (caller as any)?.uid || null,
        invitedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

  // Readiness-7: security-registry row for every invite (best-effort).
  const { writeAuditLog } = await import("../audit/auditLog");
  await writeAuditLog({
    actorUid: (caller as any)?.uid ?? null,
    actorEmail: (caller as any)?.email ?? null,
    action: "staff_invited",
    targetType: "user",
    targetId: uid,
    metadata: { email: input.email, role, invited, branchIds: input.branchIds },
  });

  return { success: true, uid, email: input.email, role, invited };
}
