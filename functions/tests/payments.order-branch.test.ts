import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * PAY-15: the BRANCH is order data, not request data.
 *
 * createPaymentOrder resolved branchId/storeId from the request BEFORE loading
 * the order. A request branch changes the packaging fee (pricing.engine) and
 * the Route transfer target, so a caller could pay for one outlet's order at
 * another outlet's packaging/royalty configuration.
 *
 * Pinned here: the order document's branch is used for money and routing even
 * when the request names another branch; a doc with no branchId falls back to
 * its own store's partnerBranchId; the delivery quote is bound against the SAME
 * resolved branch.
 */

const { savedDocs, mockDb } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};

  const docRef = (col: string, id: string): any => {
    const path = `${col}/${id}`;
    const ref: any = {
      id,
      path,
      get: async () => {
        if (Object.prototype.hasOwnProperty.call(savedDocs, path)) {
          return { exists: true, data: () => savedDocs[path], ref };
        }
        if (col === "products") {
          const catalog: Record<string, { price: number; inStock: boolean }> = {
            p1: { price: 500, inStock: true },
          };
          const entry = catalog[id];
          if (entry) return { exists: true, data: () => ({ ...entry }), ref };
        }
        return { exists: false, data: () => undefined, ref };
      },
      set: async (data: any, opts?: any) => {
        savedDocs[path] =
          opts?.merge && savedDocs[path] ? { ...savedDocs[path], ...data } : data;
      },
      create: async (data: any) => {
        if (Object.prototype.hasOwnProperty.call(savedDocs, path)) {
          const err: any = new Error("Document already exists");
          err.code = 6;
          throw err;
        }
        savedDocs[path] = data;
      },
    };
    return ref;
  };

  const mockDb: any = {
    collection: (col: string) => ({
      doc: (id: string) => docRef(col, id),
      where: (field: string, _op: string, value: any) => {
        const query: any = {
          limit: () => query,
          get: async () => {
            const docs = Object.keys(savedDocs)
              .filter((k) => k.startsWith(`${col}/`))
              .filter((k) => savedDocs[k]?.[field] === value)
              .map((k) => {
                const id = k.slice(col.length + 1);
                return { id, data: () => savedDocs[k], ref: docRef(col, id) };
              });
            return { empty: docs.length === 0, docs };
          },
        };
        return query;
      },
    }),
    runTransaction: async (fn: any) =>
      fn({
        get: (ref: any) => ref.get(),
        set: (ref: any, data: any, opts?: any) => ref.set(data, opts),
      }),
  };

  return { savedDocs, mockDb };
});

vi.mock("firebase-admin", () => {
  const FieldValue = {
    serverTimestamp: () => "MOCK_TIMESTAMP",
    increment: (n: number) => n,
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

import { createPaymentOrder } from "../src/modules/payments/razorpay.service";
import { clearBranchPricingCache } from "../src/modules/payments/branchPricing";
import { config } from "../src/config/env";

const UID = "cust_branch";
const BRANCH_A = "branch_a"; // doc branch: packaging 22, royalty 20
const BRANCH_B = "branch_b"; // request branch: packaging 15, royalty 5
const DROP = { lat: 23.0338, lng: 72.5262 };

let prevMock: boolean;

function seedOrder(id: string, extra: Record<string, any> = {}) {
  savedDocs[`orders/${id}`] = {
    id,
    customerId: UID,
    userId: UID,
    orderType: "takeaway",
    status: "pending_payment",
    items: [{ id: "l1", productId: "p1", name: "Burger", price: 500, quantity: 1 }],
    ...extra,
  };
}

function request(extra: Record<string, any> = {}) {
  return {
    items: [{ id: "l1", productId: "p1", name: "Burger", price: 1, quantity: 1 }],
    orderType: "takeaway" as const,
    customerId: UID,
    ...extra,
  };
}

beforeEach(() => {
  for (const key of Object.keys(savedDocs)) delete savedDocs[key];
  prevMock = config.mock.paymentGateway;
  config.mock.paymentGateway = true;
  savedDocs[`branches/${BRANCH_A}`] = { packagingFee: 22, royaltyPercentage: 20 };
  savedDocs[`branches/${BRANCH_B}`] = { packagingFee: 15, royaltyPercentage: 5 };
  clearBranchPricingCache();
});

afterEach(() => {
  config.mock.paymentGateway = prevMock;
});

describe("PAY-15 the branch comes from the order document", () => {
  it("prices and routes to the doc's branch when the request names another", async () => {
    seedOrder("ord_branch", { branchId: BRANCH_A });
    const res = await createPaymentOrder(
      request({ orderId: "ord_branch", branchId: BRANCH_B })
    );

    // Branch A packaging (22), not the request's B (15).
    expect(res.pricing.packagingFee).toBe(22);
    expect(res.pricing.grandTotal).toBe(522);
    // No per-order royalty survives anywhere on the split (F3).
    expect(res.pricing.split).not.toHaveProperty("royaltyPercentage");
    expect(res.pricing.split).not.toHaveProperty("brandRoyaltyPaise");
    expect(res.pricing.split.branchTransferPaise).toBe(52200);
    // The stamped order and the intent (the Route transfer target) carry A.
    expect(savedDocs["orders/ord_branch"].pricing.packagingFee).toBe(22);
  });

  it("writes the doc's branch onto the payment intent", async () => {
    seedOrder("ord_intent_branch", { branchId: BRANCH_A });
    await createPaymentOrder(
      request({
        orderId: "ord_intent_branch",
        branchId: BRANCH_B,
        idempotencyKey: "k_branch_intent",
      })
    );
    expect(savedDocs["payment_intents/k_branch_intent"].branchId).toBe(BRANCH_A);
  });

  it("falls back to the order's STORE mapping only when the doc has no branchId", async () => {
    savedDocs["stores/store_a"] = { partnerBranchId: BRANCH_A };
    seedOrder("ord_store", { storeId: "store_a" });
    const res = await createPaymentOrder(
      request({ orderId: "ord_store", branchId: BRANCH_B })
    );
    // Binding asserts the branch from the doc drives the money: branch A's
    // packaging (22), not the request's B (15).
    expect(res.pricing.packagingFee).toBe(22);
    expect(res.pricing.split).not.toHaveProperty("royaltyPercentage");
  });

  it("binds the delivery quote against the resolved (doc) branch", async () => {
    // The quote belongs to A. If the request's B were used, binding would
    // refuse with DELIVERY_QUOTE_EXPIRED and no fee would be charged.
    seedOrder("ord_delivery_branch", {
      branchId: BRANCH_A,
      orderType: "delivery",
      deliveryAddress: { lat: DROP.lat, lng: DROP.lng },
    });
    savedDocs["delivery_fee_quotes/dfq_branch_a"] = {
      uid: UID,
      branchId: BRANCH_A,
      storeId: "demo",
      dropLat: DROP.lat,
      dropLng: DROP.lng,
      fee: 40,
      provider: "borzo",
      providerQuoteId: "QTE-A",
      createdAt: "MOCK_TIMESTAMP",
      createdAtMs: Date.now() - 1000,
      expiresAt: Date.now() + 5 * 60_000,
      usedByOrderId: null,
    };
    const res = await createPaymentOrder(
      request({
        orderId: "ord_delivery_branch",
        branchId: BRANCH_B,
        orderType: "delivery",
        deliveryQuoteId: "dfq_branch_a",
      })
    );
    expect(res.pricing.deliveryFee).toBe(40);
    expect(res.pricing.packagingFee).toBe(22); // A
    expect(savedDocs["delivery_fee_quotes/dfq_branch_a"].usedByOrderId).toBe(
      "ord_delivery_branch"
    );
  });
});
