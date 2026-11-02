/**
 * Petpooja financial primitives.
 *
 * SUPERSEDED RULE — Petpooja's binding 2 November 2026 ruling (vendor review of
 * our sandbox orders) replaces the internal 2026-10-31 "restaurant due"
 * decision for `total`:
 *   "If these orders have delivery_charges then they should be included in the
 *    total. Also if there is any GST in delivery charges then they should also
 *    be added in the total_tax key and the total key as well. Same goes with
 *    packing charge and its GST."
 *   "in a COD order this [collect_cash] key must match total."
 *
 * So `total` is the amount the CUSTOMER pays for this order at the outlet:
 * items + their GST (only when the menu prices are ex-GST) + packing +
 * delivery + any GST charged on packing/delivery. `enable_delivery` still
 * distinguishes who delivers (0 = third-party courier, 1 = our own rider).
 *
 * Tax shape follows the same ruling: a GST-INCLUSIVE line carries NO item_tax
 * at all (the key is omitted), and the bottom Tax block only ever describes
 * FOOD GST that was actually added — i.e. the lines of a non-inclusive menu.
 * `tax_total` is that food GST (exclusive menus only) plus any GST charged on
 * delivery/packing, which our pricing engine currently charges none of
 * (`dc_tax_percentage` / `pc_tax_percentage` are 0). The internal rule stands:
 * menu prices are GST-inclusive and GST is never added on top of food.
 *
 * The vendor's written liability instruction controls: all GST is
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
  /**
   * Omitted entirely for GST-inclusive lines (vendor ruling 2026-11-02: "item_tax
   * should not be calculated and avoided" for those items).
   */
  item_tax?: Array<{ id: string; amount: string }>;
}

/** The restaurant-liable share of one tax row, in rupees (vendor shape). */
export function restaurantLiableItemTax(items: FinancialItem[], taxId: string): number {
  return items.reduce((sum, item) => sum +
    (item.item_tax || []).reduce((tax, row) => tax + (row.id === taxId ? paise(row.amount, "item tax") : 0), 0), 0) / 100;
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
  /**
   * GST charged on the delivery + packing charges, in rupees. Our pricing
   * engine charges none (`dc_tax_percentage`/`pc_tax_percentage` are 0); the
   * value is threaded so the vendor rule ("add charge GST to total_tax and
   * total") stays expressible and the three figures can never drift apart.
   */
  chargeTax?: number;
}

export interface PetpoojaFinancials {
  /** Amount collected for this order, including delivery + packing (+ their GST). */
  total: string;
  /** FOOD GST actually added (exclusive menus only) plus charge GST. */
  taxTotal: string;
  enable_delivery: number;
  collect_cash: string;
}

/**
 * POS financials per Petpooja's binding 2 November 2026 ruling.
 *
 * `total` = item final amounts - order discount
 *         + item GST (ONLY when the menu prices are ex-GST)
 *         + packing + delivery + charge GST.
 * COD collects exactly `total`; prepaid online collects nothing at the counter.
 * `enable_delivery` is 1 only when the restaurant's own rider delivers.
 */
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
    itemTax += (item.item_tax || []).reduce(
      (sum, row) => sum + paise(row.amount, "item tax"), 0
    );
  }

  const discount = paise(input.discount, "order discount");
  if (discount > itemNet) {
    throw new Error("BLOCKED_CONFIGURATION: discount exceeds item total");
  }
  const packing = paise(input.packagingFee, "packing charge");
  const delivery = paise(input.deliveryFee, "delivery charge");
  const chargeTax = paise(input.chargeTax ?? 0, "charge tax");
  paise(input.customerTotal, "customer total");

  // An inclusive line already contains its GST, so only an exclusive menu adds
  // item tax on top. Charge GST (delivery/packing) is always on top of the fee.
  const addedItemTax = input.taxIncluded ? 0 : itemTax;
  const total = itemNet - discount + addedItemTax + packing + delivery + chargeTax;
  const taxTotal = addedItemTax + chargeTax;

  if (!Number.isSafeInteger(total) || total < 0) {
    throw new Error("BLOCKED_CONFIGURATION: unsafe order total");
  }
  if (!Number.isSafeInteger(taxTotal) || taxTotal < 0) {
    throw new Error("BLOCKED_CONFIGURATION: unsafe tax total");
  }

  return {
    total: (total / 100).toFixed(2),
    taxTotal: (taxTotal / 100).toFixed(2),
    enable_delivery: input.isDelivery && input.restaurantDelivery ? 1 : 0,
    // Vendor ruling: on a COD order collect_cash MUST equal total exactly, in
    // the same 2dp string form. Prepaid (ONLINE) collects nothing at the door.
    collect_cash: ((input.paymentType === "COD" ? total : 0) / 100).toFixed(2),
  };
}
