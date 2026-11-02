import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// Pure formatting only. No Firebase initialization, provider calls or secrets.
vi.mock("../src/core/firebase", () => ({ db: {} }));
vi.mock("../src/core/errors", () => ({ captureErrorSnapshot: vi.fn() }));
vi.mock("../src/core/middleware", () => ({ assertOrderBranchAccess: vi.fn() }));

import { formatPetpoojaOrderPayload } from "../src/modules/petpooja/orderPush";
import { formatPetpoojaV21Payload, type PetpoojaTestOrder, type ScenarioItem } from "../src/modules/petpooja/testRunner";

const fixture = JSON.parse(readFileSync(path.join(__dirname, "fixtures/petpooja-vendor-attachment-shape.json"), "utf8"));
const taxRows = [{ id: "3928", name: "CGST", rate: 2.5 }, { id: "3929", name: "SGST", rate: 2.5 }];
const callback = "https://callback.example.test/petpooja/webhook";
const credentials = { app_key: "fixture-only", app_secret: "fixture-only", access_token: "fixture-only" };

// Ruling 2026-11-02: a tax-inclusive line omits `item_tax`, so the odd-paise
// conservation check only applies to lines that carry tax rows (the sandbox
// runner is exclusive and still does).
function withoutOptionalItemTax(shape: any): any {
  return shape;
}

function assertShape(actual: any, shape: any, at = "$"): void {
  if (typeof shape === "string") { expect(typeof actual, at).toBe(shape); return; }
  if (Array.isArray(shape)) {
    expect(Array.isArray(actual), at).toBe(true);
    for (const value of actual) assertShape(value, shape[0], `${at}[]`);
    return;
  }
  expect(actual !== null && typeof actual === "object" && !Array.isArray(actual), at).toBe(true);
  const expectedKeys = Object.keys(shape).sort();
  const actualKeys = Object.keys(actual).sort();
  // The single permitted divergence: an omitted optional `item_tax` key.
  if (expectedKeys.includes("item_tax") && !actualKeys.includes("item_tax")) {
    expect(actual.tax_inclusive, `${at}.tax_inclusive must be true when item_tax is omitted`).toBe(true);
    expect(actualKeys, at).toEqual(expectedKeys.filter((key) => key !== "item_tax"));
  } else {
    expect(actualKeys, at).toEqual(expectedKeys);
  }
  for (const key of Object.keys(shape)) {
    if (key === "item_tax" && !(key in actual)) continue;
    assertShape(actual[key], shape[key], `${at}.${key}`);
  }
}

const round = (value: number) => Math.round(value * 100) / 100;
const cents = (value: string) => Math.round(Number(value) * 100);
const base = (price: number, id = "7765862"): ScenarioItem => ({ id, name: "Synthetic contract fixture", price, quantity: 1, isVeg: true, gstType: "goods" });
// Illustrative numeric IDs are TEST ONLY, never a claim of outlet mapping.
const addon = { id: "1150783", name: "Synthetic extra", price: 30, groupId: 135699 };
const variant = { id: "89058", name: "Synthetic variant" };
const cases = [
  { id: "items_tax", items: [base(350), base(220, "118829149")], discount: 0, packaging: 0 },
  { id: "addons_tax", items: [{ ...base(310), modifiers: [addon, { ...addon, id: "1150813", price: 40 }] }], discount: 0, packaging: 20 },
  { id: "variation_tax", items: [{ ...base(270), variation: variant }], discount: 0, packaging: 0 },
  { id: "discount_tax", items: [base(290)], discount: 50, packaging: 0 },
  { id: "addon_variation_tax", items: [{ ...base(249), modifiers: [addon], variation: variant }], discount: 0, packaging: 20 },
];

function orderFor(entry: typeof cases[number]): PetpoojaTestOrder {
  const itemTotal = round(entry.items.reduce((sum, item) => sum +
    (item.price + (item.modifiers ?? []).reduce((n, mod) => n + mod.price, 0)) * item.quantity, 0));
  const gst = round((itemTotal - entry.discount) * .05);
  return { scenarioId: entry.id, orderType: "takeaway", status: "placed", items: entry.items,
    pricing: { itemTotal, discount: entry.discount, gst, deliveryFee: 0, packagingFee: entry.packaging,
      grandTotal: round(itemTotal - entry.discount + gst + entry.packaging) } };
}

function appPayload(order: PetpoojaTestOrder, taxIds = ["3928", "3929"], options?: { taxInclusive?: boolean }): any {
  const items = order.items.map((item) => ({
    productId: `prod_fixture_${item.id}`, name: item.name, quantity: item.quantity,
    unitPrice: item.price + (item.modifiers ?? []).reduce((sum, mod) => sum + mod.price, 0),
    // R4b: the POS's OWN addon/group ids (the local cart id is not one).
    modifiers: (item.modifiers ?? []).map((mod) => ({ ...mod, petpoojaAddonId: mod.id, petpoojaGroupId: mod.groupId })),
    petpoojaVariationId: item.variation?.id, petpoojaVariationName: item.variation?.name,
  }));
  return formatPetpoojaOrderPayload({
    items, fulfillmentType: "TAKEAWAY", paymentMethod: "COD", customerName: "Synthetic fixture",
    customerPhone: "9000000000", pricing: { ...order.pricing, foodSubtotal: order.pricing.itemTotal, loyaltyDiscount: 0 },
  }, { name: "Synthetic fixture outlet", petpoojaTaxes: taxRows.filter((row) => taxIds.includes(row.id)) }, "fixture-not-live", "fixture", "contract-test", undefined, undefined, undefined, options);
}

function sandboxPayload(order: PetpoojaTestOrder): any {
  return formatPetpoojaV21Payload(order, "fixture-not-live", "contract-test", callback, new Date("2026-10-28T00:00:00Z"), taxRows);
}

for (const [name, build] of [["production", appPayload], ["sandbox", sandboxPayload]] as const) {
  describe(`${name}: actual vendor attachment`, () => {
    for (const entry of cases) {
      it(`matches every supplied key/type for ${entry.id}`, () => {
        const body = { ...credentials, ...build(orderFor(entry)) };
        assertShape(body, fixture.shape);
        expect(() => JSON.parse(JSON.stringify(body))).not.toThrow();
        for (const item of body.orderinfo.OrderInfo.OrderItem.details) {
          expect(item.final_price).toBe((Number(item.price) - Number(item.item_discount)).toFixed(2));
          for (const mod of item.AddonItem.details) expect(Number.isInteger(mod.group_id)).toBe(true);
        }
      });
    }
    it("conserves odd-paise GST across item rows, summary rows and tax_total", () => {
      // The production builder runs our INCLUSIVE menu: it asserts no per-line
      // tax and no bottom food-GST rows, so the conserved figure is 0 and the
      // total is what the customer pays. The sandbox runner is EXCLUSIVE and
      // carries the rupee 13.95 food GST this case was written around.
      const info = name === "production"
        ? build(orderFor(cases[4]), undefined, { taxInclusive: false }).orderinfo.OrderInfo
        : build(orderFor(cases[4])).orderinfo.OrderInfo;
      const declared = cents(info.Order.details.tax_total);
      const taxableLines = info.OrderItem.details.filter((item: any) => item.tax_inclusive === false);
      const lineTotal = taxableLines.reduce((sum: number, item: any) =>
        sum + (item.item_tax || []).reduce((n: number, row: any) => n + cents(row.amount), 0), 0);
      const summaryTotal = info.Tax.details.reduce((sum: number, row: any) => sum + cents(row.tax), 0);
      expect(declared).toBe(1395);
      expect(lineTotal).toBe(declared);
      expect(summaryTotal).toBe(declared);
      for (const tax of info.Tax.details) {
        const acrossItems = taxableLines.reduce((sum: number, item: any) => sum +
          (item.item_tax || []).filter((row: any) => row.id === tax.id).reduce((n: number, row: any) => n + cents(row.amount), 0), 0);
        expect(cents(tax.tax)).toBe(acrossItems);
      }
    });
  });
}

it("blocks positive GST when the item metadata resolves no tax rows (exclusive menu)", () => {
  // Only an EXCLUSIVE line asserts item_tax, so only it needs the rows.
  expect(() => appPayload(orderFor(cases[0]), [], { taxInclusive: false }))
    .toThrow(/positive order GST has no matched tax rows/);
});

it("detects the legacy envelope and string add-on group regressions", () => {
  const body = { ...credentials, ...sandboxPayload(orderFor(cases[4])) };
  const legacy = structuredClone(body);
  legacy.udid = legacy.orderinfo.udid;
  delete legacy.orderinfo.udid;
  expect(() => assertShape(legacy, fixture.shape)).toThrow();
  body.orderinfo.OrderInfo.OrderItem.details[0].AddonItem.details[0].group_id = "135699";
  expect(() => assertShape(body, fixture.shape)).toThrow();
});
