import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

// B2-S1 service-level rig: Firestore is mocked per-file; the live Razorpay
// fetch is stubbed via the __setPaymentsFetchForTests seam (no network, no
// SDK mocking — the pure-HMAC suite above is unaffected).
const { mockDb, savedDocs } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  const docRef = (colName: string, docId: string) => ({
    id: docId,
    path: `${colName}/${docId}`,
    get: vi.fn(async () => ({
      exists: !!savedDocs[`${colName}/${docId}`],
      data: () => savedDocs[`${colName}/${docId}`] || {},
      ref: {
        set: vi.fn(async (data: any) => {
          const p = `${colName}/${docId}`;
          savedDocs[p] = { ...(savedDocs[p] || {}), ...data };
        }),
      },
    })),
    set: vi.fn(async (data: any, options?: any) => {
      const p = `${colName}/${docId}`;
      savedDocs[p] =
        options?.merge && savedDocs[p] ? { ...savedDocs[p], ...data } : data;
    }),
  });
  const mockDb: any = {
    collection: (colName: string) => ({
      doc: (docId: string) => docRef(colName, docId),
      // P1-F: verifyPayment now resolves the durable payment intent by gateway
      // order id, so the rig needs the same equality query the real SDK has.
      where: (field: string, _op: string, value: any) => {
        const filters: Array<[string, any]> = [[field, value]];
        const q: any = {
          where: (f: string, _op2: string, v: any) => {
            filters.push([f, v]);
            return q;
          },
          limit: () => q,
          get: async () => {
            const docs = Object.entries(savedDocs)
              .filter(([p]) => p.startsWith(`${colName}/`))
              .filter(([, d]) =>
                filters.every(([f, v]) => {
                  const nested = f.split(".").reduce((o: any, k) => (o == null ? undefined : o[k]), d);
                  return nested === v;
                })
              )
              .map(([p, d]) => ({
                id: p.slice(colName.length + 1),
                data: () => d,
              }));
            return { empty: docs.length === 0, docs };
          },
        };
        return q;
      },
    }),
    runTransaction: vi.fn(async (fn: any) =>
      fn({
        get: (ref: any) => ref.get(),
        // Real Firestore accepts the doc ref here; the mock docRef carries a
        // top-level set (NOT snapshot.ref.set — that belongs to get() results).
        set: (ref: any, data: any, opts?: any) => ref.set(data, opts),
      })
    ),
  };
  return { mockDb, savedDocs };
});

vi.mock("firebase-admin", () => {
  const FieldValue = {
    serverTimestamp: () => "MOCK_TIMESTAMP",
    increment: (n: number) => n,
    arrayUnion: (item: any) => [item],
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

import {
  verifyPayment,
  autoRefund,
  __setPaymentsFetchForTests,
  __setRefundPostForTests,
} from "../src/modules/payments/razorpay.service";
import { calculateRouteSplit, attemptRouteTransfer } from "../src/modules/payments/routeTransfers";
import { getRazorpayKeyId } from "../src/modules/payments/razorpayClient";
import { config } from "../src/config/env";
import { istMonthKey } from "../src/modules/payments/monthlyFee";


describe("r5 real verify/autoRefund settlement proofs", () => {
  let prevMock: boolean;
  const seedIntent = (id: string, amountPaise = 10000) => {
    savedDocs[`payment_intents/intent_${id}`] = {
      razorpayOrderId: "order_rzp_1", orderId: id, amountPaise,
      branchId: "branch_test_1", createdAtMs: Date.now(), expiresAtMs: Date.now() + 60_000,
    };
  };
  beforeEach(() => {
    for (const key of Object.keys(savedDocs)) delete savedDocs[key];
    __setPaymentsFetchForTests(null);
    __setRefundPostForTests(null);
    prevMock = config.mock.paymentGateway;
    config.mock.paymentGateway = true;
    process.env.OTP_HMAC_SECRET = "test_r5_otp_secret";
  });
  afterEach(() => {
    __setPaymentsFetchForTests(null);
    __setRefundPostForTests(null);
    config.mock.paymentGateway = prevMock;
  });

  it("verifyPayment marks a capture pending until the provider confirms", async () => {
    savedDocs["orders/order_r5_verify"] = {
      branchId: "branch_test_1", orderType: "delivery",
      status: { code: "PLACED" }, paymentStatus: "pending",
      pricing: { grandTotal: 100, split: { branchTransferPaise: 9000 } },
      payment: { status: "pending" },
    };
    seedIntent("order_r5_verify");
    await verifyPayment({
      orderId: "order_r5_verify", razorpayOrderId: "order_rzp_1",
      razorpayPaymentId: "pay_r5_verify", razorpaySignature: "mock_signature_valid",
    });
    const doc = savedDocs["orders/order_r5_verify"];
    expect(doc.settlementCaptureState).toBe("pending");
    expect(doc.settlementCaptureUnresolved).toBe(true);
  });

  const seedCaptured = (id: string, paymentId: string) => {
    savedDocs[`orders/${id}`] = {
      branchId: "branch_test_1", orderType: "delivery",
      payment: { razorpayPaymentId: paymentId, capturedAmountPaise: 10000, status: "completed" },
      paymentStatus: "completed", status: { code: "CONFIRMED" },
      pricing: { grandTotal: 100 }, settlementProcessedRefunds: {},
    };
  };

  it("a pending real autoRefund deducts nothing from the processed map", async () => {
    config.mock.paymentGateway = false;
    __setRefundPostForTests(async () => ({ id: "rfnd_r5_pending", status: "pending", amount: 5000 }));
    seedCaptured("order_r5_pending_refund", "pay_r5_pending");
    await autoRefund({
      orderId: "order_r5_pending_refund", razorpayPaymentId: "pay_r5_pending",
      amountRupees: 50, refundRequestId: 'rr_r5_pending_001',
    } as any);
    const doc = savedDocs["orders/order_r5_pending_refund"];
    expect(Object.values(doc.settlementProcessedRefunds || {})).toEqual([]);
  });

  it("a failed-status 2xx refund POST never enters the processed map", async () => {
    config.mock.paymentGateway = false;
    __setRefundPostForTests(async () => ({ id: "rfnd_r5_failed", status: "failed", amount: 5000 }));
    seedCaptured("order_r5_failed_post", "pay_r5_failed_post");
    await autoRefund({
      orderId: "order_r5_failed_post", razorpayPaymentId: "pay_r5_failed_post",
      amountRupees: 50, refundRequestId: 'rr_r5_failed_001',
    } as any);
    const doc = savedDocs["orders/order_r5_failed_post"];
    expect(Object.values(doc.settlementProcessedRefunds || {}).reduce((a: number, v: any) => a + Number(v), 0)).toBe(0);
  });
});
