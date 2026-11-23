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


describe("cycle-9 staging capture resolution (real webhook handler)", () => {
  let prevPg: boolean;
  let prevPp: boolean;
  beforeEach(() => {
    for (const k of Object.keys(savedDocs)) delete savedDocs[k];
    prevPg = config.mock.paymentGateway;
    prevPp = config.mock.petpoojaPos;
    config.mock.paymentGateway = true;
    config.mock.petpoojaPos = true;
  });
  afterEach(() => { config.mock.paymentGateway = prevPg; config.mock.petpoojaPos = prevPp; });

  it("a signed payment.captured event resolves an already-confirmed order", async () => {
    savedDocs["orders/c9_capture"] = {
      id: "c9_capture", branchId: "branch_surat_01",
      status: { code: "CONFIRMED" }, paymentStatus: "completed",
      payment: { razorpayPaymentId: "pay_c9", razorpayOrderId: "order_c9", capturedAmountPaise: 21900, status: "completed" },
      settlementCaptureState: "unknown", settlementCaptureUnresolved: true,
      pricing: { grandTotal: 219 }, currency: "INR",
    };
    // Razorpay docs /my/webhooks/payments.mdx "Payment Captured" sample shape.
    const eventSec = Math.floor(Date.now() / 1000);
    const payload = {
      id: "evt_c9_capture", event: "payment.captured",
      created_at: eventSec,
      payload: { payment: { entity: {
        id: "pay_c9", order_id: "order_c9", amount: 21900, currency: "INR",
        captured: true, created_at: 1795463360,
        notes: { orderId: "c9_capture", branchId: "branch_surat_01" },
      } } },
    };
    const r = mockReqRes(payload);
    await handleRazorpayWebhook(r.req, r.res);
    expect(r.out().statusCode).toBe(200);
    const doc = savedDocs["orders/c9_capture"];
    expect(doc.settlementEffectiveAtMs).toBe(eventSec * 1000);
    expect(doc.settlementCaptureState).toBe("confirmed");
    expect(doc.settlementCaptureUnresolved).toBe(false);
  });
});
