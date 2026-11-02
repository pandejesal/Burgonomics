import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * P1-C — "charged and ignored" must be impossible.
 *
 * Razorpay offers no way to close an order, so the window between the gateway
 * check and the cancel transaction cannot be eliminated. Two layers close it:
 *
 *  (1) The cancel transaction re-reads the order and refuses when ANY payment
 *      truth — or a verify-in-progress marker written by the verify/webhook
 *      paths — is present on the fresh doc.
 *  (2) A capture that still lands after expiry is automatically FULLY refunded,
 *      idempotently, through the SAME autoRefund accounting a manual refund
 *      uses; the order is never resurrected.
 *
 * This suite drives the real `expireAbandonedUnpaidOrders` and the real
 * `refundLateCaptureForExpiredOrder`, with the provider POST stubbed at the
 * seam (`__setRefundPostForTests`) — money movement logic, ledger and
 * idempotency all run for real.
 */
const { mockDb, savedDocs, control, snapshots } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  const snapshots: any[] = [];
  const control = {
    razorpayPayments: {} as Record<string, any>,
    // Runs between the gateway answer and the cancel transaction.
    afterGatewayLookup: null as null | ((orderId: string) => void | Promise<void>),
    refundPosts: [] as Array<{ paymentId: string; body: any; key: string }>,
  };

  const deepMerge = (base: any, patch: any): any => {
    const out = { ...(base || {}) };
    for (const [k, v] of Object.entries(patch)) {
      out[k] = v && typeof v === "object" && !Array.isArray(v) ? deepMerge(out[k], v) : v;
    }
    return out;
  };
  const mergeSet = (path: string, data: any) => {
    savedDocs[path] = deepMerge(savedDocs[path] || {}, data);
  };

  const makeRef = (colName: string, docId: string) => {
    const path = `${colName}/${docId}`;
    const ref: any = {
      id: docId,
      path,
      get: async () => ({
        exists: Boolean(savedDocs[path]),
        data: () => (savedDocs[path] ? JSON.parse(JSON.stringify(savedDocs[path])) : undefined),
        ref,
      }),
      set: async (data: any, opts?: any) => {
        if (opts?.merge) mergeSet(path, data);
        else savedDocs[path] = { ...data };
      },
      update: async (data: any) => {
        if (!savedDocs[path]) throw new Error(`No document to update: ${path}`);
        mergeSet(path, data);
      },
      create: async (data: any) => {
        if (savedDocs[path]) {
          const err: any = new Error("ALREADY_EXISTS: Document already exists");
          err.code = 6;
          throw err;
        }
        savedDocs[path] = { ...data };
      },
    };
    return ref;
  };

  const queryFor = (colName: string, field: string, value: any) => ({
    limit: () => ({
      get: async () => {
        const docs = Object.entries(savedDocs)
          .filter(([path]) => path.startsWith(`${colName}/`))
          .filter(([, data]) => {
            const nested = field.split(".").reduce((acc: any, key) => acc?.[key], data);
            return nested === value;
          })
          .map(([path, data]) => ({
            id: path.split("/")[1],
            ref: makeRef(colName, path.split("/")[1]),
            data: () => JSON.parse(JSON.stringify(data)),
          }));
        return { empty: docs.length === 0, docs };
      },
    }),
  });

  const mockDb: any = {
    collection: (colName: string) => ({
      doc: (docId: string) => makeRef(colName, docId),
      where: (field: string, _op: string, value: any) => queryFor(colName, field, value),
    }),
    runTransaction: vi.fn(async (fn: any) => {
      // Snapshot reads, then apply writes (Firestore optimistic-retry domain is
      // covered elsewhere; here we need the fresh-read semantics).
      const writes: Array<{ path: string; data: any; merge: boolean }> = [];
      const result = await fn({
        get: async (ref: any) => ({
          exists: Boolean(savedDocs[ref.path]),
          data: () => JSON.parse(JSON.stringify(savedDocs[ref.path] || {})),
          ref,
        }),
        set: (ref: any, data: any, opts?: any) =>
          writes.push({ path: ref.path, data, merge: !!opts?.merge }),
        update: (ref: any, data: any) => writes.push({ path: ref.path, data, merge: true }),
      });
      for (const w of writes) {
        if (w.merge) mergeSet(w.path, w.data);
        else savedDocs[w.path] = { ...w.data };
      }
      return result;
    }),
  };

  return { mockDb, savedDocs, control, snapshots };
});

vi.mock("../src/core/firebase", () => ({ db: mockDb }));

vi.mock("firebase-admin", () => {
  const FieldValue = {
    serverTimestamp: () => "MOCK_TS",
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

vi.mock("../src/modules/payments/razorpayClient", () => ({
  getRazorpayClient: () => ({
    orders: {
      fetchPayments: vi.fn(async (razorpayOrderId: string) => {
        const value = control.razorpayPayments[razorpayOrderId];
        if (value instanceof Error) throw value;
        return value ?? { items: [] };
      }),
    },
  }),
}));

vi.mock("../src/core/errors", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    captureErrorSnapshot: vi.fn(async (snapshot: any) => {
      snapshots.push(snapshot);
      return "snap_1";
    }),
  };
});

import { expireAbandonedUnpaidOrders, __setAfterGatewayLookupForTests } from "../src/modules/orders/expireUnpaidOrders";
import {
  markPaymentVerificationInFlight,
  clearPaymentVerificationInFlight,
} from "../src/modules/orders/paymentGate";
import { refundLateCaptureForExpiredOrder } from "../src/modules/payments/lateCaptureRefund";
import { __setRefundPostForTests } from "../src/modules/payments/razorpay.service";
import { config } from "../src/config/env";
import { db } from "../src/core/firebase";

const oldIso = new Date(Date.now() - 35 * 60_000).toISOString();

const abandoned = (id: string, over: Record<string, any> = {}) => ({
  id,
  createdAt: oldIso,
  placedAt: oldIso,
  customerId: "cust_1",
  userId: "cust_1",
  branchId: "branch_a",
  fulfillment: "takeaway",
  pricing: { grandTotal: 250 },
  status: { code: "PLACED", label: "Order placed", kind: "upcoming", terminal: false },
  payment: { method: "online", label: "Pay Online", status: "pending" },
  ...over,
});

const bindIntent = (orderId: string, razorpayOrderId: string) => {
  savedDocs[`payment_intents/intent_${orderId}`] = {
    orderId,
    razorpayOrderId,
    createdAtMs: Date.now() - 35 * 60_000,
  };
};

describe("P1-C layer 1 — the cancel transaction re-reads payment truth", () => {
  beforeEach(() => {
    for (const key of Object.keys(savedDocs)) delete savedDocs[key];
    snapshots.length = 0;
    control.razorpayPayments = {};
    control.afterGatewayLookup = null;
    control.refundPosts = [];
    __setAfterGatewayLookupForTests(async (orderId: string) => {
      const hook = control.afterGatewayLookup;
      if (hook) await hook(orderId);
    });
  });

  it("interleaved: a verify that starts AFTER the gateway said 'unpaid' blocks the cancel", async () => {
    // Real sequence: sweep asks Razorpay -> nothing -> customer's checkout
    // submits the payment -> verify writes its in-flight marker -> the sweep's
    // cancel transaction re-reads -> must lose.
    savedDocs["orders/ord_verify_race"] = abandoned("ord_verify_race");
    bindIntent("ord_verify_race", "rzp_verify_race");
    control.razorpayPayments["rzp_verify_race"] = { items: [] };
    control.afterGatewayLookup = async (orderId) => {
      if (orderId !== "ord_verify_race") return;
      await markPaymentVerificationInFlight(db.collection("orders").doc(orderId), {
        razorpayOrderId: "rzp_verify_race",
        razorpayPaymentId: "pay_verify_race",
      });
    };

    const stats = await expireAbandonedUnpaidOrders();

    expect(savedDocs["orders/ord_verify_race"].status.code).toBe("PLACED");
    expect(savedDocs["orders/ord_verify_race"].cancellationReason).toBeUndefined();
    expect(stats.cancelled).toBe(0);
    expect(stats.skippedUnknown).toBe(1);
  });

  it("interleaved: a capture that commits between gateway and cancel blocks the cancel", async () => {
    savedDocs["orders/ord_cap_race"] = abandoned("ord_cap_race");
    bindIntent("ord_cap_race", "rzp_cap_race");
    control.razorpayPayments["rzp_cap_race"] = { items: [] };
    control.afterGatewayLookup = async (orderId) => {
      if (orderId !== "ord_cap_race") return;
      // The webhook's confirmation lands here — the exact TOCTOU.
      savedDocs["orders/ord_cap_race"] = {
        ...savedDocs["orders/ord_cap_race"],
        paymentStatus: "completed",
        paymentChannel: "razorpay",
        payment: {
          method: "online",
          status: "completed",
          razorpayPaymentId: "pay_cap_race",
          capturedAmountPaise: 25000,
        },
        status: { code: "CONFIRMED", label: "Order confirmed", kind: "upcoming", terminal: false },
      };
    };

    const stats = await expireAbandonedUnpaidOrders();

    expect(savedDocs["orders/ord_cap_race"].status.code).toBe("CONFIRMED");
    expect(stats.cancelled).toBe(0);
  });

  it("a stale verify marker (crashed verify) does not block expiry forever", async () => {
    savedDocs["orders/ord_stale_marker"] = abandoned("ord_stale_marker", {
      paymentAttempt: {
        status: "verifying",
        razorpayOrderId: "rzp_stale",
        razorpayPaymentId: "pay_stale",
        startedAt: Date.now() - 20 * 60_000,
      },
    });
    bindIntent("ord_stale_marker", "rzp_stale");
    control.razorpayPayments["rzp_stale"] = { items: [] };

    const stats = await expireAbandonedUnpaidOrders();

    expect(stats.cancelled).toBe(1);
    expect(savedDocs["orders/ord_stale_marker"].status.code).toBe("CANCELLED");
  });

  it("an authorized-but-uncaptured hold blocks the cancel (money is reserved)", async () => {
    savedDocs["orders/ord_auth_hold"] = abandoned("ord_auth_hold", {
      paymentStatus: "awaiting_capture",
      payment: { method: "online", status: "awaiting_capture" },
    });

    const stats = await expireAbandonedUnpaidOrders();

    expect(savedDocs["orders/ord_auth_hold"].status.code).toBe("PLACED");
    expect(stats.cancelled).toBe(0);
  });

  it("clears the marker when verify finishes, so a genuinely unpaid order expires", async () => {
    savedDocs["orders/ord_clear"] = abandoned("ord_clear");
    bindIntent("ord_clear", "rzp_clear");
    control.razorpayPayments["rzp_clear"] = { items: [] };
    const ref = db.collection("orders").doc("ord_clear");
    await markPaymentVerificationInFlight(ref, {
      razorpayOrderId: "rzp_clear",
      razorpayPaymentId: "pay_clear",
    });
    await clearPaymentVerificationInFlight(ref, "PAYMENT_NOT_CAPTURED");

    const stats = await expireAbandonedUnpaidOrders();

    expect(stats.cancelled).toBe(1);
    expect(savedDocs["orders/ord_clear"].status.code).toBe("CANCELLED");
  });
});

describe("P1-C layer 2 — a late capture on an expired order is refunded, never kept", () => {
  const prevMock = config.mock.paymentGateway;
  beforeEach(() => {
    for (const key of Object.keys(savedDocs)) delete savedDocs[key];
    snapshots.length = 0;
    control.razorpayPayments = {};
    control.afterGatewayLookup = null;
    control.refundPosts = [];
    __setAfterGatewayLookupForTests(null);
    // Live-ish money path with the POST stubbed at the seam, so autoRefund's
    // real guards, ledger and idempotency run.
    config.mock.paymentGateway = false;
    __setRefundPostForTests(async (paymentId, body, key) => {
      control.refundPosts.push({ paymentId, body, key });
      return {
        id: `rfnd_late_${paymentId}`,
        payment_id: paymentId,
        amount: body.amount ?? 25000,
        status: "processed",
      };
    });
  });

  // afterEach via inline restore to keep the suite independent of ordering.
  const restore = () => {
    config.mock.paymentGateway = prevMock;
    __setRefundPostForTests(null);
  };

  it("interleaved: expiry cancel completes, THEN the capture webhook lands -> full automatic refund, order stays CANCELLED", async () => {
    savedDocs["orders/ord_late"] = abandoned("ord_late");
    bindIntent("ord_late", "rzp_late");
    control.razorpayPayments["rzp_late"] = { items: [] };
    try {
      const stats = await expireAbandonedUnpaidOrders();
      expect(stats.cancelled).toBe(1);
      expect(savedDocs["orders/ord_late"].status.code).toBe("CANCELLED");
      expect(savedDocs["orders/ord_late"].cancellationReason).toBe("payment_not_completed");

      // The customer's bank had already authorized; Razorpay delivers the
      // capture seconds after the sweep cancelled.
      const outcome = await refundLateCaptureForExpiredOrder({
        orderId: "ord_late",
        razorpayPaymentId: "pay_late",
        razorpayOrderId: "rzp_late",
        capturedAmountPaise: 25000,
        source: "webhook_capture_after_expiry",
      });

      expect(outcome).toMatchObject({ refunded: true, reason: "captured_after_expiry" });
      expect(control.refundPosts).toHaveLength(1);
      expect(control.refundPosts[0].paymentId).toBe("pay_late");
      // Deterministic gateway idempotency key for THIS request identity
      // (rfnd_<sha256 of [orderId, paymentId, requestId]>) — stable across
      // retries, so Razorpay dedupes rather than refunding twice.
      expect(control.refundPosts[0].key).toMatch(/^rfnd_[0-9a-f]{64}$/);

      const order = savedDocs["orders/ord_late"];
      // Money returned, order NOT resurrected.
      expect(order.status).toMatchObject({ code: "CANCELLED", terminal: true });
      expect(order.refundStatus).toBe("refunded");
      expect(order.refundedTotalPaise).toBe(25000);
      expect(order.status.code).not.toBe("CONFIRMED");
      // Audited through the SAME path a manual refund uses.
      const refundAudits = Object.keys(savedDocs).filter(
        (k) => k.startsWith("payment_audits/aud_rfnd_")
      );
      expect(refundAudits).toHaveLength(1);
      expect(
        snapshots.some((s) => /captured after|after expiry|expired/i.test(String(s.message)))
      ).toBe(true);
    } finally {
      restore();
    }
  });

  it("replays the same capture without a second gateway refund (idempotent)", async () => {
    savedDocs["orders/ord_late_replay"] = abandoned("ord_late_replay");
    bindIntent("ord_late_replay", "rzp_late_replay");
    control.razorpayPayments["rzp_late_replay"] = { items: [] };
    try {
      await expireAbandonedUnpaidOrders();

      const first = await refundLateCaptureForExpiredOrder({
        orderId: "ord_late_replay",
        razorpayPaymentId: "pay_late_replay",
        razorpayOrderId: "rzp_late_replay",
        capturedAmountPaise: 25000,
        source: "webhook_capture_after_expiry",
      });
      const second = await refundLateCaptureForExpiredOrder({
        orderId: "ord_late_replay",
        razorpayPaymentId: "pay_late_replay",
        razorpayOrderId: "rzp_late_replay",
        capturedAmountPaise: 25000,
        source: "webhook_capture_after_expiry",
      });

      expect(first).toMatchObject({ refunded: true });
      expect(second).toMatchObject({ refunded: true, reused: true });
      // ONE provider POST for the same capture — the retry replays the receipt.
      expect(control.refundPosts).toHaveLength(1);
      const order = savedDocs["orders/ord_late_replay"];
      expect(order.refundedTotalPaise).toBe(25000);
      expect(Object.keys(order.refundLedger)).toHaveLength(1);
    } finally {
      restore();
    }
  });

  it("does NOT auto-refund a staff-cancelled order (narrow: expiry cancellations only)", async () => {
    savedDocs["orders/ord_staff_cancel"] = abandoned("ord_staff_cancel", {
      status: { code: "CANCELLED", label: "Cancelled", kind: "cancelled", terminal: true },
      cancellationReason: "Customer asked to cancel",
    });
    try {
      const outcome = await refundLateCaptureForExpiredOrder({
        orderId: "ord_staff_cancel",
        razorpayPaymentId: "pay_staff_cancel",
        razorpayOrderId: "rzp_staff_cancel",
        capturedAmountPaise: 25000,
        source: "webhook_capture_after_expiry",
      });
      expect(outcome).toMatchObject({ refunded: false, reason: "not_an_expiry_cancellation" });
      expect(control.refundPosts).toHaveLength(0);
    } finally {
      restore();
    }
  });

  it("does NOT auto-refund a live (non-cancelled) order — that is the normal confirm path", async () => {
    savedDocs["orders/ord_live"] = abandoned("ord_live");
    try {
      const outcome = await refundLateCaptureForExpiredOrder({
        orderId: "ord_live",
        razorpayPaymentId: "pay_live",
        razorpayOrderId: "rzp_live",
        capturedAmountPaise: 25000,
        source: "webhook_capture_after_expiry",
      });
      expect(outcome).toMatchObject({ refunded: false, reason: "order_not_expired" });
      expect(control.refundPosts).toHaveLength(0);
    } finally {
      restore();
    }
  });

  it("keeps monthlyFeeHold and branch_monthly_fees consistent (no hold, no ledger movement)", async () => {
    savedDocs["orders/ord_ledger"] = abandoned("ord_ledger");
    savedDocs["branch_monthly_fees/branch_a_2026-11"] = {
      branchId: "branch_a",
      monthKey: "2026-11",
      feePaise: 250000,
      feeCollectedPaise: 0,
      razorpayEarnedPaise: 0,
      razorpayRefundedPaise: 0,
    };
    bindIntent("ord_ledger", "rzp_ledger");
    control.razorpayPayments["rzp_ledger"] = { items: [] };
    try {
      await expireAbandonedUnpaidOrders();
      const before = JSON.parse(
        JSON.stringify(savedDocs["branch_monthly_fees/branch_a_2026-11"])
      );

      await refundLateCaptureForExpiredOrder({
        orderId: "ord_ledger",
        razorpayPaymentId: "pay_ledger",
        razorpayOrderId: "rzp_ledger",
        capturedAmountPaise: 25000,
        source: "webhook_capture_after_expiry",
      });

      // The capture was never held (no transfer ran), so the refund must not
      // release or ledger anything — otherwise the fee ledger would count a
      // refund against money it never collected.
      expect(savedDocs["branch_monthly_fees/branch_a_2026-11"]).toEqual(before);
      expect(savedDocs["orders/ord_ledger"].monthlyFeeHold).toBeUndefined();
      expect(savedDocs["orders/ord_ledger"].refundedTotalPaise).toBe(25000);
    } finally {
      restore();
    }
  });
});
