import { describe, it, expect, vi, beforeEach } from "vitest";

// D-01: creating a payment order for a store that has no linked branch must
// fail as a typed 409 STORE_NOT_LINKED (customer-safe copy), and a Firestore
// READ FAILURE while resolving the store must be 503 — a transient outage
// must never tell the customer the outlet stopped taking orders.
const { state } = vi.hoisted(() => {
  process.env.OTP_HMAC_SECRET = "test_otp_payments_store_link";
  const state: { mode: "unlinked" | "throw" } = { mode: "unlinked" };
  const storeDoc: any = {
    get: async () => {
      if (state.mode === "throw") throw new Error("firestore unavailable");
      return { exists: true, data: () => ({ name: "Unlinked outlet" }) };
    },
    set: async () => undefined,
    update: async () => undefined,
  };
  // PAY-15: the branch resolves from the ORDER document, so the mock must be
  // collection-aware: the order exists and points at the unlinked store.
  const orderDoc: any = {
    get: async () => ({
      exists: true,
      data: () => ({
        id: "ord_store_link",
        customerId: "cust_unlinked",
        orderType: "takeaway",
        storeId: "store_unlinked_1",
        items: [{ id: "pp_b1", productId: "pp_b1", name: "Burger", price: 199, quantity: 1 }],
      }),
    }),
    set: async () => undefined,
    update: async () => undefined,
  };
  const doc = (col: string) => (col === "orders" ? orderDoc : storeDoc);
  const mockDb: any = {
    collection: (col: string) => ({ doc: () => doc(col) }),
  };
  (globalThis as any).__mockDb = mockDb;
  return { state };
});

vi.mock("firebase-admin", () => {
  const FieldValue = {
    serverTimestamp: () => "MOCK_TIMESTAMP",
    increment: (n: number) => n,
    arrayUnion: (item: any) => [item],
    delete: () => "MOCK_DELETE",
  };
  const firestoreFn: any = vi.fn(() => (globalThis as any).__mockDb);
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

import { createPaymentOrder } from "../src/modules/payments/razorpay.service";

const basket = {
  items: [{ id: "pp_b1", productId: "pp_b1", name: "Burger", price: 199, quantity: 1 }],
  orderType: "takeaway" as const,
  customerId: "cust_unlinked",
  storeId: "store_unlinked_1",
  orderId: "ord_store_link",
};

describe("D-01 createPaymentOrder store→branch resolution", () => {
  beforeEach(() => {
    state.mode = "unlinked";
  });

  it("returns a typed 409 STORE_NOT_LINKED with customer-safe copy", async () => {
    const err: any = await createPaymentOrder(basket).catch((e) => e);
    expect(err.statusCode).toBe(409);
    expect(err.code).toBe("STORE_NOT_LINKED");
    expect(err.message).toBe("This outlet isn't taking online orders yet.");
  });

  it("returns 503 (not 'unlinked') when the store read fails", async () => {
    state.mode = "throw";
    const err: any = await createPaymentOrder(basket).catch((e) => e);
    expect(err.statusCode).toBe(503);
    expect(err.code).not.toBe("STORE_NOT_LINKED");
    expect(err.message).not.toMatch(/isn't taking online orders/i);
  });
});
