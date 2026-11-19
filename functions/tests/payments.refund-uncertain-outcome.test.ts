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

import {
  autoRefund,
  __setRefundPostForTests,
  computeGatewayRefundKey,
  refundRequestDocId,
} from "../src/modules/payments/razorpay.service";
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

/**
 * F23 — a gateway HTTP 409 on the refund POST is NOT a rejection.
 *
 * Razorpay's idempotent-refund contract (docs/api/refunds/normal-refunds-idempotent,
 * lines 20-23 and 254-257): a POST reusing an idempotency key for a refund that is
 * STILL IN PROGRESS answers 409, and the caller must retry with the ORIGINAL key
 * and body. Lines 246-249 return 409 for "different params, already processed" —
 * also an unresolved (not safe-to-walk) outcome.
 *
 * Defect: `classifyRefundFailure` treated every 4xx as a definite rejection, so a
 * 409 released `refundActiveClaim` / `refundClaimedAt`. A second operator with a
 * NEW request id could then take a fresh claim and POST a second partial refund
 * while the first one was still in flight at the gateway.
 *
 * Required: 409 keeps the outstanding claim and the original gateway key, and
 * reports REFUND_RECONCILIATION_REQUIRED. A same-key retry replays the identical
 * key/body (one ledger row); a different-id request is refused with zero POSTs
 * until the first identity settles.
 */
describe("F23 — a gateway 409 in-flight is uncertainty, not a rejection", () => {
  const prevMock = config.mock.paymentGateway;
  const A = "f23_req_alpha";
  const B = "f23_req_bravo";
  const D = "f23_req_delta";
  const C = "f23_req_charlie";

  beforeEach(() => {
    docs.clear();
    control.refundPosts = [];
    config.mock.paymentGateway = false;
    seed();
  });
  afterEach(() => {
    config.mock.paymentGateway = prevMock;
    __setRefundPostForTests(null);
  });

  const clone = (v: any) => JSON.parse(JSON.stringify(v));

  /** 20 000pa of a 25 000pa capture: a PARTIAL, so a remainder stays possible. */
  const PARTIAL_RUPEES = 200;

  it("RED/GREEN core: A hits 409 → B (new id) must be refused with ZERO extra POST; A's claim survives", async () => {
    const seen: Array<{ paymentId: string; body: any; key: string }> = [];
    let mode: "inflight409" | "accept" = "inflight409";
    __setRefundPostForTests(async (paymentId, body, key) => {
      seen.push({ paymentId, body: clone(body), key });
      if (mode === "inflight409") {
        const err: any = new Error(
          "A refund with the same idempotency key is already in progress"
        );
        err.statusCode = 409;
        err.gatewayStatus = 409;
        throw err;
      }
      return { id: "rfnd_f23_settled", payment_id: PAY, amount: 20000, status: "processed" };
    });

    // 1. A attempts: the gateway answers 409 (its own in-flight refund).
    const aErr: any = await autoRefund({
      orderId: ORDER,
      razorpayPaymentId: PAY,
      amountRupees: PARTIAL_RUPEES,
      reason: "F23 partial A",
      refundRequestId: A,
    }).then((r) => ({ unexpected: r }), (e) => e);
    expect(aErr.unexpected).toBeUndefined();
    expect(aErr.code).toBe("REFUND_RECONCILIATION_REQUIRED");
    expect(aErr.statusCode).toBe(409);
    expect(seen).toHaveLength(1);
    const aKey = seen[0].key;
    const aBody = clone(seen[0].body);

    // The unresolved claim + original gateway key are STILL on the order:
    // that identity is the only thing stopping a different operator.
    const afterA = docs.get(`orders/${ORDER}`);
    expect(afterA.refundActiveClaim).toMatchObject({
      requestId: A,
      gatewayKey: aKey,
      requestedPaise: 20000,
    });
    expect(afterA.refundClaimedAt).toBeGreaterThan(0);
    expect(afterA.refundClaimedKey).toBe(aKey);
    // No money was claimed as returned.
    expect(afterA.refundLedger ?? {}).toEqual({});
    expect(afterA.refundedTotalPaise).toBeUndefined();

    // 2. Operator B, DIFFERENT request id, same amount: must be refused
    //    locally with zero additional POSTs while A is unresolved.
    const bErr: any = await autoRefund({
      orderId: ORDER,
      razorpayPaymentId: PAY,
      amountRupees: PARTIAL_RUPEES,
      reason: "F23 partial B",
      refundRequestId: B,
    }).then((r) => ({ unexpected: r }), (e) => e);
    expect(bErr.unexpected).toBeUndefined();
    expect(bErr.statusCode).toBe(409);
    expect(["REFUND_IN_PROGRESS", "REFUND_RECONCILIATION_REQUIRED"]).toContain(bErr.code);
    expect(seen).toHaveLength(1); // ZERO second refund POST

    // The claim is still A's.
    const afterB = docs.get(`orders/${ORDER}`);
    expect(afterB.refundActiveClaim.requestId).toBe(A);
    expect(afterB.refundActiveClaim.gatewayKey).toBe(aKey);

    // 3. A's same-key retry: the gateway now accepts. It MUST send the identical
    //    idempotency key and body (Razorpay replays the original refund).
    mode = "accept";
    const ok: any = await autoRefund({
      orderId: ORDER,
      razorpayPaymentId: PAY,
      amountRupees: PARTIAL_RUPEES,
      reason: "F23 partial A",
      refundRequestId: A,
    });
    expect(ok.id).toBe("rfnd_f23_settled");
    const retry = seen[seen.length - 1];
    expect(seen).toHaveLength(2);
    expect(retry.key).toBe(aKey);
    expect(retry.body).toEqual(aBody);

    // ONE ledger row for one refund; the total matches that row.
    const settled = docs.get(`orders/${ORDER}`);
    expect(Object.keys(settled.refundLedger)).toEqual(["rfnd_f23_settled"]);
    expect(settled.refundLedger["rfnd_f23_settled"]).toBe(20000);
    expect(settled.refundedTotalPaise).toBe(20000);
    // The claim is retired (the harness sees FieldValue.delete() as a sentinel,
    // exactly as the existing suites do — assert the absence of an active lease,
    // not a literal undefined).
    expect(settled.refundActiveClaim).not.toMatchObject({ requestId: A });
  });

  it("a legitimate remainder refund proceeds once the first identity settles", async () => {
    __setRefundPostForTests(async () => {
      const err: any = new Error("A refund with the same idempotency key is already in progress");
      err.statusCode = 409;
      throw err;
    });

    await autoRefund({
      orderId: ORDER,
      razorpayPaymentId: PAY,
      amountRupees: PARTIAL_RUPEES,
      reason: "F23 partial A",
      refundRequestId: A,
    }).catch((e) => e);

    // Authoritative settlement (what the refund.processed webhook writes):
    // the first identity's money is now in the ledger and its lane is free.
    const doc = docs.get(`orders/${ORDER}`);
    docs.set(`orders/${ORDER}`, {
      ...doc,
      refundStatus: "partially_refunded",
      refundLedger: { rfnd_f23_first: 20000 },
      refundedTotalPaise: 20000,
      refundActiveClaim: null,
      refundClaimedAt: null,
    });

    __setRefundPostForTests(async () => ({
      id: "rfnd_f23_remainder",
      payment_id: PAY,
      amount: 5000,
      status: "processed",
    }));
    const rem: any = await autoRefund({
      orderId: ORDER,
      razorpayPaymentId: PAY,
      amountRupees: 50,
      reason: "F23 remainder",
      refundRequestId: D,
    });
    expect(rem.id).toBe("rfnd_f23_remainder");
    const after = docs.get(`orders/${ORDER}`);
    expect(after.refundLedger["rfnd_f23_remainder"]).toBe(5000);
    expect(after.refundedTotalPaise).toBe(25000);
  });

  it("a genuine 400 validation rejection still releases the claim for a later distinct intent", async () => {
    const seen: string[] = [];
    let mode: "bad400" | "accept" = "bad400";
    __setRefundPostForTests(async (_p, _b, key) => {
      seen.push(key);
      if (mode === "bad400") {
        const err: any = new Error("The amount must be at least 1");
        err.statusCode = 400;
        throw err;
      }
      return { id: "rfnd_f23_after400", payment_id: PAY, amount: 10000, status: "processed" };
    });

    const aErr: any = await autoRefund({
      orderId: ORDER,
      razorpayPaymentId: PAY,
      amountRupees: 100,
      reason: "F23 400 A",
      refundRequestId: A,
    }).then((r) => ({ unexpected: r }), (e) => e);
    expect(aErr.unexpected).toBeUndefined();
    expect(aErr.code).toBe("REFUND_GATEWAY_FAILED");
    expect(aErr.statusCode).toBe(502);
    // A refusal PROVED no money moved: the lease is released (the harness models
    // FieldValue.delete() as a sentinel, so assert "no active lease remains").
    const afterA = docs.get(`orders/${ORDER}`);
    expect(afterA.refundActiveClaim).not.toMatchObject({ requestId: A });
    expect(afterA.refundClaimedAt == null || typeof afterA.refundClaimedAt !== "number").toBe(true);

    mode = "accept";
    const ok: any = await autoRefund({
      orderId: ORDER,
      razorpayPaymentId: PAY,
      amountRupees: 100,
      reason: "F23 400 B",
      refundRequestId: B,
    });
    expect(ok.id).toBe("rfnd_f23_after400");
    expect(seen).toHaveLength(2);
  });

  it("a KNOWN accepted refund id still replays locally with zero POSTs (unchanged)", async () => {
    const seen: number[] = [];
    __setRefundPostForTests(async () => {
      seen.push(1);
      throw new Error("must not post");
    });

    // An accepted-but-unsettled identity already recorded for request C.
    docs.set(`payment_refund_requests/${refundRequestDocId(ORDER, PAY, C)}`, {
      orderId: ORDER,
      paymentId: PAY,
      refundRequestId: C,
      requestedPaise: 12000,
      reason: "F23 known pending",
      status: "pending",
      refundId: "rfnd_f23_known",
      gatewayKey: computeGatewayRefundKey(ORDER, PAY, C),
      claimedAt: Date.now(),
    });

    const res: any = await autoRefund({
      orderId: ORDER,
      razorpayPaymentId: PAY,
      amountRupees: 120,
      reason: "F23 known pending",
      refundRequestId: C,
    });
    expect(res).toMatchObject({ id: "rfnd_f23_known", status: "pending", reused: true });
    expect(seen).toHaveLength(0);
  });
});


