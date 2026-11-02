import { db } from "../../core/firebase";
import { debitRedeemedCoins } from "../customers/customerCoins";
import {
  coinReservationId,
  isLiveReservation,
  reservationDoc,
  consumeReservedCoinsInTx,
  releaseAccountEntryInTx,
  accountRef,
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
    const account = accountRef(reservation.customerId);
    const accountSnap = await tx.get(account as any);
    consumeReservedCoinsInTx(tx, reservation);
    releaseAccountEntryInTx(
      tx,
      reservation,
      accountSnap.exists ? accountSnap.data() : {}
    );
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
