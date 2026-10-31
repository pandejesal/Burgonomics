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

import { computePackagingFee, clearBranchPricingCache } from "../src/modules/payments/branchPricing";
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
