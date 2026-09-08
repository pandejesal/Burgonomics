import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// These tests drive the REAL handleRazorpayWebhook (not a local
// re-implementation): replay idempotency via the audit-claim doc, stale-claim
// takeover, and unmatched-payment parking.

const { mockDb, savedDocs } = vi.hoisted(() => {
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
  };
  return { mockDb, savedDocs };
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

import { handleRazorpayWebhook } from "../src/modules/payments/webhookHandler";
import { config } from "../src/config/env";

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

describe("Razorpay webhook idempotency (real handler)", () => {
  // Explicit sandbox opt-in (was auto-mock): this suite exercises
  // idempotency, not auth — auth-denial is covered by webhook.reject.test.ts
  // (S1) and env.failclosed.test.ts (S3). Fail-closed env defaults to live.
  let prevPg = false;
  let prevPp = false;
  beforeEach(() => {
    prevPg = config.mock.paymentGateway;
    prevPp = config.mock.petpoojaPos;
    config.mock.paymentGateway = true;
    config.mock.petpoojaPos = true;
  });
  afterEach(() => {
    config.mock.paymentGateway = prevPg;
    config.mock.petpoojaPos = prevPp;
  });

  beforeEach(() => {
    for (const key of Object.keys(savedDocs)) delete savedDocs[key];
    savedDocs["orders/order_replay_1"] = {
      id: "order_replay_1",
      branchId: "branch_surat_01",
      customerPhone: "+91 90000 00000",
      paymentStatus: "pending",
    };
  });

  it("processes once: a replayed event returns already_processed with no second KOT push", async () => {
    const first = mockReqRes(capturedPayload("evt_replay_9"));
    await handleRazorpayWebhook(first.req, first.res);
    expect(first.out().statusCode).toBe(200);
    expect(first.out().body).toMatchObject({ status: "ok" });

    const firstKotId = savedDocs["orders/order_replay_1"].petpoojaOrderId;
    expect(firstKotId).toMatch(/^pp_kot_/);
    expect(savedDocs["orders/order_replay_1"].paymentStatus).toBe("completed");

    const second = mockReqRes(capturedPayload("evt_replay_9"));
    await handleRazorpayWebhook(second.req, second.res);
    expect(second.out().statusCode).toBe(200);
    expect(second.out().body).toMatchObject({ status: "already_processed" });
    // No second KOT push happened — the order doc is untouched by the replay.
    expect(savedDocs["orders/order_replay_1"].petpoojaOrderId).toBe(firstKotId);
  });

  it("takes over a stale claim (previous attempt died without completing)", async () => {
    savedDocs["payment_audits/aud_evt_evt_stale_1"] = {
      eventId: "evt_stale_1",
      claimedAt: Date.now() - 20 * 60 * 1000,
      completedAt: null,
    };
    const call = mockReqRes(capturedPayload("evt_stale_1"));
    await handleRazorpayWebhook(call.req, call.res);
    expect(call.out().body).toMatchObject({ status: "ok" });
    expect(savedDocs["orders/order_replay_1"].paymentStatus).toBe("completed");
  });

  it("parks captured money with no order linkage in unmatched_payments (never drops it)", async () => {
    const payload = capturedPayload("evt_orphan_1");
    delete payload.payload.payment.entity.notes;
    const call = mockReqRes(payload);
    await handleRazorpayWebhook(call.req, call.res);
    expect(call.out().statusCode).toBe(200);
    expect(savedDocs["unmatched_payments/ump_evt_orphan_1"]).toMatchObject({
      razorpayPaymentId: "pay_test_123",
      status: "needs_review",
    });
  });

  it("parks processed refunds with no matching order in unmatched_payments (never drops money)", async () => {
    const payload = {
      id: "evt_refund_orphan_1",
      event: "refund.processed",
      payload: {
        refund: {
          entity: {
            id: "rfnd_orphan_1",
            payment_id: "pay_ghost_1",
            amount: 9900,
            currency: "INR",
          },
        },
      },
    };
    const call = mockReqRes(payload);
    await handleRazorpayWebhook(call.req, call.res);
    expect(call.out().statusCode).toBe(200);
    expect(savedDocs["unmatched_payments/ump_refund_evt_refund_orphan_1"]).toMatchObject({
      razorpayPaymentId: "pay_ghost_1",
      refundId: "rfnd_orphan_1",
      status: "needs_review",
      reason: "refund_no_match",
    });
  });
});
