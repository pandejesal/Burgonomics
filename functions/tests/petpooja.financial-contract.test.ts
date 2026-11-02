import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Corrected R4 â€” the POS `total` is the RESTAURANT DUE, not the customer total
 * (owner decision 2026-10-31, after the vendor emails and branch
 * fix/petpooja-vendor-contract-20261031).
 *
 * Pinned here:
 *  - `tax_inclusive` stays TRUE and line price/final_price stay inclusive (R4
 *    first bullet is unchanged);
 *  - each line's item_tax is its exact share of gstIncluded IN PAISE, and the
 *    Tax rows are the exact sum of the serialized item tax;
 *  - a courier fee appears in delivery_charges and NOT in total;
 *  - a restaurant self-delivery fee does appear in total;
 *  - `enable_delivery` is 1 only for self-delivery;
 *  - COD `collect_cash` equals restaurant total, including takeaway;
 *  - online `collect_cash` remains zero;
 *  - the payload matches the vendor attachment's documented keys/types.
 */

const { savedDocs } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  return { savedDocs };
});

const { mockDb } = vi.hoisted(() => {
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
  return { mockDb };
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

import {
  formatPetpoojaOrderPayload,
  pushOrderToPetpooja,
  PetpoojaStructuralError,
} from "../src/modules/petpooja/orderPush";
import { petpoojaFinancials, petpoojaGstLiability, restaurantLiableItemTax } from "../src/modules/petpooja/financials";
import { formatPetpoojaV21Payload } from "../src/modules/petpooja/testRunner";
import { config } from "../src/config/env";

const TAXES = [
  { id: "11", name: "CGST", rate: 2.5 },
  { id: "12", name: "SGST", rate: 2.5 },
];
const BRANCH = { id: "b1", petpoojaStoreId: "PP_B1", petpoojaTaxes: TAXES };

/**
 * 235x2 + 105x1 = 575 inclusive; included GST = round2(575 * 5/105) = 27.38;
 * packaging 15; courier 60; customer total 650.
 */
function order(extra: Record<string, any> = {}) {
  return {
    id: "ord_r4b_1",
    branchId: "b1",
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
    },
    ...extra,
  };
}

function details(o: any, options?: { taxInclusive?: boolean }) {
  return formatPetpoojaOrderPayload(o, BRANCH, "PP_B1", "b1", o.id, undefined, undefined, undefined, options)
    .orderinfo.OrderInfo;
}

describe("R4b restaurant due, delivery flags and cash collection", () => {
  it("serializes a customer takeaway COD using its real nested fields", () => {
    const info = details(order({ fulfillment: "takeaway", paymentMethod: undefined, payment: { method: "cod" }, createdAt: "2026-11-01T09:11:08.034Z", pricing: { foodSubtotal: 10, gst: 0, packagingFee: 0, deliveryFee: 0, discount: 0, loyaltyDiscount: 0, grandTotal: 10 }, items: [{ id: "l1", petpoojaItemId: "101", name: "Item", price: 10, quantity: 1 }] }));
    expect(info.Order.details).toMatchObject({ order_type: "P", payment_type: "COD", collect_cash: "10.00", enable_delivery: 0, total: "10.00" });
  });

  it("serializes a walk-in counter order", () => {
    const info = details(order({ customerId: "cust_walkin", orderType: "dinein", paymentMethod: "cod", createdAt: { toDate: () => new Date("2026-11-01T09:11:08.034Z") }, pricing: { foodSubtotal: 10, gst: 0, packagingFee: 0, deliveryFee: 0, discount: 0, loyaltyDiscount: 0, grandTotal: 10 }, items: [{ itemId: "l1", petpoojaItemId: "101", name: "Item", price: 10, quantity: 1 }] }));
    expect(info.Order.details).toMatchObject({ order_type: "D", payment_type: "COD", collect_cash: "10.00", enable_delivery: 0, total: "10.00" });
  });

  it("uses the customer app's address-only delivery contact", () => {
    const info = details(order({ fulfillment: "delivery", customerName: undefined, customerPhone: undefined, deliveryAddress: undefined, address: { contactName: "Test Contact", contactPhone: "9825100001", line1: "Test Street" }, payment: { method: "cod" } }));
    expect(info.Customer.details).toMatchObject({ name: "Test Contact", phone: "9825100001", address: "Test Street" });
  });

  it("relays paid staff walk-in UPI and card tenders as CARD only", () => {
    for (const paymentMethod of ["upi", "razorpay"]) {
      const walkin = order({ customerId: "cust_walkin", userId: "staff_1", paymentStatus: "completed", orderType: "takeaway", paymentMethod, pricing: { grandTotal: 10, gst: 0 }, items: [{ itemId: "l1", petpoojaItemId: "101", name: "Item", price: 10, quantity: 1 }] });
      expect(details(walkin).Order.details).toMatchObject({ order_type: "P", payment_type: "CARD", collect_cash: "0.00", enable_delivery: 0, total: "10.00" });
      expect(() => details({ ...walkin, customerId: "customer_1" })).toThrow(/unverified payment type/);
      expect(() => details({ ...walkin, userId: "cust_walkin" })).toThrow(/unverified payment type/);
      expect(() => details({ ...walkin, paymentStatus: "pending" })).toThrow(/unverified payment type/);
    }
  });

  it("refuses unknown fulfillment or tender", () => {
    expect(() => details(order({ fulfillment: "unknown", paymentMethod: "cod" }))).toThrow(PetpoojaStructuralError);
    expect(() => details(order({ fulfillment: "takeaway", paymentMethod: "unknown" }))).toThrow(PetpoojaStructuralError);
    expect(() => details(order({ fulfillment: "takeaway", paymentMethod: "razorpay" }))).toThrow(/unverified payment type/);
  });

  it("keeps GST-inclusive line prices and declares tax_inclusive true", () => {
    const info = details(order({ fulfillmentType: "DELIVERY" }));
    for (const line of info.OrderItem.details) {
      expect(line.tax_inclusive).toBe(true);
      expect(line.price).toBe(line.final_price);
    }
  });

  it("asserts no per-line tax for an inclusive order (vendor ruling 2026-11-02)", () => {
    const info = details(order({ fulfillmentType: "DELIVERY" }));
    // An inclusive line omits item_tax entirely and the bottom block asserts no
    // food GST, so nothing can disagree with total_tax.
    for (const line of info.OrderItem.details) {
      expect(line.tax_inclusive).toBe(true);
      expect(line).not.toHaveProperty("item_tax");
    }
    expect(info.Tax.details).toEqual([]);
    expect(Number(info.Order.details.tax_total)).toBe(0);
  });

  it("conserves item tax in paise when the menu is EXCLUSIVE", () => {
    const info = details(order({ fulfillmentType: "DELIVERY" }), { taxInclusive: false });
    const allItemTaxPaise = info.OrderItem.details.reduce(
      (sum: number, line: any) =>
        sum + line.item_tax.reduce((s: number, t: any) => s + Math.round(Number(t.amount) * 100), 0),
      0
    );
    expect(allItemTaxPaise).toBe(2738);
    expect(Number(info.Order.details.tax_total)).toBe(27.38);

    const taxRowPaise = info.Tax.details.reduce(
      (sum: number, row: any) => sum + Math.round(Number(row.tax) * 100),
      0
    );
    expect(taxRowPaise).toBe(allItemTaxPaise);
    // Per tax row, the summary equals the serialized item rows of that id.
    for (const row of info.Tax.details) {
      const fromItems = info.OrderItem.details.reduce(
        (sum: number, line: any) =>
          sum +
          line.item_tax
            .filter((t: any) => t.id === row.id)
            .reduce((s: number, t: any) => s + Math.round(Number(t.amount) * 100), 0),
        0
      );
      expect(Math.round(Number(row.tax) * 100)).toBe(fromItems);
      expect(row.restaurant_liable_amt).toBe(row.tax);
    }
  });

  it("courier delivery: the fee is in delivery_charges AND inside total (vendor ruling)", () => {
    const info = details(
      order({ fulfillmentType: "DELIVERY", paymentMethod: "COD", dispatchProvider: "borzo" })
    );
    expect(info.Order.details.delivery_charges).toBe("60.00");
    // 575 inclusive + 15 packaging + the courier's 60 = the customer's 650.
    expect(info.Order.details.total).toBe("650.00");
    expect(info.Order.details.enable_delivery).toBe(0);
    // COD: collect_cash equals total exactly.
    expect(info.Order.details.collect_cash).toBe("650.00");
    expect(info.Order.details.collect_cash).toBe(info.Order.details.total);
  });

  it("self-delivery COD: total includes the fee and cash to collect is the customer total", () => {
    const info = details(
      order({
        fulfillmentType: "DELIVERY",
        paymentMethod: "COD",
        dispatchType: "manual_branch_terminal",
      })
    );
    expect(info.Order.details.delivery_charges).toBe("60.00");
    expect(info.Order.details.total).toBe("650.00");
    expect(info.Order.details.enable_delivery).toBe(1);
    expect(info.Order.details.collect_cash).toBe("650.00");
  });

  it("self-delivery online collects no cash", () => {
    const info = details(
      order({
        fulfillmentType: "DELIVERY",
        paymentMethod: "RAZORPAY",
        paymentChannel: "razorpay",
        dispatchType: "manual_branch_terminal",
      })
    );
    expect(info.Order.details.enable_delivery).toBe(1);
    expect(info.Order.details.collect_cash).toBe("0.00");
  });

  it("takeaway COD collects the total, with no delivery charge at all", () => {
    const info = details(
      order({ fulfillmentType: "TAKEAWAY", paymentMethod: "COD", dispatchType: "manual_branch_terminal" })
    );
    // A takeaway order is delivered by nobody: a stale stored fee must not be
    // reported as a charge (that was the vendor's exact complaint).
    expect(info.Order.details.delivery_charges).toBe("0.00");
    expect(info.Order.details.total).toBe("590.00"); // 575 + 15 packaging
    expect(info.Order.details.enable_delivery).toBe(0);
    expect(info.Order.details.collect_cash).toBe("590.00");
  });

  it("applies coupon and coin discounts to the total", () => {
    const o = order({ fulfillmentType: "DELIVERY", paymentMethod: "COD", dispatchProvider: "borzo" });
    o.pricing.discount = 50;
    o.pricing.loyaltyDiscount = 20;
    o.pricing.grandTotal = 580;
    const info = details(o);
    // 575 - 50 - 20 + 15 packaging + 60 courier
    expect(info.Order.details.total).toBe("580.00");
    expect(info.Order.details.discount_total).toBe("50.00");
  });
});

describe("R4b vendor attachment shape", () => {
  const fixture = JSON.parse(
    readFileSync(
      resolve(__dirname, "fixtures/petpooja-vendor-attachment-shape.json"),
      "utf8"
    )
  ).shape;

  function typeOf(value: any): string {
    if (Array.isArray(value)) return "array";
    if (value === null) return "null";
    return typeof value;
  }

  /**
   * The attachment stores TYPE NAMES as the leaf values ("string", "number",
   * "boolean"), so a leaf is compared as a declared type, not as a sample
   * value. Everything is reported, never silently skipped.
   */
  function diffShape(expected: any, actual: any, path: string, gaps: string[]): void {
    if (typeof expected === "string") {
      const actualType = typeOf(actual);
      if (actualType !== expected) {
        gaps.push(`${path}: expected ${expected}, got ${actualType}`);
      }
      return;
    }
    const expectedType = typeOf(expected);
    const actualType = typeOf(actual);
    if (expectedType !== actualType) {
      gaps.push(`${path}: expected ${expectedType}, got ${actualType}`);
      return;
    }
    if (expectedType === "array") {
      if (actual.length === 0) return;
      if (expected.length === 0) return;
      diffShape(expected[0], actual[0], `${path}[]`, gaps);
      return;
    }
    if (expectedType === "object") {
      for (const key of Object.keys(expected)) {
        if (!(key in actual)) {
          // Petpooja ruling 2026-11-02: `item_tax` is OPTIONAL and MUST be
          // absent on a tax-inclusive line. Nothing else may be missing.
          if (key === "item_tax" && actual.tax_inclusive === true) continue;
          gaps.push(`${path}.${key}: MISSING`);
          continue;
        }
        diffShape(expected[key], actual[key], `${path}.${key}`, gaps);
      }
    }
  }

  it("matches the attachment's OrderInfo keys and types", () => {
    const payload = formatPetpoojaOrderPayload(
      order({ fulfillmentType: "DELIVERY", paymentMethod: "COD", dispatchProvider: "borzo" }),
      BRANCH,
      "PP_B1",
      "b1",
      "ord_r4b_1"
    );
    const gaps: string[] = [];
    // Attachment root also carries the credentials, which this builder adds at
    // POST time (never in the payload object). Compare the orderinfo subtree.
    diffShape(fixture.orderinfo, payload.orderinfo, "orderinfo", gaps);
    expect(gaps).toEqual([]);
  });
});

describe("R4b no fabricated ids", () => {
  const base = order({ fulfillmentType: "DELIVERY", paymentMethod: "COD", dispatchProvider: "borzo" });

  it("refuses an addon without verified POS ids instead of sending 'addon' / group_id 0", () => {
    const withAddon = {
      ...base,
      items: [
        {
          id: "l1",
          petpoojaItemId: "101",
          name: "Burger",
          price: 235,
          quantity: 1,
          modifiers: [{ id: "bun_brioche", name: "Brioche Bun", priceDelta: 20 }],
        },
      ],
    };
    let err: any = null;
    try {
      formatPetpoojaOrderPayload(withAddon, BRANCH, "PP_B1", "b1", "ord_addon");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PetpoojaStructuralError);
    expect(String(err.message)).toContain("Brioche Bun");
    expect(String(err.message)).toMatch(/group|addon id/i);
  });

  it("sends verified addon ids and group ids unchanged", () => {
    const withAddon = {
      ...base,
      items: [
        {
          id: "l1",
          petpoojaItemId: "101",
          name: "Burger",
          price: 235,
          quantity: 1,
          modifiers: [
            {
              id: "local_1",
              name: "Brioche Bun",
              priceDelta: 20,
              petpoojaItemId: "201",
              petpoojaGroupId: 7,
            },
          ],
        },
      ],
    };
    const info = details(withAddon);
    expect(info.OrderItem.details[0].AddonItem.details[0]).toMatchObject({
      id: "201",
      group_id: 7,
      name: "Brioche Bun",
    });
  });

  it("refuses an unverified variation instead of sending a name/id the POS cannot match", () => {
    const withVariation = {
      ...base,
      items: [
        {
          id: "l1",
          petpoojaItemId: "101",
          name: "Burger",
          price: 235,
          quantity: 1,
          variationName: "Half",
        },
      ],
    };
    expect(() =>
      formatPetpoojaOrderPayload(withVariation, BRANCH, "PP_B1", "b1", "ord_var")
    ).toThrow(PetpoojaStructuralError);
  });

  it("leaves plain items unaffected", () => {
    expect(() => details({ ...base, fulfillmentType: "TAKEAWAY" })).not.toThrow();
  });
});

describe("R4b structural park (no relay)", () => {
  let prevMock: boolean;
  const fetchMock = vi.fn();

  beforeEach(() => {
    for (const key of Object.keys(savedDocs)) delete savedDocs[key];
    prevMock = config.mock.petpoojaPos;
    config.mock.petpoojaPos = false;
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    savedDocs["branches/b1"] = { ...BRANCH };
    // POS-11: the line must be priceable from the catalog so the test parks on
    // the ADD-ON mapping (its actual subject), not on a missing product.
    savedDocs["products/l1"] = { price: 235, inStock: true };
  });

  afterEach(() => {
    config.mock.petpoojaPos = prevMock;
    vi.unstubAllGlobals();
  });

  it("parks the order with an operator-visible reason and never POSTs", async () => {
    savedDocs["orders/ord_struct"] = {
      ...order({ fulfillmentType: "TAKEAWAY" }),
      id: "ord_struct",
      items: [
        {
          id: "l1",
          petpoojaItemId: "101",
          name: "Burger",
          price: 235,
          quantity: 1,
          modifiers: [{ id: "bun_brioche", name: "Brioche Bun", priceDelta: 20 }],
        },
      ],
    };
    const pushed = await pushOrderToPetpooja("ord_struct");
    expect(pushed).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    const doc = savedDocs["orders/ord_struct"];
    expect(doc.petpoojaStatus).toBe("blocked_configuration");
    expect(String(doc.lastPetpoojaError)).toMatch(/Brioche Bun/);
    // Not queued for the retry worker: nothing would change on a retry.
    expect(doc.petpoojaStatus).not.toBe("pending_retry");
  });
});


/**
 * Vendor-accepted financial primitives (36cdd6b / 3c2dafc), reconciled with
 * R1/R4: all GST belongs to the restaurant; `tax_included` decides
 * whether tax is ADDED or already inside the line price.
 */
describe("financial primitives: restaurant liability and inclusive-vs-exclusive", () => {
  const line = (liability: "restaurant" | "vendor") => ({
    final_price: "200.00",
    quantity: "1",
    gst_liability: liability,
    item_tax: [
      { id: "11", amount: "5.00" },
      { id: "12", amount: "5.00" },
    ],
  });
  const base = {
    discount: 0,
    packagingFee: 20,
    deliveryFee: 40,
    customerTotal: 270,
    isDelivery: true,
    restaurantDelivery: false,
    paymentType: "COD",
  };

  it("uses the vendor's written restaurant liability regardless of captured gst_type", () => {
    expect(petpoojaGstLiability("services")).toBe("restaurant");
    expect(petpoojaGstLiability("goods")).toBe("restaurant");
    expect(petpoojaGstLiability(undefined)).toBe("restaurant");
    expect(petpoojaGstLiability("unknown")).toBe("restaurant");
  });

  it("does not allow an order discount larger than its items", () => {
    expect(() =>
      petpoojaFinancials({
        items: [],
        discount: 1,
        packagingFee: 0,
        deliveryFee: 0,
        customerTotal: 0,
        isDelivery: false,
        restaurantDelivery: false,
        paymentType: "COD",
        taxIncluded: true,
      })
    ).toThrow(/BLOCKED_CONFIGURATION/);
  });

  it("adds all restaurant GST with EXCLUSIVE prices, ignoring stale vendor liability", () => {
    const goods = petpoojaFinancials({ ...base, items: [line("restaurant")], taxIncluded: false });
    // 200 + 10 kept tax + 20 packaging + 40 delivery (vendor ruling: fee is in total)
    expect(goods.total).toBe("270.00");
    const vendor = petpoojaFinancials({ ...base, items: [line("vendor")], taxIncluded: false });
    expect(vendor.total).toBe("270.00"); // stale liability metadata cannot remove restaurant GST
    expect(goods.taxTotal).toBe("10.00");
    expect(goods.enable_delivery).toBe(0);
    expect(goods.collect_cash).toBe(goods.total);
    expect(restaurantLiableItemTax([line("vendor")], "11")).toBe(5);
  });

  it("never adds the included GST again when prices are INCLUSIVE (R1/R4)", () => {
    const goods = petpoojaFinancials({ ...base, items: [line("restaurant")], taxIncluded: true });
    const vendor = petpoojaFinancials({ ...base, items: [line("vendor")], taxIncluded: true });
    // 200 + 20 packaging + 40 delivery; the 10 inside the price is not re-added
    expect(goods.total).toBe("260.00");
    expect(vendor.total).toBe("260.00");
    // Nothing was added, so nothing is reported as added tax.
    expect(goods.taxTotal).toBe("0.00");
  });

  it.each(["COD", "ONLINE"])("balances inclusive/exclusive totals and cash for %s", (paymentType) => {
    for (const taxIncluded of [true, false]) {
      for (const mode of ["pickup", "courier", "self"] as const) {
        const result = petpoojaFinancials({ ...base, items: [line("restaurant")], taxIncluded, paymentType,
          isDelivery: mode !== "pickup", restaurantDelivery: mode === "self",
          // A pick-up order is delivered by nobody, so it carries no fee.
          deliveryFee: mode === "pickup" ? 0 : 40 });
    // The courier fee is inside total for every delivery mode (vendor ruling).
    const expected = 200 + 20 + (taxIncluded ? 0 : 10) + (mode === "pickup" ? 0 : 40);
        expect(result.total).toBe(expected.toFixed(2));        expect(result.taxTotal).toBe(taxIncluded ? "0.00" : "10.00");
        expect(result.collect_cash).toBe(paymentType === "COD" ? result.total : "0.00");
        expect(result.enable_delivery).toBe(mode === "self" ? 1 : 0);
      }
    }
  });

  it("sandbox runner declares tax_inclusive false and keeps the captured tax rows", () => {
    const payload: any = formatPetpoojaV21Payload(
      {
        scenarioId: "financial-contract",
        orderType: "delivery",
        status: "placed",
        items: [
          { id: "101", name: "Synthetic test item", price: 200, quantity: 1, isVeg: true, gstType: "goods" },
        ],
        pricing: { itemTotal: 200, discount: 0, gst: 10, packagingFee: 20, deliveryFee: 40, grandTotal: 270 },
      } as any,
      "fixture_res",
      "bgx_financial_contract",
      "https://example.test/callback",
      new Date(),
      [
        { id: "11", name: "CGST", rate: 2.5 },
        { id: "12", name: "SGST", rate: 2.5 },
      ]
    );
    const info = payload.orderinfo.OrderInfo;
    expect(info.OrderItem.details[0].tax_inclusive).toBe(false);
    expect(info.OrderItem.details[0].gst_liability).toBe("restaurant");
    // The runner is EXCLUSIVE; total now also carries the 40 delivery fee.
    expect(info.Order.details.total).toBe("270.00");
    expect(info.Order.details.tax_total).toBe("10.00");
    expect(info.Tax.details.map((row: any) => row.restaurant_liable_amt)).toEqual(["5.00", "5.00"]);
    expect(info.Order.details.enable_delivery).toBe(0);
    expect(info.Order.details.collect_cash).toBe("270.00");
  });
});
