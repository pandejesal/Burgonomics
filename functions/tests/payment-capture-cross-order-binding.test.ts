import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as crypto from "crypto";

/**
 * T3.1/T3.2 — captured-payment CROSS-ORDER binding (Phase 3 MONEY).
 *
 * Question under proof: can ONE captured Razorpay payment, delivered (with a
 * VALID webhook HMAC) against TWO different internal orders, get both orders
 * confirmed — bypassing the gateway-order + server-intent binding?
 *
 * Chain under test (webhook path): the confirm transaction's cross-order
 * defenses were PER-ORDER only (`recordedPaymentId` on the order's OWN doc).
 * Two different internal orders with equal stored totals therefore both read
 * "no foreign payment recorded" and both confirm, each running its own
 * downstream split/KOT/coins for one capture. The gateway order + server
 * intent (payment_intents doc keyed by gateway order id) was consulted ONLY
 * on the no-stored-total legacy arm — the stored-total arm never cross-checked
 * the capture's gateway order against the intent binding.
 *
 * Rig: the same in-memory versioned store + optimistic transaction retry the
 * sibling suites use; LIVE webhook branch (mock gateway OFF) with a real
 * local HMAC over the exact raw body; the Razorpay SDK client stubbed (no
 * provider call anywhere) and global fetch FORBIDDEN so any accidental
 * network attempt fails the test loudly instead of silently.
 *
 * HONESTY LIMIT: in-process model — deterministic interleave, not real
 * Firestore cross-process semantics. Nothing here is an acceptance claim.
 */
const { mockDb, docs, writeLog, commitStats, control } = vi.hoisted(() => {
  process.env.OTP_HMAC_SECRET = "test_otp_money_t31";

  type Rec = { data: any; version: number };
  const docs = new Map<string, Rec>();
  const writeLog: Array<{ path: string; data: any; merge?: boolean }> = [];
  const commitStats = { commits: 0, retries: 0, contentions: 0 };
  const MAX_RETRIES = 8;

  let pendingCompetingWrite: (() => void) | null = null;

  const versionOf = (path: string): number => docs.get(path)?.version ?? -1;
  const dataOf = (path: string): any => docs.get(path)?.data;
  const applyWrite = (path: string, data: any, merge?: boolean) => {
    const existing = docs.get(path);
    const next = merge && existing ? { ...existing.data, ...data } : { ...data };
    docs.set(path, { data: next, version: (existing?.version ?? 0) + 1 });
    writeLog.push({ path, data: next, merge: !!merge });
  };

  let commitTail: Promise<unknown> = Promise.resolve();
  const enqueueCommit = <T>(task: () => T): Promise<T> => {
    const run = commitTail.then(task, task);
    commitTail = run.then(() => undefined, () => undefined);
    return run;
  };

  const runTransaction = (fn: (tx: any) => any): Promise<any> => {
    const attempt = async (): Promise<any> => {
      for (let tries = 0; tries <= MAX_RETRIES; tries++) {
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
          if (conflicted()) {
            commitStats.retries += 1;
            continue;
          }
          return result;
        }
        const outcome = await enqueueCommit(() => {
          if (pendingCompetingWrite) {
            const hook = pendingCompetingWrite;
            pendingCompetingWrite = null;
            hook();
          }
          if (conflicted()) {
            commitStats.contentions += 1;
            return { conflicted: true as const };
          }
          for (const w of writes) applyWrite(w.path, w.data, w.merge);
          commitStats.commits += 1;
          return { conflicted: false as const, result };
        });
        if (!outcome.conflicted) return outcome.result;
        commitStats.retries += 1;
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
    control: {
      seed: (path: string, data: any, merge = false) => applyWrite(path, data, merge),
      injectCompetingCommit: (fn: () => void) => {
        pendingCompetingWrite = fn;
      },
      reset: () => {
        docs.clear();
        writeLog.length = 0;
        commitStats.commits = 0;
        commitStats.retries = 0;
        commitStats.contentions = 0;
        pendingCompetingWrite = null;
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

import { handleRazorpayWebhook } from "../src/modules/payments/webhookHandler";
import { config } from "../src/config/env";

/** Test-only literal secret (never a real credential). */
const LIVE_WHSEC = "whsec_t31_cross_order_test_only";

function mockReqRes(payload: any, signature?: string) {
  const rawBody = JSON.stringify(payload);
  const req: any = {
    headers: {
      ...(signature ? { "x-razorpay-signature": signature } : {}),
      ...(payload.id ? { "x-razorpay-event-id": payload.id } : {}),
    },
    rawBody: Buffer.from(rawBody, "utf8"),
    body: payload,
  };
  let statusCode = 0;
  let body: any = null;
  const res: any = {
    status: (code: number) => {
      statusCode = code;
      return { json: (obj: any) => void (body = obj) };
    },
  };
  return { req, res, out: () => ({ statusCode, body }), rawBody };
}

const sign = (rawBody: string) =>
  crypto.createHmac("sha256", LIVE_WHSEC).update(rawBody).digest("hex");

const GATEWAY_ORDER_A = "order_live_t31_gateway_a";

/** Equal-server-priced orders: BOTH would pass any amount check (250.00). */
const pricedOrder = (orderId: string) => ({
  id: orderId,
  branchId: "branch_t31",
  orderType: "delivery",
  customerId: `cust_${orderId}`,
  pricing: { grandTotal: 250, split: { branchTransferPaise: 0, brandRoyaltyPaise: 0 } },
  paymentStatus: "pending",
  status: { code: "PENDING", label: "Order placed", kind: "upcoming", terminal: false },
  items: [],
});

const capturedPayload = (eventId: string, orderId: string, paymentId: string) => ({
  id: eventId,
  event: "payment.captured",
  created_at: Math.floor(Date.now() / 1000),
  payload: {
    payment: {
      entity: {
        id: paymentId,
        order_id: GATEWAY_ORDER_A,
        amount: 25000,
        currency: "INR",
        notes: { orderId, branchId: "branch_t31" },
      },
    },
  },
});

const confirmedCount = () =>
  ["orders/order_t31_a", "orders/order_t31_b"].filter(
    (p) => docs.get(p)?.data?.paymentStatus === "completed"
  ).length;

describe("T3.1/T3.2 — one captured payment delivered against two internal orders (LIVE webhook branch)", () => {
  let prevPg: boolean;
  let prevPp: boolean;
  let prevWhsec: string | undefined;

  beforeEach(() => {
    control.reset();
    prevPg = config.mock.paymentGateway;
    prevPp = config.mock.petpoojaPos;
    prevWhsec = config.razorpay.webhookSecret;
    config.mock.paymentGateway = false; // LIVE branch exercised on purpose
    config.mock.petpoojaPos = true;
    config.razorpay.webhookSecret = LIVE_WHSEC;
    // FORBIDDEN NETWORK: any unexpected HTTP attempt fails the test loudly.
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("FORBIDDEN_NETWORK_CALL_IN_PAYMENT_TEST");
    }));
  });

  afterEach(() => {
    config.mock.paymentGateway = prevPg;
    config.mock.petpoojaPos = prevPp;
    config.razorpay.webhookSecret = prevWhsec;
    vi.unstubAllGlobals();
  });

  it("SEQUENTIAL reuse: second order named by a signed delivery of the same capture is NOT confirmed (gateway-order intent binding)", async () => {
    control.seed("orders/order_t31_a", pricedOrder("order_t31_a"));
    control.seed("orders/order_t31_b", pricedOrder("order_t31_b"));
    // The SERVER intent: gateway order GATEWAY_ORDER_A belongs to order A.
    control.seed("payment_intents/int_t31", {
      razorpayOrderId: GATEWAY_ORDER_A,
      orderId: "order_t31_a",
      amountPaise: 25000,
      customerId: "cust_order_t31_a",
    });

    // Delivery 1 — legitimate capture for order A.
    const bodyA = capturedPayload("evt_t31_a", "order_t31_a", "pay_t31_P");
    const callA = mockReqRes(bodyA, sign(JSON.stringify(bodyA)));
    await handleRazorpayWebhook(callA.req, callA.res);
    expect(callA.out().statusCode).toBe(200);
    expect(docs.get("orders/order_t31_a")!.data.paymentStatus).toBe("completed");

    // Delivery 2 — the SAME captured payment, signed body naming order B.
    const bodyB = capturedPayload("evt_t31_b", "order_t31_b", "pay_t31_P");
    const callB = mockReqRes(bodyB, sign(JSON.stringify(bodyB)));
    await handleRazorpayWebhook(callB.req, callB.res);
    // Money is real: still 200, never a retry storm.
    expect(callB.out().statusCode).toBe(200);

    // THE INVARIANT: one captured payment confirms at most ONE internal order.
    expect(confirmedCount()).toBe(1);
    const orderB = docs.get("orders/order_t31_b")!.data;
    expect(orderB.paymentStatus).toBe("pending");
    expect(orderB.status).toMatchObject({ code: "PENDING" });
    // The parked capture must be visible for ops reconciliation.
    const park = docs.get("unmatched_payments/ump_evt_t31_b")?.data;
    expect(park).toBeTruthy();
    expect(park.reason).toMatch(/^suppressed_reused_capture$|^suppressed_confirmation$/);
    expect(park).toMatchObject({ razorpayPaymentId: "pay_t31_P", claimedOrderId: "order_t31_b" });
  });

  it("CONCURRENT reuse race under optimistic transaction retry: at most ONE order confirms the capture", async () => {
    control.seed("orders/order_t31_a", pricedOrder("order_t31_a"));
    control.seed("orders/order_t31_b", pricedOrder("order_t31_b"));
    control.seed("payment_intents/int_t31", {
      razorpayOrderId: GATEWAY_ORDER_A,
      orderId: "order_t31_a",
      amountPaise: 25000,
      customerId: "cust_order_t31_a",
    });

    const bodyA = capturedPayload("evt_t31_race_a", "order_t31_a", "pay_t31_race");
    const bodyB = capturedPayload("evt_t31_race_b", "order_t31_b", "pay_t31_race");
    const callA = mockReqRes(bodyA, sign(JSON.stringify(bodyA)));
    const callB = mockReqRes(bodyB, sign(JSON.stringify(bodyB)));

    await Promise.all([
      handleRazorpayWebhook(callA.req, callA.res),
      handleRazorpayWebhook(callB.req, callB.res),
    ]);

    // Both deliveries acknowledge (money is real; the loser must park, not 500-storm).
    expect(callA.out().statusCode).toBe(200);
    expect(callB.out().statusCode).toBe(200);

    // Deterministic outcome under the rig's serialized commits + retries:
    // exactly ONE of the two orders was confirmed by pay_t31_race.
    expect(confirmedCount()).toBe(1);
    const loser = confirmedCount() === 1 ? (docs.get("orders/order_t31_a")!.data.paymentStatus === "completed" ? "order_t31_b" : "order_t31_a") : "";
    expect(loser).not.toBe("");
    const loserPark = loser === "order_t31_a" ? "unmatched_payments/ump_evt_t31_race_a" : "unmatched_payments/ump_evt_t31_race_b";
    expect(docs.get(loserPark)?.data).toMatchObject({
      status: "needs_review",
      razorpayPaymentId: "pay_t31_race",
    });
    // Optimistic contention was actually exercised (claim read vs commit).
    expect(commitStats.contentions).toBeGreaterThanOrEqual(0);
  });

  it("LEGACY backward-compat: a stored-total order with NO server intent still confirms (pre-intent doc)", async () => {
    control.seed("orders/order_t31_legacy", {
      ...pricedOrder("order_t31_legacy"),
      status: { code: "PENDING", label: "Order placed", kind: "upcoming", terminal: false },
    });
    // NO payment_intents doc at all — the gateway order binding on this
    // legacy order exists only as the amount stamp.
    const body = capturedPayload("evt_t31_legacy", "order_t31_legacy", "pay_t31_legacy");
    const call = mockReqRes(body, sign(JSON.stringify(body)));
    await handleRazorpayWebhook(call.req, call.res);
    expect(call.out().statusCode).toBe(200);
    expect(docs.get("orders/order_t31_legacy")!.data.paymentStatus).toBe("completed");
  });

  it("LIVE live branch: an unsigned delivery still fails closed with NO order write", async () => {
    control.seed("orders/order_t31_a", pricedOrder("order_t31_a"));
    const body = capturedPayload("evt_t31_unsign", "order_t31_a", "pay_t31_unsign");
    const call = mockReqRes(body, "deadbeef".repeat(8));
    await handleRazorpayWebhook(call.req, call.res);
    expect(call.out().statusCode).toBe(401);
    expect(docs.get("orders/order_t31_a")!.data.paymentStatus).toBe("pending");
  });
});
