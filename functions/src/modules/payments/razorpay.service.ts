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
  branchId: string;
  orderType: "delivery" | "takeaway" | "dinein";
  deliveryFee?: number;
  packagingFee?: number;
  couponCode?: string;
  loyaltyPointsToRedeem?: number;
  customerId: string;
  customerName?: string;
  customerPhone?: string;
}

/**
 * Creates a Razorpay server order with authoritative price calculation and route notes.
 */
export async function createPaymentOrder(params: CreateOrderParams) {
  const pricing = await calculateOrderPricing({
    items: params.items,
    branchId: params.branchId,
    orderType: params.orderType,
    deliveryFee: params.deliveryFee,
    packagingFee: params.packagingFee,
    couponCode: params.couponCode,
    loyaltyPointsToRedeem: params.loyaltyPointsToRedeem,
  });

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
          branchId: params.branchId,
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
        branchId: params.branchId,
        customerId: params.customerId,
      });
      throw new Error(`Payment gateway order creation failed: ${err.message}`);
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
  const pricingSplit = orderData.pricing?.split;
  if (branchId && pricingSplit && pricingSplit.branchTransferPaise > 0) {
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
