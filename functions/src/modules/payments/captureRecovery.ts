import { db } from "../../core/firebase";
import * as admin from "firebase-admin";
import { captureErrorSnapshot } from "../../core/errors";
import {
  CAPTURE_RECOVERY_AFTER_MS,
  CAPTURE_REFUND_RETRY_BACKOFF_MS,
  CAPTURE_GATE_MAX_ATTEMPTS,
  captureGateAllowsConfirm,
  guardCaptureFulfillment,
  isCompensationState,
  isOrderLifecycleConfirmedOrLater,
  type CaptureFulfillmentState,
} from "./captureFulfillment";

/**
 * Grill-Coins-free money recovery for STUCK capture-fulfilment decisions.
 *
 * Why this exists. Every capture channel can be interrupted: the process dies
 * holding `checking`, the automatic refund fails transiently and records
 * `refund_failed`, or a retryable gate refusal was answered with a non-2xx that
 * the provider eventually stopped redelivering. Before this job, all three
 * left a paid customer either charged with no food or waiting on a redelivery
 * that might never come. This sweep is the independent path that finishes the
 * job WITHOUT depending on Razorpay redelivering anything.
 *
 * It is deliberately narrow and safe:
 *
 *  - It only touches orders whose `captureFulfillment` is `checking`,
 *    `refund_pending`, `refund_failed` (or `fulfillable` on a paid-but-
 *    unconfirmed order) AND whose lease is older than
 *    `CAPTURE_RECOVERY_AFTER_MS`, so it can never race a live channel;
 *  - it re-derives the decision through the SAME `guardCaptureFulfillment`
 *    entry the channels use, so there is exactly one decision rule and one
 *    refund identity (`unful_<order>_<payment>`);
 *  - it confirms a capture that is CLEAR to proceed through the SAME
 *    confirmation routine, so a recovered order can never be both fed and
 *    refunded;
 *  - after `CAPTURE_GATE_MAX_ATTEMPTS` failed refunds it STOPS retrying,
 *    writes one ops snapshot and raises a HIGH alert a human can act on.
 *
 * Idempotency with a late webhook/verify is inherited: the gate transaction and
 * the deterministic refund key make every concurrent actor converge on the same
 * outcome and the same single gateway refund.
 */

export const CAPTURE_RECOVERY_SCAN_LIMIT = 50;

export interface CaptureRecoveryStats {
  scanned: number;
  candidates: number;
  completed: number;
  refunded: number;
  confirmed: number;
  retried: number;
  escalated: number;
  skipped: number;
  failed: number;
}

/** States this job is allowed to take over once their lease has expired. */
const RECOVERABLE_STATES: ReadonlySet<CaptureFulfillmentState> = new Set([
  "checking",
  "refund_pending",
  "refund_failed",
  "fulfillable",
]);

function gateOf(order: any): {
  state: string;
  paymentId: string;
  atMs: number;
  attempts: number;
  detail?: string;
} | null {
  const raw = order?.captureFulfillment;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const state = typeof (raw as any).state === "string" ? (raw as any).state : "";
  const paymentId =
    typeof (raw as any).paymentId === "string" ? (raw as any).paymentId : "";
  if (!state || !paymentId) return null;
  return {
    state,
    paymentId,
    atMs: Number((raw as any).atMs) || 0,
    attempts: Math.max(0, Math.floor(Number((raw as any).attempts) || 0)),
    detail: typeof (raw as any).detail === "string" ? (raw as any).detail : undefined,
  };
}

/** The captured payment id an order carries, in either storage shape. */
function capturedPaymentIdOf(order: any): string {
  const nested = order?.payment?.razorpayPaymentId;
  const dotted = order?.["payment.razorpayPaymentId"];
  if (typeof nested === "string" && nested) return nested;
  if (typeof dotted === "string" && dotted) return dotted;
  return "";
}

function capturedPaiseOf(order: any): number | undefined {
  const nested = Number(order?.payment?.capturedAmountPaise);
  if (Number.isFinite(nested) && nested > 0) return nested;
  const dotted = Number(order?.["payment.capturedAmountPaise"]);
  if (Number.isFinite(dotted) && dotted > 0) return dotted;
  return undefined;
}

/**
 * Escalation is ONE deterministic doc per order (merge), so a repeatedly
 * sweeping job cannot spam staff with the same case, and a resolved case is
 * evident from its age. A HIGH snapshot pages through the existing alert
 * channels at the same time.
 */
async function escalateStuckCapture(args: {
  orderId: string;
  paymentId: string;
  state: string;
  attempts: number;
  detail?: string;
}): Promise<void> {
  const reason =
    args.state === "refund_failed"
      ? "refund_retries_exhausted"
      : args.state === "checking"
        ? "capture_decision_stuck"
        : "capture_recovery_exhausted";
  try {
    await db
      .collection("unmatched_payments")
      .doc(`ump_gate_${args.paymentId}`)
      .set(
        {
          eventId: `gate_${args.paymentId}`,
          event: "capture_fulfilment_recovery",
          razorpayPaymentId: args.paymentId,
          orderId: args.orderId,
          claimedOrderId: args.orderId,
          amount: null,
          currency: "INR",
          status: "needs_review",
          reason,
          gateState: args.state,
          attempts: args.attempts,
          detail: args.detail || null,
          staffAction: "refund_manually_or_repair_gate",
          receivedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
  } catch (err: any) {
    console.warn(
      `[Capture Recovery] escalation park write failed for order ${args.orderId}:`,
      err?.message || err
    );
  }
  await captureErrorSnapshot({
    source: "payments",
    severity: "high",
    message:
      `Capture fulfilment recovery STOPPED for order ${args.orderId} (payment ${args.paymentId}): ` +
      `gate is ${args.state} after ${args.attempts} attempt(s) — manual intervention required ` +
      `(see unmatched_payments/ump_gate_${args.paymentId})`,
    orderId: args.orderId,
    razorpayPaymentId: args.paymentId,
  }).catch(() => undefined);
}

/**
 * One recovery sweep. Exported for the scheduled function and for tests; the
 * function wrapper in `index.ts` owns the scheduler lock and cadence.
 */
export async function recoverStuckCaptureFulfilments(
  nowMs: number = Date.now()
): Promise<CaptureRecoveryStats> {
  const stats: CaptureRecoveryStats = {
    scanned: 0,
    candidates: 0,
    completed: 0,
    refunded: 0,
    confirmed: 0,
    retried: 0,
    escalated: 0,
    skipped: 0,
    failed: 0,
  };

  // ONE bounded query per recoverable state, all over the SAME top-level field.
  //
  // `captureFulfillmentState` is a mirrored top-level scalar (written beside the
  // nested record on every transition), so Firestore's automatic single-field
  // index serves these equality scans and NO composite index has to be
  // deployed with the job. Scanning the nested path instead would need one, and
  // `state` is not the only recoverable value, so a single query cannot cover
  // the lane.
  const docs: any[] = [];
  for (const state of ["checking", "refund_pending", "refund_failed"] as const) {
    try {
      const page = await db
        .collection("orders")
        .where("captureFulfillmentState", "==", state)
        .limit(CAPTURE_RECOVERY_SCAN_LIMIT)
        .get();
      if (Array.isArray(page?.docs)) docs.push(...page.docs);
    } catch (err: any) {
      await captureErrorSnapshot({
        source: "payments",
        severity: "high",
        message: `Capture-fulfilment recovery scan failed for state ${state} — that lane is skipped this tick`,
        errorStack: err?.stack,
      }).catch(() => undefined);
    }
  }

  // `fulfillable` means the decision was made but no channel finished it. That
  // is the only state where recovery must CONFIRM, and it is scanned last with
  // its own budget so a healthy backlog cannot starve the refund lanes.
  try {
    const page = await db
      .collection("orders")
      .where("captureFulfillmentState", "==", "fulfillable")
      .limit(CAPTURE_RECOVERY_SCAN_LIMIT)
      .get();
    if (Array.isArray(page?.docs)) docs.push(...page.docs);
  } catch (err: any) {
    await captureErrorSnapshot({
      source: "payments",
      severity: "medium",
      message: "Capture-fulfilment recovery scan failed for state fulfillable — that lane is skipped this tick",
      errorStack: err?.stack,
    }).catch(() => undefined);
  }

  const seen = new Set<string>();
  stats.scanned = docs.length;

  for (const doc of docs) {
    const orderId = typeof doc?.id === "string" ? doc.id : "";
    if (!orderId || seen.has(orderId)) continue;
    seen.add(orderId);

    try {
      const order = (typeof doc.data === "function" ? doc.data() : doc) || {};
      const gate = gateOf(order);
      if (!gate) continue;
      if (!RECOVERABLE_STATES.has(gate.state as CaptureFulfillmentState)) continue;

      // A confirmed/terminal LIFECYCLE order needs no recovery: the
      // confirmation won. Checked with the lifecycle-only rule because a
      // compensation stamps `paymentStatus: "completed"` without confirming.
      if (isOrderLifecycleConfirmedOrLater(order)) {
        stats.skipped += 1;
        continue;
      }

      const paymentId = gate.paymentId || capturedPaymentIdOf(order);
      if (!paymentId) {
        stats.skipped += 1;
        continue;
      }

      // Never race a live channel, and never hot-loop a known failure.
      //  - `refund_failed` is a PROVEN failed attempt, so only a short backoff
      //    applies (nothing is in flight) — it must be retried quickly.
      //  - everything else needs the full recovery window, because the owner may
      //    still be deciding or the refund POST may still be on the wire.
      const quietFor =
        gate.state === "refund_failed"
          ? CAPTURE_REFUND_RETRY_BACKOFF_MS
          : CAPTURE_RECOVERY_AFTER_MS;
      if (gate.atMs > 0 && nowMs - gate.atMs < quietFor) {
        stats.skipped += 1;
        continue;
      }
      stats.candidates += 1;

      // Attempt budget is enforced for the REFUND lanes. A fresh `checking`
      // that never decided is not an attempt: it gets one decision here.
      const attemptsUsed = Math.max(gate.attempts, 0);
      if (
        (gate.state === "refund_failed" || gate.state === "refund_pending") &&
        attemptsUsed >= CAPTURE_GATE_MAX_ATTEMPTS
      ) {
        await escalateStuckCapture({
          orderId,
          paymentId,
          state: gate.state,
          attempts: attemptsUsed,
          detail: gate.detail,
        });
        stats.escalated += 1;
        continue;
      }

      const orderRef = db.collection("orders").doc(orderId);
      const outcome = await guardCaptureFulfillment({
        orderRef,
        orderId,
        razorpayPaymentId: paymentId,
        razorpayOrderId:
          typeof order?.payment?.razorpayOrderId === "string"
            ? order.payment.razorpayOrderId
            : typeof order?.["payment.razorpayOrderId"] === "string"
              ? order["payment.razorpayOrderId"]
              : null,
        orderData: order,
        capturedAmountPaise: capturedPaiseOf(order),
        nowMs,
      });

      if (outcome.outcome === "refunded" || outcome.outcome === "already_compensated") {
        stats.refunded += 1;
        stats.completed += 1;
        continue;
      }
      if (outcome.outcome === "refund_failed") {
        // Retryable: the next tick continues, until the attempt budget is spent.
        const after = await orderRef.get().catch(() => null);
        const recorded = after?.exists ? gateOf(after.data() as any) : null;
        const used = Math.max(recorded?.attempts ?? 0, attemptsUsed);
        if (used >= CAPTURE_GATE_MAX_ATTEMPTS) {
          await escalateStuckCapture({
            orderId,
            paymentId,
            state: "refund_failed",
            attempts: used,
            detail: outcome.detail,
          });
          stats.escalated += 1;
        } else {
          stats.retried += 1;
        }
        continue;
      }
      if (outcome.outcome === "pending") {
        // Another actor took the lease while we looked: leave it alone.
        stats.skipped += 1;
        continue;
      }

      // fulfillable / already_confirmed: the decision is clear, so finish the
      // job by confirming through the shared routine. This is the SAME call the
      // capture channels make, so a recovered order cannot be both fed and
      // refunded.
      if (outcome.outcome === "fulfillable" || outcome.outcome === "already_confirmed") {
        const fresh = await orderRef.get();
        const live = fresh.exists ? ((fresh.data() || {}) as any) : {};
        if (!captureGateAllowsConfirm(live, paymentId)) {
          // A compensation landed between the decision and this read.
          stats.skipped += 1;
          continue;
        }
        const { completeRecoveredCapture } = await import("./razorpay.service");
        const confirmed = await completeRecoveredCapture({
          orderId,
          razorpayPaymentId: paymentId,
          orderData: live,
        });
        if (confirmed) {
          stats.confirmed += 1;
          stats.completed += 1;
        } else {
          // Not confirmable (a compensation landed, or a transient failure):
          // the next tick retries, and the attempt budget eventually escalates.
          stats.retried += 1;
        }
        continue;
      }

      stats.skipped += 1;
    } catch (err: any) {
      stats.failed += 1;
      console.warn(
        `[Capture Recovery] failed to recover order ${orderId} — retried next tick:`,
        err?.message || err,
        err?.stack
      );
      await captureErrorSnapshot({
        source: "payments",
        severity: "medium",
        message: `Capture-fulfilment recovery failed for order ${orderId}; it will be retried next tick`,
        orderId,
        errorStack: err?.stack,
      }).catch(() => undefined);
    }
  }

  return stats;
}
