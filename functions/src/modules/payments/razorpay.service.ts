import * as crypto from "crypto";
import { db } from "../../core/firebase";
import { config } from "../../config/env";
import { verifyRazorpaySignature, computeHmacSha256 } from "../../core/security";
import { captureErrorSnapshot } from "../../core/errors";
import { calculateOrderPricing, CalculateOrderPricingInput } from "./pricing.engine";
import * as admin from "firebase-admin";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const Razorpay = require("razorpay");

export function getRazorpayClient() {
  if (config.mock.paymentGateway) {
    return null;
  }
  return new Razorpay({
    key_id: config.razorpay.keyId,
    key_secret: config.razorpay.keySecret,
  });
}

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
        notes: {
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
    keyId: config.mock.paymentGateway ? "rzp_test_mockKey123" : config.razorpay.keyId,
  };
}

export interface VerifyPaymentParams {
  orderId: string;
  razorpayOrderId: string;
  razorpayPaymentId: string;
  razorpaySignature: string;
}

interface RoutePricingSplit {
  branchTransferPaise: number;
  brandRoyaltyAmount: number;
}

interface RouteTransferAttempt {
  ok: boolean;
  skipped?: boolean;
  result?: any;
  error?: string;
}

/**
 * Executes a Razorpay Route transfer split for a captured payment.
 * Never throws — returns a structured attempt result so the caller can decide
 * how to persist the outcome (success, pending retry, or skipped).
 */
async function attemptRouteTransfer(
  paymentId: string,
  branchId: string,
  pricingSplit: RoutePricingSplit,
  orderId: string
): Promise<RouteTransferAttempt> {
  try {
    const branchSnap = await db.collection("branches").doc(branchId).get();
    const branchData = branchSnap.data();
    const razorpayAccountId = branchData?.razorpayAccountId;

    if (!razorpayAccountId || !pricingSplit || pricingSplit.branchTransferPaise <= 0) {
      return {
        ok: false,
        skipped: true,
        error: "No linked Razorpay account or transfer amount for branch",
      };
    }

    if (config.mock.paymentGateway) {
      return {
        ok: true,
        result: {
          id: `trf_mock_${Date.now()}`,
          account: razorpayAccountId,
          amount: pricingSplit.branchTransferPaise,
          status: "processed",
        },
      };
    }

    const razorpay = getRazorpayClient();
    const result = await razorpay.payments.transfer(paymentId, {
      transfers: [
        {
          account: razorpayAccountId,
          amount: pricingSplit.branchTransferPaise,
          currency: "INR",
          notes: {
            orderId,
            branchId,
            brandRoyalty: pricingSplit.brandRoyaltyAmount,
          },
          linked_account_notes: ["orderId"],
          on_hold: 0,
        },
      ],
    });
    return { ok: true, result };
  } catch (err: any) {
    return { ok: false, error: (err as any)?.message || String(err) };
  }
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
  //    Failures are marked pending_retry for the retry worker — brand royalty
  //    reconciliation must not be lost; the buyer flow continues regardless.
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

  const updatePayload: Record<string, any> = {
    paymentStatus: "completed",
    "payment.status": "completed",
    "payment.razorpayPaymentId": razorpayPaymentId,
    "payment.razorpayOrderId": razorpayOrderId,
    "payment.verifiedAt": admin.firestore.FieldValue.serverTimestamp(),
    status: "accepted",
    "status.kind": "accepted",
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  if (deliveryOtp) {
    // Crypto-secure OTP storage for India compliance — only the HMAC-SHA256
    // hash is persisted; the raw OTP is returned once in the response.
    updatePayload.deliveryOtpHash = computeHmacSha256(deliveryOtp, config.razorpay.webhookSecret);
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

/**
 * Retries pending Razorpay Route transfers for orders marked pending_retry.
 * Runs on a schedule (see index.ts retryRouteTransfers) and never throws —
 * each order is handled independently so one failure cannot block the batch.
 */
export async function retryPendingRouteTransfersWorker() {
  const pendingSnap = await db
    .collection("orders")
    .where("routeTransferStatus", "==", "pending_retry")
    .where("routeTransferRetryCount", "<=", 3)
    .limit(20)
    .get();

  let retriedCount = 0;

  for (const doc of pendingSnap.docs) {
    const order = doc.data();
    const orderId = doc.id;
    const branchId = order.branchId;
    const pricingSplit = order.pricing?.split;
    const paymentId =
      order.payment?.razorpayPaymentId || order.razorpayPaymentId || order["payment.razorpayPaymentId"];

    try {
      if (!branchId || !pricingSplit || pricingSplit.branchTransferPaise <= 0 || !paymentId) {
        await doc.ref.set(
          {
            routeTransferStatus: "failed",
            routeTransferError: "Missing branch, pricing split, or payment id for route transfer retry",
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
        continue;
      }

      const attempt = await attemptRouteTransfer(paymentId, branchId, pricingSplit, orderId);

      if (attempt.skipped) {
        // No linked Razorpay account — this order can never be transferred.
        await doc.ref.set(
          {
            routeTransferStatus: "failed",
            routeTransferError: attempt.error,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
        continue;
      }

      if (!attempt.ok) {
        const prevRetryCount =
          typeof order.routeTransferRetryCount === "number" ? order.routeTransferRetryCount : 0;
        const nextRetryCount = prevRetryCount + 1;
        const exhausted = nextRetryCount > 3;

        await doc.ref.set(
          {
            routeTransferRetryCount: admin.firestore.FieldValue.increment(1),
            routeTransferError: attempt.error,
            routeTransferRetryAt: admin.firestore.FieldValue.serverTimestamp(),
            ...(exhausted
              ? {
                  routeTransferStatus: "failed",
                  updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                }
              : {}),
          },
          { merge: true }
        );

        if (exhausted) {
          await captureErrorSnapshot({
            source: "payments",
            severity: "high",
            message: `Route transfer retries exhausted for order ${orderId}: ${attempt.error}`,
            orderId,
            branchId,
            razorpayPaymentId: paymentId,
          });
        }
        continue;
      }

      await doc.ref.set(
        {
          routeTransferStatus: "transferred",
          "payment.routeTransfer": attempt.result,
          routeTransferError: admin.firestore.FieldValue.delete(),
          routeTransferRetryAt: admin.firestore.FieldValue.delete(),
          routeTransferRetryCount: admin.firestore.FieldValue.delete(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      retriedCount += 1;
    } catch (err: any) {
      await captureErrorSnapshot({
        source: "payments",
        severity: "high",
        message: `Route transfer retry worker failed for order ${orderId}: ${err.message || err}`,
        orderId,
        branchId,
        razorpayPaymentId: paymentId,
      });
    }
  }

  return { retriedCount };
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
    reverse_all: 1, // Automatically reverses split transfer proportionally from branch
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
