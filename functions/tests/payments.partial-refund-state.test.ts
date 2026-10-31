import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Lane 08 (payments) — partial-refund STATE regression.
//
// Defect: both the refund.processed webhook and the autoRefund post-gateway
// write plainly stamp refundStatus="refunded", and the refund-claim guard in
// razorpay.service.ts then treats that status as TERMINAL. A first PARTIAL
// refund therefore (1) brands a half-refunded order "fully refunded" on the
// board, and (2) 409-blocks the designed remainder refund the cumulative cap
// logic explicitly supports ("refund the remaining Xpa explicitly").
//
// Fixed behavior pinned here:
//  - a partial refund (below the KNOWN capture) records refundStatus=
//    "partially_refunded", never a forward lie to the board;
//  - reaching the capture (webhook ledger OR autoRefund write) records
//    "refunded" — the full-refund truth, exactly at the boundary;
//  - the claim guard refuses a further refund ONLY when the recorded ledger
//    total proves the capture is fully refunded, and keeps the legacy
//    unknown-capture semantics (replay same amount, refuse other amounts).
//
// HONESTY LIMIT: offline, in-process document store — no network, no provider
// SDK call, no secret, no real money. Gateway POSTs are the repo's mock branch.
const { mockDb, savedDocs } = vi.hoisted(() => {
  process.env.OTP_HMAC_SECRET = "test_otp_razorpay_partial_refund";
  const savedDocs: Record<string, any> = {};
  const docRef = (colName: string, docId: string) => ({
    id: docId,
    path: `${colName}/${docId}`,
    get: vi.fn(async () => ({
      exists: !!savedDocs[`${colName}/${docId}`],
      data: () => savedDocs[`${colName}/${docId}`] || {},
    })),
    set: vi.fn(async (data: any, options?: any) => {
      const docPath = `${colName}/${docId}`;
      savedDocs[docPath] =
        options?.merge && savedDocs[docPath] ? { ...savedDocs[docPath], ...data } : data;
    }),
    create: vi.fn(async (data: any) => {
      const docPath = `${colName}/${docId}`;
      if (savedDocs[docPath]) {
        const err: any = new Error("ALREADY_EXISTS: Document already exists");
        err.code = 6;
        throw err;
      }
      savedDocs[docPath] = data;
    }),
    update: vi.fn(async (data: any) => {
      const docPath = `${colName}/${docId}`;
      savedDocs[docPath] = { ...(savedDocs[docPath] || {}), ...data };
    }),
  });
  const mockDb = {
    collection: (colName: string) => ({
      doc: (docId?: string) => docRef(colName, docId || `mock_${Math.random().toString(36).slice(2, 8)}`),
      where: (field: string, op: string, value: any) => ({
        limit: (n: number) => ({
          get: vi.fn(async () => {
            const getPath = (obj: any, path: string) =>
              path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
            const docs = Object.entries(savedDocs)
              .filter(([k, v]) => k.startsWith("orders/") && getPath(v, field) === value)
              .map(([k, v]) => ({
                id: k.split("/")[1],
                ref: docRef(k.split("/")[0], k.split("/")[1]),
                data: () => v,
              }));
            return { empty: docs.length === 0, docs };
          }),
        }),
      }),
    }),
    runTransaction: vi.fn(async (fn: (tx: any) => Promise<any>) =>
      fn({
        get: (ref: any) => ref.get(),
        set: (ref: any, data: any, opts?: any) => ref.set(data, opts),
      })
    ),
  };
  return { mockDb, savedDocs };
});

vi.mock("firebase-admin", () => {
  const FieldValue = {
    serverTimestamp: () => "MOCK_SERVER_TIMESTAMP",
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

import { handleRazorpayWebhook } from "../src/modules/payments/webhookHandler";
import { autoRefund } from "../src/modules/payments/razorpay.service";
import { config } from "../src/config/env";

function mockReqRes(payload: any) {
  const req: any = { headers: {}, body: payload };
  let statusCode = 0;
  let body: any = null;
  const res: any = {
    status: (code: number) => {
      statusCode = code;
      return { json: (obj: any) => void (body = obj) };
    },
  };
  return { req, res, out: () => ({ statusCode, body }) };
}

const refundPayload = (eventId: string, refundId: string, paymentId: string, amountPaise: number) => ({
  id: eventId,
  event: "refund.processed",
  payload: {
    refund: {
      entity: { id: refundId, payment_id: paymentId, amount: amountPaise, currency: "INR" },
    },
  },
});

describe("partial refund state (webhook + claim guard)", () => {
  let prevPg = false;
  let prevPp = false;
  beforeEach(() => {
    for (const key of Object.keys(savedDocs)) delete savedDocs[key];
    prevPg = config.mock.paymentGateway;
    prevPp = config.mock.petpoojaPos;
    config.mock.paymentGateway = true;
    config.mock.petpoojaPos = true;
  });
  afterEach(() => {
    config.mock.paymentGateway = prevPg;
    config.mock.petpoojaPos = prevPp;
  });

  it("refunds to the capture boundary: webhook ledger flips the status to total ≥ capture", async () => {
    savedDocs["orders/order_pr_1"] = {
      id: "order_pr_1",
      paymentStatus: "completed",
      payment: { razorpayPaymentId: "pay_pr_1", status: "completed", capturedAmountPaise: 30000 },
    };

    // £— ₹50 of ₹300: first partial must say partially_refunded, not refunded.
    let call = mockReqRes(refundPayload("evt_pr_1", "rfnd_pr_1", "pay_pr_1", 5000));
    await handleRazorpayWebhook(call.req, call.res);
    expect(call.out().statusCode).toBe(200);
    expect(savedDocs["orders/order_pr_1"]).toMatchObject({
      refundedTotalPaise: 5000,
      refundLedger: { rfnd_pr_1: 5000 },
    });
    expect(savedDocs["orders/order_pr_1"].refundStatus).toBe("partially_refunded");

    // ₹250 more: cumulatively at the ₹300 capture — full-refund truth now.
    call = mockReqRes(refundPayload("evt_pr_2", "rfnd_pr_2", "pay_pr_1", 25000));
    await handleRazorpayWebhook(call.req, call.res);
    expect(call.out().statusCode).toBe(200);
    expect(savedDocs["orders/order_pr_1"]).toMatchObject({
      refundedTotalPaise: 30000,
      refundStatus: "refunded",
    });
  });

  it("reads the capture from the dotted-literal shape too (B4: dotted writers are honored)", async () => {
    savedDocs["orders/order_pr_1d"] = {
      id: "order_pr_1d",
      paymentStatus: "completed",
      payment: { razorpayPaymentId: "pay_pr_1d", status: "completed" },
      // Dotted-literal writer shape (merge-set writers), not the nested map.
      "payment.capturedAmountPaise": 10000,
    };
    const call = mockReqRes(refundPayload("evt_pr_1d", "rfnd_pr_1d", "pay_pr_1d", 5000));
    await handleRazorpayWebhook(call.req, call.res);
    expect(call.out().statusCode).toBe(200);
    // Capture known through the dotted shape: ₹50 of ₹100 is PARTIAL.
    expect(savedDocs["orders/order_pr_1d"].refundStatus).toBe("partially_refunded");
    expect(savedDocs["orders/order_pr_1d"].refundedTotalPaise).toBe(5000);
  });

  it("keeps the legacy refunded stamp when the capture amount is unknown", async () => {    savedDocs["orders/order_pr_1"] = {
      id: "order_pr_1",
      paymentStatus: "completed",
      payment: { razorpayPaymentId: "pay_pr_1", status: "completed" },
    };
    const call = mockReqRes(refundPayload("evt_pr_u1", "rfnd_pr_u1", "pay_pr_1", 5000));
    await handleRazorpayWebhook(call.req, call.res);
    expect(call.out().statusCode).toBe(200);
    // No capture on record means we cannot prove the refund is partial
    // relative to anything — the legacy "refunded" stamp stands.
    expect(savedDocs["orders/order_pr_1"].refundStatus).toBe("refunded");
  });

  it("autoRefund records a partial below the capture as partially_refunded", async () => {
    savedDocs["orders/ord_pr_2"] = {
      payment: { razorpayPaymentId: "pay_pr_2" },
      pricing: { grandTotal: 300 },
    };
    const res: any = await autoRefund({
      orderId: "ord_pr_2",
      razorpayPaymentId: "pay_pr_2",
      amountRupees: 50,
      reason: "item rejection",
    });
    expect(res.status).toBe("processed");
    expect(savedDocs["orders/ord_pr_2"]).toMatchObject({
      refundedTotalPaise: 5000,
      refundStatus: "partially_refunded",
    });
  });

  it("does NOT block the designed remainder refund after a first partial", async () => {
    // Document state EXACTLY as today's webhook stamps it after a ₹50 partial
    // of a ₹300 order — including the too-forward "refunded" status.
    savedDocs["orders/ord_pr_3"] = {
      payment: { razorpayPaymentId: "pay_pr_3" },
      pricing: { grandTotal: 300 },
      refundStatus: "refunded",
      refundId: "rfnd_pr_3a",
      refundAmount: 50,
      refundLedger: { rfnd_pr_3a: 5000 },
      refundedTotalPaise: 5000,
    };
    const second: any = await autoRefund({
      orderId: "ord_pr_3",
      razorpayPaymentId: "pay_pr_3",
      amountRupees: 250,
      reason: "remainder",
    });
    expect(second.status).toBe("processed");
    const order = savedDocs["orders/ord_pr_3"];
    expect(order.refundedTotalPaise).toBe(30000);
    expect(order.refundStatus).toBe("refunded");
    // Each gateway refund id is accounted exactly once.
    expect(order.refundLedger).toMatchObject({ rfnd_pr_3a: 5000 });
    expect(Object.keys(order.refundLedger)).toHaveLength(2);
  });

  it("still refuses a further refund once the capture IS fully refunded (409 ALREADY_REFUNDED)", async () => {
    savedDocs["orders/ord_pr_4"] = {
      payment: { razorpayPaymentId: "pay_pr_4" },
      pricing: { grandTotal: 300 },
      refundStatus: "refunded",
      refundId: "rfnd_pr_4a",
      refundAmount: 300,
      refundLedger: { rfnd_pr_4a: 30000 },
      refundedTotalPaise: 30000,
    };
    await expect(
      autoRefund({ orderId: "ord_pr_4", razorpayPaymentId: "pay_pr_4", amountRupees: 100 })
    ).rejects.toMatchObject({ statusCode: 409, code: "ALREADY_REFUNDED" });
  });

  it("keeps legacy replay semantics for unknown-capture refunds (same amount replays, others refused)", async () => {
    savedDocs["orders/ord_pr_5"] = {
      payment: { razorpayPaymentId: "pay_pr_5" },
      // NO pricing on purpose: an order whose capture paise are unknown keeps
      // the legacy status-only semantics below (replay by amount, refuse the
      // rest). This mirrors pre-ledger production docs.
      // Legacy shape: status says refunded but the ledger/capture cannot prove
      // it — replay-by-amount is still honored below via the documented
      // unknown-capture path.
      refundStatus: "refunded",
      refundId: "rfnd_pr_5a",
      refundAmount: 50,
      refundedTotalPaise: 5000,
    };
    const first: any = await autoRefund({
      orderId: "ord_pr_5",
      razorpayPaymentId: "pay_pr_5",
      amountRupees: 50,
    });
    // The mock gateway always "succeeds", so a passthrough would mint a fresh
    // rfnd id; a replay must return the STORED receipt instead.
    expect(first.id).toBe("rfnd_pr_5a");
    expect(first.reused).toBe(true);

    await expect(
      autoRefund({ orderId: "ord_pr_5", razorpayPaymentId: "pay_pr_5", amountRupees: 100 })
    ).rejects.toMatchObject({ statusCode: 409, code: "ALREADY_REFUNDED" });
  });

  it("does not over-refund: a partial that exceeds the remaining refundable total is refused", async () => {
    savedDocs["orders/ord_pr_6"] = {
      payment: { razorpayPaymentId: "pay_pr_6" },
      pricing: { grandTotal: 300 },
      refundStatus: "partially_refunded",
      refundLedger: { rfnd_pr_6a: 10000 },
      refundedTotalPaise: 10000,
    };
    await expect(
      autoRefund({ orderId: "ord_pr_6", razorpayPaymentId: "pay_pr_6", amountRupees: 250 })
    ).rejects.toMatchObject({ statusCode: 400, code: "REFUND_EXCEEDS_REMAINING" });
  });

  // ── Review finding M1: the cap is LEDGER-authoritative — a scalar total
  // lagging the webhook's ledger must not inflate the refundable remainder. ──
  it("caps against max(total, ledgerSum), not the lagging scalar total alone", async () => {
    savedDocs["orders/ord_pr_7"] = {
      payment: { razorpayPaymentId: "pay_pr_7" },
      pricing: { grandTotal: 300 },
      refundStatus: "partially_refunded",
      refundLedger: { rfnd_pr_7a: 20000 },
      refundedTotalPaise: 10000, // scalar lags the ledger by ₹100
    };
    // Ledger says ₹200 of ₹300 already refunded; the scalar claims ₹100.
    // Requesting ₹150: the scalar cap would allow it (₹100 + ₹150 ≤ ₹300)
    // and over-refund to ₹350 of ₹300 — the ledger-authoritative cap refuses.
    // (₹150 is not a replay: no ledger entry of that amount exists.)
    await expect(
      autoRefund({ orderId: "ord_pr_7", razorpayPaymentId: "pay_pr_7", amountRupees: 150 })
    ).rejects.toMatchObject({ statusCode: 400, code: "REFUND_EXCEEDS_REMAINING" });

    // The true remainder (₹100) still goes through and the total converges.
    const res: any = await autoRefund({
      orderId: "ord_pr_7",
      razorpayPaymentId: "pay_pr_7",
      amountRupees: 100,
    });
    expect(res.status).toBe("processed");
    const order = savedDocs["orders/ord_pr_7"];
    expect(order.refundedTotalPaise).toBe(30000);
    expect(order.refundStatus).toBe("refunded");
    expect(Object.keys(order.refundLedger)).toHaveLength(2);
  });

  // ── Review finding B2: replay identity is ledger-keyed — the (order,
  // amount) refund replays its stored receipt; a DIFFERENT amount is a new
  // refund. Also pins the gateway-echo double-count fix (M2). ──
  it("replays a retry of an earlier partial from the ledger, without a second POST or double count", async () => {
    savedDocs["orders/ord_pr_8"] = {
      payment: { razorpayPaymentId: "pay_pr_8" },
      pricing: { grandTotal: 300 },
      refundStatus: "partially_refunded",
      refundId: "rfnd_pr_8b",
      refundAmount: 100, // last scalar is the SECOND refund, not the retry target
      refundLedger: { rfnd_pr_8a: 5000, rfnd_pr_8b: 10000 },
      refundedTotalPaise: 15000,
    };
    // Retrying the ORIGINAL ₹50 refund must return rfnd_pr_8a (its ledger
    // amount matches), never POST a fresh refund that re-adds ₹50.
    const retried: any = await autoRefund({
      orderId: "ord_pr_8",
      razorpayPaymentId: "pay_pr_8",
      amountRupees: 50,
    });
    expect(retried.id).toBe("rfnd_pr_8a");
    expect(retried.reused).toBe(true);
    const order = savedDocs["orders/ord_pr_8"];
    expect(order.refundedTotalPaise).toBe(15000);
    expect(Object.keys(order.refundLedger)).toHaveLength(2);
  });

  // ── Review finding M4: a full-request doc (refundAmount === null) is
  // terminal even when the gateway echo trails the capture — refunding may
  // not restart after a genuine full refund. ──
  it("treats a full-request refunded doc as terminal even if the echoed total is below the capture", async () => {
    savedDocs["orders/ord_pr_9"] = {
      payment: { razorpayPaymentId: "pay_pr_9" },
      pricing: { grandTotal: 300 },
      refundStatus: "refunded",
      refundId: "rfnd_pr_9a",
      refundAmount: null, // full-request shape, echo (mock 10000) < capture 30000
      refundLedger: { rfnd_pr_9a: 10000 },
      refundedTotalPaise: 10000,
    };
    await expect(
      autoRefund({ orderId: "ord_pr_9", razorpayPaymentId: "pay_pr_9", amountRupees: 50 })
    ).rejects.toMatchObject({ statusCode: 409, code: "ALREADY_REFUNDED" });
    await expect(
      autoRefund({ orderId: "ord_pr_9", razorpayPaymentId: "pay_pr_9" })
    ).rejects.toMatchObject({ statusCode: 409, code: "ALREADY_REFUNDED" });
  });

  // ── Review finding B1: payment.capturedAmountPaise is the capture AUTHORITY
  // (a discounted payable captures less than the priced total). ──
  it("caps partial refunds against the live capture, not the priced total", async () => {
    savedDocs["orders/ord_pr_10"] = {
      payment: { razorpayPaymentId: "pay_pr_10", capturedAmountPaise: 30000 },
      pricing: { grandTotal: 500 }, // priced higher than the actual capture
    };
    // ₹350 exceeds the ₹300 CAPTURE but is under the ₹500 price: the capture
    // authority must refuse — the gateway holds only ₹300.
    await expect(
      autoRefund({ orderId: "ord_pr_10", razorpayPaymentId: "pay_pr_10", amountRupees: 350 })
    ).rejects.toMatchObject({ statusCode: 400, code: "REFUND_EXCEEDS_REMAINING" });

    // Up to the true capture is fine, and completion flips the status there.
    const res: any = await autoRefund({
      orderId: "ord_pr_10",
      razorpayPaymentId: "pay_pr_10",
      amountRupees: 300,
    });
    expect(res.status).toBe("processed");
    expect(savedDocs["orders/ord_pr_10"].refundStatus).toBe("refunded");
  });

  // ── Review finding B6: a second partial on an UNKNOWN-capture doc cannot
  // be bounded — fail closed instead of refunding blindly. ──
  it("fails closed on a second partial when the capture amount is unknown", async () => {
    savedDocs["orders/ord_pr_11"] = {
      payment: { razorpayPaymentId: "pay_pr_11" },
      // no pricing, no captured stamp — capture unknown
      refundStatus: "partially_refunded",
      refundId: "rfnd_pr_11a",
      refundLedger: { rfnd_pr_11a: 5000 },
      refundedTotalPaise: 5000,
    };
    await expect(
      autoRefund({ orderId: "ord_pr_11", razorpayPaymentId: "pay_pr_11", amountRupees: 30 })
    ).rejects.toMatchObject({ statusCode: 409, code: "REFUND_CAPTURE_UNKNOWN" });
  });
});
