import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Refund-only / transfer-only deliveries carry no `payment.entity`. The audit
 * summary used to be written as
 *   payloadSummary: { paymentId: payload.payload.payment.entity?.id, orderId: ... }
 * which is `{ paymentId: undefined, orderId: undefined }` for those events.
 * Firestore rejects explicit undefined, so the audit write threw AFTER the
 * money event had been processed: the handler answered 500, the claim never
 * completed, and Razorpay retried forever.
 *
 * The mock below refuses undefined exactly like Firestore does (including
 * nested maps), so this regression fails on the old code and pins both the
 * 200 and the completed claim on the fixed code.
 */

const { mockDb, savedDocs } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};

  const assertNoUndefined = (value: any, fieldPath: string) => {
    if (value === undefined) {
      throw new Error(
        `Cannot use "undefined" as a Firestore value (found in field "${fieldPath}")`
      );
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const [k, v] of Object.entries(value)) {
        assertNoUndefined(v, fieldPath ? `${fieldPath}.${k}` : k);
      }
    }
    if (Array.isArray(value)) {
      value.forEach((v, i) => assertNoUndefined(v, `${fieldPath}[${i}]`));
    }
  };

  const docRef = (col: string, id: string) => {
    const path = `${col}/${id}`;
    return {
      id,
      path,
      get: vi.fn(async () => ({
        exists: Object.prototype.hasOwnProperty.call(savedDocs, path),
        data: () => savedDocs[path],
      })),
      set: vi.fn(async (data: any, opts?: any) => {
        assertNoUndefined(data, "");
        savedDocs[path] =
          opts?.merge && savedDocs[path] ? { ...savedDocs[path], ...data } : data;
      }),
      create: vi.fn(async (data: any) => {
        assertNoUndefined(data, "");
        if (Object.prototype.hasOwnProperty.call(savedDocs, path)) {
          const err: any = new Error("ALREADY_EXISTS: Document already exists");
          err.code = 6;
          throw err;
        }
        savedDocs[path] = data;
      }),
      update: vi.fn(async (data: any) => {
        assertNoUndefined(data, "");
        savedDocs[path] = { ...(savedDocs[path] || {}), ...data };
      }),
      delete: vi.fn(async () => {
        delete savedDocs[path];
      }),
    };
  };

  const mockDb: any = {
    collection: (col: string) => ({
      doc: (id: string) => docRef(col, id),
      where: (_field: string, _op: string, _value: any) => ({
        limit: (_n: number) => ({
          get: vi.fn(async () => ({ empty: true, docs: [] })),
        }),
      }),
    }),
    runTransaction: vi.fn(async (fn: any) =>
      fn({
        get: (ref: any) => ref.get(),
        set: (ref: any, data: any, opts?: any) => ref.set(data, opts),
      })
    ),
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

const refundOnlyPayload = () => ({
  id: "evt_refund_only_1",
  event: "refund.processed",
  payload: {
    // Deliberately NO payload.payment.entity — refund-only delivery shape.
    refund: {
      entity: {
        id: "rfnd_only_1",
        payment_id: "pay_orphan_1",
        amount: 5000,
        currency: "INR",
      },
    },
  },
});

describe("Razorpay webhook — refund-only event completes its audit claim", () => {
  let prevPg = false;
  let prevPp = false;

  beforeEach(() => {
    for (const key of Object.keys(savedDocs)) delete savedDocs[key];
  });

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

  it("answers 200, records the unmatched refund, and completes the claim without undefined audit fields", async () => {
    const call = mockReqRes(refundOnlyPayload());
    await handleRazorpayWebhook(call.req, call.res);

    expect(call.out().statusCode).toBe(200);
    expect(call.out().body).toMatchObject({ status: "ok" });

    // The event really was processed (not silently acked).
    expect(savedDocs["unmatched_payments/ump_refund_evt_refund_only_1"]).toMatchObject({
      event: "refund.processed",
      razorpayPaymentId: "pay_orphan_1",
      refundId: "rfnd_only_1",
      reason: "refund_no_match",
      status: "needs_review",
    });

    const audit = savedDocs["payment_audits/aud_evt_evt_refund_only_1"];
    expect(audit).toBeTruthy();
    expect(audit.completedAt).toBeTruthy();
    // Absent identifiers are OMITTED (not written as undefined / not invented).
    expect(audit.payloadSummary).toEqual({});
    expect("paymentId" in audit.payloadSummary).toBe(false);
    expect("orderId" in audit.payloadSummary).toBe(false);

    // The completed claim still dedupes a redelivery.
    const replay = mockReqRes(refundOnlyPayload());
    await handleRazorpayWebhook(replay.req, replay.res);
    expect(replay.out().statusCode).toBe(200);
    expect(replay.out().body).toMatchObject({ status: "already_processed" });
  });
});
