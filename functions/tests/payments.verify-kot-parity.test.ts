import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * KOT PARITY — the client verify channel must tell the kitchen.
 *
 * Defect under test (LOCAL CODE VERIFIED before the fix): `verifyPayment` /
 * `finishVerifiedPayment` confirmed a captured payment but never called
 * `pushOrderToPetpooja`, while the `payment.captured` webhook did. A payer whose
 * webhook was delayed/dropped got a CONFIRMED order that never rang at the POS.
 *
 * Contract pinned here:
 *   1. a verify-only confirmation performs exactly ONE KOT push (a re-verify
 *      dedupes; it does not ring the kitchen again);
 *   2. a POS failure never un-confirms a captured payment — the order stays
 *      `paymentStatus: completed` and the POS sync lands in its existing
 *      `pending_retry` lane, with the caller still receiving payment success;
 *   3. webhook + verify together push ONCE, in either arrival order, because
 *      both channels use the same `petpoojaOrderId` / `petpoojaAcceptedNoId`
 *      dedupe inside `pushOrderToPetpooja`.
 *
 * NO NETWORK: mock gateway + mock Petpooja. `global.fetch` is stubbed to throw,
 * so any accidental real POS egress fails the test rather than reaching the
 * vendor. The one "push failure" case fails before the fetch (missing
 * branch.petpoojaStoreId) and asserts fetch was never called.
 *
 * HONESTY LIMIT: in-process datastore model; it proves channel behaviour, not
 * real Firebase cross-process transaction semantics.
 */
const { mockDb, docs, writeLog, control } = vi.hoisted(() => {
  process.env.OTP_HMAC_SECRET = "test_otp_kot_parity";

  type Rec = { data: any; version: number };
  const docs = new Map<string, Rec>();
  /** Every committed write event (path + merged payload), in arrival order. */
  const writeLog: Array<{ path: string; data: any; merge?: boolean }> = [];

  const versionOf = (path: string): number => docs.get(path)?.version ?? -1;
  const dataOf = (path: string): any => docs.get(path)?.data;
  const applyWrite = (path: string, data: any, merge?: boolean) => {
    const existing = docs.get(path);
    const next = merge && existing ? { ...existing.data, ...data } : { ...data };
    docs.set(path, { data: next, version: (existing?.version ?? 0) + 1 });
    // Log the PAYLOAD the writer sent (not the merged doc): counters must see
    // "did THIS write assign field X", not "did the doc already carry X".
    writeLog.push({ path, data, merge: !!merge });
  };

  // Commits run one at a time, in arrival order (Firestore commit semantics).
  let commitTail: Promise<unknown> = Promise.resolve();
  const enqueueCommit = <T>(task: () => T): Promise<T> => {
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
        const conflicted = (): boolean =>
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
    };
  };

  // Dotted top-level keys win over a nested walk so both payment shapes resolve.
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

import { verifyPayment } from "../src/modules/payments/razorpay.service";
import { handleRazorpayWebhook } from "../src/modules/payments/webhookHandler";
import { config } from "../src/config/env";

const GATEWAY_ORDER = "rzp_kot_parity_order";
const ORDER_AMOUNT_PAISE = 25000;

/** Amount + split are stored; the split is settled so this suite isolates KOT. */
function seedConfirmableOrder(orderId: string, branchId = "branch_kot") {
  control.seed(`orders/${orderId}`, {
    id: orderId,
    branchId,
    orderType: "delivery",
    customerId: "cust_kot",
    paymentStatus: "pending",
    pricing: { grandTotal: ORDER_AMOUNT_PAISE / 100 },
    status: { code: "PLACED", label: "Order placed", kind: "upcoming", terminal: false },
    routeTransferStatus: "transferred",
  });
}

const verifyParams = (orderId: string, paymentId: string) => ({
  orderId,
  razorpayOrderId: GATEWAY_ORDER,
  razorpayPaymentId: paymentId,
  razorpaySignature: "mock_signature_valid",
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

const capturedPayload = (eventId: string, orderId: string, paymentId: string, amountPaise: number) => ({
  id: eventId,
  event: "payment.captured",
  created_at: Math.floor(Date.now() / 1000),
  payload: {
    payment: {
      entity: {
        id: paymentId,
        order_id: GATEWAY_ORDER,
        amount: amountPaise,
        currency: "INR",
        notes: { orderId, branchId: "branch_kot" },
      },
    },
  },
});

/**
 * KOT writes that ASSIGN a POS acceptance marker (the only shape that proves a
 * push happened). A claim-only write (`petpoojaStatus: processing`) has no
 * `petpoojaOrderId` and is deliberately not counted.
 */
const kotMarkerWrites = (orderId: string) =>
  writeLog.filter(
    (entry) =>
      entry.path === `orders/${orderId}` &&
      entry.data != null &&
      Object.prototype.hasOwnProperty.call(entry.data, "petpoojaOrderId")
  );

describe("verify-path KOT parity", () => {
  let prevPaymentMock: boolean;
  let prevPetpoojaMock: boolean;
  let fetchStub: any;

  beforeEach(() => {
    control.reset();
    prevPaymentMock = config.mock.paymentGateway;
    prevPetpoojaMock = config.mock.petpoojaPos;
    config.mock.paymentGateway = true; // no gateway egress
    config.mock.petpoojaPos = true; // mock POS — no vendor egress
    fetchStub = vi.fn(async () => {
      throw new Error("UNEXPECTED NETWORK CALL — this suite must never reach a provider");
    });
    vi.stubGlobal("fetch", fetchStub);
  });

  afterEach(() => {
    config.mock.paymentGateway = prevPaymentMock;
    config.mock.petpoojaPos = prevPetpoojaMock;
    vi.unstubAllGlobals();
  });

  it("verify-only confirmation pushes the KOT exactly once (a re-verify does not ring again)", async () => {
    seedConfirmableOrder("order_kot_only");
    writeLog.length = 0; // count only writes made by the calls under test

    const first: any = await verifyPayment(verifyParams("order_kot_only", "pay_kot_only"));
    expect(first.success).toBe(true);

    const order = docs.get("orders/order_kot_only")!.data;
    expect(order.paymentStatus).toBe("completed");
    expect(order.petpoojaOrderId).toMatch(/^pp_kot_/);
    expect(kotMarkerWrites("order_kot_only")).toHaveLength(1);
    expect(fetchStub).not.toHaveBeenCalled();

    // Re-verify: confirmation and KOT are both idempotent.
    const second: any = await verifyPayment(verifyParams("order_kot_only", "pay_kot_only"));
    expect(second.success).toBe(true);
    expect(kotMarkerWrites("order_kot_only")).toHaveLength(1);
    expect(docs.get("orders/order_kot_only")!.data.petpoojaOrderId).toBe(order.petpoojaOrderId);
  });

  it("a failed POS push never un-confirms the captured payment", async () => {
    // Live POS path, but the branch has no petpoojaStoreId: orderPush fails
    // closed BEFORE any fetch and parks the order in the retry lane.
    config.mock.petpoojaPos = false;
    seedConfirmableOrder("order_kot_fail", "branch_without_pos");
    writeLog.length = 0;

    const res: any = await verifyPayment(verifyParams("order_kot_fail", "pay_kot_fail"));

    // Payment truth is still success: the money is captured.
    expect(res.success).toBe(true);
    expect(res.paymentId).toBe("pay_kot_fail");
    const order = docs.get("orders/order_kot_fail")!.data;
    expect(order.paymentStatus).toBe("completed");
    expect(order.status).toMatchObject({ code: "CONFIRMED" });
    // The POS sync is outstanding in its EXISTING retry state, not silently lost.
    expect(order.petpoojaStatus).toBe("pending_retry");
    expect(order.petpoojaOrderId).toBeUndefined();
    expect(kotMarkerWrites("order_kot_fail")).toHaveLength(0);
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("webhook then verify: one push, not two", async () => {
    seedConfirmableOrder("order_kot_wh_first");
    writeLog.length = 0;

    const call = mockReqRes(
      capturedPayload("evt_kot_wh_first", "order_kot_wh_first", "pay_kot_wh_first", ORDER_AMOUNT_PAISE)
    );
    await handleRazorpayWebhook(call.req, call.res);
    expect(call.out().statusCode).toBe(200);

    const afterWebhook = docs.get("orders/order_kot_wh_first")!.data;
    expect(afterWebhook.paymentStatus).toBe("completed");
    expect(afterWebhook.petpoojaOrderId).toMatch(/^pp_kot_/);
    expect(kotMarkerWrites("order_kot_wh_first")).toHaveLength(1);

    const verified: any = await verifyPayment(
      verifyParams("order_kot_wh_first", "pay_kot_wh_first")
    );
    expect(verified.success).toBe(true);

    // The verify channel found the webhook's marker and deduped.
    expect(kotMarkerWrites("order_kot_wh_first")).toHaveLength(1);
    expect(docs.get("orders/order_kot_wh_first")!.data.petpoojaOrderId).toBe(
      afterWebhook.petpoojaOrderId
    );
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("verify then webhook: one push, not two", async () => {
    seedConfirmableOrder("order_kot_verify_first");
    writeLog.length = 0;

    const verified: any = await verifyPayment(
      verifyParams("order_kot_verify_first", "pay_kot_verify_first")
    );
    expect(verified.success).toBe(true);
    const afterVerify = docs.get("orders/order_kot_verify_first")!.data;
    expect(afterVerify.petpoojaOrderId).toMatch(/^pp_kot_/);
    expect(kotMarkerWrites("order_kot_verify_first")).toHaveLength(1);

    const call = mockReqRes(
      capturedPayload(
        "evt_kot_verify_first",
        "order_kot_verify_first",
        "pay_kot_verify_first",
        ORDER_AMOUNT_PAISE
      )
    );
    await handleRazorpayWebhook(call.req, call.res);
    expect(call.out().statusCode).toBe(200);

    expect(kotMarkerWrites("order_kot_verify_first")).toHaveLength(1);
    expect(docs.get("orders/order_kot_verify_first")!.data.petpoojaOrderId).toBe(
      afterVerify.petpoojaOrderId
    );
    expect(fetchStub).not.toHaveBeenCalled();
  });
});
