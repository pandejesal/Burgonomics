/**
 * Cancel-refund obligation: a PAID cancellation must leave ONE durable,
 * staff-reviewable PENDING refund row — never an automatic gateway refund.
 *
 * Trusted evidence only: `paymentChannel === "razorpay"` (server-written),
 * the captured payment id and `capturedAmountPaise` written by the payment
 * module. `payment.method` and the client total are never proof or amount.
 *
 * Receipt math mirrors razorpay.service.ts authority:
 *   recordedRefunded = max(refundedTotalPaise, ledgerSum + unrepresented scalar)
 *   full only when recordedRefunded >= capture, or the full-intent shape
 *   (refundStatus=refunded + refundId + refundAmount === null).
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
  claimRefundReviewAlert,
  settleRefundReviewAlert,
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

/** Minimal in-memory Firestore with the read-before-write transaction shape. */
function makeDb(opts: { order?: any; refunds?: Record<string, any>; failTx?: boolean } = {}) {
  const orders = new Map<string, any>([["ord_1", opts.order ?? cancelled()]]);
  const refunds = new Map<string, any>(Object.entries(opts.refunds || {}));
  const writes: Array<{ kind: string; id: string; data: any; opts?: any }> = [];

  const fakeSnap = (data: any) => ({
    exists: data !== undefined,
    data: () => data,
  });

  const tx = {
    async get(ref: any) {
      if (ref && ref.collection === "refunds" && ref.query) {
        const docs = [...refunds.entries()]
          .filter(([, v]) => v.orderId === ref.value)
          .slice(0, ref.cap ?? 10)
          .map(([id, v]) => ({ id, exists: true, data: () => v }));
        return { empty: docs.length === 0, docs, size: docs.length };
      }
      if (ref && ref.collection === "orders" && ref.query) {
        const docs = [...orders.entries()]
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
      // Firestore merge is RECURSIVE on nested maps: a payment.refundStatus
      // patch must retain capturedAmountPaise/razorpayPaymentId. A shallow
      // spread here silently lost capture truth and hid real defects.
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

  const orderRef = (id: string) => ({
    kind: "orders",
    id,
    // Non-transactional marker write used by the failure path.
    set: async (data: any, setOpts?: any) => {
      writes.push({ kind: "orders", id, data, opts: setOpts });
      const prev = orders.get(id) || {};
      orders.set(id, setOpts?.merge ? { ...prev, ...data } : data);
    },
  });

  const db: any = {
    collection(name: string) {
      if (name === "orders") return { doc: orderRef };
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
      if (opts.failTx) throw new Error("firestore unavailable");
      return fn(tx);
    },
  };

  return { db, refunds, orders, writes };
}

beforeEach(() => {
  h.snapshots.length = 0;
});

describe("planCancelRefundObligation (pure gate)", () => {
  it("queues the remaining captured amount for a paid online cancellation", () => {
    const plan = planCancelRefundObligation(cancelled());
    expect(plan.eligible).toBe(true);
    expect(plan.amountPaise).toBe(45000);
    expect(plan.paymentId).toBe("pay_live_1");
  });

  it("uses only the server capture truth: payment.method alone never authorizes", () => {
    const plan = planCancelRefundObligation(
      cancelled({ paymentChannel: undefined, payment: { method: "razorpay", status: "completed" } })
    );
    expect(plan.eligible).toBe(false);
    expect(plan.reason).toBe("no_server_channel");
  });

  it("never derives the amount from a client total", () => {
    const noCapture = planCancelRefundObligation(
      cancelled({
        totals: { grandTotal: 9999 },
        payment: { razorpayPaymentId: "pay_live_1", method: "online" },
      })
    );
    expect(noCapture.eligible).toBe(false);
    expect(noCapture.reason).toBe("no_captured_amount");
  });

  it("skips fully refunded, cash and unpaid cancellations", () => {
    // CORRECTED (was: a bare `refundStatus: "refunded"` stamp => fully_refunded).
    // razorpay.service.ts:3918-3921 only treats the order as settled when the
    // recorded receipt reaches the capture, or the full-intent shape holds.
    // A stamp with no receipt and no recorded money is NOT proof of settlement,
    // so it must not silently drop a real refund obligation; the human review
    // row is the safe place for that ambiguity (no money moves without a human).
    const bareStamp = planCancelRefundObligation(cancelled({ refundStatus: "refunded" }));
    expect(bareStamp.eligible).toBe(true);
    expect(bareStamp.reason).toBeUndefined();
    // Proven settlement (ledger reaches the capture) does stand down.
    expect(
      planCancelRefundObligation(
        cancelled({ refundedTotalPaise: 45000, refundLedger: { rfnd_1: 45000 } })
      ).reason
    ).toBe("fully_refunded");
    expect(
      planCancelRefundObligation(
        cancelled({ paymentChannel: "cash", payment: { method: "cod", capturedAmountPaise: 45000 } })
      ).reason
    ).toBe("no_server_channel");
  });

  it("queues only the remaining amount after a partial refund", () => {
    const plan = planCancelRefundObligation(
      cancelled({ refundedTotalPaise: 15000, refundStatus: "partially_refunded" })
    );
    expect(plan.eligible).toBe(true);
    expect(plan.amountPaise).toBe(30000);
  });

  // Legacy receipt math (razorpay.service.ts:3640-3677): an unledgered
  // refundId/refundAmount is real money returned and consumes the cap.
  it("consumes a legacy unledgered scalar receipt instead of re-queuing it", () => {
    const plan = planCancelRefundObligation(
      cancelled({
        refundStatus: "partially_refunded",
        refundId: "rfnd_legacy_1",
        refundAmount: 150, // rupees
      })
    );
    expect(plan.eligible).toBe(true);
    expect(plan.amountPaise).toBe(30000);
    expect(plan.refundedPaise).toBe(15000);
  });

  it("does not double-count a scalar receipt already present in the ledger", () => {
    const plan = planCancelRefundObligation(
      cancelled({
        refundStatus: "partially_refunded",
        refundId: "rfnd_ledger_1",
        refundAmount: 150,
        refundLedger: { rfnd_ledger_1: 15000 },
        refundedTotalPaise: 15000,
      })
    );
    expect(plan.amountPaise).toBe(30000);
  });

  // Supported legacy partial shape: "refunded" + refundId + a POSITIVE
  // refundAmount is a partial stamp, not a full one (razorpay.service.ts:3906-3921).
  it("treats refunded+refundId+positive refundAmount as partial, not full", () => {
    const plan = planCancelRefundObligation(
      cancelled({ refundStatus: "refunded", refundId: "rfnd_legacy_2", refundAmount: 150 })
    );
    expect(plan.eligible).toBe(true);
    expect(plan.amountPaise).toBe(30000);
  });

  it("treats the full-intent shape (refundAmount null) as fully refunded", () => {
    const plan = planCancelRefundObligation(
      cancelled({ refundStatus: "refunded", refundId: "rfnd_full", refundAmount: null })
    );
    expect(plan.eligible).toBe(false);
    expect(plan.reason).toBe("fully_refunded");
  });

  // CORRECTED (was: any order-level refundStatus stamp => "existing_decision").
  // `payment.refundStatus` is written by THIS module (`PENDING_APPROVAL`) and by
  // autoRefund (`refunding`), so an order-level stamp is never proof of a human
  // decision — treating it as one made our own row un-replayable and withdrew
  // it forever. Human decisions live on the REFUNDS ROW and are enforced in
  // ensureCancelledPaidRefundObligation (see the disposed-POS-row regression).
  it("does not treat order-level refund stamps as a human decision", () => {
    for (const refundStatus of ["PENDING_APPROVAL", "APPROVED", "PROCESSING", "REJECTED"]) {
      const plan = planCancelRefundObligation(cancelled({ payment: {
        razorpayPaymentId: "pay_live_1",
        capturedAmountPaise: 45000,
        refundStatus,
      } }));
      expect(plan.eligible).toBe(true);
      expect(plan.amountPaise).toBe(45000);
    }
  });

  // Authoritative in-flight ownership (razorpay.service.ts:3770-3872,
  // 3993-4007): a live claim means money may already be moving.
  it.each([
    ["refundActiveClaim", { refundActiveClaim: { requestId: "rq_1", claimedAt: Date.now(), paymentId: "pay_live_1" } }],
    ["legacy refundClaimedAt", { refundClaimedAt: Date.now(), refundClaimedRequestId: "rq_1" }],
    ["refunding status", { refundStatus: "refunding" }],
  ])("stands down while money may be moving (%s)", (_label, extra) => {
    const plan = planCancelRefundObligation(cancelled(extra));
    expect(plan.eligible).toBe(false);
    expect(plan.reason).toBe("refund_in_progress");
  });

  // CORRECTED (was: a >10m claim lease expires into eligibility). autoRefund
  // only applies its TTL to a KEYED, identified claim it can safely replay.
  // An unresolved identity (razorpay.service.ts:3841-3870) is refused at ANY
  // age because money may already be on the wire and this review queue would
  // mint a DIFFERENT refund identity — a double-pay risk.
  it("stands down on an unresolved claim identity regardless of age", () => {
    const staleAt = Date.now() - 6 * 60 * 60_000;
    const plan = planCancelRefundObligation(
      cancelled({ refundActiveClaim: { requestId: "rq_old", claimedAt: staleAt } })
    );
    expect(plan.eligible).toBe(false);
    expect(plan.reason).toBe("refund_in_progress");
  });
});

describe("ensureCancelledPaidRefundObligation (durable queue)", () => {
  it("creates exactly one PENDING queue row and stamps the order", async () => {
    const { db, refunds, orders } = makeDb();
    const res = await ensureCancelledPaidRefundObligation({ orderId: "ord_1", after: orders.get("ord_1"), db });

    expect(res.created).toBe(true);
    const rows = [...refunds.values()];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      orderId: "ord_1",
      paymentId: "pay_live_1",
      razorpayPaymentId: "pay_live_1",
      amountPaise: 45000,
      status: "PENDING",
      ownership: "machine",
    });
    expect(refunds.size).toBe(1);
    expect(refunds.has(res.refundId!)).toBe(true);
    expect(orders.get("ord_1").payment.refundStatus).toBe("PENDING_APPROVAL");
  });

  it("is replay safe: a duplicate event never overwrites the row or the decision", async () => {
    const { db, refunds, orders } = makeDb();
    const first = await ensureCancelledPaidRefundObligation({ orderId: "ord_1", after: orders.get("ord_1"), db });
    const id = first.refundId!;
    // A human already touched the row.
    refunds.get(id).status = "APPROVED";
    refunds.get(id).amountPaise = 1;

    const second = await ensureCancelledPaidRefundObligation({ orderId: "ord_1", after: orders.get("ord_1"), db });
    expect(second.created).toBe(false);
    expect(second.reason).toBe("already_queued");
    expect(refunds.get(id).status).toBe("APPROVED");
    expect(refunds.get(id).amountPaise).toBe(1);
    expect(second.pendingRefundId).toBeUndefined();
  });

  it("leaves an existing pending refund (e.g. POS cancel) untouched but reports it for the alert", async () => {
    const { db, refunds, orders } = makeDb({
      refunds: { refund_pos_cancel_ord_1: { orderId: "ord_1", status: "PENDING", amountPaise: 12000 } },
    });
    const res = await ensureCancelledPaidRefundObligation({ orderId: "ord_1", after: orders.get("ord_1"), db });
    expect(res.created).toBe(false);
    expect(res.reason).toBe("existing_refund");
    expect(refunds.size).toBe(1);
    expect(refunds.get("refund_pos_cancel_ord_1").amountPaise).toBe(12000);
    // P2: the existing PENDING row still needs a staff alert.
    expect(res.pendingRefundId).toBe("refund_pos_cancel_ord_1");
    expect(res.reviewAmountPaise).toBe(12000);
  });

  it("does not queue cash/unpaid cancellations", async () => {
    const cash = cancelled({ paymentChannel: undefined, payment: { method: "cod" } });
    const { db, refunds } = makeDb({ order: cash });
    const res = await ensureCancelledPaidRefundObligation({ orderId: "ord_1", after: cash, db });
    expect(res.created).toBe(false);
    expect(refunds.size).toBe(0);
  });

  it("re-plans against the fresh transactional snapshot (no stale-total queue)", async () => {
    // Stale event says 45000 owed; the live doc already refunded in full.
    const stale = cancelled();
    const live = cancelled({ refundedTotalPaise: 45000, refundStatus: "refunded" });
    const { db, refunds } = makeDb({ order: live });
    const res = await ensureCancelledPaidRefundObligation({ orderId: "ord_1", after: stale, db });
    expect(res.created).toBe(false);
    expect(res.reason).toBe("fully_refunded");
    expect(refunds.size).toBe(0);
  });

  // P1: a machine-owned PENDING row must be revalidated against fresh truth,
  // so a refund that landed elsewhere does not leave a stale queue + alerts.
  it("withdraws its own stale PENDING row once the order is fully refunded", async () => {
    const live = cancelled({ refundedTotalPaise: 45000, refundStatus: "refunded" });
    const { db, refunds } = makeDb({
      order: live,
      refunds: {
        refund_cancel_ord_1: {
          id: "refund_cancel_ord_1",
          orderId: "ord_1",
          status: "PENDING",
          ownership: "machine",
          amountPaise: 45000,
        },
      },
    });
    const res = await ensureCancelledPaidRefundObligation({ orderId: "ord_1", after: live, db });
    expect(res.created).toBe(false);
    expect(res.reason).toBe("fully_refunded");
    expect(refunds.get("refund_cancel_ord_1").status).toBe("WITHDRAWN");
    expect(refunds.get("refund_cancel_ord_1").withdrawReason).toBe("fully_refunded");
    expect(res.pendingRefundId).toBeUndefined();
  });

  it("re-cuts its own machine PENDING row to the remaining amount after a partial refund", async () => {
    const live = cancelled({ refundedTotalPaise: 15000, refundStatus: "partially_refunded" });
    const { db, refunds } = makeDb({
      order: live,
      refunds: {
        refund_cancel_ord_1: {
          id: "refund_cancel_ord_1",
          orderId: "ord_1",
          status: "PENDING",
          ownership: "machine",
          amountPaise: 45000,
        },
      },
    });
    const res = await ensureCancelledPaidRefundObligation({ orderId: "ord_1", after: live, db });
    expect(res.created).toBe(false);
    expect(res.reason).toBe("already_queued");
    expect(refunds.get("refund_cancel_ord_1").amountPaise).toBe(30000);
    expect(refunds.get("refund_cancel_ord_1").status).toBe("PENDING");
    expect(res.pendingRefundId).toBe("refund_cancel_ord_1");
  });

  it("never touches a human-owned row, even when it is PENDING", async () => {
    const live = cancelled({ refundedTotalPaise: 45000, refundStatus: "refunded" });
    const { db, refunds } = makeDb({
      order: live,
      refunds: {
        refund_cancel_ord_1: {
          id: "refund_cancel_ord_1",
          orderId: "ord_1",
          status: "PENDING",
          ownership: "human",
          amountPaise: 45000,
        },
      },
    });
    const res = await ensureCancelledPaidRefundObligation({ orderId: "ord_1", after: live, db });
    expect(res.reason).toBe("already_queued");
    expect(refunds.get("refund_cancel_ord_1").status).toBe("PENDING");
    expect(refunds.get("refund_cancel_ord_1").ownership).toBe("human");
  });

  it("stands down when a live refund claim owns the money", async () => {
    const claimed = cancelled({
      refundActiveClaim: { requestId: "rq_live", claimedAt: Date.now(), paymentId: "pay_live_1" },
    });
    const { db, refunds } = makeDb({ order: claimed });
    const res = await ensureCancelledPaidRefundObligation({ orderId: "ord_1", after: claimed, db });
    expect(res.created).toBe(false);
    expect(res.reason).toBe("refund_in_progress");
    expect(refunds.size).toBe(0);
  });

  // VERIFIED human-decision shape (payments/refundRequests.ts:52-61): a staff
  // rejection writes status/disposition on the EXISTING refunds row only and
  // stamps NO order-level payment flag. A later cancel replay must honour that
  // decision — never mint a fresh refund_cancel_<orderId> across it.
  it("never mints a fresh review row across a disposed POS refund decision", async () => {
    const { db, refunds } = makeDb({
      refunds: {
        refund_pos_cancel_ord_1: {
          orderId: "ord_1",
          status: "REJECTED",
          amountPaise: 12000,
          disposition: {
            decision: "rejected",
            reason: "already handed to customer as cash",
            decidedBy: "staff",
            decidedAt: "TS",
          },
        },
      },
    });
    const res = await ensureCancelledPaidRefundObligation({ orderId: "ord_1", after: cancelled(), db });
    expect(res.created).toBe(false);
    expect(res.reason).toBe("existing_decision");
    expect(res.existingRefundId).toBe("refund_pos_cancel_ord_1");
    expect(res.pendingRefundId).toBeUndefined();
    // The human row is untouched and no second identity appears.
    expect(refunds.size).toBe(1);
    expect(refunds.get("refund_pos_cancel_ord_1").status).toBe("REJECTED");
    expect(refunds.get("refund_pos_cancel_ord_1").disposition.decidedBy).toBe("staff");
  });

  it("retires its existing machine request when a sibling human rejection owns the decision", async () => {
    const human = { orderId: "ord_1", status: "REJECTED", amountPaise: 45000, disposition: { decision: "rejected", decidedBy: "qa_staff" } };
    const { db, refunds, orders } = makeDb({ refunds: {
      refund_cancel_ord_1: { orderId: "ord_1", status: "PENDING", ownership: "machine", amountPaise: 45000 },
      refund_pos_cancel_ord_1: human,
    } });
    const result = await ensureCancelledPaidRefundObligation({ orderId: "ord_1", after: cancelled(), db });
    expect(result.pendingRefundId).toBeUndefined();
    expect(refunds.get("refund_cancel_ord_1").status).toBe("WITHDRAWN");
    expect(orders.get("ord_1").refundObligation.status).toBe("WITHDRAWN");
    expect(refunds.get("refund_pos_cancel_ord_1")).toEqual(human);
  });

  it("queues the remainder after an already-accounted completed partial refund", async () => {
    const prior = { orderId: "ord_1", status: "COMPLETED", amountPaise: 15000 };
    const current = cancelled({ refundedTotalPaise: 15000, refundLedger: { rfnd_previous: 15000 } });
    const { db, refunds } = makeDb({ order: current, refunds: { refund_previous: prior } });
    const result = await ensureCancelledPaidRefundObligation({ orderId: "ord_1", after: current, db });
    expect(result.created).toBe(true);
    expect(refunds.get("refund_cancel_ord_1")).toMatchObject({ status: "PENDING", amountPaise: 30000 });
    expect(refunds.get("refund_previous")).toEqual(prior);
  });

  it.each([false, true])("holds an overflowing ownership history without exposing a pending review (existing=%s)", async hasOwn => {
    const rows: Record<string, any> = {};
    if (hasOwn) rows.refund_cancel_ord_1 = { orderId: "ord_1", status: "PENDING", ownership: "machine", amountPaise: 45000 };
    for (let i = 0; i < 10; i++) rows[`refund_unknown_${i}`] = { orderId: "ord_1", status: "UNKNOWN", amountPaise: 1 };
    rows.refund_rejected_last = { orderId: "ord_1", status: "REJECTED", amountPaise: 45000 };
    const { db, refunds } = makeDb({ refunds: rows });
    const result = await ensureCancelledPaidRefundObligation({ orderId: "ord_1", after: cancelled(), db });
    expect(result.pendingRefundId).toBeUndefined();
    if (hasOwn) expect(refunds.get("refund_cancel_ord_1").status).toBe("WITHDRAWN");
    else expect(refunds.has("refund_cancel_ord_1")).toBe(false);
    expect(h.snapshots.some(snapshot => snapshot.severity === "high" && /history/i.test(snapshot.message))).toBe(true);
  });

  it("defers to an existing sibling pending request instead of retaining two actionable requests", async () => {
    const pending = { orderId: "ord_1", status: "PENDING", amountPaise: 45000 };
    const { db, refunds } = makeDb({ refunds: {
      refund_cancel_ord_1: { orderId: "ord_1", status: "PENDING", ownership: "machine", amountPaise: 45000 },
      refund_pos_cancel_ord_1: pending,
    } });
    const result = await ensureCancelledPaidRefundObligation({ orderId: "ord_1", after: cancelled(), db });
    expect(result.pendingRefundId).toBe("refund_pos_cancel_ord_1");
    expect(refunds.get("refund_cancel_ord_1").status).toBe("WITHDRAWN");
    expect(refunds.get("refund_pos_cancel_ord_1")).toEqual(pending);
  });

  it.each(["APPROVED", "PROCESSING", "COMPLETED"])(
    "honours an existing %s row elsewhere without creating a second identity",
    async (status) => {
      const { db, refunds } = makeDb({
        refunds: { refund_other_1: { orderId: "ord_1", status, amountPaise: 45000 } },
      });
      const res = await ensureCancelledPaidRefundObligation({ orderId: "ord_1", after: cancelled(), db });
      expect(res.created).toBe(false);
      expect(res.reason).toBe("existing_decision");
      expect(refunds.size).toBe(1);
      expect(refunds.get("refund_other_1").status).toBe(status);
    }
  );

  // Own row carrying a human decision must survive a replay untouched.
  it("leaves a human REJECTED decision on its own row in place", async () => {
    const { db, refunds } = makeDb({
      refunds: {
        refund_cancel_ord_1: {
          id: "refund_cancel_ord_1",
          orderId: "ord_1",
          status: "REJECTED",
          ownership: "machine",
          amountPaise: 45000,
        },
      },
    });
    const res = await ensureCancelledPaidRefundObligation({ orderId: "ord_1", after: cancelled(), db });
    expect(res.created).toBe(false);
    expect(res.reason).toBe("already_queued");
    expect(refunds.get("refund_cancel_ord_1").status).toBe("REJECTED");
  });

  // Regression: our own PENDING_APPROVAL stamp must never withdraw our row.
  it("keeps its own PENDING row across repeated replays of the same event", async () => {
    const { db, refunds, orders } = makeDb();
    const event = cancelled();
    for (let i = 0; i < 3; i++) {
      await ensureCancelledPaidRefundObligation({ orderId: "ord_1", after: event, db });
    }
    expect(refunds.get("refund_cancel_ord_1").status).toBe("PENDING");
    expect(refunds.get("refund_cancel_ord_1").amountPaise).toBe(45000);
    // Recursive merge keeps the capture truth this module must not destroy.
    expect(orders.get("ord_1").payment.capturedAmountPaise).toBe(45000);
    expect(orders.get("ord_1").payment.razorpayPaymentId).toBe("pay_live_1");
  });

  it.each(["cash", undefined])("never creates a refund obligation for an unverified channel during a database failure (%s)", async paymentChannel => {
    const current = cancelled({ paymentChannel });
    const { db, orders } = makeDb({ order: current, failTx: true });
    await ensureCancelledPaidRefundObligation({ orderId: "ord_1", after: current, db });
    expect(orders.get("ord_1").refundObligation).toBeUndefined();
    expect(h.snapshots.some(snapshot => /refund is owed/i.test(snapshot.message))).toBe(false);
  });

  it("makes a queue failure observable and retryable, never silent", async () => {
    const { db, orders } = makeDb({ failTx: true });
    const res = await ensureCancelledPaidRefundObligation({ orderId: "ord_1", after: orders.get("ord_1"), db });
    expect(res.created).toBe(false);
    expect(res.reason).toBe("queue_failed");
    // Operator-visible: a high-severity snapshot was captured…
    expect(h.snapshots).toHaveLength(1);
    expect(h.snapshots[0].severity).toBe("high");
    // …and the order carries a durable, retryable obligation marker.
    expect(orders.get("ord_1").refundObligation.status).toBe("PENDING");
    expect(orders.get("ord_1").refundObligation.amountPaise).toBe(45000);
  });
});

describe("refund review alert claim (durable, bounded, observable)", () => {
  const seeded = () =>
    makeDb({
      refunds: {
        refund_cancel_ord_1: {
          id: "refund_cancel_ord_1",
          orderId: "ord_1",
          status: "PENDING",
          ownership: "machine",
          amountPaise: 15000,
        },
      },
    });

  it("grants the claim once and refuses a concurrent second claim", async () => {
    const seededDb = seeded();
    const a = await claimRefundReviewAlert({ refundId: "refund_cancel_ord_1", db: seededDb.db });
    const b = await claimRefundReviewAlert({ refundId: "refund_cancel_ord_1", db: seededDb.db });
    expect(a.claimed).toBe(true);
    expect(b.claimed).toBe(false);
    expect(b.reason).toBe("in_flight");
  });

  it("records delivery so a replay never re-alerts", async () => {
    const s = seeded();
    const claim = await claimRefundReviewAlert({ refundId: "refund_cancel_ord_1", db: s.db });
    await settleRefundReviewAlert({
      refundId: "refund_cancel_ord_1",
      token: claim.token!,
      delivered: true,
      db: s.db,
    });
    const again = await claimRefundReviewAlert({ refundId: "refund_cancel_ord_1", db: s.db });
    expect(again.claimed).toBe(false);
    expect(again.reason).toBe("delivered");
    expect(s.refunds.get("refund_cancel_ord_1").alertDeliveredAt).toBeTruthy();
  });

  it("clears a failed claim so a later genuine update can retry, and counts attempts", async () => {
    const s = seeded();
    const claim = await claimRefundReviewAlert({ refundId: "refund_cancel_ord_1", db: s.db });
    await settleRefundReviewAlert({
      refundId: "refund_cancel_ord_1",
      token: claim.token!,
      delivered: false,
      error: "fcm down",
      db: s.db,
    });
    const row = s.refunds.get("refund_cancel_ord_1");
    expect(row.alertClaimedAt).toBeUndefined();
    expect(row.alertClaimToken).toBeUndefined();
    expect(row.alertAttempts).toBe(1);
    expect(row.alertLastError).toBe("fcm down");
    // A newer claim is grantable (retryable), not stuck forever.
    const retry = await claimRefundReviewAlert({ refundId: "refund_cancel_ord_1", db: s.db });
    expect(retry.claimed).toBe(true);
  });

  it("stops after the attempt cap so a poisoned alert cannot loop", async () => {
    const s = seeded();
    s.refunds.get("refund_cancel_ord_1").alertAttempts = 3;
    const res = await claimRefundReviewAlert({ refundId: "refund_cancel_ord_1", db: s.db });
    expect(res.claimed).toBe(false);
    expect(res.reason).toBe("exhausted");
  });

  it("ignores a stale owner's settle so it cannot clear a newer claim", async () => {
    const s = seeded();
    const first = await claimRefundReviewAlert({ refundId: "refund_cancel_ord_1", db: s.db });
    // Simulate the claim going stale and another worker taking over.
    s.refunds.get("refund_cancel_ord_1").alertClaimToken = "newer_token";
    await settleRefundReviewAlert({
      refundId: "refund_cancel_ord_1",
      token: first.token!,
      delivered: true,
      db: s.db,
    });
    expect(s.refunds.get("refund_cancel_ord_1").alertDeliveredAt).toBeUndefined();
    expect(s.refunds.get("refund_cancel_ord_1").alertClaimToken).toBe("newer_token");
  });
});

describe("customer cancellation copy", () => {
  it("says awaiting review for paid-unrefunded, and never claims money moved", async () => {
    const { buildCustomerOrderUpdateMessage } = await import("../src/modules/notifications/templates");
    const base = { id: "o1", orderNumber: "BG-1", fulfillmentType: "delivery" };
    const awaiting = buildCustomerOrderUpdateMessage(
      "t",
      { ...base, refundAwaitingReview: true },
      "CANCELLED"
    );
    expect(awaiting.notification?.body).toContain("awaiting review");
    expect(awaiting.notification?.body).not.toContain("has been initiated");
    expect(awaiting.notification?.body).not.toContain("No money was charged");

    const captured = buildCustomerOrderUpdateMessage(
      "t",
      { ...base, paymentCaptured: true },
      "CANCELLED"
    );
    expect(captured.notification?.body).not.toContain("No money was charged");
    expect(captured.notification?.body).not.toContain("has been initiated");

    const cash = buildCustomerOrderUpdateMessage("t", { ...base, paymentMethod: "cod" }, "CANCELLED");
    expect(cash.notification?.body).toContain("was cancelled");
    expect(cash.notification?.body).not.toContain("refund");
  });

  // P1: after a partial refund the copy must not claim "nothing was refunded".
  it("never claims nothing was refunded when a partial refund already landed", async () => {
    const { buildCustomerOrderUpdateMessage } = await import("../src/modules/notifications/templates");
    const base = { id: "o1", orderNumber: "BG-1", fulfillmentType: "delivery" };
    const partial = buildCustomerOrderUpdateMessage(
      "t",
      { ...base, refundAwaitingReview: true, partiallyRefundedPaise: 15000 },
      "CANCELLED"
    );
    const body = partial.notification?.body || "";
    expect(body).toContain("awaiting review");
    expect(body).not.toMatch(/nothing has been refunded/i);
    expect(body).not.toMatch(/No money was charged/i);
    expect(body).toMatch(/partial refund of ₹150 has already been processed/i);
  });
});

describe("staff refund-review alert", () => {
  it("is one operational branch alert that promises no money movement", async () => {
    const { buildRefundReviewAlertMessage } = await import("../src/modules/notifications/templates");
    const msg = buildRefundReviewAlertMessage("branch_a", {
      orderId: "ord_1",
      orderNumber: "BG-77",
      amountPaise: 45000,
    });
    expect(msg.topic).toBe("branch_branch_a_orders");
    expect(msg.data?.type).toBe("REFUND_REVIEW_REQUIRED");
    expect(msg.data?.orderId).toBe("ord_1");
    expect(msg.notification?.body).toContain("review");
    expect(msg.notification?.body).not.toContain("has been initiated");
  });
});
