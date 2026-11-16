import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Snapshot pricing seam — R1 walk-in scope (takeaway / dine-in, simple
 * products, no courier quote).
 *
 * WHY THIS EXISTS
 * `calculateOrderPricing` cannot run inside a Firestore transaction: it reads
 * `products`/`branches`/`coupons` itself and resolves branch config through a
 * 60s cache. The forthcoming walk-in create transaction reads those documents
 * INSIDE the transaction and must then price from that exact snapshot, or the
 * total it writes is not the total it verified.
 *
 * So the money math is factored into `computeSnapshotPricing`, a PURE function:
 * no Firestore, no cache, no logging, no provider. `calculateOrderPricing`
 * delegates to it, which is what makes the parity assertions below meaningful —
 * they compare the seam against the live engine on the same inputs.
 *
 * These tests are the RED proof that the seam does not exist yet and that a
 * snapshot path must not read, write, or warn.
 */

const { mockDb, io, CATALOG, BRANCHES, COUPONS } = vi.hoisted(() => {
  const io = { productReads: 0, branchReads: 0, couponReads: 0, writes: 0 };

  const CATALOG: Record<string, any> = {
    prod_hero: { price: 99, inStock: true },
    prod_bigbang: { price: 249, inStock: true },
    prod_fries: { price: 89, inStock: true },
    // 86'd at the kitchen: explicit false.
    prod_soldout: { price: 129, inStock: false },
    // A doc that predates the availability field: NOT sellable (fail closed).
    prod_legacy: { price: 100 },
    // Corrupt money. Must refuse, never produce a NaN total.
    prod_nan: { price: NaN, inStock: true },
    prod_inf: { price: Infinity, inStock: true },
    prod_neg: { price: -5, inStock: true },
  };

  const BRANCHES: Record<string, any> = {
    b1: { packagingFee: 15 },
    b_petpooja: {
      packagingFee: 12,
      packaging: {
        source: "petpooja",
        applicableOn: "ORDER",
        charge: 20,
        chargeType: "",
        taxOnPacking: 1,
        pcTaxIds: "",
        understood: true,
      },
    },
    b_unusable: {
      packagingFee: 12,
      packaging: {
        source: "petpooja",
        applicableOn: "ITEM",
        charge: 20,
        chargeType: "",
        taxOnPacking: 1,
        pcTaxIds: "",
        understood: false,
      },
    },
  };

  const COUPONS: Record<string, any> = {
    PERC10: { discount: 10, type: "percent", active: true, maxDiscount: 80 },
    FLAT50: { discount: 50, type: "flat", active: true },
  };

  const docGet = async (col: string, id: string) => {
    if (col === "products") {
      io.productReads += 1;
      const entry = CATALOG[id];
      return entry === undefined
        ? { exists: false, id, data: () => ({}) }
        : { exists: true, id, data: () => ({ ...entry }) };
    }
    if (col === "branches") {
      io.branchReads += 1;
      const entry = BRANCHES[id];
      return entry === undefined
        ? { exists: false, id, data: () => ({}) }
        : { exists: true, id, data: () => ({ ...entry }) };
    }
    if (col === "coupons") {
      io.couponReads += 1;
      const entry = COUPONS[id];
      return entry === undefined
        ? { exists: false, id, data: () => ({}) }
        : { exists: true, id, data: () => ({ ...entry }) };
    }
    return { exists: false, id, data: () => ({}) };
  };

  const ref = (col: string, id: string): any => ({
    id,
    get: () => docGet(col, id),
    set: async () => {
      io.writes += 1;
    },
  });

  const mockDb: any = {
    collection: (col: string) => ({
      doc: (id?: string) => ref(col, id as string),
      add: async () => {
        io.writes += 1;
      },
    }),
    getAll: async (...refs: any[]) => Promise.all(refs.map((r) => r.get())),
  };

  return { mockDb, io, CATALOG, BRANCHES, COUPONS };
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

import {
  calculateOrderPricing,
  computeSnapshotPricing,
  type PricingLineItem,
  type SnapshotProduct,
} from "../src/modules/payments/pricing.engine";
import { clearBranchPricingCache } from "../src/modules/payments/branchPricing";

const DEFAULT_CONFIG = {
  packagingFee: 15,
  branchPackagingFee: 15,
  packaging: null,
  monthlyFeePaise: 250000,
};

function branchConfig(branchId: string) {
  const branch = BRANCHES[branchId];
  return {
    packagingFee: branch.packagingFee ?? 15,
    ...(typeof branch.packagingFee === "number"
      ? { branchPackagingFee: branch.packagingFee }
      : {}),
    packaging: branch.packaging ?? null,
    monthlyFeePaise: 250000,
  };
}

function productsOf(ids: string[]): Map<string, SnapshotProduct> {
  const products = new Map<string, SnapshotProduct>();
  for (const id of ids) {
    const entry = CATALOG[id];
    if (entry === undefined) continue;
    products.set(id, {
      price: entry.price,
      inStock: entry.inStock,
      customizations: entry.customizations,
    });
  }
  return products;
}

function line(
  productId: string,
  overrides: Partial<PricingLineItem> = {}
): PricingLineItem {
  return {
    id: `l_${productId}`,
    productId,
    name: productId,
    price: CATALOG[productId]?.price ?? 0,
    quantity: 1,
    ...overrides,
  };
}

function snapshotInput(
  items: PricingLineItem[],
  overrides: Record<string, any> = {}
) {
  return {
    items,
    orderType: "takeaway" as const,
    products: productsOf(items.map((i) => i.productId || i.id)),
    branchConfig: DEFAULT_CONFIG,
    ...overrides,
  };
}

/** Fields the walk-in transaction persists as money — the parity surface. */
function money(result: any) {
  return {
    foodSubtotal: result.foodSubtotal,
    packagingFee: result.packagingFee,
    deliveryFee: result.deliveryFee,
    gst: result.gst,
    cgst: result.cgst,
    sgst: result.sgst,
    discount: result.discount,
    loyaltyDiscount: result.loyaltyDiscount,
    grandTotal: result.grandTotal,
    split: result.split,
  };
}

function capture(fn: () => unknown): any {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error("expected the call to throw");
}

beforeEach(() => {
  clearBranchPricingCache();
  io.productReads = 0;
  io.branchReads = 0;
  io.couponReads = 0;
  io.writes = 0;
});

describe("snapshot pricing — parity with the live engine", () => {
  it("matches the engine for a takeaway basket (inclusive GST, packaging, split)", async () => {
    const items = [line("prod_hero", { quantity: 2 })];
    const engine = await calculateOrderPricing({
      items,
      branchId: "b1",
      orderType: "takeaway",
    });
    const snapshot = computeSnapshotPricing(snapshotInput(items));

    expect(money(snapshot)).toEqual(money(engine));
    expect(snapshot.foodSubtotal).toBe(198);
    expect(snapshot.packagingFee).toBe(15);
    expect(snapshot.deliveryFee).toBe(0);
    // Menu prices are GST-inclusive: 198·5/105, never added on top.
    expect(snapshot.gst).toBe(9.43);
    expect(snapshot.grandTotal).toBe(213);
    expect(snapshot.pricingDegraded).toBe(false);
  });

  it("matches the engine for dine-in (packaging is 0)", async () => {
    const items = [line("prod_bigbang")];
    const engine = await calculateOrderPricing({
      items,
      branchId: "b1",
      orderType: "dinein",
    });
    const snapshot = computeSnapshotPricing(
      snapshotInput(items, { orderType: "dinein" })
    );

    expect(money(snapshot)).toEqual(money(engine));
    expect(snapshot.packagingFee).toBe(0);
    expect(snapshot.grandTotal).toBe(249);
  });

  it("matches the engine for a delivery with a server courier quote", async () => {
    const items = [line("prod_bigbang", { quantity: 2 })];
    const engine = await calculateOrderPricing({
      items,
      branchId: "b1",
      orderType: "delivery",
      serverDeliveryFee: 35,
    });
    const snapshot = computeSnapshotPricing(
      snapshotInput(items, { orderType: "delivery", serverDeliveryFee: 35 })
    );

    expect(money(snapshot)).toEqual(money(engine));
    expect(snapshot.deliveryFee).toBe(35);
    expect(snapshot.split.courierFeePaise).toBe(3500);
    expect(snapshot.split.branchTransferPaise).toBe(
      Math.round(snapshot.grandTotal * 100) - 3500
    );
  });

  it("matches the engine for a capped percent coupon", async () => {
    const items = [line("prod_bigbang", { quantity: 4 })];
    const engine = await calculateOrderPricing({
      items,
      branchId: "b1",
      orderType: "takeaway",
      couponCode: "PERC10",
    });
    const snapshot = computeSnapshotPricing(
      snapshotInput(items, { coupon: COUPONS.PERC10 })
    );

    expect(money(snapshot)).toEqual(money(engine));
    expect(snapshot.discount).toBe(80); // 10% of 996 = 99.6, capped at 80
    expect(snapshot.gst).toBe(43.62);
    expect(snapshot.grandTotal).toBe(931); // 916 + 15, GST inside the 916
  });

  it("matches the engine for loyalty redemption (20% cap)", async () => {
    const items = [line("prod_hero")];
    const engine = await calculateOrderPricing({
      items,
      branchId: "b1",
      orderType: "takeaway",
      loyaltyPointsToRedeem: 500,
    });
    const snapshot = computeSnapshotPricing(
      snapshotInput(items, { loyaltyPointsToRedeem: 500 })
    );

    expect(money(snapshot)).toEqual(money(engine));
    expect(snapshot.loyaltyDiscount).toBe(20);
  });

  it("matches the engine when Petpooja packaging is understood (ORDER charge)", async () => {
    const items = [line("prod_fries")];
    const engine = await calculateOrderPricing({
      items,
      branchId: "b_petpooja",
      orderType: "takeaway",
    });
    const snapshot = computeSnapshotPricing(
      snapshotInput(items, { branchConfig: branchConfig("b_petpooja") })
    );

    expect(money(snapshot)).toEqual(money(engine));
    expect(snapshot.packagingFee).toBe(20);
    expect(snapshot.packagingUsedFallback).toBe(false);
  });

  it("matches the engine's branch fallback when the Petpooja contract is unusable", async () => {
    const items = [line("prod_fries")];
    const engine = await calculateOrderPricing({
      items,
      branchId: "b_unusable",
      orderType: "takeaway",
    });
    const snapshot = computeSnapshotPricing(
      snapshotInput(items, { branchConfig: branchConfig("b_unusable") })
    );

    expect(money(snapshot)).toEqual(money(engine));
    expect(snapshot.packagingFee).toBe(12);
    // The seam reports the fallback so the caller can log AFTER commit; it
    // never logs itself.
    expect(snapshot.packagingUsedFallback).toBe(true);
  });

  it("keeps CGST + SGST equal to GST and the split reconciled in paise", () => {
    const snapshot = computeSnapshotPricing(
      snapshotInput([line("prod_bigbang", { quantity: 3 })])
    );

    expect(snapshot.cgst + snapshot.sgst).toBeCloseTo(snapshot.gst, 10);
    expect(Math.round(snapshot.cgst * 100) + Math.round(snapshot.sgst * 100)).toBe(
      Math.round(snapshot.gst * 100)
    );
    expect(snapshot.split.totalAmountPaise).toBe(
      Math.round(snapshot.grandTotal * 100)
    );
    expect(snapshot.split.courierFeePaise).toBe(0);
    expect(snapshot.split.branchTransferPaise).toBe(
      snapshot.split.totalAmountPaise
    );
    for (const value of [
      snapshot.foodSubtotal,
      snapshot.packagingFee,
      snapshot.deliveryFee,
      snapshot.gst,
      snapshot.discount,
      snapshot.loyaltyDiscount,
      snapshot.grandTotal,
    ]) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
    }
  });

  it("honours a server-locked packaging fee (R7) over branch config", () => {
    const snapshot = computeSnapshotPricing(
      snapshotInput([line("prod_fries")], {
        branchConfig: branchConfig("b_petpooja"),
        packagingFeeOverride: 7,
      })
    );
    expect(snapshot.packagingFee).toBe(7);
  });

  it("does not add fields the live engine does not return", async () => {
    const engine = await calculateOrderPricing({
      items: [line("prod_hero")],
      branchId: "b1",
      orderType: "takeaway",
    });
    expect("packagingUsedFallback" in engine).toBe(false);
  });
});

describe("snapshot pricing — availability and catalogue truth", () => {
  it("refuses an explicitly 86'd product with 409 ITEM_UNAVAILABLE", () => {
    const err = capture(() =>
      computeSnapshotPricing(snapshotInput([line("prod_soldout")]))
    );
    expect(err.statusCode).toBe(409);
    expect(err.code).toBe("ITEM_UNAVAILABLE");
  });

  it("refuses a product with no availability field (only explicit true sells)", () => {
    const err = capture(() =>
      computeSnapshotPricing(snapshotInput([line("prod_legacy")]))
    );
    expect(err.statusCode).toBe(409);
    expect(err.code).toBe("ITEM_UNAVAILABLE");
  });

  it("refuses a product missing from the snapshot with 409 ITEM_PRICE_UNVERIFIED", () => {
    const err = capture(() =>
      computeSnapshotPricing({
        ...snapshotInput([line("prod_hero")]),
        products: productsOf(["prod_ghost"]),
      })
    );
    expect(err.statusCode).toBe(409);
    expect(err.code).toBe("ITEM_PRICE_UNVERIFIED");
  });

  it("refuses non-finite or negative catalogue prices instead of pricing NaN", () => {
    for (const productId of ["prod_nan", "prod_inf", "prod_neg"]) {
      // The LINE price is valid; the SNAPSHOT price is corrupt — the only
      // number that matters must be refused, never coerced into a NaN total.
      const err = capture(() =>
        computeSnapshotPricing({
          ...snapshotInput([line(productId, { price: 100 })]),
          products: new Map([
            [productId, { price: CATALOG[productId].price, inStock: true }],
          ]),
        })
      );
      expect(err.statusCode, productId).toBe(409);
      expect(err.code, productId).toBe("ITEM_PRICE_UNVERIFIED");
    }
  });

  it("rejects malformed line items with 400 instead of coercing them", () => {
    const zeroQty = capture(() =>
      computeSnapshotPricing(
        snapshotInput([line("prod_fries", { quantity: 0 })])
      )
    );
    expect(zeroQty.statusCode).toBe(400);

    const textPrice = capture(() =>
      computeSnapshotPricing(
        snapshotInput([line("prod_fries", { price: "abc" as any })])
      )
    );
    expect(textPrice.statusCode).toBe(400);
  });

  it("refuses an empty basket", () => {
    const err = capture(() =>
      computeSnapshotPricing({ ...snapshotInput([]), items: [] })
    );
    expect(err.statusCode).toBe(400);
  });
});

describe("snapshot pricing — branch config is mandatory and validated", () => {
  it("refuses a missing branch snapshot with 422 BRANCH_CONFIG_REQUIRED", () => {
    const err = capture(() =>
      computeSnapshotPricing(
        snapshotInput([line("prod_hero")], { branchConfig: null })
      )
    );
    expect(err.statusCode).toBe(422);
    expect(err.code).toBe("BRANCH_CONFIG_REQUIRED");
  });

  it("refuses a corrupt branch snapshot with 422 BRANCH_CONFIG_INVALID", () => {
    for (const branchConfigValue of [
      { ...DEFAULT_CONFIG, packagingFee: NaN },
      { ...DEFAULT_CONFIG, packagingFee: -1 },
      { ...DEFAULT_CONFIG, branchPackagingFee: Infinity },
      { ...DEFAULT_CONFIG, branchPackagingFee: -2 },
    ]) {
      const err = capture(() =>
        computeSnapshotPricing(
          snapshotInput([line("prod_hero")], {
            branchConfig: branchConfigValue,
          })
        )
      );
      expect(err.statusCode).toBe(422);
      expect(err.code).toBe("BRANCH_CONFIG_INVALID");
    }
  });

  it("refuses a corrupt packaging override with 422 PACKAGING_FEE_INVALID", () => {
    const err = capture(() =>
      computeSnapshotPricing(
        snapshotInput([line("prod_hero")], { packagingFeeOverride: NaN })
      )
    );
    expect(err.statusCode).toBe(422);
    expect(err.code).toBe("PACKAGING_FEE_INVALID");
  });

  it("refuses a delivery without its server courier quote", () => {
    const err = capture(() =>
      computeSnapshotPricing(
        snapshotInput([line("prod_hero")], { orderType: "delivery" })
      )
    );
    expect(err.statusCode).toBe(422);
    expect(err.code).toBe("DELIVERY_FEE_REQUIRED");
  });

  it("refuses an unknown order type", () => {
    const err = capture(() =>
      computeSnapshotPricing(
        snapshotInput([line("prod_hero")], { orderType: "pickup" })
      )
    );
    expect(err.statusCode).toBe(422);
    expect(err.code).toBe("ORDER_TYPE_UNSUPPORTED");
  });
});

describe("snapshot pricing — no I/O, no logging", () => {
  it("performs no reads, writes, or packaging warnings", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const snapshot = computeSnapshotPricing(
        snapshotInput([line("prod_hero")], {
          branchConfig: branchConfig("b_unusable"),
        })
      );
      expect(snapshot.packagingUsedFallback).toBe(true);
      expect(io.productReads).toBe(0);
      expect(io.branchReads).toBe(0);
      expect(io.couponReads).toBe(0);
      expect(io.writes).toBe(0);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
