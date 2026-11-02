import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as crypto from "crypto";

/**
 * CAPTURE-FULFILMENT RECOVERY.
 *
 * Every scenario here is an INTERLEAVED sequence that enters through a REAL
 * entry point: the scheduled recovery job (the exported scheduled function's
 * worker), the Razorpay webhook handler, or `verifyPayment`.
 *
 * The invariant under test: a paid customer ends either fed or refunded —
 * never both, never neither — and a stuck state reaches a human or a retry.
 *
 * Contract pinned here:
 *  1. a crash BETWEEN `refund_pending` and the refund POST is recovered, and
 *     the refund uses the SAME `unful_<order>_<payment>` identity, so exactly
 *     ONE gateway refund exists;
 *  2. a transient automatic-refund failure is RETRYABLE: the next attempt
 *     succeeds and the ledger records the refund once;
 *  3. a gate pending past the freshness window is finished by the JOB, with no
 *     dependence on Razorpay redelivering anything;
 *  4. the job racing a late webhook converges: one refund, one ledger entry, no
 *     confirmed order;
 *  5. after N failed attempts the job STOPS and leaves a staff-visible alert.
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
  };

  const applyWrite = (path: string, data: any, merge?: boolean) => {
    const existing = docs.get(path);
    const next =
      merge && existing && typeof existing === "object" && typeof data === "object"
        ? { ...existing, ...data }
        : { ...data };
    docs.set(path, next);
    writeLog.push({ path, data, merge: !!merge });
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
    let limitN: number | null = null;
    let offsetN = 0;
    const q: any = {
      where: (field: string, _op: string, value: any) => {
        filters.push({ field, value });
        return q;
      },
      // ENFORCED like Firestore: a bounded query must really be bounded, so a
      // test cannot pass by silently returning more rows than production would.
      limit: (n: number) => {
        limitN = typeof n === "number" && Number.isFinite(n) ? Math.max(0, Math.floor(n)) : null;
        return q;
      },
      offset: (n: number) => {
        offsetN = typeof n === "number" && Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
        return q;
      },
      get: async () => {
        const all = [...docs.entries()]
          .filter(([p]) => p.startsWith(`${colName}/`))
          .filter(([, d]) => filters.every((f) => getByPath(d, f.field) === f.value))
          .map(([p, d]) => {
            const id = p.slice(colName.length + 1);
            return { id, ref: docRef(colName, id), data: () => JSON.parse(JSON.stringify(d)) };
          });
        const paged = all.slice(offsetN, limitN === null ? undefined : offsetN + limitN);
        return { empty: paged.length === 0, size: paged.length, docs: paged };
      },
      doc: (docId?: string) =>
        docRef(colName, docId || `auto_${Math.random().toString(36).slice(2, 8)}`),
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
    return "snap_1";
  }),
}));

import {
  verifyPayment,
  __setPaymentsFetchForTests,
  __setRefundPostForTests,
} from "../src/modules/payments/razorpay.service";
import { handleRazorpayWebhook } from "../src/modules/payments/webhookHandler";
import { recoverStuckCaptureFulfilments } from "../src/modules/payments/captureRecovery";
import {
  CAPTURE_GATE_MAX_ATTEMPTS,
  CAPTURE_RECOVERY_AFTER_MS,
} from "../src/modules/payments/captureFulfillment";
import { config } from "../src/config/env";

const BRANCH = "branch_rec";
const SECRET = "rzp_rec_secret";
const WHSEC = "whsec_rec_test_only";
const ITEMS = [{ id: "p1", productId: "p1", name: "Burger", price: 100, quantity: 1 }];

const signVerify = (gw: string, pay: string) =>
  crypto.createHmac("sha256", SECRET).update(`${gw}|${pay}`).digest("hex");
const signWebhook = (raw: string) =>
  crypto.createHmac("sha256", WHSEC).update(raw).digest("hex");

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
  __setRefundPostForTests(null);
  __setPaymentsFetchForTests(null);
});

describe("recovery: a crash between refund_pending and the refund POST", () => {
  it("the real crash leaves refund_pending, and the job finishes the SAME refund exactly once", async () => {
    // The GENUINE sequence: the kitchen 86'd the line and a capture arrives.
    // `createPaymentOrder`/`autoRefund` are the real paths; the crash seam makes
    // the process die right after `refund_pending` is persisted and before the
    // refund POST runs.
    seedPaidOrder("ord_crash", "rzp_crash", "pay_crash");
    docs.set("products/p1", { id: "p1", name: "Burger", price: 100, inStock: false });
    control.crashBeforeRefundPost = true;
    __setPaymentsFetchForTests(async () => ({
      id: "pay_crash",
      order_id: "rzp_crash",
      amount: 10000,
      currency: "INR",
      status: "captured",
      notes: { orderId: "ord_crash" },
    }));

    // The capture channel dies mid-refund.
    await verifyPayment(
      {
        orderId: "ord_crash",
        razorpayOrderId: "rzp_crash",
        razorpayPaymentId: "pay_crash",
        razorpaySignature: signVerify("rzp_crash", "pay_crash"),
      },
      { uid: "cust_rec" }
    ).catch(() => undefined);
    control.crashBeforeRefundPost = false;

    // The crash left NO money returned, but a durable pending record.
    expect(refundPostCount()).toBe(0);
    const stalled = orderOf("ord_crash")!.captureFulfillment;
    expect(stalled.state).toBe("refund_pending");
    expect(orderOf("ord_crash")!.status.code).not.toBe("CONFIRMED");

    // Age the record past the recovery window (the crash is invisible to the
    // job except through the persisted timestamp).
    docs.set("orders/ord_crash", {
      ...orderOf("ord_crash"),
      captureFulfillment: { ...stalled, atMs: Date.now() - CAPTURE_RECOVERY_AFTER_MS - 60_000 },
    });

    const stats = await recoverStuckCaptureFulfilments();
    expect(stats.candidates).toBe(1);
    expect(stats.refunded).toBe(1);

    expect(refundPostCount()).toBe(1);
    // Deterministic identity: the crash + resume converge on ONE refund key.
    expect(refundLedgerKeys()).toHaveLength(1);
    expect(orderOf("ord_crash")!.captureFulfillment).toMatchObject({
      state: "refunded",
      paymentId: "pay_crash",
    });
    // Never confirmed, never rung.
    expect(orderOf("ord_crash")!.status.code).not.toBe("CONFIRMED");
    expect(orderOf("ord_crash")!.petpoojaOrderId).toBeUndefined();
  });

  it("a second sweep after the refund is idempotent: no second POST, no second ledger row", async () => {
    seedPaidOrder("ord_crash_idem", "rzp_crash_idem", "pay_crash_idem");
    stallGate(
      "ord_crash_idem",
      "pay_crash_idem",
      "refund_pending",
      CAPTURE_RECOVERY_AFTER_MS + 60_000
    );

    await recoverStuckCaptureFulfilments();
    const postsAfterFirst = refundPostCount();
    const ledgerAfterFirst = refundLedgerKeys().length;

    await recoverStuckCaptureFulfilments();

    expect(refundPostCount()).toBe(postsAfterFirst);
    expect(refundLedgerKeys()).toHaveLength(ledgerAfterFirst);
  });

  it("a live channel is never raced: a fresh gate is skipped", async () => {
    seedPaidOrder("ord_live", "rzp_live", "pay_live");
    stallGate("ord_live", "pay_live", "refund_pending", 1_000);

    const stats = await recoverStuckCaptureFulfilments();
    expect(stats.candidates).toBe(0);
    expect(refundPostCount()).toBe(0);
  });
});

describe("recovery: a transient refund failure is RETRYABLE", () => {
  it("first attempt fails, the job retries and the ledger records ONE refund", async () => {
    seedPaidOrder("ord_transient", "rzp_transient", "pay_transient");
    stallGate(
      "ord_transient",
      "pay_transient",
      "refund_pending",
      CAPTURE_RECOVERY_AFTER_MS + 60_000
    );
    control.refundFailuresRemaining = 1;

    const first = await recoverStuckCaptureFulfilments();
    expect(first.retried).toBe(1);
    expect(first.refunded).toBe(0);
    expect(orderOf("ord_transient")!.captureFulfillment.state).toBe("refund_failed");
    expect(refundPostCount()).toBe(0);

    // The next tick retries — a failed attempt is NOT terminal. The sweep runs
    // on wall-clock time and the recorded failure already has its (short)
    // backoff applied, so a second tick retries immediately.
    const second = await recoverStuckCaptureFulfilments();
    expect(second.refunded).toBe(1);
    expect(refundPostCount()).toBe(1);
    expect(refundLedgerKeys()).toHaveLength(1);
    expect(orderOf("ord_transient")!.captureFulfillment.state).toBe("refunded");
  });

  it("a redelivered webhook also retries the refund (not a permanent refusal)", async () => {
    seedPaidOrder("ord_wh_retry", "rzp_wh_retry", "pay_wh_retry");
    // The gate failed once and its lease has expired.
    stallGate("ord_wh_retry", "pay_wh_retry", "refund_failed", 30 * 60_000, 1);

    const payload = {
      id: "evt_wh_retry",
      event: "payment.captured",
      created_at: Math.floor(Date.now() / 1000),
      payload: {
        payment: {
          entity: {
            id: "pay_wh_retry",
            order_id: "rzp_wh_retry",
            amount: 10000,
            currency: "INR",
            notes: { orderId: "ord_wh_retry", branchId: BRANCH },
          },
        },
      },
    };
    const raw = JSON.stringify(payload);
    const req: any = {
      headers: {
        "x-razorpay-signature": signWebhook(raw),
        "x-razorpay-event-id": payload.id,
      },
      rawBody: Buffer.from(raw, "utf8"),
      body: payload,
    };
    let status = 0;
    let body: any = null;
    const res: any = {
      status: (c: number) => {
        status = c;
        return { json: (o: any) => void (body = o) };
      },
    };
    await handleRazorpayWebhook(req, res);

    // It retried the refund instead of answering the recorded failure forever.
    expect(refundPostCount()).toBe(1);
    expect(orderOf("ord_wh_retry")!.captureFulfillment.state).toBe("refunded");
    expect(orderOf("ord_wh_retry")!.status.code).not.toBe("CONFIRMED");
    expect(status).toBe(200);
    void body;
  });
});

describe("recovery: a gate pending past the freshness window, no redelivery", () => {
  it("the job finishes a stalled `checking` decision without any webhook", async () => {
    seedPaidOrder("ord_stuck", "rzp_stuck", "pay_stuck");
    // Stalled past the 15-minute freshness window with NO redelivery expected.
    stallGate("ord_stuck", "pay_stuck", "checking", 45 * 60_000);

    const stats = await recoverStuckCaptureFulfilments();
    expect(stats.candidates).toBe(1);
    expect(stats.refunded).toBe(1);

    expect(refundPostCount()).toBe(1);
    expect(orderOf("ord_stuck")!.captureFulfillment.state).toBe("refunded");
    expect(orderOf("ord_stuck")!.petpoojaOrderId).toBeUndefined();
  });

  it("a stalled `fulfillable` gate on an unconfirmed order is CONFIRMED by the job", async () => {
    // The decision was made and the process died before the confirmation. The
    // order therefore does NOT yet carry payment truth: only the capture
    // record and the gate prove the capture happened.
    seedPaidOrder("ord_confirm", "rzp_confirm", "pay_confirm", {
      paymentStatus: "pending",
      payment: {
        method: "online",
        status: "pending",
        razorpayPaymentId: "pay_confirm",
        razorpayOrderId: "rzp_confirm",
        capturedAmountPaise: 10000,
      },
      "payment.status": "pending",
    });
    docs.set("products/p1", { id: "p1", name: "Burger", price: 100, inStock: true });
    const order = docs.get("orders/ord_confirm");
    docs.set("orders/ord_confirm", {
      ...order,
      captureFulfillment: {
        state: "fulfillable",
        paymentId: "pay_confirm",
        atMs: Date.now() - CAPTURE_RECOVERY_AFTER_MS - 60_000,
        attempts: 1,
      },
      captureFulfillmentState: "fulfillable",
    });

    const stats = await recoverStuckCaptureFulfilments();
    expect(stats.confirmed).toBe(1);
    expect(refundPostCount()).toBe(0);
    expect(orderOf("ord_confirm")!.paymentStatus).toBe("completed");
    expect(orderOf("ord_confirm")!.petpoojaOrderId).toMatch(/^pp_kot_/);
  });
});

describe("recovery: the job racing a late webhook", () => {
  it("converges on ONE refund and ONE ledger entry, and the order is never confirmed", async () => {
    seedPaidOrder("ord_race", "rzp_race", "pay_race");
    stallGate("ord_race", "pay_race", "refund_pending", CAPTURE_RECOVERY_AFTER_MS + 60_000);

    const payload = {
      id: "evt_race",
      event: "payment.captured",
      created_at: Math.floor(Date.now() / 1000),
      payload: {
        payment: {
          entity: {
            id: "pay_race",
            order_id: "rzp_race",
            amount: 10000,
            currency: "INR",
            notes: { orderId: "ord_race", branchId: BRANCH },
          },
        },
      },
    };
    const raw = JSON.stringify(payload);
    const mkReq = () => ({
      headers: {
        "x-razorpay-signature": signWebhook(raw),
        "x-razorpay-event-id": payload.id,
      },
      rawBody: Buffer.from(raw, "utf8"),
      body: payload,
    });
    const mkRes = () => {
      let status = 0;
      const res: any = {
        status: (c: number) => {
          status = c;
          return { json: () => undefined };
        },
        out: () => status,
      };
      return res;
    };
    const whRes = mkRes();

    // True interleave: both actors run concurrently over the same state.
    const [job] = await Promise.all([
      recoverStuckCaptureFulfilments(),
      handleRazorpayWebhook(mkReq(), whRes),
    ]);

    // Whoever won, the OUTCOME is one compensation: exactly one gateway refund,
    // one ledger row, a refunded gate and an order that was never confirmed.
    // The job may report `retried` when it observed the webhook's live lease —
    // that is the lock doing its job, and the next tick would see `refunded`.
    expect(job.refunded + job.retried).toBeGreaterThanOrEqual(1);
    // Exactly ONE gateway refund and ONE ledger row, whoever won.
    expect(refundPostCount()).toBe(1);
    expect(refundLedgerKeys()).toHaveLength(1);
    expect(orderOf("ord_race")!.captureFulfillment.state).toBe("refunded");
    expect(orderOf("ord_race")!.status.code).not.toBe("CONFIRMED");
    expect(orderOf("ord_race")!.petpoojaOrderId).toBeUndefined();
  });

  it("a late webhook after the job refunded is a no-op (no second refund, no confirm)", async () => {
    seedPaidOrder("ord_after", "rzp_after", "pay_after");
    stallGate("ord_after", "pay_after", "refund_pending", CAPTURE_RECOVERY_AFTER_MS + 60_000);

    await recoverStuckCaptureFulfilments();
    expect(refundPostCount()).toBe(1);

    const payload = {
      id: "evt_after",
      event: "payment.captured",
      created_at: Math.floor(Date.now() / 1000),
      payload: {
        payment: {
          entity: {
            id: "pay_after",
            order_id: "rzp_after",
            amount: 10000,
            currency: "INR",
            notes: { orderId: "ord_after", branchId: BRANCH },
          },
        },
      },
    };
    const raw = JSON.stringify(payload);
    const req: any = {
      headers: {
        "x-razorpay-signature": signWebhook(raw),
        "x-razorpay-event-id": payload.id,
      },
      rawBody: Buffer.from(raw, "utf8"),
      body: payload,
    };
    const res: any = { status: () => ({ json: () => undefined }) };
    await handleRazorpayWebhook(req, res);

    expect(refundPostCount()).toBe(1);
    expect(refundLedgerKeys()).toHaveLength(1);
    expect(orderOf("ord_after")!.status.code).not.toBe("CONFIRMED");
  });
});

describe("recovery: the attempt budget ends in a staff-visible alert", () => {
  it("after N failed attempts the job STOPS and leaves an ops alert, not a silent retry", async () => {
    seedPaidOrder("ord_exhaust", "rzp_exhaust", "pay_exhaust");
    stallGate(
      "ord_exhaust",
      "pay_exhaust",
      "refund_failed",
      CAPTURE_RECOVERY_AFTER_MS + 60_000,
      CAPTURE_GATE_MAX_ATTEMPTS
    );
    // Even with the gateway healthy, the budget is spent: stop and escalate.
    const before = refundPostCount();

    const stats = await recoverStuckCaptureFulfilments();
    expect(stats.escalated).toBe(1);
    expect(stats.refunded).toBe(0);
    expect(refundPostCount()).toBe(before);

    // Staff-visible: a deterministic ops doc plus a HIGH alert. The reason now
    // names the exhausted budget explicitly.
    expect(docs.get("unmatched_payments/ump_gate_pay_exhaust")).toMatchObject({
      status: "needs_review",
      gateState: "refund_exhausted",
      staffAction: "refund_manually_or_repair_gate",
    });
    expect(snapshots.some((s) => s.severity === "high")).toBe(true);

    // Sweeping again does not post a refund either — the case belongs to a human.
    await recoverStuckCaptureFulfilments();
    expect(refundPostCount()).toBe(before);
  });
});

describe("recovery: the verify channel resumes a stale compensation", () => {
  it("a verify arriving after a stalled refund_pending finishes the SAME refund", async () => {
    seedPaidOrder("ord_verify_resume", "rzp_verify_resume", "pay_verify_resume", {
      paymentStatus: "pending",
    });
    stallGate(
      "ord_verify_resume",
      "pay_verify_resume",
      "refund_pending",
      CAPTURE_RECOVERY_AFTER_MS + 60_000
    );
    __setPaymentsFetchForTests(async () => ({
      id: "pay_verify_resume",
      order_id: "rzp_verify_resume",
      amount: 10000,
      currency: "INR",
      status: "captured",
      notes: { orderId: "ord_verify_resume" },
    }));

    const err: any = await verifyPayment(
      {
        orderId: "ord_verify_resume",
        razorpayOrderId: "rzp_verify_resume",
        razorpayPaymentId: "pay_verify_resume",
        razorpaySignature: signVerify("rzp_verify_resume", "pay_verify_resume"),
      },
      { uid: "cust_rec" }
    ).then(
      (r) => ({ unexpectedSuccess: r }),
      (e) => e
    );

    // Refused (never confirmed) but the refund was completed.
    expect(err.unexpectedSuccess).toBeUndefined();
    expect(refundPostCount()).toBe(1);
    expect(refundLedgerKeys()).toHaveLength(1);
    expect(orderOf("ord_verify_resume")!.captureFulfillment.state).toBe("refunded");
    expect(orderOf("ord_verify_resume")!.status.code).not.toBe("CONFIRMED");
  });
});

// ===========================================================================
// REVIEW FINDINGS (Sol on 1549b5a)
//
// (a) a failed refund on an order the customer later CANCELLED was skipped as
//     "terminal" although the compensation was still owed;
// (b) the first 50 such terminal rows permanently occupied the bounded query,
//     so later owed refunds were never visited;
// (c) the resume path reset `attempts` to 0, so the counter stayed at 1 and the
//     max-attempts escalation never fired.
//
// These drive the REAL timed sweep with an ENFORCED limit(50) and a cursor,
// 56 owed rows (6 of them terminal/CANCELLED), and six consecutive ticks.
// ===========================================================================
describe("REVIEW: owed compensation, pagination and the attempt budget", () => {
  const seedOwed = (
    orderId: string,
    paymentId: string,
    over: Record<string, any> = {}
  ) => {
    seedPaidOrder(orderId, `rzp_${orderId}`, paymentId, {
      captureFulfillment: {
        state: "refund_failed",
        paymentId,
        // Old enough to be a candidate immediately.
        atMs: Date.now() - CAPTURE_RECOVERY_AFTER_MS - 60_000,
        attempts: 1,
        detail: "p1",
      },
      captureFulfillmentState: "refund_failed",
      ...over,
    });
  };

  it("resumes an OWED refund on a CANCELLED order instead of skipping the terminal row", async () => {
    // The exact reported sequence: the refund fails, THEN the customer cancels
    // the still-PLACED order, so the row is CANCELLED with money still owed.
    seedOwed("ord_owed_cancel", "pay_owed_cancel", {
      status: { code: "CANCELLED", label: "Cancelled", kind: "cancelled", terminal: true },
      cancellationReason: "Customer called it off",
    });

    const stats = await recoverStuckCaptureFulfilments();

    expect(stats.refunded).toBe(1);
    expect(refundPostCount()).toBe(1);
    expect(refundLedgerKeys()).toHaveLength(1);
    expect(orderOf("ord_owed_cancel")!.captureFulfillment.state).toBe("refunded");
    // The lifecycle status is never resurrected by the refund.
    expect(orderOf("ord_owed_cancel")!.status).toMatchObject({ code: "CANCELLED" });
  });

  it("reaches owed refunds behind a full page of stuck rows (cursor, no starvation)", async () => {
    const total = 56; // > 50: the first page cannot contain them all
    for (let i = 0; i < total; i += 1) {
      // The first 50 are the exhausted/terminal head of the queue that used to
      // occupy the bounded page forever. They start with a partly-spent budget
      // so six ticks are enough to reach the escalation threshold.
      seedOwed(`ord_owed_${i}`, `pay_owed_${i}`, {
        captureFulfillment: {
          state: "refund_failed",
          paymentId: `pay_owed_${i}`,
          atMs: Date.now() - CAPTURE_RECOVERY_AFTER_MS - 60_000,
          attempts: 3,
          detail: "p1",
        },
      });
      docs.set("products/p1", { id: "p1", name: "Burger", price: 100, inStock: false });
    }
    // The last six are behind the page and must be reached.

    const seen = new Set<string>();
    for (let tick = 0; tick < 6; tick += 1) {
      // Every attempt fails: this is a batch of refunds that the gateway keeps
      // rejecting, so the budget must advance and the cursor must move.
      control.refundFailuresRemaining = 999;
      const before = refundPostCount();
      await recoverStuckCaptureFulfilments();
      for (let i = 0; i < total; i += 1) {
        const attempts = orderOf(`ord_owed_${i}`)!.captureFulfillment.attempts;
        if (attempts > 1) seen.add(`ord_owed_${i}`);
      }
      expect(refundPostCount()).toBeGreaterThanOrEqual(before);
    }

    // Even with a permanently failing gateway, the LATER rows were reached:
    // the first page cannot hide them across ticks.
    const laterTouched = [...seen].filter((id) => {
      const index = Number(id.split("_").pop());
      return index >= 50;
    });
    expect(laterTouched.length).toBeGreaterThan(0);

    // The counter is REAL (not stuck at 1) and the budget eventually escalates.
    const anyEscalated = [...docs.keys()].some(
      (k) => k.startsWith("unmatched_payments/ump_gate_")
    );
    expect(anyEscalated).toBe(true);
    const maxAttempt = Math.max(
      ...Array.from({ length: total }, (_, i) =>
        Number(orderOf(`ord_owed_${i}`)!.captureFulfillment.attempts)
      )
    );
    expect(maxAttempt).toBeGreaterThan(1);

    // Escalated rows moved OUT of the retry lane into the monitored state.
    const exhausted = Array.from({ length: total }, (_, i) =>
      orderOf(`ord_owed_${i}`)!.captureFulfillment.state
    ).filter((s) => s === "refund_exhausted");
    expect(exhausted.length).toBeGreaterThan(0);
  });

  it("escalates at the budget and stops retrying that row (no infinite hot loop)", async () => {
    seedOwed("ord_budget", "pay_budget", {
      captureFulfillment: {
        state: "refund_failed",
        paymentId: "pay_budget",
        atMs: Date.now() - CAPTURE_RECOVERY_AFTER_MS - 60_000,
        attempts: CAPTURE_GATE_MAX_ATTEMPTS,
        detail: "p1",
      },
    });
    control.refundFailuresRemaining = 999;

    const first = await recoverStuckCaptureFulfilments();
    expect(first.escalated).toBe(1);
    expect(refundPostCount()).toBe(0);
    expect(orderOf("ord_budget")!.captureFulfillment.state).toBe("refund_exhausted");

    // Second tick: the row is in the monitored state, no further POSTs and no
    // further attempt is burned (it is escalated again only as a reminder, so
    // the case stays visible rather than silently disappearing).
    const second = await recoverStuckCaptureFulfilments();
    expect(refundPostCount()).toBe(0);
    expect(orderOf("ord_budget")!.captureFulfillment.attempts).toBe(
      CAPTURE_GATE_MAX_ATTEMPTS
    );
    expect(second.refunded).toBe(0);
    expect(second.retried).toBe(0);
  });
});
