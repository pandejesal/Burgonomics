import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * A pricing outage must stop createPaymentOrder BEFORE the gateway order is
 * minted. createPaymentOrder awaits calculateOrderPricing() before it ever
 * reaches razorpay.orders.create(), so a line whose catalog read failed has
 * to abort the whole checkout: no gateway order, no payment-intent lease, no
 * server pricing stamp. The client gets the retryable 503 and retries the SAME
 * idempotencyKey.
 */

const { mockDb, savedDocs, ordersCreate } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  const ordersCreate = vi.fn(async (_input: any) => ({ id: "order_live_minted" }));

  const docRef = (col: string, id: string) => {
    const path = `${col}/${id}`;
    return {
      id,
      path,
      get: vi.fn(async () => {
        if (col === "products" && id === "prod_flaky") {
          throw new Error("transient Firestore read failure");
        }
        if (col === "products") {
          if (id === "prod_ok") {
            return { exists: true, data: () => ({ price: 100, inStock: true }) };
          }
          return { exists: false, data: () => ({}) };
        }
        return {
          exists: Object.prototype.hasOwnProperty.call(savedDocs, path),
          data: () => savedDocs[path],
        };
      }),
      set: vi.fn(async (data: any, opts?: any) => {
        savedDocs[path] =
          opts?.merge && savedDocs[path] ? { ...savedDocs[path], ...data } : data;
      }),
      create: vi.fn(async (data: any) => {
        if (Object.prototype.hasOwnProperty.call(savedDocs, path)) {
          const err: any = new Error("Document already exists");
          err.code = 6;
          throw err;
        }
        savedDocs[path] = data;
      }),
    };
  };

  const mockDb: any = {
    collection: (col: string) => ({ doc: (id: string) => docRef(col, id) }),
  };
  return { mockDb, savedDocs, ordersCreate };
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

// Live gateway seam: the stub records any orders.create() call. Pricing must
// throw before this is ever reached.
vi.mock("../src/modules/payments/razorpayClient", () => ({
  getRazorpayClient: () => ({ orders: { create: ordersCreate } }),
  getRazorpayKeyId: () => "rzp_live_unittest",
}));

import { createPaymentOrder } from "../src/modules/payments/razorpay.service";
import { config } from "../src/config/env";

describe("createPaymentOrder — pricing outage never opens a gateway order", () => {
  let prevMock: boolean;
  let prevKeyId: string;
  let prevKeySecret: string;

  beforeEach(() => {
    for (const key of Object.keys(savedDocs)) delete savedDocs[key];
    ordersCreate.mockClear();
    prevMock = config.mock.paymentGateway;
    prevKeyId = config.razorpay.keyId;
    prevKeySecret = config.razorpay.keySecret;
    config.mock.paymentGateway = false;
    config.razorpay.keyId = "rzp_live_unittest";
    config.razorpay.keySecret = "unittest_secret";

    savedDocs["orders/ord_outage_1"] = {
      id: "ord_outage_1",
      customerId: "guest",
      orderType: "takeaway",
      status: "pending_payment",
    };
    savedDocs["branches/branch_o1"] = { royaltyPercentage: 5, packagingFee: 15 };
  });

  afterEach(() => {
    config.mock.paymentGateway = prevMock;
    config.razorpay.keyId = prevKeyId;
    config.razorpay.keySecret = prevKeySecret;
  });

  it("aborts with 503 before any gateway order is created", async () => {
    await expect(
      createPaymentOrder({
        orderId: "ord_outage_1",
        items: [
          { id: "l1", productId: "prod_ok", name: "Readable", price: 100, quantity: 1 },
          { id: "l2", productId: "prod_flaky", name: "Flaky", price: 70, quantity: 1 },
        ],
        branchId: "branch_o1",
        orderType: "takeaway",
        customerId: "guest",
        idempotencyKey: "k_price_outage",
      })
    ).rejects.toMatchObject({
      statusCode: 503,
      message: "Menu pricing is temporarily unavailable — please retry checkout.",
    });

    // The gateway was never asked to mint a payable order.
    expect(ordersCreate).not.toHaveBeenCalled();
    // No payment-intent lease, and no server pricing stamp on the order.
    expect(savedDocs["payment_intents/k_price_outage"]).toBeUndefined();
    expect(savedDocs["orders/ord_outage_1"].pricing).toBeUndefined();
  });
});
