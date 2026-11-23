import * as admin from "firebase-admin";
import { db } from "../../core/firebase";
import { config, assertLivePaymentsContext } from "../../config/env";
import { captureErrorSnapshot } from "../../core/errors";
import { getRazorpayClient } from "./razorpayClient";
import { ensureMonthlyFeeHold, type MonthlyFeeHold } from "./monthlyFee";

import {
  markOrderReconciliation,
  parkTerminalPaymentCapture,
  getTerminalCaptureParkDocId,
  buildTerminalCaptureParkPayload,
  buildOrderReconciliationPayload,
} from "./reconciliation";

export interface RoutePricingSplit {
  branchTransferPaise: number;
  /** The courier fee the brand keeps (D6), never transferred. */
  courierFeePaise?: number;
  /** The part of this order's earnings held against the fixed monthly fee. */
  monthlyFeeHoldPaise?: number;
  totalAmountPaise?: number;
}

export interface RouteTransferAttempt {
  ok: boolean;
  skipped?: boolean;
  result?: any;
  error?: string;
  /**
   * TRUE when the attempt's outcome is UNKNOWN (gateway timeout, ambiguous
   * network failure, or a failed pre-POST reconcile lookup). Callers MUST
   * park the order in `needs_reconciliation` — never blind-retry a money
   * POST that may have already landed.
   */
  unknown?: boolean;
  /** TRUE when an equivalent existing transfer was found and reused (no POST). */
  reconciled?: boolean;
  /**
   * TRUE for a CONFIGURATION error (e.g. malformed linked-account id): a
   * retry cannot fix a stored value, so the worker must park the order for
   * manual settlement instead of spending the 4-attempt retry budget (~20 min)
   * and then marking it terminally failed with no trail.
   */
  configError?: boolean;
}

/**
 * Explicit gateway request timeouts. Both are WELL under the 10-minute
 * transfer-claim lease: a hung-but-landed POST surfaces as `unknown` here
 * long before a stale-lease takeover could re-POST it, and the takeover
 * itself reconciles existing transfers first (below).
 */
const TRANSFER_POST_TIMEOUT_MS = 30_000;
const TRANSFER_RECONCILE_TIMEOUT_MS = 15_000;

/**
 * Linked-account shape, enforced at the money chokepoint (last line of
 * defense — some config surfaces validate loosely or not at all). Real
 * Razorpay Route account ids are `acc_` + alphanumerics (~14 chars); the
 * repo's documented demo fixtures use underscores (`acc_Rzp_Surat_01`), so
 * the accepted set is `[A-Za-z0-9_]` with a >=6-char suffix. This rejects
 * the actual defect class — bare `acc_`, `acc_x`, arbitrary text — before
 * any POST, while keeping the documented fixture shape working.
 */
const ROUTE_ACCOUNT_ID_SHAPE = /^acc_[A-Za-z0-9_]{6,}$/;

export function isRouteAccountIdShape(value: string | null | undefined): boolean {
  return typeof value === "string" && ROUTE_ACCOUNT_ID_SHAPE.test(value.trim());
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const err: any = new Error(`${label} timed out after ${ms}ms — outcome unknown`);
      err.code = "GATEWAY_TIMEOUT";
      reject(err);
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

/**
 * Reconcile-before-(re)POST: `payments.transfer` is NOT idempotent, so before
 * ANY POST (first attempt, retry worker, stale-lease takeover) we list the
 * payment's existing transfers and return an equivalent one (same internal
 * orderId in notes + same live paise amount, not failed/reversed) so callers
 * record it instead of double-paying the branch.
 *
 * Throws when the lookup itself fails — callers then treat the outcome as
 * UNKNOWN and park rather than POSTing blind.
 */
export async function findExistingTransferForPayment(
  razorpay: any,
  paymentId: string,
  want: { splitPaise: number; orderId: string }
): Promise<any | null> {
  // Fail-closed (stress sweep 2026-10-24, R3): a client WITHOUT the
  // fetchTransfer endpoint cannot prove "no transfer exists". Returning null
  // ("nothing there") made reconcile-before-POST fail OPEN and blind-POST the
  // non-idempotent transfer — so an unusable lookup now throws and callers
  // treat the outcome as UNKNOWN (park, never blind-retry).
  if (!razorpay?.payments?.fetchTransfer) {
    throw new Error(
      "Razorpay client lacks payments.fetchTransfer — transfer reconciliation unavailable; refusing to risk a duplicate payout"
    );
  }
  const res = await withTimeout(
    Promise.resolve(razorpay.payments.fetchTransfer(paymentId)),
    TRANSFER_RECONCILE_TIMEOUT_MS,
    "Razorpay payments.fetchTransfer"
  );
  const items = Array.isArray(res?.items)
    ? res.items
    : Array.isArray(res)
      ? (res as any[])
      : [];
  for (const t of items) {
    if (!t || typeof t.amount !== "number") continue;
    if (t.status === "failed" || t.status === "reversed") continue;
    if (Number(t.amount) !== want.splitPaise) continue;
    // Our transfers always stamp notes.orderId (buildRouteTransferPayload) —
    // a transfer without OUR marker is never assumed to be ours.
    if (t?.notes?.orderId === want.orderId) return t;
  }
  return null;
}

/** SDK/API errors that PROVE the transfer did not happen (safe to retry). */
function isDefiniteGatewayRejection(err: any): boolean {
  const status = Number(err?.statusCode);
  return Number.isInteger(status) && status >= 400 && status < 500;
}

/**
 * F3/F6 (owner decision 2026-11-01): NO per-order royalty. The branch is owed
 * everything except the courier fee; the fixed monthly fee is applied per
 * capture by `ensureMonthlyFeeHold`, never here.
 *
 * Kept as a pure helper for callers that only have a total and a courier fee.
 */
export function calculateRouteSplit(
  totalAmountPaise: number,
  courierFeePaise = 0
): RoutePricingSplit {
  const total = Number(totalAmountPaise);
  const courier = Number(courierFeePaise);
  if (!Number.isInteger(total) || total <= 0) {
    throw new Error(
      `calculateRouteSplit: totalAmountPaise must be a positive integer of whole paise (got ${String(totalAmountPaise)})`
    );
  }
  if (!Number.isInteger(courier) || courier < 0 || courier > total) {
    throw new Error(
      `calculateRouteSplit: courierFeePaise must be a whole, non-negative paise amount not above the total (got ${String(courierFeePaise)})`
    );
  }
  return {
    branchTransferPaise: total - courier,
    totalAmountPaise: total,
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
  monthlyFeeHoldPaise?: number
) {
  return [
    {
      account: accountId,
      amount: amountPaise,
      currency: "INR",
      notes: {
        orderId,
        branchId,
        // F6: the amount of THIS order's earnings held against the monthly fee.
        monthlyFeeHoldPaise: monthlyFeeHoldPaise ?? 0,
      },
      linked_account_notes: ["orderId"],
      on_hold: false,
    },
  ];
}

export interface OrderTerminalCheckResult {
  isTerminal: boolean;
  reason?: "capture_on_cancelled_order" | "capture_on_refunded_order";
  orderStatus?: string;
}

/**
 * Checks if an order or payment is in a terminal cancelled or refunded state.
 * Supports canonical status.code, legacy string status, and payment refund markers.
 * Deliberately excludes legitimate fulfilled terminal states (e.g. PICKED_UP, DELIVERED).
 */
export function isOrderTerminalForRouteTransfer(
  order: any
): OrderTerminalCheckResult {
  if (!order) return { isTerminal: false };
  const rawStatus =
    typeof order.status === "string" ? order.status : order.status?.code;
  const normalized = String(rawStatus || "").toUpperCase();

  const isRefunded =
    normalized === "REFUNDED" ||
    String(order.payment?.status || "").toLowerCase() === "refunded" ||
    String(order.paymentStatus || "").toLowerCase() === "refunded" ||
    String(order.refundStatus || "").toLowerCase() === "refunded";

  if (isRefunded) {
    return {
      isTerminal: true,
      reason: "capture_on_refunded_order",
      orderStatus: normalized || "REFUNDED",
    };
  }

  const isCancelled =
    normalized === "CANCELLED" ||
    normalized === "CANCELED" ||
    String(order.cancellationStatus || "").toLowerCase() === "cancelled";

  if (isCancelled) {
    return {
      isTerminal: true,
      reason: "capture_on_cancelled_order",
      orderStatus: normalized || "CANCELLED",
    };
  }

  return { isTerminal: false, orderStatus: normalized };
}

export interface TerminalRefusalTxParams {
  orderRef: any;
  orderId: string;
  paymentId?: string | null;
  razorpayOrderId?: string | null;
  capturedAmountPaise?: number | null;
  reason: "capture_on_cancelled_order" | "capture_on_refunded_order";
  orderStatus: string;
  source?: string;
}

/**
 * Atomically writes terminal refusal on the order doc (releasing lease, marking failed,
 * writing reconciliation marker) AND writes the deterministic unmatched_payments park
 * doc inside the SAME transaction. Caller performs all reads prior to invoking.
 */
export function recordTerminalRefusalInTx(
  tx: any,
  db: any,
  params: TerminalRefusalTxParams
): void {
  const {
    orderRef,
    orderId,
    paymentId,
    razorpayOrderId,
    capturedAmountPaise,
    reason,
    orderStatus,
    source = "route_transfers_retry",
  } = params;

  // 1. Order doc: failed state + lease deletion + reconciliation marker in one atomic merge
  tx.set(
    orderRef,
    {
      routeTransferStatus: "failed",
      routeTransferTerminalRefusal: true,
      routeTransferError: `Refused route transfer: order is ${orderStatus} (${reason})`,
      routeTransferClaimedAt: admin.firestore.FieldValue.delete(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      ...buildOrderReconciliationPayload({
        state: "payment_review",
        reason,
        razorpayPaymentId: paymentId || null,
      }),
    },
    { merge: true }
  );

  // 2. unmatched_payments: atomic park in the SAME transaction
  if (paymentId) {
    const parkDocId = getTerminalCaptureParkDocId(paymentId);
    const parkRef = db.collection("unmatched_payments").doc(parkDocId);
    const parkPayload = buildTerminalCaptureParkPayload({
      orderId,
      razorpayPaymentId: paymentId,
      razorpayOrderId,
      amountPaise: capturedAmountPaise,
      reason,
      orderStatus,
      source,
    });
    tx.set(parkRef, parkPayload, { merge: true });
  }
}


/**
 * Executes a Razorpay Route transfer split for a captured payment.
 * Returns a structured attempt result so the caller can decide
 * how to persist the outcome (success, pending retry, or skipped).
 */
export async function attemptRouteTransfer(
  paymentId: string,
  branchId: string,
  pricingSplit: { branchTransferPaise: number; monthlyFeeHoldPaise?: number },
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
  return { ok: false, error: 'Per-order Route transfers are retired' };
}

/** Kept during scheduler cutover. Never claim an order or contact the gateway. */
export async function retryPendingRouteTransfersWorker() {
  return { retriedCount: 0 };
}
