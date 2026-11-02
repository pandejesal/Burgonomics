/**
 * Grill-Coins lifetime contract (one place, so two clocks can never drift).
 *
 * Redemption is DISABLED for launch (D31-D33 / OPEN-EARN-1): the customer app
 * pins `loyaltyPointsToRedeem` to 0 and checkout refuses a non-zero request with
 * `COIN_REDEMPTION_DISABLED`. No intent therefore carries a coin discount, so no
 * reservation is created and there is no funding window to align.
 *
 * The numbers below are retained because the reservation module is also retained
 * (deliberately unreachable, see `coinReservations.ts`) for a future, explicitly
 * enabled launch. If that launch happens, the invariant holds: a payable intent
 * must never outlive the coin funding behind it, so a reservation lives at least
 * as long as the intent it funds — the old 40-minute reservation against a
 * 24-hour intent let funding expire while the discount stayed payable.
 */

/** How long a server-written payment intent stays reusable/payable. */
export const PAYMENT_INTENT_TTL_MS = 24 * 60 * 60 * 1000;

/** Slack so clock skew or a slow intent write can never expire first. */
export const COIN_RESERVATION_SLACK_MS = 60 * 60 * 1000;

/** A reservation is live for the whole payable life of its intent. */
export const COIN_RESERVATION_TTL_MS = PAYMENT_INTENT_TTL_MS + COIN_RESERVATION_SLACK_MS;

/**
 * The app's real Grill-Coins value: 1 coin = ₹1 of discount (the pricing engine
 * caps a redemption at 20% of the food subtotal). Every future reserve/debit
 * calculation must go through this, never the pre-capping request count.
 */
export const GRILL_COIN_VALUE_RUPEES = 1;

/**
 * Coins backing a rupee discount. `pricing.loyaltyDiscount` is the authority for
 * how many coins a capture may take (ask 100 on a ₹100 cart and the engine caps
 * the discount at ₹20, so exactly 20 coins — not 100 — may be debited).
 *
 * Uncalled today: redemption is refused before pricing can apply a discount.
 * Kept beside the value constant so re-enabling cannot reintroduce the
 * request-count bug.
 */
export function coinsForDiscountRupees(discountRupees: number): number {
  const rupees = Number(discountRupees);
  if (!Number.isFinite(rupees) || rupees <= 0) return 0;
  const value = GRILL_COIN_VALUE_RUPEES > 0 ? GRILL_COIN_VALUE_RUPEES : 1;
  return Math.max(0, Math.floor(rupees / value));
}
