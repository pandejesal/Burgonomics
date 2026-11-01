import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * F5a — a settlement must never be lost when the webhook dies after CONFIRMED.
 *
 * The webhook confirms and only then runs the split. If the process dies in
 * between (and the kitchen moves the order on), the old code left no transfer
 * status at all, so nothing ever retried it and the branch was never paid.
 *
 * The confirm transaction now stamps `routeTransferStatus: "pending_retry"` +
 * `routeTransferRetryCount: 0` when no lane exists, and the retry worker
 * finishes the order using F5 (hold exactly once, stamped amount, one transfer).
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

  const q = (col: string, filters: Array<{ field: string; op: string; value: any }> = [], max = Infinity): any => ({
    where: (field: string, op: string, value: any) =>
      q(col, [...filters, { field, op, value }], max),
    orderBy: () => q(col, filters, max),
    limit: (n: number) => q(col, filters, n),
    startAfter: () => q(col, filters, max),
    get: async () => {
      const docs = Object.keys(savedDocs)
        .filter((path) => path.startsWith(`${col}/`))
        .filter((path) =>
          filters.every(({ field, op, value }) => {
            const data = savedDocs[path] || {};
            const actual = field
              .split(".")
              .reduce((node: any, key: string) => node?.[key], data);
            if (op === "==") return actual === value;
            if (op === "<=") return Number(actual) <= Number(value);
            if (op === ">=") return Number(actual) >= Number(value);
            return false;
          })
        )
        .slice(0, max)
        .map((path) => {
          const id = path.slice(col.length + 1);
          return { id, ref: docRef(col, id), data: () => savedDocs[path] };
        });
      return { empty: docs.length === 0, docs };
    },
  });

  const mockDb: any = {
    collection: (col: string) => ({
      ...q(col),
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

import { webhookConfirmSettlementFields } from "../src/modules/payments/webhookHandler";
import { retryPendingRouteTransfersWorker } from "../src/modules/payments/routeTransfers";
import { istMonthKey, branchMonthlyFeeId } from "../src/modules/payments/monthlyFee";
import { config } from "../src/config/env";

const BRANCH = "branch_settle";
let prevMock: any;

beforeEach(() => {
  for (const key of Object.keys(savedDocs)) delete savedDocs[key];
  prevMock = { mock: { ...config.mock } };
  config.mock.paymentGateway = true;
});

afterEach(() => {
  config.mock = { ...prevMock.mock };
});

describe("F5a durable settlement marker", () => {
  it("stamps pending_retry + retryCount 0 when the order has no lane yet", () => {
    expect(webhookConfirmSettlementFields({})).toEqual({
      routeTransferStatus: "pending_retry",
      routeTransferRetryCount: 0,
    });
    expect(webhookConfirmSettlementFields({ status: { code: "PLACED" } })).toEqual({
      routeTransferStatus: "pending_retry",
      routeTransferRetryCount: 0,
    });
  });

  it("never overwrites an existing settlement lane", () => {
    for (const status of [
      "transferred",
      "transferring",
      "pending_retry",
      "not_required",
      "needs_reconciliation",
      "failed",
    ]) {
      expect(
        webhookConfirmSettlementFields({ routeTransferStatus: status })
      ).toEqual({});
    }
  });

  it("22a: the worker finishes a webhook-confirmed order after the crash — hold and transfer exactly once", async () => {
    const monthKey = istMonthKey();
    // ₹2,000 already collected this month; ₹1,000 earnings → ₹500 held, ₹500 paid.
    savedDocs[`branch_monthly_fees/${branchMonthlyFeeId(BRANCH, monthKey)}`] = {
      branchId: BRANCH,
      monthKey,
      feePaise: 250000,
      feeCollectedPaise: 200000,
      razorpayOrders: 4,
      razorpayEarnedPaise: 200000,
      razorpayRefundedPaise: 0,
    };
    savedDocs[`branches/${BRANCH}`] = { razorpayAccountId: "acc_settle01" };
    // Exactly the doc the webhook leaves behind if it died after CONFIRMED:
    // paid + CONFIRMED-in-later-state (PREPARING), no settlement lane yet.
    savedDocs["orders/ord_dead_webhook"] = {
      id: "ord_dead_webhook",
      branchId: BRANCH,
      status: { code: "PREPARING", terminal: false },
      paymentStatus: "completed",
      payment: {
        razorpayPaymentId: "pay_dead_webhook",
        capturedAmountPaise: 100000,
      },
      pricing: {
        grandTotal: 1000,
        split: { branchTransferPaise: 100000, courierFeePaise: 0 },
      },
      routeTransferStatus: "pending_retry",
      routeTransferRetryCount: 0,
    };

    const first = await retryPendingRouteTransfersWorker();
    expect(first.retriedCount).toBe(1);
    const order = savedDocs["orders/ord_dead_webhook"];
    expect(order.monthlyFeeHold).toMatchObject({
      earnedPaise: 100000,
      holdPaise: 50000,
      branchTransferPaise: 50000,
    });
    expect(order["payment.routeTransfer"].amount).toBe(50000);
    expect(order.routeTransferStatus).toBe("transferred");
    expect(savedDocs[`branch_monthly_fees/${branchMonthlyFeeId(BRANCH, monthKey)}`]).toMatchObject({
      feeCollectedPaise: 250000,
      razorpayOrders: 5,
      razorpayEarnedPaise: 300000,
    });
    // The customer's order keeps its later state.
    expect(order.status.code).toBe("PREPARING");

    // A second worker tick finds nothing pending_retry: no second hold, no
    // second transfer.
    const second = await retryPendingRouteTransfersWorker();
    expect(second.retriedCount).toBe(0);
    expect(savedDocs[`branch_monthly_fees/${branchMonthlyFeeId(BRANCH, monthKey)}`].feeCollectedPaise).toBe(250000);
    expect(savedDocs["orders/ord_dead_webhook"]["payment.routeTransfer"].amount).toBe(50000);
  });
});
