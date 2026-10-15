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
      // Official AddonItem carries id/name/group_name/price.
      expect(payload.orderinfo.OrderItem[0].AddonItem).toHaveLength(1);
      expect(payload.orderinfo.OrderItem[0].AddonItem[0].name).toBe("Brioche Bun");
      expect(payload.orderinfo.OrderItem[0].AddonItem[0].group_name).toBe("Addons");
      expect(payload.orderinfo.OrderItem[0].AddonItem[0].price).toBe("20.00");
      // Legacy aliases remain for POS parsers that still read them.
      expect(payload.orderinfo.order_items).toHaveLength(1);
      expect(payload.orderinfo.order_items[0].item_id).toBe("pp_b1");
      expect(payload.orderinfo.order_items[0].addons[0].addon_name).toBe("Brioche Bun");
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
