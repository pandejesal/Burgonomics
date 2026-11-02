import { db } from "../../core/firebase";
import { captureErrorSnapshot } from "../../core/errors";
import { autoRefund } from "./razorpay.service";
import { buildTerminalCaptureParkPayload } from "./reconciliation";

/**
 * P1-C layer 2 — the unavoidable tail of the expiry race.
 *
 * Razorpay cannot "close" an order, so there is no gateway-side window we can
 * shut: a customer can authorize and capture after our cancel. Layer 1 (see
 * `isUnsafeToExpire` / `orderState`'s cancel transaction) makes that vanishingly
 * unlikely, but a capture that DOES land afterwards must never become
 * "charged and ignored".
 *
 * Every such capture is refunded in FULL, automatically:
 *  - through `autoRefund` — the SAME accounting a manual refund uses — so the
 *    refund ledger, `refundedTotalPaise`, `applyRefundToMonthlyFee` and the
 *    `payment_audits/aud_rfnd_*` trail are produced once, by one code path.
 *    No second refund mechanism exists.
 *  - idempotently: identity is the durable `refundRequestId`
 *    `latecap_<orderId>_<paymentId>`, so a redelivered webhook replays the
 *    stored receipt instead of paying twice (`autoRefund` returns `reused`).
 *  - WITHOUT ever resurrecting the order: nothing here writes a status, a
 *    payment channel, or a KOT. The order stays CANCELLED; the money comes back.
 *
 * Scope is deliberately narrow (`payment_not_completed` cancellations only):
 * a staff/customer cancellation or a dispute resolution must not be silently
 * reversed by an automation that cannot see the conversation.
 */

export const EXPIRY_CANCELLATION_REASON = "payment_not_completed";

export type LateCaptureRefundOutcome =
  | { refunded: true; reason: "captured_after_expiry"; refundId: string; reused: boolean }
  | {
      refunded: false;
      reason:
        | "order_not_found"
        | "order_not_expired"
        | "not_an_expiry_cancellation"
        | "already_refunded"
        | "refund_refused";
      detail?: string;
    };

export interface LateCaptureRefundInput {
  orderId: string;
  razorpayPaymentId: string;
  razorpayOrderId?: string | null;
  capturedAmountPaise?: number | null;
  source: string;
}

/** Deterministic, gateway-safe refund request id (8-128 chars [A-Za-z0-9_-]). */
export function lateCaptureRefundRequestId(orderId: string, razorpayPaymentId: string): string {
  const clean = (value: string) => String(value || "").replace(/[^A-Za-z0-9_-]/g, "");
  return `latecap_${clean(orderId)}_${clean(razorpayPaymentId)}`.slice(0, 120);
}

function statusCodeOf(order: any): string {
  const raw = typeof order?.status === "string" ? order.status : order?.status?.code;
  return String(raw || "").toUpperCase();
}

export async function refundLateCaptureForExpiredOrder(
  input: LateCaptureRefundInput
): Promise<LateCaptureRefundOutcome> {
  const orderId = typeof input.orderId === "string" ? input.orderId.trim() : "";
  const razorpayPaymentId =
    typeof input.razorpayPaymentId === "string" ? input.razorpayPaymentId.trim() : "";
  if (!orderId || !razorpayPaymentId) {
    return { refunded: false, reason: "order_not_found" };
  }

  const orderRef = db.collection("orders").doc(orderId);
  const snap = await orderRef.get();
  if (!snap.exists) {
    // Money captured against an order we cannot see: never drop it silently.
    await parkLateCapture(input, "late_capture_order_not_found");
    return { refunded: false, reason: "order_not_found" };
  }
  const order = (snap.data() || {}) as Record<string, any>;

  const code = statusCodeOf(order);
  const reason = typeof order.cancellationReason === "string" ? order.cancellationReason : "";
  if (code !== "CANCELLED") {
    // Not an expired order: the normal confirm path owns this capture.
    return { refunded: false, reason: "order_not_expired" };
  }
  if (reason !== EXPIRY_CANCELLATION_REASON) {
    return { refunded: false, reason: "not_an_expiry_cancellation" };
  }

  // A capture we already returned must not be paid back twice. `autoRefund`
  // owns that decision (durable refund request id → stored receipt replay,
  // plus the cumulative cap and ALREADY_REFUNDED). This function deliberately
  // does NOT pre-empt it with its own "looks refunded" verdict: a duplicate
  // webhook must reach autoRefund and be answered with `reused`, so the replay
  // names the receipt it matched instead of inventing a local refusal.
  const capturedPaise =
    Number(input.capturedAmountPaise) ||
    Number(order?.payment?.capturedAmountPaise) ||
    Number(order?.["payment.capturedAmountPaise"]) ||
    0;

  // The capture is real money on an order nobody will cook. Record it on the
  // order first (both storage shapes the refund guard accepts), so `autoRefund`
  // can prove what it is refunding — the expiry cancel never wrote a capture.
  try {
    await orderRef.set(
      {
        payment: {
          ...(order.payment && typeof order.payment === "object" && !Array.isArray(order.payment)
            ? order.payment
            : {}),
          razorpayPaymentId,
          status: "completed",
          ...(capturedPaise > 0 ? { capturedAmountPaise: capturedPaise } : {}),
          lateCaptureAfterExpiryAt: Date.now(),
        },
        "payment.razorpayPaymentId": razorpayPaymentId,
        ...(razorpayPaymentId ? { "payment.status": "completed" } : {}),
        ...(capturedPaise > 0 ? { "payment.capturedAmountPaise": capturedPaise } : {}),
        paymentLateCapture: {
          razorpayPaymentId,
          razorpayOrderId: input.razorpayOrderId || null,
          capturedAmountPaise: capturedPaise > 0 ? capturedPaise : null,
          source: input.source,
          detectedAt: Date.now(),
        },
      },
      { merge: true }
    );
  } catch (err: any) {
    // Without the capture stamp autoRefund refuses (NO_CAPTURED_PAYMENT); park
    // for a human instead of pretending the money was handled.
    await parkLateCapture(input, "late_capture_stamp_failed");
    await captureErrorSnapshot({
      source: "payments",
      severity: "high",
      message: `Late capture ${razorpayPaymentId} on expired order ${orderId} could not be stamped — manual refund required`,
      orderId,
      razorpayPaymentId,
      errorStack: err?.stack,
    }).catch(() => undefined);
    return { refunded: false, reason: "refund_refused", detail: err?.message || String(err) };
  }

  try {
    const result: any = await autoRefund({
      orderId,
      razorpayPaymentId,
      // FULL refund by intent: amountRupees stays unset so the whole capture
      // comes back (a partial would leave the customer short).
      reason: `Automatic refund — payment captured after the order expired unpaid (order ${orderId})`,
      refundRequestId: lateCaptureRefundRequestId(orderId, razorpayPaymentId),
    });
    const refundId = typeof result?.id === "string" ? result.id : "";
    const reused = result?.reused === true;
    await captureErrorSnapshot({
      source: "payments",
      severity: "medium",
      message: reused
        ? `Late capture ${razorpayPaymentId} on expired order ${orderId} — refund ${refundId} already issued (replayed, no second refund)`
        : `Late capture ${razorpayPaymentId} on expired order ${orderId} — automatically refunded in full (refund ${refundId}); order stays cancelled`,
      orderId,
      razorpayPaymentId,
    }).catch(() => undefined);
    return { refunded: true, reason: "captured_after_expiry", refundId, reused };
  } catch (err: any) {
    // The customer's money is captured and our automatic refund failed: park
    // it where ops already look for unapplied captures and page.
    await parkLateCapture(input, "late_capture_refund_failed", err?.message);
    await captureErrorSnapshot({
      source: "payments",
      severity: "high",
      message: `Automatic refund FAILED for late capture ${razorpayPaymentId} on expired order ${orderId} — manual refund required (${err?.message || err})`,
      orderId,
      razorpayPaymentId,
      errorStack: err?.stack,
    }).catch(() => undefined);
    return { refunded: false, reason: "refund_refused", detail: err?.message || String(err) };
  }
}

async function parkLateCapture(
  input: LateCaptureRefundInput,
  reason: string,
  detail?: string
): Promise<void> {
  try {
    const payload = buildTerminalCaptureParkPayload({
      orderId: input.orderId,
      razorpayPaymentId: input.razorpayPaymentId,
      razorpayOrderId: input.razorpayOrderId || null,
      amountPaise:
        typeof input.capturedAmountPaise === "number" ? input.capturedAmountPaise : null,
      reason,
      source: input.source,
      metadata: detail ? { detail } : undefined,
    });
    await db
      .collection("unmatched_payments")
      .doc(`ump_term_${input.razorpayPaymentId}`)
      .set(payload, { merge: true });
  } catch (err: any) {
    console.warn(
      `[LateCapture] park failed for ${input.razorpayPaymentId}:`,
      err?.message || err
    );
  }
}
