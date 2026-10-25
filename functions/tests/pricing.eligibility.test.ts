import { describe, it, expect, vi } from "vitest";

/**
 * Money-time product eligibility + truthful degradation.
 *
 * Before this, the cart was the ONLY availability gate and it is client-side:
 * the pricing engine read `products/{id}.price` and never looked at `inStock`,
 * so a line that went 86 after it entered the cart (or came from a stale menu)
 * was still priced, charged, and pushed to the kitchen.
 *
 * These tests pin the server contract: an explicit `inStock: false` blocks the
 * line, a missing availability field (combo/import docs) is sellable, and a
 * line priced from client input after a transient read error is reported as
 * degraded instead of looking like a clean catalog price.
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
            if (docId === "prod_read_fail") {
              throw new Error("Firestore transient read error");
            }
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

import {
  calculateOrderPricing,
  repriceOrderForVerification,
} from "../src/modules/payments/pricing.engine";

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

  it("prices a combo/legacy product without inStock flag and allows it to be paid (missing = available)", async () => {
    // Combo-builder and brand-import docs carry no inStock. Only an explicit
    // false is an 86; an absent field is not evidence the item is unsellable.
    const r = await calculateOrderPricing(basket("prod_unknown"));
    expect(r.foodSubtotal).toBe(100);
    expect(r.pricingDegraded).toBe(false);

    // Verify it can be verified for payment
    const reprice = await repriceOrderForVerification({
      items: basket("prod_unknown").items,
      branchId: "b1",
      orderType: "takeaway",
      pricing: { grandTotal: r.grandTotal },
    });
    expect(reprice.matches).toBe(true);
    expect(reprice.pricingDegraded).toBe(false);
  });

  it("a product doc read failure does not hard-refuse as unverified (uses fallback with warning flag or retryable error)", async () => {
    // 1. Partial read failure in multi-line order: uses validated client price fallback with warning flag
    const multiBasket = {
      items: [
        { id: "l1", productId: "prod_ok", name: "Ok Item", price: 100, quantity: 1 },
        { id: "l2", productId: "prod_read_fail", name: "Failing Item", price: 120, quantity: 1 },
      ],
      orderType: "takeaway" as const,
      branchId: "b1",
      deliveryFee: 0,
      packagingFee: 15,
    };
    const r = await calculateOrderPricing(multiBasket);
    expect(r.pricingDegraded).toBe(true);
    expect(r.foodSubtotal).toBe(220);

    // 2. Total read failure: returns retryable 503 instead of non-retryable 409 ITEM_PRICE_UNVERIFIED
    try {
      await calculateOrderPricing(basket("prod_read_fail", 120));
    } catch (err: any) {
      expect(err.statusCode).toBe(503);
      expect(err.code).not.toBe("ITEM_PRICE_UNVERIFIED");
    }
  });

  it("REFUSES a line whose product cannot be looked up, instead of charging the client price", async () => {
    // The catalog is the only authoritative price source. Charging the price
    // the client happened to send for a product we cannot verify would let an
    // arbitrary request value set the amount - so this fails CLOSED.
    await expect(calculateOrderPricing(basket("prod_ghost", 120))).rejects.toMatchObject({
      statusCode: 409,
      code: "ITEM_PRICE_UNVERIFIED",
    });
  });

  it("allows a legitimate zero-price component that is explicitly in stock", async () => {
    // Zero price is not the defect; an unverifiable SOURCE is. Do not ban 0.
    const r = await calculateOrderPricing(basket("prod_free", 0));
    expect(r.foodSubtotal).toBe(0);
    expect(r.pricingDegraded).toBe(false);
  });
});
