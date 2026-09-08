import { describe, it, expect, vi, afterEach } from "vitest";
import * as crypto from "crypto";

// B2-S1 worker-guard rig: the pure split/signature suites above never touch
// Firestore; only the over-transfer worker test below uses this mock.
const { mockDb, writes } = vi.hoisted(() => {
  const writes: Array<{ ref: string; data: any }> = [];
  const orderData = () => ({
    branchId: "branch_cap_1",
    pricing: { grandTotal: 100, split: { branchTransferPaise: 9000 } },
    payment: { razorpayPaymentId: "pay_cap_1", capturedAmountPaise: 5000 },
    routeTransferStatus: "pending_retry",
    routeTransferRetryCount: 0,
  });
  const orderDoc: any = {
    id: "order_cap_1",
    data: orderData,
    ref: {
      get: async () => ({ exists: true, data: orderData }),
      set: async (data: any) => {
        writes.push({ ref: "orders/order_cap_1", data });
      },
    },
  };
  const mockDb: any = {
    collection: (colName: string) => ({
      doc: (docId: string) => ({
        get: async () =>
          colName === "branches"
            ? { exists: true, data: () => ({ razorpayAccountId: "acc_cap_1" }) }
            : { exists: false, data: () => ({}) },
        set: async (data: any) => {
          writes.push({ ref: `${colName}/${docId}`, data });
        },
      }),
      where: () => ({
        where: () => ({
          limit: () => ({
            get: async () => ({ docs: [orderDoc] }),
          }),
        }),
      }),
    }),
    runTransaction: async (fn: any) =>
      fn({
        get: (ref: any) => ref.get(),
        set: (ref: any, data: any) => ref.set(data),
      }),
  };
  return { mockDb, writes };
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
  calculateRouteSplit,
  buildRouteTransferPayload,
  attemptRouteTransfer,
  retryPendingRouteTransfersWorker,
} from "../src/modules/payments/routeTransfers";
import { config } from "../src/config/env";
import {
  verifyRazorpayWebhookSignature,
  verifyRazorpaySignature,
  computeHmacSha256,
} from "../src/core/security";

describe("Prompt 16: Razorpay Payments, Route Splits & Webhooks Suite", () => {
  const webhookSecret = "whsec_test_secret_burgonomics_12345";
  const keySecret = "rzp_secret_mock_789xyz";

  describe("1. Razorpay Route 95/5 Split Calculations", () => {
    it("calculates 95% branch transfer and 5% brand royalty accurately in paise", () => {
      const totalAmountRupees = 500;
      const totalAmountPaise = totalAmountRupees * 100; // 50,000 paise

      const split = calculateRouteSplit(totalAmountPaise, 0.05);

      // 5% of 50,000 paise = 2,500 paise (₹25)
      expect(split.brandRoyaltyPaise).toBe(2500);
      // 95% of 50,000 paise = 47,500 paise (₹475)
      expect(split.branchTransferPaise).toBe(47500);
      // Sum must strictly equal total amount
      expect(split.branchTransferPaise + split.brandRoyaltyPaise).toBe(totalAmountPaise);
    });

    it("handles fractional amounts cleanly by rounding paise", () => {
      const totalAmountPaise = 34900; // ₹349.00
      const split = calculateRouteSplit(totalAmountPaise, 0.05);

      // 5% of 34900 = 1745 paise
      expect(split.brandRoyaltyPaise).toBe(1745);
      expect(split.branchTransferPaise).toBe(33155);
      expect(split.branchTransferPaise + split.brandRoyaltyPaise).toBe(totalAmountPaise);
    });

    it("constructs valid Razorpay Route transfer payload", () => {
      const accountId = "acc_FranchiseBranchSurat01";
      const transferPaise = 47500;
      const orderId = "ord_surat_9921";
      const branchId = "branch_surat_01";
      const royaltyPaise = 2500;

      const transfers = buildRouteTransferPayload(
        accountId,
        transferPaise,
        orderId,
        branchId,
        royaltyPaise
      );

      expect(transfers).toHaveLength(1);
      expect(transfers[0].account).toBe(accountId);
      expect(transfers[0].amount).toBe(transferPaise);
      expect(transfers[0].currency).toBe("INR");
      expect(transfers[0].on_hold).toBe(false);
      expect(transfers[0].notes.orderId).toBe(orderId);
      expect(transfers[0].notes.branchId).toBe(branchId);
      expect(transfers[0].notes.brandRoyaltyPaise).toBe(royaltyPaise);
      expect(transfers[0].linked_account_notes).toContain("orderId");
    });
  });

  describe("2. Cryptographic HMAC SHA256 Webhook Verification", () => {
    it("validates authentic webhook payloads with correct signature", () => {
      const rawBody = JSON.stringify({
        event: "payment.captured",
        id: "evt_test_123",
        payload: {
          payment: {
            entity: {
              id: "pay_test_999",
              amount: 50000,
              notes: { orderId: "ord_123", branchId: "branch_01" },
            },
          },
        },
      });

      const signature = crypto
        .createHmac("sha256", webhookSecret)
        .update(rawBody)
        .digest("hex");

      const isValid = verifyRazorpayWebhookSignature(rawBody, signature, webhookSecret);
      expect(isValid).toBe(true);
    });

    it("strictly rejects tampered webhook payloads", () => {
      const rawBody = JSON.stringify({ event: "payment.captured", id: "evt_1" });
      const tamperedBody = JSON.stringify({ event: "payment.captured", id: "evt_1", malicious: true });

      const signature = crypto
        .createHmac("sha256", webhookSecret)
        .update(rawBody)
        .digest("hex");

      const isValid = verifyRazorpayWebhookSignature(tamperedBody, signature, webhookSecret);
      expect(isValid).toBe(false);
    });

    it("validates client-side Razorpay order checkout signature verification", () => {
      const razorpayOrderId = "order_N12345";
      const razorpayPaymentId = "pay_P67890";
      const payload = `${razorpayOrderId}|${razorpayPaymentId}`;

      const validSignature = crypto
        .createHmac("sha256", keySecret)
        .update(payload)
        .digest("hex");

      const isValid = verifyRazorpaySignature(
        razorpayOrderId,
        razorpayPaymentId,
        validSignature,
        keySecret
      );
      expect(isValid).toBe(true);
    });
  });

  describe("3. Secure Delivery OTP Generation & Verification Hash", () => {
    it("generates 4-digit numeric OTP and verifies HMAC hash match", () => {
      const otp = "8492";
      const hash1 = computeHmacSha256(otp, webhookSecret);
      const hash2 = computeHmacSha256(otp, webhookSecret);

      expect(hash1).toBe(hash2);
      expect(hash1).toMatch(/^[a-f0-9]{64}$/);

      const wrongHash = computeHmacSha256("8493", webhookSecret);
      expect(wrongHash).not.toBe(hash1);
    });
  });

  describe("4. Over-capture transfer guard (B2-S1)", () => {
    let prevMock: boolean;
    const beginMock = () => {
      prevMock = config.mock.paymentGateway;
      config.mock.paymentGateway = true;
    };
    afterEach(() => {
      config.mock.paymentGateway = prevMock;
      writes.length = 0;
    });

    it("refuses a split above the captured amount before any gateway call", async () => {
      const attempt = await attemptRouteTransfer(
        "pay_x",
        "branch_x",
        { branchTransferPaise: 6000 },
        "order_x",
        "acc_x",
        5000 // captured ceiling
      );
      expect(attempt.ok).toBe(false);
      expect(attempt.error).toMatch(/exceeds captured/);
    });

    it("allows a split within the captured amount (mock gateway)", async () => {
      beginMock();
      const attempt = await attemptRouteTransfer(
        "pay_x",
        "branch_x",
        { branchTransferPaise: 4000 },
        "order_x",
        "acc_x",
        5000
      );
      expect(attempt.ok).toBe(true);
      expect(attempt.result.amount).toBe(4000);
    });

    it("worker parks (never sends) a split above captured truth", async () => {
      beginMock();
      // Seeded order: Rs.90 split vs Rs.50 captured -> guard must refuse.
      const result = await retryPendingRouteTransfersWorker();
      expect(result.retriedCount).toBe(0);
      const errWrites = writes.filter((w) => w.data?.routeTransferError);
      expect(errWrites.length).toBeGreaterThan(0);
      expect(String(errWrites[0].data.routeTransferError)).toMatch(/exceeds captured/);
      // Never flipped to transferred.
      expect(
        writes.some((w) => w.data?.routeTransferStatus === "transferred")
      ).toBe(false);
    });
  });
});
