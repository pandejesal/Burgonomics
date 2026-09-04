import * as admin from "firebase-admin";
import { db } from "../../core/firebase";
import { config } from "../../config/env";
import { captureErrorSnapshot } from "../../core/errors";
import { getRazorpayClient } from "./razorpayClient";

export interface RoutePricingSplit {
  branchTransferPaise: number;
  brandRoyaltyPaise: number;
  totalAmountPaise: number;
}

export interface RouteTransferAttempt {
  ok: boolean;
  skipped?: boolean;
  result?: any;
  error?: string;
}

/**
 * Calculates 95% branch transfer and 5% brand royalty split in paise.
 */
export function calculateRouteSplit(
  totalAmountPaise: number,
  royaltyRate = 0.05
): RoutePricingSplit {
  const brandRoyaltyPaise = Math.round(totalAmountPaise * royaltyRate);
  const branchTransferPaise = totalAmountPaise - brandRoyaltyPaise;

  return {
    branchTransferPaise,
    brandRoyaltyPaise,
    totalAmountPaise,
  };
}

/**
 * Constructs the transfers array payload for Razorpay Route orders / transfers.
 */
export function buildRouteTransferPayload(
  accountId: string,
  amountPaise: number,
  orderId: string,
  branchId: string,
  brandRoyaltyPaise?: number
) {
  return [
    {
      account: accountId,
      amount: amountPaise,
      currency: "INR",
      notes: {
        orderId,
        branchId,
        brandRoyaltyPaise: brandRoyaltyPaise ?? 0,
      },
      linked_account_notes: ["orderId"],
      on_hold: false,
    },
  ];
}

/**
 * Executes a Razorpay Route transfer split for a captured payment.
 * Returns a structured attempt result so the caller can decide
 * how to persist the outcome (success, pending retry, or skipped).
 */
export async function attemptRouteTransfer(
  paymentId: string,
  branchId: string,
  pricingSplit: { branchTransferPaise: number; brandRoyaltyPaise?: number; brandRoyaltyAmount?: number },
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
    const transfers = buildRouteTransferPayload(
      razorpayAccountId,
      pricingSplit.branchTransferPaise,
      orderId,
      branchId,
      pricingSplit.brandRoyaltyPaise ?? pricingSplit.brandRoyaltyAmount
    );

    const result = await razorpay.payments.transfer(paymentId, {
      transfers,
    });
    return { ok: true, result };
  } catch (err: any) {
    return { ok: false, error: (err as any)?.message || String(err) };
  }
}

/**
 * Retries pending Razorpay Route transfers for orders marked pending_retry.
 * Runs on a schedule and handles each order independently.
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
