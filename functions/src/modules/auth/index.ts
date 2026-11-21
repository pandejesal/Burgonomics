/**
 * Auth module barrel (Batch 1 S1 — H11).
 *
 * Re-exports the role-claims, guest-migration, and auth-trigger entry
 * points consumed by `src/index.ts`.
 */
export {
  setUserCustomClaims,
  assignUserRole,
  revokeUserRole,
  validateAndNormalizeRole,
  assertCallerCanAssignRole,
  APP_USER_ROLES,
  ROLE_ALIASES,
} from "./claimsManager";
export type { AppUserRole, AssignRoleInput, CustomClaimsPayload, CustomClaimsInput } from "./claimsManager";
export { setStaffActive } from "./staffSuspension";
export type { SetStaffActiveResult } from "./staffSuspension";
export { staffSuspensionSchema } from "./staffSuspension.schema";
export type { StaffSuspensionInput } from "./staffSuspension.schema";

export {
  migrateGuestAccount,
  verifyBonusEligibility,
  normalizePhoneIN,
  areAddressesDuplicate,
  mintGuestOwnershipProof,
  verifyGuestOwnershipProof,
  assertUnguessableSessionId,
  isGuestOwnedDoc,
  MIGRATION_CHUNK_LIMIT,
} from "./guestMigration";
export type { MigratableAddress, MigrateGuestInput, MigrationResult, MigrationCaller } from "./guestMigration";
export { cleanupExpiredGuestSessionsWorker, onUserDeletedCleanup } from "./triggers";
