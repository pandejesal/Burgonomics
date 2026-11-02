import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/** Independent money-gate regressions. Recovery, capture gates, autoRefund and
 * refund accounting are REAL. Only Firestore, alerts and provider I/O are fake.
 * The boundary fixture follows payments.capture-recovery.test.ts, with frozen
 * query snapshots, default document-name ordering and dynamic bounded queries.
 */
const { mockDb, docs, writeLog, control, snapshots } = vi.hoisted(() => {
  process.env.OTP_HMAC_SECRET = "test_otp_capture_recovery";

  const docs = new Map<string, any>();
  const writeLog: Array<{ path: string; data: any; merge?: boolean }> = [];
  const snapshots: any[] = [];
  const control: any = {
    refundPosts: [] as any[],
    refundFailuresRemaining: 0,
    /** Runs INSIDE the window between the pending write and the refund POST. */
    crashBeforeRefundPost: false,
    /** Runs before a product read (a real interleave point for racing). */
    onProductRead: null as null | (() => void | Promise<void>),
    onFailedSnapshot: null as null | (() => Promise<void>),
    onHighAlert: null as null | (() => Promise<void>),
  };

  const clone = (value: any) => JSON.parse(JSON.stringify(value));
  const mergeMaps = (base: any, patch: any): any => {
    const result = { ...base };
    for (const [key, value] of Object.entries(patch)) {
      result[key] = value && typeof value === "object" && !Array.isArray(value)
        ? mergeMaps(base?.[key] || {}, value)
        : value;
    }
    return result;
  };
  const applyWrite = (path: string, data: any, merge?: boolean) => {
    docs.set(path, clone(merge ? mergeMaps(docs.get(path) || {}, data) : data));
    writeLog.push({ path, data: clone(data), merge: !!merge });
  };

  const docRef = (col: string, id: string) => {
    const path = `${col}/${id}`;
    return {
      id,
      path,
      get: async () => ({
        exists: docs.has(path),
        data: () => (docs.has(path) ? JSON.parse(JSON.stringify(docs.get(path))) : undefined),
        ref: docRef(col, id),
      }),
      set: async (data: any, opts?: any) => {
        // The crash seam: the state IS persisted, then the process dies before
        // the refund POST runs. This is the exact "refund_pending, no money"
        // window the recovery job must be able to finish.
        applyWrite(path, data, !!opts?.merge);
        if (control.crashBeforeRefundPost && col === "orders") {
          const state = docs.get(path)?.captureFulfillment?.state;
          if (state === "refund_pending") throw new Error("PROCESS_CRASHED_BEFORE_REFUND");
        }
      },
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
  };

  const getByPath = (obj: any, path: string) =>
    obj != null && Object.prototype.hasOwnProperty.call(obj, path)
      ? obj[path]
      : path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);

  const collectionMock = (colName: string) => {
    const filters: Array<{ field: string; value: any }> = [];
    let limitN = Infinity;
    let offsetN = 0;
    let afterId: string | null = null;
    let descending = false;
    const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    const q: any = {
      where: (field: string, op: string, value: any) => {
        if (op !== "==") throw new Error(`Unsupported fake query operator: ${op}`);
        filters.push({ field, value });
        return q;
      },
      orderBy: (field: string, direction = "asc") => {
        if (field !== "__name__") throw new Error(`Unsupported fake order: ${field}`);
        descending = direction === "desc";
        return q;
      },
      startAfter: (cursor: any) => {
        const id = typeof cursor === "string" ? cursor : cursor.id || cursor.ref?.id;
        if (!id) throw new Error("startAfter requires a document id/snapshot");
        afterId = id.split("/").pop();
        return q;
      },
      limit: (n: number) => { limitN = n; return q; },
      offset: (n: number) => { offsetN = n; return q; },
      get: async () => {
        // Evaluate against CURRENT membership, not the original seeded array.
        // Capture immutable snapshots before triggering the sibling interleave.
        const found = [...docs.entries()]
          .filter(([path]) => path.startsWith(`${colName}/`))
          .filter(([, data]) => filters.every(f => getByPath(data, f.field) === f.value))
          .sort(([a], [b]) => compare(a, b) * (descending ? -1 : 1))
          .filter(([path]) => afterId === null ||
            compare(path.slice(colName.length + 1), afterId) * (descending ? -1 : 1) > 0)
          .slice(offsetN, offsetN + limitN)
          .map(([path, data]) => {
            const id = path.slice(colName.length + 1);
            const saved = clone(data);
            return { id, ref: docRef(colName, id), data: () => clone(saved) };
          });
        if (colName === "orders" && filters.some(f => f.value === "refund_failed") &&
            control.onFailedSnapshot) {
          const hook = control.onFailedSnapshot;
          control.onFailedSnapshot = null;
          await hook();
        }
        return { empty: found.length === 0, size: found.length, docs: found };
      },
      doc: (docId?: string) => docRef(colName, docId || `auto_${Math.random().toString(36).slice(2, 8)}`),
    };
    return q;
  };

  const runTransaction = (fn: (tx: any) => any): Promise<any> => {
    const attempt = async (): Promise<any> => {
      for (let tries = 0; tries <= 8; tries++) {
        const reads = new Map<string, string>();
        const writes: Array<{ path: string; data: any; merge?: boolean }> = [];
        const tx = {
          get: async (ref: any) => {
            reads.set(ref.path, JSON.stringify(docs.get(ref.path) ?? null));
            const data = docs.get(ref.path);
            return {
              exists: data !== undefined,
              data: () => (data === undefined ? undefined : JSON.parse(JSON.stringify(data))),
              ref,
            };
          },
          set: (ref: any, data: any, opts?: any) =>
            void writes.push({ path: ref.path, data, merge: !!opts?.merge }),
          update: (ref: any, data: any) => void writes.push({ path: ref.path, data, merge: true }),
        };
        const result = await fn(tx);
        if ([...reads.entries()].some(([p, v]) => JSON.stringify(docs.get(p) ?? null) !== v)) continue;
        for (const w of writes) applyWrite(w.path, w.data, w.merge);
        return result;
      }
      const err: any = new Error("ABORTED");
      err.code = 10;
      throw err;
    };
    return attempt();
  };

  const mockDb: any = { collection: collectionMock, runTransaction };

  return { mockDb, docs, writeLog, control, snapshots };
});

vi.mock("../src/core/firebase", () => ({ db: mockDb }));

vi.mock("firebase-admin", () => {
  const FieldValue = {
    serverTimestamp: () => "MOCK_TS",
    increment: (n: number) => n,
    arrayUnion: (i: any) => [i],
    delete: () => "MOCK_DELETE",
  };
  const f: any = vi.fn(() => mockDb);
  f.FieldValue = FieldValue;
  f.FieldPath = { documentId: () => "__name__" };
  return {
    default: {
      firestore: f,
      auth: vi.fn(() => ({})),
      messaging: vi.fn(() => ({})),
      initializeApp: vi.fn(),
      apps: [{ name: "mock" }],
    },
    firestore: f,
    auth: vi.fn(() => ({})),
    messaging: vi.fn(() => ({})),
    initializeApp: vi.fn(),
    apps: [{ name: "mock" }],
  };
});

vi.mock("../src/modules/payments/razorpayClient", () => ({
  getRazorpayClient: () => ({
    orders: {
      create: vi.fn(async () => ({ id: "order_unused" })),
      fetchPayments: vi.fn(async () => ({ items: [] })),
    },
    payments: { fetch: vi.fn(async (id: string) => control.gateway[id]) },
  }),
  getRazorpayKeyId: () => "rzp_test_recovery",
}));

vi.mock("../src/core/errors", async (io) => ({
  ...(await io<any>()),
  captureErrorSnapshot: vi.fn(async (s: any) => {
    snapshots.push(s);
    if (s.severity === "high" && control.onHighAlert) await control.onHighAlert();
    return "snap_1";
  }),
}));

import {
  __setPaymentsFetchForTests,
  __setRefundPostForTests,
} from "../src/modules/payments/razorpay.service";
import { recoverStuckCaptureFulfilments } from "../src/modules/payments/captureRecovery";
import {
  guardCaptureFulfillment,
  CAPTURE_GATE_MAX_ATTEMPTS,
  CAPTURE_RECOVERY_AFTER_MS,
} from "../src/modules/payments/captureFulfillment";
import { config } from "../src/config/env";

const BRANCH = "branch_rec";
const SECRET = "rzp_rec_secret";
const WHSEC = "whsec_rec_test_only";
const ITEMS = [{ id: "p1", productId: "p1", name: "Burger", price: 100, quantity: 1 }];

const seedBranch = () =>
  docs.set(`branches/${BRANCH}`, { id: BRANCH, isOpen: true, packagingFee: 0, monthlyFee: 0 });

const seedPaidOrder = (
  orderId: string,
  gatewayOrderId: string,
  paymentId: string,
  over: Record<string, any> = {}
) => {
  docs.set(`orders/${orderId}`, {
    id: orderId,
    customerId: "cust_rec",
    userId: "cust_rec",
    branchId: BRANCH,
    orderType: "takeaway",
    items: ITEMS,
    payment: {
      method: "online",
      status: "completed",
      razorpayPaymentId: paymentId,
      razorpayOrderId: gatewayOrderId,
      capturedAmountPaise: 10000,
    },
    "payment.status": "completed",
    "payment.razorpayPaymentId": paymentId,
    "payment.capturedAmountPaise": 10000,
    pricing: { grandTotal: 100, split: { branchTransferPaise: 10000 } },
    paymentStatus: "completed",
    routeTransferStatus: "not_required",
    status: { code: "PLACED", label: "Order placed", kind: "upcoming", terminal: false },
    ...over,
  });
  docs.set(`payment_intents/intent_${orderId}`, {
    razorpayOrderId: gatewayOrderId,
    orderId,
    amountPaise: 10000,
    branchId: BRANCH,
    customerId: "cust_rec",
    pricing: { grandTotal: 100, loyaltyDiscount: 0, split: { branchTransferPaise: 10000 } },
    createdAtMs: Date.now(),
    expiresAtMs: Date.now() + 60_000,
  });
};

/** The order is mid-compensation: the item is 86'd and the gate stalled. */
const stallGate = (
  orderId: string,
  paymentId: string,
  state: "checking" | "refund_pending" | "refund_failed",
  ageMs: number,
  attempts = 1
) => {
  const order = docs.get(`orders/${orderId}`);
  docs.set(`orders/${orderId}`, {
    ...order,
    captureFulfillment: {
      state,
      paymentId,
      atMs: Date.now() - ageMs,
      attempts,
      detail: "p1",
    },
    // The mirrored scan key the recovery sweep queries (Firestore's automatic
    // single-field index; see captureRecovery.ts).
    captureFulfillmentState: state,
  });
  // The kitchen 86'd the line, so the decision is "unfulfillable".
  docs.set("products/p1", { id: "p1", name: "Burger", price: 100, inStock: false });
};

const orderOf = (id: string) => docs.get(`orders/${id}`);
const refundLedgerKeys = () =>
  [...docs.keys()].filter((k) => k.startsWith("payment_refund_requests/"));
const refundPostCount = () => control.refundPosts.length;

beforeEach(() => {
  for (const key of [...docs.keys()]) docs.delete(key);
  writeLog.length = 0;
  snapshots.length = 0;
  control.refundPosts = [];
  control.refundFailuresRemaining = 0;
  control.crashBeforeRefundPost = false;
  control.onProductRead = null;
  control.onFailedSnapshot = null;
  control.onHighAlert = null;
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-30T12:00:00Z"));
  control.gateway = {};

  config.mock.paymentGateway = false;
  config.mock.petpoojaPos = true;
  config.razorpay.keySecret = SECRET;
  config.razorpay.webhookSecret = WHSEC;
  seedBranch();
  docs.set("products/p1", { id: "p1", name: "Burger", price: 100, inStock: true });

  __setRefundPostForTests(async (paymentId: string, body: any, key: string) => {
    if (control.refundFailuresRemaining > 0) {
      control.refundFailuresRemaining -= 1;
      throw new Error("gateway refund exploded (transient)");
    }
    control.refundPosts.push({ paymentId, body, key });
    return {
      id: `rfnd_rec_${paymentId}`,
      payment_id: paymentId,
      amount: body.amount ?? 10000,
      status: "processed",
    };
  });
});

afterEach(() => {
  vi.useRealTimers();
  __setRefundPostForTests(null);
  __setPaymentsFetchForTests(null);
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function seedOwed(orderId: string, attempts = 1) {
  seedPaidOrder(orderId, `rzp_${orderId}`, `pay_${orderId}`);
  stallGate(orderId, `pay_${orderId}`, "refund_failed", CAPTURE_RECOVERY_AFTER_MS + 60_000, attempts);
}

describe("independent recovery pagination / exhaustion CAS regressions", () => {
  it("refunds every owed tail within eight ticks despite earlier-sorting arrivals every other tick", async () => {
    const tails = Array.from({ length: 6 }, (_, i) => `z_tail_${i}`);
    tails.forEach(id => seedOwed(id));
    const completedByTick: number[] = [];
    for (let tick = 0; tick < 8; tick++) {
      // Capacity exceeds arrivals (25/tick on average), yet positional offsets
      // repeatedly skip the same six rows when each head page leaves the lane.
      if (tick % 2 === 0) {
        for (let i = 0; i < 50; i++) seedOwed(`a_head_${tick}_${String(i).padStart(2, "0")}`);
      }
      await recoverStuckCaptureFulfilments();
      completedByTick.push(tails.filter(id => control.refundPosts.some(
        (post: any) => post.paymentId === `pay_${id}`
      )).length);
      vi.advanceTimersByTime(5 * 60_000);
    }
    // Real provider boundary calls, never attempts counters or mocked outcomes.
    expect(control.refundPosts.some((post: any) => post.paymentId.startsWith("pay_a_head_"))).toBe(true);
    for (const id of tails) {
      expect.soft(control.refundPosts.filter((post: any) => post.paymentId === `pay_${id}`),
        `${id} must receive exactly one actual refund within eight ticks; progress=${completedByTick}`
      ).toHaveLength(1);
      expect.soft(orderOf(id).captureFulfillment.state, `${id} final gate`).toBe("refunded");
    }
    expect(completedByTick[7]).toBe(6);
  });

  it("a lease-losing worker cannot exhaust a live fifth attempt or overwrite its completed refund", async () => {
    const id = "race_final_attempt";
    seedOwed(id, CAPTURE_GATE_MAX_ATTEMPTS - 1);
    const providerEntered = deferred();
    const releaseProvider = deferred();
    let sibling: ReturnType<typeof guardCaptureFulfillment> | undefined;
    let siblingCompletedDuringAlert = false;
    __setRefundPostForTests(async (paymentId: string, body: any, key: string) => {
      control.refundPosts.push({ paymentId, body, key });
      providerEntered.resolve();
      await releaseProvider.promise;
      return { id: `rfnd_rec_${paymentId}`, payment_id: paymentId, amount: body.amount, status: "processed" };
    });
    // Worker already holds an immutable failed/attempt-4 query snapshot.
    // A REAL sibling gate takes attempt 5 and waits with its lease live.
    control.onFailedSnapshot = async () => {
      sibling = guardCaptureFulfillment({
        orderRef: mockDb.collection("orders").doc(id), orderId: id,
        razorpayPaymentId: `pay_${id}`, razorpayOrderId: `rzp_${id}`,
        orderData: orderOf(id), capturedAmountPaise: 10000,
      });
      await providerEntered.promise;
      expect(orderOf(id).captureFulfillment).toMatchObject({ state: "refund_pending", attempts: 5 });
    };
    // On buggy code the worker treats its lease refusal as a fifth failure.
    // Finish the REAL refund while the worker awaits its high ops alert; its
    // following unconditional set must not downgrade that refund to exhausted.
    control.onHighAlert = async () => {
      releaseProvider.resolve();
      const result = await sibling!;
      expect(result.outcome).toBe("refunded");
      expect(orderOf(id).captureFulfillment.state).toBe("refunded");
      siblingCompletedDuringAlert = true;
    };
    try {
      await recoverStuckCaptureFulfilments();
    } finally {
      // A corrected worker skips the live lease and emits no alert, so unblock
      // the sibling here instead. Neither path relies on timers or sleeps.
      releaseProvider.resolve();
      if (sibling) await sibling;
    }
    expect(control.refundPosts.filter((post: any) => post.paymentId === `pay_${id}`)).toHaveLength(1);
    expect.soft(orderOf(id).captureFulfillment.state,
      `completed during alert=${siblingCompletedDuringAlert}`).toBe("refunded");
    expect.soft(orderOf(id).captureFulfillmentState).toBe("refunded");
    expect.soft(snapshots.filter(s => s.severity === "high"), "no false manual-refund alert for a live owner").toHaveLength(0);
    expect.soft(docs.get(`unmatched_payments/ump_gate_pay_${id}`), "no false manual-refund case").toBeUndefined();
    expect.soft(writeLog.filter(w => w.path === `orders/${id}` &&
      w.data.captureFulfillment?.state === "refund_exhausted"), "never overwrite with refund_exhausted").toHaveLength(0);
  });
});
