import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * P1 REFUND LOOKUP (money path).
 *
 * Defect under test: confirmation wrote the captured payment id as a LITERAL
 * top-level field named `"payment.razorpayPaymentId"` (a merge-set key whose
 * dot is part of the field NAME), while the `refund.processed` handler looked
 * orders up with `where("payment.razorpayPaymentId", "==", …)` — a NESTED
 * field path. The two shapes never match, so every refund for an
 * app-verified/webhook-confirmed order parked in `unmatched_payments`
 * instead of advancing that order's refund ledger. The order kept showing
 * paid, the customer's money came back from the gateway unaccounted, and the
 * cumulative-refund cap saw ₹0 refunded.
 *
 * Fixed contract pinned here:
 *   • the real confirm writer writes a CANONICAL nested `payment` map;
 *   • the refund lookup matches nested docs AND legacy dotted-literal docs;
 *   • a doc carrying both shapes counts ONCE (never "ambiguous");
 *   • the matched order's refundLedger/refundedTotalPaise advance and NO
 *     unmatched park is written.
 *
 * All Firestore writes go through an SDK-VALIDATING mock: explicit `undefined`
 * (which real Firestore rejects — the old audit write 500'd on it) throws.
 */

const { mockDb, savedDocs, control } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  // Test control: force the legacy (single-segment FieldPath) query to fail.
  const control = { failLegacyQuery: false };

  const assertNoUndefined = (value: any, fieldPath: string) => {
    if (value === undefined) {
      throw new Error(
        `Cannot use "undefined" as a Firestore value (found in field "${fieldPath}")`
      );
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const [k, v] of Object.entries(value)) {
        assertNoUndefined(v, fieldPath ? `${fieldPath}.${k}` : k);
      }
    }
    if (Array.isArray(value)) {
      value.forEach((v, i) => assertNoUndefined(v, `${fieldPath}[${i}]`));
    }
  };

  /**
   * Field resolution mirroring Firestore:
   *  - a plain dotted STRING is a NESTED field path;
   *  - a single-segment FieldPath is ONE literal field name (dots included) —
   *    the only way to query the legacy `"payment.razorpayPaymentId"` field.
   */
  const readField = (doc: any, field: any) => {
    if (field && typeof field === "object" && Array.isArray((field as any).segments)) {
      let cur = doc;
      for (const segment of (field as any).segments) {
        if (cur == null || typeof cur !== "object") return undefined;
        cur = cur[segment];
      }
      return cur;
    }
    return String(field)
      .split(".")
      .reduce((o, k) => (o == null ? undefined : o[k]), doc);
  };

  const docRef = (col: string, id: string) => {
    const path = `${col}/${id}`;
    return {
      id,
      path,
      get: vi.fn(async () => ({
        exists: Object.prototype.hasOwnProperty.call(savedDocs, path),
        id,
        data: () => savedDocs[path],
      })),
      set: vi.fn(async (data: any, opts?: any) => {
        assertNoUndefined(data, "");
        savedDocs[path] =
          opts?.merge && savedDocs[path] ? { ...savedDocs[path], ...data } : data;
      }),
      create: vi.fn(async (data: any) => {
        assertNoUndefined(data, "");
        if (Object.prototype.hasOwnProperty.call(savedDocs, path)) {
          const err: any = new Error("ALREADY_EXISTS: Document already exists");
          err.code = 6;
          throw err;
        }
        savedDocs[path] = data;
      }),
      update: vi.fn(async (data: any) => {
        assertNoUndefined(data, "");
        savedDocs[path] = { ...(savedDocs[path] || {}), ...data };
      }),
      delete: vi.fn(async () => {
        delete savedDocs[path];
      }),
    };
  };

  const mockDb: any = {
    collection: (col: string) => ({
      doc: (id: string) => docRef(col, id),
      where: (field: any, _op: string, value: any) => ({
        limit: (_n: number) => ({
          get: vi.fn(async () => {
            if (field && typeof field === "object" && control.failLegacyQuery) {
              throw new Error("legacy literal-field query unavailable");
            }
            const docs = Object.keys(savedDocs)
              .filter((p) => p.startsWith(`${col}/`) && readField(savedDocs[p], field) === value)
              .map((p) => {
                const id = p.slice(col.length + 1);
                return {
                  id,
                  ref: docRef(col, id),
                  exists: true,
                  data: () => savedDocs[p],
                };
              });
            return { empty: docs.length === 0, size: docs.length, docs };
          }),
        }),
      }),
    }),
    runTransaction: vi.fn(async (fn: any) =>
      fn({
        get: (ref: any) => ref.get(),
        set: (ref: any, data: any, opts?: any) => ref.set(data, opts),
      })
    ),
  };

  return { mockDb, savedDocs, control };
});

vi.mock("firebase-admin", () => {
  const FieldValue = {
    serverTimestamp: () => "MOCK_SERVER_TIMESTAMP",
    increment: (n: number) => n,
    arrayUnion: (item: any) => [item],
    delete: () => "MOCK_DELETE",
  };
  // Real SDK semantics: segments are literal field names, dots included.
  class FieldPath {
    segments: string[];
    constructor(...segments: string[]) {
      this.segments = segments;
    }
  }
  const firestoreFn: any = vi.fn(() => mockDb);
  firestoreFn.FieldValue = FieldValue;
  firestoreFn.FieldPath = FieldPath;
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
import {
  verifyPayment,
  __setPaymentsFetchForTests,
} from "../src/modules/payments/razorpay.service";
import { computeHmacSha256 } from "../src/core/security";
import { config } from "../src/config/env";

const KEY_SECRET = "live_secret_refund_lookup_1";
const WEBHOOK_SECRET = "test_whsec_refund_lookup_1";

const ORDER_ID = "ord_refund_lookup_1";
const RZP_ORDER_ID = "order_rzp_lookup_1";
const PAYMENT_ID = "pay_refund_lookup_1";

function seedConfirmedOrderLikeOrder() {
  savedDocs[`orders/${ORDER_ID}`] = {
    id: ORDER_ID,
    customerId: "guest",
    branchId: "branch_refund_1",
    orderType: "takeaway",
    status: "pending_payment",
    items: [{ id: "l1", productId: "prod_1", name: "Burger", price: 250, quantity: 1 }],
    pricing: { grandTotal: 250 },
  };
}

function seedLegacyLiteralOrder(id: string, paymentId: string) {
  savedDocs[`orders/${id}`] = {
    id,
    customerId: "guest",
    paymentStatus: "completed",
    // PRE-FIX WRITER SHAPE: one top-level field whose NAME contains dots.
    "payment.razorpayPaymentId": paymentId,
    "payment.status": "completed",
  };
}

function refundPayload(eventId: string, refundId: string, paymentId: string | undefined, amount = 5000) {
  return {
    id: eventId,
    event: "refund.processed",
    payload: {
      refund: {
        entity: {
          id: refundId,
          ...(paymentId !== undefined ? { payment_id: paymentId } : {}),
          amount,
          currency: "INR",
        },
      },
    },
  };
}

async function deliver(payload: any) {
  const rawBody = JSON.stringify(payload);
  const req: any = {
    headers: {},
    body: payload,
    rawBody: Buffer.from(rawBody, "utf8"),
  };
  // Real signature check (live mode): sign exactly what the handler verifies.
  req.headers["x-razorpay-signature"] = computeHmacSha256(rawBody, WEBHOOK_SECRET);

  let statusCode = 0;
  let body: any = null;
  const res: any = {
    status: (code: number) => {
      statusCode = code;
      return { json: (obj: any) => void (body = obj) };
    },
  };
  await handleRazorpayWebhook(req, res);
  return { statusCode, body };
}

function unmatchedParkPaths(): string[] {
  return Object.keys(savedDocs).filter((p) => p.startsWith("unmatched_payments/"));
}

describe("refund.processed matches the SAME order the confirm writer stamped", () => {
  let prevMock: boolean;
  let prevKeyId: string;
  let prevKeySecret: string;
  let prevWebhookSecret: string;
  let prevOtp: string | undefined;

  beforeEach(() => {
    for (const key of Object.keys(savedDocs)) delete savedDocs[key];
    __setPaymentsFetchForTests(null);
    control.failLegacyQuery = false;

    prevMock = config.mock.paymentGateway;
    prevKeyId = config.razorpay.keyId;
    prevKeySecret = config.razorpay.keySecret;
    prevWebhookSecret = config.razorpay.webhookSecret;
    prevOtp = process.env.OTP_HMAC_SECRET;

    // LIVE money path: real HMAC signature checks, stubbed gateway FETCH only
    // (no network). Nothing here calls Razorpay.
    config.mock.paymentGateway = false;
    config.razorpay.keyId = "rzp_live_refund_lookup";
    config.razorpay.keySecret = KEY_SECRET;
    config.razorpay.webhookSecret = WEBHOOK_SECRET;
    process.env.OTP_HMAC_SECRET = "test_otp_refund_lookup_only";
  });

  afterEach(() => {
    __setPaymentsFetchForTests(null);
    config.mock.paymentGateway = prevMock;
    config.razorpay.keyId = prevKeyId;
    config.razorpay.keySecret = prevKeySecret;
    config.razorpay.webhookSecret = prevWebhookSecret;
    if (prevOtp === undefined) delete process.env.OTP_HMAC_SECRET;
    else process.env.OTP_HMAC_SECRET = prevOtp;
  });

  it("confirms via the real writer, then applies a refund.processed to that same order (no park)", async () => {
    seedConfirmedOrderLikeOrder();
    __setPaymentsFetchForTests(async () => ({
      id: PAYMENT_ID,
      order_id: RZP_ORDER_ID,
      amount: 25000,
      currency: "INR",
      status: "captured",
    }));

    const verified = await verifyPayment({
      orderId: ORDER_ID,
      razorpayOrderId: RZP_ORDER_ID,
      razorpayPaymentId: PAYMENT_ID,
      razorpaySignature: computeHmacSha256(`${RZP_ORDER_ID}|${PAYMENT_ID}`, KEY_SECRET),
    });
    expect(verified.success).toBe(true);

    // The writer stamps the CANONICAL nested map (the queryable shape) and
    // keeps the legacy dotted alias for both-shape readers.
    const confirmed = savedDocs[`orders/${ORDER_ID}`];
    expect(confirmed.payment.razorpayPaymentId).toBe(PAYMENT_ID);
    expect(confirmed.payment.capturedAmountPaise).toBe(25000);
    expect(confirmed["payment.razorpayPaymentId"]).toBe(PAYMENT_ID);

    // Writer/reader shape agreement: the refund branch's PRIMARY query now
    // finds the order the confirm writer just stamped.
    const nestedMatch = await mockDb
      .collection("orders")
      .where("payment.razorpayPaymentId", "==", PAYMENT_ID)
      .limit(2)
      .get();
    expect(nestedMatch.docs.map((d: any) => d.id)).toEqual([ORDER_ID]);

    const res = await deliver(
      refundPayload("evt_refund_lookup_1", "rfnd_lookup_1", PAYMENT_ID, 5000)
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ status: "ok" });

    // SAME order advanced its refund ledger — the whole point of the fix.
    const afterRefund = savedDocs[`orders/${ORDER_ID}`];
    expect(afterRefund.refundLedger).toEqual({ rfnd_lookup_1: 5000 });
    expect(afterRefund.refundedTotalPaise).toBe(5000);
    expect(afterRefund.refundId).toBe("rfnd_lookup_1");
    // Partial against the known 25000 capture.
    expect(afterRefund.refundStatus).toBe("partially_refunded");

    // No unmatched park was written for this refund.
    expect(unmatchedParkPaths()).toEqual([]);
    // The delivery claim completed (a completed claim dedupes redelivery).
    const audit = savedDocs["payment_audits/aud_evt_evt_refund_lookup_1"];
    expect(audit.completedAt).toBeTruthy();
  });

  it("still matches a LEGACY dotted-literal order during migration", async () => {
    seedLegacyLiteralOrder("ord_legacy_refund_1", "pay_legacy_1");

    // Mechanism proof (pre-fix defect): Firestore reads a dotted STRING in
    // `where()` as a nested field PATH, so the exact lookup the handler used
    // before this fix cannot see the legacy literal field at all — the refund
    // was parked `refund_no_match`. Only the single-segment FieldPath does.
    const nestedOnly = await mockDb
      .collection("orders")
      .where("payment.razorpayPaymentId", "==", "pay_legacy_1")
      .limit(2)
      .get();
    expect(nestedOnly.docs).toHaveLength(0);

    const res = await deliver(refundPayload("evt_refund_legacy_1", "rfnd_legacy_1", "pay_legacy_1"));
    expect(res.statusCode).toBe(200);

    const order = savedDocs["orders/ord_legacy_refund_1"];
    expect(order.refundLedger).toEqual({ rfnd_legacy_1: 5000 });
    expect(order.refundedTotalPaise).toBe(5000);
    expect(unmatchedParkPaths()).toEqual([]);
  });

  it("counts a doc carrying BOTH shapes once — never as an ambiguous match", async () => {
    savedDocs["orders/ord_dual_shape_1"] = {
      id: "ord_dual_shape_1",
      customerId: "guest",
      paymentStatus: "completed",
      payment: { razorpayPaymentId: "pay_dual_1", status: "completed" },
      "payment.razorpayPaymentId": "pay_dual_1",
      "payment.status": "completed",
    };

    const res = await deliver(refundPayload("evt_refund_dual_1", "rfnd_dual_1", "pay_dual_1"));
    expect(res.statusCode).toBe(200);

    const order = savedDocs["orders/ord_dual_shape_1"];
    expect(order.refundLedger).toEqual({ rfnd_dual_1: 5000 });
    expect(order.refundedTotalPaise).toBe(5000);
    expect(unmatchedParkPaths()).toEqual([]);
  });

  it("parks genuinely ambiguous matches (two DIFFERENT orders share the payment id)", async () => {
    savedDocs["orders/ord_amb_a"] = {
      id: "ord_amb_a",
      customerId: "guest",
      paymentStatus: "completed",
      payment: { razorpayPaymentId: "pay_amb_1" },
    };
    savedDocs["orders/ord_amb_b"] = {
      id: "ord_amb_b",
      customerId: "guest",
      paymentStatus: "completed",
      payment: { razorpayPaymentId: "pay_amb_1" },
    };

    const res = await deliver(refundPayload("evt_refund_amb_1", "rfnd_amb_1", "pay_amb_1"));
    expect(res.statusCode).toBe(200);

    expect(savedDocs["unmatched_payments/ump_refund_evt_refund_amb_1"]).toMatchObject({
      reason: "refund_ambiguous_match",
      razorpayPaymentId: "pay_amb_1",
      refundId: "rfnd_amb_1",
    });
    // Neither order was mutated by an arbitrary pick.
    expect(savedDocs["orders/ord_amb_a"].refundedTotalPaise).toBeUndefined();
    expect(savedDocs["orders/ord_amb_b"].refundedTotalPaise).toBeUndefined();
  });

  it("parks a refund with NO payment_id instead of querying Firestore with undefined", async () => {
    const res = await deliver(refundPayload("evt_refund_nopid_1", "rfnd_nopid_1", undefined));
    expect(res.statusCode).toBe(200);
    expect(savedDocs["unmatched_payments/ump_refund_evt_refund_nopid_1"]).toMatchObject({
      reason: "refund_missing_payment_id",
      refundId: "rfnd_nopid_1",
      status: "needs_review",
    });
  });

  it("keeps processing when ONLY the legacy lookup fails and the canonical match is in hand", async () => {
    seedConfirmedOrderLikeOrder();
    __setPaymentsFetchForTests(async () => ({
      id: PAYMENT_ID,
      order_id: RZP_ORDER_ID,
      amount: 25000,
      currency: "INR",
      status: "captured",
    }));
    await verifyPayment({
      orderId: ORDER_ID,
      razorpayOrderId: RZP_ORDER_ID,
      razorpayPaymentId: PAYMENT_ID,
      razorpaySignature: computeHmacSha256(`${RZP_ORDER_ID}|${PAYMENT_ID}`, KEY_SECRET),
    });

    control.failLegacyQuery = true;
    const res = await deliver(refundPayload("evt_refund_legfail_1", "rfnd_legfail_1", PAYMENT_ID));
    expect(res.statusCode).toBe(200);
    expect(savedDocs[`orders/${ORDER_ID}`].refundedTotalPaise).toBe(5000);
    expect(unmatchedParkPaths()).toEqual([]);
    // The degraded legacy fallback is surfaced for ops, not swallowed.
    const snapshot = Object.entries(savedDocs).find(
      ([k, v]) =>
        k.startsWith("dev_error_snapshots/") &&
        /Legacy dotted payment-id lookup failed/.test(String((v as any)?.message || ""))
    );
    expect(snapshot, "expected a high-severity legacy-lookup snapshot").toBeTruthy();
  });

  it("fails CLOSED (500, no park) when the legacy lookup fails and nothing canonical matched", async () => {
    seedLegacyLiteralOrder("ord_legacy_unreachable_1", "pay_legacy_unreachable_1");

    control.failLegacyQuery = true;
    const res = await deliver(
      refundPayload("evt_refund_legfail_2", "rfnd_legfail_2", "pay_legacy_unreachable_1")
    );

    // Cannot prove the refund is unmatched → gateway must retry, never a park.
    expect(res.statusCode).toBe(500);
    expect(unmatchedParkPaths()).toEqual([]);
    expect(savedDocs["orders/ord_legacy_unreachable_1"].refundedTotalPaise).toBeUndefined();
  });
});
