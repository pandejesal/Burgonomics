/**
 * P1-H lifetime contract (one place, so the two clocks can never drift).
 *
 * A Razorpay order stays payable for its whole TTL. Grill-Coins are RESERVED
 * while that order is payable, so the reservation must live *at least* as long
 * as the intent it funds. The old 40-minute reservation against a 24-hour
 * intent let the funding expire while the discount stayed payable: the customer
 * re-used those coins elsewhere, then paid the old discounted intent and
 * verification only logged the missing debit and fulfilled anyway.
 *
 * The reservation now outlives the intent by an hour of slack: there is no
 * moment at which a payable intent has no live coin funding behind it.
 */

/** How long a server-written payment intent stays reusable/payable. */
export const PAYMENT_INTENT_TTL_MS = 24 * 60 * 60 * 1000;

/** Slack so clock skew or a slow intent write can never expire first. */
export const COIN_RESERVATION_SLACK_MS = 60 * 60 * 1000;

/** A reservation is live for the whole payable life of its intent. */
export const COIN_RESERVATION_TTL_MS = PAYMENT_INTENT_TTL_MS + COIN_RESERVATION_SLACK_MS;

/**
 * The app's real Grill-Coins value: 1 coin = ₹1 of discount (pricing engine
 * caps the redemption at 20% of the food subtotal). Reserve/debit math always
 * goes through this, so a future revaluation changes both sides together.
 */
export const GRILL_COIN_VALUE_RUPEES = 1;

/**
 * Coins backing a rupee discount. The pricing engine reports `loyaltyDiscount`
 * in rupees, which IS the authority for how many coins a capture may take —
 * never the pre-pricing request count (a request for 100 coins against a
 * ₹100 cart is capped to ₹20 of discount, so exactly 20 coins may be debited).
 */
export function coinsForDiscountRupees(discountRupees: number): number {
  const rupees = Number(discountRupees);
  if (!Number.isFinite(rupees) || rupees <= 0) return 0;
  const value = GRILL_COIN_VALUE_RUPEES > 0 ? GRILL_COIN_VALUE_RUPEES : 1;
  return Math.max(0, Math.floor(rupees / value));
}
