import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as crypto from "crypto";

// Negative gate for Batch 1 S1 webhook hardening: forged signatures,
// missing event ids, and stale replays are denied with 401 (never 500)
// and perform zero order writes.

const { mockDb, savedDocs } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  const docRef = (colName: string, docId: string) => ({
    id: docId,
    path: `${colName}/${docId}`,
    get: vi.fn(async () => ({
      exists: !!savedDocs[`${colName}/${docId}`],
      data: () => savedDocs[`${colName}/${docId}`] || {},
      ref: docRef(colName, docId),
    })),
    set: vi.fn(async (data: any, options?: any) => {
      const docPath = `${colName}/${docId}`;
      savedDocs[docPath] =
        options?.merge && savedDocs[docPath] ? { ...savedDocs[docPath], ...data } : data;
    }),
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
      where: (_field: string, _op: string, _value: any) => ({
        limit: (_n: number) => ({
          get: vi.fn(async () => ({ empty: true, docs: [] })),
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

const LIVE_SECRET = "whsec_negative_probe_secret";

function mockReqRes(payload: any, signature?: string) {
  const req: any = { headers: signature ? { "x-razorpay-signature": signature } : {}, body: payload };
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

// Handler falls back to JSON.stringify(req.body) when req.rawBody is absent.
const sign = (payload: any, secret: string) =>
  crypto.createHmac("sha256", secret).update(JSON.stringify(payload)).digest("hex");

const capturedPayload = (eventId: string) => ({
  id: eventId,
  event: "payment.captured",
  created_at: Math.floor(Date.now() / 1000),
  payload: {
    payment: {
      entity: {
        id: "pay_negprobe_1",
        amount: 25000,
        currency: "INR",
        notes: { orderId: "order_negprobe_1", branchId: "branch_surat_01" },
      },
    },
  },
});

function orderWrites() {
  return Object.keys(savedDocs).filter(
    (k) => k.startsWith("orders/") || k.startsWith("payment_audits/") || k.startsWith("unmatched_payments/")
  );
}

describe("Razorpay webhook rejection (fail-closed)", () => {
  const prevMock = config.mock.paymentGateway;
  const prevSecret = config.razorpay.webhookSecret;

  beforeEach(() => {
    for (const key of Object.keys(savedDocs)) delete savedDocs[key];
    savedDocs["orders/order_negprobe_1"] = {
      id: "order_negprobe_1",
      branchId: "branch_surat_01",
      customerPhone: "+91 90000 00000",
      paymentStatus: "pending",
    };
    // Live verification path: forged signatures must be checkable.
    (config.mock as any).paymentGateway = false;
    (config.razorpay as any).webhookSecret = LIVE_SECRET;
  });

  afterEach(() => {
    (config.mock as any).paymentGateway = prevMock;
    (config.razorpay as any).webhookSecret = prevSecret;
  });

  it("forged signature → 401 with no order write", async () => {
    const before = orderWrites();
    const call = mockReqRes(capturedPayload("evt_forged_1"), "deadbeef".repeat(8));
    await handleRazorpayWebhook(call.req, call.res);
    expect(call.out().statusCode).toBe(401);
    expect(call.out().statusCode).not.toBe(500);
    expect(orderWrites()).toEqual(before);
    expect(savedDocs["orders/order_negprobe_1"].paymentStatus).toBe("pending");
  });

  it("missing payload.id → 401 with no order write (no Date.now fallback)", async () => {
    const payload: any = capturedPayload("evt_missing_id_1");
    delete payload.id;
    const before = orderWrites();
    const call = mockReqRes(payload, sign(payload, LIVE_SECRET));
    await handleRazorpayWebhook(call.req, call.res);
    expect(call.out().statusCode).toBe(401);
    expect(call.out().body).toMatchObject({ error: "Missing webhook event id" });
    expect(orderWrites()).toEqual(before);
    expect(savedDocs["orders/order_negprobe_1"].paymentStatus).toBe("pending");
  });

  it("stale replay → 401 with no order write", async () => {
    const payload = capturedPayload("evt_stale_probe_1");
    payload.created_at = Math.floor(Date.now() / 1000) - 60 * 60; // 1h old
    const before = orderWrites();
    const call = mockReqRes(payload, sign(payload, LIVE_SECRET));
    await handleRazorpayWebhook(call.req, call.res);
    expect(call.out().statusCode).toBe(401);
    expect(orderWrites()).toEqual(before);
    expect(savedDocs["orders/order_negprobe_1"].paymentStatus).toBe("pending");
  });
});
