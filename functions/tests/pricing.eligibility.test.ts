import { describe, it, expect, vi } from "vitest";

/**
 * Money-time product eligibility + truthful degradation.
 *
 * Before this, the cart was the ONLY availability gate and it is client-side:
 * the pricing engine read `products/{id}.price` and never looked at `inStock`,
 * so a line that went 86 after it entered the cart (or came from a stale menu)
 * was still priced, charged, and pushed to the kitchen.
 *
 * These tests pin the server contract: only an explicit boolean `true` is
 * sellable, unknown fails CLOSED, and a line priced from client input is
 * reported as degraded instead of looking like a clean catalog price.
 */

const CATALOG: Record<string, { price: number; inStock?: boolean }> = {
  prod_ok: { price: 100, inStock: true },
  prod_off: { price: 100, inStock: false },
  prod_unknown: { price: 100 }, // doc predates the availability field
  prod_free: { price: 0, inStock: true }, // a legitimate zero-price component
};

const { mockDb } = vi.hoisted(() => {
  const mockDb: any = {
    collection: (col: string) => ({
      doc: (docId: string) => ({
        id: docId,
        get: async () => {
          if (col === "products") {
            const entry = (CATALOG as any)[docId];
            return entry === undefined
              ? { exists: false, data: () => ({}), id: docId }
              : { exists: true, data: () => ({ ...entry }), id: docId };
          }
          if (col === "branches") {
            return { exists: true, data: () => ({ royaltyPercentage: 5, packagingFee: 15 }), id: docId };
          }
          return { exists: false, data: () => ({}), id: docId };
        },
        set: async () => {},
      }),
    }),
    getAll: async (...refs: any[]) => Promise.all(refs.map((r: any) => r.get())),
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

import { calculateOrderPricing } from "../src/modules/payments/pricing.engine";

const basket = (productId: string, price = 100) => ({
  items: [{ id: "l1", productId, name: "Item", price, quantity: 1 }],
  orderType: "takeaway" as const,
  branchId: "b1",
  deliveryFee: 0,
  packagingFee: 15,
});

describe("money-time product eligibility (server, authoritative)", () => {
  it("prices a product that is explicitly in stock", async () => {
    const r = await calculateOrderPricing(basket("prod_ok"));
    expect(r.foodSubtotal).toBe(100);
    expect(r.pricingDegraded).toBe(false);
  });

  it("refuses an explicitly out-of-stock product instead of charging for it", async () => {
    await expect(calculateOrderPricing(basket("prod_off"))).rejects.toMatchObject({
      statusCode: 409,
      code: "ITEM_UNAVAILABLE",
    });
  });

  it("fails CLOSED when the product doc carries no availability field", async () => {
    // Not 'probably fine': an unknown eligibility is not a licence to sell.
    await expect(calculateOrderPricing(basket("prod_unknown"))).rejects.toMatchObject({
      statusCode: 409,
      code: "ITEM_UNAVAILABLE",
    });
  });

  it("keeps the documented client-price fallback for a MISSING product, but flags it", async () => {
    // A missing doc is a different case from an unknown field: it is the
    // documented partial-fallback path. It must not look like a clean price.
    const r = await calculateOrderPricing(basket("prod_ghost", 120));
    expect(r.foodSubtotal).toBe(120);
    expect(r.pricingDegraded).toBe(true);
  });

  it("allows a legitimate zero-price component that is explicitly in stock", async () => {
    // Zero price is not the defect; an unverifiable SOURCE is. Do not ban 0.
    const r = await calculateOrderPricing(basket("prod_free", 0));
    expect(r.foodSubtotal).toBe(0);
    expect(r.pricingDegraded).toBe(false);
  });
});
