import { describe, it, expect, vi, afterEach } from "vitest";
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

  describe("OTP HMAC secret separation", () => {
    afterEach(() => {
      delete process.env.OTP_HMAC_SECRET;
    });

    it("prefers the dedicated OTP_HMAC_SECRET when set", () => {
      process.env.OTP_HMAC_SECRET = "otp_dedicated_secret";
      expect(getOtpHmacSecret("webhook_secret")).toBe("otp_dedicated_secret");
    });

    it("falls back to the webhook secret when unset", () => {
      expect(getOtpHmacSecret("webhook_secret")).toBe("webhook_secret");
    });
  });
});
