import * as crypto from "crypto";

/**
 * Timing-safe string equality comparison to prevent timing attacks.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") {
    return false;
  }
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Computes SHA256 HMAC.
 */
export function computeHmacSha256(payload: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

/**
 * Timing-safe Razorpay payment signature verification.
 */
export function verifyRazorpaySignature(
  orderId: string,
  paymentId: string,
  signature: string,
  secret: string
): boolean {
  if (!orderId || !paymentId || !signature || !secret) {
    return false;
  }
  const expectedSignature = computeHmacSha256(`${orderId}|${paymentId}`, secret);
  return timingSafeEqual(expectedSignature, signature);
}

/**
 * Timing-safe Razorpay Webhook signature verification.
 */
export function verifyRazorpayWebhookSignature(
  rawBody: string,
  signature: string,
  secret: string
): boolean {
  if (!rawBody || !signature || !secret) {
    return false;
  }
  const expectedSignature = computeHmacSha256(rawBody, secret);
  return timingSafeEqual(expectedSignature, signature);
}

/**
 * Timing-safe Porter webhook signature verification.
 */
export function verifyPorterWebhookSignature(
  rawBody: string,
  signature: string,
  secret: string
): boolean {
  if (!rawBody || !signature || !secret) {
    return false;
  }
  const expectedSignature = computeHmacSha256(rawBody, secret);
  return timingSafeEqual(expectedSignature, signature);
}

/**
 * Dedicated HMAC secret for delivery OTP hashes — FAIL-CLOSED (H-M24/C4/M16).
 * Throws when OTP_HMAC_SECRET is unset/empty. The Razorpay webhook secret is
 * NEVER reused: sharing one secret across OTPs and webhooks means a webhook
 * rotation invalidates outstanding OTPs (or a leaked OTP hash weakens webhook
 * trust). Set OTP_HMAC_SECRET before going live; see functions/.env.example.
 */
export function getOtpHmacSecret(): string {
  const dedicated = process.env.OTP_HMAC_SECRET;
  if (!dedicated) {
    throw new Error(
      "FATAL: OTP_HMAC_SECRET is unset — set a dedicated OTP HMAC secret in " +
        "functions/.env. The Razorpay webhook secret is never reused for OTPs."
    );
  }
  return dedicated;
}


