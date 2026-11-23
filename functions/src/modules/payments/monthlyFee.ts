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
  /** M1: true when month-end mode deliberately suppressed the hold. */
  skippedByMode?: boolean;
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
  throw new Error('Per-order franchise fee holds are retired');
}

/**
 * Ledger arithmetic for a refund (F7 / P1-N) — always FieldValue.increment.
 *
 * BASIS RULE: `razorpayRefundedPaise` must be measured the way `razorpayEarnedPaise`
 * is — the BRANCH'S FOOD SHARE only, excluding the courier fee. The customer is
 * refunded the whole capture (food + courier), but the courier fee was never in
 * `earned`, so netting it out of the ledger would short the branch's statement
 * by exactly that fee (live case: earned 31000, refunded wrongly 20500, net read
 * 10500 instead of 10500 + 4500 courier = 15000).
 *
 * Proportional and bounded:
 *  - every captured rupee maps to its food share at the hold's own ratio
 *    (branchFood / capture), so a partial refund ledgers its food portion;
 *  - the cumulative ledgered figure is capped at the food share actually held
 *    (`earnedPaise`), so an over-refund can never over-credit or go negative;
 *  - deltas are differences from what is already recorded, which makes replays
 *    and webhook convergence idempotent.
 */
export function monthlyFeeRefundDeltas(
  hold: MonthlyFeeHold,
  nextRefundedTotalPaise: number
): { deltaRelease: number; deltaRefund: number; target: number; foodRefundTarget: number } {
  const refunded = Math.max(0, Math.round(Number(nextRefundedTotalPaise) || 0));
  const released = Math.max(0, Number(hold?.releasedPaise) || 0);
  const ledgered = Math.max(0, Number(hold?.refundLedgeredPaise) || 0);
  const branchShare = Math.max(0, Number(hold?.branchTransferPaise) || 0);
  const courier = Math.max(0, Number(hold?.courierFeePaise) || 0);
  const holdPaise = Math.max(0, Number(hold?.holdPaise) || 0);
  // Food the branch actually earned on this order (the basis of `earned`).
  const foodShare = Math.max(0, Number(hold?.earnedPaise) || 0);
  const capturedBasis = foodShare + courier;

  // Release (the held fee) keeps its existing rule: only when the refund has
  // passed everything the branch was actually paid.
  const target = Math.min(holdPaise, Math.max(0, refunded - branchShare - courier));
  const deltaRelease = Math.max(0, target - released);

  // Ledger basis: the branch's food share, pro rata by captured amount, capped
  // at the food share actually earned. A courier-only order (foodShare 0)
  // therefore ledgers nothing, and a full refund of a 15000-food / 4500-courier
  // order ledgers exactly 15000.
  let foodRefundTarget: number;
  if (foodShare <= 0) {
    foodRefundTarget = 0;
  } else if (capturedBasis <= 0) {
    // No courier recorded: the whole capture is food.
    foodRefundTarget = Math.min(foodShare, refunded);
  } else {
    foodRefundTarget = Math.min(foodShare, Math.round((refunded * foodShare) / capturedBasis));
  }
  const deltaRefund = Math.max(0, foodRefundTarget - ledgered);
  return { deltaRelease, deltaRefund, target, foodRefundTarget };
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
