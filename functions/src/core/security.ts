import * as crypto from "crypto";
import { Request } from "express";
import { auth } from "./firebase";
import * as admin from "firebase-admin";

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
 * Authenticates request using Firebase Auth Bearer token.
 */
export async function authenticateRequest(
  req: Request
): Promise<admin.auth.DecodedIdToken | null> {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return null;
  }
  const token = authHeader.split("Bearer ")[1];
  try {
    return await auth.verifyIdToken(token);
  } catch (err) {
    console.warn("[Security] Token verification failed:", err);
    return null;
  }
}
