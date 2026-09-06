import { db } from "../../core/firebase";

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
  deliveryFee?: number;
  packagingFee?: number;
  couponCode?: string;
  loyaltyPointsToRedeem?: number;
}

export interface PricingBreakdown {
  foodSubtotal: number;
  packagingFee: number;
  deliveryFee: number;
  gst: number;
  discount: number;
  loyaltyDiscount: number;
  grandTotal: number;
  /** True when branch/coupon reads fell back to defaults — price is degraded. */
  pricingDegraded: boolean;
  split: {
    royaltyPercentage: number;
    brandRoyaltyAmount: number;
    branchTransferAmount: number;
    brandRoyaltyPaise: number;
    branchTransferPaise: number;
  };
}

/**
 * Computes unit price for a single line item including customizations and modifiers.
 */
export function computeItemUnitPrice(item: PricingLineItem): number {
  let unitPrice = Number(item.price) || 0;

  if (Array.isArray(item.customizations)) {
    for (const c of item.customizations) {
      unitPrice += Number(c.price) || 0;
    }
  }

  if (Array.isArray(item.modifiers)) {
    for (const m of item.modifiers) {
      unitPrice += Number(m.priceDelta) || 0;
    }
  }

  return Math.max(0, unitPrice);
}

/** 60s in-memory branch config cache (royalty/packaging change rarely). */
const branchConfigCache = new Map<
  string,
  { at: number; royaltyPercentage: number; packagingFee: number }
>();
const BRANCH_CACHE_TTL_MS = 60_000;

function applyCatalogBasePrice(item: PricingLineItem, catalogPrice: number): number {
  let base = catalogPrice;
  if (Array.isArray(item.customizations)) {
    for (const c of item.customizations) {
      base += Number(c.price) || 0;
    }
  }
  if (Array.isArray(item.modifiers)) {
    for (const m of item.modifiers) {
      base += Number(m.priceDelta) || 0;
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
  let foodSubtotal = 0;

  // 1. Authoritative Item Price Resolution — ONE batched catalog read
  // (db.getAll) instead of N sequential gets; degrades to sequential on
  // Firestore shims without getAll, and to client prices on read failure.
  const catalogPrices = new Map<string, number>();
  const wantedIds = [...new Set(input.items.map((i) => i.productId || i.id).filter(Boolean))];
  if (wantedIds.length > 0 && db && typeof db.collection === "function") {
    try {
      if (typeof (db as any).getAll === "function") {
        const refs = wantedIds.map((id) => db.collection("products").doc(id as string));
        const snaps = await (db as any).getAll(...refs);
        for (const snap of snaps) {
          const data = snap.data();
          if (snap.exists && typeof data?.price === "number") {
            catalogPrices.set(snap.id, data.price);
          }
        }
      } else {
        for (const id of wantedIds) {
          try {
            const snap = await db.collection("products").doc(id as string).get();
            const data = snap.data();
            if (snap.exists && typeof data?.price === "number") {
              catalogPrices.set(id as string, data.price);
            }
          } catch {
            // Fallback to validated client price for this item
          }
        }
      }
    } catch (err) {
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

  for (const item of input.items) {
    let unitPrice = computeItemUnitPrice(item);
    const catalogPrice = catalogPrices.get(item.productId || item.id);
    if (catalogPrice !== undefined) {
      unitPrice = applyCatalogBasePrice(item, catalogPrice);
    }

    const qty = Math.max(1, Math.floor(Number(item.quantity) || 1));
    foodSubtotal += unitPrice * qty;
  }

  // 2+3. Branch config and coupon are INDEPENDENT reads — fire them together
  // instead of two serial round trips on the hot checkout path. Branch config
  // always wins over client input — client-supplied fees are untrusted.
  // Coupons collection is the SOLE discount authority (no hardcoded fallback).
  let royaltyPercentage = 5; // Default 5% brand royalty (spec: 95/5 split)
  let packagingFee = input.packagingFee ?? 15; // Default ₹15 packaging
  let couponDoc: any = null;
  // True when any pricing input fell back to defaults — surfaced on the
  // result so callers/ops can distinguish a clean price from a degraded one.
  let pricingDegraded = false;

  const couponCode = input.couponCode?.trim().toUpperCase();
  const branchRead: Promise<void> =
    input.branchId && db && typeof db.collection === "function"
      ? (async () => {
          const cached = branchConfigCache.get(input.branchId!);
          if (cached && Date.now() - cached.at < BRANCH_CACHE_TTL_MS) {
            royaltyPercentage = cached.royaltyPercentage;
            packagingFee = cached.packagingFee;
            return;
          }
          try {
            const branchSnap = await db.collection("branches").doc(input.branchId!).get();
            if (branchSnap.exists) {
              const branchData = branchSnap.data();
              if (typeof branchData?.royaltyPercentage === "number") {
                royaltyPercentage = branchData.royaltyPercentage;
              }
              if (typeof branchData?.packagingFee === "number") {
                packagingFee = branchData.packagingFee;
              }
            }
            branchConfigCache.set(input.branchId!, {
              at: Date.now(),
              royaltyPercentage,
              packagingFee,
            });
          } catch (err: any) {
            // Defaults change the royalty split — snapshot LOUD, never silent.
            console.warn("[Pricing Engine] Could not fetch branch details, using defaults:", err?.message || err);
            pricingDegraded = true;
            const { captureErrorSnapshot } = await import("../../core/errors");
            await captureErrorSnapshot({
              source: "payments",
              severity: "high",
              message: `branch config read failed for ${input.branchId} — priced with default royalty/packaging`,
              branchId: input.branchId,
              errorStack: err?.stack,
            });
          }
        })()
      : Promise.resolve();
  const couponRead: Promise<void> =
    couponCode && db && typeof db.collection === "function"
      ? (async () => {
          try {
            const couponSnap = await db.collection("coupons").doc(couponCode).get();
            if (couponSnap.exists) couponDoc = couponSnap.data();
          } catch (err: any) {
            // A failed coupon read silently charges FULL price — snapshot it
            // (medium: customer-overcharge report, not a royalty error).
            console.warn("[Pricing Engine] Could not fetch coupon, applying no discount:", err?.message || err);
            pricingDegraded = true;
            const { captureErrorSnapshot } = await import("../../core/errors");
            await captureErrorSnapshot({
              source: "payments",
              severity: "medium",
              message: `coupon read failed for ${couponCode} — discount skipped, full price charged`,
              errorStack: err?.stack,
            });
          }
        })()
      : Promise.resolve();
  await Promise.all([branchRead, couponRead]);

  // If takeaway or dinein, adjust delivery fee to 0
  const deliveryFee =
    input.orderType === "delivery" ? Math.max(0, Number(input.deliveryFee) || 0) : 0;
  if (input.orderType === "dinein") {
    packagingFee = 0;
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
              discount = Math.min(capped, foodSubtotal);
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

  // 5. 5% GST calculated on net food subtotal
  const taxableFoodAmount = Math.max(0, foodSubtotal - discount - loyaltyDiscount);
  const gst = Math.round(taxableFoodAmount * 0.05 * 100) / 100;

  // 6. Grand Total
  const grandTotal = Math.max(0, Math.round(taxableFoodAmount + packagingFee + deliveryFee + gst));

  // 7. Razorpay Route Marketplace Royalty Split (in Paise)
  const foodSubtotalPaise = Math.round(foodSubtotal * 100);
  const totalDiscountPaise = Math.round((discount + loyaltyDiscount) * 100);
  const packagingPaise = Math.round(packagingFee * 100);
  const deliveryPaise = Math.round(deliveryFee * 100);
  const gstPaise = Math.round(gst * 100);

  const brandRoyaltyPaise = Math.round(
    (foodSubtotalPaise - totalDiscountPaise) * (royaltyPercentage / 100)
  );
  const branchTransferPaise =
    foodSubtotalPaise -
    totalDiscountPaise -
    brandRoyaltyPaise +
    packagingPaise +
    deliveryPaise +
    gstPaise;

  return {
    foodSubtotal,
    packagingFee,
    deliveryFee,
    gst,
    discount,
    loyaltyDiscount,
    grandTotal,
    pricingDegraded,
    split: {
      royaltyPercentage,
      brandRoyaltyAmount: brandRoyaltyPaise / 100,
      branchTransferAmount: branchTransferPaise / 100,
      brandRoyaltyPaise,
      branchTransferPaise,
    },
  };
}
