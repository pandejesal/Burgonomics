import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The coupon authority's ELIGIBILITY and DISCOUNT rules, and the proof that the
 * pricing engine uses them.
 *
 * Audit 2026-11-20 §1.6: the customer app previewed discounts from
 * `petpooja_offers` (a collection nothing writes) while the charging server read
 * `coupons`. These tests pin the single authority: every rule below is decided
 * by `evaluateCoupon`, and `calculateOrderPricing` charges exactly what it says.
 */

const { store } = vi.hoisted(() => {
  const store = new Map<string, any>();
  return { store };
});

vi.mock("../src/core/firebase", () => {
  const docRef = (col: string, id: string) => {
    const path = `${col}/${id}`;
    return {
      id,
      path,
      get: async () => ({
        exists: store.has(path),
        data: () => (store.has(path) ? JSON.parse(JSON.stringify(store.get(path))) : undefined),
      }),
      set: async (data: any, opts?: any) => {
        const existing = store.get(path);
        store.set(
          path,
          opts?.merge && existing && typeof existing === "object"
            ? { ...existing, ...data }
            : { ...data }
        );
      },
      update: async (data: any) => store.set(path, { ...(store.get(path) ?? {}), ...data }),
      create: async (data: any) => store.set(path, { ...data }),
    };
  };
  const db: any = {
    collection: (col: string) => {
      const q: any = {
        where: () => q,
        limit: () => q,
        doc: (id: string) => docRef(col, id),
        get: async () => {
          const docs = [...store.entries()]
            .filter(([p]) => p.startsWith(`${col}/`))
            .map(([p, d]) => ({
              id: p.slice(col.length + 1),
              data: () => JSON.parse(JSON.stringify(d)),
            }));
          return { empty: docs.length === 0, docs };
        },
      };
      return q;
    },
    runTransaction: async (fn: any) => {
      const writes: Array<() => void> = [];
      const result = await fn({
        get: async (ref: any) => ref.get(),
        set: (ref: any, data: any, opts?: any) => {
          writes.push(() => {
            const existing = store.get(ref.path);
            store.set(
              ref.path,
              opts?.merge && existing && typeof existing === "object"
                ? { ...existing, ...data }
                : { ...data }
            );
          });
        },
        update: (ref: any, data: any) =>
          writes.push(() => store.set(ref.path, { ...(store.get(ref.path) ?? {}), ...data })),
      });
      writes.forEach((w) => w());
      return result;
    },
  };
  return { db, admin: { firestore: () => db } };
});

import {
  COUPON_REFUSAL_CODES,
  evaluateCoupon,
  isCouponRefusal,
  normalizeCoupon,
  quoteCoupon,
  type Coupon,
} from "../src/modules/coupons/couponAuthority";
import { calculateOrderPricing } from "../src/modules/payments/pricing.engine";

const NOW = Date.parse("2026-11-20T12:00:00Z");
const BRANCH = "branch_ahmedabad";

function coupon(overrides: Partial<Coupon> = {}): Coupon {
  return {
    code: "SAVE10",
    active: true,
    discountType: "percent",
    value: 10,
    maxDiscount: null,
    minOrder: 0,
    validFromMs: null,
    validToMs: null,
    perCustomerLimit: null,
    totalCap: null,
    branchScope: "all",
    customerScope: null,
    title: "Save 10%",
    createdBy: "staff_1",
    createdAtMs: NOW - 1000,
    ...overrides,
  };
}

function seedCoupon(code: string, doc: Record<string, any>) {
  store.set(`coupons/${code}`, doc);
}

function seedCatalog() {
  store.set("products/burger", { price: 200, inStock: true });
  store.set("products/fries", { price: 100, inStock: true });
  store.set("branches/" + BRANCH, { packagingFee: 15, monthlyFee: 2500 });
}

beforeEach(() => {
  store.clear();
  seedCatalog();
});

describe("evaluateCoupon — the one formula", () => {
  it("applies a percentage discount", () => {
    const result = evaluateCoupon(coupon(), { foodSubtotal: 500, branchId: BRANCH, nowMs: NOW });
    expect(result.eligible).toBe(true);
    expect(result.discount).toBe(50);
  });

  it("honours maxDiscount on a percentage coupon", () => {
    const result = evaluateCoupon(coupon({ maxDiscount: 40 }), {
      foodSubtotal: 500,
      branchId: BRANCH,
      nowMs: NOW,
    });
    expect(result.discount).toBe(40);
  });

  it("applies a flat discount but never more than the bill", () => {
    const result = evaluateCoupon(
      coupon({ discountType: "flat", value: 150 }),
      { foodSubtotal: 100, branchId: BRANCH, nowMs: NOW }
    );
    expect(result.discount).toBe(100);
  });

  it("refuses an expired coupon", () => {
    const result = evaluateCoupon(coupon({ validToMs: NOW - 1 }), {
      foodSubtotal: 500,
      branchId: BRANCH,
      nowMs: NOW,
    });
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe("COUPON_EXPIRED");
    expect(result.discount).toBe(0);
  });

  it("refuses a coupon that has not started", () => {
    const result = evaluateCoupon(coupon({ validFromMs: NOW + 60_000 }), {
      foodSubtotal: 500,
      branchId: BRANCH,
      nowMs: NOW,
    });
    expect(result.reason).toBe("COUPON_NOT_STARTED");
  });

  it("treats the validity window as inclusive at both ends", () => {
    const atEnd = evaluateCoupon(coupon({ validToMs: NOW }), {
      foodSubtotal: 500,
      branchId: BRANCH,
      nowMs: NOW,
    });
    expect(atEnd.eligible).toBe(true);
  });

  it("refuses an inactive coupon", () => {
    const result = evaluateCoupon(coupon({ active: false }), {
      foodSubtotal: 500,
      branchId: BRANCH,
      nowMs: NOW,
    });
    expect(result.reason).toBe("COUPON_INACTIVE");
  });

  it("refuses below the minimum order and names the shortfall", () => {
    const result = evaluateCoupon(coupon({ minOrder: 400 }), {
      foodSubtotal: 300,
      branchId: BRANCH,
      nowMs: NOW,
    });
    expect(result.reason).toBe("MIN_ORDER_NOT_MET");
    expect(result.message).toContain("100");
  });

  it("refuses a coupon scoped to other branches", () => {
    const result = evaluateCoupon(coupon({ branchScope: ["branch_surat"] }), {
      foodSubtotal: 500,
      branchId: BRANCH,
      nowMs: NOW,
    });
    expect(result.reason).toBe("COUPON_BRANCH_MISMATCH");
  });

  it("allows a coupon scoped to this branch", () => {
    const result = evaluateCoupon(coupon({ branchScope: [BRANCH] }), {
      foodSubtotal: 500,
      branchId: BRANCH,
      nowMs: NOW,
    });
    expect(result.eligible).toBe(true);
  });

  it("refuses a coupon issued to a different customer", () => {
    const result = evaluateCoupon(coupon({ customerScope: "uid_a" }), {
      foodSubtotal: 500,
      branchId: BRANCH,
      customerId: "uid_b",
      nowMs: NOW,
    });
    expect(result.reason).toBe("COUPON_CUSTOMER_MISMATCH");
  });

  it("refuses once the per-customer limit is reached", () => {
    const result = evaluateCoupon(coupon({ perCustomerLimit: 1 }), {
      foodSubtotal: 500,
      branchId: BRANCH,
      customerId: "uid_a",
      customerUsed: 1,
      nowMs: NOW,
    });
    expect(result.reason).toBe("COUPON_PER_CUSTOMER_LIMIT");
  });

  it("refuses a per-customer-limited coupon to a guest, who has no identity", () => {
    const result = evaluateCoupon(coupon({ perCustomerLimit: 1 }), {
      foodSubtotal: 500,
      branchId: BRANCH,
      customerId: null,
      nowMs: NOW,
    });
    expect(result.reason).toBe("COUPON_SIGN_IN_REQUIRED");
  });

  it("refuses once the total cap is reached", () => {
    const result = evaluateCoupon(coupon({ totalCap: 5 }), {
      foodSubtotal: 500,
      branchId: BRANCH,
      totalUsed: 5,
      nowMs: NOW,
    });
    expect(result.reason).toBe("COUPON_EXHAUSTED");
  });

  it("clamps a corrupt >100% coupon instead of negating the bill", () => {
    const result = evaluateCoupon(coupon({ value: 150 }), {
      foodSubtotal: 500,
      branchId: BRANCH,
      nowMs: NOW,
    });
    expect(result.discount).toBe(500);
  });

  it("never returns a negative discount for a corrupt document", () => {
    const result = evaluateCoupon(coupon({ value: -20 }), {
      foodSubtotal: 500,
      branchId: BRANCH,
      nowMs: NOW,
    });
    expect(result.discount).toBe(0);
  });
});

describe("normalizeCoupon — legacy documents keep working", () => {
  it("reads the pre-2026-11-20 shape", () => {
    const normalized = normalizeCoupon("welcome50", {
      discount: 50,
      type: "flat",
      active: true,
      expiresAt: new Date(NOW + 1000).toISOString(),
      min_order: 199,
      branchId: BRANCH,
    });
    expect(normalized).not.toBeNull();
    expect(normalized!.code).toBe("WELCOME50");
    expect(normalized!.discountType).toBe("flat");
    expect(normalized!.value).toBe(50);
    expect(normalized!.minOrder).toBe(199);
    expect(normalized!.branchScope).toEqual([BRANCH]);
  });

  it("returns null for a document with no usable value", () => {
    expect(normalizeCoupon("BROKEN", { active: true, title: "no value" })).toBeNull();
    expect(normalizeCoupon("ZERO", { value: 0, type: "percent" })).toBeNull();
  });
});

describe("calculateOrderPricing uses the authority", () => {
  const items = [
    { id: "burger", productId: "burger", name: "Burger", price: 200, quantity: 2 },
  ];

  it("charges the authority's discount, not the client's number", async () => {
    seedCoupon("SAVE10", {
      code: "SAVE10",
      active: true,
      discountType: "percent",
      value: 10,
      minOrder: 0,
      branchScope: "all",
    });
    const pricing = await calculateOrderPricing({
      items,
      branchId: BRANCH,
      orderType: "takeaway",
      couponCode: "save10",
    });
    expect(pricing.foodSubtotal).toBe(400);
    expect(pricing.discount).toBe(40);
    expect(pricing.grandTotal).toBe(400 - 40 + pricing.packagingFee);
  });

  it("applies NO discount for an expired coupon", async () => {
    seedCoupon("OLD", {
      code: "OLD",
      active: true,
      discountType: "flat",
      value: 100,
      // Absolute past instant: pricing uses the real clock, not the test clock.
      validToMs: 1000,
    });
    const pricing = await calculateOrderPricing({
      items,
      branchId: BRANCH,
      orderType: "takeaway",
      couponCode: "OLD",
    });
    expect(pricing.discount).toBe(0);
  });

  it("applies NO discount when the branch is out of scope", async () => {
    seedCoupon("SURATONLY", {
      code: "SURATONLY",
      active: true,
      discountType: "flat",
      value: 100,
      branchScope: ["branch_surat"],
    });
    const pricing = await calculateOrderPricing({
      items,
      branchId: BRANCH,
      orderType: "takeaway",
      couponCode: "SURATONLY",
    });
    expect(pricing.discount).toBe(0);
  });

  it("applies NO discount below the minimum order", async () => {
    seedCoupon("BIG", {
      code: "BIG",
      active: true,
      discountType: "flat",
      value: 100,
      minOrder: 1000,
    });
    const pricing = await calculateOrderPricing({
      items,
      branchId: BRANCH,
      orderType: "takeaway",
      couponCode: "BIG",
    });
    expect(pricing.discount).toBe(0);
  });

  it("applies NO discount when the coupon is inactive", async () => {
    seedCoupon("OFF", {
      code: "OFF",
      active: false,
      discountType: "flat",
      value: 100,
    });
    const pricing = await calculateOrderPricing({
      items,
      branchId: BRANCH,
      orderType: "takeaway",
      couponCode: "OFF",
    });
    expect(pricing.discount).toBe(0);
  });
});

describe("quoteCoupon — the customer app's only preview", () => {
  it("reports the server discount and the items total after it", async () => {
    seedCoupon("SAVE10", {
      code: "SAVE10",
      active: true,
      discountType: "percent",
      value: 10,
      minOrder: 0,
    });
    const quote = await quoteCoupon({
      code: "save10",
      foodSubtotal: 400,
      branchId: BRANCH,
      customerId: "uid_a",
      nowMs: NOW,
    });
    expect(quote.eligible).toBe(true);
    expect(quote.discount).toBe(40);
    expect(quote.totalAfterDiscount).toBe(360);
    expect(quote.message).toBeTruthy();
  });

  it("reports the per-customer limit from the usage counter", async () => {
    seedCoupon("ONCE", {
      code: "ONCE",
      active: true,
      discountType: "flat",
      value: 50,
      perCustomerLimit: 1,
    });
    store.set("coupon_customer_usage/ONCE__uid_a", {
      code: "ONCE",
      committed: 1,
      reservations: {},
    });
    const quote = await quoteCoupon({
      code: "ONCE",
      foodSubtotal: 400,
      customerId: "uid_a",
      nowMs: NOW,
    });
    expect(quote.eligible).toBe(false);
    expect(quote.reason).toBe("COUPON_PER_CUSTOMER_LIMIT");
  });

  it("reports an unknown code as invalid, never as free", async () => {
    const quote = await quoteCoupon({ code: "NOPE", foodSubtotal: 400, nowMs: NOW });
    expect(quote.eligible).toBe(false);
    expect(quote.reason).toBe("COUPON_INVALID");
    expect(quote.discount).toBe(0);
    expect(quote.totalAfterDiscount).toBe(400);
  });
});

describe("isCouponRefusal — a refusal is never reported as an outage", () => {
  // Review finding 2 (offers-coupons-20261120): `createPaymentOrder` guarded
  // refusals with `err.code.startsWith("COUPON_")`, so `MIN_ORDER_NOT_MET` fell
  // through and the customer was told "payment service is temporarily
  // unavailable" instead of "add ₹99 more". These pin the explicit set.

  const refuse = (code: string, statusCode = 400) => {
    const err: any = new Error(code);
    err.code = code;
    err.statusCode = statusCode;
    return err;
  };

  it("recognises every reason the customer can act on", () => {
    for (const code of [
      "COUPON_INVALID",
      "COUPON_INACTIVE",
      "COUPON_NOT_STARTED",
      "COUPON_EXPIRED",
      "MIN_ORDER_NOT_MET",
      "COUPON_BRANCH_MISMATCH",
      "COUPON_CUSTOMER_MISMATCH",
      "COUPON_PER_CUSTOMER_LIMIT",
      "COUPON_SIGN_IN_REQUIRED",
      "COUPON_EXHAUSTED",
      "COUPON_ORDER_CONFLICT",
      "COUPON_PRICE_CHANGED",
    ]) {
      expect(COUPON_REFUSAL_CODES.has(code)).toBe(true);
      expect(isCouponRefusal(refuse(code, code === "COUPON_ORDER_CONFLICT" ? 409 : 400))).toBe(
        true
      );
    }
  });

  it("treats a below-minimum basket as the customer's to fix", () => {
    // The regression: no `COUPON_` prefix, so the old prefix check missed it.
    expect(isCouponRefusal(refuse("MIN_ORDER_NOT_MET"))).toBe(true);
  });

  it("does NOT treat a datastore failure as a coupon refusal", () => {
    const crash = new Error("transaction aborted");
    expect(isCouponRefusal(crash)).toBe(false);
    const notFound: any = new Error("unavailable");
    notFound.code = "UNAVAILABLE";
    notFound.statusCode = 503;
    expect(isCouponRefusal(notFound)).toBe(false);
  });

  it("does NOT pass through a coupon code with a server-error status", () => {
    // A refusal must be 400/409; anything else is ours to fix and should be
    // reported as an outage, not blamed on the customer's coupon.
    expect(isCouponRefusal(refuse("COUPON_EXPIRED", 500))).toBe(false);
    expect(isCouponRefusal(refuse("COUPON_EXPIRED", 503))).toBe(false);
  });
});
