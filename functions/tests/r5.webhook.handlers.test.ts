import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// These tests drive the REAL handleRazorpayWebhook (not a local
// re-implementation): replay idempotency via the audit-claim doc, stale-claim
// takeover, and unmatched-payment parking.

const { mockDb, savedDocs, notifySpy } = vi.hoisted(() => {
  // The webhook confirm path now satisfies the delivery-OTP invariant (B6/C12),
  // and getOtpHmacSecret() is FAIL-CLOSED, so this suite must provide the
  // dedicated secret exactly as a real deployment does (functions/.env sets it;
  // it is one of env.ts's REQUIRED_SECRETS). Without this, a delivery confirm
  // would throw instead of minting the handover hash.
  process.env.OTP_HMAC_SECRET = "test_otp_replay_webhook";
  // Notification boundary spy: the refund branch calls
  // dispatchCustomerAccountNotification once per NEW refund id. Hoisted so the
  // vi.mock factory below can close over the same instance. Hoisting two
  // independent vi.hoisted calls would break the shared mockDb/savedDocs
  // closure, so the spy lives in this one.
  const notifySpy = vi.fn(async (_request: any) => ({ outcome: "unknown" as const }));
  const savedDocs: Record<string, any> = {};
  const docRef = (colName: string, docId: string) => ({
    id: docId,
    path: `${colName}/${docId}`,
    get: vi.fn(async () => ({
      exists: !!savedDocs[`${colName}/${docId}`],
      data: () => savedDocs[`${colName}/${docId}`] || {},
      // orderPush.ts mock path writes through orderDoc.ref
      ref: docRef(colName, docId),
    })),
    set: vi.fn(async (data: any, options?: any) => {
      const docPath = `${colName}/${docId}`;
      savedDocs[docPath] =
        options?.merge && savedDocs[docPath] ? { ...savedDocs[docPath], ...data } : data;
    }),
    // Mirrors Firestore create(): fails when the doc already exists.
    create: vi.fn(async (data: any) => {
      const docPath = `${colName}/${docId}`;
      if (savedDocs[docPath]) {
        const err: any = new Error("ALREADY_EXISTS: Document already exists");
        err.code = 6;
        throw err;
      }
      savedDocs[docPath] = data;
    }),
    update: vi.fn(async (data: any) => {
      const docPath = `${colName}/${docId}`;
      savedDocs[docPath] = { ...(savedDocs[docPath] || {}), ...data };
    }),
  });
  const mockDb = {
    collection: (colName: string) => ({
      doc: (docId?: string) => docRef(colName, docId || `mock_${Math.random().toString(36).slice(2, 8)}`),
      // Refund branch queries orders by payment id; additive — existing tests
      // never call where(), so this only serves the refund-parking test.
      where: (field: string, op: string, value: any) => ({
        limit: (n: number) => ({
          get: vi.fn(async () => {
            const getPath = (obj: any, path: string) =>
              path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
            const docs = Object.entries(savedDocs)
              .filter(([k, v]) => k.startsWith("orders/") && getPath(v, field) === value)
              .map(([k, v]) => ({
                id: k.split("/")[1],
                ref: docRef(k.split("/")[0], k.split("/")[1]),
                data: () => v,
              }));
            return { empty: docs.length === 0, docs };
          }),
        }),
      }),
    }),
    // Transaction seam used by executeRouteSplit's claim and the
    // refund.processed per-refund ledger. Thin shim over the same doc mock.
    runTransaction: vi.fn(async (fn: (tx: any) => Promise<any>) =>
      fn({
        get: (ref: any) => ref.get(),
        set: (ref: any, data: any, opts?: any) => ref.set(data, opts),
      })
    ),
  };
  return { mockDb, savedDocs, notifySpy };
});

vi.mock("firebase-admin", () => {
  const FieldValue = {
    serverTimestamp: () => "MOCK_SERVER_TIMESTAMP",
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

// The refund branch announces a NEW refund id to the customer through this
// boundary. Spy on it only - the real dispatch would fan out to FCM, which this
// hermetic suite never touches. Everything else in the handler stays real.
vi.mock("../src/modules/tickets/supportNotifications", () => ({
  dispatchCustomerAccountNotification: (...args: unknown[]) => notifySpy(...args),
}));

import { handleRazorpayWebhook } from "../src/modules/payments/webhookHandler";
import { config } from "../src/config/env";
import { branchMonthlyFeeId, istMonthKey } from "../src/modules/payments/monthlyFee";

function mockReqRes(payload: any) {
  const req: any = { headers: {}, body: payload };
  let statusCode = 0;
  let body: any = null;
  const res: any = {
    status: (code: number) => {
      statusCode = code;
      return { json: (obj: any) => void (body = obj) };
    },
  };
  return { req, res, out: () => ({ statusCode, body }) };
}

const capturedPayload = (eventId: string) => ({
  id: eventId,
  event: "payment.captured",
  payload: {
    payment: {
      entity: {
        id: "pay_test_123",
        amount: 25000,
        currency: "INR",
        notes: { orderId: "order_replay_1", branchId: "branch_surat_01" },
      },
    },
  },
});


describe("r5 real-webhook settlement proofs", () => {
  let prevPg: boolean;
  let prevPp: boolean;
  beforeEach(() => {
    for (const key of Object.keys(savedDocs)) delete savedDocs[key];
    prevPg = config.mock.paymentGateway;
    prevPp = config.mock.petpoojaPos;
    config.mock.paymentGateway = true;
    config.mock.petpoojaPos = true;
  });
  afterEach(() => {
    config.mock.paymentGateway = prevPg;
    config.mock.petpoojaPos = prevPp;
  });

  it("payment.captured with captured_at resolves a pending capture through the real handler", async () => {
    const payload = {
      id: "evt_r5_capture",
      event: "payment.captured",
      payload: { payment: { entity: {
        id: "pay_r5", amount: 25000, currency: "INR",
        captured_at: 1767225600,
        notes: { orderId: "order_r5_capture", branchId: "branch_surat_01" },
      } } },
    };
    savedDocs["orders/order_r5_capture"] = {
      id: "order_r5_capture", branchId: "branch_surat_01",
      status: { code: "PLACED" }, paymentStatus: "pending",
      settlementCaptureState: "pending", settlementCaptureUnresolved: true,
      pricing: { grandTotal: 250 }, totals: { grandTotal: 250 },
    };
    const r = mockReqRes(payload);
    await handleRazorpayWebhook(r.req, r.res);
    expect(r.out().statusCode).toBe(200);
    const doc = savedDocs["orders/order_r5_capture"];
    expect(doc.settlementEffectiveAtMs).toBe(1767225600000);
    expect(doc.settlementCaptureUnresolved).toBe(false);
  });

  it("a replayed refund.processed promotes the processed map exactly once", async () => {
    savedDocs["orders/order_r5_refund"] = {
      id: "order_r5_refund", branchId: "branch_surat_01",
      payment: { razorpayPaymentId: "pay_r5_refund", status: "completed", capturedAmountPaise: 50000 },
      paymentChannel: "razorpay", refundLedger: { rf_r5: 500 },
      settlementProcessedRefunds: {}, refundedTotalPaise: 500,
      pricing: { grandTotal: 500 }, currency: "INR",
    };
    const payload = (id: string) => ({
      id, event: "refund.processed",
      payload: { refund: { entity: { id: "rf_r5", payment_id: "pay_r5_refund", amount: 500, currency: "INR" } } },
    });
    const first = mockReqRes(payload("evt_r5_ref_1"));
    await handleRazorpayWebhook(first.req, first.res);
    const replay = mockReqRes(payload("evt_r5_ref_2"));
    await handleRazorpayWebhook(replay.req, replay.res);
    expect(savedDocs["orders/order_r5_refund"].settlementProcessedRefunds).toEqual({ rf_r5: 500 });
  });

  it("refund.failed clears a processed entry through the real handler", async () => {
    savedDocs["orders/order_r5_failed"] = {
      id: "order_r5_failed", branchId: "branch_surat_01",
      payment: { razorpayPaymentId: "pay_r5_failed", status: "completed" },
      settlementProcessedRefunds: { rf_r5_fail: 500 }, refundLedger: { rf_r5_fail: 500 },
    };
    const payload = {
      id: "evt_r5_fail", event: "refund.failed",
      payload: { refund: { entity: {
        id: "rf_r5_fail", payment_id: "pay_r5_failed",
        notes: { orderId: "order_r5_failed" }, amount: 500, currency: "INR",
      } } },
    };
    const r = mockReqRes(payload);
    await handleRazorpayWebhook(r.req, r.res);
    expect(r.out().statusCode).toBe(200);
    expect(savedDocs["orders/order_r5_failed"].settlementProcessedRefunds).toEqual({});
  });
});
