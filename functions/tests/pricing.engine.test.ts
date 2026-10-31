import { describe, it, expect, vi } from "vitest";

const { mockDb } = vi.hoisted(() => {
  const couponDocs: Record<string, any> = {
    WELCOME50: { discount: 50, type: "flat", active: true },
  };
  // Authoritative catalog. The engine now REFUSES to price a line whose product
  // it cannot look up (it will not charge the client's request price), so each
  // fixture id carries its own catalog price and availability.
  const catalogPrices: Record<string, number> = {
    prod_200: 200,
    prod_400: 400,
    prod_500: 500,
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
          if (col === "products") {
            const price = catalogPrices[docId];
            return price === undefined
              ? { exists: false, data: () => ({}) }
              : { exists: true, data: () => ({ price, inStock: true }) };
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
  repriceOrderForVerification,
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
          productId: "prod_200",
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
    // Client-sent 50 is ignored: the published checkout quote is ₹35.
    expect(breakdown.deliveryFee).toBe(35);
    expect(breakdown.gst).toBe(20); // 5% of 400 = 20
    expect(breakdown.grandTotal).toBe(470); // 400 + 15 + 35 + 20
  });

  it("computes Razorpay Route marketplace royalty split accurately", async () => {
    const breakdown = await calculateOrderPricing({
      items: [
        {
          id: "1",
          productId: "prod_500",
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

    // Subtotal = 500, GST = 25, Packaging = 15, Delivery = 35, Total = 575
    // Royalty 7% of 500 = 35
    // Brand Royalty Paise = 3500 (₹35)
    // Branch Net Transfer = (500 - 35) + 15 + 35 + 25 = ₹540 (54000 paise)
    expect(breakdown.split.brandRoyaltyAmount).toBe(35);
    expect(breakdown.split.branchTransferAmount).toBe(540);
    expect(breakdown.split.brandRoyaltyPaise + breakdown.split.branchTransferPaise).toBe(
      Math.round(breakdown.grandTotal * 100)
    );
  });

  it("applies coupon discounts and loyalty points accurately", async () => {
    const breakdown = await calculateOrderPricing({
      items: [
        {
          id: "1",
          productId: "prod_400",
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
          productId: "prod_400",
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
    // GST = 5% of 400 = 20; delivery is the published ₹35 quote when not sent
    expect(breakdown.grandTotal).toBe(470); // 400 + 15 + 35 + 20
  });

  it("prices cash and online identically for the same cart (single truth)", async () => {
    // The engine takes no payment-method input: the same cart priced twice
    // (cash leg vs online leg) must produce the identical grand total.
    const cart = {
      items: [
        {
          id: "1",
          productId: "prod_200",
          name: "Burger",
          price: 200,
          quantity: 2,
        },
      ],
      branchId: "branch_ahmedabad_1",
      orderType: "delivery" as const,
      deliveryFee: 50,
      packagingFee: 15,
    };
    const cashLeg = await calculateOrderPricing(cart);
    const onlineLeg = await calculateOrderPricing({ ...cart });
    expect(onlineLeg.grandTotal).toBe(cashLeg.grandTotal);
    expect(onlineLeg.grandTotal).toBe(470);
  });

  it("charges the published checkout quote and ignores the client deliveryFee (PAY-01)", async () => {
    const base = {
      items: [{ id: "1", productId: "prod_400", name: "Burger", price: 400, quantity: 1 }],
      branchId: "branch_ahmedabad_1",
      orderType: "delivery" as const,
      packagingFee: 15,
    };
    // A client claiming ₹0 cannot make a delivery free...
    const zero = await calculateOrderPricing({ ...base, deliveryFee: 0 });
    expect(zero.deliveryFee).toBe(35);
    // ...and a client claiming ₹999 cannot inflate it.
    const inflated = await calculateOrderPricing({ ...base, deliveryFee: 999 });
    expect(inflated.deliveryFee).toBe(35);
    // No free-delivery threshold exists on the checkout path (the 499/40 rule
    // is stale cart-fallback copy, not the bill).
    const above = await calculateOrderPricing({
      ...base,
      items: [{ id: "1", productId: "prod_500", name: "Burger", price: 500, quantity: 1 }],
      deliveryFee: 0,
    });
    expect(above.deliveryFee).toBe(35);
    // Takeaway never carries a delivery fee.
    const takeaway = await calculateOrderPricing({ ...base, orderType: "takeaway", deliveryFee: 35 });
    expect(takeaway.deliveryFee).toBe(0);
  });

  it("matches the honest client's checkout total exactly (PAY-01)", async () => {
    const items = [{ id: "1", productId: "prod_400", name: "Burger", price: 400, quantity: 1 }];
    const server = await calculateOrderPricing({
      items,
      branchId: "branch_ahmedabad_1",
      orderType: "delivery",
      deliveryFee: 0, // the real client does not send a fee at all
      packagingFee: 15,
    });
    // Client rule: calculateOrderTotals with resolvePricingConfig(deliveryQuoteFee=35).
    const clientDeliveryFee = 35;
    const clientTaxable = 400;
    const clientGst = Math.round(clientTaxable * 0.05 * 100) / 100;
    const clientGrandTotal =
      Math.round((clientTaxable + 15 + clientDeliveryFee + clientGst) * 100) / 100;
    expect(server.grandTotal).toBe(clientGrandTotal);
    expect(server.grandTotal).toBe(470);
  });
});

describe("repriceOrderForVerification (B2-S1 server truth)", () => {
  const storedCart = {
    items: [
      {
        id: "1",
        productId: "prod_200",
        name: "Burger",
        price: 200,
        quantity: 2,
      },
    ],
    branchId: "branch_ahmedabad_1",
    orderType: "delivery",
    deliveryFee: 50,
    packagingFee: 15,
  };

  it("matches when the stored total equals the server recomputation", async () => {
    const res = await repriceOrderForVerification({
      ...storedCart,
      pricing: { grandTotal: 470 },
    });
    expect(res.matches).toBe(true);
    expect(res.expectedGrandTotal).toBe(470);
    expect(res.expectedPaise).toBe(47000);
    expect(res.storedPaise).toBe(47000);
  });

  it("mismatches when the stored total drifted from catalog truth", async () => {
    const res = await repriceOrderForVerification({
      ...storedCart,
      pricing: { grandTotal: 400 }, // tampered/stale total
    });
    expect(res.matches).toBe(false);
    expect(res.expectedPaise).toBe(47000);
    expect(res.storedPaise).toBe(40000);
  });

  it("reports no match when no stored total exists", async () => {
    const res = await repriceOrderForVerification({ ...storedCart });
    expect(res.matches).toBe(false);
    expect(res.storedPaise).toBeNull();
    expect(res.expectedPaise).toBe(47000);
  });

  it("throws 422 UNPRICEABLE on missing items instead of coercing", async () => {
    const err: any = await repriceOrderForVerification({
      branchId: "branch_ahmedabad_1",
      orderType: "delivery",
      pricing: { grandTotal: 485 },
    }).then(
      () => null,
      (e) => e
    );
    expect(err?.code).toBe("UNPRICEABLE");
    expect(err?.statusCode).toBe(422);
  });

  it("throws 422 UNPRICEABLE on an unknown order type", async () => {
    const err: any = await repriceOrderForVerification({
      ...storedCart,
      orderType: "drone",
    }).then(
      () => null,
      (e) => e
    );
    expect(err?.code).toBe("UNPRICEABLE");
    expect(err?.statusCode).toBe(422);
  });
});
