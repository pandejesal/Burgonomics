import { createHmac } from "crypto";
import { computeHmacSha256, getOtpHmacSecret, isSafeDocId, timingSafeEqual } from "../../core/security";

type OrderRecord = Readonly<Record<string, unknown>>;

export class DeliveryOtpError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode: number = 409) {
    super(message);
    this.name = "DeliveryOtpError";
  }
}

export function assertDeliveryOrderId(orderId: unknown): asserts orderId is string {
  if (!isSafeDocId(orderId)) throw new DeliveryOtpError("INVALID_ORDER_ID", "Invalid order ID", 400);
}

function record(value: unknown): OrderRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as OrderRecord : {};
}

function normalized(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

const ACTIVE_DELIVERY_STATES = new Set([
  "confirmed", "accepted", "preparing", "ready", "ready_for_pickup", "out_for_delivery", "in_transit",
]);

/** Shared fresh-snapshot gate; neither client totals nor a claimed method prove payment. */
export function assertDeliveryOtpOrderActive(order: OrderRecord, handover = false): void {
  const status = record(order.status);
  const code = normalized(typeof order.status === "string" ? order.status : status.code);
  const deliveryStatus = normalized(order.deliveryStatus);
  const fulfillment = [order.orderType, order.fulfillmentType, order.fulfillment].filter((value) => value != null);
  if (fulfillment.length === 0 || fulfillment.some((value) => normalized(value) !== "delivery") ||
      !ACTIVE_DELIVERY_STATES.has(code) || status.terminal === true || order.terminal === true ||
      ["completed", "cancelled", "failed"].includes(normalized(status.kind)) ||
      ["delivered", "cancelled", "canceled", "cancelling", "refunded"].includes(deliveryStatus) ||
      order.deliveryOtpConsumedAt != null || order.deliveredAt != null || order.cancelledAt != null ||
      (order.cancellationStatus != null && !["", "none"].includes(normalized(order.cancellationStatus)))) {
    throw new DeliveryOtpError("DELIVERY_OTP_UNAVAILABLE", "Delivery handover is not available for this order");
  }
  if (handover && !["out_for_delivery", "in_transit"].includes(code) &&
      !["dispatched", "in_transit", "arrived", "at_drop"].includes(deliveryStatus)) {
    throw new DeliveryOtpError("DELIVERY_NOT_DISPATCHED", "This delivery has not been dispatched for handover");
  }

  const payment = record(order.payment);
  // Owner decision 2026-11-20: cash on delivery is a launch lane. A COD order
  // has NO gateway receipt by design, so the razorpay proof below cannot apply
  // to it. The equivalent server proof is the `paymentChannel: "cash"` marker
  // written by `orders/createCashOrder` (never by a client) plus the
  // server-computed collectible amount it stamped. Everything else — the
  // method, the pending status, the refund markers — is checked exactly as
  // strictly as the gateway lane.
  const isCashOrder = order.paymentChannel === "cash";
  const method = normalized(
    payment.method ?? order.paymentMethod ?? order.orderPaymentMethod
  );
  let paymentBasisPaise: number;
  let capturePaymentId: unknown = null;
  if (isCashOrder) {
    const due = order.cashDuePaise;
    const paymentStatuses = [payment.status, order["payment.status"], order.paymentStatus].filter(
      (value) => value != null
    );
    if (
      (method !== "cod" && method !== "cash") ||
      typeof due !== "number" ||
      !Number.isSafeInteger(due) ||
      due <= 0 ||
      paymentStatuses.some((value) =>
        ["completed", "captured", "paid"].includes(normalized(value))
      ) ||
      order.cashCollectedAt != null ||
      order.cashCollectedPaise != null
    ) {
      throw new DeliveryOtpError(
        "ORDER_NOT_PAID",
        "This cash order has no server-recorded amount to collect — the hand-over cannot be confirmed"
      );
    }
    paymentBasisPaise = due;
  } else {
    const amounts = [payment.capturedAmountPaise, order["payment.capturedAmountPaise"]].filter((value) => value != null);
    const paymentIds = [payment.razorpayPaymentId, order["payment.razorpayPaymentId"], order.razorpayPaymentId,
      order.capturedPaymentId].filter((value) => value != null);
    const paymentStatuses = [payment.status, order["payment.status"], order.paymentStatus].filter((value) => value != null);
    if (order.paymentChannel !== "razorpay" || amounts.length === 0 ||
        amounts.some((value) => typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value !== amounts[0]) ||
        paymentIds.length === 0 || paymentIds.some((value) => !isSafeDocId(value) || value !== paymentIds[0]) ||
        paymentStatuses.length === 0 || paymentStatuses.some((value) => !["completed", "captured", "paid"].includes(normalized(value)))) {
      throw new DeliveryOtpError("ORDER_NOT_PAID", "A verified captured payment is required for delivery handover");
    }
    paymentBasisPaise = Number(amounts[0]);
    capturePaymentId = paymentIds[0];
  }
  const capture = record(order.captureFulfillment);
  const refundStatuses = [order.refundStatus, payment.refundStatus, order["payment.refundStatus"]].filter((value) => value != null);
  const refunded = order.refundedTotalPaise;
  if (refundStatuses.some((value) => !["", "none", "partially_refunded"].includes(normalized(value))) ||
      order.refundActiveClaim != null || order.refundClaimedAt != null ||
      (refunded != null && (typeof refunded !== "number" || !Number.isSafeInteger(refunded) || refunded < 0 || refunded >= paymentBasisPaise)) ||
      (order.captureFulfillment != null && (capture.state !== "fulfillable" || capture.paymentId !== capturePaymentId)) ||
      (order.captureFulfillmentState != null && !["confirmed", "fulfillable"].includes(normalized(order.captureFulfillmentState))) ||
      order.reconciliation != null) {
    throw new DeliveryOtpError("DELIVERY_OTP_UNAVAILABLE", "Delivery handover is unavailable while payment requires review");
  }
}

/** Only v2 is recoverable. Historical random verifiers are never searched or replaced. */
export function readVersionedDeliveryOtp(order: OrderRecord, canonicalOrderId: string): string {
  if (order.deliveryOtpVersion == null) {
    throw new DeliveryOtpError("LEGACY_OTP_UNAVAILABLE", "This older delivery code cannot be reopened");
  }
  if (order.deliveryOtpVersion !== 2 || !hasDeliveryOtpHash(order)) {
    throw new DeliveryOtpError("DELIVERY_OTP_UNAVAILABLE", "Delivery code is not available");
  }
  const storedHash = typeof order.deliveryOtpHash === "string" ? order.deliveryOtpHash.trim() : "";
  const otp = deriveDeliveryOtp(canonicalOrderId);
  const expectedHash = computeDeliveryOtpHash(otp, canonicalOrderId, 2);
  if (!timingSafeEqual(expectedHash, storedHash)) {
    throw new DeliveryOtpError("DELIVERY_OTP_UNAVAILABLE", "Delivery code could not be verified");
  }
  return otp;
}

export interface MintedDeliveryOtp {
  readonly otp: string;
  readonly deliveryOtpHash: string;
  readonly deliveryOtpVersion: 2;
}

/** Preserve mint eligibility for paid legacy delivery docs without orderType. */
export function isDeliveryOtpEligible(order: OrderRecord): boolean {
  const orderType = typeof order.orderType === "string" ? order.orderType.trim() : order.orderType;
  return orderType === "delivery" || !orderType;
}

export function hasDeliveryOtpHash(order: OrderRecord): boolean {
  return typeof order.deliveryOtpHash === "string" && order.deliveryOtpHash.length > 0;
}

/**
 * Verifier payload calculation.
 * For v2, binds the canonical order ID into the HMAC payload ("v2:<orderId>:<otp>")
 * to eliminate pre-computation / inversion across orders.
 * Legacy unversioned codes continue to use the unsalted payload ("<otp>") byte-for-byte.
 */
export function computeDeliveryOtpHash(
  otp: string,
  canonicalOrderId?: string,
  version?: number | null
): string {
  const secret = getOtpHmacSecret();
  if (version === 2) {
    if (!canonicalOrderId || !isSafeDocId(canonicalOrderId)) {
      throw new Error("Invalid canonical order ID for delivery OTP verifier");
    }
    return computeHmacSha256(`v2:${canonicalOrderId}:${otp}`, secret);
  }
  return computeHmacSha256(otp, secret);
}

/** Version/domain separation keeps derivation distinct from the existing verifier. */
export function deriveDeliveryOtp(canonicalOrderId: string): string {
  if (!isSafeDocId(canonicalOrderId)) throw new Error("Invalid canonical order ID for delivery handover");
  const digest = createHmac("sha256", getOtpHmacSecret())
    .update(`burgonomics:delivery-otp:v2\0${canonicalOrderId}`)
    .digest();
  return String(1000 + digest.readUInt32BE(0) % 9000);
}

/**
 * F6: the COD delivery hand-over proof.
 *
 * A paid delivery gets its code from the gateway capture (verify + webhook).
 * A cash-on-delivery order has NO gateway receipt by design, so the capture
 * paths can never fire for it and it used to reach the door with no code at
 * all: the customer's own screen answered LEGACY_OTP_UNAVAILABLE and the
 * branch could only complete it with a brand-level override, leaving "cash
 * collected at hand-off" unreachable.
 *
 * So the code is minted at the SAME lifecycle point — the moment the order is
 * confirmed/allowed into the kitchen — from the server-owned proofs this lane
 * actually has: the `paymentChannel: "cash"` marker (which only
 * `orders/createCashOrder` writes) and the amount it stamped. Callers still go
 * through `mintDeliveryOtp`, so an existing code is never replaced and a
 * consumed one is never reissued.
 */
export function mintCashDeliveryOtp(
  order: OrderRecord,
  canonicalOrderId: string
): MintedDeliveryOtp | undefined {
  if (order.paymentChannel !== "cash") return undefined;
  const due = order.cashDuePaise;
  if (typeof due !== "number" || !Number.isSafeInteger(due) || due <= 0) return undefined;
  // Already handed over: the code was burnt and the cash is in the branch's hand.
  if (order.cashCollectedAt != null || order.cashCollectedPaise != null) return undefined;
  const payment = record(order.payment);
  const statuses = [payment.status, order["payment.status"], order.paymentStatus].filter(
    (value) => value != null
  );
  if (statuses.some((value) => ["completed", "captured", "paid"].includes(normalized(value)))) {
    return undefined;
  }
  return mintDeliveryOtp(order, canonicalOrderId);
}

/** Never reissue historical codes, unknown versions, or consumed verifiers. */
export function mintDeliveryOtp(order: OrderRecord, canonicalOrderId: string): MintedDeliveryOtp | undefined {
  if (!isDeliveryOtpEligible(order) || hasDeliveryOtpHash(order) ||
      order.deliveryOtp != null || order.deliveryOtpVersion != null || order.deliveryOtpConsumedAt != null) {
    return undefined;
  }
  const otp = deriveDeliveryOtp(canonicalOrderId);
  return { otp, deliveryOtpHash: computeDeliveryOtpHash(otp, canonicalOrderId, 2), deliveryOtpVersion: 2 };
}
