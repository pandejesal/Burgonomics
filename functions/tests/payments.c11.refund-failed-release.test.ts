import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as crypto from "node:crypto";

/**
 * C11 / A1-payments finding 2 (Critical) — a gateway `refund.failed` must
 * RELEASE the order, not leave it permanently wedged.
 *
 * Before this contract the handler only deleted
 * `settlementProcessedRefunds[refundId]` and answered 200. Everything else the
 * pending refund had reserved stayed in place:
 *   • `refundLedger[refundId]` (so the amount still consumed the refundable cap),
 *   • `refundedTotalPaise` (so the order looked partly/fully refunded),
 *   • `refundStatus: "refund_pending"` + `refundPendingGatewayId/Since`
 *     (so the single-in-flight guard answered 409 REFUND_IN_PROGRESS forever),
 *   • `refunds/{row}` stayed `IN_FLIGHT` (the console mapped it to the
 *     non-actionable UNKNOWN and offered no Approve/Retry),
 *   • `payment_refund_requests/{id}` stayed `pending`, so a same-request retry
 *     hit the "accepted-but-unsettled" shortcut and returned
 *     `{status:"pending", reused:true}` WITHOUT POSTing anything.
 *
 * Contract pinned here:
 *   1. one transaction releases this refund's own reservation, recomputes the
 *      total from the ledger, clears the pending markers and restores a status
 *      that no longer says "in flight";
 *   2. the correlated operator row and request record end FAILED, with a
 *      failure reason a human can read;
 *   3. the customer is told and ops gets a HIGH snapshot;
 *   4. the SAME request id can be retried and actually reaches the gateway,
 *      on a NEW idempotency key (Razorpay dedupes a failed refund by key, so
 *      reusing the failed key would replay the failure, never move money);
 *   5. a late `refund.failed` for a refund that is already SETTLED changes
 *      nothing, and a failure that names no known order parks visibly instead
 *      of silently 200-ing.
 *
 * NO NETWORK: provider POST is the refund seam, webhooks are really signed.
 * HONESTY LIMIT: in-process datastore model (strict read-before-write,
 * literal-dot set keys, recursive merge); it proves handler/store behaviour,
 * not real Firebase cross-process transaction semantics.
 */
const { mockDb, docs, control } = vi.hoisted(() => {
  process.env.OTP_HMAC_SECRET = "test_otp_c11_refund_failed";

  const docs = new Map<string, any>();
  const control = {
    readAfterWriteViolations: 0,
    refundPosts: [] as Array<{ paymentId: string; body: any; key: string }>,
    snapshots: [] as any[],
    notifications: [] as any[],
  };

  const isPlain = (v: any) => !!v && typeof v === "object" && !Array.isArray(v);
  const isDelete = (v: any) => isPlain(v) && v.__fakeDelete === true;

  const mergeInto = (target: any, patch: any): any => {
    const out: any = isPlain(target) ? { ...target } : {};
    for (const [key, value] of Object.entries(patch)) {
      if (isDelete(value)) {
        delete out[key];
        continue;
      }
      if (isPlain(value)) {
        out[key] = mergeInto(out[key], value);
        continue;
      }
      out[key] = value;
    }
    return out;
  };

  const clone = (v: any) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

  const applyWrite = (path: string, data: any, merge?: boolean) => {
    const base = merge ? docs.get(path) : undefined;
    docs.set(path, clone(mergeInto(base, data)));
  };

  const nested = (doc: any, path: string) =>
    path.split(".").reduce((o: any, k) => (o == null ? undefined : o[k]), doc);

  const docRef = (col: string, id: string) => {
    const path = `${col}/${id}`;
    return {
      id,
      path,
      get: async () => {
        const exists = docs.has(path);
        const captured = exists ? clone(docs.get(path)) : undefined;
        return { exists, data: () => clone(captured), ref: docRef(col, id) };
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
      delete: async () => void docs.delete(path),
    };
  };

  const collectionMock = (colName: string) => {
    const filters: Array<{ field: string; value: any }> = [];
    let limitN: number | null = null;
    const q: any = {
      where: (field: string, _op: string, value: any) => {
        filters.push({ field, value });
        return q;
      },
      limit: (n: number) => {
        limitN = n;
        return q;
      },
      orderBy: () => q,
      get: async () => {
        const found = [...docs.entries()]
          .filter(([p]) => p.startsWith(`${colName}/`))
          .filter(([, d]) => filters.every((f) => nested(d, f.field) === f.value))
          .map(([p]) => {
            const id = p.slice(colName.length + 1);
            const captured = clone(docs.get(p));
            return { id, ref: docRef(colName, id), exists: true, data: () => clone(captured) };
          });
        const page = limitN === null ? found : found.slice(0, limitN);
        return { empty: page.length === 0, size: page.length, docs: page };
      },
      doc: (docId?: string) =>
        docRef(colName, docId || `auto_${Math.random().toString(36).slice(2, 8)}`),
    };
    return q;
  };

  const runTransaction = async (fn: (tx: any) => any): Promise<any> => {
    const writes: Array<{ path: string; data: any; merge?: boolean }> = [];
    const tx = {
      get: async (ref: any) => {
        if (writes.length > 0) {
          control.readAfterWriteViolations += 1;
          const err: any = new Error(
            "FAILED_PRECONDITION: Firestore transactions require all reads to be " +
              "executed before all writes"
          );
          err.code = 9;
          throw err;
        }
        const stored = docs.has(ref.path) ? clone(docs.get(ref.path)) : undefined;
        return { exists: stored !== undefined, data: () => clone(stored), ref };
      },
      set: (ref: any, data: any, opts?: any) =>
        void writes.push({ path: ref.path, data, merge: !!opts?.merge }),
      update: (ref: any, data: any) => void writes.push({ path: ref.path, data, merge: true }),
    };
    const result = await fn(tx);
    for (const w of writes) applyWrite(w.path, w.data, w.merge);
    return result;
  };

  const mockDb: any = { collection: collectionMock, runTransaction };
  return { mockDb, docs, control };
});

vi.mock("firebase-admin", () => {
  const FieldValue = {
    serverTimestamp: () => "MOCK_SERVER_TIMESTAMP",
    increment: (n: number) => n,
    arrayUnion: (item: any) => [item],
    delete: () => ({ __fakeDelete: true }),
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

vi.mock("../src/core/errors", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/core/errors")>()),
  captureErrorSnapshot: vi.fn(async (snapshot: any) => {
    control.snapshots.push(snapshot);
    return "mock_snapshot";
  }),
}));

vi.mock("../src/modules/tickets/supportNotifications", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/modules/tickets/supportNotifications")>()),
  dispatchCustomerAccountNotification: vi.fn(async (request: any) => {
    control.notifications.push(request);
    return { outcome: "unknown", detail: "no_provider_ack" };
  }),
}));

import { handleRazorpayWebhook } from "../src/modules/payments/webhookHandler";
import {
  autoRefund,
  computeGatewayRefundKey,
  refundRequestDocId,
  __setRefundPostForTests,
} from "../src/modules/payments/razorpay.service";
import { config } from "../src/config/env";

const WEBHOOK_SECRET = "whsec_c11_refund_failed";
const CAPTURE_PAISE = 50000;
const REFUND_PAISE = 10000;

const orderOf = (orderId: string) => docs.get(`orders/${orderId}`);
const rowOf = (rowId: string) => docs.get(`refunds/${rowId}`);
const requestDocOf = (orderId: string, paymentId: string, requestId: string) =>
  docs.get(`payment_refund_requests/${refundRequestDocId(orderId, paymentId, requestId)}`);
const postCount = () => control.refundPosts.length;

/** An order the release path just parked as an ACCEPTED, unsettled refund. */
function seedPendingRefund(orderId: string, requestId: string, gatewayRefundId: string) {
  const paymentId = `pay_${orderId}`;
  const rowId = requestId.replace(/^refundreq_/, "");
  docs.set(`orders/${orderId}`, {
    id: orderId,
    branchId: "branch_c11",
    customerId: "cust_c11",
    paymentStatus: "completed",
    payment: {
      status: "completed",
      razorpayPaymentId: paymentId,
      capturedAmountPaise: CAPTURE_PAISE,
      refundStatus: "pending",
    },
    pricing: { grandTotal: CAPTURE_PAISE / 100 },
    refundStatus: "refund_pending",
    refundPendingGatewayId: gatewayRefundId,
    refundPendingSince: 1_700_000_000_000,
    refundedTotalPaise: REFUND_PAISE,
    refundLedger: { [gatewayRefundId]: REFUND_PAISE },
    settlementProcessedRefunds: {},
    refundKeyedReceipts: { [gatewayRefundId]: requestId },
    refundObligation: { status: "IN_FLIGHT", gatewayRefundId },
  });
  docs.set(`payment_refund_requests/${refundRequestDocId(orderId, paymentId, requestId)}`, {
    orderId,
    paymentId,
    refundRequestId: requestId,
    requestedPaise: REFUND_PAISE,
    reason: "bank rejected the credit",
    status: "pending",
    refundId: gatewayRefundId,
    gatewayStatus: "pending",
    gatewayKey: computeGatewayRefundKey(orderId, paymentId, requestId),
    acceptedAt: 1_700_000_000_000,
  });
  docs.set(`refunds/${rowId}`, {
    id: rowId,
    orderId,
    amountPaise: REFUND_PAISE,
    status: "IN_FLIGHT",
    gatewayStatus: "pending",
    gatewayRefundId,
    refundId: gatewayRefundId,
  });
  return { paymentId, rowId };
}

const failedRefundPayload = (
  eventId: string,
  refundId: string,
  paymentId: string,
  over: Record<string, any> = {}
) => ({
  id: eventId,
  event: "refund.failed",
  created_at: Math.floor(Date.now() / 1000),
  payload: {
    refund: {
      entity: {
        id: refundId,
        payment_id: paymentId,
        amount: REFUND_PAISE,
        currency: "INR",
        status: "failed",
        error_description: "The customer's bank declined the credit",
        notes: {},
        ...over,
      },
    },
  },
});

function deliver(payload: any) {
  const rawBody = JSON.stringify(payload);
  const signature = crypto
    .createHmac("sha256", WEBHOOK_SECRET)
    .update(rawBody)
    .digest("hex");
  const req: any = {
    headers: { "x-razorpay-event-id": payload.id, "x-razorpay-signature": signature },
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
  return handleRazorpayWebhook(req, res).then(() => ({ statusCode, body }));
}

let prevMock = true;
let prevSecret = "";

beforeEach(() => {
  docs.clear();
  control.readAfterWriteViolations = 0;
  control.refundPosts = [];
  control.snapshots = [];
  control.notifications = [];
  prevMock = config.mock.paymentGateway;
  prevSecret = config.razorpay.webhookSecret;
  config.mock.paymentGateway = false;
  config.razorpay.webhookSecret = WEBHOOK_SECRET;
  __setRefundPostForTests(async (paymentId: string, body: any, key: string) => {
    control.refundPosts.push({ paymentId, body, key });
    return {
      id: `rfnd_c11_${control.refundPosts.length}`,
      payment_id: paymentId,
      amount: body.amount ?? REFUND_PAISE,
      status: "pending",
    };
  });
});

afterEach(() => {
  __setRefundPostForTests(null);
  config.mock.paymentGateway = prevMock;
  config.razorpay.webhookSecret = prevSecret;
});

describe("C11 refund.failed releases the reservation instead of wedging it", () => {
  it("releases the ledger, cap, pending markers and restores a non-in-flight status", async () => {
    const { paymentId, rowId } = seedPendingRefund(
      "ord_c11_fail",
      "refundreq_c11_fail",
      "rfnd_c11_failed_1"
    );

    const out = await deliver(
      failedRefundPayload("evt_c11_rf_fail", "rfnd_c11_failed_1", paymentId, {
        notes: { orderId: "ord_c11_fail" },
      })
    );

    expect(out.statusCode).toBe(200);
    expect(control.readAfterWriteViolations).toBe(0);

    const order = orderOf("ord_c11_fail");
    // (a) the reservation is gone and the total is recomputed from the ledger
    expect(order.refundLedger ?? {}).not.toHaveProperty("rfnd_c11_failed_1");
    expect(order.refundedTotalPaise ?? 0).toBe(0);
    expect(order.settlementProcessedRefunds ?? {}).not.toHaveProperty("rfnd_c11_failed_1");
    // (b) no marker still claims a refund is in flight
    expect(order.refundPendingGatewayId).toBeUndefined();
    expect(order.refundPendingSince).toBeUndefined();
    expect(String(order.refundStatus || "")).not.toBe("refund_pending");
    expect(String(order.payment?.refundStatus || "")).not.toBe("pending");
    // the obligation no longer says IN_FLIGHT
    expect(String(order.refundObligation?.status || "")).not.toBe("IN_FLIGHT");

    // (c) the operator row and the request record are terminally FAILED
    const row = rowOf(rowId);
    expect(String(row.status).toUpperCase()).toBe("FAILED");
    expect(typeof row.failureReason).toBe("string");
    expect(row.failureReason.length).toBeGreaterThan(0);
    expect(row.gatewayRefundId).toBe("rfnd_c11_failed_1");

    const request = requestDocOf("ord_c11_fail", paymentId, "refundreq_c11_fail");
    expect(String(request.status)).toBe("failed");
    expect(typeof request.failureReason).toBe("string");

    // (d) ops sees it, the customer is told
    expect(
      control.snapshots.some(
        (s) =>
          s.severity === "high" &&
          typeof s.message === "string" &&
          s.message.includes("rfnd_c11_failed_1")
      )
    ).toBe(true);
    expect(control.notifications.length).toBeGreaterThan(0);
    expect(control.notifications[0].recipientUid).toBe("cust_c11");
    // Copy carries no order id, name or amount.
    expect(String(control.notifications[0].body)).not.toContain("ord_c11_fail");
  });

  it("a retry with the same request id reaches the gateway on a NEW idempotency key", async () => {
    const { paymentId } = seedPendingRefund(
      "ord_c11_retry",
      "refundreq_c11_retry",
      "rfnd_c11_failed_2"
    );

    await deliver(
      failedRefundPayload("evt_c11_rf_fail2", "rfnd_c11_failed_2", paymentId, {
        notes: { orderId: "ord_c11_retry" },
      })
    );
    expect(postCount()).toBe(0);

    const retried: any = await autoRefund({
      orderId: "ord_c11_retry",
      razorpayPaymentId: paymentId,
      amountRupees: REFUND_PAISE / 100,
      reason: "bank rejected the credit",
      refundRequestId: "refundreq_c11_retry",
    });

    // It must actually POST: replaying a FAILED refund under the failed key
    // would return the failure again and never move money.
    expect(postCount()).toBe(1);
    expect(retried.status).toBe("pending");
    const failedKey = computeGatewayRefundKey("ord_c11_retry", paymentId, "refundreq_c11_retry");
    expect(control.refundPosts[0].key).not.toBe(failedKey);

    // The retry re-reserves the amount it is attempting.
    const order = orderOf("ord_c11_retry");
    expect(order.refundedTotalPaise).toBe(REFUND_PAISE);
    expect(Object.keys(order.refundLedger)).toHaveLength(1);
  });

  it("a late refund.failed for an ALREADY settled refund changes nothing", async () => {
    const { paymentId } = seedPendingRefund(
      "ord_c11_settled",
      "refundreq_c11_settled",
      "rfnd_c11_settled_1"
    );
    // The processed webhook already settled this exact refund.
    const order = orderOf("ord_c11_settled");
    order.refundObligation = { status: "SETTLED", settledRefundId: "rfnd_c11_settled_1" };
    order.refundStatus = "partially_refunded";
    order.refundPendingGatewayId = undefined;
    order.refundPendingSince = undefined;
    order.payment.refundStatus = "partially_refunded";

    const out = await deliver(
      failedRefundPayload("evt_c11_rf_settled", "rfnd_c11_settled_1", paymentId, {
        notes: { orderId: "ord_c11_settled" },
      })
    );
    expect(out.statusCode).toBe(200);

    const after = orderOf("ord_c11_settled");
    // Money truth is NOT rewritten by a contradictory late signal.
    expect(after.refundedTotalPaise).toBe(REFUND_PAISE);
    expect(after.refundLedger).toEqual({ "rfnd_c11_settled_1": REFUND_PAISE });
    expect(after.refundStatus).toBe("partially_refunded");
    // …but a human must see the contradiction.
    expect(
      control.snapshots.some(
        (s) => s.severity === "high" && String(s.message).includes("rfnd_c11_settled_1")
      )
    ).toBe(true);
  });

  it("a failure that names no known order is parked, never silently 200'd", async () => {
    const out = await deliver(
      failedRefundPayload("evt_c11_rf_orphan", "rfnd_c11_orphan", "pay_unknown_c11", {
        notes: { orderId: "ord_c11_missing" },
      })
    );
    expect(out.statusCode).toBe(200);
    const park = docs.get("unmatched_payments/ump_refund_failed_evt_c11_rf_orphan");
    expect(park).toMatchObject({ status: "needs_review" });
    expect(park.refundId).toBe("rfnd_c11_orphan");
  });
});

/**
 * ROUND-B SEMANTIC CHECK — the refund-failure release (this package) against
 * the refund-after-close settlement correction (settlement-c11, already merged).
 *
 * Both of these must hold at once:
 *   • a refund that later FAILS must not leave a settlement correction behind
 *     (either the failure cancels/reverses it, or one is never queued before
 *     the refund is PROVEN processed);
 *   • a refund PROCESSED after the month closed must queue exactly one
 *     correction, however many times the event is delivered.
 *
 * `settlementProcessedRefunds[refundId]` is the only signal that money actually
 * moved, and `queueRefundCorrectionInTx` fires on exactly that 0→amount
 * transition. These cases pin the gating rather than any one call site, so a
 * future refactor that queues optimistically at POST time fails here.
 */
/** A month whose statement has already closed: Sep 2026 (IST). */
const CLOSED_MS = Date.UTC(2026, 8, 15, 6, 0);
const CLOSED_MONTH = "2026-09";
const correctionJobs = () =>
  [...docs.keys()].filter((path) => path.startsWith("settlement_corrections/"));
const closedMonthMarker = () =>
  docs.get(`settlement_capture_regeneration/branch_c11_${CLOSED_MONTH}`);

const processedRefundPayload = (
  eventId: string,
  refundId: string,
  paymentId: string
) => ({
  id: eventId,
  event: "refund.processed",
  created_at: Math.floor(Date.now() / 1000),
  payload: {
    refund: {
      entity: {
        id: refundId,
        payment_id: paymentId,
        amount: REFUND_PAISE,
        currency: "INR",
        status: "processed",
        notes: {},
      },
    },
  },
});

describe("refund failure vs the settlement correction (round-b hot spot)", () => {
  it("a failed, never-processed refund leaves no correction to reverse", async () => {
    const { paymentId } = seedPendingRefund(
      "ord_c11_unprocessed",
      "refundreq_c11_unprocessed",
      "rfnd_c11_unprocessed"
    );
    // Make the order settleable so the gate — not a missing field — is what
    // keeps the correction away.
    Object.assign(orderOf("ord_c11_unprocessed"), {
      paymentChannel: "razorpay",
      settlementEffectiveAtMs: CLOSED_MS,
    });

    const out = await deliver(
      failedRefundPayload("evt_c11_unprocessed_fail", "rfnd_c11_unprocessed", paymentId, {
        notes: { orderId: "ord_c11_unprocessed" },
      })
    );

    expect(out.statusCode).toBe(200);
    expect(control.readAfterWriteViolations).toBe(0);
    expect(correctionJobs()).toHaveLength(0);
    expect(closedMonthMarker()).toBeUndefined();
    // Nothing was ever recorded as money returned, so nothing needs restoring.
    expect(orderOf("ord_c11_unprocessed").settlementProcessedRefunds ?? {}).toEqual({});
  });

  it("a pending gateway response queues no correction either", async () => {
    const { paymentId } = seedPendingRefund(
      "ord_c11_still_pending",
      "refundreq_c11_still_pending",
      "rfnd_c11_still_pending"
    );
    Object.assign(orderOf("ord_c11_still_pending"), {
      paymentChannel: "razorpay",
      settlementEffectiveAtMs: CLOSED_MS,
    });

    // The attempt is accepted as `pending` — documented as NOT final — so the
    // statement must not be regenerated for money that has not moved.
    await deliver(
      failedRefundPayload(
        "evt_c11_still_pending_fail",
        "rfnd_c11_still_pending",
        paymentId,
        { notes: { orderId: "ord_c11_still_pending" } }
      )
    );
    const retried: any = await autoRefund({
      orderId: "ord_c11_still_pending",
      razorpayPaymentId: paymentId,
      amountRupees: REFUND_PAISE / 100,
      reason: "retry after the bank declined",
      refundRequestId: "refundreq_c11_still_pending",
    });

    expect(postCount()).toBe(1);
    expect(retried.status).toBe("pending");
    expect(correctionJobs()).toHaveLength(0);
    expect(closedMonthMarker()).toBeUndefined();
    expect(orderOf("ord_c11_still_pending").settlementProcessedRefunds ?? {}).toEqual({});
  });

  it("a failure that reverses a recorded processed refund re-requests the month correction", async () => {
    const { paymentId } = seedPendingRefund(
      "ord_c11_reverse",
      "refundreq_c11_reverse",
      "rfnd_c11_reverse"
    );
    // Money was recorded as returned — so any statement generated after that
    // point deducted it — but NO operator record proves it: `refundKeyedReceipts`
    // is empty (the gateway callback beat our POST response, so the request and
    // row were never bound to this gateway id). That is the state in which the
    // release path legitimately removes the entry, and the month must then be
    // regenerated from the corrected truth.
    Object.assign(orderOf("ord_c11_reverse"), {
      paymentChannel: "razorpay",
      settlementEffectiveAtMs: CLOSED_MS,
      settlementProcessedRefunds: { rfnd_c11_reverse: REFUND_PAISE },
      refundKeyedReceipts: {},
    });

    const out = await deliver(
      failedRefundPayload("evt_c11_reverse_fail", "rfnd_c11_reverse", paymentId, {
        notes: { orderId: "ord_c11_reverse" },
      })
    );

    expect(out.statusCode).toBe(200);
    expect(control.readAfterWriteViolations).toBe(0);
    expect(orderOf("ord_c11_reverse").settlementProcessedRefunds ?? {}).toEqual({});
    // The reversal is a REGENERATION REQUEST, not an amount: the statement math
    // derives the refund from `settlementProcessedRefunds`, so re-queueing with
    // the entry removed is what makes the closed month drop a refund that never
    // happened. Idempotent by construction — the queue is keyed per job.
    const jobs = correctionJobs().filter(
      (path) => docs.get(path)?.monthKey === CLOSED_MONTH
    );
    expect(jobs).toHaveLength(1);
    expect(docs.get(jobs[0])).toMatchObject({
      orderId: "ord_c11_reverse",
      kind: "refund",
      regenerationPending: true,
    });
    const jobId = jobs[0].slice("settlement_corrections/".length);
    expect(Object.keys(closedMonthMarker().pending)).toEqual([jobId]);
  });

  it("a refund processed after close queues exactly one correction, and a replay queues none", async () => {
    const { paymentId } = seedPendingRefund(
      "ord_c11_after_close",
      "refundreq_c11_after_close",
      "rfnd_c11_after_close"
    );
    Object.assign(orderOf("ord_c11_after_close"), {
      paymentChannel: "razorpay",
      settlementEffectiveAtMs: CLOSED_MS,
    });

    const first = await deliver(
      processedRefundPayload("evt_c11_after_close_1", "rfnd_c11_after_close", paymentId)
    );
    expect(first.statusCode).toBe(200);
    expect(control.readAfterWriteViolations).toBe(0);

    const jobs = correctionJobs();
    expect(jobs).toHaveLength(1);
    const jobId = jobs[0].slice("settlement_corrections/".length);
    const job = docs.get(jobs[0]);
    expect(job).toMatchObject({
      orderId: "ord_c11_after_close",
      kind: "refund",
      monthKey: CLOSED_MONTH,
      regenerationPending: true,
    });
    // The marker is what blocks mark-paid until the month is regenerated, and
    // its key is the job's own publication identity.
    expect(closedMonthMarker().pending).toEqual({
      [jobId]: `settlement-correction:${jobId}`,
    });

    // Same refund, second event id — the money is already in the map, so the
    // 0→amount transition cannot repeat and no second job may appear.
    const replay = await deliver(
      processedRefundPayload("evt_c11_after_close_2", "rfnd_c11_after_close", paymentId)
    );
    expect(replay.statusCode).toBe(200);
    expect(correctionJobs()).toHaveLength(1);
    expect(Object.keys(closedMonthMarker().pending)).toEqual([jobId]);
    expect(orderOf("ord_c11_after_close").settlementProcessedRefunds).toEqual({
      rfnd_c11_after_close: REFUND_PAISE,
    });
  });
});
