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
 * The vendor's written 28 October instruction controls liability: all GST is
 * restaurant-liable. Captured gst_type is metadata, not wire authority.
 *
 * All arithmetic is integer paise; every output is a 2dp string, the vendor's
 * shape for money.
 */

export type PetpoojaGstLiability = "vendor" | "restaurant";

/** Written vendor instruction overrides the menu's services/goods inference. */
export function petpoojaGstLiability(_gstType: unknown): PetpoojaGstLiability {
  return "restaurant";
}

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
  /** Absent means restaurant-liable (our menu, R4); unknown values block. */
  gst_liability?: PetpoojaGstLiability;
  item_tax: Array<{ id: string; amount: string }>;
}

/** The restaurant-liable share of one tax row, in rupees (vendor shape). */
export function restaurantLiableItemTax(items: FinancialItem[], taxId: string): number {
  return items.reduce((sum, item) => sum +
    item.item_tax.reduce((tax, row) => tax + (row.id === taxId ? paise(row.amount, "item tax") : 0), 0), 0) / 100;
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

/** POS total is restaurant due, separate from the amount charged to the customer. */
export function petpoojaFinancials(input: PetpoojaFinancialInput): PetpoojaFinancials {
  let itemNet = 0;
  let itemTax = 0;
  for (const item of input.items) {
    const quantity = Number(item.quantity);
    if (!Number.isSafeInteger(quantity) || quantity <= 0) {
      throw new Error("BLOCKED_CONFIGURATION: invalid item quantity");
    }
    if (
      item.gst_liability !== undefined &&
      item.gst_liability !== "vendor" &&
      item.gst_liability !== "restaurant"
    ) {
      throw new Error("BLOCKED_CONFIGURATION: unknown item GST liability");
    }
    itemNet += paise(item.final_price, "item final price") * quantity;
    // All tax belongs to the restaurant, including stale vendor-labelled input.
    itemTax += item.item_tax.reduce(
      (sum, row) => sum + paise(row.amount, "item tax"), 0
    );
  }

  const discount = paise(input.discount, "order discount");
  if (discount > itemNet) {
    throw new Error("BLOCKED_CONFIGURATION: discount exceeds item total");
  }
  const packing = paise(input.packagingFee, "packing charge");
  const delivery = paise(input.deliveryFee, "delivery charge");
  paise(input.customerTotal, "customer total");

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
    // Vendor instruction: COD cash equals restaurant total, including pickup.
    collect_cash: (
      (input.paymentType === "COD" ? restaurantTotal : 0) / 100
    ).toFixed(2),
  };
}
