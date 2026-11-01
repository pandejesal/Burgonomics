import { db } from "../../core/firebase";
import {
  DEFAULT_PACKAGING_FEE,
  computePackagingFee,
  resolveBranchPricingConfig,
  type BranchPricingConfig,
} from "./branchPricing";

export interface PricingLineItem {
  id: string;
  productId?: string;
  name: string;
  price: number;
  quantity: number;
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
  /** True when branch/coupon reads fell back to defaults — price is degraded. */
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

  if (selections.length > 0) {
    const itemName = String(item?.name || "An item");
    const optionLabels = selections
      .map((s) => s.label || s.id)
      .filter((label) => label !== "")
      .join(", ");
    const optionPrices = catalogOptionPrices(productCustomizations);
    if (!optionPrices) {
      throw itemOptionUnverified(
        itemName,
        `the menu has no option data for this product (selected: ${optionLabels || "unnamed option"})`
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
 * Authoritative Server-Side Pricing Engine (Check 15 & Check 57)
 * Validates product prices against Firestore catalog, calculates 5% GST, packaging, delivery,
 * coupon rules, loyalty caps (max 20%), and Razorpay Route royalty split.
 */
export async function calculateOrderPricing(
  input: CalculateOrderPricingInput
): Promise<PricingBreakdown> {
  // Defense in depth behind the zod schema (direct callers bypass routes):
  // reject unpriceable items instead of coercing them (qty 0 → phantom +1,
  // price "abc" → free item — both real over/under-charge vectors).
  if (!Array.isArray(input.items) || input.items.length === 0 || input.items.length > 100) {
    const err: any = new Error("Order must contain 1–100 items.");
    err.statusCode = 400;
    throw err;
  }
  for (const item of input.items) {
    const price = Number((item as any)?.price);
    const qty = Number((item as any)?.quantity);
    if (!Number.isFinite(price) || price < 0 || price > 100000 || !Number.isInteger(qty) || qty < 1 || qty > 99) {
      const err: any = new Error(`Invalid item in order (price and quantity 1–99 required): ${(item as any)?.productId || (item as any)?.id || "unknown"}.`);
      err.statusCode = 400;
      throw err;
    }
  }
  let foodSubtotal = 0;

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
  // True when any line was priced from client input instead of the catalog.
  // Surfaced on the result so callers can tell a clean total from a degraded
  // one; before this it was declared and never set, so the documented signal
  // did not exist.
  let pricingDegraded = false;
  const wantedIds = [...new Set(input.items.map((i) => i.productId || i.id).filter(Boolean))];
  // True only when reads themselves threw (outage) — distinct from docs that
  // merely lack a price field (data shape, keeps per-item fallback).
  let catalogReadFailed = false;
  if (wantedIds.length > 0 && db && typeof db.collection === "function") {
    try {
      if (typeof (db as any).getAll === "function") {
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
            // Fallback to validated client price for this item
          }
        }
      }
    } catch (err) {
      catalogReadFailed = true;
      // Fallback to validated client prices — but never silently: a blind
      // catalog read failure prices the whole order off untrusted input.
      const { captureErrorSnapshot } = await import("../../core/errors").catch(() => ({
        captureErrorSnapshot: async () => {},
      }));
      await captureErrorSnapshot({
        source: "payments",
        severity: "high",
        message: `Catalog price resolution failed, falling back to client prices (${wantedIds.length} items)`,
        branchId: input.branchId,
      }).catch(() => undefined);
      void err;
    }
  }

  // Fail CLOSED on total catalog outage: pricing the whole order off
  // untrusted client input turns any Firestore blip into arbitrary charges.
  // Partial misses keep per-item fallback (flagged via pricingDegraded).
  if (wantedIds.length > 0 && catalogPrices.size === 0 && catalogReadFailed) {
    const err: any = new Error("Menu pricing is temporarily unavailable — please retry checkout.");
    err.statusCode = 503;
    throw err;
  }

  for (const item of input.items) {
    let unitPrice = computeItemUnitPrice(item);
    const itemKey = item.productId || item.id;
    const catalogPrice = catalogPrices.get(itemKey);
    if (catalogPrice !== undefined) {
      // Money-time ELIGIBILITY. Fail CLOSED: only an explicit boolean true is
      // sellable, so a doc that predates the availability field cannot be sold
      // on an assumption. Without this, a line that went 86 after it entered
      // the cart was still priced and charged, because the cart is a
      // client-side gate and the server never looked.
      if (catalogAvailability.get(itemKey) !== true) {
        const unavailable: any = new Error(
          `${String((item as any)?.name || "An item")} is no longer available — please review your cart.`
        );
        unavailable.statusCode = 409;
        unavailable.code = "ITEM_UNAVAILABLE";
        throw unavailable;
      }
      unitPrice = applyCatalogBasePrice(
        item,
        catalogPrice,
        catalogCustomizations.get(itemKey)
      );
    } else {
      // FAIL CLOSED on an unverifiable price. The catalog is the only
      // authoritative price source, so charging the price the CLIENT sent for a
      // product we cannot look up lets an arbitrary request value set the
      // amount. A deleted, foreign or mistyped product is refused instead of
      // silently priced, because "we could not verify it" is not a licence to
      // charge it. Rejecting here is why pricingDegraded no longer has to carry
      // this case on its own.
      const unverified: any = new Error(
        `${String((item as any)?.name || "An item")} could not be verified against the menu — please refresh your cart and try again.`
      );
      unverified.statusCode = 409;
      unverified.code = "ITEM_PRICE_UNVERIFIED";
      throw unverified;
    }

    const qty = Math.max(1, Math.floor(Number(item.quantity) || 1));
    foodSubtotal += unitPrice * qty;
  }

  // 2+3. Branch config and coupon are INDEPENDENT reads — fire them together
  // instead of two serial round trips on the hot checkout path. Branch config
  // is the SOLE source of packaging/royalty, shared with POST /checkout/fees
  // through resolveBranchPricingConfig; client-supplied fees are untrusted.
  // Coupons collection is the SOLE discount authority (no hardcoded fallback).
  let packagingFee = DEFAULT_PACKAGING_FEE;
  const branchState: { config: BranchPricingConfig | null } = { config: null };
  let couponDoc: any = null;

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

  // Customer-facing delivery fee (R5/R6). The ONLY source is the persisted
  // courier quote handed in by the server through `serverDeliveryFee`. A
  // delivery order without one is UNPRICEABLE: no ₹35 default (the old static
  // quote), no zero, no client value. The courier quote is the provider fare
  // itself — there is no markup and no free-delivery threshold.
  let deliveryFee = 0;
  if (input.orderType === "delivery") {
    const quoted = Number(input.serverDeliveryFee);
    if (input.serverDeliveryFee === undefined || !Number.isFinite(quoted) || quoted < 0) {
      const err: any = new Error(
        "Delivery pricing requires a server courier quote — re-quote the delivery fee and retry checkout."
      );
      err.statusCode = 422;
      err.code = "DELIVERY_FEE_REQUIRED";
      throw err;
    }
    deliveryFee = round2(quoted);
  }

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
    packagingFee = round2(locked);
  } else if (input.orderType === "dinein") {
    packagingFee = 0;
  } else {
    packagingFee = await computePackagingFee({
      packaging: branchState.config?.packaging ?? null,
      branchFee: branchState.config?.branchPackagingFee,
      orderType: input.orderType,
      branchId: input.branchId,
    });
  }

  // 3. Discount calculation from the concurrently-fetched coupon doc
  let discount = 0;
  if (couponDoc) {
    {
      const c = couponDoc as any;
          // Validate the document is actually a coupon (has a discount field or percent type)
          const looksLikeCoupon =
            c &&
            (typeof c.discount === "number" ||
              typeof c.value === "number" ||
              typeof c.amount === "number" ||
              c.type === "percent" ||
              c.discountType === "percent");
          if (looksLikeCoupon) {
            const isActive = c.active !== false;
            const notExpired =
              !c.expiresAt ||
              (c.expiresAt.toMillis
                ? c.expiresAt.toMillis() > Date.now()
                : new Date(c.expiresAt) > new Date());
            const branchAllowed = !c.branchId || c.branchId === input.branchId;
            const minOk = foodSubtotal >= (c.minOrder ?? c.min_order ?? 0);
            if (isActive && notExpired && branchAllowed && minOk) {
              // Percent coupons are bounded (0,100] — a corrupt >100% value
              // must not zero out (or negate) the bill.
              const pct = c.discount ?? c.value ?? 0;
              const raw =
                c.type === "percent" || c.discountType === "percent"
                  ? Math.round((foodSubtotal * Math.min(100, Math.max(0, pct))) / 100)
                  : (c.discount ?? c.value ?? c.amount ?? 0);
              // respect coupon maxDiscount cap if set
              const capped = c.maxDiscount ? Math.min(raw, c.maxDiscount) : raw;
              // P2 clamp: a corrupt negative discount (console edit / bad
              // import) must never INFLATE the bill — discount floors at 0
              // and ceilings at the food subtotal.
              discount = Math.max(0, Math.min(capped, foodSubtotal));
            }
          }
    }
  }

  // 4. Loyalty points deduction (1 pt = ₹1, strictly capped at max 20% of subtotal)
  let loyaltyDiscount = 0;
  if (input.loyaltyPointsToRedeem && input.loyaltyPointsToRedeem > 0) {
    const maxLoyalty = Math.round(foodSubtotal * 0.2);
    loyaltyDiscount = Math.min(
      input.loyaltyPointsToRedeem,
      maxLoyalty,
      Math.max(0, foodSubtotal - discount)
    );
  }

  // 5. GST is INCLUDED in the menu price (owner decision 2026-10-31, R1).
  // The inclusive share of `netFood` at 5% is netFood·5/105; reporting it must
  // never change the amount the customer pays. Packaging and delivery sit
  // outside the base (unchanged).
  const netFood = round2(Math.max(0, foodSubtotal - discount - loyaltyDiscount));
  const gst = round2((netFood * GST_RATE) / (1 + GST_RATE));
  const gstPaise = Math.round(gst * 100);
  // Split in paise so CGST + SGST always equals GST exactly.
  const cgstPaise = Math.round(gstPaise / 2);
  const sgstPaise = gstPaise - cgstPaise;

  // 6. Grand Total (R2): net food + packaging + delivery, rounded to paise —
  // no whole-rupee rounding and no tax added on top.
  const grandTotal = round2(Math.max(0, netFood + packagingFee + deliveryFee));
  const grandPaise = Math.round(grandTotal * 100);

  // 7. Branch earnings (F3, owner decision 2026-11-01): NO per-order royalty.
  // The courier fee the customer paid stays with the brand (one Borzo account
  // pays every courier, D6); everything else is the branch's earnings for this
  // order, before the fixed monthly fee is applied at capture (F5).
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
    pricingDegraded,
    split: {
      courierFeePaise,
      branchTransferPaise,
      totalAmountPaise: grandPaise,
    },
  };
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
