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
      // Require a real stored order id AND sane numeric totals — ghost docs
      // or corrupted amounts (string/NaN) must not short-circuit into a
      // checkout for the wrong total.
      const data = (prior.exists ? (prior.data() as any) : undefined) as any;
      const storedPaise = data?.amountPaise;
      if (
        typeof data?.razorpayOrderId === "string" &&
        data.razorpayOrderId.length > 0 &&
        typeof storedPaise === "number" &&
        Number.isFinite(storedPaise) &&
        storedPaise > 0
      ) {
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
      // Fail CLOSED: minting a fresh order when the lookup blips creates a
      // second payable gateway order for the same checkout (double charge).
      // 503 tells the client to retry the SAME idempotencyKey — the retry
      // reuses the original open order instead of paying twice. Stranded
      // payers are recoverable; double charges are not.
      console.warn("[Payments] idempotency lookup failed, refusing fresh order:", err?.message || err);
      const { captureErrorSnapshot } = await import("../../core/errors");
      await captureErrorSnapshot({
        source: "payments",
        severity: "high",
        message: "payment-intent idempotency lookup failed — refused fresh order, client must retry same key",
        errorStack: err?.stack,
      });
      const refused: any = new Error("Payment service is temporarily unavailable — please retry checkout (you will not be charged twice).");
      refused.statusCode = 503;
      throw refused;
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
    // User-facing copy (no screaming codes): the route maps this to 400.
    const err: any = new Error("Your cart total is empty — please add an item before paying.");
    err.code = "INVALID_AMOUNT";
    err.statusCode = 400;
    throw err;
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

  // 2. Fetch order to perform Route split. Unknown orderId is a 404 —
  // the old code built `orderData = {}` and resurrected a partial CONFIRMED
  // doc (payment fields, no items/pricing) for a typo'd or deleted id.
  const orderRef = db.collection("orders").doc(orderId);
  const orderSnap = await orderRef.get();
  if (!orderSnap.exists) {
    throw new Error(`Order ${orderId} not found — refusing to verify payment against a ghost order`);
  }
  const orderData = orderSnap.data() || {};
  const branchId = orderData.branchId;

  let transferResult: any = null;

  // 3. Execute Razorpay Route split transfer if linked account exists.
  // Claim-then-work inside a transaction: two concurrent verifies used to
  // both read `!== "transferred"` and both POST the non-idempotent transfer
  // API. The winner flips `transferring`; the loser reuses the result.
  if (orderData.routeTransferStatus === "transferred") {
    transferResult = orderData.payment?.routeTransfer ?? orderData["payment.routeTransfer"] ?? null;
  } else if (db && typeof (db as any).runTransaction === "function") {
    const claim: "claimed" | "done" | "busy" = await (db as any).runTransaction(
      async (tx: any) => {
        const fresh = await tx.get(orderRef as any);
        const freshData = (fresh.exists ? fresh.data() : undefined) as any;
        if (!freshData) return "busy";
        if (freshData.routeTransferStatus === "transferred") {
          transferResult =
            freshData.payment?.routeTransfer ?? freshData["payment.routeTransfer"] ?? null;
          return "done";
        }
        // Another verify/worker owns the transfer right now — never POST ours.
        // Stale-claim takeover: a crash between claim and POST must not park
        // the order in `transferring` forever (every future verify would 503).
        if (freshData.routeTransferStatus === "transferring") {
          const claimedAt = freshData.routeTransferClaimedAt;
          const claimedMs =
            claimedAt && typeof claimedAt.toMillis === "function" ? claimedAt.toMillis() : 0;
          if (Date.now() - claimedMs < 10 * 60 * 1000) return "busy";
        }
        tx.set(
          orderRef as any,
          {
            routeTransferStatus: "transferring",
            routeTransferClaimedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
        return "claimed";
      }
    );
    if (claim === "done" && transferResult) {
      // Lost the race after a winner completed — reuse, skip our own POST.
      return finishVerifiedPayment({
        orderRef,
        orderData: { ...orderData, routeTransferStatus: "transferred" },
        orderId,
        razorpayOrderId,
        razorpayPaymentId,
        transferResult,
      });
    }
    if (claim === "busy") {
      // Winner still mid-flight: poll briefly for its result, else ask the
      // client to retry verify (by then the transfer has settled). Posting
      // our own transfer here is exactly the double-spend this guards.
      for (let i = 0; i < 4; i++) {
        await new Promise((r) => setTimeout(r, 500));
        const re = await orderRef.get();
        const reData = (re.exists ? re.data() : undefined) as any;
        if (reData?.routeTransferStatus === "transferred") {
          const reused =
            reData.payment?.routeTransfer ?? reData["payment.routeTransfer"] ?? null;
          return finishVerifiedPayment({
            orderRef,
            orderData: { ...orderData, routeTransferStatus: "transferred" },
            orderId,
            razorpayOrderId,
            razorpayPaymentId,
            transferResult: reused,
          });
        }
        if (reData?.routeTransferStatus !== "transferring") break;
      }
      const busy: any = new Error("Transfer in progress elsewhere — please retry payment verification.");
      busy.statusCode = 503;
      throw busy;
    }
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

  // 4+5. Confirm state + audit (shared by the normal and race-loser paths).
  return finishVerifiedPayment({
    orderRef,
    orderData,
    orderId,
    razorpayOrderId,
    razorpayPaymentId,
    transferResult,
  });
}

/**
 * Writes the CONFIRMED order state, OTP hash, and payment audit after a
 * verified payment. Split out so the transfer-claim race loser reuses the
 * winner's result through the identical write path (no divergent copies).
 */
async function finishVerifiedPayment(args: {
  orderRef: any;
  orderData: any;
  orderId: string;
  razorpayOrderId: string;
  razorpayPaymentId: string;
  transferResult: any;
}) {
  const { orderRef, orderData, orderId, razorpayOrderId, razorpayPaymentId, transferResult } = args;

  // Update order state in Firestore — crypto-secure OTP for India compliance
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

  // Append payment audit
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
