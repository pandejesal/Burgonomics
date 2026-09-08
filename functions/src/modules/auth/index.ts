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
export {
  migrateGuestAccount,
  verifyBonusEligibility,
  awardWelcomeBonus,
  normalizePhoneIN,
  areAddressesDuplicate,
} from "./guestMigration";
export type { MigratableAddress, MigrateGuestInput, MigrationResult } from "./guestMigration";
export { cleanupExpiredGuestSessionsWorker, onUserDeletedCleanup } from "./triggers";
