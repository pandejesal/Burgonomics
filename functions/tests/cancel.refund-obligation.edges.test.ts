/**
 * Cancel-refund obligation — EDGE CASES the lifecycle suite does not cover.
 *
 * Scope (deliberately narrow, no overlap with
 * cancel.refund-obligation.test.ts / cancel.refund-lifecycle.regression.test.ts):
 *   • capture timing vs the cancellation event (before / after capture)
 *   • the exact 10-minute claim-lease boundary (cancel queue has NO TTL)
 *   • receipt arithmetic that can only ever LOWER the queued amount
 *     (negative scalar, over-refund, unrelated ledger id)
 *   • sibling-row precedence: a human REJECTED decision beats a PENDING row,
 *     an accounted COMPLETED row does not, and a zero-amount PENDING row is
 *     never turned into a staff alert
 *   • a human decision that lands BETWEEN two reconciles, including after the
 *     money is settled elsewhere.
 *
 * The Firestore fake below is behavioural, not an emulator: recursive merge,
 * read-before-write rejection, and query filtering by orderId.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  snapshots: [] as any[],
}));

vi.mock("../src/core/firebase", () => ({ db: {}, auth: {}, messaging: {} }));
vi.mock("../src/modules/notifications/fcmClient", () => ({
  sendFcmMessage: vi.fn(async () => true),
  sendMulticastFcm: vi.fn(async () => ({ successCount: 1 })),
}));
vi.mock("../src/core/errors", () => ({
  captureErrorSnapshot: vi.fn(async (snap: any) => {
    h.snapshots.push(snap);
    return "err_test";
  }),
  serviceError: (code: string, message: string) => Object.assign(new Error(message), { code }),
}));

import {
  planCancelRefundObligation,
  ensureCancelledPaidRefundObligation,
  cancelRefundRequestId,
} from "../src/modules/orders/cancelRefundObligation";

const cancelled = (overrides: Record<string, any> = {}) => ({
  shortCode: "BG-77",
  branchId: "branch_a",
  customerId: "cust_1",
  status: { code: "CANCELLED", terminal: true },
  paymentChannel: "razorpay",
  payment: {
    status: "completed",
    method: "online",
    razorpayPaymentId: "pay_live_1",
    capturedAmountPaise: 45000,
  },
  ...overrides,
});

/** Minimal in-memory Firestore: reads are snapshots, writes commit at the end. */
function makeDb(opts: { order?: any; refunds?: Record<string, any> } = {}) {
  const orders = new Map<string, any>([["ord_1", opts.order ?? cancelled()]]);
  const refunds = new Map<string, any>(Object.entries(opts.refunds || {}));
  const writes: Array<{ kind: string; id: string; data: any; opts?: any }> = [];

  const fakeSnap = (data: any) => ({ exists: data !== undefined, data: () => data });

  const tx = {
    async get(ref: any) {
      if (ref && ref.query) {
        const store = ref.collection === "refunds" ? refunds : orders;
        const docs = [...store.entries()]
          .filter(([, v]) => v.orderId === ref.value)
          .slice(0, ref.cap ?? 10)
          .map(([id, v]) => ({ id, exists: true, data: () => v }));
        return { empty: docs.length === 0, docs, size: docs.length };
      }
      const store = ref.kind === "orders" ? orders : refunds;
      return fakeSnap(store.get(ref.id));
    },
    set(ref: any, data: any, setOpts?: any) {
      writes.push({ kind: ref.kind, id: ref.id, data, opts: setOpts });
      const store = ref.kind === "orders" ? orders : refunds;
      const prev = store.get(ref.id) || {};
      // Firestore merge is RECURSIVE on nested maps.
      const isDelete = (v: any) =>
        v && typeof v === "object" && v.constructor && v.constructor.name === "DeleteTransform";
      const isPlain = (v: any) =>
        v !== null && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype;
      const apply = (previous: any, patch: any, merge: boolean): any => {
        const next = merge ? { ...(previous || {}) } : {};
        for (const [k, v] of Object.entries(patch)) {
          if (isDelete(v)) delete next[k];
          else if (isPlain(v)) next[k] = apply(merge ? next[k] : {}, v, merge);
          else next[k] = v;
        }
        return next;
      };
      store.set(ref.id, apply(prev, data, setOpts?.merge === true));
    },
  };

  const db: any = {
    collection(name: string) {
      if (name === "orders") {
        return {
          doc: (id: string) => ({
            kind: "orders",
            id,
            set: async (data: any, setOpts?: any) => {
              writes.push({ kind: "orders", id, data, opts: setOpts });
              const prev = orders.get(id) || {};
              orders.set(id, setOpts?.merge ? { ...prev, ...data } : data);
            },
          }),
        };
      }
      if (name === "refunds") {
        const buildQuery = (value: string, cap: number) => ({
          collection: "refunds",
          query: true,
          value,
          cap,
          where: () => buildQuery(value, cap),
          limit: (n: number) => buildQuery(value, n),
        });
        return {
          doc: (id: string) => ({ kind: "refunds", id }),
          where: (_field: string, _op: string, value: string) => buildQuery(value, 10),
        };
      }
      return { doc: (id: string) => ({ kind: name, id }) };
    },
    async runTransaction(fn: any) {
      return fn(tx);
    },
  };

  return { db, refunds, orders, writes };
}

beforeEach(() => {
  h.snapshots.length = 0;
});

describe("capture timing vs the cancellation event", () => {
  const cancelledBeforeCapture = () => ({
    shortCode: "BG-80",
    branchId: "branch_a",
    customerId: "cust_1",
    status: { code: "CANCELLED", terminal: true },
    paymentChannel: "razorpay",
    payment: { status: "pending", razorpayOrderId: "order_rzp_1" },
  });

  it("owes nothing when the order was cancelled before the payment was captured", async () => {
    const beforeCapture = cancelledBeforeCapture();
    // No captured payment id exists yet, so the gate stops at the id check.
    expect(planCancelRefundObligation(beforeCapture)).toMatchObject({
      eligible: false,
      reason: "no_payment_id",
    });
    // The other pre-capture shape: an id is present but no captured amount.
    expect(
      planCancelRefundObligation(
        cancelled({ payment: { status: "pending", razorpayPaymentId: "pay_live_1" } })
      )
    ).toMatchObject({ eligible: false, reason: "no_captured_amount" });

    const { db, refunds, orders, writes } = makeDb({ order: beforeCapture });
    const res = await ensureCancelledPaidRefundObligation({
      orderId: "ord_1",
      after: beforeCapture,
      db,
    });
    expect(res.created).toBe(false);
    expect(res.reason).toBe("no_payment_id");
    expect(refunds.size).toBe(0);
    // Not even the order stamp may appear: there is no money to review yet.
    expect(writes).toEqual([]);
    expect(orders.get("ord_1").payment.refundStatus).toBeUndefined();
  });

  it("queues the obligation when the capture lands after the cancellation event", async () => {
    // The event payload is the pre-capture snapshot; the live doc now carries
    // the server capture truth. Planning must use the FRESH doc, not the event.
    const eventPayload = cancelledBeforeCapture();
    expect(planCancelRefundObligation(eventPayload).eligible).toBe(false);

    const { db, refunds, orders } = makeDb({ order: cancelled() });
    const res = await ensureCancelledPaidRefundObligation({
      orderId: "ord_1",
      after: eventPayload,
      db,
    });

    expect(res.created).toBe(true);
    expect(refunds.get(cancelRefundRequestId("ord_1"))).toMatchObject({
      status: "PENDING",
      amountPaise: 45000,
      paymentId: "pay_live_1",
    });
    expect(orders.get("ord_1").payment.capturedAmountPaise).toBe(45000);
  });
});

describe("a refund landing between the event and the transaction", () => {
  it("stands down on the full-intent stamp even with no ledger total written", async () => {
    // The event says nothing was refunded; the live doc carries the
    // unambiguous full-intent shape (refundStatus + refundId + null amount).
    const stale = cancelled();
    const live = cancelled({
      refundStatus: "refunded",
      refundId: "rfnd_full_intent",
      refundAmount: null,
    });
    const { db, refunds } = makeDb({ order: live });

    const res = await ensureCancelledPaidRefundObligation({ orderId: "ord_1", after: stale, db });

    expect(res.created).toBe(false);
    expect(res.reason).toBe("fully_refunded");
    expect(refunds.size).toBe(0);
  });
});

describe("refund claim lease: the exact 10-minute boundary", () => {
  const TTL_MS = 10 * 60_000;

  it.each([
    ["just claimed", 0],
    ["exactly at the 10m TTL", TTL_MS],
    ["1ms past the 10m TTL", TTL_MS + 1],
    ["far past the TTL", 6 * 60 * 60_000],
  ])("stands down on an identified claim %s", (_label, ageMs) => {
    const plan = planCancelRefundObligation(
      cancelled({
        refundActiveClaim: {
          requestId: "rq_boundary",
          claimedAt: Date.now() - ageMs,
          paymentId: "pay_live_1",
        },
      })
    );
    expect(plan.eligible).toBe(false);
    expect(plan.reason).toBe("refund_in_progress");
  });

  it.each([
    ["exactly at the 10m TTL", TTL_MS],
    ["1ms past the 10m TTL", TTL_MS + 1],
  ])("stands down on a legacy timestamped claim %s (no request id)", (_label, ageMs) => {
    const plan = planCancelRefundObligation(
      cancelled({ refundClaimedAt: Date.now() - ageMs })
    );
    expect(plan.eligible).toBe(false);
    expect(plan.reason).toBe("refund_in_progress");
  });

  it("creates no row and withdraws nothing at the TTL boundary", async () => {    const live = cancelled({
      refundActiveClaim: {
        requestId: "rq_boundary",
        claimedAt: Date.now() - TTL_MS,
        paymentId: "pay_live_1",
      },
    });
    const { db, refunds, writes } = makeDb({
      order: live,
      refunds: {
        refund_cancel_ord_1: {
          orderId: "ord_1",
          status: "PENDING",
          ownership: "machine",
          amountPaise: 45000,
        },
      },
    });

    const res = await ensureCancelledPaidRefundObligation({ orderId: "ord_1", after: live, db });

    expect(res.created).toBe(false);
    expect(res.reason).toBe("refund_in_progress");
    expect(res.pendingRefundId).toBeUndefined();
    // The machine row is held (money may be on the wire), never withdrawn.
    expect(refunds.get("refund_cancel_ord_1").status).toBe("PENDING");
    expect(writes).toEqual([]);
  });
});

describe("receipt arithmetic can only lower the queued amount", () => {
  it("ignores a negative refundedTotalPaise instead of inflating the queue", () => {
    const plan = planCancelRefundObligation(
      cancelled({ refundedTotalPaise: -5000, refundLedger: { rfnd_x: -5000 } })
    );
    expect(plan.eligible).toBe(true);
    expect(plan.refundedPaise).toBe(0);
    // Never 45000 - (-5000) = 50000: a queue can never exceed the capture.
    expect(plan.amountPaise).toBe(45000);
  });

  it("treats an over-refund as settled and never queues a negative amount", () => {
    const plan = planCancelRefundObligation(cancelled({ refundedTotalPaise: 45001 }));
    expect(plan.eligible).toBe(false);
    expect(plan.reason).toBe("fully_refunded");
    expect(plan.amountPaise).toBeUndefined();
  });

  it("counts an unrelated ledger refund id toward the captured cap", () => {
    // The ledger is keyed by gateway refund id; an id written by another flow
    // is still real money returned and consumes the cap.
    const plan = planCancelRefundObligation(
      cancelled({
        refundedTotalPaise: 0,
        refundLedger: { rfnd_from_another_flow: 5000 },
      })
    );
    expect(plan.eligible).toBe(true);
    expect(plan.refundedPaise).toBe(5000);
    expect(plan.amountPaise).toBe(40000);
  });

  it("queues only the remainder when the ledger already covers part of the capture", async () => {
    const live = cancelled({
      refundedTotalPaise: 0,
      refundLedger: { rfnd_from_another_flow: 5000 },
    });
    const { db, refunds } = makeDb({ order: live });
    const res = await ensureCancelledPaidRefundObligation({ orderId: "ord_1", after: live, db });
    expect(res.created).toBe(true);
    expect(refunds.get(cancelRefundRequestId("ord_1"))).toMatchObject({
      status: "PENDING",
      amountPaise: 40000,
      alreadyRefundedPaise: 5000,
    });
  });

  it("re-cuts its own zero-amount machine row instead of leaving it unpayable", async () => {
    const { db, refunds } = makeDb({
      refunds: {
        refund_cancel_ord_1: {
          orderId: "ord_1",
          status: "PENDING",
          ownership: "machine",
          amountPaise: 0,
        },
      },
    });
    const res = await ensureCancelledPaidRefundObligation({ orderId: "ord_1", after: cancelled(), db });
    expect(res.created).toBe(false);
    expect(res.reason).toBe("already_queued");
    expect(res.pendingRefundId).toBe("refund_cancel_ord_1");
    expect(res.reviewAmountPaise).toBe(45000);
    expect(refunds.get("refund_cancel_ord_1")).toMatchObject({
      status: "PENDING",
      amountPaise: 45000,
    });
  });
});

describe("sibling refund rows: precedence", () => {
  it("prefers a human REJECTED decision over a PENDING sibling request", async () => {
    const pending = { orderId: "ord_1", status: "PENDING", amountPaise: 12000 };
    const rejected = {
      orderId: "ord_1",
      status: "REJECTED",
      amountPaise: 45000,
      disposition: { decision: "rejected", reason: "paid out in cash", decidedBy: "staff_qa" },
    };
    const { db, refunds } = makeDb({
      refunds: {
        refund_pos_cancel_ord_1: pending,
        refund_pos_review_ord_1: rejected,
      },
    });

    const res = await ensureCancelledPaidRefundObligation({ orderId: "ord_1", after: cancelled(), db });

    expect(res.created).toBe(false);
    expect(res.reason).toBe("existing_decision");
    expect(res.existingRefundId).toBe("refund_pos_review_ord_1");
    // A rejected decision must not page staff about the sibling PENDING row.
    expect(res.pendingRefundId).toBeUndefined();
    expect(refunds.size).toBe(2);
    expect(refunds.get("refund_pos_review_ord_1")).toEqual(rejected);
    expect(refunds.get("refund_pos_cancel_ord_1")).toEqual(pending);
  });

  it("defers to a PENDING sibling when the only COMPLETED sibling is already accounted for", async () => {
    const live = cancelled({ refundedTotalPaise: 15000, refundLedger: { rfnd_prev: 15000 } });
    const { db, refunds } = makeDb({
      order: live,
      refunds: {
        refund_prev: { orderId: "ord_1", status: "COMPLETED", amountPaise: 15000 },
        refund_pos_cancel_ord_1: { orderId: "ord_1", status: "PENDING", amountPaise: 30000 },
      },
    });

    const res = await ensureCancelledPaidRefundObligation({ orderId: "ord_1", after: live, db });

    expect(res.created).toBe(false);
    expect(res.reason).toBe("existing_refund");
    expect(res.existingRefundId).toBe("refund_pos_cancel_ord_1");
    expect(res.pendingRefundId).toBe("refund_pos_cancel_ord_1");
    expect(res.reviewAmountPaise).toBe(30000);
    // No third identity was minted.
    expect(refunds.size).toBe(2);
    expect(refunds.has(cancelRefundRequestId("ord_1"))).toBe(false);
  });

  it("never turns a zero-amount PENDING sibling into a staff alert", async () => {
    const zero = { orderId: "ord_1", status: "PENDING", amountPaise: 0 };
    const { db, refunds } = makeDb({ refunds: { refund_pos_cancel_ord_1: zero } });

    const res = await ensureCancelledPaidRefundObligation({ orderId: "ord_1", after: cancelled(), db });

    expect(res.reason).toBe("existing_refund");
    expect(res.existingRefundId).toBe("refund_pos_cancel_ord_1");
    // Alerting on ₹0 would train staff to ignore the queue.
    expect(res.pendingRefundId).toBeUndefined();
    expect(res.reviewAmountPaise).toBeUndefined();
    expect(refunds.get("refund_pos_cancel_ord_1")).toEqual(zero);
  });
});

describe("a human decision landing between two reconciles", () => {
  it("keeps an APPROVED row through a later reconcile and through settlement elsewhere", async () => {
    const { db, refunds, orders } = makeDb();
    const event = cancelled();

    const first = await ensureCancelledPaidRefundObligation({ orderId: "ord_1", after: event, db });
    expect(first.created).toBe(true);
    const id = first.refundId!;

    // A human approves the machine-created row between the two reconciles.
    refunds.get(id).status = "APPROVED";
    refunds.get(id).processedBy = "staff_qa";
    refunds.get(id).approvedAmountPaise = 45000;

    const second = await ensureCancelledPaidRefundObligation({ orderId: "ord_1", after: event, db });
    expect(second.created).toBe(false);
    expect(second.reason).toBe("already_queued");
    expect(second.pendingRefundId).toBeUndefined();
    expect(refunds.get(id)).toMatchObject({
      status: "APPROVED",
      processedBy: "staff_qa",
      approvedAmountPaise: 45000,
      amountPaise: 45000,
    });

    // The refund then lands elsewhere and the order is fully settled. A human
    // decision is never withdrawn or re-cut by a later replay.
    orders.get("ord_1").refundedTotalPaise = 45000;
    orders.get("ord_1").refundLedger = { rfnd_settled: 45000 };
    const third = await ensureCancelledPaidRefundObligation({ orderId: "ord_1", after: event, db });

    expect(third.created).toBe(false);
    expect(refunds.get(id).status).toBe("APPROVED");
    expect(refunds.get(id).withdrawReason).toBeUndefined();
    expect(refunds.size).toBe(1);
  });
});

describe("a full refund landing between the event and the transaction", () => {
  it("withdraws its own machine PENDING row when the fresh doc proves full settlement", async () => {
    // The event payload shows nothing refunded, but between the event and the
    // transaction a gateway refund completed against the scalar receipt
    // authoritatively (refundedTotalPaise >= capture). A stale queue row must
    // not outlive the money it asks for.
    const stale = cancelled();
    const live = cancelled({
      refundedTotalPaise: 45000,
      refundLedger: { rfnd_landed_in_between: 45000 },
      refundId: "rfnd_landed_in_between",
      // a positive amount ⇒ NOT the full-intent stamp; settlement must be
      // proven by receipt arithmetic, not by the legacy stamp shape.
      refundAmount: 450,
    });
    const { db, refunds, orders, writes } = makeDb({
      order: live,
      refunds: {
        refund_cancel_ord_1: {
          orderId: "ord_1",
          status: "PENDING",
          ownership: "machine",
          amountPaise: 45000,
        },
      },
    });

    const res = await ensureCancelledPaidRefundObligation({ orderId: "ord_1", after: stale, db });

    expect(res.created).toBe(false);
    expect(res.reason).toBe("fully_refunded");
    expect(res.pendingRefundId).toBeUndefined();
    expect(refunds.get("refund_cancel_ord_1")).toMatchObject({
      status: "WITHDRAWN",
      withdrawReason: "fully_refunded",
    });
    expect(orders.get("ord_1").refundObligation).toMatchObject({
      status: "WITHDRAWN",
      reason: "fully_refunded",
    });
    expect(writes.some((w: any) => w.kind === "refunds")).toBe(true);
  });
});
