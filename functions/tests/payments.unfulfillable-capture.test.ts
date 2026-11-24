import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * P1-I (capture side) — a capture that can no longer be FULFILLED must be
 * refunded through the SAME automatic path, and must never be confirmed.
 *
 * Sequence: intent priced -> item 86'd -> customer pays anyway (the gateway
 * order was still open) -> verifyPayment runs. If we confirmed, the order would
 * be paid AND the KOT would ring for food the kitchen cannot cook.
 */
const { mockDb, docs, control, snapshots } = vi.hoisted(() => {
  process.env.OTP_HMAC_SECRET = "test_otp_p1i_capture";
  const docs = new Map<string, any>();
  const snapshots: any[] = [];
  const control = { refundPosts: [] as any[], refundMode: "ok" as "ok" | "fail" };

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
  const nested = (d: any, f: string | { documentId: boolean }) =>
    typeof f === "string"
      ? f.split(".").reduce((o: any, k) => (o == null ? undefined : o[k]), d)
      : d.id;

  const mockDb: any = {
    collection: (col: string) => {
      const filters: Array<[string, string, any]> = [];
      let cap = Infinity;
      let orderField = "";
      let cursor = "";
      const q: any = {
        where: (f: string, op: string, v: any) => {
          filters.push([f, op, v]);
          return q;
        },
        orderBy: (f: string) => { orderField = f; return q; },
        limit: (n: number) => { cap = n; return q; },
        startAfter: (d: any) => { cursor = d.ref?.path ?? d.id ?? ""; return q; },
        add: async (data: any) => applyWrite(`${col}/auto_${docs.size}`, data, false),
        get: async () => {
          const found = [...docs.entries()]
            .filter(([p]) => p.startsWith(`${col}/`) && (!cursor || p > cursor))
            .filter(([, d]) => filters.every(([f, op, v]) => {
              const actual = nested(d, f);
              return op === "==" ? actual === v : op === ">=" ? actual >= v : op === "<" ? actual < v : false;
            }))
            .sort(([a], [b]) => orderField ? (nested(docs.get(a), orderField) < nested(docs.get(b), orderField) ? -1 : 1) : a.localeCompare(b))
            .slice(0, cap)
            .map(([p, d]) => ({
              id: p.slice(col.length + 1),
              ref: docRef(col, p.slice(col.length + 1)),
              data: () => JSON.parse(JSON.stringify(d)),
            }));
          return { empty: found.length === 0, docs: found };
        },
        doc: (id: string) => docRef(col, id),
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
        for (const w of writes) applyWrite(w.path, w.data, w.merge);
        return result;
      }
      const err: any = new Error("ABORTED");
      err.code = 10;
      throw err;
    }),
  };
  return { mockDb, docs, control, snapshots };
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
  f.FieldPath = class FieldPath {
    static documentId() { return { documentId: true }; }
  };
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
    orders: { create: vi.fn(async () => ({ id: "order_unused" })), fetchPayments: vi.fn(async () => ({ items: [] })) },
    payments: { fetch: vi.fn(async () => ({ status: "captured", amount: 50000 })) },
    refunds: { create: vi.fn() },
  }),
  getRazorpayKeyId: () => "rzp_test_p1i_c",
}));

vi.mock("../src/core/errors", async (io) => ({
  ...(await io<any>()),
  captureErrorSnapshot: vi.fn(async (s: any) => {
    snapshots.push(s);
    return "snap_1";
  }),
}));

import {
  verifyPayment,
  __setPaymentsFetchForTests,
  __setRefundPostForTests,
} from "../src/modules/payments/razorpay.service";
import { computeHmacSha256 } from "../src/core/security";
import { generateSettlementStatement } from "../src/modules/settlements/settlementService";
import { CAPTURE_RECOVERY_AFTER_MS } from "../src/modules/payments/captureFulfillment";
import { config } from "../src/config/env";

const SECRET = "p1i_capture_secret";
const GW = "order_gw_p1i";
const sign = () => computeHmacSha256(`${GW}|pay_p1i`, SECRET);

const seed = (inStock: boolean) => {
  docs.set("branches/branch_a", {
    id: "branch_a",
    isOpen: true,
    pricing: { packagingFee: 0, deliveryFee: 0, taxRate: 0 },
    monthlyFee: "0",
  });
  docs.set("products/p1", { id: "p1", name: "Burger", price: 500, inStock, customizations: [] });
  docs.set("orders/ord_p1i", {
    id: "ord_p1i",
    customerId: "cust_1",
    userId: "cust_1",
    branchId: "branch_a",
    orderType: "takeaway",
    fulfillmentType: "takeaway",
    items: [
      { id: "p1", productId: "p1", name: "Burger", price: 500, unitPrice: 500, quantity: 1 },
    ],
    pricing: { grandTotal: 500, split: { branchTransferPaise: 0 } },
    payment: { method: "online", status: "pending" },
    paymentStatus: "pending",
    routeTransferStatus: "not_required",
    status: { code: "PLACED", label: "Order placed", kind: "upcoming", terminal: false },
    createdAt: new Date().toISOString(),
  });
  docs.set("payment_intents/intent_p1i", {
    razorpayOrderId: GW,
    orderId: "ord_p1i",
    amountPaise: 50000,
    branchId: "branch_a",
    customerId: "cust_1",
    createdAtMs: Date.now(),
    expiresAtMs: Date.now() + 60_000,
  });
};

describe("P1-I capture side — an unfulfillable capture is refunded, never confirmed", () => {
  const prevMock = config.mock.paymentGateway;
  const prevSecret = config.razorpay.keySecret;
  beforeEach(() => {
    docs.clear();
    snapshots.length = 0;
    control.refundPosts = [];
    control.refundMode = "ok";
    config.mock.paymentGateway = false;
    config.razorpay.keySecret = SECRET;
    __setPaymentsFetchForTests(async () => ({
      id: "pay_p1i",
      order_id: GW,
      amount: 50000,
      currency: "INR",
      status: "captured",
      notes: { orderId: "ord_p1i" },
    }));
    __setRefundPostForTests(async (paymentId, body, key) => {
      if (control.refundMode === "fail") throw new Error("gateway refund exploded");
      control.refundPosts.push({ paymentId, body, key });
      return { id: `rfnd_unful_${paymentId}`, payment_id: paymentId, amount: body.amount ?? 50000, status: "processed" };
    });
    // The refund seam is module-global: it is re-installed per test here and
    // cleared in afterEach so a neighbouring suite's stub can never leak in.
  });
  afterEach(() => {
    config.mock.paymentGateway = prevMock;
    config.razorpay.keySecret = prevSecret;
    __setPaymentsFetchForTests(null);
    __setRefundPostForTests(null);
  });

  it("interleaved: paid AFTER the item was 86'd — full refund, order NOT confirmed, no KOT", async () => {
    seed(false);
    const err: any = await verifyPayment(
      { orderId: "ord_p1i", razorpayOrderId: GW, razorpayPaymentId: "pay_p1i", razorpaySignature: sign() },
      { uid: "cust_1" }
    ).then(
      (r) => ({ unexpectedSuccess: r }),
      (e) => e
    );

    expect(err.unexpectedSuccess).toBeUndefined();
    expect(err.code).toBe("ORDER_ITEM_UNAVAILABLE_REFUNDED");
    expect(err.statusCode).toBe(409);

    // Money came back through the ONE refund path.
    expect(control.refundPosts).toHaveLength(1);
    expect(control.refundPosts[0].paymentId).toBe("pay_p1i");

    const order = docs.get("orders/ord_p1i");
    expect(order.refundStatus).toBe("refunded");
    // Never CONFIRMED, never rung. (`paymentChannel` is written by the refund
    // accounting itself — money did move — so it is not the confirm marker
    // here; the status code and the KOT marker are.)
    expect(order.status).toMatchObject({ code: "PLACED" });
    expect(order.petpoojaOrderId).toBeUndefined();
    expect(order.deliveryOtpHash).toBeUndefined();
  });

  it("stays refunded and idempotent when the capture is replayed", async () => {
    seed(false);
    await verifyPayment(
      { orderId: "ord_p1i", razorpayOrderId: GW, razorpayPaymentId: "pay_p1i", razorpaySignature: sign() },
      { uid: "cust_1" }
    ).catch(() => undefined);
    const firstPosts = control.refundPosts.length;

    await verifyPayment(
      { orderId: "ord_p1i", razorpayOrderId: GW, razorpayPaymentId: "pay_p1i", razorpaySignature: sign() },
      { uid: "cust_1" }
    ).catch(() => undefined);

    // No SECOND money movement for the same capture.
    expect(control.refundPosts.length).toBe(firstPosts);
    expect(docs.get("orders/ord_p1i").status).toMatchObject({ code: "PLACED" });
  });

  it("a still-available cart confirms normally (no refund)", async () => {
    seed(true);
    const res: any = await verifyPayment(
      { orderId: "ord_p1i", razorpayOrderId: GW, razorpayPaymentId: "pay_p1i", razorpaySignature: sign() },
      { uid: "cust_1" }
    );
    expect(res.ok).toBe(true);
    expect(control.refundPosts).toHaveLength(0);
    expect(docs.get("orders/ord_p1i").paymentStatus).toBe("completed");
  });

  it("a PLACED manually resolved order survives stalled recovery and verify without losing its settlement proof", async () => {
    seed(true);
    const previousPosMock = config.mock.petpoojaPos;
    config.mock.petpoojaPos = true;
    const atMs = Date.UTC(2026, 10, 20, 10);
    docs.set("orders/ord_p1i", {
      ...docs.get("orders/ord_p1i"),
      createdAt: new Date(Date.UTC(2026, 10, 1)).toISOString(),
      payment: { ...docs.get("orders/ord_p1i").payment, razorpayPaymentId: "pay_p1i", razorpayOrderId: GW },
      settlementCaptureState: "confirmed_manual",
      settlementCaptureUnresolved: false,
      settlementEffectiveAtMs: atMs,
      settlementResolution: { uid: "brand_owner", atMs, istMonthKey: "2026-11", reason: "Provider dashboard evidence" },
    });
    const monthKey = "2026-11";
    const first = await generateSettlementStatement({ branchId: "branch_a", monthKey,
      caller: { uid: "brand_owner", role: "brand_owner" }, source: "on_demand", now: Date.UTC(2026, 11, 15) });
    expect(first?.complete).toBe(true);

    docs.set("orders/ord_p1i", {
      ...docs.get("orders/ord_p1i"),
      captureFulfillmentState: "fulfillable",
      captureFulfillment: { state: "fulfillable", paymentId: "pay_p1i", atMs: Date.now() - CAPTURE_RECOVERY_AFTER_MS - 60_000 },
    });
    try {
      const recovery = await import("../src/modules/payments/captureRecovery").then(m => m.recoverStuckCaptureFulfilments());
      expect(recovery.failed).toBe(0);
      expect(recovery.confirmed).toBe(1);
      expect(docs.get("orders/ord_p1i")).toMatchObject({ status: { code: "CONFIRMED" }, settlementCaptureState: "confirmed_manual",
        settlementCaptureUnresolved: false, settlementEffectiveAtMs: atMs });

      const verified: any = await verifyPayment(
        { orderId: "ord_p1i", razorpayOrderId: GW, razorpayPaymentId: "pay_p1i", razorpaySignature: sign() },
        { uid: "cust_1" }
      );
      expect(verified.ok).toBe(true);
      expect(control.refundPosts).toHaveLength(0);
      expect(docs.get("orders/ord_p1i")).toMatchObject({ status: { code: "CONFIRMED" }, settlementCaptureState: "confirmed_manual",
        settlementCaptureUnresolved: false, settlementEffectiveAtMs: atMs });

      const regenerated = await generateSettlementStatement({ branchId: "branch_a", monthKey,
        caller: { uid: "brand_owner", role: "brand_owner" }, source: "on_demand", now: Date.UTC(2026, 11, 16) });
      expect(regenerated?.complete).toBe(true);
      expect(regenerated?.unresolvedCaptures).toBe(0);
      expect(regenerated?.manuallyResolvedCaptures).toEqual(["ord_p1i"]);
    } finally { config.mock.petpoojaPos = previousPosMock; }
  });

  it("a failed automatic refund refuses the confirm and parks for ops", async () => {
    seed(false);
    control.refundMode = "fail";
    const err: any = await verifyPayment(
      { orderId: "ord_p1i", razorpayOrderId: GW, razorpayPaymentId: "pay_p1i", razorpaySignature: sign() },
      { uid: "cust_1" }
    ).then(
      (r) => ({ unexpectedSuccess: r }),
      (e) => e
    );

    expect(err.code).toBe("ORDER_ITEM_UNAVAILABLE");
    expect(docs.get("orders/ord_p1i").status).toMatchObject({ code: "PLACED" });
    expect(docs.get("orders/ord_p1i").petpoojaOrderId).toBeUndefined();
    expect(docs.get("unmatched_payments/ump_term_pay_p1i")).toBeDefined();
    expect(snapshots.some((s) => s.severity === "high")).toBe(true);
  });
});
