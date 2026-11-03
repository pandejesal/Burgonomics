/**
 * Trigger wiring for the cancel refund obligation:
 *  - reconcile runs BEFORE the status-delta gate (capture-after-cancel and
 *    retry-after-failure both work), while notifications stay gated;
 *  - the module's own marker writes never re-enter reconcile (no write loop);
 *  - the staff alert is claimed durably on the refund row, so identical
 *    redelivered snapshots and concurrent triggers do not double-page;
 *  - honest customer copy (never "no money charged" when money was taken).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  ensure: vi.fn(),
  claim: vi.fn(),
  settle: vi.fn(async () => undefined),
  sendStaff: vi.fn(async () => true),
  sendCustomer: vi.fn(async () => ({ successCount: 1 })),
  snapshots: [] as any[],
}));

vi.mock("../src/core/firebase", () => ({
  db: {
    collection: () => ({
      doc: () => ({
        get: async () => ({ exists: true, data: () => ({ fcmTokens: ["tok"] }) }),
        set: async () => undefined,
      }),
    }),
  },
  auth: {},
  messaging: {},
}));

vi.mock("../src/modules/petpooja/orderPush", () => ({
  pushKotForCashOrderOnAccept: vi.fn(async () => false),
}));
vi.mock("../src/core/errors", () => ({
  captureErrorSnapshot: vi.fn(async (s: any) => {
    h.snapshots.push(s);
    return "err";
  }),
}));
vi.mock("../src/modules/notifications/fcmClient", () => ({
  sendFcmMessage: h.sendStaff,
  sendMulticastFcm: h.sendCustomer,
}));

// Only the real plan gate is used by the trigger; the durable pieces are
// stubbed so the wiring — not the queue — is what is under test here.
const real = await import("../src/modules/orders/cancelRefundObligation");
vi.mock("../src/modules/orders/cancelRefundObligation", async () => {
  const actual: any = await vi.importActual("../src/modules/orders/cancelRefundObligation");
  return {
    ...actual,
    ensureCancelledPaidRefundObligation: h.ensure,
    claimRefundReviewAlert: h.claim,
    settleRefundReviewAlert: h.settle,
  };
});
void real;

import { handleOrderStatusChanged } from "../src/modules/notifications/triggers";

const paidCancelled = (overrides: Record<string, any> = {}) => ({
  shortCode: "BG-77",
  branchId: "branch_a",
  customerId: "cust_1",
  status: { code: "CANCELLED", terminal: true },
  paymentChannel: "razorpay",
  payment: { method: "online", razorpayPaymentId: "pay_1", capturedAmountPaise: 45000 },
  ...overrides,
});

const queued = () => ({
  created: true,
  refundId: "refund_cancel_ord_1",
  amountPaise: 45000,
  pendingRefundId: "refund_cancel_ord_1",
  reviewAmountPaise: 45000,
});

beforeEach(() => {
  h.snapshots.length = 0;
  h.ensure.mockReset();
  h.claim.mockReset();
  h.settle.mockClear();
  h.sendStaff.mockClear();
  h.sendCustomer.mockClear();
  h.ensure.mockResolvedValue(queued());
  h.claim.mockResolvedValue({ claimed: true, token: "tok_1", reason: "claimed" });
});

describe("cancelled paid order trigger", () => {
  it("queues review, alerts staff once, and tells the customer it awaits review", async () => {
    await handleOrderStatusChanged(
      "ord_1",
      paidCancelled({ status: { code: "PREPARING" } }),
      paidCancelled()
    );

    expect(h.ensure).toHaveBeenCalledTimes(1);
    expect(h.claim).toHaveBeenCalledWith({ refundId: "refund_cancel_ord_1" });
    expect(h.sendStaff).toHaveBeenCalledTimes(1);
    const alert = h.sendStaff.mock.calls[0][0] as any;
    expect(alert.data.type).toBe("REFUND_REVIEW_REQUIRED");
    expect(alert.data.orderId).toBe("ord_1");
    expect(h.settle).toHaveBeenCalledWith({
      refundId: "refund_cancel_ord_1",
      token: "tok_1",
      delivered: true,
      error: "",
    });

    const customer = h.sendCustomer.mock.calls[0][1] as any;
    expect(customer.notification.body).toContain("awaiting review");
    expect(customer.notification.body).not.toContain("No money was charged");
  });

  // P1: CANCELLED→CANCELLED must still reconcile (a capture can land after a
  // cancel, and the queue write can fail on the first pass) — but must NOT
  // re-send the customer notification.
  it("reconciles a cancelled→cancelled update without re-notifying the customer", async () => {
    await handleOrderStatusChanged("ord_1", paidCancelled(), paidCancelled());
    expect(h.ensure).toHaveBeenCalledTimes(1);
    expect(h.sendCustomer).not.toHaveBeenCalled();
  });

  it("re-attempts a failed queue on the next genuine cancelled update", async () => {
    h.ensure.mockResolvedValueOnce({ created: false, reason: "queue_failed" });
    await handleOrderStatusChanged("ord_1", paidCancelled(), paidCancelled());
    h.ensure.mockResolvedValueOnce(queued());
    // A GENUINE update (not just our own marker/timestamp churn).
    await handleOrderStatusChanged(
      "ord_1",
      paidCancelled(),
      paidCancelled({ cancellationReason: "kitchen could not fulfil" })
    );
    expect(h.ensure).toHaveBeenCalledTimes(2);
    expect(h.sendStaff).toHaveBeenCalledTimes(1);
  });

  // P1: the module's own marker write must not feed itself.
  it("ignores an update that only carries this module's own obligation marker", async () => {
    const before = paidCancelled();
    const afterSuspect = paidCancelled({
      refundObligation: {
        status: "QUEUED",
        refundId: "refund_cancel_ord_1",
        amountPaise: 45000,
        updatedAt: "TS",
      },
    });
    await handleOrderStatusChanged("ord_1", before, afterSuspect);
    expect(h.ensure).not.toHaveBeenCalled();
    expect(h.sendStaff).not.toHaveBeenCalled();
  });

  // CORRECTED: a payment.refundStatus-only change is how autoRefund and the
  // refund.processed webhook SETTLE money. Filtering it would skip a genuine
  // reconcile (and leave a stale queue row), so it must re-enter the helper.
  it("still reconciles a refundStatus-only settlement change", async () => {
    const before = paidCancelled();
    const afterSettled = paidCancelled({
      payment: {
        method: "online",
        razorpayPaymentId: "pay_1",
        capturedAmountPaise: 45000,
        refundStatus: "refunded",
      },
    });
    await handleOrderStatusChanged("ord_1", before, afterSettled);
    expect(h.ensure).toHaveBeenCalledTimes(1);
  });

  // P2: identical replays and concurrent triggers must not double-page.
  it("does not alert when the durable claim reports already delivered", async () => {
    h.claim.mockResolvedValue({ claimed: false, reason: "delivered" });
    await handleOrderStatusChanged("ord_1", paidCancelled(), paidCancelled());
    expect(h.sendStaff).not.toHaveBeenCalled();
  });

  it("does not alert when a concurrent trigger holds the claim", async () => {
    h.claim.mockResolvedValue({ claimed: false, reason: "in_flight" });
    await Promise.all([
      handleOrderStatusChanged("ord_1", paidCancelled(), paidCancelled()),
      handleOrderStatusChanged("ord_1", paidCancelled(), paidCancelled()),
    ]);
    expect(h.sendStaff).not.toHaveBeenCalled();
  });

  it("identical before/after replay sends no customer notification and no alert", async () => {
    const snap = paidCancelled();
    h.claim.mockResolvedValue({ claimed: false, reason: "delivered" });
    await handleOrderStatusChanged("ord_1", snap, { ...snap });
    expect(h.sendCustomer).not.toHaveBeenCalled();
    expect(h.sendStaff).not.toHaveBeenCalled();
  });

  // P2: the alert must use the ROW's authoritative amount, not the stale event.
  it("uses the claim's authoritative row amount for the alert body", async () => {
    h.claim.mockResolvedValue({ claimed: true, token: "tok_1", reason: "claimed", amountPaise: 30000 });
    h.ensure.mockResolvedValue({
      created: false,
      reason: "already_queued",
      pendingRefundId: "refund_cancel_ord_1",
      reviewAmountPaise: 45000,
    });
    await handleOrderStatusChanged("ord_1", paidCancelled(), paidCancelled());
    const alert = h.sendStaff.mock.calls[0][0] as any;
    expect(alert.notification.body).toContain("₹300");
  });

  // P2: a false transport result must NOT be recorded as delivered.
  it("records a false send as a retryable failure, not a delivery", async () => {
    h.sendStaff.mockResolvedValueOnce(false);
    await handleOrderStatusChanged(
      "ord_1",
      paidCancelled({ status: { code: "PREPARING" } }),
      paidCancelled()
    );
    expect(h.settle).toHaveBeenCalledWith({
      refundId: "refund_cancel_ord_1",
      token: "tok_1",
      delivered: false,
      error: "transport returned false",
    });
    expect(h.snapshots.some((s) => s.message.includes("was not delivered"))).toBe(true);
  });

  // P2: an existing POS PENDING row still gets its ONE alert.
  it("alerts on an existing POS pending row it did not create", async () => {
    h.ensure.mockResolvedValue({
      created: false,
      reason: "existing_refund",
      pendingRefundId: "refund_pos_cancel_ord_1",
      reviewAmountPaise: 12000,
    });
    await handleOrderStatusChanged("ord_1", paidCancelled(), paidCancelled());
    expect(h.claim).toHaveBeenCalledWith({ refundId: "refund_pos_cancel_ord_1" });
    expect(h.sendStaff).toHaveBeenCalledTimes(1);
    expect((h.sendStaff.mock.calls[0][0] as any).notification.body).toContain("₹120");
  });

  it("never marks money as un-charged for a captured payment when no row was queued", async () => {
    h.ensure.mockResolvedValueOnce({ created: false, reason: "already_queued" });
    await handleOrderStatusChanged(
      "ord_1",
      paidCancelled({ status: { code: "PREPARING" } }),
      paidCancelled()
    );
    const customer = h.sendCustomer.mock.calls[0][1] as any;
    expect(customer.notification.body).not.toContain("No money was charged");
    expect(customer.notification.body).not.toContain("has been initiated");
  });

  it("does nothing when a non-cancelled status did not change", async () => {
    await handleOrderStatusChanged(
      "ord_1",
      paidCancelled({ status: { code: "PREPARING" } }),
      paidCancelled({ status: { code: "PREPARING" } })
    );
    expect(h.ensure).not.toHaveBeenCalled();
    expect(h.sendCustomer).not.toHaveBeenCalled();
  });
});
