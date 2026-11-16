import { describe, expect, it, vi } from "vitest";

const { mockDb } = vi.hoisted(() => {
  const fees: Record<string, number> = { fractional: 1.005, integer: 15 };
  const ref = (collection: string, id: string) => ({
    id,
    get: async () => ({
      id,
      exists: true,
      data: () => collection === "products"
        ? { price: 100, inStock: true }
        : { packagingFee: fees[id] },
    }),
  });
  return { mockDb: {
    collection: (collection: string) => ({ doc: (id: string) => ref(collection, id) }),
    getAll: async (...refs: any[]) => Promise.all(refs.map((r) => r.get())),
  } };
});

vi.mock("firebase-admin", () => {
  const firestore: any = vi.fn(() => mockDb);
  firestore.FieldValue = { serverTimestamp: () => "timestamp" };
  const initializeApp = vi.fn();
  const apps = [{ name: "mock" }];
  const auth = vi.fn(() => ({}));
  const messaging = vi.fn(() => ({}));
  return { default: { firestore, apps, initializeApp, auth, messaging }, firestore, apps, initializeApp, auth, messaging };
});

import { calculateOrderPricing, computeSnapshotPricing } from "../src/modules/payments/pricing.engine";
import { clearBranchPricingCache } from "../src/modules/payments/branchPricing";

describe("checkout and snapshot packaging parity", () => {
  it.each([
    { branchId: "fractional", fee: 1.005, total: 101.01, paise: 10101 },
    { branchId: "integer", fee: 15, total: 115, paise: 11500 },
  ])("preserves totals for $branchId packaging", async ({ branchId, fee, total, paise }) => {
    clearBranchPricingCache();
    const items = [{ id: "line", productId: "burger", name: "Burger", price: 100, quantity: 1 }];
    const checkout = await calculateOrderPricing({ items, branchId, orderType: "takeaway" });
    const snapshot = computeSnapshotPricing({
      items,
      branchId,
      orderType: "takeaway",
      products: new Map([["burger", { price: 100, inStock: true }]]),
      branchConfig: { packagingFee: fee, branchPackagingFee: fee, packaging: null, monthlyFeePaise: 250000 },
    });
    expect(snapshot.grandTotal).toBe(total);
    expect(checkout.grandTotal).toBe(snapshot.grandTotal);
    expect(checkout.split).toEqual(snapshot.split);
    expect(checkout.split).toEqual({ courierFeePaise: 0, branchTransferPaise: paise, totalAmountPaise: paise });
    for (const value of Object.values(checkout.split)) expect(Number.isInteger(value)).toBe(true);
  });
});
