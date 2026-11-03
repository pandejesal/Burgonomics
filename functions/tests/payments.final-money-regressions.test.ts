import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * FINAL MONEY REGRESSIONS — two independent blockers, each reproduced.
 *
 * 1. `clearCaptureStallOnRecovery` wrote the order doc and THEN read the ops
 *    case inside the same Firestore transaction. Real Firestore rejects a read
 *    after a write and aborts the transaction, so a recovered order lost BOTH
 *    the cleared stall record and the queued "do NOT refund" follow-up. The fake
 *    transaction here ENFORCES that rule (it throws on `tx.get` after
 *    `tx.set`/`tx.update`), so the bug is red for the same reason production was.
 *
 * 2. A case settled as `refunded_externally` (or `resolved`/`ignored`) was
 *    treated as `staffResolved` and therefore SKIPPED the gateway probe, so the
 *    next tick confirmed an order the gateway had already refunded. A settled
 *    case must STAND DOWN, never grant permission to confirm.
 *
 * Only Firestore, the alert transport and the confirmation seam are faked; the
 * recovery sweep, the capture gate and the guards are the real code.
 */
const { mockDb, docs, writeLog, control } = vi.hoisted(() => {
  process.env.OTP_HMAC_SECRET = "test_final_money";

  const docs = new Map<string, any>();
  const writeLog: Array<{ path: string; data: any; merge?: boolean }> = [];
  const control: any = {
    refundPosts: [] as any[],
    /** Confirmation calls the recovery lane actually made. */
    confirmAttempts: [] as string[],
    /** Orders whose confirmation should fail (exercise the stall counter). */
    confirmFailsFor: new Set<string>(),
    /** Read-before-write violations the strict fake had to reject. */
    readAfterWriteViolations: 0,
  };

  const clone = (v: any) => JSON.parse(JSON.stringify(v));
  const mergeMaps = (base: any, patch: any): any => {
    const out = { ...base };
    for (const [k, v] of Object.entries(patch)) {
      out[k] =
        v && typeof v === "object" && !Array.isArray(v)
          ? mergeMaps(base?.[k] || {}, v)
          : v;
    }
    return out;
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
        data: () => (docs.has(path) ? clone(docs.get(path)) : undefined),
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
    let limitN: number | null = null;
    let afterId: string | null = null;
    const q: any = {
      where: (field: string, _op: string, value: any) => {
        filters.push({ field, value });
        return q;
      },
      orderBy: (field: any) => {
        const name = typeof field === "string" ? field : "__name__";
        if (name !== "__name__") throw new Error(`Unsupported fake order: ${name}`);
        return q;
      },
      startAfter: (cursor: any) => {
        afterId = String(typeof cursor === "string" ? cursor : cursor?.id ?? "");
        return q;
      },
      limit: (n: number) => {
        limitN = typeof n === "number" && Number.isFinite(n) ? Math.max(0, Math.floor(n)) : null;
        return q;
      },
      get: async () => {
        const all = [...docs.entries()]
          .filter(([p]) => p.startsWith(`${colName}/`))
          .filter(([, d]) => filters.every((f) => getByPath(d, f.field) === f.value))
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([p, d]) => {
            const id = p.slice(colName.length + 1);
            return { id, ref: docRef(colName, id), data: () => clone(d) };
          });
        const after = afterId === null ? all : all.filter((d) => d.id > afterId!);
        const found = limitN === null ? after : after.slice(0, limitN);
        return { empty: found.length === 0, size: found.length, docs: found };
      },
      doc: (docId?: string) =>
        docRef(colName, docId || `auto_${Math.random().toString(36).slice(2, 8)}`),
    };
    return q;
  };

  /**
   * STRICT transactional fake: Firestore accepts all reads first, then all
   * writes. A `tx.get` AFTER any queued write is a real abort, so this fake
   * throws instead of quietly succeeding (which is what hid the bug).
   */
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
        const data = docs.get(ref.path);
        return {
          exists: data !== undefined,
          data: () => (data === undefined ? undefined : clone(data)),
          ref,
        };
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

  return { mockDb, docs, writeLog, control };
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
    payments: { fetch: vi.fn(async () => undefined) },
  }),
  getRazorpayKeyId: () => "rzp_test_final_money",
}));

// The confirmation seam: real recovery decides, only the final write is faked.
vi.mock("../src/modules/payments/razorpay.service", async (io) => {
  const actual = await io<any>();
  return {
    ...actual,
    completeRecoveredCapture: vi.fn(async (args: any) => {
      control.confirmAttempts.push(args.orderId);
      if (control.confirmFailsFor.has(args.orderId)) return false;
      docs.set(`orders/${args.orderId}`, {
        ...docs.get(`orders/${args.orderId}`),
        petpoojaOrderId: `pos_${args.orderId}`,
        paymentStatus: "completed",
        captureFulfillmentState: "confirmed",
      });
      return true;
    }),
  };
});

vi.mock("../src/core/errors", async (io) => {
  const actual = await io<any>();
  return {
    ...actual,
    captureErrorSnapshot: vi.fn(async () => "snap_1"),
  };
});

import { captureErrorSnapshot } from "../src/core/errors";
import {
  __setPaymentsFetchForTests,
  __setRefundPostForTests,
} from "../src/modules/payments/razorpay.service";
import { recoverStuckCaptureFulfilments } from "../src/modules/payments/captureRecovery";
import { CAPTURE_RECOVERY_AFTER_MS } from "../src/modules/payments/captureFulfillment";
import { config } from "../src/config/env";

const BRANCH = "branch_final_money";
const ITEMS = [{ id: "p1", productId: "p1", name: "Burger", price: 100, quantity: 1 }];

const orderOf = (id: string) => docs.get(`orders/${id}`);
const caseOf = (paymentId: string) => docs.get(`unmatched_payments/ump_gate_${paymentId}`);

function seedOrder(orderId: string, over: Record<string, any> = {}) {
  const paymentId = `pay_${orderId}`;
  docs.set(`orders/${orderId}`, {
    id: orderId,
    customerId: "cust_final",
    userId: "cust_final",
    branchId: BRANCH,
    orderType: "takeaway",
    items: ITEMS,
    payment: {
      method: "online",
      status: "completed",
      razorpayPaymentId: paymentId,
      razorpayOrderId: `rzp_${orderId}`,
      capturedAmountPaise: 10000,
    },
    "payment.status": "completed",
    "payment.razorpayPaymentId": paymentId,
    "payment.capturedAmountPaise": 10000,
    pricing: { grandTotal: 100, split: { branchTransferPaise: 10000 } },
    paymentStatus: "completed",
    routeTransferStatus: "not_required",
    status: { code: "PLACED", label: "Order placed", kind: "upcoming", terminal: false },
    captureFulfillment: {
      state: "fulfillable",
      paymentId,
      atMs: Date.now() - CAPTURE_RECOVERY_AFTER_MS - 60_000,
      attempts: 1,
      detail: "p1",
    },
    captureFulfillmentState: "fulfillable",
    ...over,
  });
  docs.set("products/p1", { id: "p1", name: "Burger", price: 100, inStock: true });
  return paymentId;
}

/** Real alert transport boundary (acknowledged fetch), no network. */
async function installRealAlerts() {
  const actual = await vi.importActual<any>("../src/core/errors");
  const mocked = await import("../src/core/errors");
  const capture = vi.mocked(captureErrorSnapshot);
  const previous = capture.getMockImplementation()!;
  const oldSlack = config.alerts.slackWebhookUrl;
  const oldDiscord = config.alerts.discordWebhookUrl;
  const sends: Array<{ text: string }> = [];
  capture.mockImplementation(actual.captureErrorSnapshot);
  config.alerts.slackWebhookUrl = "https://final.invalid/hook";
  config.alerts.discordWebhookUrl = "";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: any, options: any) => {
      sends.push({ text: JSON.parse(options.body).text });
      return { ok: true, status: 200 };
    })
  );
  return {
    sends,
    restore: () => {
      capture.mockImplementation(previous);
      config.alerts.slackWebhookUrl = oldSlack;
      config.alerts.discordWebhookUrl = oldDiscord;
      vi.unstubAllGlobals();
    },
  };
}

beforeEach(() => {
  for (const key of [...docs.keys()]) docs.delete(key);
  writeLog.length = 0;
  control.refundPosts = [];
  control.confirmAttempts = [];
  control.confirmFailsFor = new Set<string>();
  control.readAfterWriteViolations = 0;
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-03T09:00:00Z"));
  config.mock.paymentGateway = false;
  config.mock.petpoojaPos = true;
  docs.set(`branches/${BRANCH}`, { id: BRANCH, isOpen: true, packagingFee: 0, monthlyFee: 0 });
  docs.set("products/p1", { id: "p1", name: "Burger", price: 100, inStock: true });
  __setRefundPostForTests(async (paymentId: string, body: any) => {
    control.refundPosts.push({ paymentId, body });
    return { id: `rfnd_${paymentId}`, payment_id: paymentId, amount: 10000, status: "processed" };
  });
  // Default gateway truth: captured, NO refund.
  __setPaymentsFetchForTests(async (paymentId: string) => ({
    id: paymentId,
    order_id: `rzp_${paymentId}`,
    amount: 10000,
    currency: "INR",
    status: "captured",
    amount_refunded: 0,
    notes: {},
  }));
});

afterEach(() => {
  vi.useRealTimers();
  __setRefundPostForTests(null);
  __setPaymentsFetchForTests(null);
});

// ===========================================================================
// 0. The fake itself must reject a read after a write, or test 1 proves nothing.
// ===========================================================================
describe("the transactional fake enforces Firestore's read-before-write rule", () => {
  it("throws when tx.get runs after tx.set", async () => {
    docs.set("orders/fake_probe", { id: "fake_probe" });
    await expect(
      mockDb.runTransaction(async (tx: any) => {
        await tx.get(db_orderRef("fake_probe"));
        tx.set(db_orderRef("fake_probe"), { touched: true }, { merge: true });
        await tx.get(db_orderRef("fake_probe"));
      })
    ).rejects.toThrow(/reads to be executed before all writes/i);
    // The aborted transaction wrote nothing.
    expect(docs.get("orders/fake_probe").touched).toBeUndefined();
    expect(control.readAfterWriteViolations).toBe(1);
  });
});

function db_orderRef(id: string) {
  return { id, path: `orders/${id}` };
}

// ===========================================================================
// 1. clearCaptureStallOnRecovery — read the case BEFORE any write.
// ===========================================================================
describe("recovery clears the stall and queues the follow-up on one transaction", () => {
  it("a recovered, already-delivered case stamps `recovered` and sends the follow-up", async () => {
    const paymentId = seedOrder("ord_rec", {
      captureStall: {
        paymentId: "pay_ord_rec",
        gateState: "fulfillable",
        failedAttempts: 8,
        firstFailureAtMs: Date.now() - 2 * 60 * 60_000,
        lastFailureAtMs: Date.now() - 60_000,
        escalatedAtMs: Date.now() - 60 * 60_000,
      },
    });
    // A human was already paged, and the first alert really landed.
    docs.set(`unmatched_payments/ump_gate_${paymentId}`, {
      eventId: `gate_${paymentId}`,
      event: "capture_fulfilment_recovery",
      orderId: "ord_rec",
      razorpayPaymentId: paymentId,
      status: "needs_review",
      reason: "capture_decision_stuck",
      gateState: "fulfillable",
      staffAction: "confirm_or_refund_manually",
      receivedAt: "STAFF_ORIGINAL",
      alertDelivery: {
        state: "delivered",
        alertKind: "capture_decision_stuck",
        attempts: 3,
        deliveredAtMs: 1,
        escalatedAtMs: Date.now() - 60 * 60_000,
      },
    });
    const alerts = await installRealAlerts();
    const sweepStartedAtMs = Date.now();
    try {
      const stats = await recoverStuckCaptureFulfilments();

      expect(stats.confirmed).toBe(1);
      // ── the fix: the stall record is cleared and the recovery is stamped ──
      expect(orderOf("ord_rec").captureStall).toBeNull();
      const staffCase = caseOf(paymentId);
      expect(staffCase.recovered).toMatchObject({ outcome: "confirmed" });
      expect(staffCase.recovered.atMs).toBeGreaterThanOrEqual(sweepStartedAtMs);
      expect(staffCase.recovered.note).toContain("do NOT refund");
      // The follow-up really left the building on the same outbox.
      expect(staffCase.alertDelivery.alertKind).toBe("recovered_confirmed");
      expect(staffCase.alertDelivery.state).toBe("delivered");
      const followUp = alerts.sends[alerts.sends.length - 1].text.toLowerCase();
      expect(followUp).toContain("do not refund");
      expect(followUp).toContain("confirmed");
      // No read-after-write violation was ever attempted.
      expect(control.readAfterWriteViolations).toBe(0);
      // Never refunds a confirmed order.
      expect(control.refundPosts).toHaveLength(0);
    } finally {
      alerts.restore();
    }
  });

  it("a case that no longer needs review is never stamped, re-alerted or re-counted", async () => {
    const paymentId = seedOrder("ord_rec_settled", {
      captureStall: {
        paymentId: "pay_ord_rec_settled",
        gateState: "fulfillable",
        failedAttempts: 2,
        firstFailureAtMs: Date.now() - 2 * 60 * 60_000,
        lastFailureAtMs: Date.now() - 5 * 60_000,
      },
    });
    docs.set(`unmatched_payments/ump_gate_${paymentId}`, {
      orderId: "ord_rec_settled",
      razorpayPaymentId: paymentId,
      status: "resolved",
      reason: "capture_decision_stuck",
      receivedAt: "STAFF_ORIGINAL",
      alertDelivery: { state: "delivered", attempts: 1, deliveredAtMs: 1 },
    });
    const alerts = await installRealAlerts();
    try {
      const auto = await recoverStuckCaptureFulfilments();
      // A settled case STANDS DOWN: nothing is confirmed, stamped or re-sent.
      expect(auto.confirmed).toBe(0);
      expect(control.confirmAttempts).toHaveLength(0);
      expect(orderOf("ord_rec_settled").petpoojaOrderId).toBeUndefined();
      const staffCase = caseOf(paymentId);
      expect(staffCase.status).toBe("resolved");
      expect(staffCase.receivedAt).toBe("STAFF_ORIGINAL");
      expect(staffCase.recovered).toBeUndefined();
      expect(alerts.sends).toHaveLength(0);
      expect(control.refundPosts).toHaveLength(0);
      // Holding the row is NOT a recovery failure: the stall counter is left
      // exactly as it was (no extra page, no extra attempt).
      expect(orderOf("ord_rec_settled").captureStall.failedAttempts).toBe(2);
      expect(control.readAfterWriteViolations).toBe(0);
    } finally {
      alerts.restore();
    }
  });
});

// ===========================================================================
// 2. A SETTLED case must STAND DOWN — it is never permission to confirm.
// ===========================================================================
describe("a settled ops case never turns into a confirmation", () => {
  const seedSettled = (orderId: string, status: string) => {
    const paymentId = seedOrder(orderId);
    docs.set(`unmatched_payments/ump_gate_${paymentId}`, {
      eventId: `gate_${paymentId}`,
      orderId,
      razorpayPaymentId: paymentId,
      status,
      reason: "capture_decision_stuck",
      gateState: "fulfillable",
      staffAction: "confirm_or_refund_manually",
      alertDelivery: { state: "delivered", attempts: 2, deliveredAtMs: 1 },
    });
    return paymentId;
  };

  it("a `refunded_externally` case stays unconfirmed across two sweeps", async () => {
    const paymentId = seedSettled("ord_rex", "refunded_externally");
    const alerts = await installRealAlerts();
    let probeCalls = 0;
    __setPaymentsFetchForTests(async (id: string) => {
      probeCalls += 1;
      return {
        id,
        order_id: `rzp_${id}`,
        amount: 10000,
        amount_refunded: 10000,
        refund_status: "full",
        currency: "INR",
        status: "refunded",
        notes: {},
      };
    });
    try {
      const first = await recoverStuckCaptureFulfilments();
      expect(first.confirmed).toBe(0);

      // Second sweep, after the recovery window: the old code probed nothing
      // (staffResolved) and confirmed the refunded order here.
      vi.setSystemTime(new Date(Date.now() + CAPTURE_RECOVERY_AFTER_MS + 1));
      const second = await recoverStuckCaptureFulfilments();

      expect(second.confirmed).toBe(0);
      expect(control.confirmAttempts).toHaveLength(0);
      // No fulfilment / money writes of any kind.
      expect(orderOf("ord_rex").status.code).toBe("PLACED");
      expect(orderOf("ord_rex").petpoojaOrderId).toBeUndefined();
      expect(orderOf("ord_rex").captureFulfillmentState).toBe("fulfillable");
      expect(
        writeLog.filter(
          (w) => w.path === "orders/ord_rex" && (w.data?.petpoojaOrderId || w.data?.status)
        )
      ).toHaveLength(0);
      // Zero refund POSTs: a refunded_externally case is already settled.
      expect(control.refundPosts).toHaveLength(0);
      // Already recorded — no new probe, no new state change.
      expect(probeCalls).toBe(0);
      expect(caseOf(paymentId).status).toBe("refunded_externally");
    } finally {
      alerts.restore();
    }
  });

  for (const settledStatus of ["resolved", "ignored"]) {
    it(`a staff-settled "${settledStatus}" case with a CLEAN gateway still does not confirm`, async () => {
      const paymentId = seedSettled(`ord_${settledStatus}`, settledStatus);
      const alerts = await installRealAlerts();
      try {
        const first = await recoverStuckCaptureFulfilments();
        vi.setSystemTime(new Date(Date.now() + CAPTURE_RECOVERY_AFTER_MS + 1));
        const second = await recoverStuckCaptureFulfilments();

        expect(first.confirmed).toBe(0);
        expect(second.confirmed).toBe(0);
        expect(control.confirmAttempts).toHaveLength(0);
        expect(orderOf(`ord_${settledStatus}`).petpoojaOrderId).toBeUndefined();
        expect(control.refundPosts).toHaveLength(0);
        // The staff decision and its timestamp are never rewritten.
        expect(caseOf(paymentId).status).toBe(settledStatus);
        expect(caseOf(paymentId).receivedAt).toBeUndefined();
      } finally {
        alerts.restore();
      }
    });
  }

  it("the legitimate staff path is preserved: a lifecycle-CONFIRMED order is retired, not re-confirmed", async () => {
    const paymentId = seedSettled("ord_staff_ok", "resolved");
    docs.set("orders/ord_staff_ok", {
      ...orderOf("ord_staff_ok"),
      status: { code: "CONFIRMED", label: "Confirmed", kind: "upcoming", terminal: false },
      petpoojaOrderId: "pos_ord_staff_ok",
    });
    const alerts = await installRealAlerts();
    try {
      const stats = await recoverStuckCaptureFulfilments();
      expect(stats.confirmed).toBe(0);
      expect(control.confirmAttempts).toHaveLength(0);
      expect(orderOf("ord_staff_ok").status.code).toBe("CONFIRMED");
      expect(orderOf("ord_staff_ok").petpoojaOrderId).toBe("pos_ord_staff_ok");
      expect(control.refundPosts).toHaveLength(0);
      expect(alerts.sends).toHaveLength(0);
      expect(caseOf(paymentId).status).toBe("resolved");
    } finally {
      alerts.restore();
    }
  });
});
