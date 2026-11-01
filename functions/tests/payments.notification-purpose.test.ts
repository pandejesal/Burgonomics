import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// N-08 — payment/order webhook customer notices.
//
// The money paths are untouched; only the notification integration is pinned:
//  - purpose `orderUpdates`, category `order`, recipient = the order owner;
//  - `targetId` = the order id (inbox pointer), and the OS copy carries NO
//    order id, customer name, or other private identifier;
//  - a duplicate refund delivery does not announce the same money twice.
//
// HONESTY LIMIT: in-process document store, mocked transport layer, no provider
// SDK call, no network, no secret, no money.

const { mockDb, savedDocs, pushToCustomer } = vi.hoisted(() => {
  process.env.OTP_HMAC_SECRET = "test_otp_payment_notifications";
  const savedDocs: Record<string, any> = {};
  const pushToCustomer = vi.fn(async (..._args: any[]) => undefined);

  const docRef = (colName: string, docId: string) => {
    const full = `${colName}/${docId}`;
    return {
      id: docId,
      path: full,
      get: vi.fn(async () => ({ exists: !!savedDocs[full], data: () => savedDocs[full] || {} })),
      set: vi.fn(async (data: any, options?: any) => {
        savedDocs[full] = options?.merge && savedDocs[full] ? { ...savedDocs[full], ...data } : data;
      }),
      create: vi.fn(async (data: any) => {
        if (savedDocs[full]) {
          const err: any = new Error("ALREADY_EXISTS");
          err.code = 6;
          throw err;
        }
        savedDocs[full] = data;
      }),
      update: vi.fn(async (data: any) => {
        savedDocs[full] = { ...(savedDocs[full] || {}), ...data };
      }),
    };
  };

  const getPath = (obj: any, path: string) =>
    path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);

  const mockDb = {
    collection: (colName: string) => ({
      doc: (docId?: string) => docRef(colName, docId || `mock_${Math.random().toString(36).slice(2, 8)}`),
      where: (field: string, _op: string, value: any) => ({
        limit: (_n: number) => ({
          get: vi.fn(async () => {
            const docs = Object.entries(savedDocs)
              .filter(([k, v]) => k.startsWith("orders/") && getPath(v, field) === value)
              .map(([k, v]) => ({ id: k.split("/")[1], ref: docRef("orders", k.split("/")[1]), data: () => v }));
            return { empty: docs.length === 0, docs };
          }),
        }),
      }),
    }),
    runTransaction: vi.fn(async (fn: (tx: any) => Promise<any>) =>
      fn({
        get: (ref: any) => ref.get(),
        set: (ref: any, data: any, opts?: any) => ref.set(data, opts),
        update: (ref: any, data: any) => ref.update(data),
      })
    ),
  };

  return { mockDb, savedDocs, pushToCustomer };
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

// Only the notifications-core sender is replaced: this asserts the request the
// payment paths build, not how FCM is called.
vi.mock("../src/modules/notifications/fcmClient", () => ({
  pushToCustomer: pushToCustomer,
  writeCustomerInboxDoc: vi.fn(async () => true),
  getUnreadCount: vi.fn(async () => 0),
  sendFcmMessage: vi.fn(async () => true),
  sendMulticastFcm: vi.fn(async () => ({ successCount: 0, failureCount: 0, prunedTokens: [] })),
  FCM_SEND_TIMEOUT_MS: 10_000,
}));

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

const failedEvent = (eventId: string, orderId: string, paymentId: string) => ({
  id: eventId,
  event: "payment.failed",
  payload: {
    payment: {
      entity: { id: paymentId, amount: 25000, currency: "INR", notes: { orderId } },
    },
  },
});

const refundEvent = (eventId: string, refundId: string, paymentId: string, amountPaise: number) => ({
  id: eventId,
  event: "refund.processed",
  payload: {
    refund: { entity: { id: refundId, payment_id: paymentId, amount: amountPaise, currency: "INR" } },
  },
});

interface SentNotice {
  uid: string;
  title: string;
  body: string;
  data: Record<string, string>;
  opts: { purpose?: string };
}

function sentNotices(): SentNotice[] {
  return pushToCustomer.mock.calls.map((call: any[]) => ({
    uid: call[0],
    title: call[1],
    body: call[2],
    data: call[3],
    opts: call[4] || {},
  }));
}

describe("payment/order webhook customer notices (N-08)", () => {
  let prevPg = false;
  let prevPp = false;
  beforeEach(() => {
    for (const key of Object.keys(savedDocs)) delete savedDocs[key];
    vi.clearAllMocks();
    prevPg = config.mock.paymentGateway;
    prevPp = config.mock.petpoojaPos;
    config.mock.paymentGateway = true;
    config.mock.petpoojaPos = true;
  });
  afterEach(() => {
    config.mock.paymentGateway = prevPg;
    config.mock.petpoojaPos = prevPp;
  });

  it("classifies a failed payment as orderUpdates for the order owner, with no private ids in copy", async () => {
    savedDocs["orders/order_n08_fail"] = {
      id: "order_n08_fail",
      customerId: "cust_n08",
      customerName: "Asha Patel",
      paymentStatus: "pending",
      payment: { razorpayPaymentId: "pay_n08_fail" },
    };

    const call = mockReqRes(failedEvent("evt_n08_fail", "order_n08_fail", "pay_n08_fail"));
    await handleRazorpayWebhook(call.req, call.res);

    expect(call.out().statusCode).toBe(200);
    // Money truth unchanged.
    expect(savedDocs["orders/order_n08_fail"].paymentStatus).toBe("failed");

    expect(pushToCustomer).toHaveBeenCalledTimes(1);
    const [notice] = sentNotices();
    expect(notice.uid).toBe("cust_n08");
    expect(notice.opts.purpose).toBe("orderUpdates");
    expect(notice.data).toEqual({ type: "payment_failed", targetId: "order_n08_fail" });
    // OS copy: generic. No order id, no name, no payment id.
    expect(notice.body).not.toContain("order_n08_fail");
    expect(notice.body).not.toContain("Asha");
    expect(notice.body).not.toContain("pay_n08_fail");
    expect(notice.title).not.toContain("order_n08_fail");
  });

  it("classifies a new refund as orderUpdates with targetId = order id", async () => {
    savedDocs["orders/order_n08_refund"] = {
      id: "order_n08_refund",
      customerId: "cust_n08",
      paymentStatus: "completed",
      payment: { razorpayPaymentId: "pay_n08_refund", status: "completed", capturedAmountPaise: 30000 },
    };

    const call = mockReqRes(refundEvent("evt_n08_refund", "rfnd_n08", "pay_n08_refund", 5000));
    await handleRazorpayWebhook(call.req, call.res);

    expect(call.out().statusCode).toBe(200);
    expect(pushToCustomer).toHaveBeenCalledTimes(1);
    const [notice] = sentNotices();
    expect(notice.uid).toBe("cust_n08");
    expect(notice.opts.purpose).toBe("orderUpdates");
    expect(notice.data).toEqual({ type: "refund_processed", targetId: "order_n08_refund" });
    expect(notice.body).not.toContain("order_n08_refund");
    expect(notice.body).not.toContain("rfnd_n08");
    // The amount the customer actually got stays in the copy.
    expect(notice.body).toContain("50");
  });

  it("does not re-announce a duplicate refund delivery", async () => {
    savedDocs["orders/order_n08_dupe"] = {
      id: "order_n08_dupe",
      customerId: "cust_n08",
      paymentStatus: "completed",
      payment: { razorpayPaymentId: "pay_n08_dupe", status: "completed", capturedAmountPaise: 30000 },
    };

    const first = mockReqRes(refundEvent("evt_n08_dupe_1", "rfnd_n08_dupe", "pay_n08_dupe", 5000));
    await handleRazorpayWebhook(first.req, first.res);

    // Replay under a NEW event id but the same refund id: still one notice.
    const replay = mockReqRes(refundEvent("evt_n08_dupe_2", "rfnd_n08_dupe", "pay_n08_dupe", 5000));
    await handleRazorpayWebhook(replay.req, replay.res);

    expect(replay.out().statusCode).toBe(200);
    expect(pushToCustomer).toHaveBeenCalledTimes(1);
  });

  it("skips the notice when the order has no resolvable owner", async () => {
    savedDocs["orders/order_n08_guest"] = {
      id: "order_n08_guest",
      paymentStatus: "pending",
      payment: { razorpayPaymentId: "pay_n08_guest" },
    };

    const call = mockReqRes(failedEvent("evt_n08_guest", "order_n08_guest", "pay_n08_guest"));
    await handleRazorpayWebhook(call.req, call.res);

    expect(call.out().statusCode).toBe(200);
    expect(pushToCustomer).not.toHaveBeenCalled();
  });
});
