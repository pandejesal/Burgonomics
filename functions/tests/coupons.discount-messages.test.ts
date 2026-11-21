import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * F1 (staging 2026-11-21, Test 8): flat coupons and percent coupons created
 * without a cap answered `valid: true`, `discount: 0`, "Coupon applied."
 *
 * Root cause: `createCoupon` writes an EXPLICIT `maxDiscount: null` for both
 * shapes, and the reader converted it with `positiveIntOrNull`, where
 * `Number(null) === 0` is finite — so the cap became 0 and every discount was
 * clamped to nothing. An ABSENT field behaved correctly, which is why this was
 * easy to miss.
 *
 * Rules pinned here:
 *   - a null (or absent) cap means "no cap",
 *   - a flat coupon applies its value, never more than the subtotal,
 *   - an uncapped percent coupon applies fully,
 *   - a capped percent coupon still honours its cap,
 *   - "Coupon applied." is returned ONLY when the discount is above zero;
 *     otherwise the customer gets a clear refusal instead of a lie.
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
        get: async () => ({ empty: true, docs: [] }),
      };
      return q;
    },
    runTransaction: async (fn: any) => fn({ get: async (ref: any) => ref.get(), set: () => {} }),
  };
  return { db, admin: { firestore: () => db } };
});

import {
  COUPON_MESSAGES,
  COUPON_REFUSAL_CODES,
  evaluateCoupon,
  normalizeCoupon,
  quoteCoupon,
} from "../src/modules/coupons/couponAuthority";

const BRANCH = "demo";

/** Exactly the shape `createCoupon` writes (see couponService.ts:129). */
function storedCoupon(over: Record<string, any> = {}) {
  return {
    code: "QAFLAT23563",
    active: true,
    discountType: "flat",
    value: 25,
    maxDiscount: null,
    minOrder: 0,
    validFromMs: null,
    validToMs: null,
    perCustomerLimit: null,
    totalCap: null,
    branchScope: "all",
    title: "Flat 25",
    ...over,
  };
}

function seed(code: string, doc: Record<string, any>) {
  store.set(`coupons/${code}`, { ...doc, code });
}

beforeEach(() => {
  store.clear();
  store.set("coupon_stats/QAFLAT23563", { committed: 0, reservations: {} });
  store.set("coupon_stats/QAPC11354", { committed: 0, reservations: {} });
  store.set("coupon_stats/QAPC11354C", { committed: 0, reservations: {} });
});

describe("F1 — an explicit null cap means NO cap", () => {
  it("reads a stored null maxDiscount as uncapped, not as zero", () => {
    const coupon = normalizeCoupon("QAFLAT23563", storedCoupon());
    expect(coupon).not.toBeNull();
    expect(coupon!.maxDiscount).toBeNull();
    // The same guard applies to the other nullable counters: a null limit is
    // "unlimited", never "nobody may redeem".
    const unlimited = normalizeCoupon("UNL", {
      active: true,
      discountType: "percent",
      value: 10,
      totalCap: null,
      perCustomerLimit: null,
    });
    expect(unlimited!.totalCap).toBeNull();
    expect(unlimited!.perCustomerLimit).toBeNull();
  });

  it("a flat ₹25 coupon takes ₹25 off a ₹109 bill (the staging probe)", async () => {
    seed("QAFLAT23563", storedCoupon());
    const quote = await quoteCoupon({
      code: "qaflat23563",
      foodSubtotal: 109,
      branchId: BRANCH,
      customerId: "cust_a",
    });
    expect(quote.eligible).toBe(true);
    expect(quote.discount).toBe(25);
    expect(quote.subtotal).toBe(109);
    expect(quote.totalAfterDiscount).toBe(84);
    expect(quote.message).toBe(COUPON_MESSAGES.OK);
    expect(quote.reason).toBe("OK");
  });

  it("a flat coupon never takes more than the bill", () => {
    const coupon = normalizeCoupon("BIG", storedCoupon({ value: 500 }))!;
    const result = evaluateCoupon(coupon, {
      foodSubtotal: 109,
      branchId: BRANCH,
      nowMs: Date.now(),
    });
    expect(result.eligible).toBe(true);
    expect(result.discount).toBe(109);
  });

  it("an uncapped 10% coupon applies fully on ₹109 (the staging probe)", async () => {
    seed("QAPC11354", storedCoupon({ code: "QAPC11354", discountType: "percent", value: 10 }));
    const quote = await quoteCoupon({
      code: "QAPC11354",
      foodSubtotal: 109,
      branchId: BRANCH,
      customerId: "cust_a",
    });
    expect(quote.eligible).toBe(true);
    expect(quote.discount).toBe(11);
    expect(quote.totalAfterDiscount).toBe(98);
    expect(quote.message).toBe(COUPON_MESSAGES.OK);
  });

  it("a capped 10% coupon still honours its cap (no regression)", async () => {
    seed(
      "QAPC11354C",
      storedCoupon({ code: "QAPC11354C", discountType: "percent", value: 10, maxDiscount: 200 })
    );
    const small = await quoteCoupon({
      code: "QAPC11354C",
      foodSubtotal: 109,
      branchId: BRANCH,
      customerId: "cust_a",
    });
    expect(small.discount).toBe(11);

    const large = await quoteCoupon({
      code: "QAPC11354C",
      foodSubtotal: 5000,
      branchId: BRANCH,
      customerId: "cust_a",
    });
    expect(large.discount).toBe(200);
  });
});

describe("F1 — 'Coupon applied.' only when money actually comes off", () => {
  it("refuses, with clear copy, when the computed discount rounds to zero", () => {
    // 1% of ₹40 is ₹0.40 → ₹0 off. The customer must not be told it applied.
    const coupon = normalizeCoupon("TINY", {
      active: true,
      discountType: "percent",
      value: 1,
      maxDiscount: null,
    })!;
    const result = evaluateCoupon(coupon, {
      foodSubtotal: 40,
      branchId: BRANCH,
      nowMs: Date.now(),
    });
    expect(result.eligible).toBe(false);
    expect(result.discount).toBe(0);
    expect(result.reason).not.toBe("OK");
    expect(result.message).not.toBe(COUPON_MESSAGES.OK);
    // A clear refusal, not a generic error.
    expect(result.message.length).toBeGreaterThan(20);
    expect(COUPON_REFUSAL_CODES.has(result.reason)).toBe(true);
  });

  it("keeps 'Coupon applied.' for a real discount", () => {
    const coupon = normalizeCoupon("TINY2", {
      active: true,
      discountType: "percent",
      value: 10,
      maxDiscount: null,
    })!;
    const result = evaluateCoupon(coupon, {
      foodSubtotal: 40,
      branchId: BRANCH,
      nowMs: Date.now(),
    });
    expect(result.eligible).toBe(true);
    expect(result.discount).toBe(4);
    expect(result.message).toBe(COUPON_MESSAGES.OK);
  });
});
