import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const { mockDb } = vi.hoisted(() => {
  const mockDb = {
    collection: (col: string) => ({
      where: (field: string, op: string, val: any) => ({
        limit: (n: number) => ({
          get: async () => {
            if (col === "stores" && field === "petpoojaRestId" && val === "pp_store_b") {
              return { docs: [{ data: () => ({ partnerBranchId: "branch_b" }) }] };
            }
            if (col === "branches" && field === "petpoojaStoreId" && val === "pp_code_b") {
              return { docs: [{ id: "branch_b", data: () => ({ petpoojaStoreId: "pp_code_b" }) }] };
            }
            return { docs: [] };
          },
        }),
      }),
      doc: (id: string) => ({
        get: async () => {
          if (col === "products" && /^prod_branch_test_1_\d+$/.test(id)) {
            return { exists: true, id, data: () => ({
              branchId: "branch_test_1", petpoojaItemId: id.slice("prod_branch_test_1_".length),
              petpoojaItemTaxIds: ["3928", "3929"], petpoojaTaxInclusive: false,
              petpoojaTaxUnsupported: false, petpoojaGstType: "goods",
            }) };
          }
          if (id === "branch_a" || id === "branch_b") {
            return { exists: true, id, data: () => ({}) };
          }
          if (id === "branch_test_1") {
            // H2 fixture — captured Petpooja tax catalogue for the relay.
            return {
              exists: true,
              id,
              data: () => ({
                petpoojaTaxes: [
                  { id: "3928", name: "CGST", rate: 2.5 },
                  { id: "3929", name: "SGST", rate: 2.5 },
                ],
              }),
            };
          }
          return { exists: false, id, data: () => ({}) };
        },
      }),
    }),
  };
  return { mockDb };
});

vi.mock("firebase-admin", () => {
  const FieldValue = { serverTimestamp: () => "MOCK_TIMESTAMP" };
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
  runPetpoojaTestScenario,
  resolvePetpoojaTestScenario,
  buildPetpoojaTestOrder,
  assertPetpoojaRelayAccess,
  evaluatePetpoojaTestOrderSendability,
  formatPetpoojaV21Payload,
  PETPOOJA_TEST_SCENARIOS,
} from "./testRunner";
import { config } from "../../config/env";
import { petpoojaTestRunnerSchema } from "../../core/validation";

/** Canonical ids (MT-01) and their legacy Petpooja-column aliases. */
const CANONICAL_SCENARIOS = [
  "dinein-basic-kot",
  "takeaway-with-modifiers",
  "delivery-gst-fee",
  "cancel-refund-sync",
  "bulk-party-order",
] as const;

const ALIASES: Record<string, string> = {
  items_tax: "dinein-basic-kot",
  addons: "takeaway-with-modifiers",
  variations: "delivery-gst-fee",
  discounts: "cancel-refund-sync",
  addon_variation: "bulk-party-order",
};

describe("runPetpoojaTestScenario (MT-01 sandbox relay)", () => {
  it.each(["addons", "variations", "addon_variation"])("pins every id and price in %s to the real push", (scenarioId) => {
    const fixture = JSON.parse(readFileSync(resolve(__dirname, "../../../tests/fixtures/petpooja-push-real-20261101.json"), "utf8"));
    const order = buildPetpoojaTestOrder(scenarioId);
    order.items = order.items.map(i => ({ ...i, gstType: "services" }));
    const taxes = fixture.taxes.map((t: any) => ({ id: t.taxid, name: t.taxname, rate: Number(t.tax) }));
    const payload: any = formatPetpoojaV21Payload(order, "31z58ciw0h", "test-real", "https://example.com/callback", new Date(), taxes);
    const lines = payload.orderinfo.OrderInfo.OrderItem.details;
    for (const [index, item] of order.items.entries()) {
      const source = fixture.items.find((i: any) => i.itemid === item.id);
      expect(source, `real item ${item.id}`).toBeDefined();
      expect(item.name).toBe(source.itemname);
      if (item.variation) {
        const row = source.variation.find((v: any) => v.variationid === item.variation!.id);
        expect(row).toBeDefined();
        expect(lines[index].id).toBe(row.id);
        expect(item.variation.name).toBe(row.name);
        expect(item.price).toBe(Number(row.price));
      } else expect(item.price).toBe(Number(source.price));
      for (const mod of item.modifiers || []) {
        const group = fixture.addongroups.find((g: any) => Number(g.addongroupid) === mod.groupId);
        expect(group).toBeDefined();
        const attachment = [...source.addon, ...source.variation.flatMap((v: any) => v.addon)].find((a: any) => Number(a.addon_group_id) === mod.groupId);
        expect(attachment).toBeDefined();
        const option = group.addongroupitems.find((o: any) => o.addonitemid === mod.id);
        expect(mod).toMatchObject({ name: option.addonitem_name, price: Number(option.addonitem_price) });
        expect(Number.isInteger(mod.groupId)).toBe(true);
      }
      expect(lines[index].tax_inclusive).toBe(false);
      expect(lines[index].gst_liability).toBe("restaurant");
    }
    const details = payload.orderinfo.OrderInfo.Order.details;
    expect(Number(details.total)).toBe(order.pricing.grandTotal - order.pricing.deliveryFee);
    expect(details.collect_cash).toBe(details.total);
    expect(details.enable_delivery).toBe(0);
    expect(Number(details.tax_total)).toBe(order.pricing.gst);
    if (scenarioId !== "addons") expect(order.items.some(i => i.variation)).toBe(true);
    if (scenarioId !== "variations") expect(order.items.some(i => i.modifiers?.length)).toBe(true);
    if (scenarioId === "addon_variation") expect(order.items.some(i => i.variation && i.modifiers?.length)).toBe(true);
  });
  it.each([["dinein-basic-kot", "598.50", "28.50"], ["cancel-refund-sync", "252.00", "12.00"]])("reproduces accepted round3 financials for %s", (id, total, taxTotal) => {
    // petpooja-submit-round3.log: bgx_items_tax_1793423643684 and
    // bgx_discount_tax_1793423647838; written vendor approval is authoritative.
    const order = buildPetpoojaTestOrder(id);
    order.items = order.items.map(i => ({ ...i, gstType: "services" }));
    const body: any = formatPetpoojaV21Payload(order, "31z58ciw0h", "round3-reproduction", "https://example.com/callback", new Date(), [{ id: "3928", name: "CGST", rate: 2.5 }, { id: "3929", name: "SGST", rate: 2.5 }]);
    const info = body.orderinfo.OrderInfo;
    expect(info.Order.details).toMatchObject({ total, tax_total: taxTotal, collect_cash: total, enable_delivery: 0 });
    expect(info.OrderItem.details.every((i: any) => i.gst_liability === "restaurant" && i.tax_inclusive === false)).toBe(true);
    expect(info.Tax.details.every((t: any) => t.restaurant_liable_amt === t.tax)).toBe(true);
    expect(info.Order.details.dc_gst_details.every((t: any) => t.gst_liable === "restaurant")).toBe(true);
    expect(info.Order.details.pc_gst_details.every((t: any) => t.gst_liable === "restaurant")).toBe(true);
  });
  const originalMockFlag = config.mock.petpoojaPos;

  beforeEach(() => {
    // Sandbox determinism: a unit test must never reach the live POS, even on
    // a developer box with real PETPOOJA_* credentials exported.
    config.mock.petpoojaPos = true;
  });

  afterEach(() => {
    config.mock.petpoojaPos = originalMockFlag;
  });

  it("exposes exactly the 5 MT-01 scenarios", () => {
    expect(PETPOOJA_TEST_SCENARIOS.map((s) => s.id)).toEqual([
      ...CANONICAL_SCENARIOS,
    ]);
  });

  for (const scenarioId of CANONICAL_SCENARIOS) {
    it(`runs ${scenarioId} with success, matching scenarioId and order id`, async () => {
      const result = await runPetpoojaTestScenario({
        scenarioId,
        branchId: "branch_test_1",
      });

      expect(result.success).toBe(true);
      expect(result.scenarioId).toBe(scenarioId);
      expect(typeof result.petpoojaOrderId).toBe("string");
      expect(result.petpoojaOrderId.length).toBeGreaterThan(0);
      expect(result.petpoojaOrderId).toMatch(/^pp_test_/);
    });

    it(`echoes ${scenarioId}'s client reference for support reconciliation`, async () => {
      // Support reconciliation key: the vendor's Order List displays OUR
      // clientOrderID in its Order No. column and exposes no POS id through
      // the API, so the replay must carry it back regardless of whether the
      // POS returned an id.
      const result = await runPetpoojaTestScenario({
        scenarioId,
        branchId: "branch_test_1",
      });
      expect(result.clientOrderID).toMatch(
        new RegExp(`^pp_test_${scenarioId}_\\d+$`)
      );
      expect(result.petpoojaOrderIdReturned).toBe(true);
      // The echo and the id are the same value in mock mode; in the live
      // sandbox the id is empty while the echo is real — the field must be
      // carried independently, not derived from petpoojaOrderId.
    });
  }

  for (const [alias, canonical] of Object.entries(ALIASES)) {
    it(`resolves alias "${alias}" to ${canonical} and echoes the caller's scenarioId`, async () => {
      const result = await runPetpoojaTestScenario({ scenarioId: alias });

      expect(result.success).toBe(true);
      expect(result.scenarioId).toBe(alias);
      expect(result.petpoojaOrderId.length).toBeGreaterThan(0);
      expect(resolvePetpoojaTestScenario(alias)?.id).toBe(canonical);
    });
  }

  it("rejects an unknown scenario instead of minting a fake pass", async () => {
    await expect(
      runPetpoojaTestScenario({ scenarioId: "definitely-not-a-scenario" })
    ).rejects.toThrow(/Unknown Petpooja test scenario/);
  });

  it("works without a branchId (relay-less sandbox path)", async () => {
    const result = await runPetpoojaTestScenario({ scenarioId: "dinein-basic-kot" });
    expect(result.success).toBe(true);
    expect(result.petpoojaOrderId.length).toBeGreaterThan(0);
  });

  describe("live relay — the client reference echo is independent of the POS id", () => {
    // §16.8 evidence class: Petpooja's live save_order answers
    // success:"1" with an EMPTY orderID while still registering the order
    // (Order List shows our clientOrderID as the Order No.). The echo must
    // survive exactly that response — deriving clientOrderID from
    // petpoojaOrderId (the one silent-reduction regression) would make every
    // real sandbox relay un-reconcilable and copy lists stay empty.
    let savedCreds: { appKey: string; appSecret: string; accessToken: string };
    const fetchMock = vi.fn();

    beforeEach(() => {
      config.mock.petpoojaPos = false; // live path — the POS POST is stubbed
      savedCreds = {
        appKey: config.petpooja.appKey,
        appSecret: config.petpooja.appSecret,
        accessToken: config.petpooja.accessToken,
      };
      config.petpooja.appKey = "test_app_key";
      config.petpooja.appSecret = "test_app_secret";
      config.petpooja.accessToken = "test_access_token";
      fetchMock.mockReset();
      fetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            success: "1",
            message: "Your order is saved.",
            restID: "",
            clientOrderID: "",
            orderID: "",
            code: 200,
          }),
        json: async () => ({
          success: "1",
          message: "Your order is saved.",
          restID: "",
          clientOrderID: "",
          orderID: "",
          code: 200,
        }),
      });
      vi.stubGlobal("fetch", fetchMock);
    });

    afterEach(() => {
      config.mock.petpoojaPos = true;
      config.petpooja.appKey = savedCreds.appKey;
      config.petpooja.appSecret = savedCreds.appSecret;
      config.petpooja.accessToken = savedCreds.accessToken;
      vi.unstubAllGlobals();
    });

    it("accepted with no id: petpoojaOrderId stays null while clientOrderID carries our reference", async () => {
      const result = await runPetpoojaTestScenario({
        scenarioId: "dinein-basic-kot",
        branchId: "branch_test_1",
      });
      expect(result.success).toBe(true);
      expect(result.petpoojaOrderId).toBeNull();
      expect(result.petpoojaOrderIdReturned).toBe(false);
      expect(result.clientOrderID).toMatch(/^pp_test_dinein-basic-kot_\d+$/);
      // The reference echoed is exactly the one sent in the payload.
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      const sentRef = body?.orderinfo?.OrderInfo?.Order?.details?.orderID;
      expect(typeof sentRef).toBe("string");
      expect(result.clientOrderID).toBe(sentRef);
    });
  });

  describe("scenario order shapes", () => {
    it("dine-in basic KOT: table T-01 with burger + fries", () => {
      const order = buildPetpoojaTestOrder("dinein-basic-kot");
      expect(order.orderType).toBe("dinein");
      expect(order.tableNumber).toBe("T-01");
      expect(order.items).toHaveLength(2);
      expect(order.pricing.deliveryFee).toBe(0);
      expect(order.pricing.grandTotal).toBeGreaterThan(0);
    });

    it("takeaway with the real required Coke add-on priced in", () => {
      const order = buildPetpoojaTestOrder("takeaway-with-modifiers");
      expect(order.orderType).toBe("takeaway");
      const modifiers = order.items[0].modifiers || [];
      expect(modifiers.map((m) => m.name)).toEqual(
        ["Coke"]
      );
      // 310 base + 10 Coke = 320, + unchanged 20 packaging + 5% GST.
      expect(order.pricing.itemTotal).toBe(320);
      expect(order.pricing.gst).toBe(16);
      expect(order.pricing.grandTotal).toBe(356);
    });

    it("delivery: 5% GST and delivery fee math", () => {
      const order = buildPetpoojaTestOrder("delivery-gst-fee");
      const { itemTotal, gst, deliveryFee, grandTotal } = order.pricing;
      expect(itemTotal).toBe(580); // real 290 variation x 2
      expect(gst).toBe(29); // 5% of 580
      expect(deliveryFee).toBe(49);
      expect(grandTotal).toBe(658); // 580 + 29 + unchanged 49 delivery
    });

    it("cancel/refund: discount is applied before GST", () => {
      const order = buildPetpoojaTestOrder("cancel-refund-sync");
      const { itemTotal, discount, gst, grandTotal } = order.pricing;
      expect(itemTotal).toBe(290);
      expect(discount).toBe(50);
      expect(gst).toBe(12); // 5% of (290 - 50)
      expect(grandTotal).toBe(252); // 240 + 12
    });

    it("combined case has one honest variation-plus-addon line", () => {
      const order = buildPetpoojaTestOrder("bulk-party-order");
      expect(order.items).toHaveLength(1);
      expect(order.items[0].variation?.itemId).toBe("10657617");
      expect(order.items[0].modifiers?.[0].id).toBe("93021");
      expect(order.pricing.grandTotal).toBe(334);
    });
  });

  it("petpoojaTestRunnerSchema accepts the relay body and rejects an empty one", () => {
    expect(
      petpoojaTestRunnerSchema.safeParse({ scenarioId: "dinein-basic-kot" }).success
    ).toBe(true);
    expect(
      petpoojaTestRunnerSchema.safeParse({
        scenarioId: "dinein-basic-kot",
        branchId: "branch_test_1",
      }).success
    ).toBe(true);
    expect(petpoojaTestRunnerSchema.safeParse({}).success).toBe(false);
    expect(petpoojaTestRunnerSchema.safeParse({ scenarioId: "" }).success).toBe(false);
  });
});

describe("formatPetpoojaV21Payload — vendor-locked structure (sample 2026-10-26)", () => {
  // Sanitized vendor-shape fixture: NUMERIC ids of the shape the vendor's own
  // sample mints, no credentials, fictional contacts. NOT outlet 5439 data —
  // the runner's DEMO outlet publishes no addons/variations, which the
  // sendability gate below pins separately.
  function vendorShapeOrder(): any {
    return {
      scenarioId: "vendor-shape-fixture",
      orderType: "delivery",
      status: "placed",
      items: [
        {
          id: "7765862",
          name: "Garlic Bread (3Pieces)",
          price: 140,
          quantity: 2,
          isVeg: true,
          gstType: "goods", // Explicit ownership of the synthetic fixture.
          variation: { id: "89058", name: "3Pieces" },
          modifiers: [
            { id: "1150783", name: "Mojito", price: 0, groupId: 135699 },
            { id: "1150813", name: "Cheese", price: 10, groupId: 135700 },
          ],
        },
      ],
      pricing: { itemTotal: 300, discount: 0, gst: 15, deliveryFee: 50, packagingFee: 20, grandTotal: 385 },
    };
  }

  it("emits ONLY orderinfo → OrderInfo + udid + device_type, with no Discount member", () => {
    const payload = formatPetpoojaV21Payload(
      vendorShapeOrder(),
      "test_rest_id",
      "bgx_fixture_1",
      "https://callback.example.test/petpooja/webhook",
      new Date(),
      [
        { id: "3928", name: "CGST", rate: 2.5 },
        { id: "3929", name: "SGST", rate: 2.5 },
      ]
    );
    expect(Object.keys(payload)).toEqual(["orderinfo"]);
    expect(Object.keys(payload.orderinfo).sort()).toEqual(["OrderInfo", "device_type", "udid"]);
    expect(payload.orderinfo.udid).toBe("");
    expect(payload.orderinfo.device_type).toBe("Web");
    expect(payload.orderinfo.OrderInfo).not.toHaveProperty("Discount");
    // No legacy siblings under orderinfo, and no legacy members on Order.
    expect(payload.orderinfo).not.toHaveProperty("Order");
    expect(payload.orderinfo.OrderInfo.Order.details).not.toHaveProperty("clientOrderID");
    expect(payload.orderinfo.OrderInfo.Order.details).not.toHaveProperty("restID");
    expect(payload.orderinfo.OrderInfo.Order.details).not.toHaveProperty("resID");
    expect(payload.orderinfo.OrderInfo.Restaurant.details).not.toHaveProperty("resID");
    const line = payload.orderinfo.OrderInfo.OrderItem.details[0];
    for (const legacy of ["addon_items", "item_id", "item_name", "addons", "item_attribute", "tax_percentage"]) {
      expect(line).not.toHaveProperty(legacy);
    }
  });

  it("carries the callback and COD cash equal to restaurant-only total", () => {
    const payload = formatPetpoojaV21Payload(
      vendorShapeOrder(),
      "test_rest_id",
      "bgx_fixture_2",
      "https://callback.example.test/petpooja/webhook",
      new Date(),
      [
        { id: "3928", name: "CGST", rate: 2.5 },
        { id: "3929", name: "SGST", rate: 2.5 },
      ]
    );
    const order = payload.orderinfo.OrderInfo.Order.details;
    // The vendor echoes this in its order-status callback and our webhook
    // resolves `orders/{orderID}` — the MT-01 client reference, exactly.
    expect(order.orderID).toBe("bgx_fixture_2");
    expect(order.callback_url).toBe("https://callback.example.test/petpooja/webhook");
    expect(order.payment_type).toBe("COD");
    // Exclude courier cost, but COD cash still equals the restaurant due.
    expect(order.collect_cash).toBe("335.00");
    expect(order.total).toBe("335.00");
    expect(order.tax_total).toBe("15.00");
    expect(order).not.toHaveProperty("tax");
    // enable_delivery is a NUMBER (0 = third-party riders, always correct here;
    // the sample's `1` is a restaurant-rider example).
    expect(order.enable_delivery).toBe(0);
    expect(typeof order.enable_delivery).toBe("number");
    expect(order.min_prep_time).toBe(0);
    expect(order.no_of_persons).toBe("0");
    expect(order.dc_tax_percentage).toBe("0");
    expect(order.dc_tax_amount).toBe("0.00");
    expect(order.dc_gst_details).toEqual([
      { gst_liable: "restaurant", amount: "0.00" },
    ]);
    expect(order.pc_gst_details).toEqual([
      { gst_liable: "restaurant", amount: "0.00" },
    ]);
    expect(order.otp).toBe("");
    expect(order.ondc_bap).toBe("");
    expect(order.preorder_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(order.preorder_time).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    expect(order.created_on).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it("final_price is the UNIT figure (price - item_discount), even for quantity 2", () => {
    const payload = formatPetpoojaV21Payload(
      vendorShapeOrder(),
      "test_rest_id",
      "bgx_fixture_3",
      "https://callback.example.test/petpooja/webhook",
      new Date(),
      [
        { id: "3928", name: "CGST", rate: 2.5 },
        { id: "3929", name: "SGST", rate: 2.5 },
      ]
    );
    const line = payload.orderinfo.OrderInfo.OrderItem.details[0];
    // price is the all-in unit (140 + 0 mojito + 10 cheese = 150)
    expect(line.price).toBe("150.00");
    expect(line.item_discount).toBe("0.00");
    // UNIT, never the 2x line total.
    expect(line.final_price).toBe("150.00");
    expect(line.quantity).toBe("2");
  });

  it("Tax[].price is the numeric percentage string, add-on group_id an integer", () => {
    const payload = formatPetpoojaV21Payload(
      vendorShapeOrder(),
      "test_rest_id",
      "bgx_fixture_4",
      "https://callback.example.test/petpooja/webhook",
      new Date(),
      [
        { id: "3928", name: "CGST", rate: 2.5 },
        { id: "3929", name: "SGST", rate: 2.5 },
      ]
    );
    const taxes = payload.orderinfo.OrderInfo.Tax.details;
    for (const t of taxes) {
      expect(t.type).toBe("P");
      expect(t.price).toBe("2.5");
      expect(String(t.price)).not.toContain("%");
      expect(typeof t.tax).toBe("string");
    }
    const addons = payload.orderinfo.OrderInfo.OrderItem.details[0].AddonItem.details;
    expect(addons[0]).toEqual({
      id: "1150783",
      name: "Mojito",
      group_name: "Addons",
      price: "0.00",
      group_id: 135699,
      quantity: "1",
    });
    expect(addons[0].group_id).toBe(135699); // the REAL configured group id (M4)
    expect(addons[1]).toMatchObject({ id: "1150813", group_id: 135700 });
  });

  it("uses clearly-synthetic non-empty contacts (test-only, never a production customer)", () => {
    const payload = formatPetpoojaV21Payload(
      vendorShapeOrder(),
      "test_rest_id",
      "bgx_fixture_5",
      "https://callback.example.test/petpooja/webhook",
      new Date(),
      [
        { id: "3928", name: "CGST", rate: 2.5 },
        { id: "3929", name: "SGST", rate: 2.5 },
      ]
    );
    const restaurant = payload.orderinfo.OrderInfo.Restaurant.details;
    const customer = payload.orderinfo.OrderInfo.Customer.details;
    expect(restaurant.restID).toBe("test_rest_id");
    for (const v of [restaurant.res_name, restaurant.address, restaurant.contact_information]) {
      expect(v.length).toBeGreaterThan(0);
    }
    expect(restaurant.contact_information).toBe("9000000000");
    for (const v of [customer.name, customer.email, customer.phone, customer.address, customer.latitude, customer.longitude]) {
      expect(v.length).toBeGreaterThan(0);
    }
    // The synthetic markers are unmistakable: reserved-fictional phone,
    // RFC-2606 email, "Sandbox" naming.
    expect(customer.phone).toBe("9000000000");
    expect(customer.email).toContain("example.com");
    expect(customer.name).toContain("Sandbox");
  });
});

describe("evaluatePetpoojaTestOrderSendability — structural verdicts, never fabricated acceptance", () => {
  it("accepts the item-only scenarios (real numeric outlet ids)", () => {
    expect(evaluatePetpoojaTestOrderSendability(buildPetpoojaTestOrder("dinein-basic-kot"))).toEqual([]);
    expect(evaluatePetpoojaTestOrderSendability(buildPetpoojaTestOrder("delivery-gst-fee"))).toEqual([]);
    expect(evaluatePetpoojaTestOrderSendability(buildPetpoojaTestOrder("cancel-refund-sync"))).toEqual([]);
    expect(evaluatePetpoojaTestOrderSendability(buildPetpoojaTestOrder("bulk-party-order"))).toEqual([]);
  });

  it("reports BLOCKED_CONFIGURATION for the unconfigured addon fixture", () => {
    const order = structuredClone(buildPetpoojaTestOrder("takeaway-with-modifiers"));
    order.items[0].modifiers = [{ id: "missing-addon", name: "Unconfigured", price: 10, groupId: 0 }];
    const gaps = evaluatePetpoojaTestOrderSendability(order);
    expect(gaps.length).toBeGreaterThanOrEqual(2);
    for (const g of gaps) {
      expect(g.field).toBe("OrderItem.details[].AddonItem");
      // M4: the internal id AND the missing (non-positive) group id both report.
      expect(g.reason).toMatch(
        /not a verified numeric Petpooja addon id|no positive Petpooja add-on GROUP id/
      );
    }
  });

  it("reports gaps for missing ids, but never mints an acceptance", () => {
    const gaps = evaluatePetpoojaTestOrderSendability({
      scenarioId: "gapped",
      orderType: "takeaway",
      status: "placed",
      items: [
        { id: "", name: "No Id Burger", price: 10, quantity: 1, isVeg: true, modifiers: [] },
      ],
      pricing: { itemTotal: 10, discount: 0, gst: 0.5, deliveryFee: 0, packagingFee: 0, grandTotal: 10.5 },
    } as any);
    expect(gaps).toHaveLength(1);
    expect(gaps[0].field).toBe("OrderItem.details[].id");
  });

  it("relays refuse to POST a BLOCKED_CONFIGURATION order — no fetch, no fake success", async () => {
    const prevMock = config.mock.petpoojaPos;
    const savedCreds = { ...config.petpooja };
    const fetchMock = vi.fn();
    try {
      config.mock.petpoojaPos = false;
      config.petpooja.appKey = "test_app_key";
      config.petpooja.appSecret = "test_app_secret";
      config.petpooja.accessToken = "test_access_token";
      vi.stubGlobal("fetch", fetchMock);
      // An outlet with no captured catalogue must block even with real ids.
      await expect(
        runPetpoojaTestScenario({ scenarioId: "takeaway-with-modifiers", branchId: "branch_without_catalog" })
      ).rejects.toMatchObject({
        code: "BLOCKED_CONFIGURATION",
        statusCode: 409,
      });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      config.mock.petpoojaPos = prevMock;
      config.petpooja.appKey = savedCreds.appKey;
      config.petpooja.appSecret = savedCreds.appSecret;
      config.petpooja.accessToken = savedCreds.accessToken;
      vi.unstubAllGlobals();
    }
  });
});

describe("Petpooja QA relay branch scope", () => {
  const branchOwnerA = { uid: "u1", role: "branch_owner", branchIds: ["branch_a"] };

  beforeEach(() => {
    config.mock.petpoojaPos = true;
  });

  it("allows the caller's own mapped branch", () => {
    expect(() => assertPetpoojaRelayAccess(branchOwnerA, "branch_a")).not.toThrow();
  });

  it("refuses another outlet's mapped branch", () => {
    expect(() => assertPetpoojaRelayAccess(branchOwnerA, "branch_b")).toThrow(
      /outside your assigned branches/
    );
    try {
      assertPetpoojaRelayAccess(branchOwnerA, "branch_b");
    } catch (err: any) {
      expect(err.statusCode).toBe(403);
    }
  });

  it("refuses an outlet that is not linked to any branch", () => {
    expect(() => assertPetpoojaRelayAccess(branchOwnerA, null)).toThrow(
      /not linked to a branch/
    );
  });

  it("allows a brand admin to relay to any mapped outlet", () => {
    expect(() =>
      assertPetpoojaRelayAccess({ uid: "u2", role: "brand_owner", branchIds: [] }, "branch_b")
    ).not.toThrow();
  });

  it("branch_staff of branch A cannot relay to branch B", () => {
    const staffA = {
      uid: "staff_1",
      email: "staff@brancha.com",
      role: "branch_staff",
      branchIds: ["branch_a"],
    };
    expect(() => assertPetpoojaRelayAccess(staffA, "branch_b")).toThrow(
      /outside your assigned branches/
    );
    expect(() => assertPetpoojaRelayAccess(staffA, "branch_a")).not.toThrow();
  });
});
