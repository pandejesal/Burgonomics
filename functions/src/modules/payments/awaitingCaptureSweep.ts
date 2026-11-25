import * as admin from "firebase-admin";
import { db } from "../../core/firebase";
import { captureErrorSnapshot } from "../../core/errors";
import { config } from "../../config/env";
import { getRazorpayClient } from "./razorpayClient";

/**
 * C11 / A1-payments finding 4 (High) — the `awaiting_capture` dead end.
 *
 * `verifyPayment` refuses an authorized-but-uncaptured payment
 * (`PAYMENT_NOT_CAPTURED`), stamps `paymentStatus: "awaiting_capture"` and
 * throws. NOTHING ever read that state again:
 *
 *   • `isUnsafeToExpire` (paymentGate.ts) treats it as "money may be moving",
 *     so the abandoned-unpaid sweep could never cancel the order;
 *   • no job looked for it, and `POST /discrepancies/resolve` only marks the
 *     `payment_discrepancies` row resolved — it never touches the order;
 *   • so the order sat PLACED for ever (visible on the Partner KDS), and the
 *     authorization hold on the customer's card was never voided by us.
 *
 * This sweep closes the loop the way the audit asked: it RE-READS the payment at
 * the gateway and
 *   • when the hold is GONE (`failed` / `created` / `cancelled` — nothing
 *     captured, nothing authorized), it releases the marker and records why, so
 *     the ordinary expiry sweep can cancel the order with
 *     `payment_not_completed`;
 *   • while the gateway still reports `authorized`, the order stays blocked
 *     (money IS reserved) and is parked visibly for a human;
 *   • when the gateway reports `captured`, the money moved and this sweep must
 *     not touch it: it escalates for reconciliation and leaves the order alone;
 *   • an unreadable gateway is an UNKNOWN: nothing is written and the next tick
 *     retries. (Fail closed: an unanswered gateway is never "unpaid".)
 *
 * Razorpay's documented lifetime for an authorization is 3 days
 * (https://razorpay.com/docs/payments/payments/capture-settings, "Manual Capture
 * Timeout"); anything not captured inside it is auto-refunded by the gateway.
 * That is exactly why the marker must be resolved by US rather than left as a
 * permanent block: the hold disappears without any event of ours.
 */

export const AWAITING_CAPTURE_SCAN_LIMIT = 50;

/** Re-alert an unresolved authorization hold at most this often. */
export const AWAITING_CAPTURE_ALERT_INTERVAL_MS = 6 * 60 * 60_000;

/**
 * Test-only seam for the gateway payment read (same shape as
 * `__setPaymentsFetchForTests`): production always goes through the SDK client.
 */
let awaitingCaptureFetchOverride: ((paymentId: string) => Promise<any>) | null = null;

export function __setAwaitingCaptureFetchForTests(
  fn: ((paymentId: string) => Promise<any>) | null
): void {
  awaitingCaptureFetchOverride = fn;
}

export interface AwaitingCaptureSweepStats {
  scanned: number;
  resolved: number;
  stillAuthorized: number;
  capturedNeedsReconcile: number;
  unknown: number;
  failed: number;
}

type GatewayHoldState =
  | { kind: "hold_gone"; gatewayStatus: string }
  | { kind: "still_authorized"; gatewayStatus: string }
  | { kind: "captured"; gatewayStatus: string }
  | { kind: "unknown"; detail: string };

function classifyPayment(payment: any): GatewayHoldState {
  if (!payment || typeof payment !== "object") {
    return { kind: "unknown", detail: "gateway returned no payment object" };
  }
  const status = String(payment.status ?? "").trim().toLowerCase();
  if (status === "captured" || status === "refunded") {
    // `refunded` here means the gateway already returned the money (for
    // example after the authorization timeout). Either way WE must not treat
    // it as "nothing happened" silently — both are escalated.
    return { kind: "captured", gatewayStatus: status };
  }
  if (status === "authorized") {
    return { kind: "still_authorized", gatewayStatus: status };
  }
  if (status === "failed" || status === "created" || status === "cancelled") {
    // `created` = the customer never completed the flow; `failed` = declined;
    // `cancelled` = the hold was released. None of them reserves money.
    return { kind: "hold_gone", gatewayStatus: status };
  }
  return { kind: "unknown", detail: `unrecognised gateway status "${status || "(empty)"}"` };
}

/** The payment id this parked order is waiting on, across both write shapes. */
function awaitingCapturePaymentIdOf(order: any): string {
  const nested = order?.payment?.awaitingCapturePaymentId;
  if (typeof nested === "string" && nested.trim()) return nested.trim();
  const captured = order?.payment?.razorpayPaymentId ?? order?.["payment.razorpayPaymentId"];
  return typeof captured === "string" ? captured.trim() : "";
}

/**
 * Resolves every order parked in `awaiting_capture` whose gateway truth allows a
 * decision. Never throws for one bad order.
 */
export async function sweepAwaitingCaptureOrders(
  nowMs: number = Date.now()
): Promise<AwaitingCaptureSweepStats> {
  const stats: AwaitingCaptureSweepStats = {
    scanned: 0,
    resolved: 0,
    stillAuthorized: 0,
    capturedNeedsReconcile: 0,
    unknown: 0,
    failed: 0,
  };

  let snap: any;
  try {
    // Equality-only query: the automatic single-field index on `paymentStatus`
    // is enough, so this ship needs no new composite index.
    snap = await db
      .collection("orders")
      .where("paymentStatus", "==", "awaiting_capture")
      .limit(AWAITING_CAPTURE_SCAN_LIMIT)
      .get();
  } catch (err: any) {
    await captureErrorSnapshot({
      source: "payments",
      severity: "high",
      message:
        "awaiting_capture sweep could not scan orders — no order was resolved this tick (authorization holds stay parked)",
      errorStack: err?.stack,
    }).catch(() => undefined);
    return stats;
  }

  const docs: any[] = Array.isArray(snap?.docs) ? snap.docs : [];
  stats.scanned = docs.length;

  for (const doc of docs) {
    const orderId = typeof doc?.id === "string" ? doc.id : "";
    if (!orderId) continue;
    try {
      const order = (typeof doc.data === "function" ? doc.data() : doc) || {};
      const paymentId = awaitingCapturePaymentIdOf(order);
      if (!paymentId) {
        // No payment id was ever recorded: nothing to ask the gateway about.
        // Park it once so a human can finish the reconciliation.
        stats.unknown += 1;
        await db.collection("unmatched_payments").doc(`ump_awaiting_${orderId}`).set(
          {
            orderId,
            razorpayPaymentId: null,
            status: "needs_review",
            reason: "awaiting_capture_without_payment_id",
            receivedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
        await captureErrorSnapshot({
          source: "payments",
          severity: "high",
          message:
            `Order ${orderId} is parked in awaiting_capture with no recorded payment id — ` +
            "cannot ask the gateway for its truth; manual review required",
          orderId,
        }).catch(() => undefined);
        continue;
      }

      let payment: any;
      try {
        payment = awaitingCaptureFetchOverride
          ? await awaitingCaptureFetchOverride(paymentId)
          : config.mock.paymentGateway
            ? null
            : await getRazorpayClient().payments.fetch(paymentId);
      } catch (err: any) {
        stats.unknown += 1;
        await captureErrorSnapshot({
          source: "payments",
          severity: "medium",
          message:
            `awaiting_capture order ${orderId}: gateway read failed for ${paymentId} — ` +
            `left blocked and retried next tick (${err?.message || String(err)})`,
          orderId,
          razorpayPaymentId: paymentId,
        }).catch(() => undefined);
        continue;
      }

      if (config.mock.paymentGateway && !awaitingCaptureFetchOverride) {
        // Mock gateway: no gateway truth exists at all, so doing nothing is the
        // only honest outcome. Never invent a resolution from a mock.
        continue;
      }

      const state = classifyPayment(payment);

      if (state.kind === "unknown") {
        stats.unknown += 1;
        await captureErrorSnapshot({
          source: "payments",
          severity: "medium",
          message:
            `awaiting_capture order ${orderId}: ${state.detail} for ${paymentId} — ` +
            "left blocked and retried next tick",
          orderId,
          razorpayPaymentId: paymentId,
        }).catch(() => undefined);
        continue;
      }

      if (state.kind === "still_authorized") {
        stats.stillAuthorized += 1;
        const alreadyAlertedAt =
          typeof order?.awaitingCaptureAlertedAt === "number"
            ? order.awaitingCaptureAlertedAt
            : 0;
        const shouldAlert =
          !order?.awaitingCaptureAlertedAt ||
          nowMs - alreadyAlertedAt >= AWAITING_CAPTURE_ALERT_INTERVAL_MS;
        await db.collection("orders").doc(orderId).set(
          {
            awaitingCaptureCheckedAt: nowMs,
            awaitingCaptureGatewayStatus: state.gatewayStatus,
            awaitingCaptureChecks: admin.firestore.FieldValue.increment(1),
            ...(shouldAlert ? { awaitingCaptureAlertedAt: nowMs } : {}),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
        await db.collection("unmatched_payments").doc(`ump_awaiting_${orderId}`).set(
          {
            orderId,
            razorpayPaymentId: paymentId,
            status: "needs_review",
            reason: "awaiting_capture_authorized_hold",
            gatewayStatus: state.gatewayStatus,
            receivedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
        if (shouldAlert) {
          await captureErrorSnapshot({
            source: "payments",
            severity: "high",
            message:
              `Order ${orderId} is still AUTHORIZED but uncaptured at the gateway (${paymentId}) — ` +
              "the customer's money is on hold and the order cannot confirm or expire; capture or void it",
            orderId,
            razorpayPaymentId: paymentId,
          }).catch(() => undefined);
        }
        continue;
      }

      if (state.kind === "captured") {
        stats.capturedNeedsReconcile += 1;
        await db.collection("orders").doc(orderId).set(
          {
            awaitingCaptureCheckedAt: nowMs,
            awaitingCaptureGatewayStatus: state.gatewayStatus,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
        await db.collection("unmatched_payments").doc(`ump_awaiting_${orderId}`).set(
          {
            orderId,
            razorpayPaymentId: paymentId,
            status: "needs_review",
            reason: "awaiting_capture_but_gateway_captured",
            gatewayStatus: state.gatewayStatus,
            receivedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
        await captureErrorSnapshot({
          source: "payments",
          severity: "high",
          message:
            `Order ${orderId} was parked awaiting_capture but the gateway reports ${state.gatewayStatus} ` +
            `for ${paymentId} — money moved; confirm or refund deliberately (needs a human)`,
          orderId,
          razorpayPaymentId: paymentId,
        }).catch(() => undefined);
        continue;
      }

      // HOLD GONE: release the marker so the ordinary expiry sweep can act.
      // Transactional and conditional on the SAME parked state, so a capture
      // that lands between the read above and this write always wins.
      const released = await db.runTransaction(async (tx: any) => {
        const freshSnap = await tx.get(doc.ref);
        const fresh = (freshSnap && freshSnap.exists ? freshSnap.data() : null) as any;
        if (!fresh) return false;
        if (String(fresh.paymentStatus || "") !== "awaiting_capture") return false;
        // A different payment id means a NEW attempt owns the order now.
        if (awaitingCapturePaymentIdOf(fresh) !== paymentId) return false;
        const priorPayment =
          fresh.payment && typeof fresh.payment === "object" && !Array.isArray(fresh.payment)
            ? fresh.payment
            : {};
        tx.set(
          doc.ref,
          {
            // The attempt is over and nothing is captured or authorized: the
            // payment strings become `failed`, which is exactly what
            // `isAbandonedUnpaidOnlineOrder` treats as expirable.
            paymentStatus: "failed",
            "payment.status": "failed",
            payment: {
              ...priorPayment,
              status: "failed",
              awaitingCapturePaymentId: admin.firestore.FieldValue.delete(),
              awaitingCaptureSince: admin.firestore.FieldValue.delete(),
            },
            awaitingCaptureResolution: {
              resolution: "hold_gone",
              gatewayStatus: state.gatewayStatus,
              razorpayPaymentId: paymentId,
              resolvedAt: nowMs,
            },
            awaitingCaptureCheckedAt: nowMs,
            awaitingCaptureGatewayStatus: state.gatewayStatus,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
        return true;
      });

      if (!released) continue;
      stats.resolved += 1;
      // The park doc is closed with the release, so nobody keeps chasing it.
      await db.collection("unmatched_payments").doc(`ump_awaiting_${orderId}`).set(
        {
          orderId,
          razorpayPaymentId: paymentId,
          status: "resolved",
          resolution: "hold_gone",
          gatewayStatus: state.gatewayStatus,
          resolvedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      await captureErrorSnapshot({
        source: "payments",
        severity: "medium",
        message:
          `awaiting_capture order ${orderId}: gateway reports ${state.gatewayStatus} for ${paymentId} — ` +
          "no money is held; marker released so the unpaid-order sweep can cancel it",
        orderId,
        razorpayPaymentId: paymentId,
      }).catch(() => undefined);
    } catch (err: any) {
      stats.failed += 1;
      console.warn(
        `[Awaiting Capture] order ${orderId} could not be processed — retried next tick:`,
        err?.message || err
      );
      await captureErrorSnapshot({
        source: "payments",
        severity: "medium",
        message: `awaiting_capture sweep failed for order ${orderId}; it will be retried next tick`,
        orderId,
        errorStack: err?.stack,
      }).catch(() => undefined);
    }
  }

  return stats;
}
