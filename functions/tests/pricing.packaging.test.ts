import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Part P pricing (owner decision 2026-11-01, P2 as corrected by the design
 * review): ONE documented rule — applicable-on ORDER with a blank charge type
 * gives the outlet's charge. Dine-in is 0. Everything else (ITEM, F, FIXED,
 * percentages, unknown values) is understood:false → fallback to the branch
 * value, then the ₹15 default, and a warning. No guessing.
 *
 * Required tests 23, 24, 25 (replaced: ITEM is not understood) and 26.
 */

const { savedDocs, mockDb } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  const docRef = (col: string, id: string): any => {
    const path = `${col}/${id}`;
    const ref: any = {
      id,
      path,
      get: async () => ({
        id,
        exists: Object.prototype.hasOwnProperty.call(savedDocs, path),
        data: () => savedDocs[path],
        ref,
      }),
      set: async (data: any, opts?: any) => {
        savedDocs[path] =
          opts?.merge && savedDocs[path] ? { ...savedDocs[path], ...data } : data;
      },
    };
    return ref;
  };
  const query = (col: string): any => {
    const q: any = {
      where: () => q,
      orderBy: () => q,
      limit: () => q,
      startAfter: () => q,
      get: async () => ({ empty: true, docs: [] }),
    };
    return q;
  };
  const mockDb: any = {
    collection: (col: string) => ({
      ...query(col),
      doc: (id?: string) => docRef(col, id as string),
      add: async (data: any) => {
        savedDocs[`${col}/added_${Object.keys(savedDocs).length}`] = data;
      },
    }),
    getAll: async (...refs: any[]) => Promise.all(refs.map((r: any) => r.get())),
    batch: () => ({ set: () => {}, commit: async () => {} }),
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

import {
  computePackagingFee,
  clearBranchPricingCache,
  resolvePackagingFeeSnapshot,
} from "../src/modules/payments/branchPricing";
import { calculateOrderPricing } from "../src/modules/payments/pricing.engine";
import { resolveCheckoutFees } from "../src/modules/payments/checkoutFees";
import { config } from "../src/config/env";

const BRANCH = "branch_demo";
const logs = () =>
  Object.keys(savedDocs)
    .filter((k) => k.startsWith("petpooja_sync_logs/"))
    .map((k) => savedDocs[k]);

const DOC_PACKAGING = {
  source: "petpooja",
  applicableOn: "ORDER",
  charge: 20,
  chargeType: "",
  taxOnPacking: 1,
  pcTaxIds: "11213,20375",
  understood: true,
  syncedAt: "MOCK_TIMESTAMP",
};

function seedBranch(packaging: any, extra: Record<string, any> = {}) {
  savedDocs[`branches/${BRANCH}`] = {
    petpoojaStoreId: "xxxxxx",
    coordinates: { lat: 23.0225, lng: 72.5714 },
    ...(packaging === undefined ? {} : { packaging }),
    ...extra,
  };
  clearBranchPricingCache();
}

function basket(orderType: "takeaway" | "delivery" | "dinein", extra: Record<string, any> = {}) {
  return {
    items: [{ id: "l1", productId: "prod_x", name: "Burger", price: 199, quantity: 1 }],
    branchId: BRANCH,
    orderType,
    ...extra,
  };
}

let prevMock: any;

beforeEach(() => {
  for (const key of Object.keys(savedDocs)) delete savedDocs[key];
  prevMock = { mock: { ...config.mock }, borzo: config.borzo.enabled, shadowfax: config.shadowfax.enabled, porter: config.porter.enabled };
  config.mock.borzoDispatch = true;
  config.mock.shadowfaxDispatch = false;
  config.borzo.enabled = true;
  config.shadowfax.enabled = false;
  config.porter.enabled = false;
  savedDocs["products/prod_x"] = { price: 199, inStock: true, packingCharge: null };
});

afterEach(() => {
  config.mock = { ...prevMock.mock };
  config.borzo.enabled = prevMock.borzo;
  config.shadowfax.enabled = prevMock.shadowfax;
  config.porter.enabled = prevMock.porter;
});

describe("P2 one documented packaging rule", () => {
  it("honours captured NONE as zero instead of the branch fallback, without warning", async () => {
    seedBranch({ ...DOC_PACKAGING, applicableOn: "NONE", charge: 0 }, { packagingFee: 12 });
    for (const orderType of ["takeaway", "delivery", "dinein"] as const) {
      expect(await computePackagingFee({ packaging: savedDocs[`branches/${BRANCH}`].packaging, branchFee: 12, orderType, branchId: BRANCH })).toBe(0);
    }
    expect(logs()).toHaveLength(0);
  });
  it("23: ORDER/20/\"\" prices 20 for takeaway, delivery and 0 for dine-in (engine)", async () => {
    seedBranch(DOC_PACKAGING);
    const takeaway = await calculateOrderPricing(basket("takeaway"));
    expect(takeaway.packagingFee).toBe(20);

    const delivery = await calculateOrderPricing(
      basket("delivery", { serverDeliveryFee: 35 })
    );
    expect(delivery.packagingFee).toBe(20);

    const dinein = await calculateOrderPricing(basket("dinein"));
    expect(dinein.packagingFee).toBe(0);
  });

  it("23: the fees endpoint returns the same values", async () => {
    seedBranch(DOC_PACKAGING);
    const takeaway = await resolveCheckoutFees({
      branchId: BRANCH,
      orderType: "takeaway",
      customerId: "uid_1",
    });
    expect(takeaway.packagingFee).toBe(20);

    const dinein = await resolveCheckoutFees({
      branchId: BRANCH,
      orderType: "dinein",
      customerId: "uid_1",
    });
    expect(dinein.packagingFee).toBe(0);

    const delivery = await resolveCheckoutFees({
      branchId: BRANCH,
      orderType: "delivery",
      dropLat: 23.0338,
      dropLng: 72.5262,
      customerId: "uid_1",
    });
    expect(delivery.packagingFee).toBe(20);
    expect(delivery.deliveryFee).toBeGreaterThan(0);
  });

  it("24: a charge of \"0\" is honoured as 0, not replaced by a default", async () => {
    seedBranch({ ...DOC_PACKAGING, charge: 0 });
    const engine = await calculateOrderPricing(basket("takeaway"));
    expect(engine.packagingFee).toBe(0);

    const endpoint = await resolveCheckoutFees({
      branchId: BRANCH,
      orderType: "takeaway",
      customerId: "uid_1",
    });
    expect(endpoint.packagingFee).toBe(0);
  });

  it("25 (replaced): ITEM is NOT understood — it falls back and warns", async () => {
    seedBranch({ ...DOC_PACKAGING, applicableOn: "ITEM", charge: 20, understood: false });
    const engine = await calculateOrderPricing(basket("takeaway"));
    // Fallback: no branch packagingFee set → documented default 15.
    expect(engine.packagingFee).toBe(15);
    expect(logs().length).toBeGreaterThan(0);
    expect(logs()[0].packagingRaw).toMatchObject({ applicable_on: "ITEM" });
  });

  it("26: unknown applicableOn + a percentage type fall back, log, and guess nothing", async () => {
    seedBranch(
      { ...DOC_PACKAGING, applicableOn: "CART", chargeType: "P", charge: 20, understood: false },
      { packagingFee: 12 }
    );
    const engine = await calculateOrderPricing(basket("takeaway"));
    expect(engine.packagingFee).toBe(12); // branch fallback, NOT 20 and not "20%"
    const log = logs().find((l) => l.packagingRaw?.applicable_on === "CART");
    expect(log).toBeTruthy();
    // The runtime log records the STORED values (the verbatim vendor strings
    // live on the P1 sync row); charge stays 20, the type stays "P" — nothing
    // was reinterpreted into money.
    expect(log.packagingRaw).toMatchObject({ charge_type: "P", charge: 20 });
    expect(log.status).toBe("PACKAGING_FALLBACK");
  });

  it("no Petpooja data: branch fee, then the 15 default (D8)", async () => {
    seedBranch(undefined, { packagingFee: 12 });
    const withBranchFee = await calculateOrderPricing(basket("takeaway"));
    expect(withBranchFee.packagingFee).toBe(12);

    seedBranch(undefined);
    const withDefault = await calculateOrderPricing(basket("takeaway"));
    expect(withDefault.packagingFee).toBe(15);
  });

  it("uses the branch fallback for a branch with no packaging at all, dining in 0", async () => {
    seedBranch({ ...DOC_PACKAGING, understood: false, applicableOn: "ITEM" }, { packagingFee: 12 });
    const fee = await computePackagingFee({
      packaging: { ...DOC_PACKAGING, understood: false, applicableOn: "ITEM" } as any,
      branchFee: 12,
      orderType: "takeaway",
      branchId: BRANCH,
    });
    expect(fee).toBe(12);
    expect(
      await computePackagingFee({
        packaging: { ...DOC_PACKAGING, understood: false, applicableOn: "ITEM" } as any,
        branchFee: 12,
        orderType: "dinein",
        branchId: BRANCH,
      })
    ).toBe(0);
  });
});

/**
 * `resolvePackagingFeeSnapshot` is the PURE half of `computePackagingFee`: the
 * same documented P2 decision with no logging, no Firestore and no cache.
 * `computePackagingFee` delegates to it, so these cases pin BOTH to one rule —
 * a future edit cannot make the transactional seam and the checkout engine
 * disagree about packaging.
 */
describe("P2 packaging decision — pure snapshot parity", () => {
  const chargeContract = (overrides: Record<string, any> = {}) => ({
    source: "petpooja",
    applicableOn: "ORDER",
    charge: 20,
    chargeType: "",
    taxOnPacking: 1,
    pcTaxIds: "11213,20375",
    understood: true,
    ...overrides,
  });

  const CASES: Array<{ name: string; input: any }> = [
    { name: "dine-in is always 0", input: { orderType: "dinein", packaging: chargeContract(), branchFee: 12 } },
    { name: "understood ORDER charge", input: { orderType: "takeaway", packaging: chargeContract(), branchFee: 12 } },
    { name: "understood ORDER zero charge", input: { orderType: "takeaway", packaging: chargeContract({ charge: 0 }), branchFee: 12 } },
    { name: "understood NONE disables packing", input: { orderType: "takeaway", packaging: chargeContract({ applicableOn: "NONE", charge: 0 }), branchFee: 12 } },
    { name: "string charge is coerced, not guessed", input: { orderType: "takeaway", packaging: chargeContract({ charge: "20" }), branchFee: 12 } },
    { name: "malformed ITEM falls back to the branch fee", input: { orderType: "takeaway", packaging: chargeContract({ applicableOn: "ITEM", understood: false }), branchFee: 12 } },
    { name: "malformed ITEM with no branch fee falls back to 15", input: { orderType: "takeaway", packaging: chargeContract({ applicableOn: "ITEM", understood: false }) } },
    { name: "percentage type falls back", input: { orderType: "takeaway", packaging: chargeContract({ applicableOn: "CART", chargeType: "P", understood: false }), branchFee: 12 } },
    { name: "non-finite charge falls back", input: { orderType: "takeaway", packaging: chargeContract({ charge: NaN }), branchFee: 12 } },
    { name: "negative charge falls back", input: { orderType: "takeaway", packaging: chargeContract({ charge: -5 }), branchFee: 12 } },
    { name: "missing metadata uses the branch fee", input: { orderType: "takeaway", packaging: null, branchFee: 12 } },
    { name: "missing metadata with no branch fee uses 15", input: { orderType: "takeaway", packaging: null } },
    { name: "non-finite branch fee uses 15", input: { orderType: "takeaway", packaging: null, branchFee: NaN } },
    { name: "negative branch fee uses 15", input: { orderType: "takeaway", packaging: null, branchFee: -1 } },
  ];

  it.each(CASES.map((c) => [c.name, c.input] as const))("%s", async (_name, input) => {
    const pure = resolvePackagingFeeSnapshot(input);
    const live = await computePackagingFee(input);
    expect(pure.fee).toBe(live);
    expect(Number.isFinite(pure.fee)).toBe(true);
    expect(pure.fee).toBeGreaterThanOrEqual(0);
  });

  it("flags usedFallback ONLY for an unusable Petpooja contract", () => {
    expect(resolvePackagingFeeSnapshot({ orderType: "dinein", packaging: chargeContract(), branchFee: 12 }).usedFallback).toBe(false);
    expect(resolvePackagingFeeSnapshot({ orderType: "takeaway", packaging: chargeContract(), branchFee: 12 }).usedFallback).toBe(false);
    expect(resolvePackagingFeeSnapshot({ orderType: "takeaway", packaging: chargeContract({ applicableOn: "NONE", charge: 0 }), branchFee: 12 }).usedFallback).toBe(false);
    expect(resolvePackagingFeeSnapshot({ orderType: "takeaway", packaging: null, branchFee: 12 }).usedFallback).toBe(false);
    expect(resolvePackagingFeeSnapshot({ orderType: "takeaway", packaging: chargeContract({ applicableOn: "ITEM", understood: false }), branchFee: 12 }).usedFallback).toBe(true);
    expect(resolvePackagingFeeSnapshot({ orderType: "takeaway", packaging: chargeContract({ charge: NaN }), branchFee: 12 }).usedFallback).toBe(true);
  });

  it("performs no write and no warning", () => {
    const before = logs().length;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const decision = resolvePackagingFeeSnapshot({
        orderType: "takeaway",
        packaging: chargeContract({ applicableOn: "ITEM", understood: false }),
        branchFee: 12,
        branchId: BRANCH,
      });
      expect(decision).toEqual({ fee: 12, usedFallback: true });
      expect(logs()).toHaveLength(before);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
