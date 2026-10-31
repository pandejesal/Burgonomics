import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * PAY-13 (CRITICAL): the money must come from the ORDER DOCUMENT, never from
 * the request body.
 *
 * Before this, `createPaymentOrder` priced `params.items` while
 * `assertPayableOrderDoc` only checked existence/unpaid/ownership. Nothing
 * bound the priced cart to the order, and `repriceOrderForVerification` has no
 * production caller. Attack: write orders/{id} with 10 burgers, call
 * createPaymentOrder for it with one cheap item, pay — and the kitchen cooks
 * 10 burgers for the price of one.
 *
 * Pinned here: the order doc's items are priced (catalog prices, not the doc's
 * written price), the request's items and prices are irrelevant, an
 * unpriceable order is refused, no order id means no payable order, a retry
 * with an unchanged doc reuses the same gateway order, and a CHANGED doc can
 * never reuse an intent minted for the old cart.
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
            p1: { price: 199, inStock: true },
            p2: { price: 500, inStock: true },
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
import { config } from "../src/config/env";

const UID = "cust_doc";
const BRANCH = "branch_doc";

let prevMock: boolean;

function seedOrder(id: string, items: any[], extra: Record<string, any> = {}) {
  savedDocs[`orders/${id}`] = {
    id,
    customerId: UID,
    userId: UID,
    branchId: BRANCH,
    orderType: "takeaway",
    status: "pending_payment",
    items,
    ...extra,
  };
}

/** What the CLIENT claims in the request — deliberately cheap. */
const requestItems = [
  { id: "l1", productId: "p1", name: "Cheap", price: 1, quantity: 1 },
];

function params(extra: Record<string, any> = {}) {
  return {
    items: requestItems,
    branchId: BRANCH,
    orderType: "takeaway" as const,
    customerId: UID,
    ...extra,
  };
}

beforeEach(() => {
  for (const key of Object.keys(savedDocs)) delete savedDocs[key];
  prevMock = config.mock.paymentGateway;
  config.mock.paymentGateway = true;
  savedDocs[`branches/${BRANCH}`] = { razorpayAccountId: "acc_doc" };
});

afterEach(() => {
  config.mock.paymentGateway = prevMock;
});

describe("PAY-13 createPaymentOrder prices the order document", () => {
  it("charges the DOC cart, not the request (2 x 500, request says 1 x 10)", async () => {
    seedOrder("ord_doc", [
      { id: "l1", productId: "p2", name: "Big", price: 10, quantity: 2 },
    ]);
    const res = await createPaymentOrder(
      params({
        orderId: "ord_doc",
        items: [{ id: "l1", productId: "p1", name: "Cheap", price: 10, quantity: 1 }],
      })
    );
    // 2 x catalog 500 + 15 packaging = 1015 (the doc's written price 10 is
    // irrelevant; the catalog is authoritative).
    expect(res.pricing.foodSubtotal).toBe(1000);
    expect(res.pricing.grandTotal).toBe(1015);
    expect(res.amountPaise).toBe(101500);
    expect(savedDocs["orders/ord_doc"].pricing.grandTotal).toBe(1015);
  });

  it("ignores a tampered request price entirely", async () => {
    seedOrder("ord_tamper", [
      { id: "l1", productId: "p1", name: "Burger", price: 199, quantity: 1 },
    ]);
    const res = await createPaymentOrder(
      params({
        orderId: "ord_tamper",
        items: [{ id: "l1", productId: "p1", name: "Burger", price: 0.01, quantity: 1 }],
      })
    );
    expect(res.pricing.grandTotal).toBe(214);
    expect(res.amountPaise).toBe(21400);
  });

  it("refuses an order with no priceable items instead of pricing the request", async () => {
    seedOrder("ord_empty", []);
    const err: any = await createPaymentOrder(
      params({ orderId: "ord_empty" })
    ).then(
      () => null,
      (e) => e
    );
    expect(err).toMatchObject({ statusCode: 422, code: "UNPRICEABLE" });
    expect(savedDocs["orders/ord_empty"].pricing).toBeUndefined();
  });

  it("refuses a caller with no order id at all (nothing to bind the money to)", async () => {
    const err: any = await createPaymentOrder(params()).then(
      () => null,
      (e) => e
    );
    expect(err).toMatchObject({ statusCode: 409, code: "ORDER_REQUIRED" });
  });

  it("reuses the open gateway order on a retry while the doc is unchanged", async () => {
    seedOrder("ord_retry", [
      { id: "l1", productId: "p1", name: "Burger", price: 199, quantity: 1 },
    ]);
    const first = await createPaymentOrder(
      params({ orderId: "ord_retry", idempotencyKey: "k_doc_retry" })
    );
    const retry = await createPaymentOrder(
      // Same doc cart, DIFFERENT request items: still the same money.
      params({
        orderId: "ord_retry",
        idempotencyKey: "k_doc_retry",
        items: [{ id: "l1", productId: "p2", name: "Big", price: 500, quantity: 2 }],
      })
    );
    expect(retry.razorpayOrderId).toBe(first.razorpayOrderId);
    expect((retry as any).reused).toBe(true);
    expect(retry.amountPaise).toBe(first.amountPaise);
  });

  it("refuses to reuse an intent minted for a cart the order doc no longer has", async () => {
    seedOrder("ord_changed", [
      { id: "l1", productId: "p1", name: "Burger", price: 199, quantity: 1 },
    ]);
    await createPaymentOrder(
      params({ orderId: "ord_changed", idempotencyKey: "k_doc_changed" })
    );

    // A staff-side edit (customers cannot write items — see rules) changes the
    // cart AFTER the gateway order was minted for the old one.
    savedDocs["orders/ord_changed"].items = [
      { id: "l1", productId: "p2", name: "Big", price: 500, quantity: 3 },
    ];

    await expect(
      createPaymentOrder(
        params({ orderId: "ord_changed", idempotencyKey: "k_doc_changed" })
      )
    ).rejects.toMatchObject({ statusCode: 409, code: "PAYMENT_INTENT_CART_MISMATCH" });
  });
});
