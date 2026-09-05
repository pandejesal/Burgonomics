import { z } from "zod";
import { auth, db } from "../../core/firebase";
import * as admin from "firebase-admin";

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
  message?: string;
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
  rawInput: unknown
): Promise<MigrationResult> {
  const input = MigrateGuestSchema.parse(rawInput);
  const { guestSessionId, anonymousUid, permanentUid, phone, email, name, addresses } = input;

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

  let migratedOrdersCount = 0;
  let migratedTicketsCount = 0;
  let migratedAddressesCount = 0;
  let cartMigrated = false;
  let welcomeBonusAwarded = false;
  let bonusCoins = 0;

  const batch = db.batch();

  // 1. ATOMIC ORDER RELINKING
  const orderDocRefs: admin.firestore.DocumentReference[] = [];

  if (guestSessionId) {
    const guestOrdersSnap = await db
      .collection("orders")
      .where("guestSessionId", "==", guestSessionId)
      .get();
    guestOrdersSnap.docs.forEach((d: any) => orderDocRefs.push(d.ref));
  }

  if (anonymousUid && anonymousUid !== permanentUid) {
    const anonOrdersSnap = await db
      .collection("orders")
      .where("customerId", "==", anonymousUid)
      .get();
    anonOrdersSnap.docs.forEach((d: any) => {
      if (!orderDocRefs.some((r) => r.path === d.ref.path)) {
        orderDocRefs.push(d.ref);
      }
    });
  }

  for (const ref of orderDocRefs) {
    batch.update(ref, {
      customerId: permanentUid,
      ...(guestSessionId ? { originalGuestSessionId: guestSessionId } : {}),
      ...(anonymousUid ? { originalCustomerId: anonymousUid } : {}),
      migratedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    migratedOrdersCount++;
  }

  // 2. ATOMIC TICKET RELINKING
  const ticketDocRefs: admin.firestore.DocumentReference[] = [];
  if (guestSessionId) {
    const guestTicketsSnap = await db
      .collection("tickets")
      .where("guestSessionId", "==", guestSessionId)
      .get();
    guestTicketsSnap.docs.forEach((d: any) => ticketDocRefs.push(d.ref));
  }
  if (anonymousUid && anonymousUid !== permanentUid) {
    const anonTicketsSnap = await db
      .collection("tickets")
      .where("customerId", "==", anonymousUid)
      .get();
    anonTicketsSnap.docs.forEach((d: any) => {
      if (!ticketDocRefs.some((r) => r.path === d.ref.path)) {
        ticketDocRefs.push(d.ref);
      }
    });
  }

  for (const ref of ticketDocRefs) {
    batch.update(ref, {
      customerId: permanentUid,
      migratedAt: admin.firestore.FieldValue.serverTimestamp(),
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
  // awardWelcomeBonus() create() serializes concurrent callers.
  const WELCOME_BONUS_COINS = 50;
  const eligibility = await verifyBonusEligibility(phone, permanentUid);

  if (eligibility.eligible) {
    bonusCoins = await awardWelcomeBonus(permanentUid, phone, WELCOME_BONUS_COINS);
    welcomeBonusAwarded = bonusCoins > 0;
  }

  // 5. UPDATE PERMANENT USER PROFILE
  const userUpdates: Record<string, any> = {
    ...(phone ? { phone } : {}),
    ...(email ? { email } : {}),
    ...(name ? { name } : {}),
    addresses: dedupedAddresses,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  if (welcomeBonusAwarded) {
    userUpdates.hasClaimedWelcomeBonus = true;
    userUpdates.grillCoins = admin.firestore.FieldValue.increment(WELCOME_BONUS_COINS);
  }

  batch.set(permanentUserRef, userUpdates, { merge: true });

  // 6. GUEST CART MIGRATION
  const guestCartId = guestSessionId ? `guest_${guestSessionId}` : anonymousUid ? `anon_${anonymousUid}` : null;
  if (guestCartId) {
    const guestCartRef = db.collection("carts").doc(guestCartId);
    const guestCartSnap = await guestCartRef.get();
    if (guestCartSnap.exists) {
      const guestCartData = guestCartSnap.data();
      if (guestCartData && guestCartData.items && guestCartData.items.length > 0) {
        const userCartRef = db.collection("carts").doc(permanentUid);
        batch.set(
          userCartRef,
          {
            ...guestCartData,
            customerId: permanentUid,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
        batch.delete(guestCartRef);
        cartMigrated = true;
      }
    }
  }

  // Commit all changes in a single atomic transaction/batch
  await batch.commit();

  return {
    success: true,
    permanentUid,
    migratedOrdersCount,
    migratedTicketsCount,
    migratedAddressesCount,
    cartMigrated,
    welcomeBonusAwarded,
    bonusCoins,
    message: "Guest session successfully migrated to authenticated account.",
  };
}
