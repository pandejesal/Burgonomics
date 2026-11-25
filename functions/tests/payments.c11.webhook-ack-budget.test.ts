import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * C11 / A1-payments findings 1 and 3 — the webhook's 5-second budget and the
 * 15-minute "stale" reject.
 *
 * Finding 1 (Critical): `payment.captured` confirmed the order and then
 * awaited `pushOrderToPetpooja` inline (15 s abort) before answering. Razorpay
 * gives the endpoint 5 s, retries a failed delivery, and disables the endpoint
 * after 24 h of failures. Contract pinned here:
 *   1. the money transaction queues the POS sync (`petpoojaStatus` /
 *      `petpoojaSyncStatus: "pending_retry"`) and answers 2xx WITHOUT any POS
 *      call in the request;
 *   2. the existing retry worker still rings the kitchen exactly once, and a
 *      second capture event for the same payment does not queue a second KOT.
 *
 * Finding 3 (High): the freshness reject answered 401 and DELETED the claim, so
 * a signed delivery that arrived >15 min late (deploy/outage) was permanently
 * dead. Contract pinned here:
 *   3. a signature-verified FIRST delivery older than the 15-minute window is
 *      processed (2xx) and keeps its claim doc as evidence;
 *   4. a delivery beyond the absolute upper bound is parked visibly and still
 *      answered 2xx (so the endpoint is not disabled), never 401.
 *
 * NO NETWORK: mock gateway, live-POS mode with a throwing fetch stub. Any POS
 * egress from the webhook fails the test instead of reaching a vendor.
 *
 * HONESTY LIMIT: in-process datastore model; proves channel behaviour, not
 * real Firebase cross-process transaction semantics.
 */
const { mockDb, docs, writeLog, control } = vi.hoisted(() => {
  process.env.OTP_HMAC_SECRET = "test_otp_c11_ack_budget";

  type Rec = { data: any; version: number };
  const docs = new Map<string, Rec>();
  const writeLog: Array<{ path: string; data: any; merge?: boolean }> = [];

  const versionOf = (path: string): number => docs.get(path)?.version ?? -1;
  const dataOf = (path: string): any => docs.get(path)?.data;
  const applyWrite = (path: string, data: any, merge?: boolean) => {
    const existing = docs.get(path);
    const next = merge && existing ? { ...existing.data, ...data } : { ...data };
    docs.set(path, { data: next, version: (existing?.version ?? 0) + 1 });
    writeLog.push({ path, data, merge: !!merge });
  };

  let commitTail: Promise<unknown> = Promise.resolve();
  const enqueueCommit = <T,>(task: () => T): Promise<T> => {
    const run = commitTail.then(task, task);
    commitTail = run.then(() => undefined, () => undefined);
    return run;
  };

  const runTransaction = (fn: (tx: any) => any): Promise<any> => {
    const attempt = async (): Promise<any> => {
      for (let tries = 0; tries <= 8; tries++) {
        const readVersions = new Map<string, number>();
        const writes: Array<{ path: string; data: any; merge?: boolean }> = [];
        const tx = {
          get: async (ref: any) => {
            readVersions.set(ref.path, versionOf(ref.path));
            const data = dataOf(ref.path);
            return { exists: data !== undefined, data: () => data, ref };
          },
          set: (ref: any, data: any, opts?: any) =>
            void writes.push({ path: ref.path, data, merge: !!opts?.merge }),
          update: (ref: any, data: any) => void writes.push({ path: ref.path, data, merge: true }),
        };
        const result = await fn(tx);
        const conflicted = () =>
          [...readVersions.entries()].some(([path, v]) => versionOf(path) !== v);
        if (writes.length === 0) {
          if (conflicted()) continue;
          return result;
        }
        const outcome = await enqueueCommit(() => {
          if (conflicted()) return { conflicted: true as const };
          for (const w of writes) applyWrite(w.path, w.data, w.merge);
          return { conflicted: false as const, result };
        });
        if (!outcome.conflicted) return outcome.result;
      }
      const err: any = new Error("SIMULATED_TRANSACTION_CONTENTION: retries exhausted");
      err.code = "ABORTED";
      throw err;
    };
    return attempt();
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
      delete: async () => void docs.delete(path),
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
      orderBy: () => q,
      startAfter: () => q,
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
    control: {
      seed: (path: string, data: any, merge = false) => applyWrite(path, data, merge),
      reset: () => {
        docs.clear();
        writeLog.length = 0;
      },
    },
  };
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

import { handleRazorpayWebhook } from "../src/modules/payments/webhookHandler";
import { config } from "../src/config/env";

const GATEWAY_ORDER = "rzp_c11_ack";
const AMOUNT_PAISE = 25000;

function seedConfirmableOrder(orderId: string, over: Record<string, any> = {}) {
  control.seed(`orders/${orderId}`, {
    id: orderId,
    branchId: "branch_c11_ack",
    orderType: "delivery",
    customerId: "cust_c11_ack",
    paymentStatus: "pending",
    payment: { method: "online", status: "pending" },
    pricing: { grandTotal: AMOUNT_PAISE / 100 },
    status: { code: "PLACED", label: "Order placed", kind: "upcoming", terminal: false },
    routeTransferStatus: "transferred",
    createdAt: Date.now(),
    ...over,
  });
  control.seed(`payment_intents/intent_${orderId}`, {
    razorpayOrderId: GATEWAY_ORDER,
    orderId,
    amountPaise: AMOUNT_PAISE,
    branchId: "branch_c11_ack",
    customerId: "cust_c11_ack",
    createdAtMs: Date.now(),
    expiresAtMs: Date.now() + 60_000,
  });
}

const capturedPayload = (
  eventId: string,
  orderId: string,
  paymentId: string,
  over: Record<string, any> = {}
) => ({
  id: eventId,
  event: "payment.captured",
  created_at: Math.floor(Date.now() / 1000),
  payload: {
    payment: {
      entity: {
        id: paymentId,
        order_id: GATEWAY_ORDER,
        amount: AMOUNT_PAISE,
        currency: "INR",
        notes: { orderId, branchId: "branch_c11_ack" },
      },
    },
  },
  ...over,
});

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

/** Writes that ASSIGN a POS acceptance marker for this order. */
const kotMarkerWrites = (orderId: string) =>
  writeLog.filter(
    (e) =>
      e.path === `orders/${orderId}` &&
      e.data != null &&
      Object.prototype.hasOwnProperty.call(e.data, "petpoojaOrderId")
  );

describe("C11 webhook ack budget and late deliveries", () => {
  let prevPg: boolean;
  let prevPp: boolean;
  let fetchStub: any;

  beforeEach(() => {
    control.reset();
    prevPg = config.mock.paymentGateway;
    prevPp = config.mock.petpoojaPos;
    config.mock.paymentGateway = true; // no gateway egress
    // LIVE POS path with a real store id: the only way to push is an actual
    // in-handler POS call, which is exactly what must no longer happen.
    config.mock.petpoojaPos = false;
    control.seed("branches/branch_c11_ack", {
      petpoojaStoreId: "res_c11_ack",
      petpoojaTaxes: [
        { id: "3928", name: "CGST", rate: 2.5 },
        { id: "3929", name: "SGST", rate: 2.5 },
      ],
    });
    fetchStub = vi.fn(async () => {
      throw new Error("UNEXPECTED POS CALL — the webhook must not await the POS");
    });
    vi.stubGlobal("fetch", fetchStub);
  });

  afterEach(() => {
    config.mock.paymentGateway = prevPg;
    config.mock.petpoojaPos = prevPp;
    vi.unstubAllGlobals();
  });

  it("confirms the money, queues the POS sync and answers without any POS call", async () => {
    seedConfirmableOrder("ord_c11_ack");
    writeLog.length = 0;

    const call = mockReqRes(capturedPayload("evt_c11_ack", "ord_c11_ack", "pay_c11_ack"));
    await handleRazorpayWebhook(call.req, call.res);

    expect(call.out().statusCode).toBe(200);
    const order = docs.get("orders/ord_c11_ack")!.data;
    expect(order.paymentStatus).toBe("completed");
    expect(order.status).toMatchObject({ code: "CONFIRMED" });
    // Queued in the money transaction for the existing retry worker.
    expect(order.petpoojaStatus).toBe("pending_retry");
    expect(order.petpoojaSyncStatus).toBe("pending_retry");
    // Nothing was rung in the request, and nothing reached the POS.
    expect(order.petpoojaOrderId).toBeUndefined();
    expect(kotMarkerWrites("ord_c11_ack")).toHaveLength(0);
    expect(fetchStub).not.toHaveBeenCalled();

    // A second capture event for the same payment (different event id) must not
    // ring or duplicate anything either: the event-id claim dedupes within the
    // lease, and the queue stays a single row for the worker.
    const again = mockReqRes(
      capturedPayload("evt_c11_ack_2", "ord_c11_ack", "pay_c11_ack")
    );
    await handleRazorpayWebhook(again.req, again.res);
    expect(again.out().statusCode).toBe(200);
    expect(kotMarkerWrites("ord_c11_ack")).toHaveLength(0);
    expect(fetchStub).not.toHaveBeenCalled();

    // Once the worker (or an operator) records the POS acceptance, a further
    // redelivery must leave that acceptance exactly as it is.
    control.seed("orders/ord_c11_ack", { petpoojaOrderId: "pp_c11_once" }, true);
    // The seed is test setup, not a handler write: stop counting from here so
    // only writes the third delivery causes are inspected.
    writeLog.length = 0;
    const third = mockReqRes(
      capturedPayload("evt_c11_ack_3", "ord_c11_ack", "pay_c11_ack")
    );
    await handleRazorpayWebhook(third.req, third.res);
    expect(third.out().statusCode).toBe(200);
    expect(docs.get("orders/ord_c11_ack")!.data.petpoojaOrderId).toBe("pp_c11_once");
    expect(kotMarkerWrites("ord_c11_ack")).toHaveLength(0);
  });

  it("a FIRST signed delivery older than the freshness window is processed, not 401'd", async () => {
    seedConfirmableOrder("ord_c11_late");
    writeLog.length = 0;

    const payload = capturedPayload("evt_c11_late", "ord_c11_late", "pay_c11_late");
    payload.created_at = Math.floor((Date.now() - 45 * 60 * 1000) / 1000); // 45 min late

    const call = mockReqRes(payload);
    await handleRazorpayWebhook(call.req, call.res);

    expect(call.out().statusCode).toBe(200);
    const order = docs.get("orders/ord_c11_late")!.data;
    expect(order.paymentStatus).toBe("completed");
    expect(order.status).toMatchObject({ code: "CONFIRMED" });

    // The claim doc survives as evidence and is completed.
    const claim = docs.get("payment_audits/aud_evt_evt_c11_late")?.data;
    expect(claim).toBeTruthy();
    expect(claim.completedAt).toBeTruthy();
    expect(claim.lateDeliveryAt).toBeTruthy();
  });

  it("a delivery beyond the absolute bound is parked and still answered 2xx", async () => {
    seedConfirmableOrder("ord_c11_ancient");

    const payload = capturedPayload("evt_c11_ancient", "ord_c11_ancient", "pay_c11_ancient");
    payload.created_at = Math.floor((Date.now() - 90 * 24 * 60 * 60 * 1000) / 1000);

    const call = mockReqRes(payload);
    await handleRazorpayWebhook(call.req, call.res);

    // 200: Razorpay must not keep retrying (and must not disable the endpoint).
    expect(call.out().statusCode).toBe(200);
    const order = docs.get("orders/ord_c11_ancient")!.data;
    expect(order.paymentStatus).toBe("pending");
    const park = docs.get("unmatched_payments/ump_evt_c11_ancient")?.data;
    expect(park).toMatchObject({
      status: "needs_review",
      reason: "late_delivery_beyond_bound",
    });
    const claim = docs.get("payment_audits/aud_evt_evt_c11_ancient")?.data;
    expect(claim.completedAt).toBeTruthy();
    expect(claim.lateDeliveryParkedAt).toBeTruthy();
  });
});
