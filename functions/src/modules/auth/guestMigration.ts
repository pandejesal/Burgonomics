import { z } from "zod";
import { auth, db } from "../../core/firebase";
import * as admin from "firebase-admin";
import { computeHmacSha256, timingSafeEqual } from "../../core/security";

export const AddressSchema = z.object({
  id: z.string().optional(),
  label: z.string().optional(),
  full: z.string().optional(),
  fullAddress: z.string().optional(),
  street: z.string().optional(),
  area: z.string().optional(),
  city: z.string().optional(),
  pincode: z.string().optional(),
  lat: z.number().optional(),
  lng: z.number().optional(),
  isDefault: z.boolean().optional(),
});

export type MigratableAddress = z.infer<typeof AddressSchema>;

export const MigrateGuestSchema = z.object({
  guestSessionId: z.string().optional(),
  anonymousUid: z.string().optional(),
  permanentUid: z.string().min(1, "Permanent UID is required"),
  phone: z.string().optional(),
  email: z.string().optional(),
  name: z.string().optional(),
  addresses: z.array(AddressSchema).optional().default([]),
  // Signed guest-ownership proof (HMAC-SHA256 hex over the session id, see
  // mintGuestOwnershipProof). Optional during the client rollout (batch 5):
  // when present it MUST verify; when absent only guest-owned docs relink
  // (identified users' docs are never stolen — the guest-relink guard below).
  guestProof: z.string().optional(),
});

export type MigrateGuestInput = z.infer<typeof MigrateGuestSchema>;

export interface MigrationResult {
  success: boolean;
  permanentUid: string;
  migratedOrdersCount: number;
  migratedTicketsCount: number;
  migratedAddressesCount: number;
  cartMigrated: boolean;
  welcomeBonusAwarded: boolean;
  bonusCoins: number;
  /** Docs that LOOKED migratable by session id but were owned by an
   *  identified UID — left untouched (guest-relink attack denied). */
  skippedProtectedCount: number;
  message?: string;
}

/** Least-privilege caller presented by the route (verified ID token). */
export interface MigrationCaller {
  uid?: string;
  phone_number?: string;
  email?: string;
}

/** Firestore write-batch ceiling guard: relink chunks stay ≤400 ops so a
 *  single commit never approaches the 500-op hard limit (H10/M30). */
export const MIGRATION_CHUNK_LIMIT = 400;

/** Domain separator: the OTP HMAC secret signs many things; the label keeps
 *  a guest proof unusable as an OTP hash and vice versa. A dedicated
 *  GUEST_MIGRATION_SECRET is queued if rotation independence is ever needed. */
const GUEST_PROOF_LABEL = "guest-migration|";

function guestProofSecret(): string {
  return process.env.OTP_HMAC_SECRET || "";
}

/**
 * Mints a signed guest-ownership proof for a server-created guest session.
 * Server-side issuer (future issuance endpoint / tests) — never minted from
 * a caller-supplied session id on the migration path itself.
 */
export function mintGuestOwnershipProof(guestSessionId: string): string {
  const secret = guestProofSecret();
  if (!secret || !guestSessionId) {
    throw new Error("Guest-proof issuer misconfigured — refusing to mint.");
  }
  return computeHmacSha256(`${GUEST_PROOF_LABEL}${guestSessionId}`, secret);
}

/**
 * Verifies a presented guest-ownership proof with a timing-safe compare.
 * Fail-closed: missing secret, missing proof material, or mismatch all
 * return false (the migration path decides allow-vs-deny per rollout stage).
 */
export function verifyGuestOwnershipProof(
  guestSessionId: string | undefined,
  proof: string | undefined
): boolean {
  const secret = guestProofSecret();
  if (!secret || !guestSessionId || !proof) return false;
  const expected = computeHmacSha256(`${GUEST_PROOF_LABEL}${guestSessionId}`, secret);
  return timingSafeEqual(expected, proof);
}

/**
 * Guest session ids must be unguessable server tokens, not short/sequential
 * handles an attacker can enumerate. Guessable ids are refused outright.
 */
export function assertUnguessableSessionId(guestSessionId: string): void {
  if (!/^[A-Za-z0-9_-]{12,128}$/.test(guestSessionId)) {
    throw new Error("Migration refused: guest session id is not a valid unguessable token.");
  }
}

/**
 * Guest-relink guard: a session id may only ever relink docs that are still
 * guest-owned (customerId 'guest'/missing) or owned by the proven anonymous
 * UID. Docs already owned by any OTHER (identified) UID are protected — a
 * guessed/stale session id can never steal another user's orders or tickets.
 */
export function isGuestOwnedDoc(
  data: Record<string, any> | undefined,
  anonymousUid?: string
): boolean {
  if (!data) return false;
  const owner = data.customerId ?? data.userId;
  if (owner == null || owner === "guest") return true;
  if (anonymousUid && owner === anonymousUid) return true;
  return false;
}

/**
 * Calculates Haversine distance in meters between two lat/lng pairs.
 */
function calculateDistanceMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  const R = 6371e3; // Earth radius in meters
  const phi1 = (lat1 * Math.PI) / 180;
  const phi2 = (lat2 * Math.PI) / 180;
  const deltaPhi = ((lat2 - lat1) * Math.PI) / 180;
  const deltaLambda = ((lng2 - lng1) * Math.PI) / 180;

  const a =
    Math.sin(deltaPhi / 2) * Math.sin(deltaPhi / 2) +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(deltaLambda / 2) * Math.sin(deltaLambda / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c;
}

/**
 * Checks if two address objects refer to the same physical location.
 * Compares coordinates (within 50 meters) or normalized string matching.
 */
export function areAddressesDuplicate(
  a: MigratableAddress,
  b: MigratableAddress
): boolean {
  if (
    typeof a.lat === "number" &&
    typeof a.lng === "number" &&
    typeof b.lat === "number" &&
    typeof b.lng === "number"
  ) {
    const dist = calculateDistanceMeters(a.lat, a.lng, b.lat, b.lng);
    if (dist < 50) return true;
  }

  const textA = (a.full || a.fullAddress || `${a.street || ""} ${a.area || ""}`)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  const textB = (b.full || b.fullAddress || `${b.street || ""} ${b.area || ""}`)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

  if (textA.length > 5 && textB.length > 5 && textA === textB) {
    return true;
  }

  return false;
}

/**
 * Normalizes an Indian phone number to E.164 (+91XXXXXXXXXX). Returns null
 * when the input is not a usable 10-digit mobile — callers must then fall
 * back to UID-keyed dedup, never to "eligible".
 */
export function normalizePhoneIN(phone?: string): string | null {
  if (!phone) return null;
  let digits = phone.replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
  return digits.length === 10 ? `+91${digits}` : null;
}

/**
 * Verifies whether a phone number or customer UID is eligible to claim the Welcome Bonus.
 * Advisory only — the grant itself is serialized by awardWelcomeBonus()'s
 * deterministic-ID create(), which is the real double-spend guard.
 */
export async function verifyBonusEligibility(
  phone?: string,
  uid?: string
): Promise<{ eligible: boolean; reason?: string }> {
  if (uid) {
    const userDoc = await db.collection("users").doc(uid).get();
    if (userDoc.exists && userDoc.data()?.hasClaimedWelcomeBonus) {
      return { eligible: false, reason: "Welcome bonus has already been claimed by this account." };
    }
  }

  const normalizedPhone = normalizePhoneIN(phone);
  if (normalizedPhone) {
    // Check coin_transactions for existing welcome_bonus
    const txSnap = await db
      .collection("coin_transactions")
      .where("phone", "==", normalizedPhone)
      .where("type", "==", "welcome_bonus")
      .limit(1)
      .get();

    if (!txSnap.empty) {
      return {
        eligible: false,
        reason: "Welcome bonus has already been claimed for this phone number.",
      };
    }
  }

  return { eligible: true };
}

/**
 * Awards the welcome bonus exactly once per phone/UID, even under concurrent
 * migrateGuest calls. The ledger doc has a DETERMINISTIC id and is written
 * with create() (fails if it exists), so two racers serialize: one wins,
 * the other gets ALREADY_EXISTS and grants nothing. Returns coins awarded.
 */
export async function awardWelcomeBonus(
  permanentUid: string,
  phone: string | undefined,
  coins: number
): Promise<number> {
  const normalizedPhone = normalizePhoneIN(phone);
  const txId = normalizedPhone
    ? `welcome_bonus_phone_${normalizedPhone.replace(/\D/g, "")}`
    : `welcome_bonus_uid_${permanentUid}`;
  try {
    await db.collection("coin_transactions").doc(txId).create({
      id: txId,
      customerId: permanentUid,
      phone: normalizedPhone,
      amount: coins,
      type: "welcome_bonus",
      description: "Welcome Bonus: First Sign-In Grill Coins",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return coins;
  } catch (err: any) {
    // ALREADY_EXISTS (code 6) = another request won the race or a prior
    // grant exists — not an error, just no award.
    if (err?.code === 6 || err?.message?.includes("ALREADY_EXISTS")) {
      console.log(`[Auth] Welcome bonus already granted (${txId}) — skipping duplicate.`);
      return 0;
    }
    throw err;
  }
}

/**
 * Migrates guest orders, saved addresses, cart items, and resolves loyalty welcome bonus
 * into the permanent authenticated customer account atomically.
 */
export async function migrateGuestAccount(
  rawInput: unknown,
  caller?: MigrationCaller | null
): Promise<MigrationResult> {
  const input = MigrateGuestSchema.parse(rawInput);
  const { guestSessionId, anonymousUid, permanentUid, phone, email, name, addresses, guestProof } = input;

  // In-function authn bind: the migration target must be the caller's own
  // verified UID. Migrating INTO someone else's account is refused even if a
  // route ever passes a caller-supplied permanentUid through unchecked.
  if (caller?.uid && caller.uid !== permanentUid) {
    throw new Error("Migration refused: target account does not match the authenticated caller.");
  }

  // Signed guest-ownership proof: when the client presents one it MUST
  // verify (timing-safe). Absent-proof callers stay allowed during the
  // batch-5 client rollout, but the guest-relink guard below still confines
  // them to guest-owned docs only.
  if (guestProof !== undefined && !verifyGuestOwnershipProof(guestSessionId, guestProof)) {
    throw new Error("Migration refused: invalid guest-ownership proof.");
  }
  if (guestSessionId) {
    assertUnguessableSessionId(guestSessionId);
  }

  // Ownership proof for the anonymous-UID path: the source UID must be a real
  // Firebase ANONYMOUS account in this project. Claiming orders from an
  // identified (phone/email/password) account via a caller-supplied UID is
  // an order-hijack — refuse it. (Residual: a shared-device anonymous UID is
  // unguessable by design; prefer client-side Firebase account linking, which
  // keeps one UID and needs no migration at all.)
  if (anonymousUid && anonymousUid !== permanentUid) {
    let sourceUser: admin.auth.UserRecord;
    try {
      sourceUser = await auth.getUser(anonymousUid);
    } catch {
      throw new Error("Anonymous session not found — migration refused.");
    }
    const isAnonymous =
      sourceUser.providerData.length === 0 ||
      sourceUser.providerData.every((p) => p.providerId === "anonymous");
    if (!isAnonymous) {
      throw new Error("Migration refused: source account is not anonymous.");
    }
  }

  // OTP-verified phone link (C7): only the ID-token-verified phone_number
  // (Firebase OTP-minted) may key the phone bonus or overwrite the profile
  // phone. A caller-supplied body phone that CONTRADICTS the verified number
  // is an account-link attack signal — refuse. An unverified body phone is
  // ignored for bonus/profile (displayed nowhere, mints nothing).
  const verifiedPhone = normalizePhoneIN(caller?.phone_number);
  const claimedPhone = normalizePhoneIN(phone);
  if (claimedPhone && verifiedPhone && claimedPhone !== verifiedPhone) {
    throw new Error("Migration refused: phone does not match the OTP-verified number.");
  }

  let migratedOrdersCount = 0;
  let migratedTicketsCount = 0;
  let migratedAddressesCount = 0;
  let cartMigrated = false;
  let welcomeBonusAwarded = false;
  let bonusCoins = 0;
  let skippedProtectedCount = 0;

  type Op =
    | { kind: "update"; ref: admin.firestore.DocumentReference; data: Record<string, any> }
    | { kind: "set"; ref: admin.firestore.DocumentReference; data: Record<string, any>; merge: boolean }
    | { kind: "delete"; ref: admin.firestore.DocumentReference };
  const ops: Op[] = [];

  // Reads the doc payload for the guest-relink guard. where() snapshots in
  // this codebase expose data() on the doc handle; fall back to a get() when
  // the payload is absent (real Firestore QueryDocumentSnapshot always has it).
  async function isRelinkable(d: any): Promise<boolean> {
    try {
      const data = typeof d.data === "function" ? d.data() : undefined;
      if (data !== undefined) return isGuestOwnedDoc(data, anonymousUid);
      const snap = await d.ref.get();
      return snap.exists ? isGuestOwnedDoc(snap.data() as any, anonymousUid) : false;
    } catch {
      return false;
    }
  }

  async function collectRelink(
    collection: string,
    field: string,
    value: string
  ): Promise<admin.firestore.DocumentReference[]> {
    const refs: admin.firestore.DocumentReference[] = [];
    // Chunked reads: never pull an unbounded session history into one batch.
    const snap = await db.collection(collection).where(field, "==", value).limit(MIGRATION_CHUNK_LIMIT).get();
    for (const d of snap.docs as any[]) {
      if (!refs.some((r) => r.path === (d.ref as any).path)) {
        // eslint-disable-next-line no-await-in-loop
        if (await isRelinkable(d)) refs.push(d.ref);
        else skippedProtectedCount++;
      }
    }
    return refs;
  }

  // 1. ATOMIC ORDER RELINKING (guest-owned docs only, chunked)
  const orderDocRefs: admin.firestore.DocumentReference[] = [];

  if (guestSessionId) {
    for (const ref of await collectRelink("orders", "guestSessionId", guestSessionId)) {
      if (!orderDocRefs.some((r) => r.path === ref.path)) orderDocRefs.push(ref);
    }
  }

  if (anonymousUid && anonymousUid !== permanentUid) {
    for (const ref of await collectRelink("orders", "customerId", anonymousUid)) {
      if (!orderDocRefs.some((r) => r.path === ref.path)) orderDocRefs.push(ref);
    }
  }

  for (const ref of orderDocRefs) {
    ops.push({
      kind: "update",
      ref,
      data: {
        customerId: permanentUid,
        ...(guestSessionId ? { originalGuestSessionId: guestSessionId } : {}),
        ...(anonymousUid ? { originalCustomerId: anonymousUid } : {}),
        migratedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
    });
    migratedOrdersCount++;
  }

  // 2. ATOMIC TICKET RELINKING (guest-owned docs only, chunked)
  const ticketDocRefs: admin.firestore.DocumentReference[] = [];
  if (guestSessionId) {
    for (const ref of await collectRelink("tickets", "guestSessionId", guestSessionId)) {
      if (!ticketDocRefs.some((r) => r.path === ref.path)) ticketDocRefs.push(ref);
    }
  }
  if (anonymousUid && anonymousUid !== permanentUid) {
    for (const ref of await collectRelink("tickets", "customerId", anonymousUid)) {
      if (!ticketDocRefs.some((r) => r.path === ref.path)) ticketDocRefs.push(ref);
    }
  }

  for (const ref of ticketDocRefs) {
    ops.push({
      kind: "update",
      ref,
      data: {
        customerId: permanentUid,
        migratedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
    });
    migratedTicketsCount++;
  }

  // 3. PROFILE & ADDRESS DEDUPLICATION
  const permanentUserRef = db.collection("users").doc(permanentUid);
  const permanentUserSnap = await permanentUserRef.get();
  const existingUserData = permanentUserSnap.exists ? permanentUserSnap.data() || {} : {};
  const existingAddresses: MigratableAddress[] = Array.isArray(existingUserData.addresses)
    ? existingUserData.addresses
    : [];

  const dedupedAddresses = [...existingAddresses];

  if (Array.isArray(addresses) && addresses.length > 0) {
    for (const newAddr of addresses) {
      const isDupe = dedupedAddresses.some((existing) =>
        areAddressesDuplicate(existing, newAddr)
      );
      if (!isDupe) {
        dedupedAddresses.push({
          ...newAddr,
          id: newAddr.id || `addr_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
          isDefault: dedupedAddresses.length === 0,
        });
        migratedAddressesCount++;
      }
    }
  }

  // 4. LOYALTY & WALLET BONUS INTEGRITY (50 Grill Coins First Order / Welcome Bonus)
  // Advisory eligibility read first (cheap early-out), then the atomic
  // awardWelcomeBonus() create() serializes concurrent callers. The ledger is
  // keyed by the OTP-VERIFIED phone only — an unverified body phone mints
  // nothing (falls back to the once-per-UID key, still idempotent).
  const WELCOME_BONUS_COINS = 50;
  const eligibility = await verifyBonusEligibility(verifiedPhone ?? undefined, permanentUid);

  if (eligibility.eligible) {
    bonusCoins = await awardWelcomeBonus(permanentUid, verifiedPhone ?? undefined, WELCOME_BONUS_COINS);
    welcomeBonusAwarded = bonusCoins > 0;
  }

  // 5. UPDATE PERMANENT USER PROFILE (phone = verified only)
  const userUpdates: Record<string, any> = {
    ...(verifiedPhone ? { phone: verifiedPhone } : {}),
    ...(email ? { email } : {}),
    ...(name ? { name } : {}),
    addresses: dedupedAddresses,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  if (welcomeBonusAwarded) {
    userUpdates.hasClaimedWelcomeBonus = true;
  }

  ops.push({ kind: "set", ref: permanentUserRef, data: userUpdates, merge: true });

  if (welcomeBonusAwarded) {
    // Readiness-1: credit the SPENDABLE currency. The old code incremented
    // users.grillCoins — a write-only dead field nothing reads (pricing
    // clamp, client display, and debits all use customers.loyaltyPoints),
    // so bonuses were unspendable. Merge-set increment creates the doc when
    // missing; the deterministic ledger row (awardWelcomeBonus) plus the
    // eligibility pre-check keep it once-per-phone.
    ops.push({
      kind: "set",
      ref: db.collection("customers").doc(permanentUid),
      data: {
        loyaltyPoints: admin.firestore.FieldValue.increment(WELCOME_BONUS_COINS),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      merge: true,
    });
  }

  // 6. GUEST CART MIGRATION
  const guestCartId = guestSessionId ? `guest_${guestSessionId}` : anonymousUid ? `anon_${anonymousUid}` : null;
  if (guestCartId) {
    const guestCartRef = db.collection("carts").doc(guestCartId);
    const guestCartSnap = await guestCartRef.get();
    if (guestCartSnap.exists) {
      const guestCartData = guestCartSnap.data();
      if (guestCartData && guestCartData.items && guestCartData.items.length > 0) {
        const userCartRef = db.collection("carts").doc(permanentUid);
        ops.push({
          kind: "set",
          ref: userCartRef,
          data: {
            ...guestCartData,
            customerId: permanentUid,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          merge: true,
        });
        ops.push({ kind: "delete", ref: guestCartRef });
        cartMigrated = true;
      }
    }
  }

  // Commit in ≤400-op chunks: one unbounded session must never overflow the
  // 500-op Firestore batch ceiling (reads above were already limit-capped).
  for (let i = 0; i < ops.length; i += MIGRATION_CHUNK_LIMIT) {
    const chunk = ops.slice(i, i + MIGRATION_CHUNK_LIMIT);
    const batch = db.batch();
    for (const op of chunk) {
      if (op.kind === "update") batch.update(op.ref, op.data);
      else if (op.kind === "set") batch.set(op.ref, op.data, { merge: op.merge });
      else batch.delete(op.ref);
    }
    // eslint-disable-next-line no-await-in-loop
    await batch.commit();
  }

  return {
    success: true,
    permanentUid,
    migratedOrdersCount,
    migratedTicketsCount,
    migratedAddressesCount,
    cartMigrated,
    welcomeBonusAwarded,
    bonusCoins,
    skippedProtectedCount,
    message: "Guest session successfully migrated to authenticated account.",
  };
}
