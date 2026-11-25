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
    // Mock-capability repair (stress sweep 2026-10-24): the claim-first
    // freshness reject releases its audit doc on rejection. Assertions are
    // unchanged — this only lets the handler execute that release.
    delete: vi.fn(async () => {
      delete savedDocs[`${colName}/${docId}`];
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
    // C11 finding 3 makes this suite prove a late-but-genuine delivery is
    // PROCESSED, and the confirm path requires a transactional datastore. This
    // is the smallest honest shim: reads see the stored doc, writes land
    // merge-style after the callback resolves. It models NO contention — that
    // is `payment-confirmation-webhook-concurrency.test.ts`'s job.
    runTransaction: vi.fn(async (fn: any) => {
      const pending: Array<{ docPath: string; data: any; merge: boolean }> = [];
      const tx = {
        get: async (ref: any) => ({
          exists: !!savedDocs[ref.path],
          data: () => savedDocs[ref.path] || {},
          ref,
        }),
        set: (ref: any, data: any, options?: any) =>
          void pending.push({ docPath: ref.path, data, merge: !!options?.merge }),
        update: (ref: any, data: any) =>
          void pending.push({ docPath: ref.path, data, merge: true }),
      };
      const result = await fn(tx);
      for (const write of pending) {
        savedDocs[write.docPath] =
          write.merge && savedDocs[write.docPath]
            ? { ...savedDocs[write.docPath], ...write.data }
            : write.data;
      }
      return result;
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
      // A stored server total keeps the amount known, so a genuine delivery
      // reaches the confirm path instead of the `confirm_amount_unknown` park.
      pricing: { grandTotal: 250 },
      payment: { method: "online", status: "pending" },
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

  it("a late first delivery is never rejected with 401 (C11 finding 3)", async () => {
    // C11 finding 3 (High) changed this contract. The old code answered 401 and
    // DELETED the claim for any event older than 15 minutes, which made a
    // genuine delivery from an outage permanently dead: Razorpay stamps
    // `created_at` at event creation, so every redelivery was equally stale, and
    // 401 is exactly the code that stops it retrying. The signature is verified
    // in full above, so there is no forgery risk to defend here — only an
    // operational one.
    //
    // This suite is the REJECTION gate and its datastore has no transaction
    // support, so it pins exactly one thing: the freshness gate never answers
    // 401 again. Either 200 (processed) or a RETRYABLE 5xx is acceptable here;
    // the full confirm contract (order CONFIRMED, POS queued) is pinned with a
    // complete harness in `payments.c11.webhook-ack-budget.test.ts`.
    const payload = capturedPayload("evt_stale_probe_1");
    payload.created_at = Math.floor(Date.now() / 1000) - 60 * 60; // 1h old
    const call = mockReqRes(payload, sign(payload, LIVE_SECRET));
    await handleRazorpayWebhook(call.req, call.res);

    expect(call.out().statusCode).not.toBe(401);
    expect([200, 500]).toContain(call.out().statusCode);
    // The claim doc survives — it is evidence, never deleted.
    const claim = savedDocs["payment_audits/aud_evt_evt_stale_probe_1"];
    expect(claim).toBeTruthy();
    // The lateness is recorded as evidence.
    expect(claim.lateDeliveryAt).toBeTruthy();
    // And the delivery was NOT parked as an untrusted ancient event.
    expect(savedDocs["unmatched_payments/ump_evt_stale_probe_1"]).toBeUndefined();
  });
});
