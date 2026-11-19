import * as admin from "firebase-admin";
import { auth, db } from "../../core/firebase";
import { isBrandAdminClaim, type StaffCaller } from "../../core/middleware";
import { staffSuspensionSchema, type StaffSuspensionInput } from "./staffSuspension.schema";

/**
 * F06 — server-owned staff suspension.
 *
 * Before this module the Suspend control was a bare client write
 * (`partner/src/hooks/useUsers.ts` -> `users/{uid}.active`) and NOTHING in
 * authorization consulted that field: `requireRole` admitted on the token claim
 * alone and Firestore's `hasRole` read only `admins/{uid}`. A suspended operator
 * therefore kept working. This module is the authoritative writer; middleware.ts
 * and the rules read the same field.
 *
 * Safety properties, all enforced inside ONE transaction:
 *   - the caller must be a brand owner/developer by BOTH the verified token and
 *     the trusted `admins/{uid}` registry, and must itself be active;
 *   - suspending yourself is refused;
 *   - the target must exist and must be staff;
 *   - the audit row is written in the SAME transaction (no unbound post-commit
 *     helper that can be lost);
 *   - repeating the current value is a no-op with no duplicate audit row.
 *
 * Refresh-token revocation runs AFTER commit and is secondary — it narrows the
 * window in which an old token still exists, and its failure must never look
 * like a failed suspension. Repeating the call converges (idempotent state plus
 * a fresh revocation attempt).
 */

const STAFF_ROLES = [
  "brand_owner",
  "developer",
  "support",
  "regional_manager",
  "branch_owner",
  "branch_staff",
] as const;

export interface SetStaffActiveResult {
  success: boolean;
  targetUid: string;
  active: boolean;
  /** False when the stored value already matched the request. */
  changed: boolean;
}

function refusal(code: string, message: string, statusCode: number) {
  return Object.assign(new Error(message), { code, statusCode });
}

export async function setStaffActive(
  rawInput: unknown,
  caller?: StaffCaller | admin.auth.DecodedIdToken | null
): Promise<SetStaffActiveResult> {
  const input = staffSuspensionSchema.parse(rawInput) as StaffSuspensionInput;
  const actorUid = String((caller as any)?.uid ?? "").trim();
  if (!actorUid) {
    throw refusal("UNAUTHORIZED", "Authentication required", 401);
  }
  if (input.targetUid === actorUid) {
    throw refusal(
      "SELF_SUSPENSION_DENIED",
      "A brand owner cannot suspend their own account.",
      403
    );
  }

  const auditRef = db.collection("admin_audit_logs").doc();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await db.runTransaction(async (tx: any) => {
    // --- actor: trustworthy authority, re-read inside the transaction --------
    const actorAdminSnap = await tx.get(db.collection("admins").doc(actorUid));
    const actorProfileSnap = await tx.get(db.collection("users").doc(actorUid));
    const actorAdmin = actorAdminSnap.exists ? (actorAdminSnap.data() as any) : null;
    const actorRole = String(actorAdmin?.role ?? "");
    const actorIsBrand =
      isBrandAdminClaim(caller as any) &&
      (actorRole === "brand_owner" || actorRole === "developer");
    if (!actorIsBrand) {
      throw refusal(
        "FORBIDDEN",
        "Only brand owners and developers may change staff suspension.",
        403
      );
    }
    // The actor must itself be active: concurrent cross-suspension can then
    // never consume the final active authority.
    const actorActive =
      actorProfileSnap.exists && (actorProfileSnap.data() as any)?.active === true;
    if (!actorActive) {
      throw refusal(
        "ACTOR_SUSPENDED",
        "This account is suspended and cannot change staff access.",
        403
      );
    }

    // --- target: must exist and must be staff --------------------------------
    const targetRef = db.collection("users").doc(input.targetUid);
    const targetSnap = await tx.get(targetRef);
    if (!targetSnap.exists) {
      throw refusal(
        "TARGET_PROFILE_MISSING",
        "This staff member has no authoritative profile — provision it before changing access.",
        404
      );
    }
    const target = (targetSnap.data() || {}) as any;
    const targetRole = String(target.role ?? "");
    if (!(STAFF_ROLES as readonly string[]).includes(targetRole)) {
      throw refusal("TARGET_NOT_STAFF", "Only staff accounts can be suspended here.", 409);
    }

    const current = target.active === true;
    if (current === input.active) {
      return { changed: false };
    }

    tx.set(
      targetRef,
      {
        active: input.active,
        suspendedAt: input.active
          ? admin.firestore.FieldValue.delete()
          : admin.firestore.FieldValue.serverTimestamp(),
        suspendedBy: input.active ? admin.firestore.FieldValue.delete() : actorUid,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    tx.set(auditRef, {
      actorUid,
      actorEmail: (caller as any)?.email ?? null,
      action: input.active ? "staff_reactivated" : "staff_suspended",
      targetType: "user",
      targetId: input.targetUid,
      metadata: { role: targetRole, reason: input.reason ?? null },
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return { changed: true };
  });

  // Secondary: narrow the window in which the target's OLD token still works.
  // Never fails the suspension; a retry re-attempts it.
  if (result.changed) {
    try {
      await auth.revokeRefreshTokens(input.targetUid);
    } catch (err: any) {
      console.warn(
        `[Auth] refresh-token revocation failed for ${input.targetUid}:`,
        (err as any)?.message || err
      );
    }
  }

  return {
    success: true,
    targetUid: input.targetUid,
    active: input.active,
    changed: result.changed,
  };
}
