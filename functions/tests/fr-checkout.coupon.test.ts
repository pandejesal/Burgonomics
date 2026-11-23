import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * fr-checkout M2/M3: a coupon slot is bound to one payment intent, is never
 * released by a mere decline, and a cash sale commits its redemption + BOTH
 * counters inside the order transaction.
 */
const h = vi.hoisted(() => {
  process.env.BURGONOMICS_ENV = "dev";
  const docs = new Map<string, any>();
  const copy = (v: any) => (v === undefined ? undefined : structuredClone(v));
  const DEL = "__FIELD_DELETE__";
  const apply = (path: string, data: any, merge?: boolean) => {
    const next = merge ? { ...(docs.get(path) ?? {}), ...copy(data) } : copy(data);
    if (next && typeof next === "object" && !Array.isArray(next)) {
      for (const [k, v] of Object.entries(next)) {
        if (v === DEL) delete next[k];
        else if (v && typeof v === "object" && !Array.isArray(v)) {
          for (const [k2, v2] of Object.entries(v as object)) {
            if (v2 === DEL) delete (next[k] as any)[k2];
          }
        }
      }
    }
    docs.set(path, next);
  };
  const ref = (collection: string, id: string) => ({
    id,
    path: `${collection}/${id}`,
    get: async () => ({ exists: docs.has(`${collection}/${id}`), data: () => copy(docs.get(`${collection}/${id}`)) }),
    set: async (data: any, options?: { merge?: boolean }) => apply(`${collection}/${id}`, data, options?.merge),
  });
  const db: any = {
    collection: (name: string) => ({ doc: (id: string) => ref(name, id) }),
    runTransaction: async (cb: (tx: any) => Promise<any>) => {
      const pending: Array<() => void> = [];
      let wrote = false;
      const tx = {
        get: async (r: any) => {
          if (wrote) throw new Error("FIRESTORE_READ_AFTER_WRITE");
          return r.get();
        },
        set: (r: any, data: any, opts?: { merge?: boolean }) => {
          wrote = true;
          pending.push(() => apply(r.path, data, opts?.merge));
        },
      };
      const result = await cb(tx);
      for (const w of pending) w();
      return result;
    },
  };
  return { docs, db, DEL };
});

vi.mock("../src/core/firebase", () => ({ db: h.db }));
vi.mock("firebase-admin", () => {
  const firestore: any = vi.fn(() => h.db);
  firestore.FieldValue = {
    serverTimestamp: () => "SERVER_TS",
    increment: (n: number) => n,
    delete: () => h.DEL,
  };
  return {
    default: { firestore: vi.fn(() => h.db), auth: vi.fn(() => ({})), initializeApp: vi.fn(), apps: [{ name: "mock" }] },
    firestore,
    auth: vi.fn(() => ({})),
    initializeApp: vi.fn(),
    apps: [{ name: "mock" }],
  };
});

import {
  assertCouponReservationLive,
  commitCouponRedemption,
  readCouponRedemption,
  releaseCouponRedemption,
  reserveCouponInTx,
} from "../src/modules/coupons/couponAuthority";

const CODE = "FR20";
const ORDER = "ord_fr_1";
const INTENT = "idem_fr_1";

function seedCoupon() {
  h.docs.set(`coupons/${CODE}`, {
    code: CODE,
    active: true,
    discountType: "percent",
    value: 20,
    maxDiscount: 200,
    minOrder: 0,
    validFromMs: null,
    validToMs: null,
    perCustomerLimit: null,
    totalCap: 1,
    branchScope: "all",
    customerScope: null,
  });
}

beforeEach(() => h.docs.clear());

// --- M3: cash commits redemption + counters inside the same transaction ---

describe("M3 cash redemption commits in the order transaction", () => {
  it("writes a committed redemption and bumps both counters in one tx", async () => {
    seedCoupon();
    await h.db.runTransaction(async (tx: any) =>
      reserveCouponInTx(tx, {
        code: CODE,
        orderId: ORDER,
        customerId: "cust_1",
        branchId: "branch_a",
        foodSubtotal: 500,
        expectedDiscount: 100,
        paymentIntentId: ORDER,
        commitNow: true,
      })
    );
    const redemption = await readCouponRedemption(ORDER);
    expect(redemption?.status).toBe("committed");
    expect(redemption?.paymentIntentId).toBe(ORDER);
    expect(h.docs.get(`coupon_stats/${CODE}`)?.committed).toBe(1);
    expect(h.docs.get(`coupon_customer_usage/${CODE}__cust_1`)?.committed).toBe(1);
    expect(h.docs.get(`coupon_obligations/${ORDER}`)?.status).toBe("settled");
    // No live reservation is left to expire and free the slot.
    expect(Object.keys(h.docs.get(`coupon_stats/${CODE}`)?.reservations ?? {})).toHaveLength(0);
  });
});

// --- M2: intent binding + release only on terminal resolution ---

describe("M2 coupon slot is bound to one payment intent", () => {
  it("refuses a release that names a different intent", async () => {
    seedCoupon();
    await h.db.runTransaction(async (tx: any) =>
      reserveCouponInTx(tx, {
        code: CODE,
        orderId: ORDER,
        customerId: "cust_1",
        foodSubtotal: 500,
        expectedDiscount: 100,
        paymentIntentId: INTENT,
      })
    );
    const stale = await releaseCouponRedemption({
      orderId: ORDER,
      reason: "payment_failed",
      paymentIntentId: "a_different_intent",
    });
    expect(stale.released).toBe(false);
    expect(stale.reason).toBe("intent_mismatch");
    expect((await readCouponRedemption(ORDER))?.status).toBe("reserved");
  });

  it("a decline does not free the slot; a live reservation is still required", async () => {
    seedCoupon();
    await h.db.runTransaction(async (tx: any) =>
      reserveCouponInTx(tx, {
        code: CODE,
        orderId: ORDER,
        customerId: "cust_1",
        foodSubtotal: 500,
        expectedDiscount: 100,
        paymentIntentId: INTENT,
      })
    );
    // No release is issued on payment.failed; the slot must still be usable by
    // a retry of the SAME intent.
    await expect(assertCouponReservationLive(ORDER, INTENT)).resolves.toBeUndefined();
    const released = await releaseCouponRedemption({
      orderId: ORDER,
      reason: "payment_failed",
      paymentIntentId: INTENT,
    });
    expect(released.released).toBe(true);
    await expect(assertCouponReservationLive(ORDER, INTENT)).rejects.toMatchObject({
      code: "COUPON_SLOT_RELEASED",
    });
  });

  it("capture reconciles a still-reserved slot to committed", async () => {
    seedCoupon();
    await h.db.runTransaction(async (tx: any) =>
      reserveCouponInTx(tx, {
        code: CODE,
        orderId: ORDER,
        customerId: "cust_1",
        foodSubtotal: 500,
        expectedDiscount: 100,
        paymentIntentId: INTENT,
      })
    );
    const outcome = await commitCouponRedemption(ORDER);
    expect(outcome).toBe("committed");
    expect((await readCouponRedemption(ORDER))?.status).toBe("committed");
    expect(h.docs.get(`coupon_stats/${CODE}`)?.committed).toBe(1);
  });
});
