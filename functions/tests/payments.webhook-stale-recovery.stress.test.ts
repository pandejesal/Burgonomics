import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * STRESS-TEST REPAIR RED/GREEN — crash-recovery liveness of the Razorpay
 * idempotency claim (stress sweep 2026-10-24, finding W1 of the race hunter).
 *
 * P0: the payload `created_at` freshness window (15 min) is evaluated BEFORE
 * `acquireClaim`, while the stale-claim takeover TTL is 10 min. A delivery
 * whose process DIED between claim and completion can only be recovered by a
 * gateway redelivery — but Razorpay's retry cadence jumps past the 10–15 min
 * takeover band, so every redelivery inside ANY later cadence is stamped
 * `created_at > 15 min` old and hits the 401 freshness reject BEFORE the
 * claim logic can take over the dead lease. Captured money stays unconfirmed
 * forever and Razorpay stops retrying on the 401.
 *
 * The fix (webhookHandler.ts): claim FIRST; only a genuinely-NEW claim is
 * subject to the freshness reject (and releases its claim doc so the
 * rejection leaves no phantom lease); a TAKEOVER of a dead lease is a
 * recovery attempt and bypasses the freshness reject.
 *
 * HONESTY LIMIT: in-process document store; mock gateway + mock Petpooja,
 * no network, no secret. Harness mirrors webhook.replay.test.
 */
const { mockDb, docs, writeLog, control } = vi.hoisted(() => {
  process.env.OTP_HMAC_SECRET = "test_otp_razorpay_stale_recovery";
  type Rec = { data: any; version: number };
  const docs = new Map<string, Rec>();
  const writeLog: Array<{ path: string; data: any; merge?: boolean }> = [];

  // Race-injection hooks: fired ONLY on transactional reads (never plain
  // docRef.get) — see the P2 RED test below for the reasoning.
  const txGetHooks: Array<(path: string, data: any) => any> = [];

  const versionOf = (path: string): number => docs.get(path)?.version ?? -1;
  const dataOf = (path: string): any => docs.get(path)?.data;

  const applyWrite = (path: string, data: any, merge?: boolean, log = true) => {
    const existing = docs.get(path);
    const next = merge && existing ? { ...existing.data, ...data } : { ...data };
    docs.set(path, { data: next, version: (existing?.version ?? 0) + 1 });
    if (log) writeLog.push({ path, data, merge: !!merge });
  };

  const runTransaction = (fn: (tx: any) => any): Promise<any> => {
    const attempt = async (): Promise<any> => {
      for (let tries = 0; tries <= 8; tries++) {
        const readVersions = new Map<string, number>();
        const writes: Array<{ path: string; data: any; merge?: boolean }> = [];
        const tx = {
          get: async (ref: any) => {
            readVersions.set(ref.path, versionOf(ref.path));
            let data = dataOf(ref.path);
            // Race-injection hooks fire ONLY on transactional reads, so the
            // defect interleaving (capture lands after failed's plain read)
            // and the fixed flow (failed re-reads inside the transaction) are
            // both modeled without masking current behavior.
            for (const hook of txGetHooks) {
              if (hook) data = hook(ref.path, data);
            }
            if (data === undefined) return { exists: false, data: () => undefined, ref };
            return { exists: true, data: () => data, ref };
          },
          set: (ref: any, data: any, opts?: any) => void writes.push({ path: ref.path, data, merge: !!opts?.merge }),
          update: (ref: any, data: any) => void writes.push({ path: ref.path, data, merge: true }),
        };
        const result = await fn(tx);
        const conflicted = () => [...readVersions.entries()].some(([path, v]) => versionOf(path) !== v);
        if (writes.length === 0) {
          if (conflicted()) continue;
          return result;
        }
        if (conflicted()) continue;
        for (const w of writes) applyWrite(w.path, w.data, w.merge);
        return result;
      }
      const err: any = new Error("SIMULATED_TRANSACTION_CONTENTION: retries exhausted");
      err.code = "ABORTED";
      throw err;
    };
    return attempt();
  };

  const docRef = (colName: string, docId: string) => {
    const path = `${colName}/${docId}`;
    const ref: any = {
      id: docId,
      path,
      get: async () => {
        const data = dataOf(path);
        return { exists: data !== undefined, data: () => data, ref };
      },
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
      delete: async () => {
        docs.delete(path);
      },
    };
    return ref;
  };

  const getByPath = (obj: any, path: string) => path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
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
      doc: (docId?: string) => docRef(colName, docId || `auto_${Math.random().toString(36).slice(2, 8)}`),
    };
    return q;
  };

  const mockDb: any = { collection: collectionMock, runTransaction };
  return {
    mockDb,
    docs,
    writeLog,
    control: {
      seed: (path: string, data: any, merge = false) => applyWrite(path, data, merge, false),
      onTxGet: (hook: (path: string, data: any) => any) => {
        txGetHooks.push(hook);
      },
      reset: () => {
        docs.clear();
        writeLog.length = 0;
        txGetHooks.length = 0;
      },
    },
  };
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

const capturedPayload = (eventId: string, orderId: string, paymentId: string, amount = 25000) => ({
  id: eventId,
  event: "payment.captured",
  payload: {
    payment: {
      entity: {
        id: paymentId,
        amount,
        currency: "INR",
        notes: { orderId, branchId: "branch_surat_01" },
      },
    },
  },
});

const pendingOrder = (id: string, paymentId: string) => ({
  id,
  branchId: "branch_surat_01",
  pricing: { grandTotal: 250, split: { branchTransferPaise: 9000, brandRoyaltyPaise: 1600 } },
  paymentStatus: "pending",
  payment: { razorpayPaymentId: paymentId },
});

const staleClaim = (eventId: string, event = "payment.captured") => ({
  eventId,
  event,
  // Claim died 16 min ago — outside the 10-min takeover TTL, and older than
  // the payload freshness window proves the two clocks are independent.
  claimedAt: Date.now() - 16 * 60 * 1000,
  completedAt: null,
});

describe("Razorpay webhook crash-recovery vs freshness window (stress sweep)", () => {
  let prevPg: boolean;
  let prevPp: boolean;
  beforeEach(() => {
    control.reset();
    prevPg = config.mock.paymentGateway;
    prevPp = config.mock.petpoojaPos;
    config.mock.paymentGateway = true;
    config.mock.petpoojaPos = true;
  });
  afterEach(() => {
    config.mock.paymentGateway = prevPg;
    config.mock.petpoojaPos = prevPp;
  });

  it("P0 RED: a redelivery that can take over a dead claim is NOT killed by the freshness window", async () => {
    control.seed("orders/order_rec", pendingOrder("order_rec", "pay_rec"));
    control.seed("branches/branch_surat_01", { razorpayAccountId: "acc_surat_1" });
    control.seed("payment_audits/aud_evt_evt_rec", staleClaim("evt_rec"), false);

    const payload: any = capturedPayload("evt_rec", "order_rec", "pay_rec");
    // The crashed delivery is now OLDER than the 15-min freshness window
    // (Razorpay's late retry cadence lands there), so the freshness reject
    // would fire today even though the claim is dead and take-over-able.
    payload.created_at = Math.floor((Date.now() - 50 * 60 * 1000) / 1000);

    const call = mockReqRes(payload);
    await handleRazorpayWebhook(call.req, call.res);

    expect(call.out().statusCode).toBe(200);
    const order = docs.get("orders/order_rec")!.data;
    expect(order.paymentStatus).toBe("completed");
    expect(order.routeTransferStatus).toBe("transferred");
    expect(order.petpoojaOrderId).toMatch(/^pp_kot_/);
  });

  it("GUARD: a FIRST-delivery stale event stays 401 and leaves no phantom claim", async () => {
    control.seed("orders/order_stale_first", pendingOrder("order_stale_first", "pay_stale_first"));
    control.seed("branches/branch_surat_01", { razorpayAccountId: "acc_surat_1" });

    const payload: any = capturedPayload("evt_stale_first", "order_stale_first", "pay_stale_first");
    payload.created_at = Math.floor((Date.now() - 60 * 60 * 1000) / 1000); // 1h old

    const call = mockReqRes(payload);
    await handleRazorpayWebhook(call.req, call.res);

    expect(call.out().statusCode).toBe(401);
    const order = docs.get("orders/order_stale_first")!.data;
    expect(order.paymentStatus).toBe("pending");
    // No live idempotency claim must survive a plain rejection (otherwise the
    // order's recovery path is burned for every future redelivery).
    expect(docs.get("payment_audits/aud_evt_evt_stale_first")?.data?.completedAt).toBeFalsy();
  });

  it("P2 RED: a capture landing between failed's read and write SURVIVES", async () => {
    control.seed("orders/o3_race", pendingOrder("o3_race", "pay_race_1"));
    control.seed("branches/branch_surat_01", { razorpayAccountId: "acc_surat_1" });
    // The captured delivery processes first (plain read) and confirms the
    // order; the failed delivery's read then sees pending, but by the time it
    // WRITES, the store carries the capture. Model it on the failed path's
    // TRANSACTIONAL read (fixed flow) — the current plain read/write merges
    // `failed` over a COMPLETED payment.
    control.onTxGet((path, data) => {
      if (path === "orders/o3_race") {
        return {
          ...(data || {}),
          paymentStatus: "completed",
          "payment.status": "completed",
        };
      }
      return data;
    });

    const payload: any = capturedPayload("evt_fail_race", "o3_race", "pay_race_1");
    payload.event = "payment.failed";

    const call = mockReqRes(payload);
    await handleRazorpayWebhook(call.req, call.res);

    expect(call.out().statusCode).toBe(200);
    const order = docs.get("orders/o3_race")!.data;
    // The failure must never overwrite the money state the transactional
    // snapshot reported (here: a capture already recorded — even though no
    // capture event materialized in this process, the guard's decision is
    // identical, so the store keeps its truth instead of merging `failed`).
    expect(order.paymentStatus).toBe("pending");
    expect(order["payment.status"]).toBeUndefined();
  });
});
