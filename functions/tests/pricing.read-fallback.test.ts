import { describe, it, expect, vi } from "vitest";

/**
 * A catalog read failure for ONE line is an OUTAGE, not permission to charge
 * the price the client sent. The catalog is the only authoritative price
 * source, so a line whose read threw must refuse the whole basket with the
 * same retryable 503 a catalog-layer outage returns — never a "degraded"
 * total built from client input.
 *
 * A genuinely missing product doc is different (data shape, not an outage)
 * and still fails closed with 409 ITEM_PRICE_UNVERIFIED.
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

const OUTAGE_MESSAGE = "Menu pricing is temporarily unavailable — please retry checkout.";

describe("pricing read-failure refuses instead of charging a client price", () => {
  it("refuses the WHOLE basket with a retryable 503 when a readable line is mixed with a failed read", async () => {
    let result: any;
    let thrown: any;
    try {
      result = await calculateOrderPricing({
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
    } catch (err: any) {
      thrown = err;
    }

    // Zero priced success: no breakdown is returned for the basket at all.
    expect(result).toBeUndefined();
    expect(thrown).toBeTruthy();
    expect(thrown.statusCode).toBe(503);
    expect(thrown.message).toBe(OUTAGE_MESSAGE);
    expect(thrown.code).not.toBe("ITEM_PRICE_UNVERIFIED");
  });

  it("returns a retryable 503 when the ONLY line's catalog read failed", async () => {
    await expect(
      calculateOrderPricing({
        items: [{ id: "l1", productId: "prod_flaky", name: "Flaky", price: 70, quantity: 1 }],
        orderType: "takeaway",
        branchId: "b1",
        deliveryFee: 0,
        packagingFee: 15,
      })
    ).rejects.toMatchObject({ statusCode: 503, message: OUTAGE_MESSAGE });
  });

  it("still fails closed for a product doc that does not exist (409, not an outage)", async () => {
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
