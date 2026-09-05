import { describe, it, expect, vi } from "vitest";

/**
 * 20-basket pricing parity suite: every basket must satisfy the engine's
 * money invariants, on BOTH the batched (getAll) and sequential read paths.
 * Catches rounding drift, cap violations, and split mismatches that would
 * otherwise surface as Razorpay amount mismatches in production.
 */

const CATALOG: Record<string, number> = {
  prod_hero: 99,
  prod_bigbang: 249,
  prod_fries: 89,
  prod_shake: 159,
  prod_momos: 129,
};

const { mockDb, getAllCalls } = vi.hoisted(() => {
  const getAllCalls = { count: 0 };
  const docGet = async (col: string, docId: string) => {
    if (col === "products") {
      const price = (CATALOG as any)[docId];
      return price === undefined
        ? { exists: false, data: () => ({}), id: docId }
        : { exists: true, data: () => ({ price }), id: docId };
    }
    if (col === "branches") {
      return { exists: true, data: () => ({ royaltyPercentage: 5, packagingFee: 15 }), id: docId };
    }
    if (col === "coupons") {
      if (docId === "FLAT50") return { exists: true, data: () => ({ discount: 50, type: "flat", active: true }), id: docId };
      if (docId === "PERC10") {
        return { exists: true, data: () => ({ discount: 10, type: "percent", active: true, maxDiscount: 80 }), id: docId };
      }
      return { exists: false, data: () => ({}), id: docId };
    }
    return { exists: false, data: () => ({}), id: docId };
  };
  const mockDb: any = {
    collection: (col: string) => ({
      doc: (docId: string) => ({ get: () => docGet(col, docId), set: async () => {} }),
    }),
    getAll: async (...refs: any[]) => {
      getAllCalls.count += 1;
      return Promise.all(refs.map((r) => r.get()));
    },
  };
  // refs carry their doc id for getAll
  mockDb.collection = (col: string) => ({
    doc: (docId: string) => {
      const ref: any = { id: docId, get: () => docGet(col, docId), set: async () => {} };
      return ref;
    },
  });
  return { mockDb, getAllCalls };
});

vi.mock("firebase-admin", () => {
  const FieldValue = { serverTimestamp: () => "MOCK_TIMESTAMP" };
  const firestoreFn: any = vi.fn(() => mockDb);
  firestoreFn.FieldValue = FieldValue;
  return {
    default: { firestore: firestoreFn, auth: vi.fn(() => ({})), messaging: vi.fn(() => ({})), initializeApp: vi.fn(), apps: [{ name: "mock" }] },
    firestore: firestoreFn,
    auth: vi.fn(() => ({})),
    messaging: vi.fn(() => ({})),
    initializeApp: vi.fn(),
    apps: [{ name: "mock" }],
  };
});

import { calculateOrderPricing } from "../src/modules/payments/pricing.engine";

interface Basket {
  name: string;
  items: Array<{ id: string; productId: string; name: string; price: number; quantity: number; modifiers?: Array<{ id: string; name: string; priceDelta: number }> }>;
  orderType: "delivery" | "takeaway" | "dinein";
  couponCode?: string;
  loyaltyPointsToRedeem?: number;
  branchId: string;
}

const BASKETS: Basket[] = [
  { name: "single burger takeaway", items: [{ id: "l1", productId: "prod_hero", name: "Hero", price: 99, quantity: 1 }], orderType: "takeaway", branchId: "b1" },
  { name: "double bigbang delivery", items: [{ id: "l1", productId: "prod_bigbang", name: "BB", price: 249, quantity: 2 }], orderType: "delivery", branchId: "b1" },
  { name: "family mix dinein", items: [{ id: "l1", productId: "prod_hero", name: "H", price: 99, quantity: 2 }, { id: "l2", productId: "prod_fries", name: "F", price: 89, quantity: 2 }, { id: "l3", productId: "prod_shake", name: "S", price: 159, quantity: 2 }], orderType: "dinein", branchId: "b1" },
  { name: "flat coupon", items: [{ id: "l1", productId: "prod_bigbang", name: "BB", price: 249, quantity: 1 }], orderType: "takeaway", branchId: "b1", couponCode: "FLAT50" },
  { name: "percent coupon capped", items: [{ id: "l1", productId: "prod_bigbang", name: "BB", price: 249, quantity: 4 }], orderType: "delivery", branchId: "b1", couponCode: "PERC10" },
  { name: "bad coupon ignored", items: [{ id: "l1", productId: "prod_hero", name: "H", price: 99, quantity: 1 }], orderType: "takeaway", branchId: "b1", couponCode: "NOPE" },
  { name: "loyalty capped 20pct", items: [{ id: "l1", productId: "prod_hero", name: "H", price: 99, quantity: 1 }], orderType: "takeaway", branchId: "b1", loyaltyPointsToRedeem: 500 },
  { name: "loyalty exact", items: [{ id: "l1", productId: "prod_bigbang", name: "BB", price: 249, quantity: 2 }], orderType: "delivery", branchId: "b1", loyaltyPointsToRedeem: 40 },
  { name: "coupon plus loyalty", items: [{ id: "l1", productId: "prod_bigbang", name: "BB", price: 249, quantity: 2 }], orderType: "delivery", branchId: "b1", couponCode: "FLAT50", loyaltyPointsToRedeem: 60 },
  { name: "modifiers priced", items: [{ id: "l1", productId: "prod_hero", name: "H", price: 99, quantity: 1, modifiers: [{ id: "m1", name: "Cheese", priceDelta: 30 }] }], orderType: "takeaway", branchId: "b1" },
  { name: "unknown catalog id falls back", items: [{ id: "l1", productId: "prod_ghost", name: "G", price: 120, quantity: 1 }], orderType: "takeaway", branchId: "b1" },
  { name: "qty clamping", items: [{ id: "l1", productId: "prod_fries", name: "F", price: 89, quantity: 0 }], orderType: "takeaway", branchId: "b1" },
  { name: "bulk qty", items: [{ id: "l1", productId: "prod_momos", name: "M", price: 129, quantity: 10 }], orderType: "delivery", branchId: "b1" },
  { name: "all categories", items: [{ id: "l1", productId: "prod_hero", name: "H", price: 99, quantity: 1 }, { id: "l2", productId: "prod_bigbang", name: "B", price: 249, quantity: 1 }, { id: "l3", productId: "prod_fries", name: "F", price: 89, quantity: 1 }, { id: "l4", productId: "prod_shake", name: "S", price: 159, quantity: 1 }, { id: "l5", productId: "prod_momos", name: "M", price: 129, quantity: 1 }], orderType: "delivery", branchId: "b1", couponCode: "PERC10", loyaltyPointsToRedeem: 100 },
  { name: "same item twice merges by math", items: [{ id: "l1", productId: "prod_hero", name: "H", price: 99, quantity: 1 }, { id: "l2", productId: "prod_hero", name: "H", price: 99, quantity: 3 }], orderType: "takeaway", branchId: "b1" },
  { name: "dinein no packaging", items: [{ id: "l1", productId: "prod_bigbang", name: "BB", price: 249, quantity: 1 }], orderType: "dinein", branchId: "b1" },
  { name: "takeaway no delivery fee", items: [{ id: "l1", productId: "prod_bigbang", name: "BB", price: 249, quantity: 1 }], orderType: "takeaway", branchId: "b1" },
  { name: "tiny subtotal coupon floor", items: [{ id: "l1", productId: "prod_fries", name: "F", price: 89, quantity: 1 }], orderType: "takeaway", branchId: "b1", couponCode: "FLAT50" },
  { name: "zero loyalty ignored", items: [{ id: "l1", productId: "prod_hero", name: "H", price: 99, quantity: 1 }], orderType: "takeaway", branchId: "b1", loyaltyPointsToRedeem: 0 },
  { name: "second branch isolation", items: [{ id: "l1", productId: "prod_shake", name: "S", price: 159, quantity: 2 }], orderType: "delivery", branchId: "b2" },
];

describe("pricing parity — 20 baskets", () => {
  it.each(BASKETS.map((b) => [b.name, b] as const))("%s balances", async (_name, b) => {
    const r = await calculateOrderPricing({ ...b, deliveryFee: 35, packagingFee: 15 });

    // Recomputed books must match reported books
    const taxable = Math.max(0, r.foodSubtotal - r.discount - r.loyaltyDiscount);
    expect(r.gst).toBeCloseTo(Math.round(taxable * 0.05 * 100) / 100, 2);
    const packing = b.orderType === "dinein" ? 0 : 15;
    const delivery = b.orderType === "delivery" ? 35 : 0;
    expect(r.packagingFee).toBe(packing);
    expect(r.deliveryFee).toBe(delivery);
    expect(r.grandTotal).toBe(Math.max(0, Math.round(taxable + packing + delivery + r.gst)));

    // Caps hold
    expect(r.discount).toBeLessThanOrEqual(r.foodSubtotal);
    expect(r.loyaltyDiscount).toBeLessThanOrEqual(Math.round(r.foodSubtotal * 0.2));
    if (b.loyaltyPointsToRedeem) {
      expect(r.loyaltyDiscount).toBeLessThanOrEqual(b.loyaltyPointsToRedeem);
    }

    // Razorpay split conserves money (paise-exact)
    const foodPaise = Math.round(r.foodSubtotal * 100);
    const discPaise = Math.round((r.discount + r.loyaltyDiscount) * 100);
    expect(r.split.brandRoyaltyPaise + r.split.branchTransferPaise).toBe(
      foodPaise - discPaise + Math.round(packing * 100) + Math.round(delivery * 100) + Math.round(r.gst * 100)
    );

    // Non-negative, finite everywhere
    for (const v of [r.foodSubtotal, r.gst, r.discount, r.loyaltyDiscount, r.grandTotal]) {
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
    }
    expect(Number.isInteger(r.split.brandRoyaltyPaise)).toBe(true);
    expect(Number.isInteger(r.split.branchTransferPaise)).toBe(true);
  });

  it("batched catalog path is exercised", () => {
    expect(getAllCalls.count).toBeGreaterThan(0);
  });

  it("golden basket: percent coupon capped at 80", async () => {
    // 4 x 249 = 996; 10% = 99.6 → capped 80; taxable 916; gst 45.8; total 916+15+35+45.8 = 1011.8 → 1012
    const r = await calculateOrderPricing({
      items: [{ id: "l1", productId: "prod_bigbang", name: "BB", price: 249, quantity: 4 }],
      branchId: "b1",
      orderType: "delivery",
      deliveryFee: 35,
      packagingFee: 15,
      couponCode: "PERC10",
    });
    expect(r.discount).toBe(80);
    expect(r.grandTotal).toBe(1012);
  });
});
