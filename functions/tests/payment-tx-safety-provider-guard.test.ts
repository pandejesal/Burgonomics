import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as crypto from "crypto";

/**
 * T3.4 — NO provider call inside a Firestore transaction (Phase 3 MONEY).
 *
 * Firestore `runTransaction` callbacks are re-executed on contention: a
 * network/provider call inside one is a double-POST window and an unbounded
 * latency block. This is a RUNTIME guard, not a static lint claim: every
 * exercised money path runs inside a rig that tracks transaction depth, and
 * EVERY provider-call seam (the direct `https.request` refund POST, the
 * Razorpay SDK transfer/reconcile methods) records "called inside a tx" as a
 * violation. A violation fails the test loudly.
 *
 * What is explicitly NOT claimed: exactly-once behavior. Transactions can be
 * re-executed; the guarantee is bounded to "no provider call occurs while a
 * transaction callback is on the stack".
 */
const { mockDb, docs, writeLog, commitStats, monitor, control } = vi.hoisted(() => {
  process.env.OTP_HMAC_SECRET = "test_otp_money_t34";

  type Rec = { data: any; version: number };
  const docs = new Map<string, Rec>();
  const writeLog: Array<{ path: string; data: any; merge?: boolean }> = [];
  const commitStats = { commits: 0 };
  const monitor = {
    txDepth: 0,
    violations: [] as string[],
    providerCalls: [] as string[],
    recordProviderCall(name: string): void {
      monitor.providerCalls.push(name);
      if (monitor.txDepth > 0) monitor.violations.push(name);
    },
  };

  const versionOf = (path: string): number => docs.get(path)?.version ?? -1;
  const dataOf = (path: string): any => docs.get(path)?.data;
  const applyWrite = (path: string, data: any, merge?: boolean) => {
    const existing = docs.get(path);
    const next = merge && existing ? { ...existing.data, ...data } : { ...data };
    docs.set(path, { data: next, version: (existing?.version ?? 0) + 1 });
    writeLog.push({ path, data: next, merge: !!merge });
  };

  const runTransaction = async (fn: (tx: any) => any): Promise<any> => {
    monitor.txDepth += 1;
    try {
      const reads = new Map<string, number>();
      const writes: Array<{ path: string; data: any; merge?: boolean }> = [];
      const tx = {
        get: async (ref: any) => {
          reads.set(ref.path, versionOf(ref.path));
          const data = dataOf(ref.path);
          return { exists: data !== undefined, data: () => data, ref };
        },
        set: (ref: any, data: any, opts?: any) =>
          void writes.push({ path: ref.path, data, merge: !!opts?.merge }),
        update: (ref: any, data: any) => void writes.push({ path: ref.path, data, merge: true }),
      };
      const result = await fn(tx);
      for (const w of writes) applyWrite(w.path, w.data, w.merge);
      commitStats.commits += 1;
      return result;
    } finally {
      monitor.txDepth -= 1;
    }
  };

  const docRef = (colName: string, docId: string) => {
    const path = `${colName}/${docId}`;
    return {
      id: docId,
      path,
      get: async () => ({
        exists: dataOf(path) !== undefined,
        data: () => dataOf(path),
        ref: docRef(colName, docId),
      }),
      set: async (data: any, opts?: any) => applyWrite(path, data, !!opts?.merge),
      create: async (data: any) => {
        if (docs.has(path)) {
          const err: any = new Error("ALREADY_EXISTS: Document already exists");
          err.code = 6;
          throw err;
        }
        applyWrite(path, data, false);
      },
      update: async (data: any) => applyWrite(path, data, true),
    };
  };

  const getByPath = (obj: any, path: string) =>
    obj != null && Object.prototype.hasOwnProperty.call(obj, path)
      ? obj[path]
      : path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);

  const collectionMock = (colName: string) => {
    const filters: Array<{ field: string; value: any }> = [];
    const q: any = {
      where: (field: string, _op: string, value: any) => {
        filters.push({ field, value });
        return q;
      },
      limit: () => q,
      get: async () => {
        const found = [...docs.entries()]
          .filter(([path]) => path.startsWith(`${colName}/`))
          .filter(([, rec]) => filters.every((f) => getByPath(rec.data, f.field) === f.value))
          .map(([path, rec]) => {
            const [col, id] = path.split("/");
            return { id, ref: docRef(col, id), data: () => rec.data };
          });
        return { empty: found.length === 0, size: found.length, docs: found };
      },
      doc: (docId?: string) =>
        docRef(colName, docId || `auto_${Math.random().toString(36).slice(2, 8)}`),
    };
    return q;
  };

  const mockDb: any = { collection: collectionMock, runTransaction };

  return {
    mockDb,
    docs,
    writeLog,
    commitStats,
    monitor,
    control: {
      seed: (path: string, data: any) => applyWrite(path, data, false),
      reset: () => {
        docs.clear();
        writeLog.length = 0;
        commitStats.commits = 0;
        monitor.providerCalls.length = 0;
        monitor.violations.length = 0;
        monitor.txDepth = 0;
      },
    },
  };
});

vi.mock("firebase-admin", () => {
  const FieldValue = {
    serverTimestamp: () => "MOCK_TIMESTAMP",
    increment: (n: number) => n,
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

const { httpsHijack } = vi.hoisted(() => {
  let responder: ((options: any, cb: any) => any) | null = null;
  return {
    httpsHijack: {
      setResponder: (fn: ((options: any, cb: any) => any) | null) => {
        responder = fn;
      },
      respond: (options: any, cb: any): any => {
        if (responder) return responder(options, cb);
        throw new Error("FORBIDDEN_GATEWAY_HTTP_IN_PAYMENT_TEST (no responder installed)");
      },
    },
  };
});

vi.mock("https", async (importOriginal) => {
  const actual: any = await importOriginal();
  const hijacked = (...args: any[]) => httpsHijack.respond(args[0], args[1]);
  return {
    ...actual,
    default: { ...actual.default, request: hijacked },
    request: hijacked,
  };
});

import * as https from "https";
import { EventEmitter } from "events";
import {
  autoRefund,
  executeRouteSplit,
  __setPaymentsFetchForTests,
} from "../src/modules/payments/razorpay.service";
import { __setRazorpayClientForTests } from "../src/modules/payments/razorpayClient";
import { handleRazorpayWebhook } from "../src/modules/payments/webhookHandler";
import { config } from "../src/config/env";

const WHSEC = "whsec_t34_txsafety_test_only";
const WH_CONFIRMED_LATER = "\u2014"; // placeholder, not used

/** Guarded stub client: every SDK surface is a provider-call seam. */
const stubClient = () => {
  const wrap = (name: string, impl: (...a: any[]) => any) =>
    (...a: any[]) => {
      monitor.recordProviderCall(name);
      return impl(...a);
    };
  return {
    payments: {
      fetch: wrap("payments.fetch", async () => ({})),
      fetchTransfer: wrap("payments.fetchTransfer", async (pid: string) => ({ items: [] })),
      transfer: wrap(
        "payments.transfer",
        async () => ({ id: "trf_t34", amount: 9000, status: "processed" })
      ),
    },
    orders: {
      create: wrap("orders.create", async () => ({ id: "order_t34" })),
    },
  };
};

/** Requests share guard: https.request to the gateway is a provider seam. */

function fakeHttpsResponder(paymentId: string) {
  return (options: any, callback: (res: any) => void) => {
    monitor.recordProviderCall(`https.request ${options.hostname}${options.path}`);
    const req: any = new EventEmitter();
    (req as any).setTimeout = (_ms: number, cb: any) => req.on("timeout", cb);
    req.write = () => {};
    req.end = () => {
      process.nextTick(() => {
        const res: any = new EventEmitter();
        (res as any).statusCode = 200;
        callback(res);
        process.nextTick(() => {
          res.emit(
            "data",
            Buffer.from(
              JSON.stringify({
                id: "rfnd_t34_live",
                payment_id: paymentId,
                amount: 25000,
                status: "processed",
              })
            )
          );
          res.emit("end");
        });
      });
    };
    return req;
  };
}

function mockReqRes(payload: any) {
  const rawBody = JSON.stringify(payload);
  const req: any = {
    headers: {
      "x-razorpay-signature": crypto
        .createHmac("sha256", WHSEC)
        .update(rawBody)
        .digest("hex"),
      "x-razorpay-event-id": payload.id,
    },
    rawBody: Buffer.from(rawBody, "utf8"),
    body: payload,
  };
  let statusCode = 0;
  const res: any = {
    status: (code: number) => {
      statusCode = code;
      return { json: () => undefined };
    },
  };
  return { req, res, out: () => ({ statusCode }), rawBody };
}

const capturedPayload = (eventId: string, orderId: string, paymentId: string) => ({
  id: eventId,
  event: "payment.captured",
  created_at: Math.floor(Date.now() / 1000),
  payload: {
    payment: {
      entity: {
        id: paymentId,
        order_id: "order_t34_gateway",
        amount: 25000,
        currency: "INR",
        notes: { orderId, branchId: "branch_t34" },
      },
    },
  },
});

const pricedOrder = (orderId: string) => ({
  id: orderId,
  branchId: "branch_t34",
  orderType: "delivery",
  customerId: `cust_${orderId}`,
  pricing: { grandTotal: 250, split: { branchTransferPaise: 9000, brandRoyaltyPaise: 1000 } },
  paymentStatus: "pending",
  status: { code: "PENDING", label: "Order placed", kind: "upcoming", terminal: false },
  items: [],
});

describe("T3.4 — provider calls never inside a Firestore transaction (runtime guard)", () => {
  let prevPg: boolean;
  let prevPp: boolean;
  let prevWhsec: string | undefined;
  let prevKeyId: string | undefined;
  let prevKeySecret: string | undefined;

  beforeEach(() => {
    control.reset();
    prevPg = config.mock.paymentGateway;
    prevPp = config.mock.petpoojaPos;
    prevWhsec = config.razorpay.webhookSecret;
    prevKeyId = config.razorpay.keyId;
    prevKeySecret = config.razorpay.keySecret;
    config.mock.paymentGateway = false; // LIVE branch — provider seams actually exercised
    config.mock.petpoojaPos = true;
    config.razorpay.webhookSecret = WHSEC;
    config.razorpay.keyId = "test_key_t34";
    config.razorpay.keySecret = "test_secret_t34";
    httpsHijack.setResponder(fakeHttpsResponder("pay_t34_R"));
    __setRazorpayClientForTests(stubClient());
    __setPaymentsFetchForTests(async () => ({}) as any);
  });

  afterEach(() => {
    httpsHijack.setResponder(null);
    __setRazorpayClientForTests(null);
    __setPaymentsFetchForTests(null);
    config.mock.paymentGateway = prevPg;
    config.mock.petpoojaPos = prevPp;
    config.razorpay.webhookSecret = prevWhsec;
    config.razorpay.keyId = prevKeyId;
    config.razorpay.keySecret = prevKeySecret;
    expect(monitor.txDepth).toBe(0); // no leaked depth between tests
  });

  it("webhook confirm transaction: no provider seam consumed inside the confirm tx", async () => {
    control.seed("orders/order_t34_a", pricedOrder("order_t34_a"));
    const call = mockReqRes(capturedPayload("evt_t34_1", "order_t34_a", "pay_t34_1"));
    await handleRazorpayWebhook(call.req, call.res);
    expect(call.out().statusCode).toBe(200);
    expect(docs.get("orders/order_t34_a")!.data.paymentStatus).toBe("completed");
    expect(monitor.violations).toEqual([]);
    // Sensitive to execution: the split + KOT legs below the tier may call
    // stubs, but the webhook confirm tx itself consumed NO provider seam.
  });

  it("executeRouteSplit: fetchTransfer/transfer stubs run OUTSIDE the claim transaction", async () => {
    control.seed("orders/order_t34_b", {
      ...pricedOrder("order_t34_b"),
      paymentStatus: "completed",
      payment: { status: "completed", razorpayPaymentId: "pay_t34_P", capturedAmountPaise: 25000 },
    });
    control.seed("branches/branch_t34", { razorpayAccountId: "acc_t34_branch" });
    const before = monitor.providerCalls.length;
    const outcome = await executeRouteSplit({
      orderRef: mockDb.collection("orders").doc("order_t34_b") as any,
      orderId: "order_t34_b",
      orderData: docs.get("orders/order_t34_b")!.data,
      razorpayPaymentId: "pay_t34_P",
      capturedAmountPaise: 25000,
    });
    expect(outcome.state).toBe("transferred");
    const splitCalls = monitor.providerCalls.slice(before);
    expect(splitCalls).toContain("payments.fetchTransfer");
    expect(splitCalls).toContain("payments.transfer");
    // THE GUARD itself: none of those ran while a transaction was on the stack.
    expect(monitor.violations).toEqual([]);
  });

  it("autoRefund LIVE: the refund POST (https.request) runs OUTSIDE both claim and record transactions", async () => {
    control.seed("orders/order_t34_r", {
      ...pricedOrder("order_t34_r"),
      paymentStatus: "completed",
      payment: { status: "completed", razorpayPaymentId: "pay_t34_R", capturedAmountPaise: 25000 },
    });
    const out = await autoRefund(
      {
        orderId: "order_t34_r",
        razorpayPaymentId: "pay_t34_R",
        refundRequestId: "req_t34_live_rfnd_1",
      },
      null
    );
    expect(out).toMatchObject({ id: "rfnd_t34_live", payment_id: "pay_t34_R" });
    expect(monitor.violations).toEqual([]);
    expect(monitor.providerCalls.some((c) => c.startsWith("https.request api.razorpay.in"))).toBe(
      true
    );
    expect(docs.get("orders/order_t34_r")!.data.refundStatus).toBe("refunded");
  });
});
