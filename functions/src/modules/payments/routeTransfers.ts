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
  orderId: string,
  // Pre-resolved linked account from the worker's batched branch prefetch.
  // `undefined` (direct callers/tests) keeps the old inline branch read.
  preResolvedAccountId?: string | null,
  // Fail-closed ceiling: the gateway-captured amount in paise (B2-S1). When
  // provided, a split above what the customer actually paid is refused to
  // pending_retry — never clamped-and-sent (clamping would silently
  // underpay the branch with no trail) and never over-transferred (which
  // would pull brand money into the branch payout).
  capturedAmountPaise?: number
): Promise<RouteTransferAttempt> {
  try {
    const rawAccountId =
      preResolvedAccountId !== undefined
        ? preResolvedAccountId
        : (await db.collection("branches").doc(branchId).get()).data()?.razorpayAccountId;
    // Narrow before money moves: a string-typed paise ("5000") coerces past
    // `> 0` and POSTs a wrong amount; a missing split must fail LOUD to
    // pending_retry (silent skip leaves the branch unpaid with no trail).
    const splitPaise = Number(pricingSplit?.branchTransferPaise);
    if (!Number.isInteger(splitPaise) || splitPaise <= 0) {
      return {
        ok: false,
        error: "Invalid pricing split: branchTransferPaise must be a positive integer",
      };
    }
    // Over-capture guard (B2-S1): runs BEFORE the mock success branch and
    // before any gateway POST, so neither path can move more than captured.
    if (
      capturedAmountPaise !== undefined &&
      Number.isFinite(capturedAmountPaise) &&
      capturedAmountPaise > 0 &&
      splitPaise > capturedAmountPaise
    ) {
      return {
        ok: false,
        error:
          `Transfer split exceeds captured payment amount — refusing over-transfer ` +
          `(split ${splitPaise} paise > captured ${capturedAmountPaise} paise)`,
      };
    }
    const razorpayAccountId = typeof rawAccountId === "string" && rawAccountId ? rawAccountId : null;

    if (!razorpayAccountId) {
      return {
        ok: false,
        skipped: true,
        error: "No linked Razorpay account for branch",
      };
    }

    if (config.mock.paymentGateway) {
      return {
        ok: true,
        result: {
          id: `trf_mock_${Date.now()}`,
          account: razorpayAccountId,
          amount: splitPaise,
          status: "processed",
        },
      };
    }

    const razorpay = getRazorpayClient();
    const transfers = buildRouteTransferPayload(
      razorpayAccountId,
      splitPaise,
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

  // One batched prefetch for every distinct branch: the old code re-read the
  // same branch doc once per order (N orders × 1 read + 1 external POST,
  // all serial). External transfer POSTs then run in bounded chunks.
  const docs = pendingSnap.docs as any[];
  const distinctBranchIds = [
    ...new Set(
      docs.map((d) => d.data()?.branchId).filter((b): b is string => typeof b === "string" && !!b)
    ),
  ];
  const branchAccounts = new Map<string, string | null>();
  await Promise.all(
    distinctBranchIds.map(async (branchId) => {
      try {
        const snap = await db.collection("branches").doc(branchId).get();
        branchAccounts.set(branchId, snap.data()?.razorpayAccountId ?? null);
      } catch {
        branchAccounts.set(branchId, null);
      }
    })
  );

  // Claim-then-work (shared lease with verifyPayment's `transferring` flag):
  // overlapping scheduler ticks used to POST the same non-idempotent
  // transfer twice. Stale claims (>10 min) are take-over-able.
  const CLAIM_TTL_MS = 10 * 60 * 1000;
  const claimedDocs: any[] = [];
  if (db && typeof (db as any).runTransaction === "function") {
    try {
      const won: any[] = await (db as any).runTransaction(async (tx: any) => {
        const mine: any[] = [];
        for (const doc of docs) {
          const fresh = await tx.get(doc.ref);
          const data = (fresh.exists ? fresh.data() : undefined) as any;
          if (!data || data.routeTransferStatus !== "pending_retry") continue;
          const claimedAt =
            data.routeTransferClaimedAt && typeof data.routeTransferClaimedAt.toMillis === "function"
              ? data.routeTransferClaimedAt.toMillis()
              : 0;
          if (data.routeTransferClaimedAt && Date.now() - claimedAt < CLAIM_TTL_MS) continue;
          tx.set(
            doc.ref,
            {
              routeTransferStatus: "transferring",
              routeTransferClaimedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
          mine.push(doc);
        }
        return mine;
      });
      claimedDocs.push(...won);
    } catch (err: any) {
      console.warn("[Route Transfer Worker] claim transaction failed, skipping tick:", err?.message || err);
      return { retriedCount: 0 };
    }
  } else {
    claimedDocs.push(...docs);
  }

  let retriedCount = 0;

  const processDoc = async (doc: any): Promise<boolean> => {
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
        return false;
      }

      const attempt = await attemptRouteTransfer(
        paymentId,
        branchId,
        pricingSplit,
        orderId,
        branchAccounts.has(branchId) ? branchAccounts.get(branchId) ?? null : undefined,
        // Captured ceiling for the over-transfer guard: live gateway truth
        // when verify stored it, else the server-priced total. Undefined when
        // neither exists — the guard then skips (missing-data check above
        // already failed such orders out).
        typeof order.payment?.capturedAmountPaise === "number"
          ? order.payment.capturedAmountPaise
          : typeof (order as any)["payment.capturedAmountPaise"] === "number"
            ? (order as any)["payment.capturedAmountPaise"]
            : typeof order.pricing?.grandTotal === "number"
              ? Math.round(order.pricing.grandTotal * 100)
              : undefined
      );

      if (attempt.skipped) {
        await doc.ref.set(
          {
            routeTransferStatus: "failed",
            routeTransferError: attempt.error,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
        return false;
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
        return false;
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
      return true;
    } catch (err: any) {
      await captureErrorSnapshot({
        source: "payments",
        severity: "high",
        message: `Route transfer retry worker failed for order ${orderId}: ${err.message || err}`,
        orderId,
        branchId,
        razorpayPaymentId: paymentId,
      });
      return false;
    }
  };

  const CHUNK_SIZE = 4;
  for (let i = 0; i < claimedDocs.length; i += CHUNK_SIZE) {
    const chunk = claimedDocs.slice(i, i + CHUNK_SIZE);
    const results = await Promise.allSettled(chunk.map((doc) => processDoc(doc)));
    for (const res of results) {
      if (res.status === "fulfilled" && res.value) retriedCount += 1;
    }
  }

  return { retriedCount };
}
