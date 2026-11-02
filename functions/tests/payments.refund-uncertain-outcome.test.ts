import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * P1-M — a gateway refund that SUCCEEDS without a usable refund id must not
 * roll back its own accounting.
 *
 * Defect: after the refund POST returns 2xx, `refundResult.id` is written into
 * the order doc, the per-refund ledger, the refund request record and the audit
 * row without a guard. A response with no `id` therefore writes `undefined` —
 * real Firestore rejects that, the transaction rolls back `refundedTotalPaise`,
 * the ledger entry and the monthly-fee release, and the order looks refundable
 * again while the money has already left. A later refund then pays out twice.
 *
 * Required: treat a post-send response with no usable id as an UNCERTAIN
 * outcome — keep the claim, record what is known, require reconciliation, and
 * never roll the accounting back. A retry with the same idempotency key must
 * stay safe (Razorpay replays the original refund).
 */
const { mockDb, docs, control } = vi.hoisted(() => {
  process.env.OTP_HMAC_SECRET = "test_otp_p1m";
  const docs = new Map<string, any>();
  const control = { refundResponse: null as any, refundPosts: [] as any[] };

  const applyWrite = (path: string, data: any, merge?: boolean) => {
    const existing = docs.get(path);
    docs.set(
      path,
      merge && existing && typeof existing === "object" && typeof data === "object"
        ? { ...existing, ...data }
        : { ...data }
    );
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
          const err: any = new Error("ALREADY_EXISTS");
          err.code = 6;
          throw err;
        }
        applyWrite(path, data, false);
      },
      update: async (data: any) => applyWrite(path, data, true),
    };
  };
  const nested = (d: any, f: string) =>
    f.split(".").reduce((o: any, k) => (o == null ? undefined : o[k]), d);

  const mockDb: any = {
    collection: (col: string) => {
      const filters: Array<[string, any]> = [];
      const q: any = {
        where: (f: string, _o: string, v: any) => {
          filters.push([f, v]);
          return q;
        },
        limit: () => q,
        get: async () => {
          const found = [...docs.entries()]
            .filter(([p]) => p.startsWith(`${col}/`))
            .filter(([, d]) => filters.every(([f, v]) => nested(d, f) === v))
            .map(([p, d]) => ({
              id: p.slice(col.length + 1),
              ref: docRef(col, p.slice(col.length + 1)),
              data: () => JSON.parse(JSON.stringify(d)),
            }));
          return { empty: found.length === 0, docs: found };
        },
        doc: (id: string) => docRef(col, id),
        add: async (data: any) => {
          const id = `auto_${docs.size + 1}`;
          applyWrite(`${col}/${id}`, data, false);
          return { id };
        },
      };
      return q;
    },
    runTransaction: vi.fn(async (fn: any) => {
      for (let attempt = 0; attempt < 8; attempt++) {
        const reads = new Map<string, string>();
        const writes: Array<{ path: string; data: any; merge: boolean }> = [];
        const result = await fn({
          get: async (ref: any) => {
            reads.set(ref.path, JSON.stringify(docs.get(ref.path) ?? null));
            return {
              exists: docs.has(ref.path),
              data: () =>
                docs.has(ref.path) ? JSON.parse(JSON.stringify(docs.get(ref.path))) : undefined,
              ref,
            };
          },
          set: (ref: any, data: any, opts?: any) =>
            writes.push({ path: ref.path, data, merge: !!opts?.merge }),
          update: (ref: any, data: any) => writes.push({ path: ref.path, data, merge: true }),
        });
        if ([...reads.entries()].some(([p, v]) => JSON.stringify(docs.get(p) ?? null) !== v)) continue;
        // Real Firestore REJECTS undefined values at commit time.
        for (const w of writes) assertNoUndefined(w.data, w.path);
        for (const w of writes) applyWrite(w.path, w.data, w.merge);
        return result;
      }
      const err: any = new Error("ABORTED");
      err.code = 10;
      throw err;
    }),
  };
  return { mockDb, docs, control };
});

function assertNoUndefined(value: any, path: string): void {
  const walk = (v: any, p: string) => {
    if (v === undefined) {
      const err: any = new Error(`Firestore rejects undefined at ${p}`);
      err.code = "INVALID_ARGUMENT";
      throw err;
    }
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${p}[${i}]`));
    if (v && typeof v === "object" && typeof v.toMillis !== "function") {
      for (const [k, x] of Object.entries(v)) walk(x, `${p}.${k}`);
    }
  };
  walk(value, path);
}

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
    orders: { create: vi.fn(), fetchPayments: vi.fn(async () => ({ items: [] })) },
    payments: { fetch: vi.fn() },
  }),
  getRazorpayKeyId: () => "rzp_test_p1m",
}));

vi.mock("../src/core/errors", async (io) => ({
  ...(await io<any>()),
  captureErrorSnapshot: vi.fn(async () => "snap_1"),
}));

import { autoRefund, __setRefundPostForTests } from "../src/modules/payments/razorpay.service";
import { config } from "../src/config/env";

const ORDER = "ord_p1m";
const PAY = "pay_p1m";

const seed = () => {
  docs.set(`orders/${ORDER}`, {
    id: ORDER,
    customerId: "cust_1",
    branchId: "branch_a",
    payment: { razorpayPaymentId: PAY, capturedAmountPaise: 25000 },
    pricing: { grandTotal: 250 },
    paymentStatus: "completed",
    monthlyFeeHold: {
      monthKey: "2026-11",
      earnedPaise: 25000,
      courierFeePaise: 0,
      holdPaise: 0,
      branchTransferPaise: 25000,
      releasedPaise: 0,
      refundLedgeredPaise: 0,
    },
  });
  docs.set("branch_monthly_fees/branch_a_2026-11", {
    branchId: "branch_a",
    monthKey: "2026-11",
    feePaise: 250000,
    feeCollectedPaise: 0,
    razorpayEarnedPaise: 25000,
    razorpayRefundedPaise: 0,
  });
};

describe("P1-M — a 2xx refund with no usable id must not roll back", () => {
  const prevMock = config.mock.paymentGateway;
  beforeEach(() => {
    docs.clear();
    control.refundPosts = [];
    control.refundResponse = undefined;
    config.mock.paymentGateway = false;
    seed();
    __setRefundPostForTests(async (paymentId, body, key) => {
      control.refundPosts.push({ paymentId, body, key });
      if (control.refundResponse === "throw") throw new Error("socket hang up after send");
      return control.refundResponse;
    });
  });
  afterEach(() => {
    config.mock.paymentGateway = prevMock;
    __setRefundPostForTests(null);
  });

  it("keeps the refunded accounting when the gateway answers 2xx with NO id", async () => {
    control.refundResponse = { status: "processed", amount: 25000 }; // no id

    const err: any = await autoRefund({
      orderId: ORDER,
      razorpayPaymentId: PAY,
      reason: "test",
      refundRequestId: "p1m_req_1",
    }).then(
      (r) => ({ unexpectedSuccess: r }),
      (e) => e
    );

    // The money left, so this is an UNCERTAIN outcome that must be surfaced.
    expect(err.unexpectedSuccess).toBeUndefined();
    expect(err.code).toBe("REFUND_RECONCILIATION_REQUIRED");
    expect(err.statusCode).toBe(409);

    const order = docs.get(`orders/${ORDER}`);
    // Accounting must be KEPT, not rolled back: the customer's money is gone.
    // The status stays at the CLAIM ("refunding") — never promoted to a proven
    // "refunded", which is what would let a second refund look allowed.
    expect(order.refundStatus).toBe("refunding");
    expect(order.refundClaimedAt).toBeDefined(); // claim retained for recovery
    expect(order.refundUncertain).toMatchObject({ attempted: true });
    expect(order.refundUncertain.amountPaise).toBe(25000);
    expect(order.refundUncertain.requestId).toBe("p1m_req_1");
    // NOT recorded as a completed refund id.
    expect(order.refundId).toBeUndefined();
    expect(order.refundedTotalPaise).toBeUndefined();
    // Fee ledger untouched: no refund was proven.
    const ledger = docs.get("branch_monthly_fees/branch_a_2026-11");
    expect(ledger.razorpayRefundedPaise).toBe(0);
    // Ops can find it.
    expect(
      [...docs.keys()].some((k) => k.startsWith("unmatched_payments/ump_refund_uncertain_"))
    ).toBe(true);
  });

  it("parks the uncertain refund for ops with the known facts", async () => {
    control.refundResponse = { status: "processed", amount: 25000 };
    await autoRefund({
      orderId: ORDER,
      razorpayPaymentId: PAY,
      reason: "test",
      refundRequestId: "p1m_req_2",
    }).catch(() => undefined);

    const parks = [...docs.keys()].filter((k) => k.startsWith("unmatched_payments/"));
    expect(parks.length).toBeGreaterThanOrEqual(1);
    const park = docs.get(parks[0]);
    expect(park.razorpayPaymentId).toBe(PAY);
    expect(park.amountPaise ?? park.metadata?.amountPaise).toBe(25000);
  });

  it("a retry with the SAME key does not post a second refund", async () => {
    control.refundResponse = { status: "processed", amount: 25000 };
    await autoRefund({
      orderId: ORDER,
      razorpayPaymentId: PAY,
      reason: "test",
      refundRequestId: "p1m_req_3",
    }).catch(() => undefined);

    const first = control.refundPosts.length;
    // Retry: the retained claim makes it a reconciliation wait, not a new POST.
    const err: any = await autoRefund({
      orderId: ORDER,
      razorpayPaymentId: PAY,
      reason: "test",
      refundRequestId: "p1m_req_3",
    }).then(
      (r) => ({ unexpectedSuccess: r }),
      (e) => e
    );
    expect(err.unexpectedSuccess).toBeUndefined();
    expect(control.refundPosts.length).toBe(first);
    expect(["REFUND_RECONCILIATION_REQUIRED", "REFUND_IN_PROGRESS"]).toContain(err.code);
  });

  it("a normal refund with an id still records everything", async () => {
    control.refundResponse = { id: "rfnd_ok_1", payment_id: PAY, amount: 25000, status: "processed" };
    const res: any = await autoRefund({
      orderId: ORDER,
      razorpayPaymentId: PAY,
      reason: "test",
      refundRequestId: "p1m_req_4",
    });
    expect(res.id).toBe("rfnd_ok_1");
    const order = docs.get(`orders/${ORDER}`);
    expect(order.refundId).toBe("rfnd_ok_1");
    expect(order.refundedTotalPaise).toBe(25000);
    expect(order.refundUncertain).toBeUndefined();
  });
});
