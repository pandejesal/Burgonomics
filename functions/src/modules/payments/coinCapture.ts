import { db } from "../../core/firebase";
import { debitRedeemedCoins } from "../customers/customerCoins";
import {
  coinReservationId,
  isLiveReservation,
  reservationDoc,
  consumeReservedCoinsInTx,
  releaseAccountEntryInTx,
  type CoinReservation,
} from "./coinReservations";

/**
 * P1-H capture step: turn a Grill-Coins RESERVATION into a real debit.
 *
 * `debitRedeemedCoins` alone clamped the debit to the remaining balance, so a
 * discount could be honoured while the coins behind it had been spent on a
 * different order. This consumes the reservation and the balance in ONE
 * transaction, so what is debited is exactly what was reserved.
 *
 * Three outcomes, all honest:
 *  - live reservation  → consume it, then debit those exact coins;
 *  - already consumed  → no-op (the deterministic ledger row replays);
 *  - released/absent   → debit NOTHING and report `reservation_released`: the
 *    coins were handed back (expired intent / cancelled order) while the
 *    payment was in flight, and taking them now would punish the customer for
 *    a race the system caused. The caller compensates with the automatic
 *    refund path (P1-C) when a discount can no longer be funded.
 *
 * UNREACHABLE AT LAUNCH (D31-D33): checkout refuses any redemption, no
 * reservation is created, and nothing on the payment lane calls this. Kept
 * beside the reservation module for a future, explicitly enabled launch.
 */
export async function debitRedeemedCoinsIfReserved(input: {
  customerId: string;
  orderId: string;
  razorpayOrderId: string;
  /** Fallback when the customer's intent carried no reservation record. */
  coins?: number;
}): Promise<{
  debited: number;
  balanceAfter: number;
  alreadyDone: boolean;
  reason: "debited" | "nothing_reserved" | "reservation_released" | "guest";
}> {
  const { customerId, orderId, razorpayOrderId } = input;
  if (!customerId || customerId === "guest") {
    return { debited: 0, balanceAfter: 0, alreadyDone: true, reason: "guest" };
  }
  if (!razorpayOrderId) {
    return { debited: 0, balanceAfter: 0, alreadyDone: true, reason: "nothing_reserved" };
  }

  const reservationRef = db
    .collection("coin_reservations")
    .doc(coinReservationId(razorpayOrderId));

  const outcome = await db.runTransaction(async (tx: any) => {
    const snap = await tx.get(reservationRef as any);
    const reservation: CoinReservation | null = snap.exists
      ? reservationDoc(snap.data() as any)
      : null;

    if (!reservation) {
      // No reservation: the old free-form path (legacy intent) still holds a
      // redeemable amount — debit it so a discount is never free.
      return { decision: "legacy" as const, coins: Math.floor(Number(input.coins) || 0) };
    }
    if (reservation.status === "consumed") {
      return { decision: "already" as const, coins: reservation.coins };
    }
    if (reservation.status !== "reserved" || !isLiveReservation(reservation, Date.now())) {
      // Released, or never completed: nothing to take.
      return { decision: "released" as const, coins: 0 };
    }
    consumeReservedCoinsInTx(tx, reservation);
    // The account entry is removed with a field delete, so no account read is
    // needed here any more.
    releaseAccountEntryInTx(tx, reservation);
    return { decision: "consume" as const, coins: reservation.coins };
  });

  if (outcome.decision === "released") {
    return { debited: 0, balanceAfter: 0, alreadyDone: true, reason: "reservation_released" };
  }
  if (outcome.coins <= 0) {
    return { debited: 0, balanceAfter: 0, alreadyDone: true, reason: "nothing_reserved" };
  }
  if (outcome.decision === "already") {
    // Deterministic ledger row already exists; `debitRedeemedCoins` replays it.
    const replay = await debitRedeemedCoins({
      customerId,
      coins: outcome.coins,
      orderId,
      razorpayOrderId,
    });
    return { ...replay, reason: "debited" as const };
  }

  const debit = await debitRedeemedCoins({
    customerId,
    coins: outcome.coins,
    orderId,
    razorpayOrderId,
  });
  return { ...debit, reason: "debited" as const };
}

export type RedeemedCoinFundingOutcome =
  | { outcome: "no_redemption" }
  | { outcome: "funded"; coins: number; reacquired: boolean }
  | { outcome: "unfunded"; coins: number };

/**
 * P1-H/P1-I money gate: prove the Gril-Coins behind a captured discount are
 * still fundable BEFORE the order is fulfilled.
 *
 * The intent stays payable for 24h and a reservation can be released inside
 * that window (cancelled attempt, crashed checkout, an old 40-minute
 * reservation). Fulfilling anyway would hand out a discount the customer never
 * paid for. So a released reservation is RE-ACQUIRED against the live balance
 * and debited; only when the coins are genuinely gone does this report
 * `unfunded`, and the caller compensates with a full automatic refund instead
 * of fulfilling.
 */
export async function ensureRedeemedCoinsFunded(input: {
  razorpayOrderId: string;
  orderId: string;
}): Promise<RedeemedCoinFundingOutcome> {
  const { razorpayOrderId, orderId } = input;
  if (!razorpayOrderId || !orderId) return { outcome: "no_redemption" };

  const { resolveIntentRedemption } = await import("./razorpay.service");
  const redemption = await resolveIntentRedemption(razorpayOrderId);
  if (!redemption) return { outcome: "no_redemption" };

  const first = await debitRedeemedCoinsIfReserved({
    customerId: redemption.customerId,
    orderId,
    razorpayOrderId,
    coins: redemption.coins,
  });
  if (first.reason !== "reservation_released") {
    return { outcome: "funded", coins: first.debited, reacquired: false };
  }

  // The funding was handed back while the payment was in flight. Re-acquire
  // exactly the coins the discount is worth, if the customer still has them.
  const { reserveRedeemedCoins } = await import("./coinReservations");
  try {
    await reserveRedeemedCoins({
      customerId: redemption.customerId,
      coins: redemption.coins,
      orderId,
      razorpayOrderId,
    });
  } catch (err: any) {
    return { outcome: "unfunded", coins: redemption.coins };
  }
  const second = await debitRedeemedCoinsIfReserved({
    customerId: redemption.customerId,
    orderId,
    razorpayOrderId,
    coins: redemption.coins,
  });
  if (second.reason === "debited" && second.debited > 0) {
    return { outcome: "funded", coins: second.debited, reacquired: true };
  }
  if (second.reason === "debited" && second.alreadyDone) {
    return { outcome: "funded", coins: redemption.coins, reacquired: true };
  }
  return { outcome: "unfunded", coins: redemption.coins };
}
