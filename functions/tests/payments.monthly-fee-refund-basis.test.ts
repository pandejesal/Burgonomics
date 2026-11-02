import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * P1-N — the monthly-fee ledger must use ONE basis for earned and refunded.
 *
 * Live case (ord_1793598898586_Y4hQIn, delivery):
 *   food (branch share)  15000 paise
 *   courier fee           4500 paise
 *   captured              19500 paise
 *
 * The hold correctly EXCLUDES the courier (`earnedPaise: 15000`). After a full
 * refund the ledger recorded `razorpayRefundedPaise: 20500` — the full captured
 * amount — so `earned - refunded` read 31000 - 20500 = 10500 instead of the
 * true 15000: the branch's statement was short by exactly the courier fee,
 * money that was never in `earned` to begin with.
 */
const { mockDb, docs } = vi.hoisted(() => {
  const docs = new Map<string, any>();
  const applyWrite = (path: string, data: any, merge?: boolean) => {
    const existing = docs.get(path);
    const merged =
      merge && existing && typeof existing === "object" && typeof data === "object"
        ? { ...existing, ...data }
        : { ...data };
    // Mirror Firestore: reject undefined anywhere in the payload.
    const assertNoUndefined = (v: any, p: string) => {
      if (v === undefined) throw new Error(`Firestore rejects undefined at ${p}`);
      if (Array.isArray(v)) return v.forEach((x, i) => assertNoUndefined(x, `${p}[${i}]`));
      if (v && typeof v === "object" && typeof v.toMillis !== "function") {
        for (const [k, x] of Object.entries(v)) assertNoUndefined(x, `${p}.${k}`);
      }
    };
    assertNoUndefined(merged, path);
    docs.set(path, merged);
  };

  const docRef = (col: string, id: string) => {
    const path = `${col}/${id}`;
    return {
      id,
      path,
      get: async () => ({
        exists: docs.has(path),
        data: () => (docs.has(path) ? JSON.parse(JSON.stringify(docs.get(path))) : undefined),
        ref: docRef(col, id),
      }),
      set: async (data: any, opts?: any) => applyWrite(path, data, !!opts?.merge),
      update: async (data: any) => applyWrite(path, data, true),
    };
  };

  const mockDb: any = {
    collection: (col: string) => ({ doc: (id: string) => docRef(col, id) }),
    runTransaction: vi.fn(async (fn: any) => {
      const writes: Array<{ path: string; data: any; merge: boolean }> = [];
      const result = await fn({
        get: async (ref: any) => ({
          exists: docs.has(ref.path),
          data: () =>
            docs.has(ref.path) ? JSON.parse(JSON.stringify(docs.get(ref.path))) : undefined,
          ref,
        }),
        set: (ref: any, data: any, opts?: any) =>
          writes.push({ path: ref.path, data, merge: !!opts?.merge }),
        update: (ref: any, data: any) => writes.push({ path: ref.path, data, merge: true }),
      });
      for (const w of writes) applyWrite(w.path, w.data, w.merge);
      return result;
    }),
  };
  return { mockDb, docs };
});

vi.mock("../src/core/firebase", () => ({ db: mockDb }));
vi.mock("firebase-admin", () => {
  const FieldValue = {
    serverTimestamp: () => "MOCK_TS",
    increment: (n: number) => ({ __inc: n }),
    arrayUnion: (i: any) => [i],
    delete: () => "MOCK_DELETE",
  };
  const f: any = vi.fn(() => mockDb);
  f.FieldValue = FieldValue;
  return {
    default: {
      firestore: f,
      auth: vi.fn(() => ({})),
      messaging: vi.fn(() => ({})),
      initializeApp: vi.fn(),
      apps: [{ name: "mock" }],
    },
    firestore: f,
    auth: vi.fn(() => ({})),
    messaging: vi.fn(() => ({})),
    initializeApp: vi.fn(),
    apps: [{ name: "mock" }],
  };
});
vi.mock("../src/core/errors", async (io) => ({
  ...(await io<any>()),
  captureErrorSnapshot: vi.fn(async () => "snap_1"),
}));

import { applyRefundToMonthlyFee, monthlyFeeRefundDeltas } from "../src/modules/payments/monthlyFee";

const BRANCH = "demo";
const MONTH = "2026-11";
const LEDGER = `branch_monthly_fees/${BRANCH}_${MONTH}`;
const ORDER = "ord_1793598898586_Y4hQIn";

/** Applies `increment` sentinels the way Firestore would. */
function settleIncrements(target: any, patch: any) {
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === "object" && typeof (v as any).__inc === "number") {
      target[k] = Number(target[k] || 0) + (v as any).__inc;
    } else {
      target[k] = v;
    }
  }
}

const seedHold = () => {
  docs.set(`orders/${ORDER}`, {
    id: ORDER,
    branchId: BRANCH,
    fulfillmentType: "delivery",
    monthlyFeeHold: {
      monthKey: MONTH,
      earnedPaise: 15000,
      courierFeePaise: 4500,
      holdPaise: 15000,
      branchTransferPaise: 0,
      releasedPaise: 0,
      refundLedgeredPaise: 0,
    },
    payment: { capturedAmountPaise: 19500 },
  });
  docs.set(LEDGER, {
    branchId: BRANCH,
    monthKey: MONTH,
    feePaise: 250000,
    feeCollectedPaise: 15000,
    razorpayOrders: 1,
    razorpayEarnedPaise: 31000,
    razorpayRefundedPaise: 0,
  });
};

describe("P1-N — the ledger's refunded figure uses the SAME basis as earned", () => {
  beforeEach(() => {
    docs.clear();
    seedHold();
  });

  it("full refund of a delivery order ledgers the FOOD share only, not the courier fee", () => {
    const orderRef = mockDb.collection("orders").doc(ORDER);
    const freshOrder = docs.get(`orders/${ORDER}`);

    // Transact exactly like the refund path: collect the ledger patch, then apply.
    const writes: Array<{ ref: any; data: any }> = [];
    const tx = {
      set: (ref: any, data: any) => writes.push({ ref, data }),
    };
    applyRefundToMonthlyFee(tx, orderRef, freshOrder, 19500);

    const ledgerWrite = writes.find((w) => String(w.ref.path).startsWith("branch_monthly_fees/"));
    expect(ledgerWrite).toBeDefined();
    settleIncrements(docs.get(LEDGER), ledgerWrite!.data);

    const ledger = docs.get(LEDGER);
    // Earned already counts this order's food share (15000 of the 31000).
    expect(ledger.razorpayEarnedPaise).toBe(31000);
    // Refunded must be the SAME basis: the food share (15000), NOT 19500.
    expect(ledger.razorpayRefundedPaise).toBe(15000);

    // Net the partner statement reads: earned - refunded.
    const net = ledger.razorpayEarnedPaise - ledger.razorpayRefundedPaise;
    // 31000 of food earned, 15000 refunded -> 16000 still net food earnings.
    expect(net).toBe(16000);
    // The courier fee must never be netted out of the branch's food earnings:
    // the old code read 31000 - 19500 = 11500, short by exactly 4500.
    expect(net).not.toBe(31000 - 19500);
  });

  it("the hold's released/refundLedgered figures stay on the food basis too", () => {
    const orderRef = mockDb.collection("orders").doc(ORDER);
    const writes: Array<{ ref: any; data: any }> = [];
    applyRefundToMonthlyFee(
      { set: (ref: any, data: any) => writes.push({ ref, data }) },
      orderRef,
      docs.get(`orders/${ORDER}`),
      19500
    );
    const orderWrite = writes.find((w) => String(w.ref.path) === `orders/${ORDER}`);
    expect(orderWrite).toBeDefined();
    const hold = orderWrite!.data.monthlyFeeHold;
    // The full hold is released (all 15000 was held).
    expect(hold.releasedPaise).toBe(15000);
    // And the refund ledgered is the food share, matching `earnedPaise`.
    expect(hold.refundLedgeredPaise).toBe(15000);
    expect(hold.refundLedgeredPaise).toBeLessThanOrEqual(hold.earnedPaise);
  });

  it("partial refunds ledger proportionally, never exceeding the food share", () => {
    // Half the captured amount back: 9750 of 19500, i.e. half the food (7500)
    // plus half the courier (2250) — only the food half belongs in the ledger.
    const deltas = monthlyFeeRefundDeltas(
      docs.get(`orders/${ORDER}`).monthlyFeeHold,
      9750
    );
    expect(deltas.deltaRefund).toBe(7500);
    expect(deltas.deltaRefund).toBeLessThan(9750);
  });

  it("never lets the refunded figure exceed the food share on an over-refund", () => {
    const deltas = monthlyFeeRefundDeltas(
      docs.get(`orders/${ORDER}`).monthlyFeeHold,
      999999
    );
    expect(deltas.deltaRefund).toBe(15000);
  });

  it("is idempotent: replaying the same refund adds nothing", () => {
    const hold = {
      ...docs.get(`orders/${ORDER}`).monthlyFeeHold,
      refundLedgeredPaise: 15000,
      releasedPaise: 15000,
    };
    const deltas = monthlyFeeRefundDeltas(hold, 19500);
    expect(deltas.deltaRefund).toBe(0);
    expect(deltas.deltaRelease).toBe(0);
  });

  it("a cash/courier-only order with zero food share ledgers nothing", () => {
    const hold = {
      monthKey: MONTH,
      earnedPaise: 0,
      courierFeePaise: 4500,
      holdPaise: 0,
      branchTransferPaise: 0,
      releasedPaise: 0,
      refundLedgeredPaise: 0,
    };
    expect(monthlyFeeRefundDeltas(hold, 4500).deltaRefund).toBe(0);
  });
});
