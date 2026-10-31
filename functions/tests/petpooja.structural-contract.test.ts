import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Petpooja STRUCTURAL CONTRACT — both order builders under one fixture.
 *
 * These tests encode the vendor's corrected save_order sample (2026-10-26):
 * Petpooja rejected the five sandbox relays on STRUCTURE (HTTP 200 +
 * success:"1" notwithstanding). Anything that ships an unverified identifier
 * is therefore barred by constructor-level fail-closed gates, not by tests
 * alone. Fixture data: NUMERIC POS ids of the vendor sample's SHAPE — no
 * credentials, no real customer data, no real outlet rows impersonated.
 */

const { mockDb, savedDocs } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  const mockDb = {
    batch: () => ({
      set: vi.fn((docRef: any, data: any) => {
        savedDocs[docRef.id || "last"] = data;
      }),
      commit: async () => {},
    }),
    collection: (colName: string) => ({
      where: (field: string, op: string, val: any) => ({
        limit: (n: number) => ({
          get: async () => {
            const matched = Object.entries(savedDocs)
              .filter(([p]) => p.startsWith(`${colName}/`))
              .map(([p, data]) => ({
                id: p.slice(colName.length + 1),
                ref: { id: p.slice(colName.length + 1), path: p },
                data: () => data,
              }))
              .filter((d) => d.data()[field] === val)
              .slice(0, n);
            return { docs: matched, empty: matched.length === 0 };
          },
        }),
      }),
      doc: (docId: string) => ({
        id: docId,
        update: vi.fn(async (data: any) => {
          savedDocs[`${colName}/${docId}`] = { ...(savedDocs[`${colName}/${docId}`] || {}), ...data };
        }),
        set: vi.fn(async (data: any) => {
          savedDocs[`${colName}/${docId}`] = { ...(savedDocs[`${colName}/${docId}`] || {}), ...data };
        }),
        get: vi.fn(async () => ({
          exists: Object.prototype.hasOwnProperty.call(savedDocs, `${colName}/${docId}`),
          data: () => savedDocs[`${colName}/${docId}`],
          ref: {
            id: docId,
            set: vi.fn(async (data: any) => {
              savedDocs[`${colName}/${docId}`] = { ...(savedDocs[`${colName}/${docId}`] || {}), ...data };
            }),
          },
        })),
      }),
    }),
  };
  return { mockDb, savedDocs };
});

vi.mock("firebase-admin", () => {
  const FieldValue = { serverTimestamp: () => "MOCK_TIMESTAMP", increment: (n: number) => n };
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

import { formatPetpoojaOrderPayload } from "../src/modules/petpooja";
import {
  buildPetpoojaTestOrder,
  evaluatePetpoojaTestOrderSendability,
  formatPetpoojaV21Payload,
  PETPOOJA_TEST_SCENARIOS,
} from "../src/modules/petpooja/testRunner";
import {
  captureTaxCatalogue,
  parseItemTaxCsv,
  parseTaxInclusiveFlag,
} from "../src/modules/petpooja/menuSyncWebhook";
import { config } from "../src/config/env";

const CALLBACK = "https://callback.example.test/petpooja/webhook";

/**
 * Legacy spellings banned by the vendor sample — reproduced here RAW (JSON key
 * escape) so a config regression surfaces as a concrete assertion failure.
 */
const FORBIDDEN_LEGACY_KEYS = [
  "addon_id",
  "addon_name",
  "addon_items",
  "item_id",
  "item_name",
  "item_attribute",
  '"tax_details"',
  '"order_items"',
  '"clientOrderID"',
  '"resID"',
  '"customer_name"',
  '"customer_phone"',
  '"customer_address"',
  '"order_type_legacy"',
];

function assertSampleStrict(payload: any) {
  expect(Object.keys(payload)).toEqual(["orderinfo"]);
  expect(Object.keys(payload.orderinfo).sort()).toEqual(["OrderInfo", "device_type", "udid"]);
  expect(payload.orderinfo.udid).toBe("");
  expect(payload.orderinfo.device_type).toBe("Web");
  expect(payload.orderinfo.OrderInfo).not.toHaveProperty("Discount");
  const branchTaxesTax = payload.orderinfo.OrderInfo.Tax.details;
  for (const t of branchTaxesTax) {
    expect(t.type).toBe("P");
    expect(typeof t.price).toBe("string");
    expect(String(t.price)).not.toContain("%");
  }
  for (const line of payload.orderinfo.OrderInfo.OrderItem.details as Array<Record<string, unknown>>) {
    // UNIT final_price invariant from the sample.
    expect(line.final_price).toBe(
      (Number(line.price) - Number(line.item_discount)).toFixed(2)
    );
    // quantity is a numeric string.
    expect(String(Number(line.quantity))).toBe(line.quantity);
  }
}

describe("app-order builder (orderPush.formatPetpoojaOrderPayload) — vendor sample contract", () => {
  it("emits the sample envelope, unit final_price, numeric tax strings and callback for a vendor-shape COD order", () => {
    const order = {
      id: "ord_doc_1",
      orderNumber: "BUR-DOC-1",
      fulfillmentType: "DELIVERY",
      paymentMethod: "COD",
      customerName: "Fixture Customer",
      customerPhone: "+919000000000",
      deliveryAddress: {
        full: "Fixture Customer Address, Ahmedabad",
        lat: "23.022500",
        lng: "72.571400",
      },
      items: [
        {
          lineId: "l1",
          productId: "prod_branch_fixture_7765862",
          name: "Garlic Bread (3Pieces)",
          unitPrice: 140,
          quantity: 2,
          veg: true,
        },
      ],
      pricing: { gst: 14, deliveryFee: 50, packagingFee: 20, discount: 0, grandTotal: 364 },
    };
    const payload = formatPetpoojaOrderPayload(
      order,
      // H2 — fixture supplies the branch's CAPTURED tax catalogue (no builder
      // default exists to lean on).
      {
        id: "branch_fixture",
        petpoojaStoreId: "fixture_res",
        petpoojaTaxes: [
          { id: "3928", name: "CGST", rate: 2.5 },
          { id: "3929", name: "SGST", rate: 2.5 },
        ],
      },
      "fixture_res",
      "branch_fixture",
      "ord_doc_1",
      // H1 — the prefetch snapshot the production push supplies.
      [
        {
          petpoojaItemId: "7765862",
          taxIds: ["3928", "3929"],
          taxInclusive: false,
          taxUnsupported: false,
          gstType: "goods", // Synthetic restaurant-liable fixture.
        },
      ]
    );
    assertSampleStrict(payload as any);

    const order_ = payload.orderinfo.OrderInfo.Order.details;
    // orderID is the FIRESTORE doc id — the callback resolution key.
    expect(order_.orderID).toBe("ord_doc_1");
    // Config-derived callback (the same URL the status webhook lives on).
    expect(order_.callback_url).toMatch(/\/petpooja\/webhook$/);
    expect(order_.payment_type).toBe("COD");
    expect(order_.collect_cash).toBe("0.00"); // Not merchant self-delivery.
    expect(order_.total).toBe("314.00"); // Food + merchant GST + packing, excluding courier.
    expect(order_.enable_delivery).toBe(0);
    expect(order_.dc_tax_percentage).toBe("0");
    expect(order_.pc_tax_percentage).toBe("0");
    // The customer address/coords are the order's own, never invented.
    expect(payload.orderinfo.OrderInfo.Customer.details.address).toBe(
      "Fixture Customer Address, Ahmedabad"
    );
    expect(payload.orderinfo.OrderInfo.Customer.details.latitude).toBe("23.022500");

    const line = payload.orderinfo.OrderInfo.OrderItem.details[0];
    expect(line.id).toBe("7765862");
    expect(line.price).toBe("140.00");
    expect(line.final_price).toBe("140.00");
    expect(line.quantity).toBe("2");
    expect(line.tax_inclusive).toBe(false);
    // The fixture outlet declares CGST 2.5 + SGST 2.5 (vendor sample values).
    expect(line.item_tax).toHaveLength(2);
    expect(line.item_tax[0].tax_percentage).toBe("2.5");

    // The shipped body JSON must not contain ANY legacy spelling.
    const noCredsBody = JSON.stringify(payload);
    for (const legacy of FORBIDDEN_LEGACY_KEYS) {
      expect(noCredsBody).not.toContain(legacy);
    }
  });
});

describe("sandbox runner builder (testRunner.formatPetpoojaV21Payload) — vendor sample contract", () => {
  it("emits the sample envelope, unit final_price, callback and synthetic contacts for every scenario", () => {
    for (const scenario of PETPOOJA_TEST_SCENARIOS) {
      const order = buildPetpoojaTestOrder(scenario.id);
      order.items = order.items.map((item) => ({ ...item, gstType: "goods" }));
      const payload = formatPetpoojaV21Payload(
        order as any,
        "fixture_res",
        `bgx_${scenario.id}_1111111111`,
        CALLBACK,
        new Date(),
        // H2 — the mapped branch's captured tax catalogue (fixture truth).
        [
          { id: "3928", name: "CGST", rate: 2.5 },
          { id: "3929", name: "SGST", rate: 2.5 },
        ]
      );
      assertSampleStrict(payload as any);
      const order_ = payload.orderinfo.OrderInfo.Order.details;
      expect(order_.orderID).toBe(`bgx_${scenario.id}_1111111111`);
      expect(order_.callback_url).toBe(CALLBACK);
      // The synthetic cases do not assign a merchant rider.
      expect(order_.collect_cash).toBe("0.00");
      expect(order_.enable_delivery).toBe(0);
      // Synthetic contacts are non-empty and unmistakably fictional.
      const customer = payload.orderinfo.OrderInfo.Customer.details;
      expect(customer.phone).toBe("9000000000");
      expect(customer.email).toContain("example.com");
      expect(customer.name).toContain("Sandbox");
    }
  });
});

describe("dry-run scenario outputs — scenario verdicts are structural, never acceptance", () => {
  it("reports exactly which MT-01-like scenarios are BLOCKED_CONFIGURATION on the unconfigured outlet", () => {
    // The captured demo outlet publishes `addongroups: []`,
    // `itemallowaddon: "0"` on all items and no variation definitions —
    // scenarios whose payloads would need an addon or variation mapping are
    // reported BLOCKED_CONFIGURATION; the relay does NOT POST them and the
    // dry-run never claims acceptance (success:1 is NOT acceptance).
    const verdicts = PETPOOJA_TEST_SCENARIOS.map((s) => ({
      id: s.id,
      gaps: evaluatePetpoojaTestOrderSendability(buildPetpoojaTestOrder(s.id) as any),
    }));
    for (const v of verdicts) {
      if (v.id === "takeaway-with-modifiers") {
        expect(v.gaps.length).toBeGreaterThan(0);
        expect(v.gaps.every((g) => g.field === "OrderItem.details[].AddonItem")).toBe(true);
      } else {
        expect(v.gaps).toEqual([]);
      }
    }
  });
});

describe("menuSync tax capture helpers — provenance-backed, never guessed", () => {
  it("captures the outlet catalogue rows only when id + positive rate resolve (typed)", () => {
    const capture = captureTaxCatalogue([
      { id: "11213", name: "CGST", tax_percentage: "2.5" },
      { id: "20375", name: "SGST", tax_percentage: "2.5" },
      { id: "9", rate: 9 },
      { id: "", name: "broken" },
      { id: "norow" },
      "not-an-object",
    ]);
    expect(capture.payloadHadTaxes).toBe(true);
    expect(capture.rows).toEqual([
      { id: "11213", name: "CGST", rate: 2.5 },
      { id: "20375", name: "SGST", rate: 2.5 },
      { id: "9", name: "", rate: 9 },
    ]);
    expect(capture.unsupported).toBe(3);
    expect(capture.unsupportedReasons.length).toBe(3);
  });

  it("refuses a non-array catalogue and never fabricates rows", () => {
    const capture = captureTaxCatalogue({ oops: true });
    expect(capture.rows).toEqual([]);
    expect(capture.unsupported).toBe(1);
    expect(capture.unsupportedReasons[0]).toMatch(/not an array/);
  });

  it("parses the item_tax CSV and decodes tax_inclusive strictly (no coercion)", () => {
    expect(parseItemTaxCsv("3928,3929")).toEqual(["3928", "3929"]);
    expect(parseItemTaxCsv(" 11213 , 20375, ")).toEqual(["11213", "20375"]);
    expect(parseItemTaxCsv("")).toEqual([]);
    expect(parseItemTaxCsv(undefined)).toEqual([]);
    expect(parseTaxInclusiveFlag(true)).toBe(true);
    expect(parseTaxInclusiveFlag("1")).toBe(true);
    expect(parseTaxInclusiveFlag(false)).toBe(false);
    expect(parseTaxInclusiveFlag(0)).toBe(false);
    expect(parseTaxInclusiveFlag("yes")).toBeNull();
    expect(parseTaxInclusiveFlag(undefined)).toBeNull();
    expect(parseTaxInclusiveFlag(null)).toBeNull();
  });
});

describe("fail-open prevention across both builders — no fabricated identifiers", () => {
  beforeEach(() => {
    config.mock.petpoojaPos = false;
  });
  afterEach(() => {
    config.mock.petpoojaPos = true;
  });

  it("orderPush builder refuses unverified add-on ids outright (BLOCKED_CONFIGURATION)", () => {
    expect(() =>
      formatPetpoojaOrderPayload(
        {
          id: "ord_bad_addon",
          fulfillmentType: "TAKEAWAY",
          paymentMethod: "COD",
          items: [
            {
              lineId: "l1",
              productId: "prod_branch_fixture_7765862",
              name: "Paneer Achari Tikka",
              unitPrice: 310,
              quantity: 1,
              modifiers: [{ id: "mod_extra_cheese", name: "Extra Cheese", price: 30 }],
            },
          ],
          pricing: { gst: 15.5, deliveryFee: 0, packagingFee: 20, discount: 0, grandTotal: 345.5 },
        },
        { id: "branch_fixture", petpoojaStoreId: "fixture_res" },
        "fixture_res",
        "branch_fixture",
        "ord_bad_addon"
      )
    ).toThrow(/BLOCKED_CONFIGURATION/);
  });
});
