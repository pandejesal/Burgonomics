import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as crypto from "crypto";

/**
 * FINAL-REVIEW FINDINGS (a7a74c8).
 *
 * (1) The recovery sweep could be STARVED. Its `fulfillable` lane is an
 *     equality query with a limit, and nothing ever moved a confirmed order out
 *     of that state — so the first N healthy orders filled the page forever and
 *     a later crashed paid order never got scanned.
 *
 * (2) A failed refund POST released the claim lease on EVERY error, including a
 *     LOST RESPONSE after the gateway had already accepted the refund. A second
 *     operator using a DIFFERENT refund key then saw "no outstanding claim" and
 *     POSTed a second partial refund — money returned twice.
 *
 * Both are exercised through REAL entry points: the scheduled recovery worker,
 * `verifyPayment`, the Razorpay webhook handler and `autoRefund`.
 */
const { mockDb, docs, control, snapshots } = vi.hoisted(() => {
  process.env.OTP_HMAC_SECRET = "test_otp_final_findings";

  const docs = new Map<string, any>();
  const snapshots: any[] = [];
  const control: any = {
    refundPosts: [] as any[],
    /** Queued refund outcomes: Error instances are thrown, objects returned. */
    refundQueue: [] as any[],
    gateway: {} as Record<string, any>,
  };

  const applyWrite = (path: string, data: any, merge?: boolean) => {
    const existing = docs.get(path);
    const next =
      merge && existing && typeof existing === "object" && typeof data === "object"
        ? { ...existing, ...data }
        : { ...data };
    docs.set(path, next);
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
      limit: () => q,
      get: async () => {
        const found = [...docs.entries()]
          .filter(([p]) => p.startsWith(`${colName}/`))
          .filter(([, d]) => filters.every((f) => getByPath(d, f.field) === f.value))
          .map(([p, d]) => {
            const id = p.slice(colName.length + 1);
            return { id, ref: docRef(colName, id), data: () => JSON.parse(JSON.stringify(d)) };
          });
        return { empty: found.length === 0, size: found.length, docs: found };
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

  return { mockDb, docs, control, snapshots };
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
  getRazorpayKeyId: () => "rzp_test_final",
}));

vi.mock("../src/core/errors", async (io) => ({
  ...(await io<any>()),
  captureErrorSnapshot: vi.fn(async (s: any) => {
    snapshots.push(s);
    return "snap_1";
  }),
}));

import {
  autoRefund,
  verifyPayment,
  completeRecoveredCapture,
  __setPaymentsFetchForTests,
  __setRefundPostForTests,
} from "../src/modules/payments/razorpay.service";
import { handleRazorpayWebhook } from "../src/modules/payments/webhookHandler";
import {
  recoverStuckCaptureFulfilments,
  CAPTURE_RECOVERY_SCAN_LIMIT,
} from "../src/modules/payments/captureRecovery";
import { CAPTURE_RECOVERY_AFTER_MS } from "../src/modules/payments/captureFulfillment";
import { config } from "../src/config/env";

const BRANCH = "branch_fin";
const SECRET = "rzp_fin_secret";
const WHSEC = "whsec_fin_test_only";
const ITEMS = [{ id: "p1", productId: "p1", name: "Burger", price: 100, quantity: 1 }];

const signVerify = (gw: string, pay: string) =>
  crypto.createHmac("sha256", SECRET).update(`${gw}|${pay}`).digest("hex");
const signWebhook = (raw: string) =>
  crypto.createHmac("sha256", WHSEC).update(raw).digest("hex");

function seedBase() {
  docs.set(`branches/${BRANCH}`, { id: BRANCH, isOpen: true, packagingFee: 0, monthlyFee: 0 });
  docs.set("products/p1", { id: "p1", name: "Burger", price: 100, inStock: true });
}

/** A paid, PLACED order with a paid intent, ready for either capture channel. */
function seedPaidOrder(
  orderId: string,
  gatewayOrderId: string,
  paymentId: string,
  over: Record<string, any> = {}
) {
  docs.set(`orders/${orderId}`, {
    id: orderId,
    customerId: "cust_fin",
    userId: "cust_fin",
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
    customerId: "cust_fin",
    pricing: { grandTotal: 100, loyaltyDiscount: 0, split: { branchTransferPaise: 10000 } },
    createdAtMs: Date.now(),
    expiresAtMs: Date.now() + 60_000,
  });
}

const orderOf = (id: string) => docs.get(`orders/${id}`);
const refundLedgerKeys = () =>
  [...docs.keys()].filter((k) => k.startsWith("payment_refund_requests/"));

beforeEach(() => {
  for (const key of [...docs.keys()]) docs.delete(key);
  snapshots.length = 0;
  control.refundPosts = [];
  control.refundQueue = [];
  control.gateway = {};

  config.mock.paymentGateway = false;
  config.mock.petpoojaPos = true;
  config.razorpay.keySecret = SECRET;
  config.razorpay.webhookSecret = WHSEC;
  seedBase();

  __setRefundPostForTests(async (paymentId: string, body: any, key: string) => {
    // Record EVERY attempt (success or failure): the assertion under test is
    // "how many refunds did we ask the gateway for", not just successes.
    control.refundPosts.push({ paymentId, body, key });
    const next = control.refundQueue.shift();
    if (next instanceof Error) throw next;
    return next ?? {
      id: `rfnd_fin_${paymentId}`,
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

// ===========================================================================
// FINDING 1 — a confirmed order must leave the recovery scan.
// ===========================================================================
/**
 * A CAPTURED-BUT-UNCONFIRMED order: the gateway has the money and the gate
 * decided `fulfillable`, but no channel has written payment truth yet. This is
 * the only shape in which a confirmation actually happens (a `paymentStatus:
 * completed` order is a replay).
 */
function seedUnconfirmedCapture(
  orderId: string,
  gatewayOrderId: string,
  paymentId: string,
  over: Record<string, any> = {}
) {
  seedPaidOrder(orderId, gatewayOrderId, paymentId, over);
  docs.set(`orders/${orderId}`, {
    ...orderOf(orderId),
    payment: {
      method: "online",
      status: "pending",
      razorpayPaymentId: paymentId,
      razorpayOrderId: gatewayOrderId,
      capturedAmountPaise: 10000,
    },
    "payment.status": "pending",
    paymentStatus: "pending",
    captureFulfillment: { state: "fulfillable", paymentId, atMs: Date.now() },
    captureFulfillmentState: "fulfillable",
  });
}

describe("FINDING 1 — terminal confirmation clears the recovery scan state", () => {
  it("a fulfilled order confirmed by VERIFY no longer carries a scan state", async () => {
    // The gate decided "fulfillable" and the channel is about to confirm.
    seedUnconfirmedCapture("ord_v", "rzp_v", "pay_v");
    __setPaymentsFetchForTests(async () => ({
      id: "pay_v",
      order_id: "rzp_v",
      amount: 10000,
      currency: "INR",
      status: "captured",
      notes: { orderId: "ord_v" },
    }));

    const res: any = await verifyPayment(
      {
        orderId: "ord_v",
        razorpayOrderId: "rzp_v",
        razorpayPaymentId: "pay_v",
        razorpaySignature: signVerify("rzp_v", "pay_v"),
      },
      { uid: "cust_fin" }
    );
    expect(res.ok).toBe(true);
    expect(orderOf("ord_v").paymentStatus).toBe("completed");

    // The terminal state is no longer something a recovery sweep should see.
    expect(orderOf("ord_v").captureFulfillmentState).not.toBe("fulfillable");
  });

  it("a fulfilled order confirmed by the WEBHOOK no longer carries a scan state", async () => {
    seedUnconfirmedCapture("ord_w", "rzp_w", "pay_w");

    const payload = {
      id: "evt_w",
      event: "payment.captured",
      created_at: Math.floor(Date.now() / 1000),
      payload: {
        payment: {
          entity: {
            id: "pay_w",
            order_id: "rzp_w",
            amount: 10000,
            currency: "INR",
            notes: { orderId: "ord_w", branchId: BRANCH },
          },
        },
      },
    };
    const raw = JSON.stringify(payload);
    const req: any = {
      headers: { "x-razorpay-signature": signWebhook(raw), "x-razorpay-event-id": payload.id },
      rawBody: Buffer.from(raw, "utf8"),
      body: payload,
    };
    const res: any = { status: () => ({ json: () => undefined }) };
    await handleRazorpayWebhook(req, res);

    expect(orderOf("ord_w").paymentStatus).toBe("completed");
    expect(orderOf("ord_w").captureFulfillmentState).not.toBe("fulfillable");
  });

  it("a backlog of healthy confirmed orders cannot starve a crashed paid order", async () => {
    // Fill the page with more CONFIRMED orders than the scan limit, each left in
    // the `fulfillable` mirror exactly as the pre-fix code left them. This is
    // the situation that used to occupy the bounded page forever.
    const backlog = CAPTURE_RECOVERY_SCAN_LIMIT + 5;
    for (let i = 0; i < backlog; i += 1) {
      seedPaidOrder(`ord_old_${i}`, `rzp_old_${i}`, `pay_old_${i}`, {
        captureFulfillment: {
          state: "fulfillable",
          paymentId: `pay_old_${i}`,
          // Stale enough to be scanned, but ALREADY CONFIRMED: it must be
          // retired rather than occupy the lane.
          atMs: Date.now() - CAPTURE_RECOVERY_AFTER_MS - 60_000,
        },
        captureFulfillmentState: "fulfillable",
      });
      expect(
        await completeRecoveredCapture({
          orderId: `ord_old_${i}`,
          razorpayPaymentId: `pay_old_${i}`,
        })
      ).toBe(true);
      expect(orderOf(`ord_old_${i}`).captureFulfillmentState).not.toBe("fulfillable");
    }

    // Now a genuinely stuck order is created AFTER the page would have filled.
    seedUnconfirmedCapture("ord_stuck_victim", "rzp_stuck_victim", "pay_stuck_victim");
    docs.set("orders/ord_stuck_victim", {
      ...orderOf("ord_stuck_victim"),
      captureFulfillment: {
        state: "fulfillable",
        paymentId: "pay_stuck_victim",
        atMs: Date.now() - CAPTURE_RECOVERY_AFTER_MS - 60_000,
      },
    });

    const stats = await recoverStuckCaptureFulfilments();
    expect(stats.confirmed).toBe(1);
    expect(orderOf("ord_stuck_victim").paymentStatus).toBe("completed");
  });
});

// ===========================================================================
// FINDING 2 — an UNCERTAIN refund outcome must keep the claim.
// ===========================================================================
describe("FINDING 2 — only a PROVEN rejection releases the refund claim", () => {
  const seedRefundable = (orderId: string, paymentId: string) => {
    docs.set(`orders/${orderId}`, {
      id: orderId,
      payment: { razorpayPaymentId: paymentId, status: "completed", capturedAmountPaise: 10000 },
      "payment.razorpayPaymentId": paymentId,
      "payment.capturedAmountPaise": 10000,
      pricing: { grandTotal: 100 },
      paymentStatus: "completed",
    });
  };

  /** A transport loss: the request left, the gateway may have accepted it. */
  const lostResponse = () => {
    const err: any = new Error("socket hang up");
    err.code = "ECONNRESET";
    return err;
  };

  /** A proveable rejection: the gateway answered with a 4xx. */
  const proven4xx = () => {
    const err: any = new Error("The payment has been fully refunded.");
    err.statusCode = 400;
    return err;
  };

  it("a LOST RESPONSE keeps the claim, so a DIFFERENT key cannot post a second partial", async () => {
    seedRefundable("ord_lost", "pay_lost");
    control.refundQueue = [lostResponse()];

    await expect(
      autoRefund({
        orderId: "ord_lost",
        razorpayPaymentId: "pay_lost",
        amountRupees: 40,
        reason: "ticket A",
        refundRequestId: "req_lost_a",
      })
    ).rejects.toBeTruthy();

    // The outstanding identity must survive: the money may already be out.
    expect(orderOf("ord_lost").refundActiveClaim).toMatchObject({
      requestId: "req_lost_a",
    });

    // A different operator, different key: refused instead of paying again.
    const second: any = await autoRefund({
      orderId: "ord_lost",
      razorpayPaymentId: "pay_lost",
      amountRupees: 40,
      reason: "ticket B",
      refundRequestId: "req_lost_b",
    }).then(
      (r) => ({ unexpectedSuccess: r }),
      (e) => e
    );
    expect(second.unexpectedSuccess).toBeUndefined();
    // Refused because the outstanding identity is still held: either the lease
    // is live (`REFUND_IN_PROGRESS`) or the differing request demands
    // reconciliation (`REFUND_RECONCILIATION_REQUIRED`). Both mean "do not pay
    // again"; neither releases the money twice.
    expect(["REFUND_IN_PROGRESS", "REFUND_RECONCILIATION_REQUIRED"]).toContain(second.code);
    // Exactly ONE gateway POST for the money that actually moved.
    expect(control.refundPosts).toHaveLength(1);
  });

  it("the SAME key still retries safely after a lost response (no second payout)", async () => {
    seedRefundable("ord_lost_same", "pay_lost_same");
    control.refundQueue = [lostResponse(), { id: "rfnd_same_1", status: "processed", amount: 4000 }];

    await expect(
      autoRefund({
        orderId: "ord_lost_same",
        razorpayPaymentId: "pay_lost_same",
        amountRupees: 40,
        reason: "ticket A",
        refundRequestId: "req_same_a",
      })
    ).rejects.toBeTruthy();

    // Same identity, immediately: allowed to retry on the SAME key. The
    // production guarantee is the IDENTICAL gateway idempotency key, which
    // makes Razorpay replay the original refund instead of creating a second.
    const retried: any = await autoRefund({
      orderId: "ord_lost_same",
      razorpayPaymentId: "pay_lost_same",
      amountRupees: 40,
      reason: "ticket A",
      refundRequestId: "req_same_a",
    });
    expect(retried.id).toBe("rfnd_same_1");
    expect(control.refundPosts).toHaveLength(2);
    expect(control.refundPosts[0].key).toBe(control.refundPosts[1].key);
    // And the money is accounted ONCE.
    expect(refundLedgerKeys()).toHaveLength(1);
    expect(orderOf("ord_lost_same").refundedTotalPaise).toBe(4000);
  });

  it("a PROVEN 4xx releases the claim so a later legitimate refund is not wedged", async () => {
    seedRefundable("ord_4xx", "pay_4xx");
    control.refundQueue = [proven4xx()];

    await expect(
      autoRefund({
        orderId: "ord_4xx",
        razorpayPaymentId: "pay_4xx",
        amountRupees: 40,
        reason: "ticket A",
        refundRequestId: "req_4xx_a",
      })
    ).rejects.toBeTruthy();

    // Nothing moved: no outstanding identity, and no claim lease.
    expect(orderOf("ord_4xx").refundActiveClaim).toBeNull();
    expect(orderOf("ord_4xx").refundClaimedAt ?? null).toBeNull();

    // A genuinely new request is accepted and posts exactly once.
    const fresh: any = await autoRefund({
      orderId: "ord_4xx",
      razorpayPaymentId: "pay_4xx",
      amountRupees: 40,
      reason: "ticket B",
      refundRequestId: "req_4xx_b",
    });
    expect(fresh.id).toBeTruthy();
    expect(control.refundPosts).toHaveLength(2);
  });

  it("a proven transient failure (5xx) still retries through the SAME identity", async () => {
    seedRefundable("ord_5xx", "pay_5xx");
    const transient: any = new Error("upstream temporarily unavailable");
    transient.statusCode = 503;
    control.refundQueue = [
      transient,
      { id: "rfnd_5xx_ok", status: "processed", amount: 4000 },
    ];

    await expect(
      autoRefund({
        orderId: "ord_5xx",
        razorpayPaymentId: "pay_5xx",
        amountRupees: 40,
        reason: "ticket A",
        refundRequestId: "req_5xx_a",
      })
    ).rejects.toBeTruthy();

    const retried: any = await autoRefund({
      orderId: "ord_5xx",
      razorpayPaymentId: "pay_5xx",
      amountRupees: 40,
      reason: "ticket A",
      refundRequestId: "req_5xx_a",
    });
    expect(retried.id).toBe("rfnd_5xx_ok");
    expect(refundLedgerKeys()).toHaveLength(1);
  });
});
