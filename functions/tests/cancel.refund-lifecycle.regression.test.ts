import { describe, expect, it, vi } from "vitest";

vi.mock("../src/core/firebase", () => ({ db: {} }));
vi.mock("../src/core/errors", () => ({ captureErrorSnapshot: vi.fn(async () => undefined) }));

import {
  cancelRefundRequestId,
  claimRefundReviewAlert,
  ensureCancelledPaidRefundObligation,
  planCancelRefundObligation,
} from "../src/modules/orders/cancelRefundObligation";

const orderId = "ord_lifecycle";
const refundId = cancelRefundRequestId(orderId);
const capturedOrder = () => ({
  status: "CANCELLED",
  branchId: "qa_branch",
  paymentChannel: "razorpay",
  payment: { razorpayPaymentId: "pay_test_lifecycle", capturedAmountPaise: 45000 },
});
const copy = <T>(value: T): T => structuredClone(value);
const plain = (value: any): boolean =>
  value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;

/**
 * Behavioral fake, NOT production Firestore proof: recursive merge, immutable
 * snapshots, filtered queries, read-before-write enforcement and atomic commits.
 * In particular a payment.refundStatus merge must retain the capture fields.
 */
function database(initialOrder: any = capturedOrder(), rows: Record<string, any> = {}) {
  const state = new Map<string, any>([
    [`orders/${orderId}`, copy(initialOrder)],
    ...Object.entries(rows).map(([id, row]) => [`refunds/${id}`, copy(row)] as [string, any]),
  ]);
  let queue = Promise.resolve();
  const apply = (previous: any, patch: any, merge: boolean): any => {
    const next = merge ? copy(previous || {}) : {};
    for (const [key, value] of Object.entries(patch)) {
      const transform = (value as any)?.constructor?.name;
      if (transform === "DeleteTransform") delete next[key];
      else if (transform === "ServerTimestampTransform") next[key] = Date.now();
      else if (plain(value)) next[key] = apply(merge ? next[key] : {}, value, merge);
      else next[key] = copy(value);
    }
    return next;
  };
  const ref = (path: string): any => ({
    path,
    id: path.split("/").at(-1),
    set: async (patch: any, options?: any) => {
      state.set(path, apply(state.get(path), patch, options?.merge === true));
    },
  });
  const snapshot = (path: string) => {
    const value = copy(state.get(path));
    return { exists: value !== undefined, id: path.split("/").at(-1), data: () => copy(value) };
  };
  const query = (collection: string, filters: any[] = [], cap = Infinity): any => ({
    collection,
    filters,
    cap,
    where: (field: string, op: string, value: any) => {
      if (op !== "==") throw Error("unsupported test query operator");
      return query(collection, [...filters, [field, value]], cap);
    },
    limit: (n: number) => query(collection, filters, n),
    doc: (id: string) => ref(`${collection}/${id}`),
  });
  const db: any = {
    collection: (name: string) => query(name),
    runTransaction: (run: any) => {
      const result = queue.then(async () => {
        const pending: Array<{ target: any; patch: any; options: any }> = [];
        const tx = {
          get: async (target: any) => {
            if (pending.length) throw Error("Firestore read after write");
            if (target.path) return snapshot(target.path);
            const docs = [...state.keys()]
              .filter(path => path.startsWith(`${target.collection}/`))
              .filter(path => target.filters.every(([field, value]: any) => state.get(path)[field] === value))
              .slice(0, target.cap)
              .map(snapshot);
            return { docs, empty: docs.length === 0, size: docs.length };
          },
          set: (target: any, patch: any, options: any) => pending.push({ target, patch, options }),
        };
        const value = await run(tx);
        for (const write of pending) {
          state.set(write.target.path, apply(state.get(write.target.path), write.patch, write.options?.merge === true));
        }
        return value;
      });
      queue = result.then(() => undefined, () => undefined);
      return result;
    },
  };
  return { db, state, update: (patch: any) => ref(`orders/${orderId}`).set(patch, { merge: true }) };
}

describe("cancel refund review: persisted lifecycle regressions", () => {
  it("keeps one obligation across identical replay, then tracks a partial receipt", async () => {
    const fixture = database();
    const originalEvent = copy(capturedOrder());
    await ensureCancelledPaidRefundObligation({ orderId, after: originalEvent, db: fixture.db });
    expect(fixture.state.get(`orders/${orderId}`).payment).toMatchObject({
      capturedAmountPaise: 45000,
      razorpayPaymentId: "pay_test_lifecycle",
      refundStatus: "PENDING_APPROVAL",
    });
    for (let replay = 0; replay < 3; replay++) {
      await ensureCancelledPaidRefundObligation({ orderId, after: originalEvent, db: fixture.db });
      expect(fixture.state.get(`refunds/${refundId}`)).toMatchObject({ status: "PENDING", amountPaise: 45000 });
    }
    await fixture.update({ refundStatus: "partially_refunded", refundId: "rfnd_partial", refundAmount: 150 });
    await ensureCancelledPaidRefundObligation({ orderId, after: originalEvent, db: fixture.db });
    expect(fixture.state.get(`refunds/${refundId}`)).toMatchObject({ status: "PENDING", amountPaise: 30000 });
    expect([...fixture.state.keys()].filter(path => path.startsWith("refunds/"))).toHaveLength(1);
  });

  it.each(["active", "legacy"])("does not replace a stale unresolved %s refund identity", (shape) => {
    const claimedAt = Date.now() - 11 * 60_000;
    const claim = shape === "active"
      ? { refundActiveClaim: { requestId: "existing_request", claimedAt, paymentId: "pay_test_lifecycle" } }
      : { refundClaimedAt: claimedAt, refundClaimedRequestId: "existing_request" };
    const plan = planCancelRefundObligation({ ...capturedOrder(), ...claim, refundStatus: "partially_refunded" });
    expect(plan.eligible).toBe(false);
    expect(plan.reason).toBe("refund_in_progress");
  });

  it("does not treat an unreceipted requested refundAmount as returned money", () => {
    const plan = planCancelRefundObligation({ ...capturedOrder(), refundAmount: 450 });
    expect(plan).toMatchObject({ eligible: true, amountPaise: 45000, refundedPaise: 0 });
  });

  it.each(["REJECTED", "WITHDRAWN", "APPROVED"])("never claims an awaiting-approval alert for a %s decision", async status => {
    const fixture = database(capturedOrder(), { [refundId]: { orderId, status, amountPaise: 45000 } });
    const claim = await claimRefundReviewAlert({ refundId, db: fixture.db });
    expect(claim.claimed).toBe(false);
    expect(fixture.state.get(`refunds/${refundId}`)).not.toHaveProperty("alertClaimToken");
  });

  it("returns the current row amount with an alert claim, not the stale event amount", async () => {
    const fixture = database(capturedOrder(), { [refundId]: { orderId, status: "PENDING", amountPaise: 30000 } });
    const claim = await claimRefundReviewAlert({ refundId, db: fixture.db });
    expect(claim.claimed).toBe(true);
    expect(claim).toHaveProperty("amountPaise", 30000);
  });

  it.each(["remaining", "settled"])("leaves unknown-provenance PENDING rows intact when %s", async condition => {
    const row = { orderId, status: "PENDING", amountPaise: 45000, source: "manual_import" };
    const order = { ...capturedOrder(), refundedTotalPaise: condition === "settled" ? 45000 : 15000 };
    const fixture = database(order, { [refundId]: row });
    await ensureCancelledPaidRefundObligation({ orderId, after: order, db: fixture.db });
    expect(fixture.state.get(`refunds/${refundId}`)).toEqual(row);
  });

  it("serializes concurrent creation and replay without withdrawing or losing capture truth", async () => {
    const fixture = database();
    const event = capturedOrder();
    await Promise.all(Array.from({ length: 4 }, () =>
      ensureCancelledPaidRefundObligation({ orderId, after: event, db: fixture.db })
    ));
    expect(fixture.state.get(`refunds/${refundId}`)).toMatchObject({ status: "PENDING", amountPaise: 45000 });
    expect(fixture.state.get(`orders/${orderId}`).payment.capturedAmountPaise).toBe(45000);
  });
});
