import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Part F1-F6/F8 (owner decision 2026-11-01): fixed monthly branch fee.
 *
 * The first ₹2,500 of a branch's Razorpay earnings each calendar month stays
 * with the brand; every later order pays the branch in full. The hold is
 * stamped on the order exactly once and the ledger
 * `branch_monthly_fees/{branchId}_{monthKey}` records the month.
 *
 * Hermetic: in-memory Firestore shim (with FieldValue.increment applied on
 * write) and the mock gateway, so no network and no real money.
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

import { executeRouteSplit } from "../src/modules/payments/razorpay.service";
import { istMonthKey, branchMonthlyFeeId } from "../src/modules/payments/monthlyFee";
import { config } from "../src/config/env";

const BRANCH = "branch_fee";
const DAY = 24 * 60 * 60 * 1000;

let prevMock: any;

function seedBranch(extra: Record<string, any> = {}) {
  savedDocs[`branches/${BRANCH}`] = {
    razorpayAccountId: "acc_feetest01",
    ...extra,
  };
}

function seedOrder(
  id: string,
  opts: {
    grandPaise: number;
    courierPaise?: number;
    gatewayCreatedAtMs?: number;
    extra?: Record<string, any>;
  }
) {
  const courier = opts.courierPaise ?? 0;
  savedDocs[`orders/${id}`] = {
    id,
    branchId: BRANCH,
    status: { code: "CONFIRMED", terminal: false },
    paymentStatus: "completed",
    pricing: {
      grandTotal: opts.grandPaise / 100,
      split: {
        courierFeePaise: courier,
        branchTransferPaise: opts.grandPaise - courier,
        totalAmountPaise: opts.grandPaise,
      },
    },
    payment: {
      razorpayPaymentId: `pay_${id}`,
      capturedAmountPaise: opts.grandPaise,
      ...(opts.gatewayCreatedAtMs ? { gatewayCreatedAtMs: opts.gatewayCreatedAtMs } : {}),
    },
    ...(opts.extra || {}),
  };
}

async function split(orderId: string) {
  const orderRef = mockDb.collection("orders").doc(orderId);
  const data = savedDocs[`orders/${orderId}`];
  return executeRouteSplit({
    orderRef,
    orderId,
    orderData: data,
    razorpayPaymentId: data.payment.razorpayPaymentId,
    capturedAmountPaise: data.payment.capturedAmountPaise,
  });
}

const ledger = (monthKey = istMonthKey()) =>
  savedDocs[`branch_monthly_fees/${branchMonthlyFeeId(BRANCH, monthKey)}`];

beforeEach(() => {
  for (const key of Object.keys(savedDocs)) delete savedDocs[key];
  prevMock = { mock: { ...config.mock } };
  config.mock.paymentGateway = true;
  seedBranch();
});

afterEach(() => {
  config.mock = { ...prevMock.mock };
});

describe("F5 monthly fee hold", () => {
  it("1: the first capture of a month holds the lot (transfer 0, not_required)", async () => {
    seedOrder("ord_first", { grandPaise: 100000 });
    const outcome = await split("ord_first");
    expect(outcome.state).toBe("not_required");
    const order = savedDocs["orders/ord_first"];
    expect(order.monthlyFeeHold).toMatchObject({
      monthKey: istMonthKey(),
      earnedPaise: 100000,
      holdPaise: 100000,
      branchTransferPaise: 0,
    });
    expect(order.routeTransferStatus).toBe("not_required");
    expect(order.payment.routeTransfer).toBeUndefined();
    // Stream marker survives here too (F8).
    expect(order.paymentChannel).toBe("razorpay");
  });

  it("2: crossing the line holds only the remainder and transfers the rest", async () => {
    savedDocs[`branch_monthly_fees/${branchMonthlyFeeId(BRANCH, istMonthKey())}`] = {
      branchId: BRANCH,
      monthKey: istMonthKey(),
      feePaise: 250000,
      feeCollectedPaise: 200000,
      razorpayOrders: 8,
      razorpayEarnedPaise: 200000,
      razorpayRefundedPaise: 0,
    };
    seedOrder("ord_cross", { grandPaise: 100000 });
    const outcome = await split("ord_cross");
    expect(outcome.state).toBe("transferred");
    const order = savedDocs["orders/ord_cross"];
    expect(order.monthlyFeeHold.holdPaise).toBe(50000);
    expect(order.monthlyFeeHold.branchTransferPaise).toBe(50000);
    expect(order["payment.routeTransfer"].amount).toBe(50000);
    expect(ledger().feeCollectedPaise).toBe(250000);
    expect(ledger().razorpayOrders).toBe(9);
    expect(ledger().razorpayEarnedPaise).toBe(300000);
  });

  it("3: after the fee is met, nothing is held and the branch gets everything", async () => {
    savedDocs[`branch_monthly_fees/${branchMonthlyFeeId(BRANCH, istMonthKey())}`] = {
      branchId: BRANCH,
      monthKey: istMonthKey(),
      feePaise: 250000,
      feeCollectedPaise: 250000,
      razorpayOrders: 3,
      razorpayEarnedPaise: 250000,
      razorpayRefundedPaise: 0,
    };
    seedOrder("ord_after", { grandPaise: 100000 });
    expect((await split("ord_after")).state).toBe("transferred");
    const hold = savedDocs["orders/ord_after"].monthlyFeeHold;
    expect(hold.holdPaise).toBe(0);
    expect(hold.branchTransferPaise).toBe(100000);
    expect(ledger().feeCollectedPaise).toBe(250000);
  });

  it("4: the courier fee is never transferred (D6)", async () => {
    savedDocs[`branch_monthly_fees/${branchMonthlyFeeId(BRANCH, istMonthKey())}`] = {
      branchId: BRANCH,
      monthKey: istMonthKey(),
      feePaise: 250000,
      feeCollectedPaise: 250000,
      razorpayOrders: 3,
      razorpayEarnedPaise: 250000,
      razorpayRefundedPaise: 0,
    };
    seedOrder("ord_courier", { grandPaise: 104500, courierPaise: 4500 });
    await split("ord_courier");
    const order = savedDocs["orders/ord_courier"];
    expect(order.monthlyFeeHold.earnedPaise).toBe(100000);
    expect(order.monthlyFeeHold.courierFeePaise).toBe(4500);
    expect(order["payment.routeTransfer"].amount).toBe(100000);
    // The Razorpay notes record the held amount, not a royalty.
    expect(order.monthlyFeeHold.holdPaise).toBe(0);
  });

  it("5: verify and webhook both fire — one hold, ledger counted once", async () => {
    seedOrder("ord_twice", { grandPaise: 100000 });
    await split("ord_twice");
    const afterFirst = JSON.parse(JSON.stringify(ledger()));
    const second = await split("ord_twice");
    // The first capture held the whole fee, so there is nothing to pay (and a
    // rerun must not change that).
    expect(second.state).toBe("not_required");
    expect(ledger()).toEqual(afterFirst);
    expect(savedDocs["orders/ord_twice"].monthlyFeeHold.holdPaise).toBe(100000);
  });

  it("6: a re-run (stale-lease takeover / retry worker) reuses the stamped amount", async () => {
    seedOrder("ord_reuse", { grandPaise: 100000 });
    await split("ord_reuse");
    const hold = { ...savedDocs["orders/ord_reuse"].monthlyFeeHold };
    const ledgerBefore = JSON.parse(JSON.stringify(ledger()));

    // Simulate a takeover: the transfer never landed, so the order is retried.
    savedDocs["orders/ord_reuse"].routeTransferStatus = "pending_retry";
    savedDocs["orders/ord_reuse"].routeTransferClaimedAt = Date.now() - 11 * 60 * 1000;
    const again = await split("ord_reuse");
    expect(["transferred", "not_required"]).toContain(again.state);
    expect(savedDocs["orders/ord_reuse"].monthlyFeeHold).toEqual(hold);
    expect(ledger()).toEqual(ledgerBefore);
  });

  it("7: two captures racing for the last ₹500 hold exactly ₹500 in total", async () => {
    savedDocs[`branch_monthly_fees/${branchMonthlyFeeId(BRANCH, istMonthKey())}`] = {
      branchId: BRANCH,
      monthKey: istMonthKey(),
      feePaise: 250000,
      feeCollectedPaise: 249500,
      razorpayOrders: 3,
      razorpayEarnedPaise: 249500,
      razorpayRefundedPaise: 0,
    };
    seedOrder("ord_race_a", { grandPaise: 100000 });
    seedOrder("ord_race_b", { grandPaise: 100000 });
    await Promise.all([split("ord_race_a"), split("ord_race_b")]);
    const held =
      Number(savedDocs["orders/ord_race_a"].monthlyFeeHold?.holdPaise || 0) +
      Number(savedDocs["orders/ord_race_b"].monthlyFeeHold?.holdPaise || 0);
    expect(held).toBe(500);
    expect(ledger().feeCollectedPaise).toBe(250000);
  });

  it("8: month boundary is 18:30Z (Asia/Kolkata)", () => {
    expect(istMonthKey(Date.parse("2026-10-31T18:29:59Z"))).toBe("2026-10");
    expect(istMonthKey(Date.parse("2026-10-31T18:30:00Z"))).toBe("2026-11");
  });

  it("9: a new month starts a new ledger with the full fee", async () => {
    const october = "2026-10";
    savedDocs[`branch_monthly_fees/${branchMonthlyFeeId(BRANCH, october)}`] = {
      branchId: BRANCH,
      monthKey: october,
      feePaise: 250000,
      feeCollectedPaise: 250000,
      razorpayOrders: 5,
      razorpayEarnedPaise: 250000,
      razorpayRefundedPaise: 0,
    };
    const novemberMs = Date.parse("2026-11-05T10:00:00Z");
    seedOrder("ord_new_month", { grandPaise: 100000, gatewayCreatedAtMs: novemberMs });
    await split("ord_new_month");
    const newLedger = ledger("2026-11");
    expect(newLedger).toBeTruthy();
    expect(newLedger.feePaise).toBe(250000);
    expect(newLedger.feeCollectedPaise).toBe(100000);
    // October's ledger is untouched.
    expect(ledger("2026-10").feeCollectedPaise).toBe(250000);
  });

  it("10: a fee changed mid-month applies from the next month only", async () => {
    // October's ledger froze a 3000-rupee fee.
    savedDocs[`branch_monthly_fees/${branchMonthlyFeeId(BRANCH, "2026-10")}`] = {
      branchId: BRANCH,
      monthKey: "2026-10",
      feePaise: 300000,
      feeCollectedPaise: 300000,
      razorpayOrders: 1,
      razorpayEarnedPaise: 300000,
      razorpayRefundedPaise: 0,
    };
    // The branch document now says 1000 rupees.
    seedBranch({ monthlyFee: 1000 });
    seedOrder("ord_oct", {
      grandPaise: 100000,
      gatewayCreatedAtMs: Date.parse("2026-10-20T10:00:00Z"),
    });
    await split("ord_oct");
    expect(ledger("2026-10").feeCollectedPaise).toBe(300000); // still met
    expect(savedDocs["orders/ord_oct"].monthlyFeeHold.holdPaise).toBe(0);

    seedOrder("ord_nov", {
      grandPaise: 100000,
      gatewayCreatedAtMs: Date.parse("2026-11-02T10:00:00Z"),
    });
    await split("ord_nov");
    expect(ledger("2026-11").feePaise).toBe(100000); // new fee
    expect(savedDocs["orders/ord_nov"].monthlyFeeHold.holdPaise).toBe(100000);
  });

  it("11: monthlyFee 0 holds nothing but still counts the stream", async () => {
    seedBranch({ monthlyFee: 0 });
    seedOrder("ord_free", { grandPaise: 100000 });
    expect((await split("ord_free")).state).toBe("transferred");
    const order = savedDocs["orders/ord_free"];
    expect(order.monthlyFeeHold.holdPaise).toBe(0);
    expect(order.monthlyFeeHold.branchTransferPaise).toBe(100000);
    expect(ledger().feePaise).toBe(0);
    expect(ledger().razorpayOrders).toBe(1);
    expect(ledger().razorpayEarnedPaise).toBe(100000);
  });

  it("12: an unlinked branch still gets its ledger, is flagged, and the order confirms", async () => {
    // The fee is already met this month, so there IS a payout owed — which an
    // unlinked branch cannot receive: flag it for a human, never fail the
    // customer.
    savedDocs[`branch_monthly_fees/${branchMonthlyFeeId(BRANCH, istMonthKey())}`] = {
      branchId: BRANCH,
      monthKey: istMonthKey(),
      feePaise: 250000,
      feeCollectedPaise: 250000,
      razorpayOrders: 3,
      razorpayEarnedPaise: 250000,
      razorpayRefundedPaise: 0,
    };
    seedBranch({ razorpayAccountId: "" });
    seedOrder("ord_unlinked", { grandPaise: 100000 });
    const outcome = await split("ord_unlinked");
    expect(outcome.state).toBe("flagged");
    const order = savedDocs["orders/ord_unlinked"];
    expect(order.routeTransferNeedsManualSettlement).toBe(true);
    expect(order.paymentStatus).toBe("completed");
    expect(ledger().feeCollectedPaise).toBe(250000);
    expect(ledger().razorpayOrders).toBe(4);
  });

  it("13: a corrupt monthlyFee flags manual settlement and still confirms", async () => {
    seedBranch({ monthlyFee: -50 });
    seedOrder("ord_corrupt_fee", { grandPaise: 100000 });
    const outcome = await split("ord_corrupt_fee");
    expect(outcome.state).toBe("flagged");
    const order = savedDocs["orders/ord_corrupt_fee"];
    expect(order.routeTransferNeedsManualSettlement).toBe(true);
    expect(order.monthlyFeeHold.holdPaise).toBe(0);
    expect(order.monthlyFeeHold.branchTransferPaise).toBe(0);
    expect(order.paymentStatus).toBe("completed");
    // Never counted as earnings.
    expect(ledger()).toBeUndefined();
  });

  it("22e: a late October payment processed in November lands on October", async () => {
    const octoberPaymentMs = Date.parse("2026-10-31T18:00:00Z"); // 23:30 IST, October
    seedOrder("ord_late", { grandPaise: 100000, gatewayCreatedAtMs: octoberPaymentMs });
    await split("ord_late");
    expect(ledger("2026-10")).toBeTruthy();
    expect(ledger("2026-10").feeCollectedPaise).toBe(100000);
    expect(ledger("2026-11")).toBeUndefined();
  });

  it("22f: the fee is read from the branch document, not the 60s cache", async () => {
    // Prime the cache with the old fee by pricing an order.
    const { resolveBranchPricingConfig } = await import("../src/modules/payments/branchPricing");
    seedBranch({ monthlyFee: 2500 });
    await resolveBranchPricingConfig(BRANCH);
    // Change the branch doc directly; the cache still says 2500.
    savedDocs[`branches/${BRANCH}`].monthlyFee = 100;
    seedOrder("ord_cache", { grandPaise: 100000 });
    await split("ord_cache");
    expect(savedDocs["orders/ord_cache"].monthlyFeeHold.holdPaise).toBe(10000);
    expect(ledger().feePaise).toBe(10000);
  });
});
