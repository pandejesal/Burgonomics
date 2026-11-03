import * as admin from "firebase-admin";
import { randomUUID } from "crypto";
import { db as defaultDb } from "../../core/firebase";
import { captureErrorSnapshot } from "../../core/errors";

/**
 * Cancel → refund obligation (durable, human-approved).
 *
 * A PAID order that gets cancelled must never silently keep the customer's
 * money, and must never auto-fire a gateway refund either. This module leaves
 * ONE deterministic `refunds/{id}` PENDING row for a human to approve in the
 * partner Refunds console and stamps `payment.refundStatus = PENDING_APPROVAL`
 * on the order.
 *
 * Trust model: the ONLY proof accepted is the server-written capture truth —
 * `paymentChannel === "razorpay"` (written by verifyPayment / the
 * `payment.captured` webhook, never by a client), the captured payment id and
 * `payment.capturedAmountPaise`. `payment.method` and any client total are
 * never treated as proof of money or as the queue amount.
 *
 * Receipt math mirrors the authoritative refund authority in
 * `payments/razorpay.service.ts`:
 *   recordedRefunded = max(refundedTotalPaise,
 *                         ledgerSum + unrepresented scalar refundId/refundAmount)
 *   full only when recordedRefunded >= capture, or the full-intent shape
 *   (`refundStatus === "refunded" && refundId && refundAmount === null`).
 * A "refunded" status with a POSITIVE refundAmount is a partial stamp.
 *
 * Ownership: rows carry `ownership: "machine"` when this module created them.
 * Only machine-owned PENDING rows are ever revalidated/withdrawn/re-cut;
 * human decisions (APPROVED/REJECTED/…) and rows without the marker are left
 * exactly as they are. Money-movement claims (`refundActiveClaim`, legacy
 * `refundClaimedAt`, `refunding`) stand the queue down entirely.
 *
 * Replay safety: the row id is derived from the order id and is read inside the
 * same transaction that writes it, so a replayed event or a retry can never
 * mint a second request or rewrite a human's decision.
 */

export type CancelRefundSkipReason =
  | "not_cancelled"
  | "no_server_channel"
  | "no_payment_id"
  | "no_captured_amount"
  | "fully_refunded"
  | "existing_decision"
  | "existing_refund"
  | "refund_in_progress"
  | "refund_history_ambiguous"
  | "already_queued"
  | "queue_failed";

export interface CancelRefundPlan {
  eligible: boolean;
  reason?: CancelRefundSkipReason;
  /** Remaining refundable amount in paise (never from a client total). */
  amountPaise?: number;
  paymentId?: string;
  capturedPaise?: number;
  refundedPaise?: number;
}

/**
 * Human/POS decisions on a REFUNDS ROW that already own this money. These are
 * row statuses, never order-level stamps: `payment.refundStatus` is written by
 * this module (`PENDING_APPROVAL`) and by autoRefund (`refunding`), so it is
 * not evidence of a human decision.
 */
const HUMAN_DECISION_ROW_STATUSES = new Set([
  "APPROVED",
  "PROCESSING",
  "IN_PROGRESS",
  "REJECTED",
  "COMPLETED",
  "FAILED",
  "WITHDRAWN",
]);

/** Bounded alert retries; past this the row is visibly stuck for ops. */
export const REFUND_ALERT_MAX_ATTEMPTS = 3;
const REFUND_ALERT_CLAIM_TTL_MS = 5 * 60_000;

function statusCodeOf(order: any): string {
  const raw = typeof order?.status === "object" ? order?.status?.code : order?.status;
  return String(raw || "").toUpperCase();
}

function num(value: any): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

/** Server capture truth only — the nested or dotted form the payment writer emits. */
function capturedPaiseOf(order: any): number {
  return (
    num(order?.payment?.capturedAmountPaise) || num(order?.["payment.capturedAmountPaise"])
  );
}

function paymentIdOf(order: any): string {
  const raw =
    order?.payment?.razorpayPaymentId ?? order?.["payment.razorpayPaymentId"] ?? "";
  return typeof raw === "string" ? raw.trim() : "";
}

/**
 * Any existing refund identity holds this queue — with NO time bound.
 *
 * Mirrors the authoritative stance in razorpay.service.ts:3841-3870: an
 * unresolved identity (unkeyed, or parked for reconciliation) may still have
 * money on the wire, so the payment service refuses to re-POST it at ANY age.
 * Same-identity recovery belongs to autoRefund, which owns the gateway key;
 * this review queue would mint a DIFFERENT identity and could double-pay. So
 * we stand down rather than "expire" the claim — that is why there is no TTL
 * here even though autoRefund has one for its own stale takeover.
 */
export function hasLiveRefundClaim(order: any): boolean {
  const claim = order?.refundActiveClaim;
  if (claim && typeof claim === "object" && !Array.isArray(claim)) {
    const claimedAt = Number(claim.claimedAt);
    const hasIdentity = typeof claim.requestId === "string" && claim.requestId.trim() !== "";
    if (hasIdentity || (Number.isFinite(claimedAt) && claimedAt > 0)) return true;
  }
  const legacyClaimedAt = Number(order?.refundClaimedAt);
  const legacyRequestId =
    typeof order?.refundClaimedRequestId === "string" ? order.refundClaimedRequestId.trim() : "";
  return legacyRequestId !== "" || (Number.isFinite(legacyClaimedAt) && legacyClaimedAt > 0);
}

/**
 * Already-refunded paise, matching the payment service receipt math: the
 * scalar total accumulates, the ledger counts each gateway refund id once, and
 * a legacy receipt (`refundId` + `refundAmount`) that the ledger does not
 * already represent is real money returned.
 *
 * `refundAmount` ALONE is not a receipt: razorpay.service.ts:3644-3659 only
 * folds the scalar in when a real `refundId` exists, because `refundAmount` is
 * also the *requested* amount of an in-flight/abandoned attempt. Counting it
 * without an id would silently under-queue the customer's money.
 */
function refundedPaiseOf(order: any): number {
  const scalar = num(order?.refundedTotalPaise);
  const ledger =
    order?.refundLedger && typeof order.refundLedger === "object" && !Array.isArray(order.refundLedger)
      ? Object.values(order.refundLedger as Record<string, any>).reduce(
          (sum: number, v: any) => sum + num(v),
          0
        )
      : 0;

  const scalarRefundId =
    typeof order?.refundId === "string" && order.refundId.trim() ? order.refundId.trim() : null;
  const scalarRefundPaise =
    typeof order?.refundAmount === "number" && Number.isFinite(order.refundAmount)
      ? Math.round(order.refundAmount * 100)
      : 0;
  const ledgerHasScalar =
    !!scalarRefundId &&
    !!order?.refundLedger &&
    typeof order.refundLedger === "object" &&
    !Array.isArray(order.refundLedger) &&
    Object.prototype.hasOwnProperty.call(order.refundLedger, scalarRefundId);
  // Requires a real refundId — an id-less amount is not proof of money returned.
  const unrepresentedScalar =
    !!scalarRefundId && !ledgerHasScalar ? scalarRefundPaise : 0;

  return Math.max(scalar, ledger + unrepresentedScalar);
}

/** The unambiguous full-refund intent shape (razorpay.service.ts:3914-3917). */
function isFullIntentShape(order: any): boolean {
  return (
    order?.refundStatus === "refunded" &&
    !!order?.refundId &&
    (order?.refundAmount ?? null) === null
  );
}

/**
 * Pure gate: decides whether a cancelled order owes a staff-reviewed refund
 * and how much. No I/O — callers re-run it against the freshest snapshot they
 * can see so a race (refund landed, human decided, money moving) always wins.
 */
export function planCancelRefundObligation(order: any): CancelRefundPlan {
  if (statusCodeOf(order) !== "CANCELLED") {
    return { eligible: false, reason: "not_cancelled" };
  }
  // Server-only marker; a client-written payment.method never authorizes this.
  if (order?.paymentChannel !== "razorpay") {
    return { eligible: false, reason: "no_server_channel" };
  }
  const paymentId = paymentIdOf(order);
  if (!paymentId) {
    return { eligible: false, reason: "no_payment_id" };
  }
  const capturedPaise = capturedPaiseOf(order);
  if (capturedPaise <= 0) {
    return { eligible: false, reason: "no_captured_amount" };
  }
  // Money may already be on the wire: never queue a second claim beside it.
  if (hasLiveRefundClaim(order) || order?.payment?.refunded === true) {
    return { eligible: false, reason: "refund_in_progress" };
  }
  // Both storage shapes are read: autoRefund claims nest under `payment`,
  // legacy writers stamped the top-level key.
  const declaredPayment = String(order?.payment?.refundStatus ?? "").toUpperCase();
  const declaredTop = String(order?.refundStatus ?? "").toUpperCase();
  if (declaredPayment === "REFUNDING" || declaredTop === "REFUNDING") {
    return { eligible: false, reason: "refund_in_progress" };
  }
  if (isFullIntentShape(order)) {
    return {
      eligible: false,
      reason: "fully_refunded",
      capturedPaise,
      refundedPaise: refundedPaiseOf(order),
    };
  }
  const refundedPaise = refundedPaiseOf(order);
  if (refundedPaise >= capturedPaise) {
    return { eligible: false, reason: "fully_refunded", capturedPaise, refundedPaise };
  }
  const amountPaise = capturedPaise - refundedPaise;
  if (amountPaise <= 0) {
    return { eligible: false, reason: "fully_refunded", capturedPaise, refundedPaise };
  }
  return { eligible: true, amountPaise, paymentId, capturedPaise, refundedPaise };
}

/** Deterministic queue id: one cancel-review row per order, forever. */
export function cancelRefundRequestId(orderId: string): string {
  const safe = String(orderId || "").replace(/[^A-Za-z0-9_-]/g, "_");
  return `refund_cancel_${safe}`;
}

export interface EnsureCancelRefundResult {
  created: boolean;
  refundId?: string;
  amountPaise?: number;
  /**
   * A PENDING review row that still needs a staff alert (ours or the POS one),
   * already revalidated against fresh truth. Together with `reviewAmountPaise`
   * this is the ONLY thing the caller may alert on.
   */
  pendingRefundId?: string;
  reviewAmountPaise?: number;
  /** Another row's human decision (e.g. disposed POS request) owns the money. */
  existingRefundId?: string;
  reason?: CancelRefundSkipReason;
}

/**
 * Creates, re-cuts, or withdraws the PENDING approval row. All reads happen
 * before any write inside one transaction, so a concurrent human decision or a
 * landed refund cannot be clobbered by a stale event.
 */
export async function ensureCancelledPaidRefundObligation(params: {
  orderId: string;
  after: any;
  db?: any;
  reason?: string;
}): Promise<EnsureCancelRefundResult> {
  const { orderId, after } = params;
  const db = params.db || defaultDb;
  const refundDocId = cancelRefundRequestId(orderId);

  // Cheap pre-check on the event payload: never open a transaction for an
  // unrelated transition (this also runs as the retry hook on every update).
  if (statusCodeOf(after) !== "CANCELLED") {
    return { created: false, reason: "not_cancelled" };
  }
  // A later capture carries its own order-update event. An unverified/cash
  // event must not acquire a false refund obligation merely because a database
  // read fails before we can inspect it.
  if (after?.paymentChannel !== "razorpay") {
    return { created: false, reason: "no_server_channel" };
  }

  try {
    const outcome = await db.runTransaction(async (tx: any) => {
      const refundRef = db.collection("refunds").doc(refundDocId);

      // 1. ALL READS FIRST.
      const existingRowSnap = await tx.get(refundRef);
      const existingRow = existingRowSnap?.exists
        ? ((existingRowSnap.data() || {}) as Record<string, any>)
        : null;

      const orderSnap = await tx.get(db.collection("orders").doc(orderId));
      const fresh = orderSnap?.exists
        ? ((orderSnap.data() || {}) as Record<string, any>)
        : null;
      if (!fresh) {
        return { created: false, reason: "not_cancelled" as CancelRefundSkipReason };
      }

      // Read one beyond the ownership budget. A truncated history is NOT proof
      // that no other operator owns the decision.
      const siblingsSnap = await tx.get(
        db.collection("refunds").where("orderId", "==", orderId).limit(11)
      );
      const siblings: Array<{ id: string; data: Record<string, any> }> = (
        siblingsSnap?.docs || []
      )
        .map((doc: any) => ({
          id: String(doc.id || ""),
          data: (doc.data?.() || {}) as Record<string, any>,
        }))
        .filter((row: { id: string }) => row.id !== refundDocId);

      // Re-run the gate on the FRESH doc: a refund that landed between the
      // event and this transaction wins, and live money movement stands down.
      const plan = planCancelRefundObligation(fresh);
      const machinePending = existingRow?.ownership === "machine" &&
        String(existingRow.status || "").toUpperCase() === "PENDING";
      const withdrawMachineRequest = (reason: string, supersededBy?: string) => {
        if (!machinePending) return;
        tx.set(refundRef, {
          status: "WITHDRAWN",
          withdrawReason: reason,
          ...(supersededBy ? { supersededBy } : {}),
          withdrawnAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
        tx.set(db.collection("orders").doc(orderId), {
          refundObligation: {
            status: "WITHDRAWN",
            refundId: refundDocId,
            reason,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
        }, { merge: true });
      };

      if ((siblingsSnap?.docs?.length || 0) > 10) {
        withdrawMachineRequest("refund_history_ambiguous");
        return { created: false, reason: "refund_history_ambiguous" as CancelRefundSkipReason,
          requiresManualReview: true };
      }
      // Never rewrite a human decision or an unknown-provenance deterministic row.
      if (existingRow && !machinePending) {
        return { created: false, reason: "already_queued" as CancelRefundSkipReason };
      }

      // A COMPLETED partial intent does not own money that remains captured.
      // Ignore completed rows only when their whole positive amount is already
      // accounted for by the authoritative order receipts; ambiguity holds.
      const completedRows = siblings.filter(row =>
        String(row.data.status || "").toUpperCase() === "COMPLETED");
      const completedAmount = completedRows.reduce((sum, row) => sum + num(row.data.amountPaise), 0);
      const completedAccounted = completedRows.every(row => num(row.data.amountPaise) > 0) &&
        completedAmount <= (plan.refundedPaise || 0);
      const decidedElsewhere = siblings.find(row => {
        const status = String(row.data.status || "").toUpperCase();
        return HUMAN_DECISION_ROW_STATUSES.has(status) &&
          !(status === "COMPLETED" && completedAccounted);
      });
      if (decidedElsewhere) {
        withdrawMachineRequest("superseded_by_decision", decidedElsewhere.id);
        return { created: false, reason: "existing_decision" as CancelRefundSkipReason,
          existingRefundId: decidedElsewhere.id };
      }

      const pendingElsewhere = siblings.find(row =>
        String(row.data.status || "").toUpperCase() === "PENDING");
      if (pendingElsewhere) {
        withdrawMachineRequest("superseded_by_existing_request", pendingElsewhere.id);
        return {
          created: false,
          reason: "existing_refund" as CancelRefundSkipReason,
          existingRefundId: pendingElsewhere.id,
          ...(plan.eligible && num(pendingElsewhere.data.amountPaise) > 0 ? {
            pendingRefundId: pendingElsewhere.id,
            reviewAmountPaise: num(pendingElsewhere.data.amountPaise),
          } : {}),
        };
      }

      // A row already exists under our deterministic id.
      if (existingRow) {
        // Our own PENDING row, but fresh truth PROVES the money is settled:
        // withdraw it so a stale queue row cannot outlive the refund.
        // `PENDING_APPROVAL` on the order is this module's own marker, so it
        // never counts as proof and never withdraws the row.
        if (!plan.eligible) {
          if (plan.reason === "fully_refunded") {
            withdrawMachineRequest(plan.reason);
            return { created: false, reason: plan.reason };
          }
          // Refund in flight / channel gone: keep the row, alert nothing.
          return { created: false, reason: plan.reason };
        }

        // Still owed, but the amount moved (partial refund landed elsewhere):
        // re-cut OUR row to the remaining amount. One write, no new row.
        const newAmount = plan.amountPaise as number;
        if (num(existingRow.amountPaise) !== newAmount) {
          tx.set(
            refundRef,
            {
              amountPaise: newAmount,
              capturedPaise: plan.capturedPaise,
              alreadyRefundedPaise: plan.refundedPaise,
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
        }
        return {
          created: false,
          reason: "already_queued" as CancelRefundSkipReason,
          pendingRefundId: refundDocId,
          reviewAmountPaise: newAmount,
        };
      }

      if (!plan.eligible) {
        return { created: false, reason: plan.reason };
      }

      // 2. WRITES.
      tx.set(refundRef, {
        id: refundDocId,
        orderId,
        paymentId: plan.paymentId,
        razorpayPaymentId: plan.paymentId,
        branchId: fresh.branchId ?? null,
        amountPaise: plan.amountPaise,
        capturedPaise: plan.capturedPaise,
        alreadyRefundedPaise: plan.refundedPaise,
        currency: "INR",
        reason: params.reason || "ORDER_CANCELLED_AFTER_PAYMENT",
        detail: "Order cancelled after a server-confirmed Razorpay capture — refund awaits staff approval.",
        status: "PENDING",
        source: "order_cancel",
        ownership: "machine",
        processedBy: null,
        gatewayStatus: "awaiting_approval",
        alertAttempts: 0,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      tx.set(
        db.collection("orders").doc(orderId),
        {
          payment: { refundStatus: "PENDING_APPROVAL" },
          refundObligation: {
            status: "QUEUED",
            refundId: refundDocId,
            amountPaise: plan.amountPaise,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
        },
        { merge: true }
      );

      return {
        created: true,
        refundId: refundDocId,
        amountPaise: plan.amountPaise,
        pendingRefundId: refundDocId,
        reviewAmountPaise: plan.amountPaise,
      };
    });

    if (outcome?.requiresManualReview) {
      await captureErrorSnapshot({
        source: "payments", severity: "high", orderId,
        message: `Cancelled order ${orderId} refund history exceeds the ownership read budget — manual review required; no new refund request authorized`,
      }, { snapshotId: `err_cancel_refund_history_${orderId}` }).catch(() => undefined);
    }
    if (outcome?.created) {
      return {
        created: true,
        refundId: outcome.refundId,
        amountPaise: outcome.amountPaise,
        pendingRefundId: outcome.pendingRefundId,
        reviewAmountPaise: outcome.reviewAmountPaise,
      };
    }
    return {
      created: false,
      reason: outcome?.reason,
      ...(outcome?.existingRefundId ? { existingRefundId: outcome.existingRefundId } : {}),
      ...(outcome?.pendingRefundId
        ? { pendingRefundId: outcome.pendingRefundId, reviewAmountPaise: outcome.reviewAmountPaise }
        : {}),
    };
  } catch (err: any) {
    // Never silent: park a durable, retryable obligation on the order (any
    // later genuine update of this cancelled order re-attempts the queue) and
    // raise a high-severity snapshot so ops can see money awaiting a decision.
    // There is deliberately NO self-scheduled retry: an order that never
    // updates again needs an operator (documented residual, not a promise).
    const plan = planCancelRefundObligation(after);
    try {
      await db
        .collection("orders")
        .doc(orderId)
        .set(
          {
            refundObligation: {
              status: "PENDING",
              amountPaise: plan.amountPaise ?? null,
              paymentId: plan.paymentId ?? null,
              refundId: refundDocId,
              lastError: String(err?.message || err).slice(0, 200),
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
          },
          { merge: true }
        );
    } catch (markerErr: any) {
      console.error(
        `[CancelRefund] obligation marker write failed for order ${orderId}:`,
        markerErr?.message || markerErr
      );
    }
    await captureErrorSnapshot({
      source: "payments",
      severity: "high",
      message: `Refund review queue write failed for cancelled PAID order ${orderId} — refund is owed and must be queued manually`,
      orderId,
      errorStack: err?.stack,
    }).catch(() => undefined);
    return { created: false, reason: "queue_failed" };
  }
}

export type AlertClaimReason =
  | "claimed"
  | "delivered"
  | "in_flight"
  | "exhausted"
  | "missing"
  | "not_pending";

export interface AlertClaimResult {
  claimed: boolean;
  token?: string;
  reason: AlertClaimReason;
  /** The row's current amount, authoritative at claim time. */
  amountPaise?: number;
}

/**
 * Durable alert claim keyed on the refund row (not on the immutable event
 * snapshot). One worker at a time, bounded attempts, and a delivered marker so
 * acknowledged deliveries are not repeated. Delivery is best-effort with
 * bounded retries: an ambiguous send or failed settlement can duplicate a
 * notification after lease expiry. This is not exactly- or at-most-once.
 */
export async function claimRefundReviewAlert(params: {
  refundId: string;
  db?: any;
  nowMs?: number;
}): Promise<AlertClaimResult> {
  const db = params.db || defaultDb;
  const now = params.nowMs ?? Date.now();
  const refundRef = db.collection("refunds").doc(params.refundId);
  try {
    return await db.runTransaction(async (tx: any) => {
      const snap = await tx.get(refundRef);
      if (!snap?.exists) return { claimed: false, reason: "missing" as AlertClaimReason };
      const row = (snap.data() || {}) as Record<string, any>;
      const amountPaise = num(row.amountPaise);
      // Only an outstanding approval request may page staff. A REJECTED /
      // WITHDRAWN / APPROVED row is a decision, not a pending obligation.
      if (String(row.status || "").toUpperCase() !== "PENDING") {
        return { claimed: false, reason: "not_pending" as AlertClaimReason, amountPaise };
      }
      if (row.alertDeliveredAt) {
        return { claimed: false, reason: "delivered" as AlertClaimReason, amountPaise };
      }
      const attempts = num(row.alertAttempts);
      if (attempts >= REFUND_ALERT_MAX_ATTEMPTS) {
        return { claimed: false, reason: "exhausted" as AlertClaimReason, amountPaise };
      }
      const claimedAt = Number(row.alertClaimedAt);
      if (Number.isFinite(claimedAt) && claimedAt > 0 && now - claimedAt < REFUND_ALERT_CLAIM_TTL_MS) {
        return { claimed: false, reason: "in_flight" as AlertClaimReason, amountPaise };
      }
      const token = randomUUID();
      tx.set(
        refundRef,
        {
          alertClaimedAt: now,
          alertClaimToken: token,
          alertAttempts: attempts + 1,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      return { claimed: true, token, reason: "claimed" as AlertClaimReason, amountPaise };
    });
  } catch (err: any) {
    console.warn(
      `[CancelRefund] alert claim failed for refund ${params.refundId}:`,
      err?.message || err
    );
    return { claimed: false, reason: "missing" };
  }
}

/**
 * Settles a claim. A stale token is ignored so an old worker cannot clear a
 * newer claim. Failure releases the claim (retryable) and records why.
 */
export async function settleRefundReviewAlert(params: {
  refundId: string;
  token: string;
  delivered: boolean;
  error?: string;
  db?: any;
}): Promise<void> {
  const db = params.db || defaultDb;
  const refundRef = db.collection("refunds").doc(params.refundId);
  try {
    await db.runTransaction(async (tx: any) => {
      const snap = await tx.get(refundRef);
      if (!snap?.exists) return;
      const row = (snap.data() || {}) as Record<string, any>;
      if (row.alertClaimToken !== params.token) return; // newer owner wins
      if (params.delivered) {
        tx.set(
          refundRef,
          {
            alertDeliveredAt: admin.firestore.FieldValue.serverTimestamp(),
            alertClaimedAt: admin.firestore.FieldValue.delete(),
            alertClaimToken: admin.firestore.FieldValue.delete(),
            alertLastError: admin.firestore.FieldValue.delete(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
        return;
      }
      tx.set(
        refundRef,
        {
          alertClaimedAt: admin.firestore.FieldValue.delete(),
          alertClaimToken: admin.firestore.FieldValue.delete(),
          alertLastError: String(params.error || "unknown").slice(0, 200),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    });
  } catch (err: any) {
    console.warn(
      `[CancelRefund] alert settle failed for refund ${params.refundId}:`,
      err?.message || err
    );
  }
}
