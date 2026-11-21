import { z } from "zod";
import { auth, db } from "../../core/firebase";
import * as admin from "firebase-admin";
import { computeHmacSha256, timingSafeEqual } from "../../core/security";

import { AddressSchema, MigrateGuestSchema, MigratableAddress } from "./guestMigration.schema";

// FIX2 (C1): the wire/service shape contract is now shared with the route
// layer via the PURE schema module. Re-exported under the same names so the
// service typing and existing tests are untouched; the routes their fields
// carry are validated once, at the boundary, and never silently stripped.
export { AddressSchema, MigrateGuestSchema, MigratableAddress };

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
 * RETIRED (owner decision 2026-11-20: "Loyalty no: hide coins, tiers and
 * points everywhere").
 *
 * This was the deterministic-create welcome-bonus minter. Nothing mints Grill
 * Coins any more: the balance it credited is not displayed and cannot be spent
 * at checkout, so granting it is a dead write that keeps a retired feature
 * alive in the data model. It is deleted rather than left callable, so no
 * future route can resurrect the mint by accident.
 *
 * Historical `coin_transactions` welcome_bonus rows and existing balances are
 * untouched; `verifyBonusEligibility` still reads them, which is what keeps a
 * re-enabled programme exactly-once per phone/UID.
 */

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

  // H1 FAIL-CLOSED (orchestrator decision 2026-10-20T03:00Z): a guest-session
  // relink is reachable ONLY with a VALID signed guest-ownership proof,
  // verified timing-safe AGAINST that session id - and the refusal runs
  // BEFORE any read or write. The previous "unproven batch-5 rollout stage"
  // made a session id (unguessable by design, but not by POSSESSION)
  // sufficient to relink guest-owned docs; Admin-SDK writes bypass client
  // Firestore rules and requireRole confirms role only, so those were never
  // a backstop. Unproven relink is a security regression, not a product
  // policy: MISSING/invalid/garbage proof => typed 403, session-ID-only
  // migration no longer exists.
  if (guestSessionId) {
    assertUnguessableSessionId(guestSessionId);
    if (!verifyGuestOwnershipProof(guestSessionId, guestProof)) {
      const e = new Error(
        "Migration refused: a valid signed guest-ownership proof is required for session relink."
      ) as Error & { code?: string; statusCode?: number };
      e.code = "MIGRATION_PROOF_REQUIRED";
      e.statusCode = 403;
      throw e;
    }
  } else if (guestProof !== undefined) {
    // A proof with no session id verifies against nothing: refuse instead of
    // silently treating the call as proofless.
    const e = new Error(
      "Migration refused: a guest-ownership proof was provided without a guest session id."
    ) as Error & { code?: string; statusCode?: number };
    e.code = "MIGRATION_PROOF_REQUIRED";
    e.statusCode = 403;
    throw e;
  }

  // anonymousUid CROSS-ACCOUNT relink FAILS CLOSED (same decision). Looking up
  // the source UID and observing that it "is anonymous" proves nothing about
  // caller POSSESSION of that account: Admin-SDK lookups are not
  // authorization, and unguessability is not an access control. No supported
  // source-possession token exists in this project yet, so cross-UID relink
  // stays BLOCKED until one is ratified (e.g. a Firebase account-link
  // migration flow minted server-side). Same-UID upgrade is NOT a cross-UID
  // relink and remains unaffected. LEGITIMATE PATH AFFECTED: the batch-5
  // anonymous->permanent upgrade flow - disclosed here explicitly rather
  // than silently relinking, per the fail-closed instruction.
  if (anonymousUid && anonymousUid !== permanentUid) {
    const e = new Error(
      "Migration refused: cross-UID relink requires verifiable source ownership - no supported source-proof mechanism exists (BLOCKED)."
    ) as Error & { code?: string; statusCode?: number };
    e.code = "MIGRATION_SOURCE_UNOWNED";
    e.statusCode = 403;
    throw e;
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
  // Loyalty is retired (owner decision 2026-11-20): no welcome bonus is minted.
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
    const seenPaths = new Set<string>();

    const docIdField =
      typeof admin.firestore?.FieldPath?.documentId === "function"
        ? admin.firestore.FieldPath.documentId()
        : "__name__";

    let lastDoc: any = undefined;
    let prevLastId: string | undefined = undefined;

    while (true) {
      let query: any = db.collection(collection).where(field, "==", value);

      // Inspect capabilities before .limit because legacy fakes may narrow the object returned by .limit()
      const hasOrderBy = typeof query.orderBy === "function";
      const hasStartAfter = typeof query.startAfter === "function";

      if (hasOrderBy) {
        query = query.orderBy(docIdField);
      }

      if (lastDoc) {
        if (typeof query.startAfter !== "function") {
          const e = new Error(
            `Migration failed: datastore query for ${collection} lacks startAfter capability required to drain beyond page 1.`
          ) as Error & { code?: string; statusCode?: number };
          e.code = "MIGRATION_PAGINATION_FAILED";
          e.statusCode = 500;
          throw e;
        }
        query = query.startAfter(lastDoc);
      }

      const canPage = typeof query.startAfter === "function" || hasStartAfter;

      query = query.limit(MIGRATION_CHUNK_LIMIT);

      // eslint-disable-next-line no-await-in-loop
      const snap = await query.get();
      const docs: any[] = snap?.docs || [];

      if (docs.length === 0) {
        break;
      }

      for (const d of docs) {
        const refPath = d.ref?.path || `${collection}/${d.id || d.ref?.id}`;
        if (!seenPaths.has(refPath)) {
          seenPaths.add(refPath);
          // eslint-disable-next-line no-await-in-loop
          if (await isRelinkable(d)) {
            refs.push(d.ref);
          } else {
            skippedProtectedCount++;
          }
        }
      }

      // If page had fewer than MIGRATION_CHUNK_LIMIT docs, collection is fully drained.
      // Small finite shim datasets (<400) exit cleanly here.
      if (docs.length < MIGRATION_CHUNK_LIMIT) {
        break;
      }

      // A full page (docs.length === MIGRATION_CHUNK_LIMIT) requires valid cursor progression
      const currentLastDoc = docs[docs.length - 1];
      const currentLastId = currentLastDoc?.id || currentLastDoc?.ref?.id;

      if (!currentLastDoc || !currentLastId) {
        const e = new Error(
          `Migration failed: last document in ${collection} page is malformed; cannot paginate safely.`
        ) as Error & { code?: string; statusCode?: number };
        e.code = "MIGRATION_PAGINATION_FAILED";
        e.statusCode = 500;
        throw e;
      }

      if (currentLastId === prevLastId) {
        const e = new Error(
          `Migration failed: repeated cursor detected at doc ${currentLastId} in ${collection}; pagination non-advancing.`
        ) as Error & { code?: string; statusCode?: number };
        e.code = "MIGRATION_PAGINATION_FAILED";
        e.statusCode = 500;
        throw e;
      }

      if (!canPage) {
        const e = new Error(
          `Migration failed: full page reached in ${collection} but datastore lacks pagination cursor support.`
        ) as Error & { code?: string; statusCode?: number };
        e.code = "MIGRATION_PAGINATION_FAILED";
        e.statusCode = 500;
        throw e;
      }

      lastDoc = currentLastDoc;
      prevLastId = currentLastId;
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

  // 4. LOYALTY RETIRED (owner decision 2026-11-20: "Loyalty no: hide coins,
  // tiers and points everywhere").
  //
  // This step used to award a 50-coin welcome bonus into
  // `customers/{uid}.loyaltyPoints` with a `coin_transactions` ledger row.
  // Nothing in the launch renders or spends that balance any more, so minting
  // it is a dead write that keeps a retired feature alive in the data model.
  // New grants therefore stop here. What remains is the CLAIM FLAG, so the
  // bonus stays exactly-once-claimed: a later re-enable cannot double-grant an
  // account that was already awarded, and no historical row is deleted or
  // zeroed. `welcomeBonusAwarded`/`bonusCoins` keep reporting zero so every
  // existing caller sees the truth.


  // 5. UPDATE PERMANENT USER PROFILE (phone = verified only)
  const userUpdates: Record<string, any> = {
    ...(verifiedPhone ? { phone: verifiedPhone } : {}),
    ...(email ? { email } : {}),
    ...(name ? { name } : {}),
    addresses: dedupedAddresses,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  ops.push({ kind: "set", ref: permanentUserRef, data: userUpdates, merge: true });

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

  // 6.5. WELCOME-BONUS: RETIRED. The award used to land here, after the relink
  // batch, as ledger row + balance + claim flag in one transaction. Loyalty is
  // no longer part of the launch, so nothing is minted. Only the claim flag is
  // stamped (outside the relink batch, so a failed relink never burns it), which
  // preserves exactly-once semantics if the programme is ever re-enabled:
  // verifyBonusEligibility still short-circuits on it.
  const claimSnap = await permanentUserRef.get();
  if (!(claimSnap.exists && claimSnap.data()?.hasClaimedWelcomeBonus)) {
    await permanentUserRef.set(
      {
        hasClaimedWelcomeBonus: true,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  }

  return {
    success: true,
    permanentUid,
    migratedOrdersCount,
    migratedTicketsCount,
    migratedAddressesCount,
    cartMigrated,
    // Loyalty is retired (owner decision 2026-11-20): nothing is minted, so
    // both counters report zero. The fields stay in the contract so existing
    // callers and historical evidence keep parsing.
    welcomeBonusAwarded: false,
    bonusCoins: 0,
    skippedProtectedCount,
    message: "Guest session successfully migrated to authenticated account.",
  };
}
