/**
 * Petpooja "restaurant due" financials (corrected rule R4, owner decision
 * 2026-10-31, adapted from 36cdd6b:functions/src/modules/petpooja/financials.ts).
 *
 * The vendor's `total` is what the RESTAURANT is owed, not what the customer
 * paid. The vendor contract requires `total` to contain `tax_total`; a
 * third-party courier fee (Borzo/Shadowfax/Porter) is NOT restaurant revenue,
 * so it stays in `delivery_charges` and out of `total`.
 *
 * Adaptation for this branch: our menu prices are GST-INCLUSIVE (R1/R4), so the
 * per-unit `final_price` already carries its tax and the item net must not have
 * `tax_total` added a second time. 36cdd6b ran with `tax_inclusive: false`,
 * where adding it was correct. `taxIncluded` keeps both shapes honest and
 * defaults to nothing — the caller must say which world it is in.
 *
 * All arithmetic is integer paise; every output is a 2dp string, the vendor's
 * shape for money.
 */

function paise(value: number | string, field: string): number {
  if (value === "" || typeof value === "boolean" || value == null) {
    throw new Error(`BLOCKED_CONFIGURATION: invalid ${field}`);
  }
  const amount = Number(value);
  const minor = Math.round(amount * 100);
  if (!Number.isFinite(amount) || amount < 0 || !Number.isSafeInteger(minor)) {
    throw new Error(`BLOCKED_CONFIGURATION: invalid ${field}`);
  }
  return minor;
}

export interface FinancialItem {
  final_price: string;
  quantity: string;
  item_tax: Array<{ id: string; amount: string }>;
}

export interface PetpoojaFinancialInput {
  items: FinancialItem[];
  discount: number;
  packagingFee: number;
  deliveryFee: number;
  customerTotal: number;
  isDelivery: boolean;
  /** True only when the restaurant delivers it itself (in-house rider). */
  restaurantDelivery: boolean;
  paymentType: string;
  /** True when `final_price` already contains GST (our menu prices do). */
  taxIncluded: boolean;
}

export interface PetpoojaFinancials {
  total: string;
  enable_delivery: number;
  collect_cash: string;
}

export function petpoojaFinancials(input: PetpoojaFinancialInput): PetpoojaFinancials {
  let itemNet = 0;
  let itemTax = 0;
  for (const item of input.items) {
    const quantity = Number(item.quantity);
    if (!Number.isSafeInteger(quantity) || quantity <= 0) {
      throw new Error("BLOCKED_CONFIGURATION: invalid item quantity");
    }
    itemNet += paise(item.final_price, "item final price") * quantity;
    itemTax += item.item_tax.reduce(
      (sum, row) => sum + paise(row.amount, "item tax"),
      0
    );
  }

  const discount = paise(input.discount, "order discount");
  if (discount > itemNet) {
    throw new Error("BLOCKED_CONFIGURATION: discount exceeds item total");
  }
  const packing = paise(input.packagingFee, "packing charge");
  const delivery = paise(input.deliveryFee, "delivery charge");
  const customerTotal = paise(input.customerTotal, "customer total");

  // A courier order is NOT self-delivery: the fee is the courier's, so it is
  // reported in delivery_charges and excluded from the restaurant due.
  const selfDelivery = input.isDelivery && input.restaurantDelivery;
  const restaurantTotal =
    itemNet -
    discount +
    (input.taxIncluded ? 0 : itemTax) +
    packing +
    (selfDelivery ? delivery : 0);

  if (!Number.isSafeInteger(restaurantTotal) || restaurantTotal < 0) {
    throw new Error("BLOCKED_CONFIGURATION: unsafe restaurant total");
  }

  return {
    total: (restaurantTotal / 100).toFixed(2),
    enable_delivery: selfDelivery ? 1 : 0,
    // Cash is collected by the restaurant only when its own rider hands over.
    collect_cash: (
      (selfDelivery && input.paymentType === "COD" ? customerTotal : 0) / 100
    ).toFixed(2),
  };
}
