import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
              .map(([p, data]) => {
                const id = p.slice(colName.length + 1);
                return {
                  id,
                  ref: { id, path: p },
                  data: () => data,
                };
              })
              .filter((d) => d.data()[field] === val)
              .slice(0, n);
            return { docs: matched, empty: matched.length === 0 };
          },
        }),
      }),
      doc: (docId: string) => ({
        id: docId,
        update: vi.fn(async (data: any) => {
          savedDocs[`${colName}/${docId}`] = {
            ...(savedDocs[`${colName}/${docId}`] || {}),
            ...data,
          };
        }),
        set: vi.fn(async (data: any) => {
          savedDocs[`${colName}/${docId}`] = {
            ...(savedDocs[`${colName}/${docId}`] || {}),
            ...data,
          };
        }),
        get: vi.fn(async () => ({
          exists:
            Object.prototype.hasOwnProperty.call(savedDocs, `${colName}/${docId}`) ||
            colName === "orders",
          data: () =>
            savedDocs[`${colName}/${docId}`] || {
              branchId: "branch_ahmedabad_1",
              items: [
                {
                  id: "itm_1",
                  name: "Classic Smash Burger",
                  price: 199,
                  quantity: 1,
                  isVeg: true,
                },
              ],
              pricing: { grandTotal: 250, gst: 10, deliveryFee: 40 },
              payment: { razorpayPaymentId: "pay_test_123" },
              status: "pending",
            },
          ref: {
            id: docId,
            update: vi.fn(async (data: any) => {
              savedDocs[`${colName}/${docId}`] = {
                ...(savedDocs[`${colName}/${docId}`] || {}),
                ...data,
              };
            }),
            set: vi.fn(async (data: any) => {
              savedDocs[`${colName}/${docId}`] = {
                ...(savedDocs[`${colName}/${docId}`] || {}),
                ...data,
              };
            }),
          },
        })),
      }),
    }),
  };
  return { mockDb, savedDocs };
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
  syncPetpoojaMenu,
  normalizePetpoojaStatus,
  pushOrderToPetpooja,
  handlePetpoojaWebhook,
  formatPetpoojaOrderPayload,
  verifyPetpoojaSignature,
  handlePetpoojaStockWebhook,
  pushItemStockToPetpooja,
  handlePetpoojaMenuWebhook,
  extractMenuRestId,
} from "../src/modules/petpooja";
import { computeStockQuarantineDocId } from "../src/modules/petpooja/item86ingSync";
import { config } from "../src/config/env";

describe("Petpooja POS Bridge Service", () => {
  // Explicit sandbox opt-in (was auto-mock): fail-closed env defaults to
  // live, so tests exercising mock paths must set MOCK_PETPOOJA_POS.
  let prevMock = false;
  beforeEach(() => {
    prevMock = config.mock.petpoojaPos;
    config.mock.petpoojaPos = true;
  });
  afterEach(() => {
    config.mock.petpoojaPos = prevMock;
  });
  it("synchronizes mock catalog into Firestore with items and categories", async () => {
    const result = await syncPetpoojaMenu("branch_ahmedabad_1");
    expect(result).toBeDefined();
    expect(result.itemCount).toBe(4);
    expect(result.categoriesCount).toBe(3);
  });

  describe("formatPetpoojaOrderPayload", () => {
    // Sanitized vendor-shape fixture: real-shaped NUMERIC POS ids taken from
    // the vendor's corrected save_order sample, no credentials, no real
    // H2 — the branch's CAPTURED tax catalogue fixture (what menuSyncWebhook
    // writes; no builder default exists anymore). The ids are the outlet's
    // own captured rows, used as test FIXTURE truth only.
    const CAPTURED_TAXES = [
      { id: "3928", name: "CGST", rate: 2.5 },
      { id: "3929", name: "SGST", rate: 2.5 },
    ];
    const capturedBranch = (extra: Record<string, any> = {}) => ({
      id: "branch_surat_01",
      petpoojaStoreId: "PP_SURAT_01",
      petpoojaTaxes: CAPTURED_TAXES,
      ...extra,
    });
    // H1 — per-product tax metadata snapshots (edited per test as needed).
    const snapshotFor = (posId: string, taxIds: string[] = ["3928", "3929"]) => ({
      petpoojaItemId: posId,
      taxIds,
      taxInclusive: false,
      taxUnsupported: false,
    });

    // customer data (names/phones/address are fictional placeholders).
    function vendorShapeOrder(extra: Record<string, any> = {}) {
      return {
        id: "ord_1001",
        orderNumber: "BUR-1001",
        branchId: "branch_surat_01",
        fulfillmentType: "DELIVERY",
        paymentMethod: "RAZORPAY",
        customerName: "Aarav Mehta",
        customerPhone: "+919825100001",
        address: { street: "123 Adajan Main Rd" },
        items: [
          {
            id: "l1",
            productId: "prod_branch_surat_01_7765862",
            petpoojaItemId: "7765862",
            name: "Classic Smash Cheese Burger",
            price: 249,
            quantity: 2,
            isVeg: true,
            modifiers: [
              {
                id: "opt_extra_cheese",
                petpoojaAddonId: "1150783",
                petpoojaAddonGroupId: 135699,
                name: "Extra Cheese",
                price: 20,
              },
            ],
          },
        ],
        pricing: {
          subtotal: 498,
          gst: 24.9,
          deliveryFee: 40,
          packagingFee: 15,
          discount: 50,
          grandTotal: 527.9,
        },
        ...extra,
      };
    }

    it("correctly maps order details, items, GST tax splits, and order types", () => {
      const branch = capturedBranch();
      const payload = formatPetpoojaOrderPayload(
        vendorShapeOrder(),
        branch,
        "PP_SURAT_01",
        "branch_surat_01",
        "ord_1001",
        [snapshotFor("7765862")]
      );

      // ---- the vendor's envelope (sample of 2026-10-26) ----
      // `orderinfo` contains exactly OrderInfo + udid + device_type. Extra
      // siblings and root-level duplicates are what Petpooja called its
      // structural issues, so they must never come back.
      expect(Object.keys(payload)).toEqual(["orderinfo"]);
      expect(Object.keys(payload.orderinfo).sort()).toEqual([
        "OrderInfo",
        "device_type",
        "udid",
      ]);
      expect(payload.orderinfo.udid).toBe("");
      expect(payload.orderinfo.device_type).toBe("Web");

      const info = payload.orderinfo.OrderInfo;
      const orderDetails = info.Order.details;
      const customerDetails = info.Customer.details;

      // `orderID` is the client reference the POS echoes to our status
      // webhook, and the webhook resolves it as `orders/{orderID}` — the
      // Firestore document id, not the decorative order number.
      expect(orderDetails.orderID).toBe("ord_1001");
      // The vendor sample carries restID only on Restaurant.details.
      expect(info.Restaurant.details.restID).toBe("PP_SURAT_01");
      expect(info.Restaurant.details).not.toHaveProperty("resID");

      // DOC VERIFIED: callback_url must be sent in EVERY save_order request,
      // and the POS reads it from Order.details.
      const callbackUrl = orderDetails.callback_url;
      expect(typeof callbackUrl).toBe("string");
      expect(callbackUrl).toMatch(/\/petpooja\/webhook$/);
      // Official V2.1.0 order_type is a letter code (H/P/D), not 1/2/3.
      expect(orderDetails.order_type).toBe("H"); // H = home delivery
      // Petpooja accepts COD / CARD / ONLINE — "Prepaid" is not a valid value.
      expect(orderDetails.payment_type).toBe("ONLINE");
      expect(orderDetails.total).toBe("527.90");
      expect(orderDetails.tax_total).toBe("24.90");
      // The old `tax`/`discount` aliases are not in the vendor sample.
      expect(orderDetails).not.toHaveProperty("tax");
      expect(orderDetails).not.toHaveProperty("discount");
      expect(orderDetails.discount_total).toBe("50.00");
      expect(orderDetails.delivery_charges).toBe("40.00");
      expect(orderDetails.packing_charges).toBe("15.00");
      expect(orderDetails.service_charge).toBe("0.00");
      // The vendor sample requires the full charge-tax block (numeric strings).
      expect(orderDetails.sc_tax_amount).toBe("0.00");
      expect(orderDetails.dc_tax_percentage).toBe("0");
      expect(orderDetails.dc_tax_amount).toBe("0.00");
      expect(orderDetails.dc_gst_details).toEqual([
        { gst_liable: "vendor", amount: "0.00" },
        { gst_liable: "restaurant", amount: "0.00" },
      ]);
      expect(orderDetails.pc_tax_percentage).toBe("0");
      expect(orderDetails.pc_tax_amount).toBe("0.00");
      expect(orderDetails.pc_gst_details).toEqual([
        { gst_liable: "vendor", amount: "0.00" },
        { gst_liable: "restaurant", amount: "0.00" },
      ]);
      // No legacy aliases anywhere on Order (resID/restID/customer_name/…).
      expect(orderDetails).not.toHaveProperty("clientOrderID");
      expect(orderDetails).not.toHaveProperty("resID");
      expect(orderDetails).not.toHaveProperty("restID");
      expect(orderDetails).not.toHaveProperty("order_type_legacy");
      expect(orderDetails).not.toHaveProperty("customer_name");
      expect(orderDetails).not.toHaveProperty("customer_phone");
      expect(orderDetails).not.toHaveProperty("customer_address");
      // Numeric-vs-string typing per the sample.
      expect(orderDetails.enable_delivery).toBe(0); // number, third-party riders
      expect(typeof orderDetails.enable_delivery).toBe("number");
      expect(typeof orderDetails.min_prep_time).toBe("number");
      expect(orderDetails.no_of_persons).toBe("0"); // string
      expect(orderDetails.ondc_bap).toBe("");
      expect(orderDetails.advanced_order).toBe("N");
      expect(orderDetails.urgent_order).toBe(false);
      expect(orderDetails.preorder_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(orderDetails.preorder_time).toMatch(/^\d{2}:\d{2}:\d{2}$/);
      expect(orderDetails.created_on).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
      expect(orderDetails.otp).toBe("");

      // Official Customer details carries the contact — never a flat key.
      expect(customerDetails.name).toBe("Aarav Mehta");
      expect(customerDetails.phone).toBe("+919825100001");
      expect(customerDetails.address).toBe("123 Adajan Main Rd");

      // Official Tax[] shape (id/title/type/price/tax/restaurant_liable_amt),
      // `price` the numeric percentage string (not "2.5%").
      expect(info.Tax.details).toHaveLength(2);
      expect(info.Tax.details[0].title).toBe("CGST");
      expect(info.Tax.details[0].type).toBe("P");
      expect(info.Tax.details[0].price).toBe("2.5");
      expect(info.Tax.details[0].tax).toBe("12.45");
      // Legacy envelope spellings are GONE.
      expect(payload.orderinfo).not.toHaveProperty("tax_details");
      expect(payload.orderinfo).not.toHaveProperty("order_items");
      expect(payload.orderinfo).not.toHaveProperty("items");

      // Verify item mapping with verified add-ons — official OrderItem names.
      expect(info.OrderItem.details).toHaveLength(1);
      const line = info.OrderItem.details[0];
      expect(line.id).toBe("7765862");
      expect(line.name).toBe("Classic Smash Cheese Burger");
      expect(line.quantity).toBe("2");
      // `price` is the per-unit all-in figure; add-on rows are descriptive.
      expect(line.price).toBe("249.00");
      // UNIT final_price (not the line total) per the vendor sample.
      expect(line.final_price).toBe("249.00");
      expect(line.item_discount).toBe("0.00");
      // Our checkout prices are tax-EXCLUSIVE, matching the outlet's menu.
      expect(line.tax_inclusive).toBe(false);
      expect(line.gst_liability).toBe("restaurant");
      // Per-line tax rows carry a share of the order GST.
      expect(line.item_tax).toHaveLength(2);
      expect(line.item_tax[0].tax_percentage).toBe("2.5");
      // The AddonItem carries verified numeric POS ids.
      expect(line.AddonItem.details).toHaveLength(1);
      expect(line.AddonItem.details[0].name).toBe("Extra Cheese");
      expect(line.AddonItem.details[0].group_name).toBe("Addons");
      expect(line.AddonItem.details[0].price).toBe("20.00");
      // Vendor sample: add-on id numeric STRING, group_id a NUMBER (int).
      expect(line.AddonItem.details[0].id).toBe("1150783");
      expect(line.AddonItem.details[0].group_id).toBe(135699);
      expect(typeof line.AddonItem.details[0].group_id).toBe("number");
      // Legacy line aliases are GONE.
      expect(line).not.toHaveProperty("addon_items");
      expect(line).not.toHaveProperty("item_id");
      expect(line).not.toHaveProperty("item_name");
      expect(line).not.toHaveProperty("addons");
      expect(line).not.toHaveProperty("item_attribute");
      expect(line).not.toHaveProperty("tax_percentage");
      expect(line).not.toHaveProperty("addon_id");
      expect(line).not.toHaveProperty("addon_name");
    });

    it("unit final_price stays a UNIT figure for quantity > 1 (no line-total inflation)", () => {
      // Vendor sample: `final_price = price - item_discount` — a UNIT figure.
      // The old line-total form (unit x qty) overstated shipping lines and
      // broke the sample invariant for multi-quantity lines.
      const payload = formatPetpoojaOrderPayload(
        vendorShapeOrder({ items: [
          { id: "l1", productId: "prod_branch_surat_01_7765862", petpoojaItemId: "7765862", name: "Burger", price: 249, quantity: 3 },
        ] }),
        capturedBranch(),
        "PP_SURAT_01",
        "branch_surat_01",
        "ord_1001",
        [snapshotFor("7765862")]
      );
      const line = payload.orderinfo.OrderInfo.OrderItem.details[0];
      expect(line.quantity).toBe("3");
      expect(line.price).toBe("249.00");
      expect(line.final_price).toBe("249.00");
      expect(line.final_price).not.toBe("747.00");
    });

    it("COD orders collect the FULL total; ONLINE orders collect 0 (retained policy)", () => {
      const codPayload = formatPetpoojaOrderPayload(
        vendorShapeOrder({ paymentMethod: "COD" }),
        capturedBranch({ id: "b1", petpoojaStoreId: "PP_1" }),
        "PP_1",
        "branch_surat_01",
        "ord_c1",
        [snapshotFor("7765862")]
      );
      const codOrder = codPayload.orderinfo.OrderInfo.Order.details;
      expect(codOrder.payment_type).toBe("COD");
      expect(codOrder.collect_cash).toBe("527.90");

      const onlinePayload = formatPetpoojaOrderPayload(
        vendorShapeOrder(),
        capturedBranch({ id: "b1", petpoojaStoreId: "PP_1" }),
        "PP_1",
        "branch_surat_01",
        "ord_o1",
        [snapshotFor("7765862")]
      );
      const onlineOrder = onlinePayload.orderinfo.OrderInfo.Order.details;
      expect(onlineOrder.payment_type).toBe("ONLINE");
      expect(onlineOrder.collect_cash).toBe("0.00");
    });

    it("carries the vendor's optional variation fields, as empty strings when absent", () => {
      // Vendor pp.6-7: `variation_id`/`variation_name` are OPTIONAL and its own
      // OrderItem example emits both as EMPTY STRINGS for a line with no
      // variant. The key must exist (not omitted) — a stricter parser could
      // read a missing member differently.
      const order = {
        id: "ord_var_01",
        orderNumber: "BUR-VAR-01",
        branchId: "branch_surat_01",
        fulfillmentType: "DELIVERY",
        paymentMethod: "COD",
        customerName: "Variation Case",
        customerPhone: "+919825100009",
        address: { street: "123 Adajan Main Rd" },
        items: [
          { id: "l_no_variant", petpoojaResolvedId: "30791", name: "Tandoori Dahi Kebab", price: 350, quantity: 1 },
          {
            id: "l_with_variant",
            petpoojaResolvedId: "30792",
            name: "Half Dish Case",
            price: 200,
            quantity: 1,
            petpoojaVariationId: "110",
            petpoojaVariationName: "Half Dish",
          },
        ],
      };

      const payload = formatPetpoojaOrderPayload(order, capturedBranch(), "TEST_RES_ID", "branch_surat_01", undefined, [snapshotFor("30791"), snapshotFor("30792")]);
      const [noVariant, withVariant] = payload.orderinfo.OrderInfo.OrderItem.details;

      expect(noVariant.variation_id).toBe("");
      expect(noVariant.variation_name).toBe("");
      expect(Object.prototype.hasOwnProperty.call(noVariant, "variation_id")).toBe(true);
      expect(Object.prototype.hasOwnProperty.call(noVariant, "variation_name")).toBe(true);

      expect(withVariant.variation_id).toBe("110");
      expect(withVariant.variation_name).toBe("Half Dish");
    });

    it("also resolves the legacy `variationId`/`variationName` cart-line spellings", () => {
      // The relay reads `petpoojaVariationId || variationId` (and the matching
      // name pair). CartLine documents in the app carry the short spelling, so
      // a regression that kept only the prefixed one would silently strip the
      // variant off every variation line after shipping the case above.
      const order = {
        id: "ord_var_02",
        orderNumber: "BUR-VAR-02",
        fulfillmentType: "TAKEAWAY",
        paymentMethod: "COD",
        items: [
          {
            lineId: "l1",
            productId: "prod_branch_surat_01_30792",
            name: "Legacy Spelling",
            unitPrice: 200,
            quantity: 1,
            variationId: "110",
            variationName: "Full Dish",
          },
        ],
      };

      const payload = formatPetpoojaOrderPayload(order, capturedBranch(), "TEST_RES_ID", "branch_surat_01", undefined, [snapshotFor("30792")]);
      expect(payload.orderinfo.OrderInfo.OrderItem.details[0].variation_id).toBe("110");
      expect(payload.orderinfo.OrderInfo.OrderItem.details[0].variation_name).toBe("Full Dish");
    });

    it("maps takeaway and dine-in fulfillment types correctly", () => {
      const takeawayOrder = {
        id: "ord_1002",
        fulfillmentType: "TAKEAWAY",
        paymentMethod: "COD",
        items: [],
      };
      const dineInOrder = {
        id: "ord_1003",
        fulfillmentType: "DINE_IN",
        paymentMethod: "PREPAID",
        items: [],
      };

      const payload1 = formatPetpoojaOrderPayload(takeawayOrder, capturedBranch(), "TEST_RES_ID", "branch_x");
      expect(payload1.orderinfo.OrderInfo.Order.details.order_type).toBe("P");
      expect(payload1.orderinfo.OrderInfo.Order.details.payment_type).toBe("COD");

      const payload2 = formatPetpoojaOrderPayload(dineInOrder, capturedBranch(), "TEST_RES_ID", "branch_x");
      expect(payload2.orderinfo.OrderInfo.Order.details.order_type).toBe("D");
      expect(payload2.orderinfo.OrderInfo.Order.details.payment_type).toBe("ONLINE");
    });

    it("resolves the POS item id and price from the CartLine shape the app actually writes", () => {
      // Regression: the `orders` document stores CartLine objects, which carry
      // `productId` / `unitPrice` / `veg` / `meta` — none of the names the relay
      // used to read. Every line therefore shipped `id: undefined` at price 0.
      const order = {
        id: "ord_2001",
        orderNumber: "BUR-2001",
        fulfillmentType: "DELIVERY",
        paymentMethod: "COD",
        customerName: "Cartline Case",
        customerPhone: "9825100001",
        items: [
          {
            lineId: "l1",
            productId: "prod_branch_surat_01_30791",
            unitPrice: 350,
            quantity: 2,
            veg: false,
            name: "Tandoori Dahi Kebab",
          },
          {
            lineId: "l2",
            productId: "prod_branch_surat_01_30787",
            unitPrice: 220,
            quantity: 1,
            veg: true,
            name: "French Fries",
            // The cart's agreement escape hatch: it must AGREE with the
            // branch-scoped doc id's numeric tail (H3) or the line blocks.
            meta: { petpoojaItemId: "30787" },
          },
        ],
        pricing: { subtotal: 920, gst: 46, grandTotal: 966 },
      };

      const payload = formatPetpoojaOrderPayload(
        order,
        capturedBranch(),
        "TEST_RES_ID",
        "branch_surat_01",
        undefined,
        [snapshotFor("30791"), snapshotFor("30787")]
      );
      const lines = payload.orderinfo.OrderInfo.OrderItem.details as Array<Record<string, unknown>>;

      // `prod_<branchId>_<itemid>` is stripped by exact prefix.
      expect(lines[0].id).toBe("30791");
      // meta.petpoojaItemId AGREES with the prefix tail (H3: agreement only).
      expect(lines[1].id).toBe("30787");
      // Prices come from `unitPrice`, not the absent `price`/`basePrice`.
      expect(lines[0].price).toBe("350.00");
      expect(lines[1].price).toBe("220.00");
      // The tax split is a share of the order's embedded GST, per line.
      expect(Number(lines[0].item_tax[0].amount) + Number(lines[0].item_tax[1].amount)).toBeCloseTo(
        (46 * 700) / 920 / 1,
        2
      );
    });

    it("throws BLOCKED_CONFIGURATION (never invents) when a line's Petpooja item id cannot be verified", () => {
      // Wrong-branch id / empty resolution is NOT represented as an empty
      // `item.id` — a fabricated/unverified id is exactly what the vendor's
      // structural rejection punished CANNOT be risked.
      expect(() =>
        formatPetpoojaOrderPayload(
          {
            id: "ord_2002",
            fulfillmentType: "TAKEAWAY",
            paymentMethod: "COD",
            items: [{ lineId: "l1", productId: "prod_other_branch_9", unitPrice: 100, quantity: 1 }],
            pricing: { grandTotal: 100 },
          },
          capturedBranch(),
          "TEST_RES_ID",
          "branch_surat_01"
        )
      ).toThrow(/BLOCKED_CONFIGURATION/);
      expect(() =>
        formatPetpoojaOrderPayload(
          {
            id: "ord_2002",
            fulfillmentType: "TAKEAWAY",
            paymentMethod: "COD",
            items: [{ lineId: "l1", productId: "prod_other_branch_9", unitPrice: 100, quantity: 1 }],
            pricing: { grandTotal: 100 },
          },
          capturedBranch(),
          "TEST_RES_ID",
          "branch_surat_01"
        )
      ).toThrow(/no verified Petpooja item id/);
    });

    it("throws BLOCKED_CONFIGURATION for add-ons whose POS ids are not verified numeric credentials", () => {
      // BOTH fake shapes are banned outright: an internal id ("mod_…") and the
      // literal "addon" fallback are placeholders pretending to be configured,
      // and a group id that collapses `Number(internalId) || 0` sends the KOT
      // to a non-existent add-on group.
      const cases = [
        { id: "mod_extra_cheese", name: "Extra Cheese", price: 30 },
        { id: "addon", name: "Unnamed Addon", price: 10 },
        { id: "opt_extra", petpoojaAddonId: "1150783", name: "Extra Cheese", price: 30 }, // no group id
        {
          id: "opt_extra",
          petpoojaAddonId: "1150783",
          // Internal group id "grp_bun" is NOT a numeric POS group — the old
          // `Number(...) || 0` folded it to 0, which is fabrication.
          petpoojaAddonGroupId: "grp_bun",
          name: "Extra Cheese",
          price: 30,
        },
      ];
      for (const modifier of cases) {
        expect(() =>
          formatPetpoojaOrderPayload(
            {
              id: "ord_addon_1",
              fulfillmentType: "TAKEAWAY",
              paymentMethod: "COD",
              items: [
                {
                  id: "l1",
                  petpoojaResolvedId: "7765862",
                  name: "Burger",
                  price: 249,
                  quantity: 1,
                  modifiers: [modifier],
                },
              ],
              pricing: { grandTotal: 249 },
            },
            capturedBranch(),
            "TEST_RES_ID",
            "branch_surat_01",
            undefined,
            [snapshotFor("7765862")]
          )
        ).toThrow(/BLOCKED_CONFIGURATION/);
      }
    });

    it("blocks a line that claims a variation it cannot verify", () => {
      expect(() =>
        formatPetpoojaOrderPayload(
          {
            id: "ord_var_block",
            fulfillmentType: "TAKEAWAY",
            paymentMethod: "COD",
            items: [
              {
                id: "l1",
                petpoojaResolvedId: "7765862",
                name: "Burger",
                price: 249,
                quantity: 1,
                variationRequired: true,
              },
            ],
            pricing: { grandTotal: 249 },
          },
          capturedBranch(),
          "TEST_RES_ID",
          "branch_surat_01",
          undefined,
          [snapshotFor("7765862")]
        )
      ).toThrow(/variation_id/);
    });

    // ---------------- NEW — independent-review H1/H2/H3 pins ----------------

    it("H1: a tax-INCLUSIVE product blocks the push before the vendor (no honest representation)", () => {
      expect(() =>
        formatPetpoojaOrderPayload(
          {
            id: "ord_h1_inc",
            fulfillmentType: "TAKEAWAY",
            paymentMethod: "COD",
            items: [{ id: "l1", petpoojaResolvedId: "30791", name: "Inclusive Item", price: 100, quantity: 1 }],
          },
          capturedBranch(),
          "TEST_RES_ID",
          "branch_surat_01",
          undefined,
          [{ ...snapshotFor("30791"), taxInclusive: true }]
        )
      ).toThrow(/TAX-INCLUSIVE/);
    });

    it("H1: unsupported tax shapes block before the vendor", () => {
      expect(() =>
        formatPetpoojaOrderPayload(
          {
            id: "ord_h1_unsup",
            fulfillmentType: "TAKEAWAY",
            paymentMethod: "COD",
            items: [{ id: "l1", petpoojaResolvedId: "30791", name: "Unsupported Item", price: 100, quantity: 1 }],
          },
          capturedBranch(),
          "TEST_RES_ID",
          "branch_surat_01",
          undefined,
          [{ ...snapshotFor("30791"), taxUnsupported: true }]
        )
      ).toThrow(/not representable/);
    });

    it("H1: a 4-row captured catalogue with item taxIds [3928,3929] sends exactly 2 matching rows", () => {
      const fourRowBranch = capturedBranch({
        petpoojaTaxes: [
          { id: "3928", name: "CGST", rate: 2.5 },
          { id: "3929", name: "SGST", rate: 2.5 },
          { id: "11213", name: "SGST6", rate: 6 },
          { id: "20375", name: "CGST6", rate: 6 },
        ],
      });
      // Representable: rows sum to the engine's effective rate (formal GST 5%
      // of the taxable food amount below).
      const payload = formatPetpoojaOrderPayload(
        {
          id: "ord_h1_four",
          fulfillmentType: "TAKEAWAY",
          paymentMethod: "COD",
          items: [{ id: "l1", petpoojaResolvedId: "30791", name: "Matched Item", price: 200, quantity: 1 }],
          pricing: { foodSubtotal: 200, discount: 0, loyaltyDiscount: 0, gst: 10, grandTotal: 210 },
        },
        fourRowBranch,
        "TEST_RES_ID",
        "branch_surat_01",
        undefined,
        [snapshotFor("30791", ["3928", "3929"])]
      );
      const rows = payload.orderinfo.OrderInfo.OrderItem.details[0].item_tax;
      expect(rows).toHaveLength(2);
      expect(rows.map((r: any) => r.id)).toEqual(["3928", "3929"]);
      // Order-level Tax member carries exactly the matched union, not all 4.
      expect(payload.orderinfo.OrderInfo.Tax.details).toHaveLength(2);
    });

    it("H1: an item declaring an unknown tax id (99999) blocks the push", () => {
      expect(() =>
        formatPetpoojaOrderPayload(
          {
            id: "ord_h1_unknown",
            fulfillmentType: "TAKEAWAY",
            paymentMethod: "COD",
            items: [{ id: "l1", petpoojaResolvedId: "30791", name: "Unknown-Tax Item", price: 100, quantity: 1 }],
          },
          capturedBranch(),
          "TEST_RES_ID",
          "branch_surat_01",
          undefined,
          [snapshotFor("30791", ["99999"])]
        )
      ).toThrow(/99999/);
    });

    it("H1: a line with no product tax metadata snapshot blocks (missing ids — not notice-only)", () => {
      expect(() =>
        formatPetpoojaOrderPayload(
          {
            id: "ord_h1_missing",
            fulfillmentType: "TAKEAWAY",
            paymentMethod: "COD",
            items: [{ id: "l1", petpoojaResolvedId: "30791", name: "Metadata-less Item", price: 100, quantity: 1 }],
          },
          capturedBranch(),
          "TEST_RES_ID",
          "branch_surat_01"
        )
      ).toThrow(/no product tax metadata snapshot/);
    });

    it("H1: matched rows whose rate sum disagrees with the order's GST engine rate block", () => {
      // The captured rows sum to 5% but the ORDER was priced at the 12% slab.
      expect(() =>
        formatPetpoojaOrderPayload(
          {
            id: "ord_h1_rate",
            fulfillmentType: "TAKEAWAY",
            paymentMethod: "COD",
            items: [{ id: "l1", petpoojaResolvedId: "30791", name: "Rate-Mismatch Item", price: 200, quantity: 1 }],
            pricing: { foodSubtotal: 200, discount: 0, loyaltyDiscount: 0, gst: 12, grandTotal: 212 },
          },
          capturedBranch(),
          "TEST_RES_ID",
          "branch_surat_01",
          undefined,
          [snapshotFor("30791")]
        )
      ).toThrow(/representable/);
    });

    it("H2: a branch with no captured tax catalogue blocks the push (no invented defaults)", () => {
      expect(() =>
        formatPetpoojaOrderPayload(
          {
            id: "ord_h2_missing",
            fulfillmentType: "TAKEAWAY",
            paymentMethod: "COD",
            items: [],
          },
          { id: "branch_bare", petpoojaStoreId: "PP_BARE" },
          "PP_BARE",
          "branch_bare"
        )
      ).toThrow(/branch\.petpoojaTaxes/);
    });

    it("H3: internal-only ids (line1, uuid-shaped, prod without numeric tail) block", () => {
      for (const badItem of [
        { id: "line1", name: "X", price: 10, quantity: 1 },
        { id: "a3c1f6e2-8a9b-4c0d-9e1f-2b3c4d5e6f70", name: "X", price: 10, quantity: 1 },
        { id: "internal_9", productId: "prod_branch_surat_01", name: "X", price: 10, quantity: 1 },
      ]) {
        expect(() =>
          formatPetpoojaOrderPayload(
            {
              id: "ord_h3_internal",
              fulfillmentType: "TAKEAWAY",
              paymentMethod: "COD",
              items: [badItem],
            },
            capturedBranch(),
            "TEST_RES_ID",
            "branch_surat_01"
          )
        ).toThrow(/no verified Petpooja item id|blocked/);
      }
    });

    it("H3: a numeric-looking CLIENT item id alone is not provenance — it must agree with the trusted resolution", () => {
      // A client-stamped petpoojaItemId with NO trusted mapping blocks...
      expect(() =>
        formatPetpoojaOrderPayload(
          {
            id: "ord_h3_client",
            fulfillmentType: "TAKEAWAY",
            paymentMethod: "COD",
            items: [{ id: "l1", petpoojaItemId: "30791", name: "Claimed Item", price: 10, quantity: 1 }],
          },
          capturedBranch(),
          "TEST_RES_ID",
          "branch_surat_01"
        )
      ).toThrow(/no verified Petpooja item id/);
      // ...and a client stamp that DISAGREES with the branch-prefixed id blocks.
      expect(() =>
        formatPetpoojaOrderPayload(
          {
            id: "ord_h3_disagree",
            fulfillmentType: "TAKEAWAY",
            paymentMethod: "COD",
            items: [
              {
                id: "l1",
                productId: "prod_branch_surat_01_30791",
                petpoojaItemId: "9999999",
                name: "Disagreeing Item",
                price: 10,
                quantity: 1,
              },
            ],
          },
          capturedBranch(),
          "TEST_RES_ID",
          "branch_surat_01"
        )
      ).toThrow(/no verified Petpooja item id/);
    });

    it("H3: the correct branch-prefixed product id resolves its numeric tail as the POS id", () => {
      const payload = formatPetpoojaOrderPayload(
        {
          id: "ord_h3_ok",
          fulfillmentType: "TAKEAWAY",
          paymentMethod: "COD",
          items: [{ id: "l1", productId: "prod_branch_surat_01_30791", name: "Prefixed Item", price: 100, quantity: 1 }],
        },
        capturedBranch(),
        "TEST_RES_ID",
        "branch_surat_01",
        undefined,
        [snapshotFor("30791")]
      );
      expect(payload.orderinfo.OrderInfo.OrderItem.details[0].id).toBe("30791");
    });
  });


  describe("normalizePetpoojaStatus", () => {
    it("correctly maps numeric Petpooja status codes", () => {
      expect(normalizePetpoojaStatus(-1)).toBe("cancelled");
      expect(normalizePetpoojaStatus("-1")).toBe("cancelled");
      expect(normalizePetpoojaStatus(1)).toBe("accepted");
      expect(normalizePetpoojaStatus(2)).toBe("accepted");
      expect(normalizePetpoojaStatus(3)).toBe("accepted");
      expect(normalizePetpoojaStatus(4)).toBe("out_for_delivery");
      expect(normalizePetpoojaStatus(5)).toBe("ready");
      expect(normalizePetpoojaStatus(10)).toBe("delivered");
    });

    it("correctly maps string Petpooja status codes", () => {
      expect(normalizePetpoojaStatus("KITCHEN_ACCEPTED")).toBe("accepted");
      expect(normalizePetpoojaStatus("FOOD_READY")).toBe("ready");
      expect(normalizePetpoojaStatus("CANCELLED")).toBe("cancelled");
      expect(normalizePetpoojaStatus("DISPATCH")).toBe("out_for_delivery");
      expect(normalizePetpoojaStatus("DELIVERED")).toBe("delivered");
    });

    it("returns unknown for null or unmapped statuses", () => {
      expect(normalizePetpoojaStatus(null)).toBe("unknown");
      expect(normalizePetpoojaStatus(undefined)).toBe("unknown");
      expect(normalizePetpoojaStatus("INVALID_STATUS")).toBe("unknown");
    });
  });

  describe("86ing & Menu Webhook Handlers", () => {
    it("handles incoming 86ing out-of-stock webhook from Petpooja POS for unlinked outlet by capturing review evidence", async () => {
      await handlePetpoojaStockWebhook({
        rest_id: "branch_surat_01",
        item_id: "pp_b1",
        in_stock: 0,
      });

      // rest_id is unlinked in this fixture, so canonical products are NOT mutated and no prod_unlinked doc is created.
      expect(savedDocs["products/prod_unlinked_pp_b1"]).toBeUndefined();
      const productKeys = Object.keys(savedDocs).filter((k) => k.startsWith("products/"));
      expect(productKeys).toHaveLength(0);

      // Captured in unmatched_petpooja_stock as explicit review evidence.
      const qId = computeStockQuarantineDocId("branch_surat_01", "pp_b1");
      expect(savedDocs[`unmatched_petpooja_stock/${qId}`]).toBeDefined();
      expect(savedDocs[`unmatched_petpooja_stock/${qId}`]?.inStock).toBe(false);
      expect(savedDocs[`unmatched_petpooja_stock/${qId}`]?.status).toBe("needs_review");
    });

    it("fails CLOSED on the stock verb for every value outside the on-whitelist on linked canonical product", async () => {
      // The vendor documents the Item On/Off Webhook as carrying "the item stock
      // status (in-stock or out-of-stock)" but documents NO value encoding for it
      // - while its Push Menu payload uses "2" for all 166 items (see the
      // in_stock census in the reference doc section 18.1). This verb is the
      // AUTHORITATIVE stock channel, and before this test only in_stock: 0 was
      // pinned, so the mapping for every other value was unspecified.
      //
      // Pin it: ONLY 1 / "1" / true mean in stock; anything else - including the
      // push payload's "2" - resolves to out-of-stock. That is deliberately the
      // SAFE direction (never sell what the POS 86-ed) and deliberately NOT a
      // tolerant mapping (C07): the real encoding stays unknown until an actual
      // on/off callback is observed, so neither branch may be "relaxed" quietly.
      const cases: Array<[unknown, boolean]> = [
        [1, true],
        ["1", true],
        [true, true],
        [0, false],
        ["0", false],
        [false, false],
        ["2", false], // the value the Push Menu payload carries for every item
        [2, false],
        ["ON", false],
        [undefined, false],
      ];

      for (const [in_stock, expected] of cases) {
        for (const key of Object.keys(savedDocs)) delete savedDocs[key];
        savedDocs["branches/branch_surat_01"] = { petpoojaStoreId: "PP_SURAT_01" };
        savedDocs["products/prod_branch_surat_01_pp_b1"] = {
          id: "prod_branch_surat_01_pp_b1",
          branchId: "branch_surat_01",
          petpoojaItemId: "pp_b1",
          inStock: true,
        };

        await handlePetpoojaStockWebhook({
          rest_id: "PP_SURAT_01",
          item_id: "pp_b1",
          in_stock,
        } as any);
        expect(
          savedDocs["products/prod_branch_surat_01_pp_b1"]?.inStock,
          `in_stock=${String(in_stock)} must resolve to inStock=${expected}`
        ).toBe(expected);
      }
    });

    it("pushes stock toggle to Petpooja API successfully", async () => {
      const res = await pushItemStockToPetpooja("branch_surat_01", "pp_b1", true);
      expect(res).toBe(true);
    });

    it("refuses the stock push for an UNLINKED branch without touching the vendor", async () => {
      // Consumer-scope guard on the OUTBOUND management surface. In live mode
      // (mock off) the push resolves the branch's linked outlet from
      // branches/{id}.petpoojaStoreId and REFUSES when there is none
      // (item86ingSync.ts:148-159). Refusing BEFORE any network call is the
      // point: a toggle sent to a wrong-but-valid outlet SUCCEEDS remotely and
      // 86s someone else's item silently (the Loop 6 note at :118-122), so a
      // success return here would be a fabricated stock change.
      // No branch doc is seeded, so the lookup finds no petpoojaStoreId.
      config.mock.petpoojaPos = false;
      const fetchSpy = vi.fn(async () => {
        throw new Error("the outbound push must not reach the vendor for an unlinked branch");
      });
      vi.stubGlobal("fetch", fetchSpy);
      try {
        const res = await pushItemStockToPetpooja("branch_unlinked", "pp_b1", true);
        expect(res).toBe(false);
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("refuses the stock push outright when a declared-production process has the POS mock active", async () => {
      // ZERO-MOCK runtime guard (env.ts:267-273). The boot assert alone is not
      // enough because config.mock is a plain mutable object, so the push
      // re-checks at its own boundary. Without this, the mock branch at
      // item86ingSync.ts:112-115 returns TRUE for a toggle it never sent -
      // reporting success to staff for a stock change the POS never received.
      const prevEnv = process.env.BURGONOMICS_ENV;
      config.mock.petpoojaPos = true; // the mock branch would otherwise "succeed"
      process.env.BURGONOMICS_ENV = "production";
      try {
        await expect(
          pushItemStockToPetpooja("branch_surat_01", "pp_b1", true)
        ).rejects.toThrow(/MOCK_PETPOOJA_POS is active in production/);
      } finally {
        if (prevEnv === undefined) delete process.env.BURGONOMICS_ENV;
        else process.env.BURGONOMICS_ENV = prevEnv;
      }
    });

    it("handles full menu webhook synchronization", async () => {
      const res = await handlePetpoojaMenuWebhook({
        rest_id: "branch_surat_01",
      });
      expect(res.success).toBe(true);
      expect(res.itemCount).toBe(4);
    });

    it("resolves a menu PUSH's outlet code from restaurants[].details.menusharingcode", () => {
      // The dashboard's "API Menu" push nests the code — reading only a
      // top-level rest_id made every real push throw "Missing rest_id" and
      // answer 400, and made the audit row for a refused push name no outlet.
      expect(
        extractMenuRestId({
          restaurants: [{ restaurantid: "5439", details: { menusharingcode: "31z58ciw0h" } }],
        })
      ).toBe("31z58ciw0h");
    });

    it.each([
      ["details.menusharingcode", { details: { menusharingcode: "31z58ciw0h" } }],
      ["details.menu_sharing_code", { details: { menu_sharing_code: "31z58ciw0h" } }],
      ["details.restID", { details: { restID: "31z58ciw0h" } }],
      ["flattened menusharingcode without details", { menusharingcode: "31z58ciw0h" }],
      ["flattened menusharingcode with empty details", { details: {}, menusharingcode: "31z58ciw0h" }],
    ])("resolves a menu PUSH's outlet code from %s", (_shape, restaurant) => {
      // Flattened pushes are a fallback, not a reason to require details.
      expect(extractMenuRestId({ restaurants: [restaurant] })).toBe("31z58ciw0h");
    });

    it.each([
      ["details.menusharingcode", {
        details: { menusharingcode: "primary_code", menu_sharing_code: "underscored_code", restID: "alias_code" },
        menusharingcode: "flattened_code",
      }, "primary_code"],
      ["details.menu_sharing_code", {
        details: { menu_sharing_code: "underscored_code", restID: "alias_code" },
        menusharingcode: "flattened_code",
      }, "underscored_code"],
      ["details.restID", {
        details: { restID: "alias_code" },
        menusharingcode: "flattened_code",
      }, "alias_code"],
    ])("prefers %s over the remaining push-code fallbacks", (_shape, restaurant, expected) => {
      // Conflicting spellings must keep the source's order — not whichever
      // property a vendor happens to send first.
      expect(extractMenuRestId({ restaurants: [restaurant] })).toBe(expected);
    });

    it("prefers an explicit top-level rest_id over all push-code spellings", () => {
      expect(
        extractMenuRestId({
          rest_id: "explicit_code",
          restaurants: [{
            details: { menusharingcode: "primary_code", menu_sharing_code: "underscored_code", restID: "alias_code" },
            menusharingcode: "flattened_code",
          }],
        })
      ).toBe("explicit_code");
    });

    it.each([
      ["keeps the first value even when a later entry has a nested code", [
        { menusharingcode: "first_code" },
        { details: { menusharingcode: "later_code" } },
      ]],
      ["skips an entry without a sharing code", [
        { restaurantid: "5439", details: {} },
        { details: { restID: "first_code" } },
        { details: { menusharingcode: "later_code" } },
      ]],
    ])("resolves the first restaurant entry that yields a code: %s", (_case, restaurants) => {
      expect(extractMenuRestId({ restaurants })).toBe("first_code");
    });

    it("prefers an explicit top-level rest_id over the nested push code", () => {
      expect(
        extractMenuRestId({
          rest_id: "explicit_code",
          restaurants: [{ details: { menusharingcode: "31z58ciw0h" } }],
        })
      ).toBe("explicit_code");
    });

    it("falls back to the numeric restaurantid only as a last resort", () => {
      expect(
        extractMenuRestId({ restaurants: [{ restaurantid: "5439", details: {} }] })
      ).toBe("5439");
      expect(extractMenuRestId({ restaurants: [{ details: {} }] })).toBeNull();
    });
  });

  describe("pushOrderToPetpooja & handlePetpoojaWebhook", () => {
    it("pushes order KOT to Petpooja and marks order synced", async () => {
      const success = await pushOrderToPetpooja("order_test_999");
      expect(success).toBe(true);
      expect(savedDocs["orders/order_test_999"]?.petpoojaStatus).toBe("synced");
      // Finding 5: A mock or relay push sets kotPushedAt, but does not manufacture kotPrinted!
      expect(savedDocs["orders/order_test_999"]?.kotPrinted).toBeUndefined();
      expect(savedDocs["orders/order_test_999"]?.kotPushedAt).toBeDefined();
      expect(savedDocs["orders/order_test_999"]?.petpoojaMock).toBe(true);
    });

    it("processes webhook food ready status update", async () => {
      await handlePetpoojaWebhook({
        order_id: "order_test_999",
        status: "FOOD_READY",
      });
      expect(savedDocs["orders/order_test_999"]?.status).toMatchObject({
        code: "READY_FOR_PICKUP",
        kind: "in_progress",
      });

      expect(savedDocs["orders/order_test_999"]?.petpoojaKitchenStatus).toBe("FOOD_READY");
    });

    it("processes webhook numeric 5 (food ready) status update", async () => {
      await handlePetpoojaWebhook({
        order_id: "order_test_999",
        status: 5,
      });

      expect(savedDocs["orders/order_test_999"]?.status).toMatchObject({
        code: "READY_FOR_PICKUP",
        kind: "in_progress",
      });
    });
  });
});
