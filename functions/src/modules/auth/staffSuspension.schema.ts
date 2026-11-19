import { z } from "zod";

/**
 * F06 — request body for POST /auth/suspendStaff.
 *
 * The target state is an explicit boolean: an omitted `active` must never be
 * coerced into either direction. No `actorUid`/`role`/`branchIds` field exists —
 * those come from the verified ID token and the trusted `admins/{uid}` registry,
 * never from this body.
 */
export const staffSuspensionSchema = z
  .object({
    targetUid: z.string().trim().min(1, "targetUid is required").max(128),
    active: z.boolean(),
    /** Recorded on the audit row; not a security decision. */
    reason: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

export type StaffSuspensionInput = z.infer<typeof staffSuspensionSchema>;
