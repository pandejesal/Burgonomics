import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * C11 / A1-payments findings 4 and 5.
 *
 * Finding 4 (High) — `PAYMENT_NOT_CAPTURED` stamps
 * `paymentStatus: "awaiting_capture"`, and NOTHING ever reads that state again:
 *   • `isUnsafeToExpire` treats it as "money may be moving", so the abandoned
 *     -unpaid sweep can never cancel the order;
 *   • no job, alert or operator action can resolve it, so the order sits PLACED
 *     for ever (visible on the Partner KDS) and the authorization hold on the
 *     customer's card is never voided by us.
 *
 * Contract pinned here:
 *   1. once the gateway PROVES the hold is gone (failed / created / cancelled),
 *      the marker is released, the decision is audited, and the order becomes
 *      expirable again (proved with the real payment-gate predicates);
 *   2. while the gateway still reports `authorized`, the order STAYS blocked
 *      (money is genuinely reserved) and ops gets a visible park + alert;
 *   3. an unreadable gateway is an UNKNOWN: nothing is written, the order stays
 *      blocked, and the next tick retries.
 *
 * Finding 5 (Medium) — the refund `reason` is copied verbatim into the gateway
 * `notes`. Razorpay rejects any notes VALUE longer than 512 characters with
 * `400 Notes validation failed`, and a 4xx is classified as a PROVEN rejection,
 * so every retry re-sends the same too-long body and fails again.
 *
 * Contract pinned here:
 *   4. the value that reaches the gateway is never longer than 512 characters
 *      (and still carries the order binding);
 *   5. the FULL text is preserved on our own records (request + audit row), so
 *      nothing an operator typed is lost.
 *
 * NO NETWORK: the gateway fetch/POST are the module seams; every amount is
 * test data.
 * HONESTY LIMIT: in-process datastore model; it proves the sweep's decisions and
 * the stored shapes, not real Firebase cross-region behaviour.
 */
const { mockDb, docs, control } = vi.hoisted(() => {
  process.env.OTP_HMAC_SECRET = "test_otp_c11_awaiting_capture";

  const docs = new Map<string, any>();
  const control = {
    snapshots: [] as any[],
    refundPosts: [] as Array<{ paymentId: string; body: any; key: string }>,
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
          const err: any = new Error(
            "FAILED_PRECONDITION: Firestore transactions require all reads before all writes"
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

import {
  autoRefund,
  computeGatewayRefundKey,
  refundRequestDocId,
  __setRefundPostForTests,
} from "../src/modules/payments/razorpay.service";
import {
  isAbandonedUnpaidOnlineOrder,
  isUnsafeToExpire,
} from "../src/modules/orders/paymentGate";
import { config } from "../src/config/env";

/**
 * The sweep module itself is resolved LAZILY and defensively, so the SAME test
 * bytes can run against the unfixed base: there the module does not exist and
 * each case fails on its own first assertion (`expected 'undefined' to be
 * 'function'`) instead of dying in module resolution with zero assertions
 * executed.
 */
let sweepModuleCache: any;

async function loadSweepModule(): Promise<any> {
  if (sweepModuleCache !== undefined) return sweepModuleCache;
  try {
    sweepModuleCache = await import("../src/modules/payments/awaitingCaptureSweep");
  } catch {
    sweepModuleCache = null;
  }
  return sweepModuleCache;
}

const oldIso = new Date(Date.now() - 35 * 60_000).toISOString();

/** The exact shape `assertLivePaymentMatchesOrder` leaves behind. */
function seedAwaitingCapture(orderId: string, paymentId: string, over: Record<string, any> = {}) {
  docs.set(`orders/${orderId}`, {
    id: orderId,
    createdAt: oldIso,
    placedAt: oldIso,
    branchId: "branch_c11",
    customerId: "cust_c11",
    paymentMethod: "online",
    pricing: { grandTotal: 250 },
    status: { code: "PLACED", label: "Order placed", kind: "upcoming", terminal: false },
    paymentStatus: "awaiting_capture",
    "payment.status": "awaiting_capture",
    payment: {
      method: "online",
      status: "awaiting_capture",
      awaitingCapturePaymentId: paymentId,
      awaitingCaptureSince: Date.now() - 35 * 60_000,
    },
    ...over,
  });
  return paymentId;
}

const orderOf = (orderId: string) => docs.get(`orders/${orderId}`);

let prevMock = true;

beforeEach(() => {
  docs.clear();
  control.snapshots = [];
  control.refundPosts = [];
  prevMock = config.mock.paymentGateway;
  config.mock.paymentGateway = false;
  __setRefundPostForTests(null);
});

afterEach(() => {
  // Reset the gateway seam on the CACHED module (it may never have loaded on the
  // base tree, where the module does not exist).
  sweepModuleCache?.__setAwaitingCaptureFetchForTests?.(null);
  __setRefundPostForTests(null);
  config.mock.paymentGateway = prevMock;
});

describe("C11 awaiting_capture sweep resolves the parked hold", () => {
  it("ships the sweep at all (the parked state has a reader)", async () => {
    const mod = await loadSweepModule();
    expect(typeof mod?.sweepAwaitingCaptureOrders).toBe("function");
  });

  it("releases the marker once the gateway proves the hold is gone, and expiry works again", async () => {
    seedAwaitingCapture("ord_aw_gone", "pay_aw_gone");
    // The blocked state, proved with the real predicates the sweeps use.
    expect(isUnsafeToExpire(orderOf("ord_aw_gone"))).toBe(true);
    expect(isAbandonedUnpaidOnlineOrder(orderOf("ord_aw_gone"))).toBe(false);

    const mod = await loadSweepModule();
    expect(typeof mod?.__setAwaitingCaptureFetchForTests).toBe("function");
    mod.__setAwaitingCaptureFetchForTests(async (paymentId: string) => ({
      id: paymentId,
      order_id: "rzp_aw_gone",
      amount: 25000,
      currency: "INR",
      status: "failed",
      error_description: "Customer's bank declined the authorization",
    }));
    expect(typeof mod?.sweepAwaitingCaptureOrders).toBe("function");

    const stats = await mod.sweepAwaitingCaptureOrders();

    expect(stats.resolved).toBe(1);
    const order = orderOf("ord_aw_gone");
    // The blocking marker is gone…
    expect(String(order.paymentStatus || "")).not.toBe("awaiting_capture");
    expect(String(order.payment?.status || "")).not.toBe("awaiting_capture");
    // …the decision is recorded with the gateway's own reason…
    expect(order.awaitingCaptureResolution).toMatchObject({
      resolution: "hold_gone",
      gatewayStatus: "failed",
    });
    // …and the order is expirable again, which it was not before.
    expect(isUnsafeToExpire(order)).toBe(false);
    expect(isAbandonedUnpaidOnlineOrder(order)).toBe(true);
  });

  it("keeps the block while the gateway still reports authorized, and pages ops", async () => {
    seedAwaitingCapture("ord_aw_live", "pay_aw_live");
    const mod = await loadSweepModule();
    expect(typeof mod?.__setAwaitingCaptureFetchForTests).toBe("function");
    mod.__setAwaitingCaptureFetchForTests(async (paymentId: string) => ({
      id: paymentId,
      order_id: "rzp_aw_live",
      amount: 25000,
      currency: "INR",
      status: "authorized",
    }));
    expect(typeof mod?.sweepAwaitingCaptureOrders).toBe("function");

    const stats = await mod.sweepAwaitingCaptureOrders();

    expect(stats.stillAuthorized).toBe(1);
    const order = orderOf("ord_aw_live");
    // Money IS reserved: the block must survive.
    expect(order.paymentStatus).toBe("awaiting_capture");
    expect(isUnsafeToExpire(order)).toBe(true);
    // The order is visibly parked for a human, not just silently blocked.
    const park = docs.get("unmatched_payments/ump_awaiting_ord_aw_live");
    expect(park).toMatchObject({ status: "needs_review" });
    expect(
      control.snapshots.some(
        (s) => s.severity === "high" && String(s.message).includes("ord_aw_live")
      )
    ).toBe(true);
    // The check is stamped so a hold that never resolves is visible over time.
    expect(typeof order.awaitingCaptureCheckedAt).toBe("number");
  });

  it("an unreadable gateway is an unknown: nothing is written and the block stays", async () => {
    seedAwaitingCapture("ord_aw_unknown", "pay_aw_unknown");
    const mod = await loadSweepModule();
    expect(typeof mod?.__setAwaitingCaptureFetchForTests).toBe("function");
    mod.__setAwaitingCaptureFetchForTests(async () => {
      throw new Error("gateway timeout");
    });
    expect(typeof mod?.sweepAwaitingCaptureOrders).toBe("function");

    const stats = await mod.sweepAwaitingCaptureOrders();

    expect(stats.unknown).toBe(1);
    const order = orderOf("ord_aw_unknown");
    expect(order.paymentStatus).toBe("awaiting_capture");
    expect(order.awaitingCaptureResolution).toBeUndefined();
    expect(isUnsafeToExpire(order)).toBe(true);
    expect(
      control.snapshots.some((s) => s.severity === "medium" && String(s.message).includes("ord_aw_unknown"))
    ).toBe(true);
  });
});

describe("C11 refund notes never exceed the gateway's 512-character limit", () => {
  const LONG_REASON = `Customer complaint: ${"rider was late and the packaging was damaged. ".repeat(25)}phone 9812345678`;

  it("clamps the gateway notes value while keeping the full text on our records", async () => {
    expect(LONG_REASON.length).toBeGreaterThan(900);
    docs.set("orders/ord_c11_long", {
      id: "ord_c11_long",
      branchId: "branch_c11",
      customerId: "cust_c11",
      paymentStatus: "completed",
      payment: {
        status: "completed",
        razorpayPaymentId: "pay_c11_long",
        capturedAmountPaise: 50000,
      },
      pricing: { grandTotal: 500 },
    });
    __setRefundPostForTests(async (paymentId: string, body: any, key: string) => {
      control.refundPosts.push({ paymentId, body, key });
      return {
        id: "rfnd_c11_long",
        payment_id: paymentId,
        amount: body.amount ?? 50000,
        status: "pending",
      };
    });

    await autoRefund({
      orderId: "ord_c11_long",
      razorpayPaymentId: "pay_c11_long",
      amountRupees: 100,
      reason: LONG_REASON,
      refundRequestId: "refundreq_c11_long",
    });

    expect(control.refundPosts).toHaveLength(1);
    const notes = control.refundPosts[0].body.notes;
    expect(typeof notes.orderId).toBe("string");
    expect(notes.orderId).toBe("ord_c11_long");
    // Razorpay rejects a notes VALUE over 512 characters.
    expect(typeof notes.reason).toBe("string");
    expect(notes.reason.length).toBeLessThanOrEqual(512);
    expect(notes.reason.length).toBeGreaterThan(0);

    // Nothing the operator typed is lost: the SERVER-ONLY request record keeps
    // it in full. `payment_refund_requests` is denied to every client by
    // firestore.rules, which is exactly why the full text lives there and not in
    // a brand-readable collection (C11 finding 6).
    const request = docs.get(
      `payment_refund_requests/${refundRequestDocId("ord_c11_long", "pay_c11_long", "refundreq_c11_long")}`
    );
    expect(request).toBeTruthy();
    expect(request.reason).toBe(LONG_REASON);
  });

  it("the idempotency key is still bound to this exact request identity", async () => {
    docs.set("orders/ord_c11_key", {
      id: "ord_c11_key",
      branchId: "branch_c11",
      paymentStatus: "completed",
      payment: {
        status: "completed",
        razorpayPaymentId: "pay_c11_key",
        capturedAmountPaise: 50000,
      },
      pricing: { grandTotal: 500 },
    });
    __setRefundPostForTests(async (paymentId: string, body: any, key: string) => {
      control.refundPosts.push({ paymentId, body, key });
      return { id: "rfnd_c11_key", payment_id: paymentId, amount: body.amount ?? 50000, status: "pending" };
    });

    await autoRefund({
      orderId: "ord_c11_key",
      razorpayPaymentId: "pay_c11_key",
      reason: LONG_REASON,
      refundRequestId: "refundreq_c11_key",
    });

    expect(control.refundPosts[0].key).toBe(
      computeGatewayRefundKey("ord_c11_key", "pay_c11_key", "refundreq_c11_key")
    );
  });
});
