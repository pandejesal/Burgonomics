import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * R6/R7 — charge the PERSISTED courier quote (owner decision 2026-10-31).
 *
 * Contract pinned here:
 *  - `createPaymentOrder` accepts `deliveryQuoteId`; the quote is loaded and
 *    bound to the order inside a transaction.
 *  - Refused with 409 DELIVERY_QUOTE_EXPIRED: another uid, another branch, a
 *    changed drop address, an expired quote, or a quote already used by a
 *    different order.
 *  - Allowed: a retry of the SAME order (usedByOrderId === orderId).
 *  - Missing quote: 409 DELIVERY_QUOTE_REQUIRED — never charged 0 or a default.
 *  - The client `deliveryFee` is ignored in both directions.
 *  - Repricing at verify reuses the stored server fee and calls no provider.
 *
 * Mock-only, in-memory store: no network, no Firestore, no gateway.
 */

const { mockDb, savedDocs } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};

  const docRef = (col: string, id: string): any => {
    const path = `${col}/${id}`;
    return {
      id,
      path,
      get: async () => {
        if (Object.prototype.hasOwnProperty.call(savedDocs, path)) {
          return { exists: true, data: () => savedDocs[path], ref: { id, path } };
        }
        if (col === "products") {
          const catalog: Record<string, { price: number; inStock: boolean }> = {
            p1: { price: 199, inStock: true },
          };
          const entry = catalog[id];
          if (entry) {
            return { exists: true, data: () => ({ ...entry }), ref: { id, path } };
          }
        }
        return { exists: false, data: () => undefined, ref: { id, path } };
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
      update: async (data: any) => {
        savedDocs[path] = { ...(savedDocs[path] || {}), ...data };
      },
    };
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
                const id = k.split("/")[1];
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
        update: (ref: any, data: any) => ref.set(data, { merge: true }),
      }),
  };

  return { mockDb, savedDocs };
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
import { repriceOrderForVerification } from "../src/modules/payments/pricing.engine";
import { clearBranchPricingCache } from "../src/modules/payments/branchPricing";
import { config } from "../src/config/env";

const ORDER_ID = "ord_quote_1";
const UID = "uid_buyer_1";
const BRANCH = "branch_demo";
const DROP = { lat: 23.0338, lng: 72.5262 };
const FEE = 42.55;

let savedEnv: any = {};

function seedOrder(id: string, extra: Record<string, any> = {}) {
  savedDocs[`orders/${id}`] = {
    id,
    branchId: BRANCH,
    customerId: UID,
    userId: UID,
    orderType: "delivery",
    items: [{ id: "l1", productId: "p1", name: "Burger", price: 199, quantity: 1 }],
    deliveryAddress: { lat: DROP.lat, lng: DROP.lng },
    ...extra,
  };
}

function seedQuote(id: string, extra: Record<string, any> = {}) {
  savedDocs[`delivery_fee_quotes/${id}`] = {
    uid: UID,
    branchId: BRANCH,
    storeId: "demo",
    dropLat: DROP.lat,
    dropLng: DROP.lng,
    fee: FEE,
    provider: "borzo",
    providerQuoteId: "QTE-BORZO-1",
    createdAt: "MOCK_TIMESTAMP",
    createdAtMs: Date.now() - 1000,
    expiresAt: Date.now() + 5 * 60_000,
    usedByOrderId: null,
    ...extra,
  };
}

function baseOrderParams(extra: Record<string, any> = {}) {
  return {
    orderId: ORDER_ID,
    items: [{ id: "l1", productId: "p1", name: "Burger", price: 199, quantity: 1 }],
    branchId: BRANCH,
    orderType: "delivery" as const,
    customerId: UID,
    ...extra,
  };
}

beforeEach(() => {
  savedEnv = {
    mock: { ...config.mock },
    branches: undefined,
  };
  config.mock.paymentGateway = true;
  for (const k of Object.keys(savedDocs)) delete savedDocs[k];
  savedDocs[`branches/${BRANCH}`] = {
    name: "Burgonomics Demo",
    coordinates: { lat: 23.0225, lng: 72.5714 },
    packagingFee: 15,
  };
  clearBranchPricingCache();
  seedOrder(ORDER_ID);
  seedQuote("dfq_good_quote_1");
});

afterEach(() => {
  config.mock = { ...savedEnv.mock };
});

describe("createPaymentOrder charges the persisted courier quote (R6)", () => {
  it("charges the quote fee, not the client deliveryFee", async () => {
    const res = await createPaymentOrder(
      baseOrderParams({
        deliveryQuoteId: "dfq_good_quote_1",
        // Client claims a free delivery AND an inflated one; both are ignored.
        deliveryFee: 0,
      })
    );
    // 199 food (inclusive) + 15 packaging + 42.55 courier quote = 256.55
    expect(res.pricing.deliveryFee).toBe(FEE);
    expect(res.pricing.grandTotal).toBe(256.55);
    expect(res.amountPaise).toBe(25655);
    expect(savedDocs[`delivery_fee_quotes/dfq_good_quote_1`].usedByOrderId).toBe(ORDER_ID);
  });

  it("binds the quote to the order it paid for", async () => {
    const inflated = await createPaymentOrder(
      baseOrderParams({ deliveryQuoteId: "dfq_good_quote_1", deliveryFee: 999 })
    );
    expect(inflated.pricing.deliveryFee).toBe(FEE);
  });

  it("refuses a missing quote and never charges 0 or a default", async () => {
    const err: any = await createPaymentOrder(baseOrderParams()).then(
      () => null,
      (e) => e
    );
    expect(err).toMatchObject({ statusCode: 409, code: "DELIVERY_QUOTE_REQUIRED" });
    expect(savedDocs[`orders/${ORDER_ID}`].pricing).toBeUndefined();
  });

  it("refuses a quote from another uid", async () => {
    seedQuote("dfq_other_uid", { uid: "uid_someone_else" });
    await expect(
      createPaymentOrder(baseOrderParams({ deliveryQuoteId: "dfq_other_uid" }))
    ).rejects.toMatchObject({ statusCode: 409, code: "DELIVERY_QUOTE_EXPIRED" });
  });

  it("refuses an expired quote", async () => {
    seedQuote("dfq_expired", { expiresAt: Date.now() - 1 });
    await expect(
      createPaymentOrder(baseOrderParams({ deliveryQuoteId: "dfq_expired" }))
    ).rejects.toMatchObject({ statusCode: 409, code: "DELIVERY_QUOTE_EXPIRED" });
  });

  it("refuses a quote quoted for another branch", async () => {
    seedQuote("dfq_other_branch", { branchId: "branch_other" });
    await expect(
      createPaymentOrder(baseOrderParams({ deliveryQuoteId: "dfq_other_branch" }))
    ).rejects.toMatchObject({ statusCode: 409, code: "DELIVERY_QUOTE_EXPIRED" });
  });

  it("refuses a quote when the drop coordinates changed", async () => {
    seedQuote("dfq_other_drop", { dropLat: 23.5, dropLng: 72.9 });
    await expect(
      createPaymentOrder(baseOrderParams({ deliveryQuoteId: "dfq_other_drop" }))
    ).rejects.toMatchObject({ statusCode: 409, code: "DELIVERY_QUOTE_EXPIRED" });
  });

  it("refuses a quote already used by a second order", async () => {
    seedQuote("dfq_used", { usedByOrderId: "ord_someone_else" });
    await expect(
      createPaymentOrder(baseOrderParams({ deliveryQuoteId: "dfq_used" }))
    ).rejects.toMatchObject({ statusCode: 409, code: "DELIVERY_QUOTE_EXPIRED" });
  });

  it("allows a retry of the SAME order with the same quote", async () => {
    const first = await createPaymentOrder(
      baseOrderParams({ deliveryQuoteId: "dfq_good_quote_1", idempotencyKey: "chk_retry_key_1" })
    );
    expect(first.pricing.deliveryFee).toBe(FEE);
    // Same order, NEW idempotency key: the quote is already bound to this
    // order, which is a retry, not reuse.
    const second = await createPaymentOrder(
      baseOrderParams({ deliveryQuoteId: "dfq_good_quote_1", idempotencyKey: "chk_retry_key_2" })
    );
    expect(second.pricing.deliveryFee).toBe(FEE);
    expect(savedDocs[`delivery_fee_quotes/dfq_good_quote_1`].usedByOrderId).toBe(ORDER_ID);
  });

  it("does not require a quote for takeaway", async () => {
    const res = await createPaymentOrder(
      baseOrderParams({ orderType: "takeaway" as const })
    );
    expect(res.pricing.deliveryFee).toBe(0);
    expect(res.pricing.grandTotal).toBe(214); // 199 + 15
  });
});

describe("repricing at verify (R7)", () => {
  it("reuses the stored server fee and never calls a provider", async () => {
    const fetchSpy = vi.fn();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy as any;
    try {
      const order = {
        items: [{ id: "l1", productId: "p1", name: "Burger", price: 199, quantity: 1 }],
        branchId: BRANCH,
        orderType: "delivery",
        // Client-writable top-level fields: deliberately wrong.
        deliveryFee: 0,
        packagingFee: 0,
        pricing: { deliveryFee: FEE, packagingFee: 15, grandTotal: 256.55 },
      };
      const res = await repriceOrderForVerification(order);
      expect(res.matches).toBe(true);
      expect(res.expectedGrandTotal).toBe(256.55);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("fails closed when a delivery order has no stored server fee", async () => {
    const err: any = await repriceOrderForVerification({
      items: [{ id: "l1", productId: "p1", name: "Burger", price: 199, quantity: 1 }],
      branchId: BRANCH,
      orderType: "delivery",
      pricing: { grandTotal: 214 },
    }).then(
      () => null,
      (e) => e
    );
    expect(err).toMatchObject({ statusCode: 422, code: "DELIVERY_FEE_REQUIRED" });
  });
});
