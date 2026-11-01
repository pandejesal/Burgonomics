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
 * but only after asking the gateway for that Razorpay order's payments. Any
 * authorized/captured payment skips the order (high-severity snapshot); an
 * unreachable gateway skips it too. The cancel runs through the normal
 * `bumpOrderStatus` path with `onlyIfUnpaid`, whose transaction re-reads the
 * order, so a capture landing in the same moment wins and the cancel loses.
 * No customer message is sent.
 */
export const UNPAID_EXPIRY_AGE_MS = 30 * 60_000;
export const UNPAID_EXPIRY_SCAN_LIMIT = 100;
export const UNPAID_EXPIRY_MAX_CANCELS = 50;

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
      let gatewayAnswered = false;
      for (const razorpayOrderId of gatewayOrderIds) {
        let payments: any[];
        try {
          payments = await fetchOrderPayments(razorpay, razorpayOrderId);
        } catch (err: any) {
          console.warn(
            `[Unpaid Expiry] gateway unavailable for order ${orderId} — skipped this tick:`,
            err?.message || String(err)
          );
          break;
        }
        gatewayAnswered = true;
        if (
          payments.some(
            (payment) => payment?.status === "authorized" || payment?.status === "captured"
          )
        ) {
          authorizedOrCaptured = true;
          break;
        }
      }

      if (!gatewayAnswered) {
        stats.skippedUnknown += 1;
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
