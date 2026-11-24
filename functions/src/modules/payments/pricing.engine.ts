import { db } from "../../core/firebase";
import {
  computePackagingFee,
  resolveBranchPricingConfig,
  resolvePackagingFeeSnapshot,
  type BranchPricingConfig,
} from "./branchPricing";
// ONE coupon formula. The discount is not computed here any more: it is the
// coupon authority's answer, so a preview and the charge cannot disagree.
import {
  evaluateCoupon,
  normalizeCoupon,
  normalizeCouponCustomer,
  readCouponUsage,
} from "../coupons/couponAuthority";

export interface PricingLineItem {
  id: string;
  productId?: string;
  name: string;
  price: number;
  quantity: number;
  /** Cooking instruction; the pricing engine does not use free text. */
  notes?: string;
  customizations?: Array<{ id: string; name: string; price: number }>;
  modifiers?: Array<{ id: string; name: string; priceDelta: number }>;
}

export interface CalculateOrderPricingInput {
  items: PricingLineItem[];
  branchId: string;
  orderType: "delivery" | "takeaway" | "dinein";
  /**
   * IGNORED. A request body may still carry it (old clients do), but the
   * customer-facing fee is the SERVER-persisted courier quote: see
   * `serverDeliveryFee`. Reading this field is how a client used to set its own
   * delivery price.
   */
  deliveryFee?: number;
  /**
   * SERVER-ONLY. The fee from the persisted `delivery_fee_quotes` document
   * (R5/R6). No HTTP route maps any request field onto this; only
   * `createPaymentOrder` and `repriceOrderForVerification` may supply it.
   */
  serverDeliveryFee?: number;
  /** Client-supplied packaging — IGNORED. The branch config is the source. */
  packagingFee?: number;
  /**
   * SERVER-ONLY. Packaging locked from a server-written pricing snapshot
   * (R7 repricing), so a branch config edit between pricing and verification
   * cannot move a total the customer already agreed to.
   */
  serverPackagingFee?: number;
  couponCode?: string;
  /**
   * The customer the per-customer coupon limit applies to. Optional: a walk-in
   * or guest checkout has none, and a customer-scoped coupon then simply
   * refuses (it was issued to somebody).
   */
  customerId?: string | null;
  loyaltyPointsToRedeem?: number;
}

export interface PricingBreakdown {
  foodSubtotal: number;
  packagingFee: number;
  deliveryFee: number;
  /** GST INCLUDED in the menu prices — reported, never added (R1). */
  gst: number;
  /** Half of `gst`, rounded in paise; `cgst + sgst === gst` exactly. */
  cgst: number;
  sgst: number;
  discount: number;
  loyaltyDiscount: number;
  grandTotal: number;
  /** True when pricing used a default input (no branchId → default packaging).
   *  Catalog read failures refuse with 503; they never degrade to a client price. */
  pricingDegraded: boolean;
  split: {
    /**
     * F3 (owner decision 2026-11-01): the courier fee the customer paid stays
     * with the brand (one Borzo account pays every courier), so it is NOT
     * branch earnings. 0 off-delivery.
     */
    courierFeePaise: number;
    /** Branch earnings on this order (grand total minus the courier fee). */
    branchTransferPaise: number;
    /** The charged total in paise (kept so the split always reconciles). */
    totalAmountPaise: number;
  };
}

/**
 * Owner decision 2026-10-31: menu prices are GST-inclusive. The GST share of an
 * inclusive amount at rate r is amount·r/(1+r) — NOT amount·r.
 */
export const GST_RATE = 0.05;

/** Round to whole paise (2 decimals). */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}


/**
 * Computes unit price for a single line item including customizations and modifiers.
 */
export function computeItemUnitPrice(item: PricingLineItem): number {
  let unitPrice = Number(item.price) || 0;

  if (Array.isArray(item.customizations)) {
    for (const c of item.customizations) {
      // Loop 3: addon deltas are never negative — a tampered client item
      // must not discount via negative customizations (use coupons).
      unitPrice += Math.max(0, Number(c.price) || 0);
    }
  }

  if (Array.isArray(item.modifiers)) {
    for (const m of item.modifiers) {
      unitPrice += Math.max(0, Number(m.priceDelta) || 0);
    }
  }

  return Math.max(0, unitPrice);
}

/** Branch config (royalty/packaging) lives in the shared helper. */
/**
 * PAY-16: builds { optionId → catalog price } from a product document's
 * `customizations` groups (the exact data the customer app maps in
 * menuService.mapToCustomizationGroups). Returns null when the product carries
 * no option data AT ALL, which makes any selection on it unpriceable.
 */
export function catalogOptionPrices(
  productCustomizations: any[] | undefined
): Map<string, number> | null {
  if (!Array.isArray(productCustomizations)) return null;
  const prices = new Map<string, number>();
  for (const group of productCustomizations) {
    const options = Array.isArray(group?.options) ? group.options : [];
    for (const option of options) {
      const id = String(option?.id ?? option?.optionId ?? "").trim();
      if (!id) continue;
      const raw = option?.price;
      const price = typeof raw === "number" ? raw : Number(raw ?? 0);
      prices.set(id, Number.isFinite(price) ? price : NaN);
    }
  }
  return prices;
}

function itemOptionUnverified(itemName: string, detail: string): Error {
  const err: any = new Error(
    `${itemName} has an option that could not be verified against the menu — please refresh your cart and try again (${detail}).`
  );
  err.statusCode = 422;
  err.code = "ITEM_OPTION_UNVERIFIED";
  return err;
}

function itemOptionError(code: string, itemName: string, detail: string): Error {
  const err: any = new Error(`${itemName}: ${detail}`);
  err.statusCode = 422;
  err.code = code;
  return err;
}

/**
 * M2a: the SERVER enforces the product's own selection rules, so a tampered
 * client cannot skip a required variation and pay the base price, stack more
 * options than a group allows, or pick an unavailable option.
 *
 * The customer app enforces the same limits (ProductCustomizerModal:
 * required groups block Add-to-cart, multi-select is capped at maxSelect, and
 * out-of-stock options are disabled), so an honest order is never refused.
 *
 * No customizations on the product → nothing to enforce.
 */
export function validateOptionSelections(
  item: PricingLineItem,
  productCustomizations?: any[]
): void {
  if (!Array.isArray(productCustomizations)) return;
  const itemName = String((item as any)?.name || "An item");

  const selectedIds = new Set<string>();
  for (const c of item.customizations || []) {
    const id = String(c?.id ?? (c as any)?.optionId ?? "").trim();
    if (id) selectedIds.add(id);
  }
  for (const m of item.modifiers || []) {
    const id = String(m?.id ?? (m as any)?.optionId ?? "").trim();
    if (id) selectedIds.add(id);
  }

  for (const group of productCustomizations) {
    if (!group || typeof group !== "object") continue;
    const options: any[] = Array.isArray(group.options) ? group.options : [];
    const groupId = String(group.id ?? "");
    const selectedInGroup = options.filter((option) =>
      selectedIds.has(String(option?.id ?? "").trim())
    );

    const minSelections = Number(group.minSelections) || 0;
    const required = minSelections > 0 || group.required === true;
    if (required && selectedInGroup.length === 0) {
      throw itemOptionError(
        "ITEM_OPTION_REQUIRED",
        itemName,
        `a required option group${group.name ? ` "${group.name}"` : ""} has no selection`
      );
    }

    const maxSelections = Number(group.maxSelections);
    if (
      Number.isFinite(maxSelections) &&
      maxSelections > 0 &&
      selectedInGroup.length > maxSelections
    ) {
      throw itemOptionError(
        "ITEM_OPTION_LIMIT",
        itemName,
        `option group${group.name ? ` "${group.name}"` : ""} allows ${maxSelections} selection(s), got ${selectedInGroup.length}`
      );
    }

    for (const option of selectedInGroup) {
      if (option?.isAvailable === false) {
        throw itemOptionError(
          "ITEM_OPTION_UNAVAILABLE",
          itemName,
          `option "${String(option?.name ?? option?.id ?? "")}" is not available`
        );
      }
    }
    void groupId;
  }
}

/**
 * Unit price for a line from its AUTHORITATIVE catalog price plus its own
 * add-on deltas (the engine's own rule). Exported for the POS relay (POS-11),
 * which must price lines from the same source instead of the order document.
 *
 * PAY-16: the add-on deltas come from the CATALOG too. Every selected
 * customization/modifier must exist in the product's own option data and is
 * charged the catalog's price; the cart's `price`/`priceDelta` is never read.
 */
export function applyCatalogBasePrice(
  item: PricingLineItem,
  catalogPrice: number,
  productCustomizations?: any[]
): number {
  let base = catalogPrice;
  const selections: Array<{ id: string; kind: string; label: string }> = [];
  if (Array.isArray(item.customizations)) {
    for (const c of item.customizations) {
      selections.push({
        id: String(c?.id ?? (c as any)?.optionId ?? "").trim(),
        kind: "customization",
        label: String((c as any)?.name || c?.id || ""),
      });
    }
  }
  if (Array.isArray(item.modifiers)) {
    for (const m of item.modifiers) {
      selections.push({
        id: String(m?.id ?? (m as any)?.optionId ?? "").trim(),
        kind: "modifier",
        label: String((m as any)?.name || m?.id || ""),
      });
    }
  }

  // M2a: enforce required groups, per-group limits and availability whether or
  // NOT the line carries selections — a tampered client could otherwise skip a
  // required variation entirely and pay the base price.
  const itemName = String(item?.name || "An item");
  validateOptionSelections(item, productCustomizations);

  if (selections.length > 0) {
    const optionPrices = catalogOptionPrices(productCustomizations);
    if (!optionPrices) {
      throw itemOptionUnverified(
        itemName,
        `the menu has no option data for this product (selected: ${selections
          .map((s) => s.label || s.id)
          .filter((label) => label !== "")
          .join(", ") || "unnamed option"})`
      );
    }
    for (const selection of selections) {
      if (!selection.id) {
        throw itemOptionUnverified(
          itemName,
          `a ${selection.kind}${selection.label ? ` "${selection.label}"` : ""} has no id`
        );
      }
      const price = optionPrices.get(selection.id);
      if (price === undefined || !Number.isFinite(price)) {
        throw itemOptionUnverified(
          itemName,
          `${selection.kind} "${selection.label || selection.id}" (${selection.id}) is not on the menu`
        );
      }
      if (price < 0) {
        throw itemOptionUnverified(
          itemName,
          `${selection.kind} "${selection.label || selection.id}" has an invalid catalog price`
        );
      }
      base += price;
    }
  }

  return Math.max(0, base);
}

/**
 * Availability-only catalogue probe: is every line in this cart sellable RIGHT
 * NOW?
 *
 * `calculateOrderPricing` is the authoritative price+eligibility gate, but it
 * also needs the full pricing inputs (a delivery needs its persisted courier
 * quote). Re-pricing a reusable intent to *check availability* therefore
 * refused every ordinary delivery retry with DELIVERY_FEE_REQUIRED — a
 * customer-facing outage caused by a safety check. This probe re-reads the
 * SAME catalogue documents (`products/{id}`) with the SAME fail-closed rule
 * the engine applies (only an explicit `inStock === true` is sellable) and
 * raises the SAME typed `ITEM_UNAVAILABLE` refusal, without touching money.
 *
 * A catalogue read FAILURE is an outage, not unavailability: it is refused with
 * a retryable 503 so a Firestore blip can never cancel a customer's checkout.
 */
export async function assertCatalogLinesSellable(items: any[]): Promise<void> {
  const lines = Array.isArray(items) ? items : [];
  const wanted = [
    ...new Set(
      lines
        .map((item) => String((item as any)?.productId ?? (item as any)?.id ?? "").trim())
        .filter((id) => id.length > 0)
    ),
  ];
  if (wanted.length === 0 || !db || typeof db.collection !== "function") return;

  const availability = new Map<string, unknown>();
  try {
    if (typeof (db as any).getAll === "function") {
      try {
        const snaps = await (db as any).getAll(
          ...wanted.map((id) => db.collection("products").doc(id))
        );
        for (const snap of snaps) {
          if (snap?.exists) availability.set(snap.id, (snap.data() as any)?.inStock);
        }
      } catch {
        availability.clear();
        for (const id of wanted) {
          const snap = await db.collection("products").doc(id).get();
          if (snap?.exists) availability.set(id, (snap.data() as any)?.inStock);
        }
      }
    } else {
      for (const id of wanted) {
        const snap = await db.collection("products").doc(id).get();
        if (snap?.exists) availability.set(id, (snap.data() as any)?.inStock);
      }
    }
  } catch (err: any) {
    const { captureErrorSnapshot } = await import("../../core/errors").catch(() => ({
      captureErrorSnapshot: async () => {},
    }));
    await captureErrorSnapshot({
      source: "payments",
      severity: "high",
      message: `Availability recheck failed for a payable intent (${wanted.length} lines) — refused, retryable`,
      errorStack: err?.stack,
    }).catch(() => undefined);
    const outage: any = new Error(
      "Menu availability could not be verified — please retry checkout."
    );
    outage.statusCode = 503;
    outage.code = "MENU_AVAILABILITY_UNAVAILABLE";
    throw outage;
  }

  for (const id of wanted) {
    // A product doc we have no price eligibility proof for is NOT silently
    // sellable: the engine refuses that case too (ITEM_PRICE_UNVERIFIED). Here
    // only a recorded 86 (explicit `inStock: false`) is proven unavailability;
    // a genuinely missing doc keeps the engine's own typed refusal on the fresh
    // path and is not converted into a false "86'd" here.
    if (availability.get(id) === false) {
      const item = lines.find(
        (line) =>
          String((line as any)?.productId ?? (line as any)?.id ?? "").trim() === id
      );
      const unavailable: any = new Error(
        `${String((item as any)?.name || "An item")} is no longer available — please review your cart.`
      );
      unavailable.statusCode = 409;
      unavailable.code = "ITEM_UNAVAILABLE";
      throw unavailable;
    }
  }
}

/* ------------------------------------------------------------------------- *
 * Snapshot pricing seam (walk-in create transaction, R1 scope)
 * ------------------------------------------------------------------------- */

/**
 * A product document as read INSIDE the caller's Firestore transaction.
 *
 * The caller owns the read so the total it writes is computed from the SAME
 * snapshot it verified — no cache, no second read, no drift between "what we
 * checked" and "what we charged".
 */
export interface SnapshotProduct {
  /** Catalogue price in rupees, GST-inclusive. Must be finite and >= 0. */
  price: number;
  /** Sellable ONLY when explicitly `true` — the engine's fail-closed rule. */
  inStock: unknown;
  /** The product's own option groups, when the doc carries them (PAY-16). */
  customizations?: any[];
}

export interface SnapshotPricingInput {
  items: PricingLineItem[];
  orderType: "delivery" | "takeaway" | "dinein";
  /** Products read in the caller's transaction, keyed by product id. */
  products: ReadonlyMap<string, SnapshotProduct>;
  /** Branch pricing config read in the SAME transaction. Required. */
  branchConfig: BranchPricingConfig | null;
  /** Branch id — coupon eligibility only. Membership is the route's check. */
  branchId?: string;
  /** Coupon document read in the same transaction, when the order carries one. */
  coupon?: any | null;
  /**
   * Committed + live-reserved redemptions, read from the coupon authority's
   * counters in the same snapshot as `coupon`. Absent means "unknown", which
   * the authority treats as zero usage — the caller that RESERVES the slot
   * (`reserveCouponInTx`) is the one that enforces the cap atomically.
   */
  couponUsage?: { totalUsed?: number; customerUsed?: number };
  /** Customer whose per-customer limit applies. */
  customerId?: string | null;
  loyaltyPointsToRedeem?: number;
  /** R7: a server-locked packaging fee (repricing an agreed total). */
  packagingFeeOverride?: number;
  /** SERVER-ONLY: the persisted courier quote for a delivery. */
  serverDeliveryFee?: number;
  /** Clock for coupon expiry; no I/O either way. Defaults to Date.now(). */
  nowMs?: number;
}

export interface SnapshotPricingResult extends PricingBreakdown {
  /**
   * True when the branch's Petpooja packaging was not understood and a
   * fallback fee was used. This seam never writes, so a caller that wants the
   * warning records it AFTER its transaction commits.
   */
  packagingUsedFallback: boolean;
}

function pricingInputError(statusCode: number, code: string, message: string): Error {
  const err: any = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  return err;
}

/**
 * Defense in depth behind the zod schema (direct callers bypass routes):
 * reject unpriceable items instead of coercing them (qty 0 → phantom +1,
 * price "abc" → free item — both real over/under-charge vectors).
 * Shared by the live engine and the snapshot seam so both refuse identically.
 */
function assertPriceableItems(items: PricingLineItem[]): void {
  if (!Array.isArray(items) || items.length === 0 || items.length > 100) {
    const err: any = new Error("Order must contain 1–100 items.");
    err.statusCode = 400;
    throw err;
  }
  for (const item of items) {
    const price = Number((item as any)?.price);
    const qty = Number((item as any)?.quantity);
    if (!Number.isFinite(price) || price < 0 || price > 100000 || !Number.isInteger(qty) || qty < 1 || qty > 99) {
      const err: any = new Error(`Invalid item in order (price and quantity 1–99 required): ${(item as any)?.productId || (item as any)?.id || "unknown"}.`);
      err.statusCode = 400;
      throw err;
    }
  }
}

/**
 * Coupon discount from a document the caller already read. Pure: the clock and
 * the usage counters are passed in.
 *
 * This is a thin delegate to the coupon authority (`evaluateCoupon`): the
 * canonical rules (active, validity window, branch scope, customer scope,
 * minimum order, per-customer limit, total cap, max discount, percent clamp,
 * floor 0, ceiling at the food subtotal) live in ONE place. The old local
 * implementation read `expiresAt`/`branchId` only, so a coupon written in the
 * canonical shape was silently ignored — the two-authority bug this replaces.
 */
function computeCouponDiscount(
  couponDoc: any,
  foodSubtotal: number,
  branchId: string,
  nowMs: number,
  usage?: { totalUsed?: number; customerUsed?: number },
  customerId?: string | null
): number {
  const coupon = couponDoc
    ? normalizeCoupon(String(couponDoc.code ?? ""), couponDoc)
    : null;
  const evaluation = evaluateCoupon(coupon, {
    foodSubtotal,
    branchId,
    nowMs,
    customerId: normalizeCouponCustomer(customerId),
    totalUsed: usage?.totalUsed,
    customerUsed: usage?.customerUsed,
  });
  return evaluation.discount;
}

/**
 * PURE pricing from a caller-supplied snapshot. No Firestore, no cache, no
 * logging, no provider call — safe to invoke inside a Firestore transaction
 * after it has read `products`, `branches` and (optionally) `coupons`.
 *
 * `calculateOrderPricing` delegates here after doing the reads, so there is
 * exactly ONE money formula: inclusive GST (reported, never added), packaging,
 * coupon and loyalty clamps, paise-exact CGST/SGST split, grand total and the
 * F3 branch/courier split.
 *
 * Fail closed on anything unverifiable: a missing or non-finite catalogue
 * price, a line that is not explicitly `inStock: true`, a missing/invalid
 * branch snapshot, or a delivery without its server courier quote.
 *
 * NOTE for callers building lines from a POS/cart: `items` still pass the
 * shared request-shape guard (a finite `price` 0–100000 and an integer
 * quantity 1–99), but the line's `price` VALUE is never charged — the
 * snapshot's catalogue price is authoritative. Set it to the snapshot price
 * (or any valid number) so the shape guard accepts the line.
 */
export function computeSnapshotPricing(
  input: SnapshotPricingInput
): SnapshotPricingResult {
  assertPriceableItems(input.items);

  if (
    input.orderType !== "delivery" &&
    input.orderType !== "takeaway" &&
    input.orderType !== "dinein"
  ) {
    throw pricingInputError(
      422,
      "ORDER_TYPE_UNSUPPORTED",
      "Unknown order type — cannot price this order."
    );
  }

  // 1. Authoritative line prices come ONLY from the supplied snapshot.
  let foodSubtotal = 0;
  for (const item of input.items) {
    const itemKey = String(item.productId || item.id || "");
    const itemName = String((item as any)?.name || "An item");
    const product = input.products.get(itemKey);

    // An unverifiable price is a refusal, never the client's number.
    if (!product) {
      throw pricingInputError(
        409,
        "ITEM_PRICE_UNVERIFIED",
        `${itemName} could not be verified against the menu — please refresh your cart and try again.`
      );
    }
    // Money-time ELIGIBILITY: only an explicit boolean true is sellable, so a
    // doc that predates the availability field cannot be sold on an assumption.
    if (product.inStock !== true) {
      throw pricingInputError(
        409,
        "ITEM_UNAVAILABLE",
        `${itemName} is no longer available — please review your cart.`
      );
    }
    const catalogPrice = Number(product.price);
    if (!Number.isFinite(catalogPrice) || catalogPrice < 0) {
      throw pricingInputError(
        409,
        "ITEM_PRICE_UNVERIFIED",
        `${itemName} could not be verified against the menu — please refresh your cart and try again.`
      );
    }

    // PAY-16: option deltas come from the product's own catalogue data too.
    const unitPrice = applyCatalogBasePrice(
      item,
      catalogPrice,
      product.customizations
    );
    const qty = Math.max(1, Math.floor(Number(item.quantity) || 1));
    foodSubtotal += unitPrice * qty;
  }

  // 2. Branch config is mandatory: a walk-in total is never priced off defaults.
  const config = input.branchConfig;
  if (!config || typeof config !== "object") {
    throw pricingInputError(
      422,
      "BRANCH_CONFIG_REQUIRED",
      "Walk-in pricing requires a branch pricing snapshot."
    );
  }
  const configPackagingFee = Number((config as any).packagingFee);
  const rawBranchFee = (config as any).branchPackagingFee;
  const branchFeeInvalid =
    rawBranchFee !== undefined &&
    (!Number.isFinite(Number(rawBranchFee)) || Number(rawBranchFee) < 0);
  if (
    !Number.isFinite(configPackagingFee) ||
    configPackagingFee < 0 ||
    branchFeeInvalid
  ) {
    throw pricingInputError(
      422,
      "BRANCH_CONFIG_INVALID",
      "Branch pricing snapshot is invalid — cannot price this order."
    );
  }

  // 3. Packaging: an R7 locked fee wins; otherwise the ONE P2 rule, purely.
  let packagingFee: number;
  let packagingUsedFallback = false;
  if (input.packagingFeeOverride !== undefined) {
    const locked = Number(input.packagingFeeOverride);
    if (!Number.isFinite(locked) || locked < 0) {
      throw pricingInputError(
        422,
        "PACKAGING_FEE_INVALID",
        "Stored packaging fee is invalid — cannot reprice this order."
      );
    }
    packagingFee = round2(locked);
  } else {
    const decision = resolvePackagingFeeSnapshot({
      packaging: config.packaging ?? null,
      branchFee: (config as any).branchPackagingFee,
      orderType: input.orderType,
      branchId: input.branchId,
    });
    packagingFee = decision.fee;
    packagingUsedFallback = decision.usedFallback;
  }

  // 4. Delivery fee: the persisted courier quote is the ONLY source.
  let deliveryFee = 0;
  if (input.orderType === "delivery") {
    const quoted = Number(input.serverDeliveryFee);
    if (
      input.serverDeliveryFee === undefined ||
      !Number.isFinite(quoted) ||
      quoted < 0
    ) {
      throw pricingInputError(
        422,
        "DELIVERY_FEE_REQUIRED",
        "Delivery pricing requires a server courier quote — re-quote the delivery fee and retry checkout."
      );
    }
    deliveryFee = round2(quoted);
  }

  // 5. Discount from the supplied coupon document (already read by the caller),
  // decided by the ONE coupon authority.
  const discount = computeCouponDiscount(
    input.coupon ?? null,
    foodSubtotal,
    String(input.branchId ?? ""),
    input.nowMs ?? Date.now(),
    input.couponUsage,
    input.customerId ?? null
  );

  // 6. Loyalty points deduction (1 pt = ₹1, strictly capped at 20% of subtotal).
  let loyaltyDiscount = 0;
  if (input.loyaltyPointsToRedeem && input.loyaltyPointsToRedeem > 0) {
    const maxLoyalty = Math.round(foodSubtotal * 0.2);
    loyaltyDiscount = Math.min(
      input.loyaltyPointsToRedeem,
      maxLoyalty,
      Math.max(0, foodSubtotal - discount)
    );
  }

  // 7. GST is INCLUDED in the menu price (owner decision 2026-10-31, R1).
  // The inclusive share of `netFood` at 5% is netFood·5/105; reporting it must
  // never change the amount the customer pays. Packaging and delivery sit
  // outside the base (unchanged).
  const netFood = round2(Math.max(0, foodSubtotal - discount - loyaltyDiscount));
  const gst = round2((netFood * GST_RATE) / (1 + GST_RATE));
  const gstPaise = Math.round(gst * 100);
  // Split in paise so CGST + SGST always equals GST exactly.
  const cgstPaise = Math.round(gstPaise / 2);
  const sgstPaise = gstPaise - cgstPaise;

  // 8. Grand Total (R2): net food + packaging + delivery, rounded to paise —
  // no whole-rupee rounding and no tax added on top.
  const grandTotal = round2(Math.max(0, netFood + packagingFee + deliveryFee));
  const grandPaise = Math.round(grandTotal * 100);

  // 9. Branch earnings (F3, owner decision 2026-11-01): NO per-order royalty.
  // The courier fee the customer paid stays with the brand; everything else is
  // the branch's earnings for this order, before the fixed monthly fee.
  const courierFeePaise = Math.round(deliveryFee * 100);
  const branchTransferPaise = Math.max(0, grandPaise - courierFeePaise);

  return {
    foodSubtotal,
    packagingFee,
    deliveryFee,
    gst,
    cgst: cgstPaise / 100,
    sgst: sgstPaise / 100,
    discount,
    loyaltyDiscount,
    grandTotal,
    pricingDegraded: false,
    split: {
      courierFeePaise,
      branchTransferPaise,
      totalAmountPaise: grandPaise,
    },
    packagingUsedFallback,
  };
}

/**
 * Authoritative Server-Side Pricing Engine (Check 15 & Check 57)
 * Validates product prices against Firestore catalog, calculates 5% GST, packaging, delivery,
 * coupon rules, loyalty caps (max 20%), and Razorpay Route royalty split.
 *
 * The reads happen here; every rupee of the bill is computed by the pure
 * `computeSnapshotPricing` seam, so the live path and the walk-in transaction
 * share one formula.
 */
export async function calculateOrderPricing(
  input: CalculateOrderPricingInput
): Promise<PricingBreakdown> {
  // Fail fast on malformed input before any catalog read.
  assertPriceableItems(input.items);

  // 1. Authoritative Item Price Resolution — ONE batched catalog read
  // (db.getAll) instead of N sequential gets; degrades to sequential on
  // Firestore shims without getAll, and to client prices on read failure.
  const catalogPrices = new Map<string, number>();
  // Availability is captured from the SAME snapshot as the price. Until now the
  // cart was the ONLY availability gate and it is client-side: a line added
  // before an 86, or from a stale menu, was still priced and charged. Reading
  // it here costs no extra query and refuses to trust client cart state.
  const catalogAvailability = new Map<string, unknown>();
  // PAY-16: the product document's OWN option data (the `customizations`
  // groups the customer app reads), so a selection's price comes from the
  // catalog instead of the cart's priceDelta.
  const catalogCustomizations = new Map<string, any[] | undefined>();
  // Per-line read failures (sequential path only). A transient read error is
  // an OUTAGE for that line, not a price: the catalog is the only
  // authoritative source, so the basket is refused with the same retryable
  // 503 a catalog-layer failure returns (below). A doc that genuinely does
  // not exist is a different outcome (409 ITEM_PRICE_UNVERIFIED).
  const catalogReadErrors = new Set<string>();
  // True when a pricing INPUT fell back to a default (no branchId → default
  // packaging). Lines are never priced from client input any more.
  let pricingDegraded = false;
  const wantedIds = [...new Set(input.items.map((i) => i.productId || i.id).filter(Boolean))];
  // True only when reads themselves threw (outage) — distinct from docs that
  // merely lack a price field (data shape, keeps per-item fallback).
  let catalogReadFailed = false;
  if (wantedIds.length > 0 && db && typeof db.collection === "function") {
    try {
      if (typeof (db as any).getAll === "function") {
        try {
          const refs = wantedIds.map((id) => db.collection("products").doc(id as string));
          const snaps = await (db as any).getAll(...refs);
          for (const snap of snaps) {
            const data = snap.data();
            if (snap.exists && typeof data?.price === "number") {
              catalogPrices.set(snap.id, data.price);
              catalogAvailability.set(snap.id, data?.inStock);
              catalogCustomizations.set(snap.id, data?.customizations);
            }
          }
        } catch {
          // If getAll throws (e.g. single doc error or unsupported batch), degrade to sequential gets
          for (const id of wantedIds) {
            try {
              const snap = await db.collection("products").doc(id as string).get();
              const data = snap.data();
              if (snap.exists && typeof data?.price === "number") {
                catalogPrices.set(id as string, data.price);
                catalogAvailability.set(id as string, data?.inStock);
                catalogCustomizations.set(id as string, data?.customizations);
              }
            } catch {
              catalogReadFailed = true;
              catalogReadErrors.add(id as string);
            }
          }
        }
      } else {
        for (const id of wantedIds) {
          try {
            const snap = await db.collection("products").doc(id as string).get();
            const data = snap.data();
            if (snap.exists && typeof data?.price === "number") {
              catalogPrices.set(id as string, data.price);
              catalogAvailability.set(id as string, data?.inStock);
              catalogCustomizations.set(id as string, data?.customizations);
            }
          } catch {
            catalogReadFailed = true;
            catalogReadErrors.add(id as string);
            // Fallback to validated client price for this item
          }
        }
      }
    } catch (err) {
      catalogReadFailed = true;
      // A failure outside the per-document reads means the catalog layer
      // itself is unavailable. Do NOT mark every wanted id as a transient
      // per-line failure: that would let a genuinely missing product fall back
      // to a client price. Fail closed with a retryable 503 instead.
      const { captureErrorSnapshot } = await import("../../core/errors").catch(() => ({
        captureErrorSnapshot: async () => {},
      }));
      await captureErrorSnapshot({
        source: "payments",
        severity: "high",
        message: `Catalog price resolution failed (${wantedIds.length} items)`,
        branchId: input.branchId,
      }).catch(() => undefined);
      void err;
      const outage: any = new Error("Menu pricing is temporarily unavailable — please retry checkout.");
      outage.statusCode = 503;
      throw outage;
    }
  }

  // Fail CLOSED on total catalog outage: pricing the whole order off
  // untrusted client input turns any Firestore blip into arbitrary charges.
  // Partial read failures are refused per line below.
  if (wantedIds.length > 0 && catalogPrices.size === 0 && catalogReadFailed) {
    const err: any = new Error("Menu pricing is temporarily unavailable — please retry checkout.");
    err.statusCode = 503;
    throw err;
  }

  // A per-line catalog read that THREW is an outage for the basket, not a
  // price: refuse it with the same retryable 503 the catalog layer returns.
  // Charging `item.price` here would let a Firestore blip turn the
  // client-supplied amount into the authoritative charge. A genuinely missing
  // doc is a different outcome — the snapshot seam refuses it 409
  // ITEM_PRICE_UNVERIFIED.
  for (const item of input.items) {
    const itemKey = item.productId || item.id;
    if (catalogReadErrors.has(itemKey)) {
      const { captureErrorSnapshot } = await import("../../core/errors").catch(() => ({
        captureErrorSnapshot: async () => {},
      }));
      await captureErrorSnapshot({
        source: "payments",
        severity: "high",
        message: `Catalog price read failed for ${itemKey} — refused basket (retryable outage)`,
        branchId: input.branchId,
      }).catch(() => undefined);
      const outage: any = new Error(
        "Menu pricing is temporarily unavailable — please retry checkout."
      );
      outage.statusCode = 503;
      throw outage;
    }
  }

  // The exact documents just read, handed to the pure seam. From here every
  // rupee of the bill is computed by `computeSnapshotPricing`, so this path and
  // the walk-in transaction cannot drift apart.
  const snapshotProducts = new Map<string, SnapshotProduct>();
  for (const [id, price] of catalogPrices) {
    snapshotProducts.set(id, {
      price,
      inStock: catalogAvailability.get(id),
      customizations: catalogCustomizations.get(id),
    });
  }

  // 2+3. Branch config and coupon are INDEPENDENT reads — fire them together
  // instead of two serial round trips on the hot checkout path. Branch config
  // is the SOLE source of packaging/royalty, shared with POST /checkout/fees
  // through resolveBranchPricingConfig; client-supplied fees are untrusted.
  // Coupons collection is the SOLE discount authority (no hardcoded fallback).
  const branchState: { config: BranchPricingConfig | null } = { config: null };
  let couponDoc: any = null;
  // Usage counters (committed + live reservations). Read alongside the coupon so
  // an exhausted cap or a used-up per-customer limit is reported at pricing time
  // instead of only at reservation. A read failure keeps the old fail-closed
  // contract: with a code supplied, we must be able to verify it.
  let couponUsage: { totalUsed?: number; customerUsed?: number } | undefined;

  const couponCode = input.couponCode?.trim().toUpperCase();
  const branchRead: Promise<void> = resolveBranchPricingConfig(input.branchId).then(
    (cfg) => {
      branchState.config = cfg;
    }
  );
  const couponRead: Promise<void> =
    couponCode && db && typeof db.collection === "function"
      ? (async () => {
          try {
            const couponSnap = await db.collection("coupons").doc(couponCode).get();
            if (couponSnap.exists) couponDoc = couponSnap.data();
            couponUsage = await readCouponUsage(
              couponCode,
              normalizeCouponCustomer(input.customerId)
            );
          } catch (err: any) {
            // Fail-closed: coupon read failure must not silently charge full price.
            // If coupon was provided, we must verify it; failure = 503.
            const { captureErrorSnapshot } = await import("../../core/errors");
            await captureErrorSnapshot({
              source: "payments",
              severity: "high",
              message: `coupon read failed for ${couponCode} — cannot verify discount`,
              errorStack: err?.stack,
            });
            const err2: any = new Error("Coupon verification unavailable — please retry checkout");
            err2.statusCode = 503;
            throw err2;
          }
        })()
      : Promise.resolve();
  await Promise.all([branchRead, couponRead]);

  // No branch to read means the default packaging fee stands. That IS a
  // fallback, so it must be visible rather than silent — the flag loses its
  // old meaning (client-priced lines) now that those are refused outright.
  if (!input.branchId) {
    pricingDegraded = true;
  }

  // The delivery fee is validated inside the seam: a delivery without its
  // persisted courier quote is refused 422 DELIVERY_FEE_REQUIRED (R5/R6), with
  // no ₹35 default, no zero and no client value.

  // R7: a server-written packaging snapshot wins over live branch config, so
  // repricing an agreed total cannot be moved by a later config edit. Outside
  // that, P2's single documented rule (ORDER + blank type) decides, through
  // the SAME helper the fees endpoint uses.
  if (input.serverPackagingFee !== undefined) {
    const locked = Number(input.serverPackagingFee);
    if (!Number.isFinite(locked) || locked < 0) {
      const err: any = new Error("Stored packaging fee is invalid — cannot reprice this order.");
      err.statusCode = 422;
      err.code = "PACKAGING_FEE_INVALID";
      throw err;
    }
  } else if (input.orderType !== "dinein") {
    await computePackagingFee({
      packaging: branchState.config?.packaging ?? null,
      branchFee: branchState.config?.branchPackagingFee,
      orderType: input.orderType,
      branchId: input.branchId,
    });
  }

  // 3–9. Every rupee of the bill is computed by the pure seam from the exact
  // documents read above. Only a genuinely locked fee is passed as an override;
  // the live resolution above preserves warning behaviour for branch fees.
  const snapshot = computeSnapshotPricing({
    items: input.items,
    orderType: input.orderType,
    products: snapshotProducts,
    branchConfig: branchState.config,
    branchId: input.branchId,
    coupon: couponDoc,
    couponUsage,
    customerId: input.customerId ?? null,
    loyaltyPointsToRedeem: input.loyaltyPointsToRedeem,
    packagingFeeOverride: input.serverPackagingFee,
    serverDeliveryFee: input.serverDeliveryFee,
  });

  // `packagingUsedFallback` is the seam's post-commit signal for callers that
  // cannot write. The live engine already warned above, so it is not exposed on
  // the public `PricingBreakdown`.
  const { packagingUsedFallback: _unusedFallback, ...breakdown } = snapshot;
  void _unusedFallback;

  return { ...breakdown, pricingDegraded };
}

export interface RepriceVerification {
  expectedGrandTotal: number;
  expectedPaise: number;
  storedPaise: number | null;
  matches: boolean;
  pricingDegraded: boolean;
}

/**
 * Server-repricing truth for payment verification (B2-S1).
 *
 * Recomputes the order total from the stored cart (items + branch + coupon +
 * loyalty) through the SAME authoritative engine and compares it — in exact
 * paise — against the stored grandTotal. A mismatch means the stored price
 * drifted from catalog truth between pricing and payment (tamper, stale
 * coupon, catalog edit) and must be resolved before money moves.
 *
 * R7 (owner decision 2026-10-31): the courier fee and packaging are NOT
 * re-quoted here. They are reused from the SERVER-WRITTEN `pricing` snapshot
 * stamped at intent time (`orders.pricing` is in the rules' server-owned key
 * set, so no client can write it; the top-level `deliveryFee`/`packagingFee`
 * fields ARE client-writable and are never read). A verified payment therefore
 * cannot be failed by a courier price move, and no provider is called.
 *
 * Fail-closed on unpriceable input: missing/empty items, missing branch, or
 * an unknown orderType throws 422 UNPRICEABLE instead of coercing a price.
 * A missing stored total yields storedPaise=null, matches=false (nothing to
 * compare against — the caller decides; verifyPayment's gateway-amount check
 * is the binding control there).
 *
 * NOTE: intentionally NOT wired into verifyPayment's confirm path — live
 * signature-bound orders without a stored cart (legacy docs) must keep
 * verifying while the gateway-amount check covers them. Adopters (batch 3+
 * reprice-before-pay routes) should treat matches=false as refuse-to-charge.
 */
export async function repriceOrderForVerification(
  orderData: any
): Promise<RepriceVerification> {
  const unpriceable = (detail: string): Error => {
    const err: any = new Error(`Cannot reprice order for verification: ${detail}`);
    err.statusCode = 422;
    err.code = "UNPRICEABLE";
    return err;
  };

  const items = (orderData as any)?.items;
  if (!Array.isArray(items) || items.length === 0) {
    throw unpriceable("no priceable items on the order.");
  }
  const branchId = (orderData as any)?.branchId;
  if (typeof branchId !== "string" || branchId.length === 0) {
    throw unpriceable("no resolvable branch on the order.");
  }
  const orderType = (orderData as any)?.orderType;
  if (orderType !== "delivery" && orderType !== "takeaway" && orderType !== "dinein") {
    throw unpriceable("unknown order type on the order.");
  }

  const storedPricing = (orderData as any)?.pricing;
  const storedDeliveryFee = Number(storedPricing?.deliveryFee);
  const storedPackagingFee = Number(storedPricing?.packagingFee);

  const recomputed = await calculateOrderPricing({
    items,
    branchId,
    orderType,
    serverDeliveryFee:
      orderType === "delivery" &&
      storedPricing?.deliveryFee !== undefined &&
      Number.isFinite(storedDeliveryFee) &&
      storedDeliveryFee >= 0
        ? storedDeliveryFee
        : undefined,
    serverPackagingFee:
      storedPricing?.packagingFee !== undefined &&
      Number.isFinite(storedPackagingFee) &&
      storedPackagingFee >= 0
        ? storedPackagingFee
        : undefined,
    couponCode: (orderData as any)?.couponCode,
    // The per-customer limit belongs to the same customer who is paying.
    customerId: (orderData as any)?.customerId ?? (orderData as any)?.userId ?? null,
    loyaltyPointsToRedeem: (orderData as any)?.loyaltyPointsToRedeem,
  });


  const storedGrandTotal = Number((orderData as any)?.pricing?.grandTotal);
  const storedPaise =
    Number.isFinite(storedGrandTotal) && storedGrandTotal >= 0
      ? Math.round(storedGrandTotal * 100)
      : null;
  const expectedPaise = Math.round(recomputed.grandTotal * 100);

  return {
    expectedGrandTotal: recomputed.grandTotal,
    expectedPaise,
    storedPaise,
    matches: storedPaise !== null && storedPaise === expectedPaise,
    pricingDegraded: recomputed.pricingDegraded,
  };
}
