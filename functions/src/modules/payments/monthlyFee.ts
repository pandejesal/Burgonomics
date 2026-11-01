import * as admin from "firebase-admin";
import { db } from "../../core/firebase";
import { captureErrorSnapshot } from "../../core/errors";
import { DEFAULT_MONTHLY_FEE_RUPEES } from "./branchPricing";

/**
 * Fixed monthly branch fee (owner decision 2026-11-01, F1-F6).
 *
 * No per-order royalty. The first ₹2,500 of a branch's Razorpay earnings each
 * calendar month stays with the brand; every later order pays the branch in
 * full. The hold is stamped on the order exactly once (`monthlyFeeHold`) and
 * the ledger `branch_monthly_fees/{branchId}_{monthKey}` records the month.
 */

export const DEFAULT_MONTHLY_FEE_PAISE = DEFAULT_MONTHLY_FEE_RUPEES * 100;
export const BRANCH_MONTHLY_FEES = "branch_monthly_fees";

/**
 * F2: `YYYY-MM` for Asia/Kolkata (UTC+05:30, no DST). The boundary is 18:30Z:
 * `2026-10-31T18:29:59Z` → 2026-10, `2026-10-31T18:30:00Z` → 2026-11.
 */
export function istMonthKey(date: Date | number = new Date()): string {
  const ms = typeof date === "number" ? date : date.getTime();
  if (!Number.isFinite(ms)) throw new Error("istMonthKey: invalid date");
  const shifted = new Date(ms + 5.5 * 60 * 60 * 1000);
  const year = shifted.getUTCFullYear();
  const month = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

export function branchMonthlyFeeId(branchId: string, monthKey: string): string {
  return `${branchId}_${monthKey}`;
}

/** F1: parses `branches/{id}.monthlyFee` (rupees). Invalid → flagged. */
export function parseMonthlyFeePaise(raw: unknown): {
  feePaise: number;
  invalid: boolean;
} {
  if (raw === undefined || raw === null) {
    return { feePaise: DEFAULT_MONTHLY_FEE_PAISE, invalid: false };
  }
  const rupees = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(rupees) || rupees < 0) {
    return { feePaise: DEFAULT_MONTHLY_FEE_PAISE, invalid: true };
  }
  return { feePaise: Math.round(rupees * 100), invalid: false };
}

export interface MonthlyFeeHold {
  monthKey: string;
  earnedPaise: number;
  courierFeePaise: number;
  holdPaise: number;
  branchTransferPaise: number;
  releasedPaise: number;
  refundLedgeredPaise: number;
}

export interface EnsureHoldResult {
  hold: MonthlyFeeHold;
  /** True when a payout bookkeeping problem must be settled by a human. */
  manualSettlement: boolean;
  reason?: string;
}

export interface EnsureMonthlyFeeHoldInput {
  orderRef: any;
  orderId: string;
  branchId: string;
  /** Branch earnings on this order before the fee (grand - courier). */
  earnedPaise: number;
  courierFeePaise: number;
  /** F2: the gateway's payment time (ms). Falls back to now. */
  gatewayCreatedAtMs?: number;
}

function isRefundedBeforeTransfer(order: any): boolean {
  const refunded = Number(order?.refundedTotalPaise);
  if (Number.isFinite(refunded) && refunded > 0) return true;
  return order?.refundStatus !== undefined && order?.refundStatus !== null && order?.refundStatus !== "";
}

/**
 * F5: holds the fee exactly once, in its OWN transaction, separate from the
 * transfer lease. Both `executeRouteSplit` and the retry worker call it after
 * winning the lease and before any transfer; a crash between the two is
 * harmless because this is independently idempotent and returns the fresh
 * stamp. There is no non-transaction fallback: without `runTransaction` the
 * order is flagged for manual settlement and nothing is held.
 */
export async function ensureMonthlyFeeHold(
  input: EnsureMonthlyFeeHoldInput
): Promise<EnsureHoldResult> {
  const { orderRef, orderId, branchId, earnedPaise, courierFeePaise } = input;
  const earned = Math.max(0, Math.round(Number(earnedPaise) || 0));
  const courier = Math.max(0, Math.round(Number(courierFeePaise) || 0));
  const gatewayMs =
    typeof input.gatewayCreatedAtMs === "number" && Number.isFinite(input.gatewayCreatedAtMs)
      ? input.gatewayCreatedAtMs
      : Date.now();
  const monthKey = istMonthKey(gatewayMs);

  if (!db || typeof (db as any).runTransaction !== "function") {
    return {
      hold: {
        monthKey,
        earnedPaise: earned,
        courierFeePaise: courier,
        holdPaise: 0,
        branchTransferPaise: 0,
        releasedPaise: 0,
        refundLedgeredPaise: 0,
      },
      manualSettlement: true,
      reason: "no transactional datastore — monthly fee not held, settle manually",
    };
  }

  const ledgerRef = db.collection(BRANCH_MONTHLY_FEES).doc(branchMonthlyFeeId(branchId, monthKey));
  const branchRef = db.collection("branches").doc(branchId);

  return (db as any).runTransaction(async (tx: any) => {
    const orderSnap = await tx.get(orderRef);
    const order = (orderSnap && orderSnap.exists ? orderSnap.data() : {}) || {};

    // Already stamped: reuse, never recompute, never touch the ledger again.
    if (order.monthlyFeeHold && typeof order.monthlyFeeHold === "object") {
      return { hold: order.monthlyFeeHold as MonthlyFeeHold, manualSettlement: false };
    }

    // Refunded before the transfer: never pay out refunded money, never count
    // the earnings, flag a human.
    if (isRefundedBeforeTransfer(order)) {
      const hold: MonthlyFeeHold = {
        monthKey,
        earnedPaise: 0,
        courierFeePaise: 0,
        holdPaise: 0,
        branchTransferPaise: 0,
        releasedPaise: 0,
        refundLedgeredPaise: Number(order.refundedTotalPaise) || 0,
      };
      tx.set(
        orderRef,
        {
          paymentChannel: "razorpay",
          monthlyFeeHold: hold,
          routeTransferStatus: "failed",
          routeTransferNeedsManualSettlement: true,
          routeTransferError: "refunded before transfer — no payout, settle manually",
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      return {
        hold,
        manualSettlement: true,
        reason: "refunded before transfer",
      };
    }

    // F5/F22f: feePaise comes from the ledger if it exists, else read the
    // BRANCH DOCUMENT inside this transaction — never the 60-second cache.
    const ledgerSnap = await tx.get(ledgerRef);
    const ledger = (ledgerSnap && ledgerSnap.exists ? ledgerSnap.data() : null) as any;
    let feePaise: number;
    if (ledger && Number.isFinite(Number(ledger.feePaise)) && Number(ledger.feePaise) >= 0) {
      feePaise = Number(ledger.feePaise);
    } else {
      const branchSnap = await tx.get(branchRef);
      const branchData = (branchSnap && branchSnap.exists ? branchSnap.data() : null) as any;
      if (!branchData) {
        const hold: MonthlyFeeHold = {
          monthKey,
          earnedPaise: earned,
          courierFeePaise: courier,
          holdPaise: 0,
          branchTransferPaise: 0,
          releasedPaise: 0,
          refundLedgeredPaise: 0,
        };
        tx.set(
          orderRef,
          {
            paymentChannel: "razorpay",
            monthlyFeeHold: hold,
            routeTransferNeedsManualSettlement: true,
            routeTransferError: "branch config unreadable at capture — settle manually",
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
        return { hold, manualSettlement: true, reason: "branch config unreadable at capture" };
      }
      const parsed = parseMonthlyFeePaise(branchData.monthlyFee);
      if (parsed.invalid) {
        const hold: MonthlyFeeHold = {
          monthKey,
          earnedPaise: earned,
          courierFeePaise: courier,
          holdPaise: 0,
          branchTransferPaise: 0,
          releasedPaise: 0,
          refundLedgeredPaise: 0,
        };
        tx.set(
          orderRef,
          {
            paymentChannel: "razorpay",
            monthlyFeeHold: hold,
            routeTransferNeedsManualSettlement: true,
            routeTransferError: `branch monthlyFee ${String(
              branchData.monthlyFee
            )} is invalid — fee not held, settle manually`,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
        return { hold, manualSettlement: true, reason: "invalid monthlyFee" };
      }
      feePaise = parsed.feePaise;
    }

    const collected = Math.max(0, Number(ledger?.feeCollectedPaise) || 0);
    const remaining = Math.max(0, feePaise - collected);
    const holdPaise = Math.min(remaining, earned);
    const branchTransferPaise = earned - holdPaise;

    const hold: MonthlyFeeHold = {
      monthKey,
      earnedPaise: earned,
      courierFeePaise: courier,
      holdPaise,
      branchTransferPaise,
      releasedPaise: 0,
      refundLedgeredPaise: 0,
    };

    // Ledger + hold commit together (same transaction) or not at all.
    if (ledger) {
      tx.set(
        ledgerRef,
        {
          feePaise,
          feeCollectedPaise: admin.firestore.FieldValue.increment(holdPaise),
          razorpayOrders: admin.firestore.FieldValue.increment(1),
          razorpayEarnedPaise: admin.firestore.FieldValue.increment(earned),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    } else {
      tx.set(ledgerRef, {
        branchId,
        monthKey,
        feePaise,
        feeCollectedPaise: holdPaise,
        razorpayOrders: 1,
        razorpayEarnedPaise: earned,
        razorpayRefundedPaise: 0,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    tx.set(
      orderRef,
      {
        // F5/F8: the stream marker is written here too, so it survives a
        // suppressed confirm.
        paymentChannel: "razorpay",
        monthlyFeeHold: hold,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    return { hold, manualSettlement: false };
  });
}

/** Ledger arithmetic for a refund (F7) — always FieldValue.increment. */
export function monthlyFeeRefundDeltas(
  hold: MonthlyFeeHold,
  nextRefundedTotalPaise: number
): { deltaRelease: number; deltaRefund: number; target: number } {
  const refunded = Math.max(0, Math.round(Number(nextRefundedTotalPaise) || 0));
  const released = Math.max(0, Number(hold?.releasedPaise) || 0);
  const ledgered = Math.max(0, Number(hold?.refundLedgeredPaise) || 0);
  const branchShare = Math.max(0, Number(hold?.branchTransferPaise) || 0);
  const courier = Math.max(0, Number(hold?.courierFeePaise) || 0);
  const holdPaise = Math.max(0, Number(hold?.holdPaise) || 0);

  const target = Math.min(holdPaise, Math.max(0, refunded - branchShare - courier));
  const deltaRelease = Math.max(0, target - released);
  const deltaRefund = Math.max(0, refunded - ledgered);
  return { deltaRelease, deltaRefund, target };
}

/**
 * F7: called INSIDE the transaction that records `refundedTotalPaise`, so the
 * refund record and the ledger commit together. Uses only increments.
 */
export function applyRefundToMonthlyFee(
  tx: any,
  orderRef: any,
  freshOrder: any,
  nextRefundedTotalPaise: number
): void {
  const hold = freshOrder?.monthlyFeeHold as MonthlyFeeHold | undefined;
  if (!hold || typeof hold !== "object") return;

  const { deltaRelease, deltaRefund } = monthlyFeeRefundDeltas(hold, nextRefundedTotalPaise);
  if (deltaRelease === 0 && deltaRefund === 0) return;

  const ledgerRef = db
    .collection(BRANCH_MONTHLY_FEES)
    .doc(branchMonthlyFeeId(String(freshOrder.branchId || ""), String(hold.monthKey)));

  // The ledger of the hold's month, not the current one. Negative collection
  // would mean the brand collected more than the fee; clamp the write to the
  // hold's own fee so a corrupt replay can never mint money.
  tx.set(
    ledgerRef,
    {
      ...(deltaRelease > 0
        ? { feeCollectedPaise: admin.firestore.FieldValue.increment(-deltaRelease) }
        : {}),
      ...(deltaRefund > 0
        ? { razorpayRefundedPaise: admin.firestore.FieldValue.increment(deltaRefund) }
        : {}),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  tx.set(
    orderRef,
    {
      monthlyFeeHold: {
        ...hold,
        releasedPaise: Math.max(0, Number(hold.releasedPaise) || 0) + deltaRelease,
        refundLedgeredPaise:
          Math.max(0, Number(hold.refundLedgeredPaise) || 0) + deltaRefund,
      },
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

/** Snapshot helper: log a hold problem without failing the capture. */
export async function reportHoldProblem(
  orderId: string,
  branchId: string | undefined,
  message: string
): Promise<void> {
  await captureErrorSnapshot({
    source: "payments",
    severity: "high",
    message,
    orderId,
    branchId,
  }).catch(() => undefined);
}
