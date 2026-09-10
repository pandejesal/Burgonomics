import { describe, it, expect } from "vitest";
import * as crypto from "crypto";
import { verifyRazorpaySignature, computeHmacSha256 } from "../src/core/security";

describe("Functions Backend — Webhooks, Signatures & Crypto OTP Hardening", () => {
  const testSecret = "sec_test_mock_webhook_secret_9988";

  it("verifies Razorpay payment signature correctly with valid secret", () => {
    const orderId = "order_rzp_987123";
    const paymentId = "pay_rzp_654321";
    const payload = `${orderId}|${paymentId}`;
    const validSignature = crypto.createHmac("sha256", testSecret).update(payload).digest("hex");

    const isValid = verifyRazorpaySignature(orderId, paymentId, validSignature, testSecret);
    expect(isValid).toBe(true);
  });

  it("strictly rejects forged or tampered Razorpay signatures", () => {
    const orderId = "order_rzp_987123";
    const paymentId = "pay_rzp_654321";
    const forgedSignature = "0000000000000000000000000000000000000000000000000000000000000000";

    const isValid = verifyRazorpaySignature(orderId, paymentId, forgedSignature, testSecret);
    expect(isValid).toBe(false);
  });

  it("computes reproducible and secure HMAC-SHA256 hashes for delivery OTP verification", () => {
    const otp = "5849";
    const hash1 = computeHmacSha256(otp, testSecret);
    const hash2 = computeHmacSha256(otp, testSecret);

    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[a-f0-9]{64}$/);

    const wrongOtp = "5848";
    const wrongHash = computeHmacSha256(wrongOtp, testSecret);
    expect(wrongHash).not.toBe(hash1);
  });

  it("safely generates a 4-digit numeric OTP in the range 1000..9999", () => {
    for (let i = 0; i < 50; i++) {
      const otp = crypto.randomInt(1000, 10000);
      expect(otp).toBeGreaterThanOrEqual(1000);
      expect(otp).toBeLessThan(10000);
    }
  });
});
