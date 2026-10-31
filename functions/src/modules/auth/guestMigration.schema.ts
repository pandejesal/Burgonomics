import { z } from "zod";

/**
 * PURE wire/shape contract for guest migration (FIX2, C1).
 *
 * Lives alone so both consumers bind to ONE schema without dragging
 * firebase-admin/service side effects into core validation:
 *   - core/validation.ts re-exports it for the /auth/migrateGuest route
 *   - modules/auth/guestMigration.ts re-exports it for service typing
 *
 * Before this, the ROUTE schema kept only {permanentUid, phone, email} and
 * validateBody REPLACED req.body with that subset - so guestSessionId,
 * anonymousUid, name, addresses and guestProof were stripped before
 * migrateGuestAccount ran; the route answered success:true while relinking
 * NOTHING. The service schema (all fields) is now the single source of truth.
 *
 * Bounds without silently dropping legitimate migration data: real guest
 * sessions carry nothing larger - oversized or malicious payloads get a loud
 * 400 instead of a truncated relink.
 */

export const AddressSchema = z
  .object({
    id: z.string().max(128).optional(),
    label: z.string().max(64).optional(),
    full: z.string().max(500).optional(),
    fullAddress: z.string().max(500).optional(),
    street: z.string().max(200).optional(),
    area: z.string().max(120).optional(),
    city: z.string().max(120).optional(),
    pincode: z.string().max(12).optional(),
    lat: z.number().finite().min(-90).max(90).optional(),
    lng: z.number().finite().min(-180).max(180).optional(),
    isDefault: z.boolean().optional(),
  })
  .passthrough(); // unknown keys inside a legacy address snapshot are harmless copy data

export type MigratableAddress = z.infer<typeof AddressSchema>;

export const MigrateGuestSchema = z
  .object({
    /** Upgraded UID; the verified ID token binds here first (route overrides from req.user). */
    permanentUid: z.string().min(1).max(128),
    // Legacy guest sources - each gets its own relink guard in the service
    // (guestSessionId + guestProof HMAC; anonymousUid authenticated against
    // Firebase Anonymous). Shape-validated here, ownership-validated there.
    guestSessionId: z.string().min(1).max(128).optional(),
    anonymousUid: z.string().min(1).max(128).optional(),
    phone: z.string().max(20).optional(),
    email: z.string().email().max(254).optional(),
    name: z.string().trim().max(120).optional(),
    addresses: z.array(AddressSchema).max(20).optional().default([]),
    /** Signed guest-ownership proof (HMAC-SHA256 hex, see mintGuestOwnershipProof). */
    guestProof: z.string().max(256).optional(),
  })
  .strict(); // unknown fields are an ERROR, never a silent strip - a future
             // client bug must surface loudly instead of regressing to a no-op
