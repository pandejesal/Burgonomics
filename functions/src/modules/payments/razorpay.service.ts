import * as crypto from "crypto";
import * as admin from "firebase-admin";
import { db } from "../../core/firebase";
import { config } from "../../config/env";
import {
  verifyRazorpaySignature,
  computeHmacSha256,
  getOtpHmacSecret,
} from "../../core/security";
import { captureErrorSnapshot } from "../../core/errors";
import { calculateOrderPricing, CalculateOrderPricingInput } from "./pricing.engine";
import { getRazorpayClient, getRazorpayKeyId } from "./razorpayClient";
import {
  attemptRouteTransfer,
  retryPendingRouteTransfersWorker,
  calculateRouteSplit,
} from "./routeTransfers";

export { retryPendingRouteTransfersWorker, calculateRouteSplit } from "./routeTransfers";
export { getOtpHmacSecret };

export interface CreateOrderParams {
  orderId?: string;
  items: any[];
  branchId?: string;
  /** Delivery store id — resolved to a branch via stores/{id}.partnerBranchId. */
  storeId?: string;
  orderType: "delivery" | "takeaway" | "dinein";
  deliveryFee?: number;
  packagingFee?: number;
  couponCode?: string;
  loyaltyPointsToRedeem?: number;
  customerId: string;
  customerName?: string;
  customerPhone?: string;
  /** Stable per-checkout key: retries reuse the open gateway order. */
  idempotencyKey?: string;
}

/**
 * Resolves the branch for pricing, transfers, and KOT routing. Explicit
 * branchId wins; otherwise the delivery store record's linked branch.
 */
async function resolveBranchId(params: CreateOrderParams): Promise<string> {
  if (params.branchId) return params.branchId;
  if (params.storeId && db && typeof db.collection === "function") {
    try {
      const snap = await db.collection("stores").doc(params.storeId).get();
      const linked = snap.exists ? (snap.data() as any)?.partnerBranchId : undefined;
      if (typeof linked === "string" && linked) return linked;
    } catch (err) {
      console.warn("[Payments] store→branch resolution failed:", err);
    }
  }
  throw new Error("Branch could not be resolved for this store. Link the outlet first.");
}

/**
 * Creates a Razorpay server order with authoritative price calculation and route notes.
 */
export async function createPaymentOrder(params: CreateOrderParams) {
  const branchId = await resolveBranchId(params);

  // Idempotent retries: same key returns the already-open gateway order
  // instead of minting a second payable order (double-charge risk).
  if (params.idempotencyKey && db && typeof db.collection === "function") {
    try {
      const prior = await db.collection("payment_intents").doc(params.idempotencyKey).get();
      // Require a real stored order id — ghost/empty docs must not short-circuit.
      const data = (prior.exists ? (prior.data() as any) : undefined) as any;
      if (data?.razorpayOrderId) {
        return {
          razorpayOrderId: data.razorpayOrderId,
          amountPaise: data.amountPaise,
          amountRupees: data.amountPaise / 100,
          currency: "INR",
          receipt: data.receipt,
          pricing: data.pricing,
          keyId: getRazorpayKeyId(),
          reused: true as const,
        };
      }
    } catch (err: any) {
      // A failed lookup must not silently mint a second payable order: snapshot
      // it LOUD so ops sees the double-charge risk window. Fail-open (fresh
      // order) is deliberate — blocking checkout on a read blip strands payers.
      console.warn("[Payments] idempotency lookup failed, minting fresh order:", err?.message || err);
      const { captureErrorSnapshot } = await import("../../core/errors");
      await captureErrorSnapshot({
        source: "payments",
        severity: "high",
        message: "payment-intent idempotency lookup failed — minted fresh order (double-charge risk window)",
        errorStack: err?.stack,
      });
    }
  }

  const pricing = await calculateOrderPricing({
    items: params.items,
    branchId,
    orderType: params.orderType,
    deliveryFee: params.deliveryFee,
    packagingFee: params.packagingFee,
    couponCode: params.couponCode,
    loyaltyPointsToRedeem: params.loyaltyPointsToRedeem,
  });

  if (!(pricing.grandTotal > 0)) {
    throw new Error("INVALID_AMOUNT: order total must be greater than zero");
  }

  const amountPaise = Math.round(pricing.grandTotal * 100);
  const receipt = `rcpt_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 6)}`;

  let razorpayOrderId: string;

  if (config.mock.paymentGateway) {
    razorpayOrderId = `order_mock_${Date.now()}`;
  } else {
    try {
      const razorpay = getRazorpayClient();
      const rzpOrder = await razorpay.orders.create({
        amount: amountPaise,
        currency: "INR",
        receipt,
        // Required for Razorpay Route: transfers only execute on captured
        // payments of orders with partial payments disabled.
        partial_payment: false,
        notes: {
          orderId: params.orderId || "",
          branchId,
          customerId: params.customerId,
          orderType: params.orderType,
          brandRoyaltyPaise: pricing.split.brandRoyaltyPaise,
          branchTransferPaise: pricing.split.branchTransferPaise,
        },
      });
      razorpayOrderId = rzpOrder.id;
    } catch (err: any) {
      await captureErrorSnapshot({
        source: "payments",
        severity: "high",
        message: `Failed to create Razorpay order: ${err.message || err}`,
        errorStack: err.stack,
        branchId,
        customerId: params.customerId,
      });
      throw new Error(`Payment gateway order creation failed: ${err.message}`);
    }
  }

  if (params.idempotencyKey && db && typeof db.collection === "function") {
    try {
      await db.collection("payment_intents").doc(params.idempotencyKey).set(
        {
          razorpayOrderId,
          amountPaise,
          receipt,
          pricing,
          orderId: params.orderId || null,
          customerId: params.customerId,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    } catch (err) {
      console.warn("[Payments] idempotency store failed (non-blocking):", err);
    }
  }

  return {
    razorpayOrderId,
    amountPaise,
    amountRupees: pricing.grandTotal,
    currency: "INR",
    receipt,
    pricing,
    keyId: getRazorpayKeyId(),
  };
}

export interface VerifyPaymentParams {
  orderId: string;
  razorpayOrderId: string;
  razorpayPaymentId: string;
  razorpaySignature: string;
}

/**
 * Verifies Razorpay payment signature, executes Razorpay Route transfer split,
 * and updates order status.
 */
export async function verifyPayment(params: VerifyPaymentParams) {
  const { orderId, razorpayOrderId, razorpayPaymentId, razorpaySignature } = params;

  // 1. Signature verification
  let isValid = false;
  if (config.mock.paymentGateway) {
    isValid = razorpaySignature !== "force_fail";
  } else {
    isValid = verifyRazorpaySignature(
      razorpayOrderId,
      razorpayPaymentId,
      razorpaySignature,
      config.razorpay.keySecret
    );
  }

  if (!isValid) {
    await captureErrorSnapshot({
      source: "payments",
      severity: "high",
      message: "Razorpay HMAC payment signature verification failed",
      orderId,
      razorpayPaymentId,
    });
    throw new Error("Invalid payment signature");
  }

  // 2. Fetch order to perform Route split
  const orderRef = db.collection("orders").doc(orderId);
  const orderSnap = await orderRef.get();
  const orderData = orderSnap.data() || {};
  const branchId = orderData.branchId;

  let transferResult: any = null;

  // 3. Execute Razorpay Route split transfer if linked account exists.
  // Guard: a retried/concurrent verify must never double-transfer. Transfers
  // are keyed by payment — an already-transferred order reuses its result.
  if (orderData.routeTransferStatus === "transferred") {
    transferResult = orderData["payment.routeTransfer"] ?? orderData.payment?.routeTransfer ?? null;
  }
  const pricingSplit = orderData.pricing?.split;
  if (
    transferResult === null &&
    branchId &&
    pricingSplit &&
    pricingSplit.branchTransferPaise > 0
  ) {
    const attempt = await attemptRouteTransfer(razorpayPaymentId, branchId, pricingSplit, orderId);

    if (attempt.ok && attempt.result) {
      transferResult = attempt.result;
      await orderRef.set(
        {
          routeTransferStatus: "transferred",
          "payment.routeTransfer": attempt.result,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    } else if (!attempt.skipped) {
      await captureErrorSnapshot({
        source: "payments",
        severity: "high",
        message: `Razorpay Route transfer failed for order ${orderId}: ${attempt.error}`,
        orderId,
        branchId,
        razorpayPaymentId,
      });
      await orderRef.set(
        {
          routeTransferStatus: "pending_retry",
          routeTransferError: attempt.error,
          routeTransferRetryAt: admin.firestore.FieldValue.serverTimestamp(),
          routeTransferRetryCount: 0,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    }
  }

  // 4. Update order state in Firestore — crypto-secure OTP for India compliance
  const deliveryOtp =
    orderData.deliveryOtp ||
    (orderData.orderType === "delivery" || !orderData.orderType
      ? String(crypto.randomInt(1000, 10000))
      : undefined);

  // Canonical object form: Partner normalizes it, Delivery reads .code, and
  // server triggers accept both shapes. Never write a bare string status.
  const updatePayload: Record<string, any> = {
    paymentStatus: "completed",
    "payment.status": "completed",
    "payment.razorpayPaymentId": razorpayPaymentId,
    "payment.razorpayOrderId": razorpayOrderId,
    "payment.verifiedAt": admin.firestore.FieldValue.serverTimestamp(),
    status: {
      code: "CONFIRMED",
      label: "Order confirmed",
      kind: "upcoming",
      terminal: false,
    },
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  if (deliveryOtp) {
    updatePayload.deliveryOtpHash = computeHmacSha256(
      deliveryOtp,
      getOtpHmacSecret(config.razorpay.webhookSecret)
    );
  }

  await orderRef.set(updatePayload, { merge: true });

  // 5. Append payment audit
  const auditId = `aud_${Date.now()}_${razorpayPaymentId.substring(0, 10)}`;
  await db.collection("payment_audits").doc(auditId).set({
    orderId,
    razorpayOrderId,
    razorpayPaymentId,
    status: "success",
    action: "payment_captured",
    amountPaise: orderData.pricing?.grandTotal ? Math.round(orderData.pricing.grandTotal * 100) : null,
    transferResult,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return {
    success: true,
    confirmedOrderId: orderId,
    paymentId: razorpayPaymentId,
    transfer: transferResult,
    deliveryOtp,
  };
}

export interface RefundParams {
  orderId: string;
  razorpayPaymentId: string;
  amountRupees?: number;
  reason?: string;
}

/**
 * Executes a full or partial refund with proportional Route transfer reversal.
 */
export async function autoRefund(params: RefundParams) {
  const { orderId, razorpayPaymentId, amountRupees, reason } = params;

  const refundPayload: any = {
    reverse_all: true, // Automatically reverses split transfer proportionally from branch
    notes: {
      orderId,
      reason: reason || "Customer support resolution / item rejection",
    },
  };

  if (amountRupees && amountRupees > 0) {
    refundPayload.amount = Math.round(amountRupees * 100);
  }

  let refundResult: any;

  if (config.mock.paymentGateway) {
    refundResult = {
      id: `rfnd_mock_${Date.now()}`,
      payment_id: razorpayPaymentId,
      amount: refundPayload.amount || 10000,
      status: "processed",
    };
  } else {
    try {
      const razorpay = getRazorpayClient();
      refundResult = await razorpay.payments.refund(razorpayPaymentId, refundPayload);
    } catch (err: any) {
      await captureErrorSnapshot({
        source: "payments",
        severity: "high",
        message: `Refund execution failed for payment ${razorpayPaymentId}: ${err.message}`,
        orderId,
        razorpayPaymentId,
      });
      throw new Error(`Refund failed: ${err.message}`);
    }
  }

  // Update order record
  await db.collection("orders").doc(orderId).set(
    {
      refundStatus: "refunded",
      refundAmount: amountRupees,
      refundId: refundResult.id,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  // Append audit trail
  const auditId = `aud_rfnd_${Date.now()}_${refundResult.id}`;
  await db.collection("payment_audits").doc(auditId).set({
    orderId,
    razorpayPaymentId,
    refundId: refundResult.id,
    amountRupees,
    action: "refund_processed",
    reason,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return refundResult;
}
