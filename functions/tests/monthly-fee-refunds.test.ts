import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Part F7/F7a (owner decision 2026-11-01): the fee ledger stays correct across
 * refunds, and a refund never races a transfer.
 *
 * D7: a refund comes out of the courier fee and the branch's share first, and
 * out of the held fee last:
 *   target = min(holdPaise, max(0, refunded - branchTransferPaise - courierFeePaise))
 * The release is written to the ledger of the hold's MONTH, inside the same
 * transaction as the refund record, using increments only — so a replay
 * changes nothing.
 *
 * Hermetic: in-memory Firestore, mock gateway, no network.
 */

const { savedDocs, mockDb } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};

  const applyWrites = (path: string, data: any, merge: boolean) => {
    const base = merge && savedDocs[path] ? { ...savedDocs[path] } : {};
    for (const [key, value] of Object.entries(data || {})) {
      if (value && typeof value === "object" && typeof (value as any).__inc === "number") {
        base[key] = (Number(base[key]) || 0) + (value as any).__inc;
      } else {
        base[key] = value;
      }
    }
    savedDocs[path] = base;
  };

  const docRef = (col: string, id: string): any => {
    const path = `${col}/${id}`;
    return {
      id,
      path,
      get: async () => ({
        id,
        exists: Object.prototype.hasOwnProperty.call(savedDocs, path),
        data: () => savedDocs[path],
      }),
      set: async (data: any, opts?: any) => applyWrites(path, data, !!opts?.merge),
    };
  };

  const q = (): any => ({
    where: () => q(),
    orderBy: () => q(),
    limit: () => q(),
    startAfter: () => q(),
    get: async () => ({ empty: true, docs: [] }),
  });

  const mockDb: any = {
    collection: (col: string) => ({
      ...q(),
      doc: (id?: string) => docRef(col, id as string),
    }),
    runTransaction: async (fn: any) =>
      fn({
        get: (ref: any) => ref.get(),
        set: (ref: any, data: any, opts?: any) => ref.set(data, opts),
      }),
  };
  return { savedDocs, mockDb };
});

vi.mock("firebase-admin", () => {
  const FieldValue = {
    serverTimestamp: () => "MOCK_TIMESTAMP",
    increment: (n: number) => ({ __inc: n }),
    delete: () => "MOCK_DELETED",
    arrayUnion: (item: any) => [item],
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
  applyRefundToMonthlyFee,
  branchMonthlyFeeId,
  monthlyFeeRefundDeltas,
  istMonthKey,
} from "../src/modules/payments/monthlyFee";
import { executeRouteSplit, __setRefundPostForTests } from "../src/modules/payments/razorpay.service";
import { config } from "../src/config/env";

const BRANCH = "branch_refund";
let prevMock: any;

const HOLD = {
  monthKey: "2026-10",
  earnedPaise: 400000,
  courierFeePaise: 4500,
  holdPaise: 80000,
  branchTransferPaise: 315500,
  releasedPaise: 0,
  refundLedgeredPaise: 0,
};

function seedLedger(monthKey = "2026-10", collected = 80000) {
  savedDocs[`branch_monthly_fees/${branchMonthlyFeeId(BRANCH, monthKey)}`] = {
    branchId: BRANCH,
    monthKey,
    feePaise: 250000,
    feeCollectedPaise: collected,
    razorpayOrders: 1,
    razorpayEarnedPaise: 400000,
    razorpayRefundedPaise: 0,
  };
}

function seedOrder(id: string, extra: Record<string, any> = {}) {
  savedDocs[`orders/${id}`] = {
    id,
    branchId: BRANCH,
    paymentStatus: "completed",
    payment: { razorpayPaymentId: `pay_${id}`, capturedAmountPaise: 320000 },
    pricing: {
      grandTotal: 3200,
      split: { branchTransferPaise: 315500, courierFeePaise: 4500 },
    },
    monthlyFeeHold: { ...HOLD },
    ...extra,
  };
}

async function refund(orderId: string, nextRefundedTotalPaise: number) {
  const orderRef = mockDb.collection("orders").doc(orderId);
  return mockDb.runTransaction(async (tx: any) => {
    const snap = await tx.get(orderRef);
    const fresh = snap.data();
    applyRefundToMonthlyFee(tx, orderRef, fresh, nextRefundedTotalPaise);
  });
}

beforeEach(() => {
  for (const key of Object.keys(savedDocs)) delete savedDocs[key];
  prevMock = { mock: { ...config.mock } };
  config.mock.paymentGateway = true;
  seedLedger();
});

afterEach(() => {
  config.mock = { ...prevMock.mock };
  __setRefundPostForTests(null);
});

describe("F7 refunds and the monthly fee", () => {
  it("14: a full refund releases the whole hold, and a later order holds it again", async () => {
    seedOrder("ord_full_refund");
    // 315500 branch share + 4500 courier = 320000; the refund reaches the hold.
    await refund("ord_full_refund", 400000); // entire earnings refunded
    expect(
      savedDocs[`branch_monthly_fees/${branchMonthlyFeeId(BRANCH, "2026-10")}`].feeCollectedPaise
    ).toBe(0);
    expect(savedDocs["orders/ord_full_refund"].monthlyFeeHold.releasedPaise).toBe(80000);

    // A later order that month holds the fee again.
    savedDocs[`branches/${BRANCH}`] = { razorpayAccountId: "acc_refund01" };
    savedDocs["orders/ord_after_refund"] = {
      id: "ord_after_refund",
      branchId: BRANCH,
      paymentStatus: "completed",
      payment: { razorpayPaymentId: "pay_after", capturedAmountPaise: 100000 },
      pricing: { grandTotal: 1000, split: { branchTransferPaise: 100000, courierFeePaise: 0 } },
    };
    const orderRef = mockDb.collection("orders").doc("ord_after_refund");
    await executeRouteSplit({
      orderRef,
      orderId: "ord_after_refund",
      orderData: savedDocs["orders/ord_after_refund"],
      razorpayPaymentId: "pay_after",
      capturedAmountPaise: 100000,
    });
    expect(savedDocs["orders/ord_after_refund"].monthlyFeeHold.holdPaise).toBe(100000);
    // The later order holds against the CURRENT month's ledger (the release
    // was on October's).
    expect(
      savedDocs[`branch_monthly_fees/${branchMonthlyFeeId(BRANCH, istMonthKey())}`].feeCollectedPaise
    ).toBe(100000);
  });

  it("15: a partial refund inside branch share + courier releases nothing but counts the FOOD share of the refund", async () => {
    seedOrder("ord_partial_small");
    const deltas = monthlyFeeRefundDeltas(
      { ...HOLD, releasedPaise: 0, refundLedgeredPaise: 0 },
      300000 // exactly branch share + courier (320000) is not reached
    );
    expect(deltas.deltaRelease).toBe(0);
    // P1-N: the ledger's refunded figure is the BRANCH'S FOOD SHARE of the
    // refund, not the whole capture — the courier fee was never in `earned`,
    // so counting it here shorted the branch's statement by that fee.
    // 300000 * 400000 / (400000 + 4500) = 296663 (rounded).
    expect(deltas.deltaRefund).toBe(296663);
    expect(deltas.deltaRefund).toBeLessThan(300000);
    expect(deltas.deltaRefund).toBeLessThanOrEqual(HOLD.earnedPaise);

    await refund("ord_partial_small", 300000);
    const ledger =
      savedDocs[`branch_monthly_fees/${branchMonthlyFeeId(BRANCH, "2026-10")}`];
    expect(ledger.feeCollectedPaise).toBe(80000);
    expect(ledger.razorpayRefundedPaise).toBe(296663);
  });

  it("16: a partial refund beyond branch share + courier releases only the excess", async () => {
    seedOrder("ord_partial_big");
    // 320000 (share+courier) is the threshold; refund 330000 → excess 10000,
    // capped at the 80000 hold.
    await refund("ord_partial_big", 330000);
    const ledger =
      savedDocs[`branch_monthly_fees/${branchMonthlyFeeId(BRANCH, "2026-10")}`];
    expect(ledger.feeCollectedPaise).toBe(70000);
    expect(savedDocs["orders/ord_partial_big"].monthlyFeeHold.releasedPaise).toBe(10000);
  });

  it("17: a refund of last month's order changes last month's ledger only", async () => {
    // An order held in October; the current month's ledger is separate.
    seedOrder("ord_last_month", { monthlyFeeHold: { ...HOLD, monthKey: "2026-10" } });
    savedDocs[`branch_monthly_fees/${branchMonthlyFeeId(BRANCH, "2026-11")}`] = {
      branchId: BRANCH,
      monthKey: "2026-11",
      feePaise: 250000,
      feeCollectedPaise: 50000,
      razorpayOrders: 1,
      razorpayEarnedPaise: 50000,
      razorpayRefundedPaise: 0,
    };
    await refund("ord_last_month", 400000);
    expect(
      savedDocs[`branch_monthly_fees/${branchMonthlyFeeId(BRANCH, "2026-10")}`].feeCollectedPaise
    ).toBe(0);
    expect(
      savedDocs[`branch_monthly_fees/${branchMonthlyFeeId(BRANCH, "2026-11")}`].feeCollectedPaise
    ).toBe(50000);
  });

  it("18 + 22g: a replayed refund changes nothing (crash between Razorpay and our record)", async () => {
    seedOrder("ord_replay");
    await refund("ord_replay", 400000);
    const afterFirst = JSON.parse(
      JSON.stringify(savedDocs[`branch_monthly_fees/${branchMonthlyFeeId(BRANCH, "2026-10")}`])
    );
    const holdAfterFirst = { ...savedDocs["orders/ord_replay"].monthlyFeeHold };

    // The same gateway refund processed again: identical total.
    await refund("ord_replay", 400000);
    expect(
      savedDocs[`branch_monthly_fees/${branchMonthlyFeeId(BRANCH, "2026-10")}`]
    ).toEqual(afterFirst);
    expect(savedDocs["orders/ord_replay"].monthlyFeeHold).toEqual(holdAfterFirst);
  });

  it("22b: a refund recorded before the transfer means no POST, nothing held, manual flag", async () => {
    savedDocs[`branches/${BRANCH}`] = { razorpayAccountId: "acc_refund01" };
    savedDocs["orders/ord_refunded_before"] = {
      id: "ord_refunded_before",
      branchId: BRANCH,
      paymentStatus: "completed",
      payment: { razorpayPaymentId: "pay_rb", capturedAmountPaise: 100000 },
      pricing: { grandTotal: 1000, split: { branchTransferPaise: 100000, courierFeePaise: 0 } },
      refundedTotalPaise: 100000,
      refundStatus: "refunded",
      routeTransferStatus: "pending_retry",
    };
    const orderRef = mockDb.collection("orders").doc("ord_refunded_before");
    const outcome = await executeRouteSplit({
      orderRef,
      orderId: "ord_refunded_before",
      orderData: savedDocs["orders/ord_refunded_before"],
      razorpayPaymentId: "pay_rb",
      capturedAmountPaise: 100000,
    });
    expect(outcome.state).toBe("flagged");
    const order = savedDocs["orders/ord_refunded_before"];
    expect(order.monthlyFeeHold.branchTransferPaise).toBe(0);
    expect(order.routeTransferNeedsManualSettlement).toBe(true);
    expect(order["payment.routeTransfer"]).toBeUndefined();
    // Nothing counted as earnings.
    expect(
      savedDocs[`branch_monthly_fees/${branchMonthlyFeeId(BRANCH, istMonthKey())}`]
    ).toBeUndefined();
  });

  it("22c: a refund is refused while a transfer lease is live, and allowed after it", async () => {
    const { autoRefund } = await import("../src/modules/payments/razorpay.service");
    seedOrder("ord_lease", {
      routeTransferStatus: "transferring",
      routeTransferClaimedAt: Date.now(),
      monthlyFeeHold: undefined,
    });
    const live: any = await autoRefund({
      orderId: "ord_lease",
      razorpayPaymentId: "pay_ord_lease",
      amountRupees: 100,
          refundRequestId: "refund_req_ord_lease",
    }).catch((e) => e);
    expect(live).toMatchObject({ statusCode: 409, code: "REFUND_WAIT_TRANSFER" });

    // Expired lease: the refund proceeds.
    savedDocs["orders/ord_lease"].routeTransferClaimedAt = Date.now() - 11 * 60 * 1000;
    const ok = await autoRefund({
      orderId: "ord_lease",
      razorpayPaymentId: "pay_ord_lease",
      amountRupees: 100,
          refundRequestId: "refund_req_ord_lease",
    });
    expect(ok.id).toBeTruthy();
  });

  it("22d: reverse_all is sent only when a transfer exists to reverse", async () => {
    const { autoRefund } = await import("../src/modules/payments/razorpay.service");
    const payloads: any[] = [];
    // The refund POST only exists on the live path; drive it with a stubbed
    // transport and non-mock keys (no network).
    const prevKeys = { id: config.razorpay.keyId, secret: config.razorpay.keySecret };
    config.mock.paymentGateway = false;
    config.razorpay.keyId = "rzp_test_key_id_123";
    config.razorpay.keySecret = "rzp_test_key_secret_123";
    __setRefundPostForTests((async (_paymentId: string, payload: any) => {
      payloads.push(payload);
      return { id: `rfnd_${payloads.length}`, payment_id: "pay_x", amount: payload.amount, status: "processed" };
    }) as any);
    try {
      for (const status of ["transferred", "needs_reconciliation"]) {
        const id = `ord_rev_${status}`;
        seedOrder(id, { routeTransferStatus: status, monthlyFeeHold: undefined });
        await autoRefund({ orderId: id, razorpayPaymentId: `pay_${id}`, amountRupees: 100, refundRequestId: `refund_req_${id}` });
      }
      for (const status of ["not_required", "pending_retry", "failed"]) {
        const id = `ord_norev_${status}`;
        seedOrder(id, { routeTransferStatus: status, monthlyFeeHold: undefined });
        await autoRefund({ orderId: id, razorpayPaymentId: `pay_${id}`, amountRupees: 100, refundRequestId: `refund_req_${id}` });
      }
      const id = "ord_norev_none";
      seedOrder(id, { monthlyFeeHold: undefined });
      await autoRefund({ orderId: id, razorpayPaymentId: `pay_${id}`, amountRupees: 100, refundRequestId: `refund_req_${id}` });

      const withReverse = payloads.filter((p) => "reverse_all" in p);
      const withoutReverse = payloads.filter((p) => !("reverse_all" in p));
      expect(withReverse).toHaveLength(2);
      expect(withoutReverse).toHaveLength(4);
    } finally {
      config.razorpay.keyId = prevKeys.id;
      config.razorpay.keySecret = prevKeys.secret;
    }
  });
});
