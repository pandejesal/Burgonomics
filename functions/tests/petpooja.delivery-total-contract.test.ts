import { describe, it, expect, vi } from "vitest";

/**
 * Petpooja's 2 November 2026 ruling (binding, supersedes the internal "total is
 * restaurant due" decision R4b from 2026-10-31):
 *
 *  - `total` includes delivery_charges, packing_charges and any GST on them.
 *  - COD: `collect_cash` equals `total` exactly, same string format.
 *    Prepaid online: `collect_cash` stays "0.00".
 *  - `enable_delivery` is 0 for a third-party courier, 1 only for the
 *    restaurant's own rider. Takeaway is unchanged (0).
 *  - Tax-inclusive items: `tax_inclusive: true` and `item_tax` is ABSENT (not an
 *    empty array), and the bottom Tax block reports no food GST; `tax_total`
 *    carries only GST on delivery/packing (zero today, by configuration).
 *  - NON-inclusive menus (the approved sandbox DEMO runs) keep item_tax and the
 *    food-GST Tax block exactly as approved.
 *
 * Real order shapes, real production builder; no network, no Firestore.
 */

const { mockDb } = vi.hoisted(() => {
  const mockDb: any = {
    collection: () => ({
      doc: (id: string) => ({
        id,
        get: async () => ({ exists: false, data: () => undefined }),
        set: async () => undefined,
      }),
    }),
    runTransaction: async (fn: any) => fn({ get: (r: any) => r.get(), set: () => undefined }),
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

import { formatPetpoojaOrderPayload } from "../src/modules/petpooja/orderPush";
import { petpoojaFinancials } from "../src/modules/petpooja/financials";
import { formatPetpoojaV21Payload, buildPetpoojaTestOrder } from "../src/modules/petpooja/testRunner";

const TAXES = [
  { id: "3928", name: "CGST", rate: 2.5 },
  { id: "3929", name: "SGST", rate: 2.5 },
];
const BRANCH = { id: "branch_delivery", petpoojaStoreId: "31z58ciw0h", petpoojaTaxes: TAXES };

/** Food 200 (GST-inclusive), courier 45, no packaging: the vendor's own example. */
function deliveryOrder(extra: Record<string, any> = {}) {
  return {
    id: "ord_delivery_1",
    branchId: "branch_delivery",
    fulfillment: "delivery",
    paymentMethod: "cod",
    customerName: "Vendor Check",
    customerPhone: "+919825000111",
    deliveryAddress: { full: "12 Vendor Road", lat: 23.0338, lng: 72.5262 },
    items: [
      { id: "l1", productId: "p_burger", petpoojaItemId: "30791", name: "Burger", price: 200, quantity: 1 },
    ],
    pricing: {
      foodSubtotal: 200,
      gst: 9.52, // 200 inclusive at 5%
      packagingFee: 0,
      deliveryFee: 45,
      discount: 0,
      loyaltyDiscount: 0,
      grandTotal: 245,
    },
    ...extra,
  };
}

function info(o: any) {
  return formatPetpoojaOrderPayload(o, BRANCH, "31z58ciw0h", "branch_delivery", o.id)
    .orderinfo.OrderInfo;
}

describe("Petpooja 2 Nov 2026 ruling — delivery charges live inside total", () => {
  it("delivery COD: food 200 + courier 45 => total 245 and collect_cash '245.00'", () => {
    const details = info(deliveryOrder()).Order.details;
    expect(details.delivery_charges).toBe("45.00");
    expect(details.total).toBe("245.00");
    // Exactly the same string format and value: the vendor's COD rule.
    expect(details.collect_cash).toBe(details.total);
    expect(details.collect_cash).toBe("245.00");
  });

  it("prepaid online delivery: total includes the fee, collect_cash stays 0", () => {
    const details = info(
      deliveryOrder({ paymentMethod: "razorpay", paymentChannel: "razorpay" })
    ).Order.details;
    expect(details.payment_type).toBe("ONLINE");
    expect(details.delivery_charges).toBe("45.00");
    expect(details.total).toBe("245.00");
    expect(details.collect_cash).toBe("0.00");
  });

  it("packing charges are in total too, and COD still collects exactly total", () => {
    const o = deliveryOrder({ fulfillment: "takeaway", pricing: { ...deliveryOrder().pricing, deliveryFee: 0, packagingFee: 20, grandTotal: 220 } });
    const details = info(o).Order.details;
    expect(details.packing_charges).toBe("20.00");
    expect(details.total).toBe("220.00");
    expect(details.collect_cash).toBe("220.00");
  });

  it("enable_delivery is 0 for a third-party courier", () => {
    const details = info(deliveryOrder({ dispatchProvider: "borzo" })).Order.details;
    expect(details.enable_delivery).toBe(0);
    expect(typeof details.enable_delivery).toBe("number");
  });

  it("enable_delivery stays 1 for the restaurant's own in-house rider", () => {
    const details = info(deliveryOrder({ dispatchType: "manual_branch_terminal" })).Order.details;
    expect(details.enable_delivery).toBe(1);
    expect(details.total).toBe("245.00");
    expect(details.collect_cash).toBe("245.00");
  });

  it("takeaway is unchanged: no delivery fee to add, COD collects total", () => {
    const details = info(
      deliveryOrder({ fulfillment: "takeaway", pricing: { ...deliveryOrder().pricing, deliveryFee: 0, grandTotal: 200 } })
    ).Order.details;
    expect(details.order_type).toBe("P");
    expect(details.delivery_charges).toBe("0.00");
    expect(details.total).toBe("200.00");
    expect(details.collect_cash).toBe("200.00");
    expect(details.enable_delivery).toBe(0);
  });
});

describe("Petpooja 2 Nov 2026 ruling — tax-inclusive items", () => {
  it("a tax-inclusive line declares tax_inclusive and carries NO item_tax key", () => {
    const itemInfo = info(deliveryOrder());
    const line = itemInfo.OrderItem.details[0];
    expect(line.tax_inclusive).toBe(true);
    // "item_tax should not be calculated and avoided" — the key is ABSENT.
    expect(Object.prototype.hasOwnProperty.call(line, "item_tax")).toBe(false);
  });

  it("the bottom Tax block reports no food GST, and tax_total is only charge GST", () => {
    const itemInfo = info(deliveryOrder());
    expect(itemInfo.Tax.details).toEqual([]);
    // Our courier fee and packaging carry no added GST (dc/pc tax are 0).
    expect(itemInfo.Order.details.dc_tax_amount).toBe("0.00");
    expect(itemInfo.Order.details.pc_tax_amount).toBe("0.00");
    expect(itemInfo.Order.details.tax_total).toBe("0.00");
    // The invoice still balances: total is what the customer pays.
    expect(itemInfo.Order.details.total).toBe("245.00");
  });

  it("a NON-inclusive line still carries item_tax and the food-GST Tax block", () => {
    const o = deliveryOrder();
    // The approved sandbox DEMO shape: prices are ex-GST and GST is added.
    o.pricing = { ...o.pricing, gst: 10 };
    const itemInfo = formatPetpoojaOrderPayload(
      o,
      BRANCH,
      "31z58ciw0h",
      "branch_delivery",
      o.id,
      undefined,
      undefined,
      undefined,
      { taxInclusive: false }
    ).orderinfo.OrderInfo;

    const line = itemInfo.OrderItem.details[0];
    expect(line.tax_inclusive).toBe(false);
    expect(Array.isArray(line.item_tax)).toBe(true);
    expect(line.item_tax.map((t: any) => t.amount)).toEqual(["5.00", "5.00"]);

    // Food GST stays in the bottom Tax block for exclusive menus.
    expect(itemInfo.Tax.details.map((r: any) => r.tax)).toEqual(["5.00", "5.00"]);
    // tax_total = food GST + charge GST; total = food + GST + courier.
    expect(itemInfo.Order.details.tax_total).toBe("10.00");
    expect(itemInfo.Order.details.total).toBe("255.00");
    expect(itemInfo.Order.details.collect_cash).toBe("255.00");
  });

  it("an explicit exclusive pricing marker on the order selects the exclusive path", () => {
    const o = deliveryOrder({ pricing: { ...deliveryOrder().pricing, gst: 10, taxInclusive: false } });
    const itemInfo = info(o);
    expect(itemInfo.OrderItem.details[0].tax_inclusive).toBe(false);
    expect(Array.isArray(itemInfo.OrderItem.details[0].item_tax)).toBe(true);
    expect(itemInfo.Order.details.total).toBe("255.00");
  });
});

describe("Petpooja 2 Nov 2026 ruling — financial primitives", () => {
  const line = {
    final_price: "200.00",
    quantity: "1",
    gst_liability: "restaurant" as const,
    item_tax: [
      { id: "3928", amount: "5.00" },
      { id: "3929", amount: "5.00" },
    ],
  };
  const base = {
    discount: 0,
    packagingFee: 0,
    deliveryFee: 45,
    customerTotal: 245,
    isDelivery: true,
    restaurantDelivery: false,
    paymentType: "COD",
    chargeTax: 0,
  };

  it("inclusive: a third-party courier fee is INSIDE total (vendor ruling)", () => {
    const r = petpoojaFinancials({ ...base, items: [line], taxIncluded: true });
    expect(r.total).toBe("245.00");
    expect(r.collect_cash).toBe("245.00");
    expect(r.taxTotal).toBe("0.00");
    expect(r.enable_delivery).toBe(0);
  });

  it("exclusive: food GST is added and food + charge GST is reported", () => {
    const r = petpoojaFinancials({ ...base, items: [line], taxIncluded: false, chargeTax: 0 });
    expect(r.total).toBe("255.00"); // 200 + 10 GST + 45 courier
    expect(r.taxTotal).toBe("10.00");
    expect(r.collect_cash).toBe("255.00");
  });
});

describe("Petpooja 2 Nov 2026 ruling — sandbox runner delivery scenario", () => {
  const RUNNER_TAXES = [
    { id: "3928", name: "CGST", rate: 2.5 },
    { id: "3929", name: "SGST", rate: 2.5 },
  ];

  it("delivery-gst-fee now sends the courier fee inside total, cash equal to total", () => {
    const order = buildPetpoojaTestOrder("delivery-gst-fee");
    const payload: any = formatPetpoojaV21Payload(
      order,
      "31z58ciw0h",
      "pp_test_delivery",
      "https://example.test/callback",
      new Date(),
      RUNNER_TAXES
    );
    const details = payload.orderinfo.OrderInfo.Order.details;
    expect(Number(details.delivery_charges)).toBe(49);
    expect(Number(details.total)).toBe(order.pricing.grandTotal);
    expect(details.collect_cash).toBe(details.total);
    expect(details.enable_delivery).toBe(0);
    // The runner is EXCLUSIVE (approved): item_tax and the Tax block stay.
    const line = payload.orderinfo.OrderInfo.OrderItem.details[0];
    expect(line.tax_inclusive).toBe(false);
    expect(Array.isArray(line.item_tax)).toBe(true);
    expect(payload.orderinfo.OrderInfo.Tax.details.length).toBeGreaterThan(0);
    expect(Number(details.tax_total)).toBe(order.pricing.gst);
  });

  it("takeaway and bulk scenarios are unchanged in total (no delivery fee)", () => {
    for (const id of ["takeaway-with-modifiers", "bulk-party-order"] as const) {
      const order = buildPetpoojaTestOrder(id);
      const payload: any = formatPetpoojaV21Payload(
        order,
        "31z58ciw0h",
        `pp_test_${id}`,
        "https://example.test/callback",
        new Date(),
        RUNNER_TAXES
      );
      const details = payload.orderinfo.OrderInfo.Order.details;
      expect(Number(details.total)).toBe(order.pricing.grandTotal);
      expect(details.collect_cash).toBe(details.total);
      expect(Number(details.delivery_charges)).toBe(0);
    }
  });
});
