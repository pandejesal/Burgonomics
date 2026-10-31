import { describe, expect, it, vi } from "vitest";

vi.mock("../src/core/firebase", () => ({ db: {} }));
vi.mock("../src/core/errors", () => ({ captureErrorSnapshot: vi.fn() }));
vi.mock("../src/core/middleware", () => ({ assertOrderBranchAccess: vi.fn() }));

import { formatPetpoojaOrderPayload } from "../src/modules/petpooja/orderPush";
import { formatPetpoojaV21Payload } from "../src/modules/petpooja/testRunner";
import { petpoojaFinancials, petpoojaGstLiability } from "../src/modules/petpooja/financials";

const taxes = [{ id: "11", name: "CGST", rate: 2.5 }, { id: "12", name: "SGST", rate: 2.5 }];
function production(gstType: string, extra: Record<string, unknown> = {}) {
  return formatPetpoojaOrderPayload({
    items: [{ productId: "prod_fixture_101", name: "Synthetic test item", unitPrice: 200, quantity: 1 }],
    fulfillmentType: "DELIVERY", paymentMethod: "COD",
    pricing: { foodSubtotal: 200, discount: 0, loyaltyDiscount: 0, gst: 10, packagingFee: 20, deliveryFee: 40, grandTotal: 270 },
    ...extra,
  }, { petpoojaTaxes: taxes }, "fixture-only", "fixture", "financial-contract",
  [{ petpoojaItemId: "101", taxIds: ["11", "12"], taxInclusive: false, taxUnsupported: false, gstType } as any]).orderinfo.OrderInfo;
}
function sandbox(gstType: string) {
  return (formatPetpoojaV21Payload({
    scenarioId: "financial-contract", orderType: "delivery", status: "placed",
    items: [{ id: "101", name: "Synthetic test item", price: 200, quantity: 1, isVeg: true, gstType }],
    pricing: { itemTotal: 200, discount: 0, gst: 10, packagingFee: 20, deliveryFee: 40, grandTotal: 270 },
  } as any, "fixture-only", "financial-contract", "https://example.test/callback", new Date(), taxes) as any).orderinfo.OrderInfo;
}

for (const [label, build] of [["production", production], ["sandbox", sandbox]] as const) {
  describe(`${label} documented financial contract`, () => {
    it("excludes integrator-remitted GST and courier charges from restaurant due", () => {
      const info = build("services");
      expect(info.Order.details.total).toBe("220.00");
      expect(info.Order.details.tax_total).toBe("10.00");
      expect(info.OrderItem.details[0].gst_liability).toBe("vendor");
      expect(info.Tax.details.map((row: any) => row.restaurant_liable_amt)).toEqual(["0.00", "0.00"]);
      expect(info.Order.details.enable_delivery).toBe(0);
      expect(info.Order.details.collect_cash).toBe("0.00");
    });
    it("includes restaurant-liable GST but still excludes third-party courier charges", () => {
      const info = build("goods");
      expect(info.Order.details.total).toBe("230.00");
      expect(info.OrderItem.details[0].gst_liability).toBe("restaurant");
      expect(info.Tax.details.map((row: any) => row.restaurant_liable_amt)).toEqual(["5.00", "5.00"]);
      expect(info.Order.details.collect_cash).toBe("0.00");
    });
    it("blocks unknown ownership instead of assigning liability to the restaurant", () => {
      expect(() => build("unknown")).toThrow(/BLOCKED_CONFIGURATION/);
    });
  });
}

it("supports explicitly selected restaurant self-delivery and COD collection", () => {
  const info = production("goods", { dispatchType: "manual_branch_terminal" });
  expect(info.Order.details.total).toBe("270.00");
  expect(info.Order.details.enable_delivery).toBe(1);
  expect(info.Order.details.collect_cash).toBe("270.00");
  const online = production("goods", { dispatchType: "manual_branch_terminal", paymentMethod: "ONLINE" });
  expect(online.Order.details.collect_cash).toBe("0.00");
});

it("never applies merchant collection to a counter pickup", () => {
  const info = production("goods", { fulfillmentType: "TAKEAWAY", dispatchType: "manual_branch_terminal" });
  expect(info.Order.details.enable_delivery).toBe(0);
  expect(info.Order.details.collect_cash).toBe("0.00");
});

it("uses the persisted all-in unit price instead of raw legacy base price", () => {
  const info = production("goods", {
    items: [{ productId: "prod_fixture_101", name: "Synthetic test item", basePrice: 100, price: 150, unitPrice: 200, quantity: 1 }],
  });
  expect(info.OrderItem.details[0].price).toBe("200.00");
});

it("defines both documented GST ownership modes without a default", () => {
  expect(petpoojaGstLiability("services")).toBe("vendor");
  expect(petpoojaGstLiability("goods")).toBe("restaurant");
  expect(() => petpoojaGstLiability(undefined)).toThrow();
});

it("does not allow an order discount larger than its items", () => {
  expect(() => petpoojaFinancials({ items: [], discount: 1, packagingFee: 0, deliveryFee: 0,
    customerTotal: 0, isDelivery: false, restaurantDelivery: false, paymentType: "COD" })).toThrow();
});
