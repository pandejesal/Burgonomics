import { db } from "../../core/firebase";
import * as admin from "firebase-admin";
import { COIN_RESERVATION_TTL_MS } from "./lifetimes";

/**
 * P1-H — Grill-Coins RESERVATIONS.
 *
 * `resolveRedeemableCoins` only CHECKS a balance at intent time. Several
 * discounted intents could therefore be minted against one balance, each
 * payable; at capture `debitRedeemedCoins` clamped the debit to whatever was
 * left, so every discount stood while the balance drained to zero — the
 * customer kept discounts they never paid for.
 *
 * A reservation closes that by making the coins unavailable the moment an
 * intent becomes payable:
 *
 *  - `reserveRedeemedCoins` runs INSIDE the intent transaction, so two
 *    concurrent checkouts conflict and only one can hold the coins.
 *  - `releaseReservedCoins` returns them when the intent expires or is
 *    cancelled, and is idempotent.
 *  - `consumeReservedCoinsInTx` spends them on capture, in the same
 *    transaction that records the debit ledger row.
 *
 * The customer's `loyaltyPoints` is NOT moved at reservation time: the coins
 * are still theirs until the money is actually taken. Availability is
 * `loyaltyPoints - sum(active reservations)`, which keeps the balance honest
 * even if a worker dies (a stale reservation ages out via the TTL).
 */

export const COIN_RESERVATIONS = "coin_reservations";
/**
 * Per-customer aggregate that makes availability atomic. A Firestore
 * transaction cannot SUM a query, so the running reserved total lives on one
 * document that every reservation reads and writes: two concurrent checkouts
 * therefore CONFLICT instead of both seeing "20 free" and both taking it.
 */
export const COIN_RESERVATION_ACCOUNTS = "coin_reservation_accounts";

/** A reservation older than this is treated as abandoned (crashed checkout). */
export { COIN_RESERVATION_TTL_MS };

export interface CoinReservation {
  customerId: string;
  coins: number;
  orderId: string;
  razorpayOrderId: string;
  status: "reserved" | "consumed" | "released";
  reservedAtMs: number;
  expiresAtMs: number;
  consumedAtMs?: number;
  releasedAtMs?: number;
  releaseReason?: string;
}

export function coinReservationId(razorpayOrderId: string): string {
  return `coinres_${String(razorpayOrderId || "").replace(/[^A-Za-z0-9_-]/g, "")}`;
}

function reservationDoc(value: any): CoinReservation | null {
  if (!value || typeof value !== "object") return null;
  const coins = Number(value.coins);
  if (!Number.isFinite(coins) || coins <= 0) return null;
  return value as CoinReservation;
}

/** The atomic per-customer aggregate document. */
function accountRef(customerId: string): any {
  return db
    .collection(COIN_RESERVATION_ACCOUNTS)
    .doc(String(customerId).replace(/[^A-Za-z0-9_-]/g, "_"));
}

/** Live reserved total, aged out per reservation (crashed checkouts expire). */
function liveReservedFromAccount(account: any, nowMs: number): number {
  const entries = account?.reservations;
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) return 0;
  let total = 0;
  for (const value of Object.values(entries as Record<string, any>)) {
    const coins = Number((value as any)?.coins);
    const expires = Number((value as any)?.expiresAtMs);
    if (!Number.isFinite(coins) || coins <= 0) continue;
    if (!Number.isFinite(expires) || expires <= nowMs) continue;
    total += coins;
  }
  return total;
}

function isLiveReservation(reservation: CoinReservation, nowMs: number): boolean {
  if (reservation.status !== "reserved") return false;
  const expires = Number(reservation.expiresAtMs);
  if (!Number.isFinite(expires)) return false;
  return expires > nowMs;
}

/**
 * Coins the customer can still commit: balance minus every LIVE reservation.
 * A reservation only held coins at intent time, so it is subtracted, never
 * re-added to `loyaltyPoints`.
 */
export async function availableCoinBalance(
  customerId: string,
  nowMs: number = Date.now()
): Promise<number> {
  if (!customerId || customerId === "guest") return 0;
  const snap = await db.collection("customers").doc(customerId).get();
  const balance = snap.exists
    ? Math.max(0, Math.floor(Number((snap.data() as any)?.loyaltyPoints) || 0))
    : 0;
  const accountSnap = await accountRef(customerId).get();
  const reserved = accountSnap.exists
    ? liveReservedFromAccount(accountSnap.data(), nowMs)
    : 0;
  return Math.max(0, balance - reserved);
}

async function reservedCoinTotal(customerId: string, nowMs: number): Promise<number> {
  try {
    const snap = await db
      .collection(COIN_RESERVATIONS)
      .where("customerId", "==", customerId)
      .limit(50)
      .get();
    const docs = Array.isArray(snap?.docs) ? snap.docs : [];
    let total = 0;
    for (const doc of docs) {
      const reservation = reservationDoc(
        typeof doc.data === "function" ? doc.data() : doc
      );
      if (reservation && isLiveReservation(reservation, nowMs)) total += reservation.coins;
    }
    return total;
  } catch (err: any) {
    // Fail CLOSED: an unreadable reservation set cannot prove coins are free.
    console.warn("[Coins] reservation lookup failed:", err?.message || err);
    throw err;
  }
}

/**
 * Reserves `coins` for one gateway order, transactionally against the customer
 * document, so two concurrent checkouts cannot both claim the same balance.
 * Runs on the CALLER's transaction when one is supplied (intent creation), and
 * in its own transaction otherwise.
 */
export async function reserveRedeemedCoinsInTx(
  tx: any,
  params: {
    customerId: string;
    coins: number;
    orderId: string;
    razorpayOrderId: string;
    nowMs?: number;
  }
): Promise<CoinReservation | null> {
  const coins = Math.floor(Number(params.coins) || 0);
  if (coins <= 0) return null;
  if (!params.customerId || params.customerId === "guest") return null;

  const nowMs = params.nowMs ?? Date.now();
  const customerRef = db.collection("customers").doc(params.customerId);
  const reservationRef = db
    .collection(COIN_RESERVATIONS)
    .doc(coinReservationId(params.razorpayOrderId));
  const account = accountRef(params.customerId);

  const snap = await tx.get(customerRef as any);
  const balance = snap.exists
    ? Math.max(0, Math.floor(Number((snap.data() as any)?.loyaltyPoints) || 0))
    : 0;

  const existingSnap = await tx.get(reservationRef as any);
  const existing = existingSnap.exists
    ? reservationDoc(existingSnap.data() as any)
    : null;
  if (existing && isLiveReservation(existing, nowMs)) {
    // Same gateway order asking again: reuse (idempotent retry).
    if (existing.customerId === params.customerId && existing.coins === coins) return existing;
    const conflict: any = new Error(
      "A different Grill-Coins reservation already exists for this payment — retry checkout."
    );
    conflict.statusCode = 409;
    conflict.code = "COINS_RESERVATION_CONFLICT";
    throw conflict;
  }

  // The ATOMIC read: every reservation for this customer goes through this one
  // document, so two concurrent checkouts conflict here instead of both
  // measuring the same free balance.
  const accountSnap = await tx.get(account as any);
  const accountData = accountSnap.exists ? accountSnap.data() : {};
  const reserved = liveReservedFromAccount(accountData, nowMs);
  const available = Math.max(0, balance - reserved);
  if (coins > available) {
    const err: any = new Error(
      `You only have ${available} Grill Coins available — please lower the redemption or earn more before retrying.`
    );
    err.statusCode = 400;
    err.code = "COINS_INSUFFICIENT";
    throw err;
  }

  const reservation: CoinReservation = {
    customerId: params.customerId,
    coins,
    orderId: params.orderId,
    razorpayOrderId: params.razorpayOrderId,
    status: "reserved",
    reservedAtMs: nowMs,
    expiresAtMs: nowMs + COIN_RESERVATION_TTL_MS,
  };
  tx.set(reservationRef as any, reservation, { merge: true });
  tx.set(
    account as any,
    {
      customerId: params.customerId,
      reservations: {
        ...(accountData?.reservations &&
        typeof accountData.reservations === "object" &&
        !Array.isArray(accountData.reservations)
          ? accountData.reservations
          : {}),
        [coinReservationId(params.razorpayOrderId)]: {
          coins,
          expiresAtMs: reservation.expiresAtMs,
        },
      },
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
  return reservation;
}

/** Convenience wrapper running its own transaction. */
export async function reserveRedeemedCoins(params: {
  customerId: string;
  coins: number;
  orderId: string;
  razorpayOrderId: string;
}): Promise<CoinReservation | null> {
  // Serialize per customer INSIDE this process as well: two concurrent
  // checkouts would otherwise both read the account aggregate before either
  // write lands, and the optimistic retry would let the second re-read the
  // FIRST one's still-absent entry. (Cross-process safety is the transaction's
  // account-document conflict; this closes the same-process interleave.)
  const key = String(params.customerId || "");
  const previous = reservationQueue.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const mine = previous.catch(() => undefined).then(() => gate);
  reservationQueue.set(key, mine);
  await previous.catch(() => undefined);
  try {
    return await db.runTransaction((tx: any) => reserveRedeemedCoinsInTx(tx, params));
  } finally {
    release();
    if (reservationQueue.get(key) === mine) reservationQueue.delete(key);
  }
}

const reservationQueue = new Map<string, Promise<unknown>>();

/**
 * Gives reserved coins back (intent expired, order cancelled, or the payment
 * never completed). Idempotent: a reservation that is already released or
 * consumed is left alone, so a replay cannot mint availability.
 */
export async function releaseReservedCoins(params: {
  razorpayOrderId: string;
  reason: string;
}): Promise<{ released: boolean; coins: number }> {
  const razorpayOrderId = String(params.razorpayOrderId || "");
  if (!razorpayOrderId) return { released: false, coins: 0 };
  const ref = db.collection(COIN_RESERVATIONS).doc(coinReservationId(razorpayOrderId));

  return db.runTransaction(async (tx: any) => {
    const snap = await tx.get(ref as any);
    if (!snap.exists) return { released: false, coins: 0 };
    const reservation = reservationDoc(snap.data() as any);
    if (!reservation) return { released: false, coins: 0 };
    // Consumed coins are already spent; released ones are already back.
    if (reservation.status !== "reserved") return { released: false, coins: 0 };

    const account = accountRef(reservation.customerId);
    const accountSnap = await tx.get(account as any);
    const accountData = accountSnap.exists ? accountSnap.data() : {};
    const entries: Record<string, any> =
      accountData?.reservations &&
      typeof accountData.reservations === "object" &&
      !Array.isArray(accountData.reservations)
        ? { ...accountData.reservations }
        : {};
    // Removing the entry is what actually returns the availability.
    delete entries[coinReservationId(razorpayOrderId)];

    tx.set(
      ref as any,
      {
        status: "released",
        releasedAtMs: Date.now(),
        releaseReason: params.reason || "unknown",
      },
      { merge: true }
    );
    tx.set(
      account as any,
      { customerId: reservation.customerId, reservations: entries },
      { merge: true }
    );
    return { released: true, coins: reservation.coins };
  });
}

/**
 * Consumes a reservation on capture, in the transaction that records the debit
 * ledger row. Returns the coins to debit — or 0 when there is no live
 * reservation (nothing redeemed, already consumed, or released while the
 * payment was in flight — in which case the customer must NOT be charged
 * coins for a discount the system already withdrew).
 */
export function consumeReservedCoinsInTx(
  tx: any,
  reservation: CoinReservation
): CoinReservation {
  const consumed: CoinReservation = {
    ...reservation,
    status: "consumed",
    consumedAtMs: Date.now(),
  };
  tx.set(
    db.collection(COIN_RESERVATIONS).doc(coinReservationId(reservation.razorpayOrderId)) as any,
    consumed,
    { merge: true }
  );
  return consumed;
}

/**
 * Drops a consumed reservation from the customer's aggregate. Caller supplies
 * the account snapshot it already read so this stays inside one transaction.
 */
export function releaseAccountEntryInTx(
  tx: any,
  reservation: CoinReservation,
  accountData: any
): void {
  const entries: Record<string, any> =
    accountData?.reservations &&
    typeof accountData.reservations === "object" &&
    !Array.isArray(accountData.reservations)
      ? { ...accountData.reservations }
      : {};
  delete entries[coinReservationId(reservation.razorpayOrderId)];
  tx.set(
    accountRef(reservation.customerId) as any,
    { customerId: reservation.customerId, reservations: entries },
    { merge: true }
  );
}

export { accountRef, isLiveReservation, reservationDoc };

/** Test seam parity with the rest of the payments lane. */
export const __coinReservationsCollectionForTests = COIN_RESERVATIONS;
void admin;
