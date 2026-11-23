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

import { executeRouteSplit, retryPendingRouteTransfersWorker } from "../src/modules/payments/razorpay.service";
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

/**
 * Owner decision 2026-11-20 + GPT-6.2 Sol 2026-11-22: Route and per-order fee
 * holds are RETIRED in this version. The assertions below replace the old
 * "hold the first ₹2,500" expectations: no configuration, month, branch state
 * or repeated call may create a hold, a claim, or a gateway transfer.
 */
describe("retired per-order Route and fee hold", () => {
  const cases: Array<[string, Record<string, any>, Record<string, any>]> = [
    ["first capture of a month", { monthlyFee: 2500 }, { grandPaise: 100000 }],
    ["crossing the old monthly threshold", { monthlyFee: 2500 }, { grandPaise: 300000 }],
    ["zero configured fee", { monthlyFee: 0 }, { grandPaise: 100000 }],
    ["a later month", { monthlyFee: 2500 }, { grandPaise: 100000, gatewayCreatedAtMs: Date.parse("2026-10-31T18:31:00Z") }],
    ["an unlinked branch", {}, { grandPaise: 100000 }],
    ["a corrupt fee", { monthlyFee: -50 }, { grandPaise: 100000 }],
    ["a terminal order", { monthlyFee: 2500 }, { grandPaise: 100000, extra: { status: { code: "CANCELLED" } } }],
  ];

  it.each(cases)("never creates a hold or transfer: %s", async (_label, branch, order) => {
    seedBranch(branch);
    const id = `retired_${_label.replace(/\W+/g, "_")}`;
    seedOrder(id, order);
    const outcome = await split(id);
    expect(outcome.state).toBe("not_required");
    const after = savedDocs[`orders/${id}`];
    expect(after.monthlyFeeHold).toBeUndefined();
    expect(after.routeTransferStatus).toBeUndefined();
    expect(after.routeTransferClaimedAt).toBeUndefined();
    expect(after.payment?.routeTransfer).toBeUndefined();
    expect(ledger()).toBeUndefined();
  });

  it("is idempotent under concurrent verify/webhook-style replays", async () => {
    seedBranch({ monthlyFee: 2500 });
    seedOrder("parallel", { grandPaise: 100000 });
    const outcomes = await Promise.all([split("parallel"), split("parallel"), split("parallel")]);
    expect(outcomes.map((o) => o.state)).toEqual(["not_required", "not_required", "not_required"]);
    expect(savedDocs["orders/parallel"].monthlyFeeHold).toBeUndefined();
    expect(ledger()).toBeUndefined();
  });

  it("the retry worker claims nothing and contacts no provider", async () => {
    seedBranch({ monthlyFee: 2500 });
    seedOrder("pending", { grandPaise: 100000, extra: { routeTransferStatus: "pending_retry" } });
    const result = await retryPendingRouteTransfersWorker();
    expect(result).toEqual({ retriedCount: 0 });
    expect(savedDocs["orders/pending"].routeTransferStatus).toBe('pending_retry');
  });

  it("keeps the pure month helpers available for statements", () => {
    expect(istMonthKey(new Date("2026-10-31T18:29:59Z"))).toBe("2026-10");
    expect(istMonthKey(new Date("2026-10-31T18:30:00Z"))).toBe("2026-11");
    expect(branchMonthlyFeeId("b", "2026-11")).toBe("b_2026-11");
  });
});

describe("M1 month-end settlement mode (GPT-6.2 Sol 2026-11-22)", () => {
  it('cannot re-enable Route or fee holds with any legacy configuration', async () => {
    vi.stubEnv('FR_SETTLEMENT_MODE','per_order_route');
    try {
      seedBranch({monthlyFee:100});
      savedDocs['app_config/fr_settlement']={mode:'per_order_route'};
      seedOrder('retired',{grandPaise:100000});
      expect((await split('retired')).state).toBe('not_required');
      expect(savedDocs['orders/retired'].monthlyFeeHold).toBeUndefined();
      expect(ledger()).toBeUndefined();
    } finally { vi.unstubAllEnvs(); }
  });
  it("skips the fee hold and sends no new Route transfer", async () => {
    const prev = process.env.FR_SETTLEMENT_MODE;
    process.env.FR_SETTLEMENT_MODE = "month_end";
    try {
      seedOrder("ord_month_end", { grandPaise: 100000 });
      const outcome = await split("ord_month_end");
      expect(outcome.state).toBe("not_required");
      const order = savedDocs["orders/ord_month_end"];
      expect(order.monthlyFeeHold).toBeUndefined();
      expect(order.routeTransferStatus).toBeUndefined();
      expect(order.payment.routeTransfer).toBeUndefined();
      expect(ledger()).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.FR_SETTLEMENT_MODE;
      else process.env.FR_SETTLEMENT_MODE = prev;
    }
  });
});
