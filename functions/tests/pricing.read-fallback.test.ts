import { describe, it, expect, vi } from "vitest";

/**
 * A temporary catalog read failure for ONE line must not become a
 * non-retryable "unverified price" error. When the catalog as a whole answers,
 * the failed line uses the already-validated client price and the result is
 * flagged degraded. A genuinely missing product doc still fails closed.
 *
 * This mock deliberately omits `getAll` so the engine takes its sequential
 * path, where a single doc read can throw independently.
 */
const CATALOG: Record<string, { price: number; inStock?: boolean }> = {
  prod_ok: { price: 100, inStock: true },
  prod_unknown: { price: 80 },
};

const { mockDb } = vi.hoisted(() => {
  const mockDb: any = {
    collection: (col: string) => ({
      doc: (docId: string) => ({
        id: docId,
        get: async () => {
          if (col === "products" && docId === "prod_flaky") {
            throw new Error("transient Firestore read failure");
          }
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

describe("pricing read-failure fallback (sequential catalog path)", () => {
  it("prices the readable line and degrades only the line whose read failed", async () => {
    const result = await calculateOrderPricing({
      items: [
        { id: "l1", productId: "prod_ok", name: "Good", price: 100, quantity: 1 },
        { id: "l2", productId: "prod_flaky", name: "Flaky", price: 70, quantity: 1 },
        { id: "l3", productId: "prod_unknown", name: "Legacy", price: 80, quantity: 1 },
      ],
      orderType: "takeaway",
      branchId: "b1",
      deliveryFee: 0,
      packagingFee: 15,
    });

    expect(result.foodSubtotal).toBe(250);
    expect(result.pricingDegraded).toBe(true);
  });

  it("still fails closed for a product doc that does not exist", async () => {
    await expect(
      calculateOrderPricing({
        items: [
          { id: "l1", productId: "prod_ok", name: "Good", price: 100, quantity: 1 },
          { id: "l2", productId: "prod_ghost", name: "Ghost", price: 70, quantity: 1 },
        ],
        orderType: "takeaway",
        branchId: "b1",
        deliveryFee: 0,
        packagingFee: 15,
      })
    ).rejects.toMatchObject({ statusCode: 409, code: "ITEM_PRICE_UNVERIFIED" });
  });
});
