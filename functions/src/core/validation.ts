import { Request, Response, NextFunction } from "express";
import { z } from "zod";

/**
 * Request validation for money- and dispatch-critical routes.
 * Malformed bodies are rejected with 400 BEFORE any handler touches
 * Firestore, Razorpay, Petpooja, or Porter — fail fast, never half-apply.
 */

const nonEmptyString = z.string().min(1);
const optionalNonNegative = z.number().min(0).optional();

export const createPaymentOrderSchema = z.object({
  items: z.array(z.any()).min(1),
  branchId: nonEmptyString,
  orderType: z.enum(["delivery", "takeaway", "dinein"]),
  deliveryFee: optionalNonNegative,
  packagingFee: optionalNonNegative,
  couponCode: z.string().optional(),
  loyaltyPointsToRedeem: z.number().int().min(0).optional(),
  customerId: z.string().optional(),
  orderId: z.string().optional(),
});

export const verifyPaymentSchema = z.object({
  orderId: nonEmptyString,
  razorpayOrderId: nonEmptyString,
  razorpayPaymentId: nonEmptyString,
  razorpaySignature: nonEmptyString,
});

export const refundSchema = z.object({
  orderId: nonEmptyString,
  razorpayPaymentId: nonEmptyString,
  amountRupees: z.number().positive().optional(),
  reason: z.string().optional(),
});

export const pushOrderSchema = z.object({
  orderId: nonEmptyString,
});

export const syncMenuSchema = z.object({
  branchId: nonEmptyString,
});

export const pushStockSchema = z.object({
  branchId: nonEmptyString,
  itemId: nonEmptyString,
  inStock: z.boolean(),
});

export const porterBookSchema = z.object({
  orderId: nonEmptyString,
  staffName: z.string().optional(),
});

export const verifyDeliveryOtpSchema = z.object({
  orderId: nonEmptyString,
  otp: z.string().regex(/^\d{4}$/, "OTP must be exactly 4 digits"),
  staffName: z.string().optional(),
});

export const manualDispatchSchema = z.object({
  orderId: nonEmptyString,
  riderName: nonEmptyString,
  riderPhone: nonEmptyString,
  staffName: z.string().optional(),
  notes: z.string().optional(),
});

export function validateBody<T>(schema: z.ZodType<T>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid request body",
        details: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
      });
      return;
    }
    req.body = parsed.data;
    next();
  };
}
