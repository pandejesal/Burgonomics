import { db } from "../../core/firebase";
import { captureErrorSnapshot } from "../../core/errors";
import { getRazorpayClient } from "../payments/razorpayClient";
import { bumpOrderStatus } from "./orderStatus";
import { isAbandonedUnpaidOnlineOrder } from "./paymentGate";

/**
 * CUS-16 — expire abandoned unpaid orders.
 *
 * A customer who closes Razorpay leaves a real `orders/{id}` document: online
 * method, nested `payment.status: "pending"`, status PLACED, no server
 * `paymentChannel`. Nothing else expires it, and the partner KDS lists it.
 *
 * Every 10 minutes this worker cancels such orders older than 30 minutes —
 * but only after asking the gateway for EVERY Razorpay order bound to it. Any
 * authorized/captured payment skips the order (high-severity snapshot); any
 * bound gateway order whose lookup FAILED skips it too (P1-B: an unchecked
 * gateway order is an unknown, not an unpaid, and the old code cancelled on a
 * partial answer). The cancel runs through the normal `bumpOrderStatus` path
 * with `onlyIfUnpaid`, whose transaction re-reads the order, so a capture
 * landing in the same moment wins and the cancel loses.
 * No customer message is sent.
 */
export const UNPAID_EXPIRY_AGE_MS = 30 * 60_000;
export const UNPAID_EXPIRY_SCAN_LIMIT = 100;
export const UNPAID_EXPIRY_MAX_CANCELS = 50;

/**
 * Test-only seam: runs after the gateway has answered for one order and BEFORE
 * the cancel transaction commits. It exists so the P1-C race can be written as
 * an INTERLEAVED sequence (a verify starting or a capture landing in exactly
 * that window) instead of as a mock that merely asserts the guard's shape.
 * Production never sets it.
 */
let afterGatewayLookupForTests:
  | null
  | ((orderId: string) => void | Promise<void>) = null;

export function __setAfterGatewayLookupForTests(
  fn: typeof afterGatewayLookupForTests
): void {
  afterGatewayLookupForTests = fn;
}

export interface UnpaidExpiryStats {
  scanned: number;
  candidates: number;
  cancelled: number;
  skippedAuthorized: number;
  skippedUnknown: number;
  failed: number;
}

function createdAtMs(value: any): number | null {
  if (typeof value === "string") {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }
  if (value && typeof value.toDate === "function") {
    const date = value.toDate();
    return date instanceof Date && Number.isFinite(date.getTime()) ? date.getTime() : null;
  }
  if (value && typeof value.toMillis === "function") {
    const ms = value.toMillis();
    return typeof ms === "number" && Number.isFinite(ms) ? ms : null;
  }
  if (value && typeof value.seconds === "number") {
    return value.seconds * 1000;
  }
  if (value && typeof value._seconds === "number") {
    return value._seconds * 1000;
  }
  return null;
}

/** Gateway payment list for one Razorpay order (order-scoped). */
async function fetchOrderPayments(razorpay: any, razorpayOrderId: string): Promise<any[]> {
  if (razorpay?.orders?.fetchPayments) {
    const res = await razorpay.orders.fetchPayments(razorpayOrderId);
    return Array.isArray(res) ? res : Array.isArray(res?.items) ? res.items : [];
  }
  if (razorpay?.payments?.all) {
    const res = await razorpay.payments.all({ order_id: razorpayOrderId, count: 100 });
    return Array.isArray(res) ? res : Array.isArray(res?.items) ? res.items : [];
  }
  throw new Error("Razorpay payment listing is unavailable");
}

/**
 * Returns the gateway order ids bound to this internal order, newest first.
 * An empty list means the gateway was never asked for this order: that is an
 * UNKNOWN, never evidence that no payment exists.
 */
async function boundGatewayOrderIds(orderId: string): Promise<string[]> {
  const snap = await db.collection("payment_intents").where("orderId", "==", orderId).limit(5).get();
  const docs = Array.isArray(snap?.docs) ? snap.docs : [];
  return docs
    .map((doc: any) => {
      const data = typeof doc.data === "function" ? doc.data() : doc;
      return {
        razorpayOrderId:
          typeof data?.razorpayOrderId === "string" ? data.razorpayOrderId.trim() : "",
        createdAtMs: typeof data?.createdAtMs === "number" ? data.createdAtMs : 0,
      };
    })
    .filter((entry: any) => entry.razorpayOrderId.length > 0)
    .sort((a: any, b: any) => b.createdAtMs - a.createdAtMs)
    .map((entry: any) => entry.razorpayOrderId);
}

export async function expireAbandonedUnpaidOrders(
  nowMs: number = Date.now()
): Promise<UnpaidExpiryStats> {
  const stats: UnpaidExpiryStats = {
    scanned: 0,
    candidates: 0,
    cancelled: 0,
    skippedAuthorized: 0,
    skippedUnknown: 0,
    failed: 0,
  };

  let snap: any;
  try {
    // Equality-only query: uses the automatic single-field index on the nested
    // `status.code`, so no composite index has to be deployed with this job.
    snap = await db
      .collection("orders")
      .where("status.code", "==", "PLACED")
      .limit(UNPAID_EXPIRY_SCAN_LIMIT)
      .get();
  } catch (err: any) {
    await captureErrorSnapshot({
      source: "system",
      severity: "high",
      message: "Unpaid-order expiry scan failed — no orders were cancelled this tick",
      errorStack: err?.stack,
    }).catch(() => undefined);
    return stats;
  }

  const docs = Array.isArray(snap?.docs) ? snap.docs : [];
  stats.scanned = docs.length;

  for (const doc of docs) {
    const orderId = typeof doc.id === "string" ? doc.id : "";
    try {
      const order = (typeof doc.data === "function" ? doc.data() : doc) || {};
      if (!orderId) continue;
      if (!isAbandonedUnpaidOnlineOrder(order)) continue;

      const created = createdAtMs(order.createdAt ?? order.placedAt);
      if (created === null || nowMs - created < UNPAID_EXPIRY_AGE_MS) continue;
      stats.candidates += 1;

      const gatewayOrderIds = await boundGatewayOrderIds(orderId);
      if (gatewayOrderIds.length === 0) {
        // No gateway order was ever minted (or the binding is unreadable).
        // Never cancel on an unknown.
        stats.skippedUnknown += 1;
        continue;
      }

      const razorpay = getRazorpayClient();
      let authorizedOrCaptured = false;
      // P1-B: EVERY gateway order bound to this internal order must be CHECKED
      // before a cancel is allowed. The old loop set `gatewayAnswered` after
      // the first successful lookup and merely `break`-ed on a failure, so a
      // later bound gateway order that timed out left the flag true and the
      // order was cancelled — although that unchecked order could be holding a
      // captured payment. One unknown now cancels nothing.
      let gatewayUnknownReason: string | null = null;
      for (const razorpayOrderId of gatewayOrderIds) {
        let payments: any[];
        try {
          payments = await fetchOrderPayments(razorpay, razorpayOrderId);
        } catch (err: any) {
          gatewayUnknownReason = `${razorpayOrderId}: ${err?.message || String(err)}`;
          console.warn(
            `[Unpaid Expiry] gateway unavailable for order ${orderId} (${razorpayOrderId}) — skipped this tick:`,
            err?.message || String(err)
          );
          break;
        }
        if (
          payments.some(
            (payment) => payment?.status === "authorized" || payment?.status === "captured"
          )
        ) {
          authorizedOrCaptured = true;
          break;
        }
      }

      if (gatewayUnknownReason) {
        // Unknown, never evidence of "unpaid": leave the order alone for the
        // next tick and record WHY, so a repeatedly failing gateway shows up
        // instead of silently ageing orders towards cancellation.
        stats.skippedUnknown += 1;
        await captureErrorSnapshot({
          source: "system",
          severity: "medium",
          message: `Abandoned unpaid order ${orderId} not cancelled: a bound gateway order could not be checked (${gatewayUnknownReason}) — retried next tick`,
          orderId,
        }).catch(() => undefined);
        continue;
      }
      if (authorizedOrCaptured) {
        stats.skippedAuthorized += 1;
        await captureErrorSnapshot({
          source: "system",
          severity: "high",
          message: `Abandoned unpaid order ${orderId} has an authorized/captured gateway payment — not cancelled; reconcile the capture`,
          orderId,
        }).catch(() => undefined);
        continue;
      }
      if (stats.cancelled >= UNPAID_EXPIRY_MAX_CANCELS) continue;

      if (afterGatewayLookupForTests) await afterGatewayLookupForTests(orderId);

      await bumpOrderStatus({
        orderId,
        status: "cancelled",
        cancellationReason: "payment_not_completed",
        timelineEvent: { title: "Cancelled — payment not completed", actor: "system" },
        // Re-reads inside the cancel transaction: a capture that lands after
        // the gateway check flips the guard and the cancel is refused.
        onlyIfUnpaid: true,
      });
      stats.cancelled += 1;
    } catch (err: any) {
        // A capture landing in the same moment (or any other refusal) must not
      // poison the rest of the batch.
      if (err?.code === "ORDER_NOT_PAID") {
        stats.skippedUnknown += 1;
        // P1-C layer 1 refusal: the fresh doc showed money moving. Say why, so
        // a sweep that keeps losing this race is visible instead of looking
        // like a no-op.
        console.warn(
          `[Unpaid Expiry] order ${orderId} was NOT cancelled — payment activity appeared inside the cancel transaction:`,
          err?.message || err
        );
        await captureErrorSnapshot({
          source: "system",
          severity: "medium",
          message: `Abandoned unpaid order ${orderId} was not cancelled: payment activity appeared before the cancel committed (${err?.message || "no reason given"})`,
          orderId,
        }).catch(() => undefined);
        continue;
      }
      stats.failed += 1;
      console.warn(
        `[Unpaid Expiry] failed to cancel ${orderId} — retried next tick:`,
        err?.message || String(err)
      );
      await captureErrorSnapshot({
        source: "system",
        severity: "medium",
        message: `Unpaid-order expiry failed to cancel ${orderId}; it will be retried next tick`,
        orderId,
        errorStack: err?.stack,
      }).catch(() => undefined);
    }
  }

  return stats;
}
