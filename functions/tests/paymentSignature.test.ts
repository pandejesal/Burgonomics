import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as crypto from "crypto";

// Proves the production HMAC path actually rejects forged signatures. The
// e2e suite runs with mock.paymentGateway=true (no live keys under vitest),
// where ANY non-empty string verifies — so this file flips mock mode off for
// its own scope and restores it after.

const { mockDb, savedDocs } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  const mockDb: any = {
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
      // Payment-intent lookups (loadPaymentIntent / resolveIntentRedemption)
      // query payment_intents by razorpayOrderId. P1-F makes the intent a hard
      // precondition of verification, so this must behave like the real SDK
      // (equality match over the store) rather than always-empty.
      where: (field: string, _op: string, value: any) => {
        const filters: Array<[string, any]> = [[field, value]];
        const q: any = {
          where: (f: string, _o2: string, v: any) => {
            filters.push([f, v]);
            return q;
          },
          limit: () => q,
          get: async () => {
            const docs = Object.entries(savedDocs)
              .filter(([p]) => p.startsWith(`${colName}/`))
              .filter(([, d]) =>
                filters.every(([f, v]) => {
                  const nested = f
                    .split(".")
                    .reduce((o: any, k) => (o == null ? undefined : o[k]), d);
                  return nested === v;
                })
              )
              .map(([p]) => ({ id: p.slice(colName.length + 1), data: () => savedDocs[p] }));
            return { empty: docs.length === 0, docs };
          },
        };
        return q;
      },
    }),
    // R20: finishVerifiedPayment requires a transactional datastore (the
    // production path has NO non-atomic fallback). Mirror the R06
    // concurrency fixtures: get/set delegate to the same doc refs the
    // direct path uses, so tx reads re-materialize current store state.
    runTransaction: vi.fn(async (fn: any) =>
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

import { verifyPayment, __setPaymentsFetchForTests } from "../src/modules/payments/razorpay.service";
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
    __setPaymentsFetchForTests(null);
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
    // P1-F: verification requires the durable intent binding gateway order ->
    // internal order (it is also the amount authority), and (live mode) the
    // gateway's captured truth. Both are real production preconditions.
    savedDocs["payment_intents/intent_sig_2"] = {
      razorpayOrderId: orderId,
      orderId: "order_sig_2",
      amountPaise: 10000,
      branchId: "branch_surat_01",
      createdAtMs: Date.now(),
      expiresAtMs: Date.now() + 60_000,
    };
    __setPaymentsFetchForTests(async () => ({
      id: paymentId,
      order_id: orderId,
      amount: 10000,
      currency: "INR",
      status: "captured",
    }));
    const res = await verifyPayment({
      orderId: "order_sig_2",
      razorpayOrderId: orderId,
      razorpayPaymentId: paymentId,
      razorpaySignature: sig,
    });
    expect(res.success).toBe(true);
  });
});
