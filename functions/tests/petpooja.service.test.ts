import { describe, it, expect, vi } from "vitest";

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

describe("Petpooja POS Bridge Service", () => {
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
      const payload = formatPetpoojaOrderPayload(order, branch);

      expect(payload.orderinfo.orderID).toBe("BUR-1001");
      expect(payload.orderinfo.resID).toBe("PP_SURAT_01");
      expect(payload.orderinfo.order_type).toBe("1"); // 1 = Delivery
      expect(payload.orderinfo.payment_type).toBe("Prepaid");
      expect(payload.orderinfo.total).toBe(527.9);
      expect(payload.orderinfo.tax).toBe(24.9);
      expect(payload.orderinfo.discount).toBe(50);
      expect(payload.orderinfo.delivery_charges).toBe(40);
      expect(payload.orderinfo.packing_charges).toBe(15);
      expect(payload.orderinfo.customer_name).toBe("Aarav Mehta");
      expect(payload.orderinfo.customer_phone).toBe("+919825100001");
      expect(payload.orderinfo.customer_address).toBe("123 Adajan Main Rd");

      // Verify GST split (2.5% CGST + 2.5% SGST)
      expect(payload.orderinfo.tax_details).toHaveLength(2);
      expect(payload.orderinfo.tax_details[0].tax_name).toBe("CGST");
      expect(payload.orderinfo.tax_details[0].tax_percent).toBe(2.5);
      expect(payload.orderinfo.tax_details[1].tax_name).toBe("SGST");
      expect(payload.orderinfo.tax_details[1].tax_percent).toBe(2.5);

      // Verify item mapping with addons
      expect(payload.orderinfo.order_items).toHaveLength(1);
      expect(payload.orderinfo.order_items[0].item_id).toBe("pp_b1");
      expect(payload.orderinfo.order_items[0].quantity).toBe(2);
      expect(payload.orderinfo.order_items[0].addons).toHaveLength(1);
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

      const payload1 = formatPetpoojaOrderPayload(takeawayOrder, null);
      expect(payload1.orderinfo.order_type).toBe("2");
      expect(payload1.orderinfo.payment_type).toBe("COD");

      const payload2 = formatPetpoojaOrderPayload(dineInOrder, null);
      expect(payload2.orderinfo.order_type).toBe("3");
      expect(payload2.orderinfo.payment_type).toBe("Prepaid");
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

      expect(savedDocs["products/prod_pp_b1"]?.inStock).toBe(false);
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
