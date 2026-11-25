import { describe, it, expect, vi } from "vitest";

/**
 * A5 finding 2 (fix wave 2026-11-20): the KOT `discount_total` omitted the
 * loyalty (Grill-Coins) discount while `total` and `collect_cash` included it.
 *
 * BEFORE: `petpoojaFinancials` received `discount + loyaltyDiscount` (so `total`
 * and COD `collect_cash` are ₹80 off on a ₹50 coupon + ₹30 coin order) while the
 * same payload carried `discount_type:"F"`, `discount_total:"50.00"`. The POS
 * ticket then showed a ₹50 discount against a ₹80-reduced total — till reports,
 * restaurant settlement and any reconciliation against the customer's payment
 * disagree by the coin amount.
 *
 * CHOSEN OPTION: make `discount_total` CONSISTENT with the discount that drives
 * `total` (not "drop a non-zero loyaltyDiscount at the front door").
 *
 *   - The front door is ALREADY closed: Grill-Coins redemption is a non-launch
 *     feature (`config.loyalty.redemptionEnabled` defaults false) and checkout
 *     refuses any non-zero request with a typed 409
 *     (`razorpay.service.resolveRedeemableCoins`, pinned below). So no NEW order
 *     can acquire a loyalty discount.
 *   - The orders that still carry one are LEGACY: the customer really did pay
 *     ₹30 in coins. Removing that discount from the KOT would raise the POS
 *     total by ₹30 and make COD `collect_cash` demand money the customer never
 *     owes — a worse defect than the reporting drift it fixes.
 *
 * So the wire discount must equal the discount used to compute `total`. The
 * fix makes that a single value produced by `petpoojaFinancials` (the same
 * module that computes `total`), instead of two independently-read numbers in
 * `orderPush.ts`.
 */

const { mockDb, savedDocs } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  const docRef = (col: string, id: string): any => {
    const path = `${col}/${id}`;
    const ref: any = {
      id,
      path,
      get: async () => ({
        exists: Object.prototype.hasOwnProperty.call(savedDocs, path),
        data: () => savedDocs[path],
        ref,
      }),
      set: async (data: any, opts?: any) => {
        savedDocs[path] =
          opts?.merge && savedDocs[path] ? { ...savedDocs[path], ...data } : data;
      },
    };
    return ref;
  };
  const mockDb: any = {
    collection: (col: string) => ({ doc: (id: string) => docRef(col, id) }),
    runTransaction: async (fn: any) =>
      fn({
        get: (ref: any) => ref.get(),
        set: (ref: any, data: any, opts?: any) => ref.set(data, opts),
      }),
  };
  return { mockDb, savedDocs };
});

vi.mock("firebase-admin", () => {
  const FieldValue = {
    serverTimestamp: () => "MOCK_TIMESTAMP",
    increment: (n: number) => n,
    arrayUnion: (item: any) => [item],
    delete: () => "MOCK_DELETE",
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

import { formatPetpoojaOrderPayload } from "../src/modules/petpooja/orderPush";
import { petpoojaFinancials } from "../src/modules/petpooja/financials";
import { config } from "../src/config/env";

const TAXES = [
  { id: "11", name: "CGST", rate: 2.5 },
  { id: "12", name: "SGST", rate: 2.5 },
];
const BRANCH = { id: "b1", petpoojaStoreId: "PP_B1", petpoojaTaxes: TAXES };

/**
 * 235 x 2 + 105 x 1 = 575 inclusive food; packaging 15; courier 60.
 * The customer-app order emits NO item_tax for inclusive lines, which is the
 * shape the vendor ruling defines.
 */
function order(pricing: Record<string, any> = {}) {
  return {
    id: "ord_discount_1",
    branchId: "b1",
    fulfillmentType: "DELIVERY",
    paymentMethod: "COD",
    customerName: "Aarav Mehta",
    customerPhone: "+919825100001",
    address: { street: "123 Adajan Main Rd" },
    items: [
      { id: "l1", petpoojaItemId: "101", name: "Burger", price: 235, quantity: 2 },
      { id: "l2", petpoojaItemId: "102", name: "Fries", price: 105, quantity: 1 },
    ],
    pricing: {
      foodSubtotal: 575,
      gst: 27.38,
      packagingFee: 15,
      deliveryFee: 60,
      discount: 0,
      loyaltyDiscount: 0,
      grandTotal: 650,
      ...pricing,
    },
  };
}

const details = (o: any) =>
  formatPetpoojaOrderPayload(o, BRANCH, "PP_B1", "b1", o.id).orderinfo.OrderInfo.Order.details;

const rupees = (wire: string) => Math.round(Number(wire) * 100);

describe("KOT discount_total equals the discount that drives total", () => {
  it("coupon 50 + loyalty 30 are ONE discount on the wire and in the total", () => {
    // 575 - 80 + 15 packing + 60 courier = 570.
    const o = order({ discount: 50, loyaltyDiscount: 30, grandTotal: 570 });
    const d = details(o);

    expect(d.discount_total).toBe("80.00");
    expect(d.tax_total).toBe("0.00");
    expect(d.total).toBe("570.00");
    expect(d.collect_cash).toBe("570.00");

    // THE INVARIANT this fix exists for: the discount sent to the POS is the
    // discount subtracted from the item subtotal to reach `total`.
    const itemSubtotal = 575;
    const fees = 75; // packing 15 + courier 60
    expect(rupees(d.discount_total)).toBe(
      Math.round((itemSubtotal + fees - Number(d.total)) * 100)
    );
  });

  it("a coupon-only order is unchanged (no regression on the common path)", () => {
    const o = order({ discount: 50, loyaltyDiscount: 0, grandTotal: 600 }); // 575-50+75
    const d = details(o);
    expect(d.discount_total).toBe("50.00");
    expect(d.total).toBe("600.00");
  });

  it("an undiscounted order sends 0.00, never a fabricated figure", () => {
    const d = details(order({ discount: 0, loyaltyDiscount: 0, grandTotal: 650 }));
    expect(d.discount_total).toBe("0.00");
    expect(d.total).toBe("650.00");
  });

  it("loyalty-only (legacy coin order) discount still lands on the wire", () => {
    // A pre-launch order that spent coins without a coupon. Dropping it would
    // make the POS demand 30 rupees the customer already paid.
    const o = order({ discount: 0, loyaltyDiscount: 30, grandTotal: 620 });
    const d = details(o);
    expect(d.discount_total).toBe("30.00");
    expect(d.total).toBe("620.00");
  });

  it("the builder takes the discount figure from financials, not a second read", () => {
    // One source of truth: `petpoojaFinancials` returns the discount it applied,
    // and that exact string is what `orderPush` puts on the wire. If these two
    // ever diverge again, this fails regardless of which number moved.
    const o = order({ discount: 50, loyaltyDiscount: 30, grandTotal: 570 });
    const line = {
      final_price: "235.00",
      quantity: "2",
      price: "235.00",
      item_discount: "0.00",
    };
    const financials = petpoojaFinancials({
      items: [
        { final_price: "235.00", quantity: "2" },
        { final_price: "105.00", quantity: "1" },
      ],
      discount: 80,
      packagingFee: 15,
      deliveryFee: 60,
      customerTotal: 570,
      isDelivery: true,
      restaurantDelivery: false,
      paymentType: "COD",
      taxIncluded: true,
      chargeTax: 0,
    });

    const d = details(o);
    expect(d.discount_total).toBe(financials.discountTotal);
    expect(d.total).toBe(financials.total);
    expect(d.collect_cash).toBe(financials.collect_cash);
    // Sanity: the paise arithmetic is what produced both strings.
    expect(financials.discountTotal).toBe("80.00");
    expect(line.final_price).toBe("235.00");
  });
});

describe("the front door is already closed for NEW loyalty discounts", () => {
  it("checkout refuses a non-zero coin redemption while the feature is off", async () => {
    const previous = config.loyalty.redemptionEnabled;
    config.loyalty.redemptionEnabled = false;
    try {
      const { resolveRedeemableCoins } = await import("../src/modules/payments/razorpay.service");
      expect(() => resolveRedeemableCoins("cust_1", 30)).toThrow(
        /Grill-Coins redemption is not available/
      );
      // A zero request is honoured, so the launch app path is untouched.
      expect(resolveRedeemableCoins("cust_1", 0)).toBe(0);
    } finally {
      config.loyalty.redemptionEnabled = previous;
    }
  });
});
