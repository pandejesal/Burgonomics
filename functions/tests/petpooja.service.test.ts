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
      doc: (docId: string) => ({
        id: docId,
        set: vi.fn(async (data: any) => {
          savedDocs[`${colName}/${docId}`] = {
            ...(savedDocs[`${colName}/${docId}`] || {}),
            ...data,
          };
        }),
        get: vi.fn(async () => ({
          exists: true,
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
    it("correctly maps order details, items, GST tax splits, and order types", () => {
      const order = {
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
            id: "itm_smash_01",
            petpoojaItemId: "pp_b1",
            name: "Classic Smash Cheese Burger",
            price: 249,
            quantity: 2,
            isVeg: true,
            modifiers: [{ id: "bun_brioche", name: "Brioche Bun", price: 20 }],
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
      };

      const branch = { id: "branch_surat_01", petpoojaStoreId: "PP_SURAT_01" };
      const payload = formatPetpoojaOrderPayload(order, branch, "PP_SURAT_01");

      expect(payload.orderinfo.Order.orderID).toBe("BUR-1001");
      expect(payload.orderinfo.Order.resID).toBe("PP_SURAT_01");
      expect(payload.orderinfo.Order.restID).toBe("PP_SURAT_01");
      // Official V2.1.0 order_type is a letter code (H/P/D), not 1/2/3.
      expect(payload.orderinfo.Order.order_type).toBe("H"); // H = home delivery
      // Petpooja accepts COD / CARD / ONLINE — "Prepaid" is not a valid value.
      expect(payload.orderinfo.Order.payment_type).toBe("ONLINE");
      expect(payload.orderinfo.Order.total).toBe("527.90");
      expect(payload.orderinfo.Order.tax).toBe("24.90");
      expect(payload.orderinfo.Order.discount).toBe("50.00");
      expect(payload.orderinfo.Order.delivery_charges).toBe("40.00");
      expect(payload.orderinfo.Order.packing_charges).toBe("15.00");
      // Official Customer object carries the contact, not the flat order key.
      expect(payload.orderinfo.Customer.name).toBe("Aarav Mehta");
      expect(payload.orderinfo.Customer.phone).toBe("+919825100001");
      expect(payload.orderinfo.Customer.address).toBe("123 Adajan Main Rd");

      // Verify GST split (2.5% CGST + 2.5% SGST)
      expect(payload.orderinfo.tax_details).toHaveLength(2);
      expect(payload.orderinfo.tax_details[0].tax_name).toBe("CGST");
      expect(payload.orderinfo.tax_details[0].tax_percent).toBe(2.5);
      expect(payload.orderinfo.tax_details[1].tax_name).toBe("SGST");
      expect(payload.orderinfo.tax_details[1].tax_percent).toBe(2.5);

      // Official Tax[] shape (id/title/type/price/tax) is emitted alongside.
      expect(payload.orderinfo.Tax).toHaveLength(2);
      expect(payload.orderinfo.Tax[0].title).toBe("CGST");
      expect(payload.orderinfo.Tax[0].type).toBe("P");
      expect(payload.orderinfo.Tax[0].tax).toBe("12.45");

      // Verify item mapping with addons — official OrderItem names.
      expect(payload.orderinfo.OrderItem).toHaveLength(1);
      expect(payload.orderinfo.OrderItem[0].id).toBe("pp_b1");
      expect(payload.orderinfo.OrderItem[0].name).toBe("Classic Smash Cheese Burger");
      expect(payload.orderinfo.OrderItem[0].quantity).toBe("2");
      expect(payload.orderinfo.OrderItem[0].price).toBe("249.00");
      expect(payload.orderinfo.OrderItem[0].final_price).toBe("498.00");
      // Official AddonItem carries its entries under `details`.
      expect(payload.orderinfo.OrderItem[0].AddonItem.details).toHaveLength(1);
      expect(payload.orderinfo.OrderItem[0].AddonItem.details[0].name).toBe("Brioche Bun");
      expect(payload.orderinfo.OrderItem[0].AddonItem.details[0].group_name).toBe("Addons");
      expect(payload.orderinfo.OrderItem[0].AddonItem.details[0].price).toBe("20.00");
      // Legacy aliases remain for POS parsers that still read them.
      expect(payload.orderinfo.order_items).toHaveLength(1);
      expect(payload.orderinfo.order_items[0].item_id).toBe("pp_b1");
      expect(payload.orderinfo.order_items[0].addons[0].addon_name).toBe("Brioche Bun");

      // ---- the documented envelope ----
      // Everything must ALSO be reachable at
      // `orderinfo.OrderInfo.<Member>.details`. Without these levels the live
      // endpoint answers success:"1" while parsing nothing and registering no
      // order — the failure this builder shipped with for weeks.
      const info = payload.orderinfo.OrderInfo;
      expect(info.Restaurant.details.restID).toBe("PP_SURAT_01");
      expect(info.Customer.details.name).toBe("Aarav Mehta");
      expect(info.Order.details.orderID).toBe("BUR-1001");
      expect(info.Order.details.order_type).toBe("H");
      expect(info.OrderItem.details).toHaveLength(1);
      expect(info.OrderItem.details[0].id).toBe("pp_b1");
      expect(info.OrderItem.details[0].AddonItem.details).toHaveLength(1);
      expect(info.Tax.details).toHaveLength(2);
      expect(info.Tax.details[0].title).toBe("CGST");
      // Discounts travel as the two Order scalars; the member is declared empty.
      expect(info.Discount.details).toHaveLength(0);
    });

    it("carries the vendor's optional variation fields, as empty strings when absent", () => {
      // Vendor "API Guide for Placing Orders on Petpooja POS" (pp.6-7) lists
      // `variation_id` ("Unique ID for variant received from Menu Push Payload")
      // and `variation_name` ("Half Dish or Full Dish") as OPTIONAL, and its own
      // OrderItem example emits both as EMPTY STRINGS for a line with no variant.
      // The sandbox outlet exposes no variation definitions (81 of 166 items are
      // variation-flagged with an empty `variation` - see the menu census), so
      // the absent case is what ships for V1/V2/V4 and it must be a PRESENT ""
      // rather than an omitted key, which a stricter POS parser could read
      // differently. There was no test on these two keys at all before this one.
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
          { id: "l_no_variant", petpoojaItemId: "30791", name: "Tandoori Dahi Kebab", price: 350, quantity: 1 },
          {
            id: "l_with_variant",
            petpoojaItemId: "30792",
            name: "Half Dish Case",
            price: 200,
            quantity: 1,
            petpoojaVariationId: "110",
            petpoojaVariationName: "Half Dish",
          },
        ],
      };

      const payload = formatPetpoojaOrderPayload(order, null, "TEST_RES_ID");
      const [noVariant, withVariant] = payload.orderinfo.OrderItem;

      expect(noVariant.variation_id).toBe("");
      expect(noVariant.variation_name).toBe("");
      // The key must exist; undefined/absent is the shape the guide does not show.
      expect(Object.prototype.hasOwnProperty.call(noVariant, "variation_id")).toBe(true);
      expect(Object.prototype.hasOwnProperty.call(noVariant, "variation_name")).toBe(true);

      expect(withVariant.variation_id).toBe("110");
      expect(withVariant.variation_name).toBe("Half Dish");
    });

    it("also resolves the legacy `variationId`/`variationName` cart-line spellings", () => {
      // The relay reads `petpoojaVariationId || variationId` (and the matching
      // name pair). CartLine documents in the app carry the short spelling, so
      // a regression that kept only the prefixed one would silently strip the
      // variant off every variation line while still passing the case above.
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

      const payload = formatPetpoojaOrderPayload(order, null, "TEST_RES_ID");
      expect(payload.orderinfo.OrderItem[0].variation_id).toBe("110");
      expect(payload.orderinfo.OrderItem[0].variation_name).toBe("Full Dish");
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

      const payload1 = formatPetpoojaOrderPayload(takeawayOrder, null, "TEST_RES_ID");
      expect(payload1.orderinfo.Order.order_type).toBe("P");
      expect(payload1.orderinfo.Order.payment_type).toBe("COD");

      const payload2 = formatPetpoojaOrderPayload(dineInOrder, null, "TEST_RES_ID");
      expect(payload2.orderinfo.Order.order_type).toBe("D");
      expect(payload2.orderinfo.Order.payment_type).toBe("ONLINE");
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
            // The cart's documented escape hatch for POS ids.
            meta: { petpoojaItemId: "30799" },
          },
        ],
        pricing: { subtotal: 920, gst: 46, grandTotal: 966 },
      };

      const payload = formatPetpoojaOrderPayload(
        order,
        null,
        "TEST_RES_ID",
        "branch_surat_01"
      );
      const lines = payload.orderinfo.OrderItem as Array<Record<string, unknown>>;

      // `prod_<branchId>_<itemid>` is stripped by exact prefix.
      expect(lines[0].id).toBe("30791");
      expect(lines[0].item_id).toBe("30791");
      // `meta.petpoojaItemId` outranks the doc-id fallback.
      expect(lines[1].id).toBe("30799");
      // Prices come from `unitPrice`, not the absent `price`/`basePrice`.
      expect(lines[0].price).toBe("350.00");
      expect(lines[1].price).toBe("220.00");
      // `veg` is honoured; reading only `isVeg` reported every line as veg.
      expect(lines[0].item_attribute).toBe("2");
      expect(lines[1].item_attribute).toBe("1");
      // The tax split is a share of the order's embedded GST, per line.
      expect(Number(lines[0].item_tax[0].amount) + Number(lines[0].item_tax[1].amount)).toBeCloseTo(
        (46 * 700) / 920 / 1,
        2
      );
    });

    it("leaves the item id empty rather than inventing one when nothing resolves", () => {
      const payload = formatPetpoojaOrderPayload(
        {
          id: "ord_2002",
          fulfillmentType: "TAKEAWAY",
          paymentMethod: "COD",
          items: [{ lineId: "l1", productId: "prod_other_branch_9", unitPrice: 100, quantity: 1 }],
          pricing: { grandTotal: 100 },
        },
        null,
        "TEST_RES_ID",
        "branch_surat_01"
      );
      // Wrong-branch prefix must NOT be stripped into a bogus id.
      expect((payload.orderinfo.OrderItem as any)[0].id).toBe("");
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
    it("handles incoming 86ing out-of-stock webhook from Petpooja POS", async () => {
      await handlePetpoojaStockWebhook({
        rest_id: "branch_surat_01",
        item_id: "pp_b1",
        in_stock: 0,
      });

      // rest_id is unlinked in this fixture, so stock is staged on an
      // attributed orphan doc — never silently merged into another branch.
      expect(savedDocs["products/prod_unlinked_pp_b1"]?.inStock).toBe(false);
      expect(
        savedDocs["products/prod_unlinked_pp_b1"]?.branchId
      ).toBeUndefined();
    });

    it("pushes stock toggle to Petpooja API successfully", async () => {
      const res = await pushItemStockToPetpooja("branch_surat_01", "pp_b1", true);
      expect(res).toBe(true);
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
      expect(savedDocs["orders/order_test_999"]?.kotPrinted).toBe(true);
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
