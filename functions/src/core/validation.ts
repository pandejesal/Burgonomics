import { Request, Response, NextFunction } from "express";
import { z } from "zod";

/**
 * Request validation for money- and dispatch-critical routes.
 * Malformed bodies are rejected with 400 BEFORE any handler touches
 * Firestore, Razorpay, Petpooja, or Porter — fail fast, never half-apply.
 */

const nonEmptyString = z.string().min(1);
const optionalNonNegative = z.number().min(0).optional();

const pricingLineItemSchema = z.object({
  id: z.string().min(1).optional(),
  productId: z.string().min(1).optional(),
  name: z.string().max(200).optional(),
  // Finite, sane bounds: price "abc"/NaN/Infinity and quantity 0/negative
  // used to coerce into free items or phantom +1 units downstream.
  price: z.number().finite().min(0).max(100000),
  quantity: z.number().int().min(1).max(99),
  customizations: z
    .array(z.object({ price: z.number().finite().min(0).max(100000) }).passthrough())
    .optional(),
  modifiers: z
    .array(z.object({ priceDelta: z.number().finite().min(0).max(100000) }).passthrough())
    .optional(),
});

export const createPaymentOrderSchema = z
  .object({
    items: z.array(pricingLineItemSchema).min(1).max(100),
    branchId: z.string().min(1).optional(),
    storeId: z.string().min(1).optional(),
    orderType: z.enum(["delivery", "takeaway", "dinein"]),
    deliveryFee: optionalNonNegative,
    packagingFee: optionalNonNegative,
    couponCode: z.string().optional(),
    loyaltyPointsToRedeem: z.number().int().min(0).optional(),
    customerId: z.string().optional(),
    orderId: z.string().optional(),
    idempotencyKey: z.string().min(8).max(128).optional(),
  })
  .refine((d) => d.branchId || d.storeId, {
    message: "branchId or storeId is required",
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

const optionalCoord = z.number().finite().optional();

export const porterQuoteSchema = z.object({
  pickupLat: optionalCoord,
  pickupLng: optionalCoord,
  dropLat: optionalCoord,
  dropLng: optionalCoord,
  customerName: z.string().optional(),
  customerPhone: z.string().optional(),
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

export const adjustCoinsSchema = z.object({
  customerId: nonEmptyString,
  delta: z.number().int().min(-5000).max(5000).refine((n) => n !== 0, {
    message: "delta cannot be zero",
  }),
  reason: z.string().trim().min(3).max(200),
  notes: z.string().max(500).optional(),
});

// ---------------------------------------------------------------------------
// B5-S1 support tickets + franchise leads (spam/abuse guards live in the
// service; these schemas enforce shape + length at the route boundary so
// unbounded free-text never reaches Firestore or a lock-screen push body).
// ---------------------------------------------------------------------------

const ticketCategorySchema = z.enum([
  "wrong_item",
  "late_delivery",
  "food_quality",
  "payment_issue",
  "app_bug",
  "general_inquiry",
]);

export const createTicketSchema = z.object({
  customerId: z.string().min(1).max(128).optional(),
  customerName: z.string().trim().min(1).max(120),
  customerPhone: z.string().trim().max(20).optional(),
  orderId: z.string().min(1).max(128).optional(),
  branchId: z.string().min(1).max(128),
  category: ticketCategorySchema,
  priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
  subject: z.string().trim().min(4).max(120),
  description: z.string().trim().min(1).max(2000),
  attachments: z.array(z.string().url().max(500)).max(5).optional(),
});

export const ticketMessageSchema = z.object({
  ticketId: nonEmptyString,
  senderId: z.string().min(1).max(128).optional(),
  senderName: z.string().trim().min(1).max(120).optional(),
  text: z.string().trim().min(1).max(2000),
});

export const resolveTicketSchema = z.object({
  ticketId: nonEmptyString,
  resolvedBy: z.string().min(1).max(128).optional(),
  resolvedByName: z.string().trim().min(1).max(120).optional(),
  action: z.enum(["full_refund", "partial_refund", "discount_coupon", "loyalty_credit", "explanation"]),
  amount: z.number().finite().min(0).max(100000).optional(),
  couponCode: z.string().trim().min(1).max(64).optional(),
  notes: z.string().trim().min(1).max(2000),
});

export const escalateTicketSchema = z.object({
  ticketId: nonEmptyString,
  targetTier: z.enum(["brand_support", "developer_team"]),
  reason: z.string().trim().min(3).max(1000),
  escalatedBy: z.string().min(1).max(128).optional(),
  escalatedByName: z.string().trim().min(1).max(120).optional(),
});

// Franchise lead intake: customerId MUST equal the caller UID (rules bind it
// too) — kills victim-id stamping at both layers (M14 follow-up).
export const franchiseLeadSchema = z.object({
  customerId: nonEmptyString,
  name: z.string().trim().min(1).max(120),
  phone: z.string().trim().min(6).max(20),
  city: z.string().trim().min(1).max(120),
  message: z.string().trim().max(2000).optional(),
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
