export type PetpoojaGstLiability = "vendor" | "restaurant";

/** The menu, not a client or a global default, defines who remits item GST. */
export function petpoojaGstLiability(gstType: unknown): PetpoojaGstLiability {
  if (gstType === "services") return "vendor";
  if (gstType === "goods") return "restaurant";
  throw new Error("BLOCKED_CONFIGURATION: missing or unknown captured item gst_type");
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

interface FinancialItem {
  final_price: string;
  quantity: string;
  gst_liability: PetpoojaGstLiability;
  item_tax: Array<{ id: string; amount: string }>;
}

export function restaurantLiableItemTax(items: FinancialItem[], taxId: string): number {
  return items.reduce((sum, item) => sum + (item.gst_liability === "restaurant"
    ? item.item_tax.reduce((tax, row) => tax + (row.id === taxId ? paise(row.amount, "item tax") : 0), 0)
    : 0), 0) / 100;
}

/** POS total is restaurant due, separate from the amount charged to the customer. */
export function petpoojaFinancials(input: {
  items: FinancialItem[];
  discount: number;
  packagingFee: number;
  deliveryFee: number;
  customerTotal: number;
  isDelivery: boolean;
  restaurantDelivery: boolean;
  paymentType: string;
}) {
  let itemNet = 0;
  let restaurantGst = 0;
  for (const item of input.items) {
    const quantity = Number(item.quantity);
    if (!Number.isSafeInteger(quantity) || quantity <= 0) {
      throw new Error("BLOCKED_CONFIGURATION: invalid item quantity");
    }
    itemNet += paise(item.final_price, "item final price") * quantity;
    if (item.gst_liability === "restaurant") {
      restaurantGst += item.item_tax.reduce((sum, row) => sum + paise(row.amount, "item tax"), 0);
    } else if (item.gst_liability !== "vendor") {
      throw new Error("BLOCKED_CONFIGURATION: unknown item GST liability");
    }
  }
  const discount = paise(input.discount, "order discount");
  if (discount > itemNet) throw new Error("BLOCKED_CONFIGURATION: discount exceeds item total");
  const packing = paise(input.packagingFee, "packing charge");
  const delivery = paise(input.deliveryFee, "delivery charge");
  const customerTotal = paise(input.customerTotal, "customer total");
  const selfDelivery = input.isDelivery && input.restaurantDelivery;
  const restaurantTotal = itemNet - discount + restaurantGst + packing + (selfDelivery ? delivery : 0);
  if (!Number.isSafeInteger(restaurantTotal)) throw new Error("BLOCKED_CONFIGURATION: unsafe restaurant total");
  return {
    total: (restaurantTotal / 100).toFixed(2),
    enable_delivery: selfDelivery ? 1 : 0,
    collect_cash: ((selfDelivery && input.paymentType === "COD" ? customerTotal : 0) / 100).toFixed(2),
  };
}
