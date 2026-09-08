import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

// B2-S1 service-level rig: Firestore is mocked per-file; the live Razorpay
// fetch is stubbed via the __setPaymentsFetchForTests seam (no network, no
// SDK mocking — the pure-HMAC suite above is unaffected).
const { mockDb, savedDocs } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  const docRef = (colName: string, docId: string) => ({
    id: docId,
    path: `${colName}/${docId}`,
    get: vi.fn(async () => ({
      exists: !!savedDocs[`${colName}/${docId}`],
      data: () => savedDocs[`${colName}/${docId}`] || {},
      ref: {
        set: vi.fn(async (data: any) => {
          const p = `${colName}/${docId}`;
          savedDocs[p] = { ...(savedDocs[p] || {}), ...data };
        }),
      },
    })),
    set: vi.fn(async (data: any, options?: any) => {
      const p = `${colName}/${docId}`;
      savedDocs[p] =
        options?.merge && savedDocs[p] ? { ...savedDocs[p], ...data } : data;
    }),
  });
  const mockDb: any = {
    collection: (colName: string) => ({
      doc: (docId: string) => docRef(colName, docId),
    }),
    runTransaction: vi.fn(async (fn: any) =>
      fn({
        get: (ref: any) => ref.get(),
        // Real Firestore accepts the doc ref here; the mock docRef carries a
        // top-level set (NOT snapshot.ref.set — that belongs to get() results).
        set: (ref: any, data: any, opts?: any) => ref.set(data, opts),
      })
    ),
  };
  return { mockDb, savedDocs };
});

vi.mock("firebase-admin", () => {
  const FieldValue = {
    serverTimestamp: () => "MOCK_TIMESTAMP",
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

import {
  verifyPayment,
  autoRefund,
  __setPaymentsFetchForTests,
} from "../src/modules/payments/razorpay.service";
import { config } from "../src/config/env";

describe("verifyPayment fail-closed (B2-S1)", () => {
  const LIVE_SECRET = "test_rzp_b2s1_sig_secret";
  let prevMock: boolean;
  let prevKeyId: string;
  let prevKeySecret: string;
  let prevOtp: string | undefined;

  beforeEach(() => {
    for (const key of Object.keys(savedDocs)) delete savedDocs[key];
    __setPaymentsFetchForTests(null);
    prevMock = config.mock.paymentGateway;
    prevKeyId = config.razorpay.keyId;
    prevKeySecret = config.razorpay.keySecret;
    config.mock.paymentGateway = false; // live path: fetch stub is exercised
    config.razorpay.keyId = "test_key_id_b2s1";
    config.razorpay.keySecret = LIVE_SECRET;
    prevOtp = process.env.OTP_HMAC_SECRET;
    process.env.OTP_HMAC_SECRET = "test_otp_b2s1_only";
  });

  afterEach(() => {
    __setPaymentsFetchForTests(null);
    config.mock.paymentGateway = prevMock;
    config.razorpay.keyId = prevKeyId;
    config.razorpay.keySecret = prevKeySecret;
    if (prevOtp === undefined) delete process.env.OTP_HMAC_SECRET;
    else process.env.OTP_HMAC_SECRET = prevOtp;
  });

  const liveSig = (orderId: string, paymentId: string) =>
    computeHmacSha256(`${orderId}|${paymentId}`, LIVE_SECRET);

  const seedPricedOrder = (id = "order_b2s1_1", grandTotal = 100) => {
    savedDocs[`orders/${id}`] = {
      branchId: "branch_test_1",
      orderType: "delivery",
      pricing: { grandTotal, split: { branchTransferPaise: 9000 } },
    };
  };

  it("confirms a matching captured payment and stores captured paise", async () => {
    seedPricedOrder();
    __setPaymentsFetchForTests(async () => ({
      id: "pay_live_1",
      order_id: "order_rzp_1",
      amount: 10000,
      currency: "INR",
      status: "captured",
    }));
    const res = await verifyPayment({
      orderId: "order_b2s1_1",
      razorpayOrderId: "order_rzp_1",
      razorpayPaymentId: "pay_live_1",
      razorpaySignature: liveSig("order_rzp_1", "pay_live_1"),
    });
    expect(res.success).toBe(true);
    expect(savedDocs["orders/order_b2s1_1"].paymentStatus).toBe("completed");
    expect(savedDocs["orders/order_b2s1_1"]["payment.capturedAmountPaise"]).toBe(10000);
  });

  it("rejects amount mismatch with 409 + discrepancy doc, never confirms", async () => {
    seedPricedOrder();
    __setPaymentsFetchForTests(async () => ({
      id: "pay_live_2",
      order_id: "order_rzp_1",
      amount: 5000, // paid half of the ₹100 total
      currency: "INR",
      status: "captured",
    }));
    const err: any = await verifyPayment({
      orderId: "order_b2s1_1",
      razorpayOrderId: "order_rzp_1",
      razorpayPaymentId: "pay_live_2",
      razorpaySignature: liveSig("order_rzp_1", "pay_live_2"),
    }).then(
      () => null,
      (e) => e
    );
    expect(err?.code).toBe("AMOUNT_MISMATCH");
    expect(err?.statusCode).toBe(409);
    expect(savedDocs["orders/order_b2s1_1"].paymentStatus).not.toBe("completed");
    const parks = Object.keys(savedDocs).filter((k) => k.startsWith("payment_discrepancies/"));
    expect(parks).toHaveLength(1);
    expect(savedDocs[parks[0]].reason).toBe("AMOUNT_MISMATCH");
    expect(savedDocs[parks[0]].status).toBe("needs_review");
  });

  it("refuses uncaptured payment without auto-capture", async () => {
    seedPricedOrder();
    __setPaymentsFetchForTests(async () => ({
      id: "pay_live_3",
      order_id: "order_rzp_1",
      amount: 10000,
      currency: "INR",
      status: "authorized", // never captured
    }));
    const err: any = await verifyPayment({
      orderId: "order_b2s1_1",
      razorpayOrderId: "order_rzp_1",
      razorpayPaymentId: "pay_live_3",
      razorpaySignature: liveSig("order_rzp_1", "pay_live_3"),
    }).then(
      () => null,
      (e) => e
    );
    expect(err?.code).toBe("PAYMENT_NOT_CAPTURED");
    expect(savedDocs["orders/order_b2s1_1"].paymentStatus).toBe("awaiting_capture");
    expect(savedDocs["orders/order_b2s1_1"].status).toBeUndefined();
  });

  it("rejects a payment bound to a different gateway order", async () => {
    seedPricedOrder();
    __setPaymentsFetchForTests(async () => ({
      id: "pay_live_4",
      order_id: "order_rzp_OTHER",
      amount: 10000,
      currency: "INR",
      status: "captured",
    }));
    const err: any = await verifyPayment({
      orderId: "order_b2s1_1",
      razorpayOrderId: "order_rzp_1",
      razorpayPaymentId: "pay_live_4",
      razorpaySignature: liveSig("order_rzp_1", "pay_live_4"),
    }).then(
      () => null,
      (e) => e
    );
    expect(err?.code).toBe("ORDER_MISMATCH");
    expect(err?.statusCode).toBe(409);
    expect(savedDocs["orders/order_b2s1_1"].paymentStatus).not.toBe("completed");
  });

  it("fails closed with 503 when the gateway fetch throws", async () => {
    seedPricedOrder();
    __setPaymentsFetchForTests(async () => { throw new Error("socket hang up"); });
    const err: any = await verifyPayment({
      orderId: "order_b2s1_1",
      razorpayOrderId: "order_rzp_1",
      razorpayPaymentId: "pay_live_5",
      razorpaySignature: liveSig("order_rzp_1", "pay_live_5"),
    }).then(
      () => null,
      (e) => e
    );
    expect(err?.code).toBe("PAYMENT_STATUS_UNKNOWN");
    expect(err?.statusCode).toBe(503);
    expect(savedDocs["orders/order_b2s1_1"].paymentStatus).not.toBe("completed");
  });

  it("busy transfer claim returns an immediate 202 with no 2s poll", async () => {
    config.mock.paymentGateway = true; // signature short-circuit; claim path is the subject
    savedDocs["orders/order_busy_1"] = {
      branchId: "branch_test_1",
      pricing: { grandTotal: 100, split: { branchTransferPaise: 9000 } },
      routeTransferStatus: "transferring",
      routeTransferClaimedAt: { toMillis: () => Date.now() }, // fresh claim
    };
    const started = Date.now();
    const err: any = await verifyPayment({
      orderId: "order_busy_1",
      razorpayOrderId: "order_rzp_1",
      razorpayPaymentId: "pay_live_6",
      razorpaySignature: "mock_signature_valid",
    }).then(
      () => null,
      (e) => e
    );
    expect(err?.code).toBe("TRANSFER_IN_PROGRESS");
    expect(err?.statusCode).toBe(202);
    expect(err?.message).toMatch(/retry/i);
    expect(Date.now() - started).toBeLessThan(1500); // no serial poll loop
  });

  it("keeps the legacy path for orders without stored pricing", async () => {
    config.mock.paymentGateway = true;
    // A fetch stub that fails the test if the service ever calls it.
    __setPaymentsFetchForTests(async () => {
      throw new Error("gateway fetch must be skipped without stored pricing");
    });
    savedDocs["orders/order_legacy_1"] = { branchId: "branch_test_1" };
    const res = await verifyPayment({
      orderId: "order_legacy_1",
      razorpayOrderId: "order_rzp_1",
      razorpayPaymentId: "pay_live_7",
      razorpaySignature: "mock_signature_valid",
    });
    expect(res.success).toBe(true);
    expect(true).toBe(true); // reaching here proves the fetch was skipped
  });
});

describe("autoRefund fail-closed + idempotent (B2-S1)", () => {
  let prevMock: boolean;
  let prevOtp: string | undefined;

  beforeEach(() => {
    for (const key of Object.keys(savedDocs)) delete savedDocs[key];
    prevMock = config.mock.paymentGateway;
    config.mock.paymentGateway = true;
    prevOtp = process.env.OTP_HMAC_SECRET;
    process.env.OTP_HMAC_SECRET = "test_otp_b2s1_only";
  });

  afterEach(() => {
    config.mock.paymentGateway = prevMock;
    if (prevOtp === undefined) delete process.env.OTP_HMAC_SECRET;
    else process.env.OTP_HMAC_SECRET = prevOtp;
  });

  it("replays a completed refund idempotently instead of re-POSTing", async () => {
    savedDocs["orders/order_rf_1"] = {
      payment: { razorpayPaymentId: "pay_rf_1" },
      pricing: { grandTotal: 100 },
      refundStatus: "refunded",
      refundId: "rfnd_orig_1",
      refundAmount: 50,
    };
    const res = await autoRefund({
      orderId: "order_rf_1",
      razorpayPaymentId: "pay_rf_1",
      amountRupees: 50,
    });
    expect(res).toMatchObject({ id: "rfnd_orig_1", reused: true });
  });

  it("refuses a second refund for a different amount", async () => {
    savedDocs["orders/order_rf_2"] = {
      payment: { razorpayPaymentId: "pay_rf_2" },
      pricing: { grandTotal: 100 },
      refundStatus: "refunded",
      refundId: "rfnd_orig_2",
      refundAmount: 50,
    };
    const err: any = await autoRefund({
      orderId: "order_rf_2",
      razorpayPaymentId: "pay_rf_2",
      amountRupees: 60,
    }).then(
      () => null,
      (e) => e
    );
    expect(err?.code).toBe("ALREADY_REFUNDED");
    expect(err?.statusCode).toBe(409);
  });

  it("caps partial refunds at the order total", async () => {
    savedDocs["orders/order_rf_3"] = {
      payment: { razorpayPaymentId: "pay_rf_3" },
      pricing: { grandTotal: 100 },
    };
    const err: any = await autoRefund({
      orderId: "order_rf_3",
      razorpayPaymentId: "pay_rf_3",
      amountRupees: 200,
    }).then(
      () => null,
      (e) => e
    );
    expect(err?.code).toBe("REFUND_AMOUNT_EXCEEDS");
    expect(err?.statusCode).toBe(400);
  });

  it("refuses COD/unpaid orders loud", async () => {
    savedDocs["orders/order_cod_9"] = { payment: { method: "cod" } };
    const err: any = await autoRefund({
      orderId: "order_cod_9",
      razorpayPaymentId: "pay_cod_9",
    }).then(
      () => null,
      (e) => e
    );
    expect(err?.code).toBe("NO_CAPTURED_PAYMENT");
    expect(err?.statusCode).toBe(409);
  });

  it("404s on a missing order", async () => {
    const err: any = await autoRefund({
      orderId: "order_ghost_9",
      razorpayPaymentId: "pay_ghost_9",
    }).then(
      () => null,
      (e) => e
    );
    expect(err?.code).toBe("ORDER_NOT_FOUND");
    expect(err?.statusCode).toBe(404);
  });
});
import {
  verifyRazorpaySignature,
  computeHmacSha256,
  getOtpHmacSecret,
} from "../src/core/security";

describe("Razorpay Service & Signature Verification", () => {
  const secret = "test_webhook_secret_key_12345";
  const orderId = "order_Nabc12345XYZ";
  const paymentId = "pay_Pabc12345XYZ";

  it("verifies valid Razorpay HMAC signatures timing-safely", () => {
    const validSignature = computeHmacSha256(`${orderId}|${paymentId}`, secret);
    const isValid = verifyRazorpaySignature(orderId, paymentId, validSignature, secret);
    expect(isValid).toBe(true);
  });

  it("rejects tampered payment signatures", () => {
    const fakeSignature = "tampered_signature_hex_value_here";
    const isValid = verifyRazorpaySignature(orderId, paymentId, fakeSignature, secret);
    expect(isValid).toBe(false);
  });

  it("handles missing or malformed inputs gracefully", () => {
    expect(verifyRazorpaySignature("", paymentId, "sig", secret)).toBe(false);
    expect(verifyRazorpaySignature(orderId, "", "sig", secret)).toBe(false);
    expect(verifyRazorpaySignature(orderId, paymentId, "", secret)).toBe(false);
  });

  describe("OTP HMAC secret separation (fail-closed)", () => {
    afterEach(() => {
      delete process.env.OTP_HMAC_SECRET;
    });

    it("prefers the dedicated OTP_HMAC_SECRET when set", () => {
      process.env.OTP_HMAC_SECRET = "otp_dedicated_secret";
      expect(getOtpHmacSecret()).toBe("otp_dedicated_secret");
    });

    it("throws instead of falling back to the webhook secret when unset", () => {
      expect(() => getOtpHmacSecret()).toThrow(/OTP_HMAC_SECRET is unset/);
    });
  });
});
