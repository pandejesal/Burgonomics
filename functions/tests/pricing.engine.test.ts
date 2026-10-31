import { describe, it, expect, vi } from "vitest";

const { mockDb } = vi.hoisted(() => {
  const couponDocs: Record<string, any> = {
    WELCOME50: { discount: 50, type: "flat", active: true },
  };
  // Authoritative catalog. The engine now REFUSES to price a line whose product
  // it cannot look up (it will not charge the client's request price), so each
  // fixture id carries its own catalog price and availability.
  const catalogPrices: Record<string, number> = {
    prod_0: 0,
    prod_105: 105,
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

  it("calculates inclusive GST, packaging, delivery, and grand total correctly", async () => {
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
      serverDeliveryFee: 35,
      packagingFee: 15,
    });

    expect(breakdown.foodSubtotal).toBe(400);
    expect(breakdown.packagingFee).toBe(15);
    // Client-sent 50 is ignored: the server courier quote is ₹35.
    expect(breakdown.deliveryFee).toBe(35);
    expect(breakdown.gst).toBe(19.05); // included share: 400 · 5/105
    expect(breakdown.grandTotal).toBe(450); // 400 + 15 + 35, no tax on top
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
      serverDeliveryFee: 35,
      packagingFee: 15,
    });

    // Subtotal = 500 (GST-inclusive), GST included = 23.81, Packaging = 15,
    // Delivery = 35, Total = 550
    // Royalty 7% of the ex-GST ₹476.19 = ₹33.33 (3333 paise)
    // Branch Transfer = 55000 - 3333 = ₹516.67 (51667 paise)
    expect(breakdown.foodSubtotal).toBe(500);
    expect(breakdown.gst).toBe(23.81);
    expect(breakdown.split.brandRoyaltyAmount).toBe(33.33);
    expect(breakdown.split.branchTransferAmount).toBe(516.67);
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
      packagingFee: 15,
    });

    expect(breakdown.foodSubtotal).toBe(400);
    expect(breakdown.discount).toBe(50);
    expect(breakdown.loyaltyDiscount).toBe(20);
    // Net food = 400 - 50 - 20 = 330
    // Included GST = 330 · 5/105 = 15.71
    expect(breakdown.gst).toBe(15.71);
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
      serverDeliveryFee: 35,
      couponCode: "UNKNOWN50",
    });

    expect(breakdown.foodSubtotal).toBe(400);
    expect(breakdown.discount).toBe(0);
    // GST included = 19.05; delivery is the server courier quote (₹35)
    expect(breakdown.grandTotal).toBe(450); // 400 + 15 + 35
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
      serverDeliveryFee: 35,
      packagingFee: 15,
    };
    const cashLeg = await calculateOrderPricing(cart);
    const onlineLeg = await calculateOrderPricing({ ...cart });
    expect(onlineLeg.grandTotal).toBe(cashLeg.grandTotal);
    expect(onlineLeg.grandTotal).toBe(450);
  });

  it("charges the server courier fee and ignores the client deliveryFee (PAY-01)", async () => {
    const base = {
      items: [{ id: "1", productId: "prod_400", name: "Burger", price: 400, quantity: 1 }],
      branchId: "branch_ahmedabad_1",
      orderType: "delivery" as const,
      serverDeliveryFee: 35,
      packagingFee: 15,
    };
    // A client claiming ₹0 cannot make a delivery free...
    const zero = await calculateOrderPricing({ ...base, deliveryFee: 0 });
    expect(zero.deliveryFee).toBe(35);
    // ...and a client claiming ₹999 cannot inflate it.
    const inflated = await calculateOrderPricing({ ...base, deliveryFee: 999 });
    expect(inflated.deliveryFee).toBe(35);
    // No free-delivery threshold exists on the checkout path.
    const above = await calculateOrderPricing({
      ...base,
      items: [{ id: "1", productId: "prod_500", name: "Burger", price: 500, quantity: 1 }],
      deliveryFee: 0,
    });
    expect(above.deliveryFee).toBe(35);
    // Takeaway never carries a delivery fee, and needs no courier quote.
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
      serverDeliveryFee: 35,
      packagingFee: 15,
    });
    // Client rule (R1/R2): inclusive GST is displayed, never added, and the
    // total is the menu price + packaging + the same server courier quote.
    const clientDeliveryFee = 35;
    const clientNetFood = 400;
    const clientGst = Math.round((clientNetFood * 0.05 / 1.05) * 100) / 100;
    const clientGrandTotal =
      Math.round((clientNetFood + 15 + clientDeliveryFee) * 100) / 100;
    expect(clientGst).toBe(19.05);
    expect(server.grandTotal).toBe(clientGrandTotal);
    expect(server.grandTotal).toBe(450);
  });
});

/**
 * OWNER DECISION 2026-10-31 (pricing-contract.md R1–R3): menu prices are
 * GST-INCLUSIVE. The GST share is reported, never added:
 *
 *   netFood     = foodSubtotal − discount − loyaltyDiscount
 *   gst         = round2(netFood · 0.05 / 1.05)
 *   grandTotal  = round2(max(0, netFood + packagingFee + deliveryFee))
 *   exGstPaise  = netFoodPaise − gstPaise
 *   royalty     = round(exGstPaise · pct / 100)
 *   branch      = grandPaise − royalty          (the split always sums)
 *
 * The delivery fee is a TRUE COURIER QUOTE now (R5/R6): the engine only takes
 * it through the server-only `serverDeliveryFee`; a delivery order without one
 * throws instead of pricing a default.
 */
describe("GST-inclusive menu prices (R1/R2/R3)", () => {
  interface Case {
    name: string;
    items: Array<{ id: string; productId: string; name: string; price: number; quantity: number }>;
    orderType: "delivery" | "takeaway" | "dinein";
    couponCode?: string;
    loyaltyPointsToRedeem?: number;
    serverDeliveryFee?: number;
    netFood: number;
    packaging: number;
    delivery: number;
    gst: number;
    cgst: number;
    sgst: number;
    grandTotal: number;
    royaltyPaise: number;
    branchPaise: number;
  }

  const CASES: Case[] = [
    {
      name: "₹105 food: the included share is exactly ₹5.00, not ₹5.25",
      items: [{ id: "l1", productId: "prod_105", name: "Burger", price: 105, quantity: 1 }],
      orderType: "takeaway",
      netFood: 105,
      packaging: 15,
      delivery: 0,
      gst: 5,
      cgst: 2.5,
      sgst: 2.5,
      grandTotal: 120,
      royaltyPaise: 700,
      branchPaise: 11300,
    },
    {
      name: "a ₹50 coupon + ₹20 loyalty reduces the GST base to ₹330",
      items: [{ id: "l1", productId: "prod_400", name: "Burger", price: 400, quantity: 1 }],
      orderType: "takeaway",
      couponCode: "WELCOME50",
      loyaltyPointsToRedeem: 20,
      netFood: 330,
      packaging: 15,
      delivery: 0,
      gst: 15.71,
      cgst: 7.86,
      sgst: 7.85,
      grandTotal: 345,
      royaltyPaise: 2200,
      branchPaise: 32300,
    },
    {
      name: "delivery adds the courier quote and no tax on top",
      items: [{ id: "l1", productId: "prod_500", name: "Burger", price: 500, quantity: 1 }],
      orderType: "delivery",
      serverDeliveryFee: 35,
      netFood: 500,
      packaging: 15,
      delivery: 35,
      gst: 23.81,
      cgst: 11.91,
      sgst: 11.9,
      grandTotal: 550,
      royaltyPaise: 3333,
      branchPaise: 51667,
    },
    {
      name: "paise-bearing total (courier quote ₹42.55) stays exact in paise",
      items: [{ id: "l1", productId: "prod_200", name: "Burger", price: 200, quantity: 2 }],
      orderType: "delivery",
      serverDeliveryFee: 42.55,
      netFood: 400,
      packaging: 15,
      delivery: 42.55,
      gst: 19.05,
      cgst: 9.53,
      sgst: 9.52,
      grandTotal: 457.55,
      royaltyPaise: 2667,
      branchPaise: 43088,
    },
    {
      name: "dine-in ₹105: no packaging, no delivery, total is the menu price",
      items: [{ id: "l1", productId: "prod_105", name: "Burger", price: 105, quantity: 1 }],
      orderType: "dinein",
      netFood: 105,
      packaging: 0,
      delivery: 0,
      gst: 5,
      cgst: 2.5,
      sgst: 2.5,
      grandTotal: 105,
      royaltyPaise: 700,
      branchPaise: 9800,
    },
    {
      name: "₹0 total: nothing to tax, nothing to split",
      items: [{ id: "l1", productId: "prod_0", name: "Comp", price: 0, quantity: 1 }],
      orderType: "dinein",
      netFood: 0,
      packaging: 0,
      delivery: 0,
      gst: 0,
      cgst: 0,
      sgst: 0,
      grandTotal: 0,
      royaltyPaise: 0,
      branchPaise: 0,
    },
  ];

  it.each(CASES.map((c) => [c.name, c] as const))("%s", async (_name, c) => {
    const b = await calculateOrderPricing({
      items: c.items,
      branchId: "branch_ahmedabad_1",
      orderType: c.orderType,
      couponCode: c.couponCode,
      loyaltyPointsToRedeem: c.loyaltyPointsToRedeem,
      serverDeliveryFee: c.serverDeliveryFee,
    });

    // R1: the reported GST is the INCLUDED share, never added on top.
    expect(b.gst).toBe(c.gst);
    expect(b.cgst).toBe(c.cgst);
    expect(b.sgst).toBe(c.sgst);
    // CGST + SGST == GST exactly, in paise (no float dust, no lost paisa).
    expect(Math.round(b.cgst * 100) + Math.round(b.sgst * 100)).toBe(
      Math.round(b.gst * 100)
    );
    expect(b.cgst + b.sgst).toBeCloseTo(b.gst, 10);

    // R2: no whole-rupee rounding, and no tax added to the total.
    expect(b.packagingFee).toBe(c.packaging);
    expect(b.deliveryFee).toBe(c.delivery);
    expect(b.grandTotal).toBe(c.grandTotal);
    expect(b.grandTotal).toBe(
      Math.round(Math.max(0, c.netFood + c.packaging + c.delivery) * 100) / 100
    );
    if (c.gst > 0) {
      // "no tax added": the total is the net food + fees, never that PLUS gst.
      expect(b.grandTotal).toBeLessThan(
        c.netFood + c.packaging + c.delivery + b.gst
      );
    }

    // R3: royalty on the ex-GST food value; the split sums to the total.
    const netFoodPaise = Math.round(c.netFood * 100);
    const gstPaise = Math.round(c.gst * 100);
    const exGstPaise = netFoodPaise - gstPaise;
    expect(b.split.brandRoyaltyPaise).toBe(Math.round((exGstPaise * 7) / 100));
    expect(b.split.brandRoyaltyPaise).toBe(c.royaltyPaise);
    expect(b.split.branchTransferPaise).toBe(c.branchPaise);
    expect(b.split.brandRoyaltyPaise + b.split.branchTransferPaise).toBe(
      Math.round(c.grandTotal * 100)
    );
    expect(Number.isInteger(b.split.brandRoyaltyPaise)).toBe(true);
    expect(Number.isInteger(b.split.branchTransferPaise)).toBe(true);
  });

  it("reports the inclusive GST share, which is never 5% of the inclusive amount", async () => {
    const b = await calculateOrderPricing({
      items: [{ id: "l1", productId: "prod_400", name: "Burger", price: 400, quantity: 1 }],
      branchId: "branch_ahmedabad_1",
      orderType: "takeaway",
    });
    expect(b.gst).toBe(19.05); // 400 · 5/105
    expect(b.gst).not.toBe(20); // the old add-on-top 5%
  });

  it("refuses to price a delivery order without a server courier fee", async () => {
    // R6: no default, no static ₹35 — a delivery priced without a persisted
    // quote is unpriceable, not free and not a guess.
    await expect(
      calculateOrderPricing({
        items: [{ id: "l1", productId: "prod_400", name: "Burger", price: 400, quantity: 1 }],
        branchId: "branch_ahmedabad_1",
        orderType: "delivery",
      })
    ).rejects.toMatchObject({ statusCode: 422, code: "DELIVERY_FEE_REQUIRED" });
  });

  it("ignores a client deliveryFee even when a server fee is supplied (PAY-01)", async () => {
    const base = {
      items: [{ id: "l1", productId: "prod_400", name: "Burger", price: 400, quantity: 1 }],
      branchId: "branch_ahmedabad_1",
      orderType: "delivery" as const,
      serverDeliveryFee: 61.25,
    };
    for (const clientFee of [0, 35, 999]) {
      const b = await calculateOrderPricing({ ...base, deliveryFee: clientFee });
      expect(b.deliveryFee).toBe(61.25);
      expect(b.grandTotal).toBe(476.25);
    }
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
    // Client-writable top-level fields: deliberately wrong. R7 says they must
    // never be read — the server-written `pricing` snapshot is the source.
    deliveryFee: 0,
    packagingFee: 0,
    pricing: { grandTotal: 450, deliveryFee: 35, packagingFee: 15 },
  };

  it("matches when the stored total equals the server recomputation", async () => {
    const res = await repriceOrderForVerification({ ...storedCart });
    expect(res.matches).toBe(true);
    expect(res.expectedGrandTotal).toBe(450);
    expect(res.expectedPaise).toBe(45000);
    expect(res.storedPaise).toBe(45000);
  });

  it("mismatches when the stored total drifted from catalog truth", async () => {
    const res = await repriceOrderForVerification({
      ...storedCart,
      pricing: { ...storedCart.pricing, grandTotal: 400 }, // tampered/stale total
    });
    expect(res.matches).toBe(false);
    expect(res.expectedPaise).toBe(45000);
    expect(res.storedPaise).toBe(40000);
  });

  it("reports no match when no stored total exists", async () => {
    const res = await repriceOrderForVerification({
      ...storedCart,
      // Server-written fees are present; only the total is missing.
      pricing: { deliveryFee: 35, packagingFee: 15 },
    });
    expect(res.matches).toBe(false);
    expect(res.storedPaise).toBeNull();
    expect(res.expectedPaise).toBe(45000);
  });

  it("reuses the stored server courier fee instead of a live quote (R7)", async () => {
    const res = await repriceOrderForVerification({
      ...storedCart,
      pricing: { grandTotal: 476.25, deliveryFee: 61.25, packagingFee: 15 },
    });
    // The courier price moved (₹61.25 was quoted and stored); the client's
    // top-level ₹0 and any live re-quote are irrelevant to the agreed total.
    expect(res.expectedGrandTotal).toBe(476.25);
    expect(res.expectedPaise).toBe(47625);
    expect(res.matches).toBe(true);
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
