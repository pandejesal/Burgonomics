import { Request, Response, NextFunction } from "express";
import { z } from "zod";

/**
 * Request validation for money- and dispatch-critical routes.
 * Malformed bodies are rejected with 400 BEFORE any handler touches
 * Firestore, Razorpay, Petpooja, or Porter — fail fast, never half-apply.
 */

const nonEmptyString = z.string().min(1);
// Finite + capped: Infinity/NaN used to flow into Math.max(0, x) and produce
// Infinity totals downstream. Cap matches the per-line-item ceiling.
const optionalNonNegative = z.number().finite().min(0).max(100000).optional();

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

// PAYMENTS_CONTRACT_SPEC §1: `orderType` stays canonical; `fulfillment` is a
// backward-compatible alias with two legacy spellings mapped onto the canonical
// enum ("pickup" -> takeaway, "dine-in" -> dinein).
const canonicalOrderType = z.enum(["delivery", "takeaway", "dinein"]);
const fulfillmentAlias = z.enum(["delivery", "takeaway", "dinein", "pickup", "dine-in"]);

/** Maps the wire shapes ({orderType} | legacy {fulfillment}) to the canonical enum. */
export function normalizeOrderType(input: {
  orderType?: "delivery" | "takeaway" | "dinein";
  fulfillment?: "delivery" | "takeaway" | "dinein" | "pickup" | "dine-in";
}): "delivery" | "takeaway" | "dinein" {
  if (input.orderType) return input.orderType;
  switch (input.fulfillment) {
    case "pickup":
      return "takeaway";
    case "dine-in":
      return "dinein";
    default:
      // Schema-guaranteed: delivery | takeaway | dinein.
      return input.fulfillment as "delivery" | "takeaway" | "dinein";
  }
}

export const createPaymentOrderSchema = z
  .object({
    items: z.array(pricingLineItemSchema).min(1).max(100),
    branchId: z.string().min(1).optional(),
    storeId: z.string().min(1).optional(),
    orderType: canonicalOrderType.optional(),
    fulfillment: fulfillmentAlias.optional(),
    deliveryFee: optionalNonNegative,
    packagingFee: optionalNonNegative,
    couponCode: z.string().trim().max(64).optional(),
    loyaltyPointsToRedeem: z.number().int().min(0).max(100000).optional(),
    // Kept for shape compatibility ONLY — the route binds customerId from the
    // verified token (or "guest"); a body customerId is never honoured.
    customerId: z.string().optional(),
    // REQUIRED (PAYMENTS_CONTRACT_SPEC §1): the server verifies the internal
    // orders/{orderId} doc exists AND is unpaid AND owned by the caller
    // BEFORE minting a payable gateway order. No internal id, no checkout.
    orderId: nonEmptyString,
    idempotencyKey: z.string().min(8).max(128).optional(),
  })
  .refine((d) => d.branchId || d.storeId, {
    message: "branchId or storeId is required",
  })
  .refine((d) => !!d.orderType || !!d.fulfillment, {
    message: "orderType (or fulfillment alias) is required",
  });

// PAYMENTS_CONTRACT_SPEC §2: canonical wire names, plus the legacy
// checkout-shim body { paymentId, orderId, signature, method } where the lone
// orderId is the GATEWAY order id (the internal order id resolves server-side
// through the payment-intent record keyed by razorpayOrderId). `method` is
// accepted and ignored — old clients always sent it.
export const verifyPaymentSchema = z
  .object({
    orderId: nonEmptyString,
    razorpayOrderId: nonEmptyString,
    razorpayPaymentId: nonEmptyString,
    // Empty is ALLOWED through validation on purpose: a missing/blank
    // signature is an auth failure, not a malformed body, and must answer
    // 401 INVALID_SIGNATURE from the HMAC layer (verifyRazorpaySignature
    // refuses any falsy signature before touching an order) instead of a
    // generic 400 validation error.
    razorpaySignature: z.string(),
  })
  .or(
    z.object({
      paymentId: nonEmptyString,
      orderId: nonEmptyString,
      signature: z.string(),
      method: z.string().max(32).optional(),
    })
  );

export const refundSchema = z.object({
  orderId: nonEmptyString,
  razorpayPaymentId: nonEmptyString,
  amountRupees: z.number().finite().positive().max(100000).optional(),
  reason: z.string().max(2000).optional(),
});

// Loop 7/120: refund-request disposition (reject path). Reason is REQUIRED —
// a rejection without a recorded reason is a silent decision.
export const disposeRefundSchema = z.object({
  refundId: nonEmptyString,
  reason: nonEmptyString,
});

// Loop 25/120: discrepancy resolution. Resolution label + optional note are
// recorded server-side; unresolved rows are the ops review queue.
export const resolveDiscrepancySchema = z.object({
  discrepancyId: nonEmptyString,
  resolution: nonEmptyString,
  note: z.string().max(500).optional(),
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

// MT-01: Petpooja sandbox test relay. scenarioId is bounded (not enum'd) so
// new sandbox scenarios can ship without a schema change — the runner itself
// rejects unknown ids with the valid catalog in the error message.
export const petpoojaTestRunnerSchema = z.object({
  scenarioId: z.string().min(1),
  branchId: z.string().optional(),
});

export const porterBookSchema = z.object({
  orderId: nonEmptyString,
  staffName: z.string().max(128).optional(),
});

export const porterCancelSchema = z.object({
  orderId: nonEmptyString,
  staffName: z.string().max(128).optional(),
});

const optionalLatitude = z.number().finite().min(-90).max(90).optional();
const optionalLongitude = z.number().finite().min(-180).max(180).optional();

export const porterQuoteSchema = z.object({
  pickupLat: optionalLatitude,
  pickupLng: optionalLongitude,
  dropLat: optionalLatitude,
  dropLng: optionalLongitude,
  customerName: z.string().max(120).optional(),
  customerPhone: z.string().max(32).optional(),
});

// ---- Multi-provider dispatch (references/delivery_routing.md) ----

const latitude = z.number().finite().min(-90).max(90);
const longitude = z.number().finite().min(-180).max(180);

// Pre-order quote: coordinates are REQUIRED — the radius gate cannot run on
// undefined, and a missing drop lat/lng would fan out providers with a
// garbage point.
export const dispatchQuoteSchema = z.object({
  pickupLat: latitude,
  pickupLng: longitude,
  dropLat: latitude,
  dropLng: longitude,
  customerName: z.string().max(120).optional(),
  customerPhone: z.string().max(32).optional(),
  orderId: z.string().max(64).optional(),
});

export const dispatchBookSchema = z.object({
  orderId: nonEmptyString,
  staffName: z.string().max(128).optional(),
  // Staff-confirmed fare from the quote card — gates the DR7 delta check.
  quotedFare: z.number().finite().min(0).max(100000).optional(),
  confirmFare: z.boolean().optional(),
  preferredProvider: z.enum(["borzo", "shadowfax", "porter"]).optional(),
});

export const dispatchRebookSchema = z.object({
  orderId: nonEmptyString,
  staffName: z.string().max(128).optional(),
  quotedFare: z.number().finite().min(0).max(100000).optional(),
  confirmFare: z.boolean().optional(),
  preferredProvider: z.enum(["borzo", "shadowfax", "porter"]).optional(),
});

export const dispatchPorterManualSchema = z.object({
  orderId: nonEmptyString,
  porterOrderId: z.string().min(1).max(64),
  trackingUrl: z.string().max(512).optional(),
  staffName: z.string().max(128).optional(),
});

export const dispatchCancelSchema = z.object({
  orderId: nonEmptyString,
  staffName: z.string().max(128).optional(),
});

export const verifyDeliveryOtpSchema = z.object({
  orderId: nonEmptyString,
  otp: z.string().regex(/^\d{4}$/, "OTP must be exactly 4 digits"),
  staffName: z.string().optional(),
});

export const manualDispatchSchema = z.object({
  orderId: nonEmptyString,
  riderName: z.string().min(1).max(120),
  riderPhone: z.string().min(1).max(32),
  staffName: z.string().max(128).optional(),
  notes: z.string().max(500).optional(),
});

export const orderBumpSchema = z.object({
  orderId: nonEmptyString,
  status: z.enum([
    "pending",
    "accepted",
    "preparing",
    "ready",
    "out_for_delivery",
    "delivered",
    "cancelled",
    "placed",
    "ready_for_pickup",
  ]),
  cancellationReason: z.string().trim().min(1).max(500).optional(),
  /**
   * Optimistic-concurrency precondition (partner KDS/detail send the
   * status.code their screen is showing). When present the server only applies
   * the bump if it still matches — a stale screen or a delayed double-tap can
   * no longer overwrite a newer status written by another staff member.
   */
  expectedStatus: z.string().trim().max(64).optional(),
  timelineEvent: z
    .object({
      title: z.string().trim().min(1).max(120),
      actor: z.string().trim().min(1).max(120).optional(),
      description: z.string().trim().min(1).max(500).optional(),
    })
    .optional(),
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

export const resolveNoteSchema = z.object({
  ticketId: nonEmptyString,
  resolution: z.string().trim().min(1).max(2000),
});

// MOP-S1 (B5-S1 follow-up): mark-read intake. Empty body marks the whole
// unread inbox; explicit ids mark only those (capped at 200, service-side).
export const markReadSchema = z.object({
  notificationIds: z.array(z.string().min(1).max(256)).max(200).optional(),
});

// Notification dispatch: exactly one of topic or token, bounded copy.
export const dispatchNotificationSchema = z.object({
  topic: z.string().min(1).max(128).optional(),
  token: z.string().min(1).max(256).optional(),
  title: z.string().min(1).max(120),
  body: z.string().min(1).max(500),
  data: z.record(z.string(), z.string()).optional(),
}).refine((d) => (d.topic ? 1 : 0) + (d.token ? 1 : 0) === 1, {
  message: "exactly one of topic or token is required",
});

// Notification token registration
export const registerTokenSchema = z.object({
  token: z.string().min(10).max(500),
  platform: z.enum(["ios", "android", "web"]).optional(),
  appVersion: z.string().max(64).optional(),
});

// Token unregistration
export const unregisterTokenSchema = z.object({
  token: z.string().min(10).max(500),
});

// Topic subscription/unsubscription
export const topicSubscriptionSchema = z.object({
  token: z.string().min(10).max(500),
  topics: z.array(z.string().min(1).max(128)).min(1).max(50),
});

// Auth: set custom claims
export const setClaimsSchema = z.object({
  targetUid: z.string().min(1).max(128),
  role: z.enum(["brand_owner", "developer", "support", "regional_manager", "branch_owner", "branch_staff"]),
  branchIds: z.array(z.string().min(1).max(128)).max(50).optional(),
});

// Auth: assign/revoke role
export const assignRoleSchema = z.object({
  targetUid: z.string().min(1).max(128),
  role: z.enum(["support", "regional_manager", "branch_owner", "branch_staff"]),
  branchIds: z.array(z.string().min(1).max(128)).max(50).optional(),
});

export const revokeRoleSchema = z.object({
  targetUid: z.string().min(1).max(128),
});

// Auth: migrate guest. FIX2 (C1): this route schema previously kept only
// {permanentUid, phone, email} and validateBody REPLACED req.body with that
// subset - the service never saw guestSessionId/anonymousUid/name/addresses/
// guestProof and the endpoint silently migrated NOTHING while still answering
// success:true. The route now binds the SERVICE's own bounded schema
// (modules/auth/guestMigration.schema.ts, pure zod) so every accepted field
// reaches the service, with caps and .strict() making oversized/unknown
// payloads a loud 400 instead of a truncated relink.
export { MigrateGuestSchema as migrateGuestSchema } from "../modules/auth/guestMigration.schema";

// Auth: verify bonus eligibility
export const verifyBonusSchema = z.object({
  phone: z.string().min(6).max(20),
  uid: z.string().min(1).max(128).optional(),
});

// Auth: delete account
export const deleteAccountSchema = z.object({
  confirm: z.literal(true),
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
