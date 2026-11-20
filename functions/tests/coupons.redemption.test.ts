import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Coupon REDEMPTION: the slot a checkout holds, and the three ways it is
 * returned.
 *
 * The audit's failure mode (§1.6) was a discount the charging server never saw.
 * The mirror-image risk is a coupon that can be used twice: a cap checked but
 * not HELD lets two concurrent checkouts both read "one left" and both pay a
 * discounted total. These tests pin the atomic behaviour against a transactional
 * fake that detects read/write conflicts exactly like Firestore does.
 */

const { store } = vi.hoisted(() => ({ store: new Map<string, any>() }));
const { NOW } = vi.hoisted(() => ({ NOW: Date.parse("2026-11-20T12:00:00Z") }));

const DELETE = Symbol("field-delete");

function isDeleteSentinel(value: any): boolean {
  return (
    value === DELETE ||
    (value && typeof value === "object" && value.__fieldDelete === true)
  );
}

/** Firestore-faithful merge: nested maps merge, a delete sentinel removes. */
function deepMerge(target: any, patch: any): any {
  const base =
    target && typeof target === "object" && !Array.isArray(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (isDeleteSentinel(value)) {
      delete base[key];
    } else if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      base[key] &&
      typeof base[key] === "object" &&
      !Array.isArray(base[key])
    ) {
      base[key] = deepMerge(base[key], value);
    } else {
      base[key] = value;
    }
  }
  return base;
}

vi.mock("../src/core/firebase", () => {
  const adminFieldValue = {
    serverTimestamp: () => "SERVER_TS",
    delete: () => DELETE,
    increment: (n: number) => n,
  };
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
        store.set(
          path,
          opts?.merge
            ? deepMerge(store.get(path), data)
            : JSON.parse(JSON.stringify(data))
        );
      },
      update: async (data: any) => store.set(path, deepMerge(store.get(path), data)),
      create: async (data: any) => {
        if (store.has(path)) {
          const err: any = new Error("ALREADY_EXISTS");
          err.code = 6;
          throw err;
        }
        store.set(path, JSON.parse(JSON.stringify(data)));
      },
    };
  };
  const db: any = {
    collection: (col: string) => {
      const filters: Array<[string, any]> = [];
      const q: any = {
        where: (field: string, _op: string, value: any) => {
          filters.push([field, value]);
          return q;
        },
        limit: () => q,
        doc: (id: string) => docRef(col, id),
        get: async () => {
          const docs = [...store.entries()]
            .filter(([p]) => p.startsWith(`${col}/`))
            .filter(([, d]) => filters.every(([f, v]) => d?.[f] === v))
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
      for (let attempt = 0; attempt < 10; attempt++) {
        const reads = new Map<string, string>();
        const writes: Array<{ path: string; data: any; merge: boolean }> = [];
        const result = await fn({
          get: async (ref: any) => {
            reads.set(ref.path, JSON.stringify(store.get(ref.path) ?? null));
            return {
              exists: store.has(ref.path),
              data: () =>
                store.has(ref.path) ? JSON.parse(JSON.stringify(store.get(ref.path))) : undefined,
              ref,
            };
          },
          set: (ref: any, data: any, opts?: any) =>
            writes.push({ path: ref.path, data, merge: !!opts?.merge }),
          update: (ref: any, data: any) => writes.push({ path: ref.path, data, merge: true }),
        });
        const conflicted = [...reads.entries()].some(
          ([p, v]) => JSON.stringify(store.get(p) ?? null) !== v
        );
        if (conflicted) continue;
        for (const w of writes) {
          store.set(w.path, w.merge ? deepMerge(store.get(w.path), w.data) : JSON.parse(JSON.stringify(w.data)));
        }
        return result;
      }
      const err: any = new Error("ABORTED");
      err.code = 10;
      throw err;
    },
  };
  const admin = { firestore: Object.assign(() => db, { FieldValue: adminFieldValue }) };
  return { db, admin };
});

// `couponAuthority` and `cancelSideEffects` take `FieldValue` from the
// firebase-admin package directly (the production code path), so the delete
// sentinel must come from the same place the fake understands.
vi.mock("firebase-admin", () => {
  const FieldValue = {
    serverTimestamp: () => "SERVER_TS",
    delete: () => DELETE,
    increment: (n: number) => n,
  };
  const firestoreFn: any = () => ({ collection: () => ({ doc: () => ({}) }) });
  firestoreFn.FieldValue = FieldValue;
  return {
    default: {
      firestore: firestoreFn,
      auth: () => ({}),
      messaging: () => ({}),
      initializeApp: () => undefined,
      apps: [{}],
      credential: { cert: () => ({}) },
    },
    firestore: firestoreFn,
    auth: () => ({}),
    messaging: () => ({}),
    initializeApp: () => undefined,
    apps: [{}],
  };
});

import {
  COUPON_RESERVATION_TTL_MS,
  commitCouponRedemption,
  readCouponRedemption,
  releaseCouponRedemption,
  reserveCoupon,
  couponStatsRef,
} from "../src/modules/coupons/couponAuthority";
import { applyCancelSideEffects } from "../src/modules/orders/cancelSideEffects";

function seedCoupon(code: string, overrides: Record<string, any> = {}) {
  store.set(`coupons/${code}`, {
    code,
    active: true,
    discountType: "flat",
    value: 50,
    minOrder: 0,
    branchScope: "all",
    ...overrides,
  });
}

function reserve(orderId: string, customerId: string, code = "SAVE50", extra: any = {}) {
  return reserveCoupon({
    code,
    orderId,
    customerId,
    branchId: "branch_1",
    foodSubtotal: 500,
    expectedDiscount: 50,
    nowMs: NOW,
    ...extra,
  });
}

beforeEach(() => {
  store.clear();
});

describe("reserveCouponInTx", () => {
  it("holds a slot and records the redemption against the order", async () => {
    seedCoupon("SAVE50", { totalCap: 10 });
    const reservation = await reserve("order_1", "uid_a");
    expect(reservation.status).toBe("reserved");
    expect(reservation.discount).toBe(50);

    const stored = await readCouponRedemption("order_1");
    expect(stored?.code).toBe("SAVE50");
    expect(stored?.status).toBe("reserved");
  });

  it("refuses an expired coupon before any slot is written", async () => {
    seedCoupon("SAVE50", { validToMs: NOW - 1000 });
    await expect(reserve("order_1", "uid_a")).rejects.toMatchObject({
      code: "COUPON_EXPIRED",
      statusCode: 400,
    });
    expect(await readCouponRedemption("order_1")).toBeNull();
  });

  it("refuses below the minimum order", async () => {
    seedCoupon("SAVE50", { minOrder: 900 });
    await expect(reserve("order_1", "uid_a")).rejects.toMatchObject({
      code: "MIN_ORDER_NOT_MET",
    });
  });

  it("refuses a coupon that is not valid at this branch", async () => {
    seedCoupon("SAVE50", { branchScope: ["branch_other"] });
    await expect(reserve("order_1", "uid_a")).rejects.toMatchObject({
      code: "COUPON_BRANCH_MISMATCH",
    });
  });

  it("refuses once the total cap is used", async () => {
    seedCoupon("SAVE50", { totalCap: 1 });
    await reserve("order_1", "uid_a");
    await expect(reserve("order_2", "uid_b")).rejects.toMatchObject({
      code: "COUPON_EXHAUSTED",
    });
  });

  it("refuses a second use by the same customer at the per-customer limit", async () => {
    seedCoupon("SAVE50", { perCustomerLimit: 1 });
    await reserve("order_1", "uid_a");
    await expect(reserve("order_2", "uid_a")).rejects.toMatchObject({
      code: "COUPON_PER_CUSTOMER_LIMIT",
    });
    // A different customer is unaffected.
    await expect(reserve("order_3", "uid_b")).resolves.toBeTruthy();
  });

  it("refuses when the priced discount no longer matches the coupon", async () => {
    seedCoupon("SAVE50", { value: 80 });
    await expect(reserve("order_1", "uid_a")).rejects.toMatchObject({
      code: "COUPON_PRICE_CHANGED",
      statusCode: 409,
    });
  });

  it("is idempotent for a retry of the same order", async () => {
    seedCoupon("SAVE50", { totalCap: 2 });
    const first = await reserve("order_1", "uid_a");
    const second = await reserve("order_1", "uid_a");
    expect(second.reservedAtMs).toBe(first.reservedAtMs);
    const stats = store.get("coupon_stats/SAVE50");
    expect(Object.keys(stats.reservations)).toHaveLength(1);
  });

  it("lets exactly ONE of two concurrent checkouts take the last slot", async () => {
    seedCoupon("SAVE50", { totalCap: 1 });
    const results = await Promise.allSettled([
      reserve("order_a", "uid_a"),
      reserve("order_b", "uid_b"),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: "COUPON_EXHAUSTED",
    });
    // And only one redemption exists — the loser wrote nothing.
    const redemptions = [...store.keys()].filter((p) => p.startsWith("coupon_redemptions/"));
    expect(redemptions).toHaveLength(1);
  });

  it("lets exactly ONE of two concurrent same-customer checkouts past a limit of one", async () => {
    seedCoupon("SAVE50", { perCustomerLimit: 1 });
    const results = await Promise.allSettled([
      reserve("order_a", "uid_same"),
      reserve("order_b", "uid_same"),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  });
});

describe("release and commit", () => {
  it("releases a held slot so the next customer can use it", async () => {
    seedCoupon("SAVE50", { totalCap: 1 });
    await reserve("order_1", "uid_a");
    const released = await releaseCouponRedemption({
      orderId: "order_1",
      reason: "order_cancelled",
    });
    expect(released.released).toBe(true);
    await expect(reserve("order_2", "uid_b")).resolves.toBeTruthy();
  });

  it("is idempotent: releasing twice does not free two slots", async () => {
    seedCoupon("SAVE50", { totalCap: 1 });
    await reserve("order_1", "uid_a");
    await releaseCouponRedemption({ orderId: "order_1", reason: "order_cancelled" });
    const again = await releaseCouponRedemption({
      orderId: "order_1",
      reason: "order_cancelled",
    });
    expect(again.released).toBe(false);
    await reserve("order_2", "uid_b");
    await expect(reserve("order_3", "uid_c")).rejects.toMatchObject({
      code: "COUPON_EXHAUSTED",
    });
  });

  it("is a no-op for an order that never had a coupon", async () => {
    const result = await releaseCouponRedemption({
      orderId: "order_none",
      reason: "payment_failed",
    });
    expect(result.released).toBe(false);
  });

  it("commits a paid redemption once, and keeps the cap consumed", async () => {
    seedCoupon("SAVE50", { totalCap: 1 });
    await reserve("order_1", "uid_a");
    expect(await commitCouponRedemption("order_1")).toBe("committed");
    expect(await commitCouponRedemption("order_1")).toBe("noop");
    const stored = await readCouponRedemption("order_1");
    expect(stored?.status).toBe("committed");
    const stats = store.get("coupon_stats/SAVE50");
    expect(stats.committed).toBe(1);
    expect(Object.keys(stats.reservations ?? {})).toHaveLength(0);
    await expect(reserve("order_2", "uid_b")).rejects.toMatchObject({
      code: "COUPON_EXHAUSTED",
    });
  });

  it("a cancellation AFTER payment returns the slot (cancel before preparation)", async () => {
    seedCoupon("SAVE50", { totalCap: 1 });
    await reserve("order_1", "uid_a");
    await commitCouponRedemption("order_1");
    const released = await releaseCouponRedemption({
      orderId: "order_1",
      reason: "order_cancelled",
    });
    expect(released.released).toBe(true);
    expect(store.get("coupon_stats/SAVE50").committed).toBe(0);
    await expect(reserve("order_2", "uid_b")).resolves.toBeTruthy();
  });

  it("ages out an abandoned reservation so a dead checkout cannot burn the cap", async () => {
    seedCoupon("SAVE50", { totalCap: 1 });
    await reserve("order_1", "uid_a");
    // Simulate a checkout that died: the reservation is past its TTL.
    const stats = store.get("coupon_stats/SAVE50");
    const key = Object.keys(stats.reservations)[0];
    store.set("coupon_stats/SAVE50", {
      ...stats,
      reservations: {
        [key]: { expiresAtMs: NOW - COUPON_RESERVATION_TTL_MS - 1 },
      },
    });
    await expect(
      reserveCoupon({
        code: "SAVE50",
        orderId: "order_2",
        customerId: "uid_b",
        branchId: "branch_1",
        foodSubtotal: 500,
        expectedDiscount: 50,
        nowMs: NOW,
      })
    ).resolves.toBeTruthy();
  });
});

describe("cancellation returns the coupon", () => {
  it("applyCancelSideEffects releases the redemption", async () => {
    seedCoupon("SAVE50", { totalCap: 5 });
    await reserve("order_cancel", "uid_a");
    const result = await applyCancelSideEffects({
      orderId: "order_cancel",
      requestedBy: "customer:uid_a",
      reason: "order_cancelled",
    });
    expect(result.couponReleased).toBe("released");
    expect((await readCouponRedemption("order_cancel"))?.status).toBe("released");
  });

  it("reports noop for an order with no coupon", async () => {
    const result = await applyCancelSideEffects({
      orderId: "order_plain",
      requestedBy: "customer:uid_a",
      reason: "order_cancelled",
    });
    expect(result.couponReleased).toBe("noop");
  });
});

void couponStatsRef;
