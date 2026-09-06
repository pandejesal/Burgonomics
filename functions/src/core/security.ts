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

let otpSecretFallbackWarned = false;

/**
 * Dedicated HMAC secret for delivery OTP hashes. Falls back to the Razorpay
 * webhook secret only when OTP_HMAC_SECRET is unset (warns once) so existing
 * hashes keep verifying until ops sets the dedicated secret — after which
 * the webhook secret can rotate freely without invalidating OTPs.
 */
export function getOtpHmacSecret(webhookSecret: string): string {
  const dedicated = process.env.OTP_HMAC_SECRET;
  if (dedicated) return dedicated;
  if (!otpSecretFallbackWarned) {
    otpSecretFallbackWarned = true;
    console.warn(
      "[security] OTP_HMAC_SECRET unset — falling back to webhook secret. " +
        "Set a dedicated OTP_HMAC_SECRET so webhook rotation never invalidates OTPs."
    );
  }
  return webhookSecret;
}


