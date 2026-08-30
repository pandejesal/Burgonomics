import { describe, it, expect, vi } from "vitest";

const { mockDb } = vi.hoisted(() => {
  const couponDocs: Record<string, any> = {
    WELCOME50: { discount: 50, type: "flat", active: true },
  };
  const mockDb = {
    collection: (col: string) => ({
      doc: (docId: string) => ({
        get: async () => {
          if (col === "coupons") {
            const coupon = couponDocs[docId];
            return coupon
              ? { exists: true, data: () => coupon }
              : { exists: false, data: () => ({}) };
          }
          return {
            exists: true,
            data: () => ({
              royaltyPercentage: 7,
              packagingFee: 15,
            }),
          };
        },
        set: async () => {},
      }),
    }),
  };
  return { mockDb };
});

vi.mock("firebase-admin", () => {
  const FieldValue = {
    serverTimestamp: () => "MOCK_TIMESTAMP",
    increment: (n: number) => n,
    arrayUnion: (item: any) => [item],
  };

  const firestoreFn: any = vi.fn(() => mockDb);
  firestoreFn.FieldValue = FieldValue;

  return {
    default: {
      firestore: firestoreFn,
      auth: vi.fn(() => ({})),
      messaging: vi.fn(() => ({})),
      initializeApp: vi.fn(),
      apps: [{ name: "mock" }],
    },
    firestore: firestoreFn,
    auth: vi.fn(() => ({})),
    messaging: vi.fn(() => ({})),
    initializeApp: vi.fn(),
    apps: [{ name: "mock" }],
  };
});

import {
  calculateOrderPricing,
  computeItemUnitPrice,
} from "../src/modules/payments/pricing.engine";

describe("Pricing Engine", () => {
  it("calculates item unit price with modifiers and customizations", () => {
    const item = {
      id: "item_1",
      productId: "prod_1",
      name: "Smash Burger",
      price: 199,
      quantity: 1,
      customizations: [{ id: "c1", name: "Extra Cheese", price: 30 }],
      modifiers: [{ id: "m1", name: "Gluten Free Bun", priceDelta: 20 }],
    };

    const unitPrice = computeItemUnitPrice(item);
    expect(unitPrice).toBe(249);
  });

  it("calculates 5% GST, packaging, delivery, and grand total correctly", async () => {
    const breakdown = await calculateOrderPricing({
      items: [
        {
          id: "1",
          productId: "p1",
          name: "Burger",
          price: 200,
          quantity: 2,
        },
      ],
      branchId: "branch_ahmedabad_1",
      orderType: "delivery",
      deliveryFee: 50,
      packagingFee: 15,
    });

    expect(breakdown.foodSubtotal).toBe(400);
    expect(breakdown.packagingFee).toBe(15);
    expect(breakdown.deliveryFee).toBe(50);
    expect(breakdown.gst).toBe(20); // 5% of 400 = 20
    expect(breakdown.grandTotal).toBe(485); // 400 + 15 + 50 + 20
  });

  it("computes Razorpay Route marketplace royalty split accurately", async () => {
    const breakdown = await calculateOrderPricing({
      items: [
        {
          id: "1",
          productId: "p1",
          name: "Burger",
          price: 500,
          quantity: 1,
        },
      ],
      branchId: "branch_ahmedabad_1",
      orderType: "delivery",
      deliveryFee: 40,
      packagingFee: 15,
    });

    // Subtotal = 500, GST = 25, Packaging = 15, Delivery = 40, Total = 580
    // Royalty 7% of 500 = 35
    // Brand Royalty Paise = 3500 (₹35)
    // Branch Net Transfer = (500 - 35) + 15 + 40 + 25 = ₹545 (54500 paise)
    expect(breakdown.split.brandRoyaltyAmount).toBe(35);
    expect(breakdown.split.branchTransferAmount).toBe(545);
    expect(breakdown.split.brandRoyaltyPaise + breakdown.split.branchTransferPaise).toBe(
      Math.round(breakdown.grandTotal * 100)
    );
  });

  it("applies coupon discounts and loyalty points accurately", async () => {
    const breakdown = await calculateOrderPricing({
      items: [
        {
          id: "1",
          productId: "p1",
          name: "Burger",
          price: 400,
          quantity: 1,
        },
      ],
      branchId: "branch_1",
      orderType: "takeaway",
      couponCode: "WELCOME50",
      loyaltyPointsToRedeem: 20,
    });

    expect(breakdown.foodSubtotal).toBe(400);
    expect(breakdown.discount).toBe(50);
    expect(breakdown.loyaltyDiscount).toBe(20);
    // Taxable = 400 - 50 - 20 = 330
    // GST = 5% of 330 = 16.5
    expect(breakdown.gst).toBe(16.5);
    // Delivery for takeaway = 0
    expect(breakdown.deliveryFee).toBe(0);
  });

  it("applies no discount when coupon document does not exist (no hardcoded fallback)", async () => {
    const breakdown = await calculateOrderPricing({
      items: [
        {
          id: "1",
          productId: "p1",
          name: "Burger",
          price: 400,
          quantity: 1,
        },
      ],
      branchId: "branch_1",
      orderType: "delivery",
      packagingFee: 15,
      couponCode: "UNKNOWN50",
    });

    expect(breakdown.foodSubtotal).toBe(400);
    expect(breakdown.discount).toBe(0);
    // GST = 5% of 400 = 20; delivery fee defaults to 0 when not provided
    expect(breakdown.grandTotal).toBe(435); // 400 + 15 + 0 + 20
  });
});
