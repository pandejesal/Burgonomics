import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as crypto from "crypto";

// Proves the production HMAC path actually rejects forged signatures. The
// e2e suite runs with mock.paymentGateway=true (no live keys under vitest),
// where ANY non-empty string verifies — so this file flips mock mode off for
// its own scope and restores it after.

const { mockDb, savedDocs } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  const mockDb = {
    collection: (colName: string) => ({
      doc: (docId: string) => ({
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
      }),
    }),
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

import { verifyPayment } from "../src/modules/payments/razorpay.service";
import { config } from "../src/config/env";

describe("Payment signature enforcement (live HMAC path)", () => {
  const prevMock = config.mock.paymentGateway;
  const prevKeySecret = config.razorpay.keySecret;
  let prevOtpSecret: string | undefined;

  beforeEach(() => {
    for (const key of Object.keys(savedDocs)) delete savedDocs[key];
    config.mock.paymentGateway = false;
    // Fail-closed env leaves keySecret empty (denies everything); the live
    // path under test needs an explicit test secret — never a mock literal.
    config.razorpay.keySecret = "test_rzp_key_secret_sig_only";
    // verifyPayment mints the delivery OTP hash via the dedicated secret.
    prevOtpSecret = process.env.OTP_HMAC_SECRET;
    process.env.OTP_HMAC_SECRET = "test_otp_hmac_sig_only";
  });

  afterEach(() => {
    config.mock.paymentGateway = prevMock;
    config.razorpay.keySecret = prevKeySecret;
    if (prevOtpSecret === undefined) delete process.env.OTP_HMAC_SECRET;
    else process.env.OTP_HMAC_SECRET = prevOtpSecret;
  });

  it("rejects a forged signature before touching the order", async () => {
    savedDocs["orders/order_sig_1"] = { branchId: "branch_surat_01" };
    await expect(
      verifyPayment({
        orderId: "order_sig_1",
        razorpayOrderId: "order_mock_x",
        razorpayPaymentId: "pay_mock_x",
        razorpaySignature: "forged_signature_value",
      })
    ).rejects.toThrow(/Invalid payment signature/);
  });

  it("accepts a correctly computed HMAC signature", async () => {
    const orderId = "order_mock_y";
    const paymentId = "pay_mock_y";
    const sig = crypto
      .createHmac("sha256", config.razorpay.keySecret)
      .update(`${orderId}|${paymentId}`)
      .digest("hex");
    savedDocs["orders/order_sig_2"] = { branchId: "branch_surat_01" };
    const res = await verifyPayment({
      orderId: "order_sig_2",
      razorpayOrderId: orderId,
      razorpayPaymentId: paymentId,
      razorpaySignature: sig,
    });
    expect(res.success).toBe(true);
  });
});
