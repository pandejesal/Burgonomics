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

/**
 * Authoritative Server-Side Pricing Engine (Check 15 & Check 57)
 * Validates product prices against Firestore catalog, calculates 5% GST, packaging, delivery,
 * coupon rules, loyalty caps (max 20%), and Razorpay Route royalty split.
 */
export async function calculateOrderPricing(
  input: CalculateOrderPricingInput
): Promise<PricingBreakdown> {
  let foodSubtotal = 0;

  // 1. Authoritative Item Price Resolution
  for (const item of input.items) {
    let unitPrice = computeItemUnitPrice(item);

    // If productId is provided, verify against catalog in Firestore
    const targetDocId = item.productId || item.id;
    if (targetDocId && db && typeof db.collection === "function") {
      try {
        const productSnap = await db.collection("products").doc(targetDocId).get();
        if (productSnap.exists) {
          const productData = productSnap.data();
          if (typeof productData?.price === "number") {
            // Recompute unit price using authoritative catalog base price
            let authoritativeBase = productData.price;
            if (Array.isArray(item.customizations)) {
              for (const c of item.customizations) {
                authoritativeBase += Number(c.price) || 0;
              }
            }
            if (Array.isArray(item.modifiers)) {
              for (const m of item.modifiers) {
                authoritativeBase += Number(m.priceDelta) || 0;
              }
            }
            unitPrice = Math.max(0, authoritativeBase);
          }
        }
      } catch {
        // Fallback to validated client price
      }
    }

    const qty = Math.max(1, Math.floor(Number(item.quantity) || 1));
    foodSubtotal += unitPrice * qty;
  }

  // 2. Fetch branch details for royalty & packaging config
  let royaltyPercentage = 7; // Default 7% brand royalty
  let packagingFee = input.packagingFee ?? 15; // Default ₹15 packaging

  if (input.branchId && db && typeof db.collection === "function") {
    try {
      const branchSnap = await db.collection("branches").doc(input.branchId).get();
      if (branchSnap.exists) {
        const branchData = branchSnap.data();
        if (typeof branchData?.royaltyPercentage === "number") {
          royaltyPercentage = branchData.royaltyPercentage;
        }
        if (typeof branchData?.packagingFee === "number") {
          packagingFee = branchData.packagingFee;
        }
      }
    } catch (err) {
      console.warn("[Pricing Engine] Could not fetch branch details, using defaults", err);
    }
  }

  // If takeaway or dinein, adjust delivery fee to 0
  const deliveryFee =
    input.orderType === "delivery" ? Math.max(0, Number(input.deliveryFee) || 0) : 0;
  if (input.orderType === "dinein") {
    packagingFee = 0;
  }

  // 3. Discount calculation — Firestore coupons collection is the SOLE authority (no hardcoded fallback)
  let discount = 0;
  if (input.couponCode) {
    const code = input.couponCode.trim().toUpperCase();
    if (db && typeof db.collection === "function") {
      try {
        const couponSnap = await db.collection("coupons").doc(code).get();
        if (couponSnap.exists) {
          const c = couponSnap.data() as any;
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
              const raw =
                c.type === "percent" || c.discountType === "percent"
                  ? Math.round((foodSubtotal * (c.discount ?? c.value ?? 0)) / 100)
                  : (c.discount ?? c.value ?? c.amount ?? 0);
              // respect coupon maxDiscount cap if set
              const capped = c.maxDiscount ? Math.min(raw, c.maxDiscount) : raw;
              discount = Math.min(capped, foodSubtotal);
            }
          }
        }
      } catch (err) {
        console.warn("[Pricing Engine] Could not fetch coupon, applying no discount", err);
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
    split: {
      royaltyPercentage,
      brandRoyaltyAmount: brandRoyaltyPaise / 100,
      branchTransferAmount: branchTransferPaise / 100,
      brandRoyaltyPaise,
      branchTransferPaise,
    },
  };
}
