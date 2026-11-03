import { db } from "../../core/firebase";
import * as admin from "firebase-admin";
import { captureErrorSnapshot } from "../../core/errors";
import {
  CAPTURE_RECOVERY_AFTER_MS,
  CAPTURE_REFUND_RETRY_BACKOFF_MS,
  CAPTURE_GATE_MAX_ATTEMPTS,
  CAPTURE_GATE_LEASE_MS,
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
  /** Alerts ACKNOWLEDGED by a transport this tick. */
  escalated: number;
  /** Exhausted rows whose ops case exists but the alert could not be delivered. */
  escalationPending: number;
  skipped: number;
  failed: number;
}

/** States this job is allowed to take over once their lease has expired. */
const RECOVERABLE_STATES: ReadonlySet<CaptureFulfillmentState> = new Set([
  "checking",
  "refund_pending",
  "refund_failed",
  "refund_exhausted",
  "fulfillable",
]);

/** Cursor document name; one doc holds one last-document-id per lane. */
const SCAN_CURSOR_DOC = "capture-recovery-cursors";

/**
 * Reads ONE keyset page for a lane, and persists the new cursor.
 *
 * The cursor is the last document ID seen (a STRING), paged with
 * `.orderBy(documentId()).startAfter(lastId).limit(50)`. That is stable while
 * rows leave the lane (which they do every tick), unlike a positional offset.
 * A short page means the end was reached, so the cursor RESETS for the next
 * tick — bounded wrap-around, never an unbounded walk.
 *
 * A legacy NUMERIC cursor (written by the previous offset implementation) is
 * RESET, never coerced into a document id: coercing it would page from a bogus
 * boundary and silently skip real rows.
 *
 * Returns null when the lane could not be read (already alarmed); the caller
 * skips only that lane.
 */
async function readScanPage(state: string, _nowMs: number): Promise<any[] | null> {
  const lastId = await readScanCursor(state);
  try {
    let query = db
      .collection("orders")
      .where("captureFulfillmentState", "==", state)
      .orderBy(admin.firestore.FieldPath.documentId());

    if (lastId) query = query.startAfter(lastId);

    const page = await query.limit(CAPTURE_RECOVERY_SCAN_LIMIT).get();
    const found = Array.isArray(page?.docs) ? page.docs : [];

    const isLastPage = found.length < CAPTURE_RECOVERY_SCAN_LIMIT;
    const nextId = isLastPage
      ? ""
      : String(found[found.length - 1]?.id ?? "");
    await writeScanCursor(state, nextId);

    return found;
  } catch (err: any) {
    // NO silent fallback to the first page: that would re-scan the same head
    // forever and hide the starvation this paging exists to prevent. Alarm and
    // skip the lane for this tick; the cursor is untouched so the next tick
    // resumes exactly where this one would have.
    await captureErrorSnapshot({
      source: "payments",
      severity: "high",
      message: `Capture-fulfilment recovery scan failed for state ${state} — that lane is skipped this tick`,
      errorStack: err?.stack,
    }).catch(() => undefined);
    return null;
  }
}

/**
 * Per-lane last-document-id. Deliberately a plain cursor on a scheduler-owned
 * doc: it is NOT a source of truth, and a missing/corrupt value only means
 * "start from the beginning" — which can duplicate work (harmless: every action
 * is idempotent) but can never skip an owed order.
 */
async function readScanCursor(lane: string): Promise<string> {
  try {
    const snap = await db.collection("scheduler_locks").doc(SCAN_CURSOR_DOC).get();
    const value = snap.exists ? (snap.data() as any)?.[lane] : undefined;
    // Only a non-empty STRING is a usable keyset cursor. A legacy numeric
    // offset is deliberately RESET (returns "") rather than coerced.
    return typeof value === "string" && value.length > 0 ? value : "";
  } catch {
    return "";
  }
}

async function writeScanCursor(lane: string, lastDocumentId: string): Promise<void> {
  try {
    await db
      .collection("scheduler_locks")
      .doc(SCAN_CURSOR_DOC)
      .set(
        {
          [lane]: typeof lastDocumentId === "string" ? lastDocumentId : "",
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
  } catch (err: any) {
    console.warn(
      `[Capture Recovery] could not persist the ${lane} scan cursor:`,
      err?.message || err
    );
  }
}

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
 * How long a `checking`/`fulfillable` recovery may keep FAILING before a human
 * is told. The scheduled sweep runs every 5 minutes (cron every-five-minutes in
 * functions/src/index.ts), so 1 hour is about 12 consecutive failed recovery
 * attempts: time-to-human is about one hour after the FIRST failed attempt. A
 * lease refusal or a skipped sweep never counts and never starts the clock.
 */
export const CAPTURE_STALL_ESCALATE_AFTER_MS = 60 * 60_000;

/**
 * Records ONE failed recovery attempt for a `checking`/`fulfillable` row, and
 * tells a human once the stall has lasted CAPTURE_STALL_ESCALATE_AFTER_MS.
 *
 * Why a top-level field: `recordGateState` REPLACES the nested
 * `captureFulfillment` map on every transition, so stall bookkeeping stored
 * there would be wiped by the next gate write. `captureStall` lives on its own
 * top-level key and is cleared whenever the order confirms or compensates.
 *
 * It NEVER changes the gate state, never refunds, and never marks the row
 * exhausted: money decisions here belong to a human. Automatic recovery keeps
 * running afterwards — a later success is the best outcome.
 *
 * A lease refusal or a skipped sweep must NOT call this: only a sweep that
 * actually attempted recovery and failed counts.
 */
async function recordCaptureRecoveryFailure(args: {
  orderId: string;
  paymentId: string;
  state: CaptureFulfillmentState;
  nowMs: number;
}): Promise<"escalated" | "pending" | "skipped"> {
  const orderRef = db.collection("orders").doc(args.orderId);
  const caseRef = gateCaseRef(args.paymentId);

  type Claim =
    | { kind: "counters_only"; failedAttempts: number }
    | { kind: "threshold"; failedAttempts: number }
    | { kind: "skip" }
    | { kind: "throw"; error: Error };

  let claim: Claim;
  try {
    claim = (await (db as any).runTransaction(async (tx: any) => {
      const orderSnap = await tx.get(orderRef);
      if (!orderSnap || !orderSnap.exists) return { kind: "skip" } as const;
      const fresh = (orderSnap.data() || {}) as any;
      const record = gateOf(fresh);

      // Revalidate: SAME payment, still a decision lane, still unconfirmed.
      const inDecisionLane =
        !!record &&
        record.paymentId === args.paymentId &&
        (record.state === "checking" || record.state === "fulfillable");
      if (!inDecisionLane) return { kind: "skip" } as const;
      if (isOrderLifecycleConfirmedOrLater(fresh)) return { kind: "skip" } as const;

      const stall = fresh.captureStall;
      const previousAttempts =
        stall && typeof stall === "object" ? Math.max(0, Math.floor(Number(stall.failedAttempts) || 0)) : 0;
      const firstFailureAtMs =
        stall && typeof stall === "object" && Number(stall.firstFailureAtMs) > 0
          ? Number(stall.firstFailureAtMs)
          : args.nowMs;
      const failedAttempts = previousAttempts + 1;
      const stallMs = args.nowMs - firstFailureAtMs;
      const crossed = stallMs >= CAPTURE_STALL_ESCALATE_AFTER_MS;

      const caseSnap = await tx.get(caseRef);
      const caseData = caseSnap?.exists ? (caseSnap.data() as any) : null;
      const delivery = deliveryOf(caseData);

      if (!crossed) {
        tx.set(
          orderRef,
          {
            captureStall: {
              paymentId: args.paymentId,
              gateState: record!.state,
              failedAttempts,
              firstFailureAtMs,
              lastFailureAtMs: args.nowMs,
            },
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
        return { kind: "counters_only", failedAttempts } as const;
      }

      // Already reported: only keep the counters current (the case and its
      // alertDelivery own the delivery state and backoff).
      if (caseData) {
        if (typeof caseData.orderId === "string" && caseData.orderId !== args.orderId) {
          return {
            kind: "throw",
            error: new Error(
              `stuck-decision case ${gateCaseDocId(args.paymentId)} belongs to a different order`
            ),
          } as const;
        }
        tx.set(
          orderRef,
          {
            captureStall: {
              paymentId: args.paymentId,
              gateState: record!.state,
              failedAttempts,
              firstFailureAtMs,
              lastFailureAtMs: args.nowMs,
              escalatedAtMs: Number(delivery.escalatedAtMs) || args.nowMs,
            },
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
        return { kind: "skip" } as const;
      }

      // THRESHOLD CROSSED: create the case in the SAME transaction that records
      // it, so a failed case write aborts the counter write too and the next
      // sweep re-detects the stall.
      tx.set(
        orderRef,
        {
          captureStall: {
            paymentId: args.paymentId,
            gateState: record!.state,
            failedAttempts,
            firstFailureAtMs,
            lastFailureAtMs: args.nowMs,
            escalatedAtMs: args.nowMs,
          },
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      tx.set(
        caseRef,
        {
          eventId: `gate_${args.paymentId}`,
          event: "capture_fulfilment_recovery",
          razorpayPaymentId: args.paymentId,
          orderId: args.orderId,
          claimedOrderId: args.orderId,
          amount: null,
          currency: "INR",
          status: "needs_review",
          reason: "capture_decision_stuck",
          gateState: record!.state,
          attempts: failedAttempts,
          detail: record!.detail || null,
          staffAction: "confirm_or_refund_manually",
          receivedAt: admin.firestore.FieldValue.serverTimestamp(),
          alertDelivery: {
            state: "sending",
            attempts: 1,
            escalatedAtMs: args.nowMs,
            leaseUntilMs: args.nowMs + CAPTURE_GATE_LEASE_MS,
            nextAttemptAtMs: args.nowMs + CAPTURE_GATE_LEASE_MS,
            lastError: null,
          },
        },
        { merge: true }
      );
      return { kind: "threshold", failedAttempts } as const;
    })) as Claim;
  } catch (err: any) {
    console.error(
      `[Capture Recovery] stuck-decision tracking failed for order ${args.orderId} — ` +
        `left undelivered:`,
      err?.message || err
    );
    return "pending";
  }

  if (claim.kind === "throw") {
    console.error(`[Capture Recovery] ${claim.error.message}`);
    return "pending";
  }
  if (claim.kind === "skip") return "skipped";
  if (claim.kind === "counters_only") {
    console.error(
      `[Capture Recovery] recovery for order ${args.orderId} is not completing ` +
        `(${claim.failedAttempts} failed attempt(s); a human is alerted after ` +
        `${Math.round(CAPTURE_STALL_ESCALATE_AFTER_MS / 60_000)} min)`
    );
    return "skipped";
  }

  const delivered = await sendStuckDecisionAlert({
    orderId: args.orderId,
    paymentId: args.paymentId,
    state: args.state,
    failedAttempts: claim.failedAttempts,
    caseRef,
  });
  return delivered ? "escalated" : "pending";
}

/**
 * Sends the stuck-decision alert for an EXISTING case and records the outcome
 * against the same attempt, revalidating the row right before persisting.
 *
 * Also used by the plain retry path so a case whose first send failed is retried
 * with the same lease/backoff/sanitized-error machinery.
 */
async function sendStuckDecisionAlert(args: {
  orderId: string;
  paymentId: string;
  state: CaptureFulfillmentState;
  failedAttempts: number;
  caseRef: any;
}): Promise<boolean> {
  let delivered = false;
  let failureCode = "";
  try {
    await captureErrorSnapshot(
      {
        source: "payments",
        severity: "high",
        message:
          `Order ${args.orderId} is STUCK in payment-capture recovery ` +
          `(gate ${args.state}): the customer has PAID and has received NEITHER a ` +
          `confirmed order NOR a refund. Automatic recovery is still retrying after ` +
          `${args.failedAttempts} failed attempt(s). Confirm or refund manually.`,
        orderId: args.orderId,
        razorpayPaymentId: args.paymentId,
      },
      {
        requireAlertDelivery: true,
        snapshotId: `err_capture_stuck_${args.orderId}`,
      }
    );
    delivered = true;
  } catch (err: any) {
    const failures = Array.isArray(err?.detail?.failures) ? err.detail.failures : [];
    const code = typeof err?.code === "string" ? err.code : "ALERT_DELIVERY_FAILED";
    failureCode = [code, ...failures].filter(Boolean).join("|").slice(0, 200);
  }

  try {
    await (db as any).runTransaction(async (tx: any) => {
      const caseSnap = await tx.get(args.caseRef);
      if (!caseSnap || !caseSnap.exists) return false;
      const caseData = (caseSnap.data() || {}) as any;
      // A staff decision or a newer attempt wins; never rewrite their record.
      if (caseData.status !== "needs_review") return false;
      const delivery = deliveryOf(caseData);
      if (Number(delivery.attempts) > 1 && !delivered) return false;
      if (delivery.state === "delivered" && !delivered) return false;

      const attempts = Math.max(1, Math.floor(Number(delivery.attempts) || 1));
      tx.set(
        args.caseRef,
        {
          alertDelivery: delivered
            ? {
                ...delivery,
                state: "delivered",
                attempts,
                deliveredAtMs: Date.now(),
                lastError: null,
                leaseUntilMs: 0,
                nextAttemptAtMs: 0,
              }
            : {
                ...delivery,
                state: "pending",
                attempts,
                lastError: failureCode || "ALERT_DELIVERY_FAILED",
                leaseUntilMs: 0,
                nextAttemptAtMs: Date.now() + alertRetryDelayMs(attempts),
              },
        },
        { merge: true }
      );
      return true;
    });
  } catch (err: any) {
    console.error(
      `[Capture Recovery] could not record stuck-decision alert delivery for ` +
        `order ${args.orderId} (${failureCode || "delivered"}):`,
      err?.message || err
    );
  }

  if (!delivered) {
    console.error(
      `[Capture Recovery] stuck-decision alert NOT delivered for order ${args.orderId} — ` +
        `code ${failureCode || "ALERT_DELIVERY_FAILED"}`
    );
  }
  return delivered;
}

/**
 * A `checking`/`fulfillable` row that already has an UNDELIVERED case: retry the
 * send on the same lease/backoff schedule, and skip while the lease or the
 * backoff is still live.
 */
async function retryStuckDecisionAlert(args: {
  orderId: string;
  paymentId: string;
  state: CaptureFulfillmentState;
  nowMs: number;
}): Promise<"delivered" | "pending" | "skipped"> {
  const caseRef = gateCaseRef(args.paymentId);
  const snap = await caseRef.get().catch(() => null);
  if (!snap || !snap.exists) return "skipped";
  const caseData = (snap.data() || {}) as any;
  if (caseData.status !== "needs_review") return "skipped";
  const delivery = deliveryOf(caseData);
  if (delivery.lastError === "gate_recovered") return "skipped";

  const attempts = Math.max(1, Math.floor(Number(delivery.attempts) || 1));
  // Revalidate that the row is STILL stuck before sending anything.
  const orderSnap = await db.collection("orders").doc(args.orderId).get();
  const fresh = orderSnap?.exists ? ((orderSnap.data() || {}) as any) : {};
  const record = gateOf(fresh);
  if (
    !record ||
    record.paymentId !== args.paymentId ||
    (record.state !== "checking" && record.state !== "fulfillable")
  ) {
    return "skipped";
  }

  if (delivery.state === "sending" && Number(delivery.leaseUntilMs) > args.nowMs) {
    return "skipped";
  }
  if (Number(delivery.nextAttemptAtMs) > args.nowMs) return "skipped";
  if (delivery.state === "delivered") return "skipped";

  const delivered = await sendStuckDecisionAlert({
    orderId: args.orderId,
    paymentId: args.paymentId,
    state: args.state,
    failedAttempts: Number(caseData.attempts) || attempts,
    caseRef,
  });
  return delivered ? "delivered" : "pending";
}

/**
 * A stuck-decision order RECOVERED (confirmed, or compensated).
 *
 *  - an undelivered alert is marked `superseded`: nobody should be paged for a
 *    decision that no longer needs making;
 *  - an ALREADY DELIVERED alert is left in place (staff may already be holding
 *    the case) AND a SECOND, follow-up alert is queued through the same outbox:
 *    "order X recovered automatically and was confirmed; the customer will
 *    receive food; do NOT refund". Stamping the case alone is not enough —
 *    nobody re-reads a case, and a staff member holding only the first alert
 *    would otherwise refund an order that was actually fulfilled.
 */
async function clearCaptureStallOnRecovery(args: {
  orderId: string;
  paymentId: string;
  outcome: "confirmed" | "compensated";
  nowMs: number;
}): Promise<void> {
  const orderRef = db.collection("orders").doc(args.orderId);
  const caseRef = gateCaseRef(args.paymentId);
  let needsFollowUp = false;
  try {
    await (db as any).runTransaction(async (tx: any) => {
      const orderSnap = await tx.get(orderRef);
      if (!orderSnap || !orderSnap.exists) return false;
      const fresh = (orderSnap.data() || {}) as any;
      if (!fresh.captureStall) return false;

      tx.set(orderRef, { captureStall: null }, { merge: true });

      const caseSnap = await tx.get(caseRef);
      if (!caseSnap || !caseSnap.exists) return false;
      const caseData = (caseSnap.data() || {}) as any;
      // NEVER reset a staff decision or its received timestamp.
      if (caseData.status !== "needs_review") return false;
      const delivery = deliveryOf(caseData);

      const alreadyDelivered = delivery.state === "delivered";
      needsFollowUp = alreadyDelivered;

      tx.set(
        caseRef,
        {
          recovered: {
            atMs: Date.now(),
            outcome: args.outcome,
            note:
              args.outcome === "confirmed"
                ? "Order was confirmed by automatic recovery — do NOT refund."
                : "Capture was compensated by automatic recovery — no further refund due.",
          },
          alertDelivery: alreadyDelivered
            ? {
                ...delivery,
                recoveredAtMs: Date.now(),
                // Queue the follow-up on the SAME delivery record, so it uses
                // the same lease/backoff/sanitized machinery.
                state: "pending",
                alertKind: "recovered_confirmed",
                attempts: 0,
                lastError: null,
                leaseUntilMs: 0,
                nextAttemptAtMs: 0,
                deliveredAtMs: 0,
              }
            : {
                ...delivery,
                state: "superseded",
                lastError: "gate_recovered",
              },
        },
        { merge: true }
      );
      return true;
    });
  } catch (err: any) {
    console.warn(
      `[Capture Recovery] could not clear the stall record for order ${args.orderId}:`,
      err?.message || err
    );
    return;
  }

  if (needsFollowUp) {
    await deliverRecoveredConfirmedAlert({
      orderId: args.orderId,
      paymentId: args.paymentId,
      nowMs: args.nowMs,
    });
  }
}

/**
 * Sends (and retries) the "recovered automatically — do NOT refund" follow-up.
 *
 * Same outbox, same lease, same capped backoff, same sanitized error codes as
 * every other alert here, and the case records which alert kind is pending
 * (`alertDelivery.alertKind`) so a retry of the FIRST alert can never be
 * confused with this one.
 */
async function deliverRecoveredConfirmedAlert(args: {
  orderId: string;
  paymentId: string;
  nowMs: number;
}): Promise<"delivered" | "pending" | "skipped"> {
  const caseRef = gateCaseRef(args.paymentId);
  const snap = await caseRef.get().catch(() => null);
  if (!snap || !snap.exists) return "skipped";
  const caseData = (snap.data() || {}) as any;
  if (caseData.status !== "needs_review") return "skipped";
  const delivery = deliveryOf(caseData);
  if (delivery.alertKind !== "recovered_confirmed") return "skipped";
  if (delivery.state === "delivered") return "skipped";
  if (delivery.state === "sending" && Number(delivery.leaseUntilMs) > args.nowMs) {
    return "skipped";
  }
  if (Number(delivery.nextAttemptAtMs) > args.nowMs) return "skipped";

  // Claim the attempt before sending (one sender at a time).
  const claimedAttempt = await (db as any)
    .runTransaction(async (tx: any) => {
      const caseSnap = await tx.get(caseRef);
      if (!caseSnap || !caseSnap.exists) return 0;
      const current = (caseSnap.data() || {}) as any;
      if (current.status !== "needs_review") return 0;
      const currentDelivery = deliveryOf(current);
      if (currentDelivery.alertKind !== "recovered_confirmed") return 0;
      if (currentDelivery.state === "delivered") return 0;
      if (
        currentDelivery.state === "sending" &&
        Number(currentDelivery.leaseUntilMs) > args.nowMs
      ) {
        return 0;
      }
      const attempts = Math.floor(Number(currentDelivery.attempts) || 0) + 1;
      tx.set(
        caseRef,
        {
          alertDelivery: {
            ...currentDelivery,
            state: "sending",
            attempts,
            leaseUntilMs: args.nowMs + CAPTURE_GATE_LEASE_MS,
          },
        },
        { merge: true }
      );
      return attempts;
    })
    .catch(() => 0);
  if (!claimedAttempt) return "skipped";

  let delivered = false;
  let failureCode = "";
  try {
    await captureErrorSnapshot(
      {
        source: "payments",
        severity: "high",
        message:
          `UPDATE — order ${args.orderId} RECOVERED AUTOMATICALLY and was CONFIRMED. ` +
          `The customer WILL receive food. Do NOT refund this order. ` +
          `(An earlier alert said it was neither confirmed nor refunded; that is now resolved.)`,
        orderId: args.orderId,
        razorpayPaymentId: args.paymentId,
      },
      {
        requireAlertDelivery: true,
        snapshotId: `err_capture_recovered_${args.orderId}`,
      }
    );
    delivered = true;
  } catch (err: any) {
    const failures = Array.isArray(err?.detail?.failures) ? err.detail.failures : [];
    const code = typeof err?.code === "string" ? err.code : "ALERT_DELIVERY_FAILED";
    failureCode = [code, ...failures].filter(Boolean).join("|").slice(0, 200);
  }

  try {
    await (db as any).runTransaction(async (tx: any) => {
      const caseSnap = await tx.get(caseRef);
      if (!caseSnap || !caseSnap.exists) return false;
      const current = (caseSnap.data() || {}) as any;
      if (current.status !== "needs_review") return false;
      const currentDelivery = deliveryOf(current);
      if (Number(currentDelivery.attempts) > claimedAttempt) return false;

      tx.set(
        caseRef,
        {
          alertDelivery: delivered
            ? {
                ...currentDelivery,
                state: "delivered",
                alertKind: "recovered_confirmed",
                attempts: claimedAttempt,
                deliveredAtMs: Date.now(),
                lastError: null,
                leaseUntilMs: 0,
                nextAttemptAtMs: 0,
              }
            : {
                ...currentDelivery,
                state: "pending",
                alertKind: "recovered_confirmed",
                attempts: claimedAttempt,
                lastError: failureCode || "ALERT_DELIVERY_FAILED",
                leaseUntilMs: 0,
                nextAttemptAtMs: Date.now() + alertRetryDelayMs(claimedAttempt),
              },
        },
        { merge: true }
      );
      return true;
    });
  } catch (err: any) {
    console.error(
      `[Capture Recovery] could not record the recovered-follow-up delivery for ` +
        `order ${args.orderId} (${failureCode || "delivered"}):`,
      err?.message || err
    );
  }

  if (!delivered) {
    console.error(
      `[Capture Recovery] recovered-follow-up alert NOT delivered for order ` +
        `${args.orderId} — code ${failureCode || "ALERT_DELIVERY_FAILED"}`
    );
  }
  return delivered ? "delivered" : "pending";
}

/**
 * The gateway (or staff in the dashboard) already refunded this payment, so the
 * order must NOT be confirmed automatically: the customer would get food that
 * has already been paid back.
 *
 * It records the fact on the case for staff and stands the row down from
 * automatic confirmation. It intentionally does NOT write any refund
 * accounting of its own — that is the refund webhook's job.
 */
async function markCaseRefundedExternally(args: {
  orderId: string;
  paymentId: string;
}): Promise<void> {
  const caseRef = gateCaseRef(args.paymentId);
  try {
    const snap = await caseRef.get();
    const caseData = snap?.exists ? ((snap.data() || {}) as any) : null;
    const delivery = deliveryOf(caseData);
    await caseRef.set(
      {
        status: "refunded_externally",
        refundedExternallyAtMs: Date.now(),
        staffAction: "refund_already_issued_do_not_confirm",
        ...(delivery.state === "delivered"
          ? {}
          : { alertDelivery: { ...delivery, state: "superseded", lastError: "refunded_externally" } }),
      },
      { merge: true }
    );
    await captureErrorSnapshot({
      source: "payments",
      severity: "high",
      message:
        `Order ${args.orderId} was REFUNDED at the gateway while awaiting recovery — ` +
        `automatic confirmation withheld so the customer is not fed AND refunded. ` +
        `No further action unless the refund is reversed.`,
      orderId: args.orderId,
      razorpayPaymentId: args.paymentId,
    }).catch(() => undefined);
  } catch (err: any) {
    console.warn(
      `[Capture Recovery] could not mark order ${args.orderId} refunded-externally:`,
      err?.message || err
    );
  }
}

/**
 * Deterministic ops-case doc for an exhausted capture. The outbox lives ON this
 * doc (`alertDelivery`), so there is exactly ONE record per payment and no new
 * collection: the case is the actionable artefact, the delivery map is its
 * attempt record.
 */
function gateCaseDocId(paymentId: string): string {
  return `ump_gate_${paymentId}`;
}

function gateCaseRef(paymentId: string): any {
  return db.collection("unmatched_payments").doc(gateCaseDocId(paymentId));
}

/** Alert body for an exhausted refund. Names the ORDER, never the case doc. */
function exhaustedAlertText(args: {
  orderId: string;
  attempts: number;
  detail?: string;
}): string {
  return (
    `Capture fulfilment recovery STOPPED for order ${args.orderId}: the automatic refund ` +
    `budget is spent after ${args.attempts} attempt(s) and money may still be owed. ` +
    `Manual refund or gate repair required` +
    (args.detail ? ` (item detail: ${args.detail})` : "")
  );
}

/**
 * Backoff for a failed alert delivery: 10m, 20m, 40m … capped at 6h. Retries
 * continue indefinitely at the cap — a broken channel stays VISIBLY
 * undelivered instead of giving up silently.
 */
export function alertRetryDelayMs(attempts: number): number {
  const exponent = Math.max(0, Math.floor(attempts) - 1);
  const SIX_HOURS = 6 * 60 * 60 * 1000;
  return Math.min(CAPTURE_RECOVERY_AFTER_MS * Math.pow(2, exponent), SIX_HOURS);
}

type DeliveryRecord = {
  state?: "pending" | "sending" | "delivered" | "superseded";
  attempts?: number;
  lastError?: string;
  leaseUntilMs?: number;
  deliveredAtMs?: number;
  nextAttemptAtMs?: number;
  /** When this case was first raised for a stuck DECISION (not a refund). */
  escalatedAtMs?: number;
  /** Set when automatic recovery later resolved the decision. */
  recoveredAtMs?: number;
  /**
   * Which alert this delivery record is carrying. `recovered_confirmed` is the
   * follow-up that says the order was fulfilled, so a retry can never confuse it
   * with the original "stuck decision" page.
   */
  alertKind?: "stuck_decision" | "recovered_confirmed" | "refund_exhausted";
};

function deliveryOf(caseData: any): DeliveryRecord {
  const raw = caseData?.alertDelivery;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return raw as DeliveryRecord;
}

/**
 * Creates/repairs the ops CASE for an exhausted refund, then delivers its alert.
 * ONE entry point for every exhausted path — the sweep's lane branch, the
 * guard's outcome, and a failure that reached the budget — including rows the
 * real capture guard already moved to `refund_exhausted` (which used to get no
 * case and no alert at all).
 *
 * Returns "delivered" | "pending" | "skipped".
 */
async function escalateExhaustedRefund(args: {
  orderId: string;
  paymentId: string;
  attempts: number;
  detail?: string;
  nowMs?: number;
}): Promise<"delivered" | "pending" | "skipped"> {
  const nowMs = typeof args.nowMs === "number" ? args.nowMs : Date.now();
  const orderRef = db.collection("orders").doc(args.orderId);
  const caseRef = gateCaseRef(args.paymentId);

  // ── CLAIM (one transaction: revalidate the order AND the case) ───────────
  let claim:
    | { kind: "send"; attempts: number }
    | { kind: "skip"; }
    | { kind: "throw"; error: Error };
  try {
    claim = await (db as any).runTransaction(async (tx: any) => {
      const orderSnap = await tx.get(orderRef);
      if (!orderSnap || !orderSnap.exists) return { kind: "skip" } as const;
      const fresh = (orderSnap.data() || {}) as any;
      const record = gateOf(fresh);

      // Revalidate the SAME exhausted capture. A gate that moved on (refunded,
      // repaired, or a different payment) owes no escalation.
      //
      // Two legitimate shapes reach here:
      //  - a row the capture GUARD already moved to `refund_exhausted`, and
      //  - a row still owed at/over budget in this sweep (`refund_failed` /
      //    stale `refund_pending`), which is transitioned HERE so the state and
      //    the ops case commit together (a failed case write aborts both, and
      //    the next sweep reclaims it).
      const samePayment = !!record && record.paymentId === args.paymentId;
      const alreadyExhausted = samePayment && record!.state === "refund_exhausted";
      const owedAtBudget =
        samePayment &&
        (record!.state === "refund_failed" || record!.state === "refund_pending") &&
        record!.attempts >= CAPTURE_GATE_MAX_ATTEMPTS;

      // A LIVE lease on a `refund_pending` row means a sibling may be mid-refund
      // RIGHT NOW (e.g. attempt 5 awaiting the provider). Exhausting it here
      // would race that refund and could clobber a `refunded` result, so it is
      // never ours. A `refund_failed` row has NOTHING in flight — its lease only
      // records when the failure happened — so it must not be blocked.
      if (owedAtBudget && record && record.state === "refund_pending") {
        const age = nowMs - record.atMs;
        if (Number.isFinite(record.atMs) && record.atMs > 0 && age < CAPTURE_GATE_LEASE_MS) {
          return { kind: "skip" } as const;
        }
      }

      const stillExhausted = alreadyExhausted || owedAtBudget;
      const caseSnap = await tx.get(caseRef);
      const caseData = caseSnap?.exists ? (caseSnap.data() as any) : null;
      const delivery = deliveryOf(caseData);

      if (!stillExhausted || !record) {
        // Gate moved on: retire any pending delivery, send nothing.
        if (caseData && delivery.state !== "delivered") {
          tx.set(
            caseRef,
            {
              alertDelivery: {
                ...delivery,
                state: "superseded",
                lastError: "gate_moved_on",
              },
            },
            { merge: true }
          );
        }
        return { kind: "skip" } as const;
      }

      if (caseData) {
        if (typeof caseData.orderId === "string" && caseData.orderId !== args.orderId) {
          return {
            kind: "throw",
            error: new Error(
              `escalation case ${gateCaseDocId(args.paymentId)} belongs to a different order`
            ),
          } as const;
        }
        if (caseData.status !== "needs_review") {
          // Staff settled it: never alert again, never reset their status.
          return { kind: "skip" } as const;
        }

        // ── REASON UPGRADE ───────────────────────────────────────────────
        // A refund-exhausted case is MORE urgent than a stuck decision. If this
        // case was raised for a different reason and its alert already went
        // out, silently keeping the old reason would hide the new problem.
        // Re-open the delivery so the new alert really sends — but an identical
        // reason never re-alerts, so a steady case cannot spam staff.
        const priorReason = String(caseData.reason || "");
        const reasonChanged = priorReason !== "refund_retries_exhausted";
        const alreadyDelivered = delivery.state === "delivered";
        if (reasonChanged && alreadyDelivered) {
          // Falls through with a reset delivery below.
        } else if (alreadyDelivered) {
          return { kind: "skip" } as const;
        }
        // A sibling is mid-send under a live lease.
        if (
          !(reasonChanged && alreadyDelivered) &&
          delivery.state === "sending" &&
          Number(delivery.leaseUntilMs) > nowMs
        ) {
          return { kind: "skip" } as const;
        }
        if (!(reasonChanged && alreadyDelivered) && Number(delivery.nextAttemptAtMs) > nowMs) {
          return { kind: "skip" } as const;
        }
      }

      const attempts = Math.max(
        Math.floor(Number(delivery.attempts) || 0) + 1,
        1
      );
      // A still-owed row is transitioned to `refund_exhausted` in THIS same      // transaction as its ops case: if the case write fails below the whole
      // transaction aborts, so the row stays owed and the next sweep reclaims
      // it. That is what makes a transient case-write failure recoverable
      // instead of permanently losing the escalation.
      if (owedAtBudget) {
        tx.set(
          orderRef,
          {
            captureFulfillment: {
              state: "refund_exhausted",
              paymentId: args.paymentId,
              atMs: nowMs,
              attempts: record!.attempts,
              ...(record!.detail || args.detail
                ? { detail: record!.detail || args.detail }
                : {}),
            },
            captureFulfillmentState: "refund_exhausted",
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
      }
      const priorReason = String(caseData?.reason || "");
      const upgradingReason =
        !!caseData &&
        priorReason.length > 0 &&
        priorReason !== "refund_retries_exhausted";
      // A reason change restarts delivery at attempt 1 so the MORE urgent alert
      // really goes out (the delivered record would otherwise suppress it).
      const deliveryAttempts = upgradingReason ? 1 : Math.max(
        Math.floor(Number(delivery.attempts) || 0) + 1,
        1
      );
      tx.set(
        caseRef,
        {
          eventId: `gate_${args.paymentId}`,
          event: "capture_fulfilment_recovery",
          razorpayPaymentId: args.paymentId,
          orderId: args.orderId,
          claimedOrderId: args.orderId,
          amount: null,
          currency: "INR",
          status: "needs_review",
          reason: "refund_retries_exhausted",
          gateState: "refund_exhausted",
          attempts: args.attempts,
          detail: args.detail || null,
          staffAction: "refund_manually_or_repair_gate",
          ...(caseData && caseData.receivedAt ? {} : {
            receivedAt: admin.firestore.FieldValue.serverTimestamp(),
          }),
          ...(upgradingReason
            ? { reasonUpgradedAtMs: nowMs, priorReason }
            : {}),
          alertDelivery: {
            state: "sending",
            alertKind: "refund_exhausted",
            attempts: deliveryAttempts,
            leaseUntilMs: nowMs + CAPTURE_GATE_LEASE_MS,
            nextAttemptAtMs: nowMs + CAPTURE_GATE_LEASE_MS,
            lastError: null,
            ...(upgradingReason ? { deliveredAtMs: 0 } : {}),
          },
        },
        { merge: true }
      );
      return { kind: "send", attempts: deliveryAttempts } as const;
    });
  } catch (err: any) {
    console.error(
      `[Capture Recovery] escalation claim failed for order ${args.orderId} — left undelivered:`,
      err?.message || err
    );
    return "pending";
  }

  if (claim.kind === "throw") {
    console.error(`[Capture Recovery] ${claim.error.message}`);
    return "pending";
  }
  if (claim.kind === "skip") return "skipped";

  // ── SEND (outside the transaction; at-least-once) ────────────────────────
  // Delivery is at-least-once by design: if this process dies AFTER the
  // transport acknowledged but BEFORE the result write, the lease expires and a
  // later sweep sends the alert again. A duplicate page is acceptable; a
  // silently lost exhausted refund is not.
  let delivered = false;
  let failureCode = "";
  try {
    await captureErrorSnapshot(
      {
        source: "payments",
        severity: "high",
        message: exhaustedAlertText(args),
        orderId: args.orderId,
        razorpayPaymentId: args.paymentId,
      },
      {
        requireAlertDelivery: true,
        // One deterministic snapshot per order: a retry overwrites rather than
        // spamming the collection with a new row per attempt.
        snapshotId: `err_capture_exhausted_${args.orderId}`,
      }
    );
    delivered = true;
  } catch (err: any) {
    delivered = false;
    const failures = Array.isArray(err?.detail?.failures) ? err.detail.failures : [];
    const code = typeof err?.code === "string" ? err.code : "ALERT_DELIVERY_FAILED";
    failureCode = [code, ...failures].filter(Boolean).join("|").slice(0, 200);
  }

  // ── RECORD the outcome against the SAME attempt ──────────────────────────
  try {
    await (db as any).runTransaction(async (tx: any) => {
      const caseSnap = await tx.get(caseRef);
      if (!caseSnap || !caseSnap.exists) return false;
      const caseData = (caseSnap.data() || {}) as any;
      const delivery = deliveryOf(caseData);
      // A newer attempt took over, or staff settled the case meanwhile: do not
      // rewrite their record with this stale outcome.
      if (Number(delivery.attempts) > claim.attempts) return false;
      if (caseData.status !== "needs_review") return false;
      if (delivery.state === "delivered" && !delivered) return false;

      if (delivered) {
        tx.set(
          caseRef,
          {
            alertDelivery: {
              ...delivery,
              state: "delivered",
              attempts: claim.attempts,
              deliveredAtMs: Date.now(),
              lastError: null,
              leaseUntilMs: 0,
              nextAttemptAtMs: 0,
            },
          },
          { merge: true }
        );
      } else {
        tx.set(
          caseRef,
          {
            alertDelivery: {
              ...delivery,
              state: "pending",
              attempts: claim.attempts,
              lastError: failureCode || "ALERT_DELIVERY_FAILED",
              leaseUntilMs: 0,
              nextAttemptAtMs: Date.now() + alertRetryDelayMs(claim.attempts),
            },
          },
          { merge: true }
        );
      }
      return true;
    });
  } catch (err: any) {
    // The claim lease stays live; once it expires (or the backoff passes) the
    // next sweep retries. Never silent: log with the sanitized code only.
    console.error(
      `[Capture Recovery] could not record alert delivery for order ${args.orderId} ` +
        `(${failureCode || "delivered"}):`,
      err?.message || err
    );
  }

  if (!delivered) {
    console.error(
      `[Capture Recovery] escalation alert NOT delivered for order ${args.orderId} — ` +
        `code ${failureCode || "ALERT_DELIVERY_FAILED"}`
    );
    return "pending";
  }
  return "delivered";
}


/**
 * Moves an already-confirmed order OUT of the scan lane.
 *
 * The channels clear the mirror at confirmation time, but orders confirmed
 * before that existed still sit in `fulfillable`. Without this retirement the
 * first bounded page fills with healthy history and a later crashed paid order
 * is never scanned — the starvation this sweep exists to end. Merge-only and
 * idempotent.
 */
async function retireConfirmedMarker(
  orderId: string,
  paymentId: string
): Promise<void> {
  try {
    await db
      .collection("orders")
      .doc(orderId)
      .set(
        {
          captureFulfillmentState: "confirmed",
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
  } catch (err: any) {
    console.warn(
      `[Capture Recovery] could not retire the confirmed marker for ${orderId} (payment ${paymentId}):`,
      err?.message || err
    );
  }
}

/**
 * One recovery sweep. Exported for the scheduled function and for tests; the
 * function wrapper in `index.ts` owns the scheduler lock and cadence.
 *
 * ORDERING AND PAGINATION (this is what makes the lane truthful):
 *
 *  - the OWED lanes (`refund_failed`, `refund_pending`, `refund_exhausted`) are
 *    read FIRST and each page is CURSORed, so a row-51 owed refund is reached on
 *    the next tick even when the first page is entirely stuck rows;
 *  - `refund_exhausted` rows get ONE durable ops case plus a delivered alert;
 *    they stay in that state (never re-confirmed, never retried financially),
 *    and their alert is retried with capped backoff until a channel
 *    acknowledges;
 *  - `fulfillable` confirmation candidates come LAST with their own budget,
 *    because a healthy backlog must never starve an owed refund.
 *
 * The cursor is a per-lane LAST-DOCUMENT-ID (a string) on the scheduler-lock
 * document, used with `orderBy(documentId()).startAfter(id)`. It is not a source
 * of truth: a lost or legacy value only ever means "start from the beginning",
 * which can duplicate work (harmless, idempotent) but never skips an order.
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
    escalationPending: 0,
    skipped: 0,
    failed: 0,
  };

  // ONE bounded, KEYSET-paged query per recoverable state, all over the SAME
  // top-level field.
  //
  // `captureFulfillmentState` is a mirrored top-level scalar (written beside the
  // nested record on every transition), so Firestore's automatic single-field
  // index serves these equality scans and NO composite index has to be
  // deployed with the job. The only explicit ordering is the document name
  // (`__name__`), which the ordinary single-field index already provides as a
  // tie-breaker.
  //
  // WHY KEYSET AND NOT OFFSET: an offset is positional. Every row a tick
  // processes LEAVES the lane (it becomes `refunded`), so the page shifts under
  // the cursor and rows near the end are never reached while new arrivals keep
  // sorting ahead of them. Paging by "the last document id I saw" is stable
  // under insertion and removal.
  //
  // OWED LANES FIRST: `refund_failed`, `refund_pending`, `refund_exhausted`, then
  // `checking` and `fulfillable` — an owed refund must never wait behind
  // confirmation work.
  const docs: any[] = [];
  for (const state of ["refund_failed", "refund_pending", "refund_exhausted", "checking"] as const) {
    const found = await readScanPage(state, nowMs);
    if (found === null) continue; // lane failed; already alarmed
    if (state === "checking") {
      // `checking`/`fulfillable` are CONFIRMATION candidates: only a genuinely
      // stalled decision is ours, so fresh work is not even collected.
      for (const doc of found) {
        const data = ((typeof doc?.data === "function" ? doc.data() : doc) || {}) as any;
        const atMs = Number(data?.captureFulfillment?.atMs);
        if (Number.isFinite(atMs) && atMs > 0 && nowMs - atMs < CAPTURE_RECOVERY_AFTER_MS) {
          continue;
        }
        docs.push(doc);
      }
    } else {
      docs.push(...found);
    }
  }

  // `fulfillable` means the decision was made but no channel finished it. Same
  // keyset paging and the same age bound, and it runs LAST so a healthy backlog
  // cannot starve the refund lanes.
  const fulfillablePage = await readScanPage("fulfillable", nowMs);
  if (fulfillablePage) {
    for (const doc of fulfillablePage) {
      const data = ((typeof doc?.data === "function" ? doc.data() : doc) || {}) as any;
      const atMs = Number(data?.captureFulfillment?.atMs);
      if (Number.isFinite(atMs) && atMs > 0 && nowMs - atMs < CAPTURE_RECOVERY_AFTER_MS) {
        continue;
      }
      docs.push(doc);
    }
  }

  // ── PENDING FOLLOW-UPS ───────────────────────────────────────────────────
  // A confirmed order LEAVES every recovery lane, yet its "recovered — do NOT
  // refund" follow-up may still be undelivered. Those cases are retried here, by
  // case id, so a transient channel failure cannot silently lose the one message
  // that stops staff refunding a fulfilled order.
  try {
    const pending = await db
      .collection("unmatched_payments")
      .where("alertDelivery.state", "==", "pending")
      .limit(CAPTURE_RECOVERY_SCAN_LIMIT)
      .get();
    for (const caseDoc of Array.isArray(pending?.docs) ? pending.docs : []) {
      const caseData = ((typeof caseDoc?.data === "function" ? caseDoc.data() : caseDoc) ||
        {}) as any;
      const delivery = deliveryOf(caseData);
      if (delivery.alertKind !== "recovered_confirmed") continue;
      if (caseData.status !== "needs_review") continue;
      if (Number(delivery.nextAttemptAtMs) > nowMs) {
        stats.escalationPending += 1;
        continue;
      }
      const result = await deliverRecoveredConfirmedAlert({
        orderId: String(caseData.orderId || ""),
        paymentId: String(caseData.razorpayPaymentId || ""),
        nowMs,
      });
      if (result === "delivered") stats.escalated += 1;
      else if (result === "pending") stats.escalationPending += 1;
    }
  } catch (err: any) {
    console.warn(
      "[Capture Recovery] pending follow-up scan failed — retried next tick:",
      err?.message || err
    );
  }

  const seen = new Set<string>();
  stats.scanned = docs.length;

  for (const doc of docs) {
    const orderId = typeof doc?.id === "string" ? doc.id : "";
    if (!orderId || seen.has(orderId)) continue;
    seen.add(orderId);

    // Hoisted OUT of the try so the catch can escalate a row that THREW before
    // any decision was reached (a malformed order, a datastore fault). A throw
    // before these are known leaves them null/empty and the catch stays
    // conservative.
    let gate: ReturnType<typeof gateOf> = null;
    let paymentId = "";

    try {
      const order = (typeof doc.data === "function" ? doc.data() : doc) || {};
      gate = gateOf(order);
      if (!gate) continue;
      if (!RECOVERABLE_STATES.has(gate.state as CaptureFulfillmentState)) continue;

      paymentId = gate.paymentId || capturedPaymentIdOf(order);
      if (!paymentId) {
        stats.skipped += 1;
        continue;
      }

      // ── OWED COMPENSATION FIRST ────────────────────────────────────────────
      // A refund the system already owes is settled (or escalated) BEFORE any
      // lifecycle reasoning. A customer who cancels a still-PLACED order turns
      // it CANCELLED; the old code then treated the row as "nothing to do" and
      // the refund stayed owed forever — and kept occupying this page.
      const owedState =
        gate.state === "refund_failed" ||
        gate.state === "refund_pending" ||
        gate.state === "refund_exhausted";

      if (owedState) {
        // A failed attempt has nothing in flight; a pending one must have aged
        // past its lease before a takeover. This is checked BEFORE counting a
        // candidate, so a freshly-resumed refund is never raced.
        const quietFor =
          gate.state === "refund_failed"
            ? CAPTURE_REFUND_RETRY_BACKOFF_MS
            : CAPTURE_RECOVERY_AFTER_MS;
        if (gate.atMs > 0 && nowMs - gate.atMs < quietFor) {
          stats.skipped += 1;
          continue;
        }
        stats.candidates += 1;

        if (gate.state === "refund_exhausted" || gate.attempts >= CAPTURE_GATE_MAX_ATTEMPTS) {
          // Budget spent (including rows the REAL capture guard already moved to
          // `refund_exhausted`): create/repair the ops case and prove delivery.
          const result = await escalateExhaustedRefund({
            orderId,
            paymentId,
            attempts: Math.max(gate.attempts, CAPTURE_GATE_MAX_ATTEMPTS),
            detail: gate.detail,
            nowMs,
          });
          if (result === "delivered") stats.escalated += 1;
          else if (result === "pending") stats.escalationPending += 1;
          else stats.skipped += 1;
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
        if (outcome.outcome === "refund_exhausted") {
          const result = await escalateExhaustedRefund({
            orderId,
            paymentId,
            attempts: CAPTURE_GATE_MAX_ATTEMPTS,
            detail: gate.detail,
            nowMs,
          });
          if (result === "delivered") stats.escalated += 1;
          else if (result === "pending") stats.escalationPending += 1;
          else stats.skipped += 1;
          continue;
        }
        if (outcome.outcome === "refund_failed" || outcome.outcome === "pending") {
          // `pending` here means a LIVE sibling owns the attempt (a lease
          // refusal), NOT a failure of ours: it must never be escalated, and it
          // must never be re-labelled as an exhausted refund.
          if (outcome.outcome === "pending") {
            stats.skipped += 1;
            continue;
          }
          const after = await orderRef.get().catch(() => null);
          const recorded = after?.exists ? gateOf(after.data() as any) : null;
          const used = Math.max(recorded?.attempts ?? 0, gate.attempts);
          if (used >= CAPTURE_GATE_MAX_ATTEMPTS) {
            const result = await escalateExhaustedRefund({
              orderId,
              paymentId,
              attempts: used,
              detail: outcome.detail,
              nowMs,
            });
            if (result === "delivered") stats.escalated += 1;
            else if (result === "pending") stats.escalationPending += 1;
            else stats.skipped += 1;
          } else {
            stats.retried += 1;
          }
          continue;
        }
        // `pending` (a sibling took the lease) or a clear decision: nothing owed
        // to do in this branch.
        stats.skipped += 1;
        continue;
      }

      // A confirmed/terminal LIFECYCLE order needs no CONFIRMATION: it is NOT
      // owed anything, so it is retired out of the scan lane. This runs only for
      // non-owed states — an owed refund is handled above, never here.
      if (isOrderLifecycleConfirmedOrLater(order)) {
        if (gate.state === "fulfillable") {
          await retireConfirmedMarker(orderId, gate.paymentId);
        }
        stats.skipped += 1;
        continue;
      }

      // Never race a live channel: `checking`/`fulfillable` may still belong to
      // an owner that is deciding right now.
      if (gate.atMs > 0 && nowMs - gate.atMs < CAPTURE_RECOVERY_AFTER_MS) {
        stats.skipped += 1;
        continue;
      }
      stats.candidates += 1;

      // If a stuck-decision case already exists and its alert never landed,
      // retry it on the same lease/backoff. This runs BEFORE the recovery
      // attempt so a permanently broken channel is retried even while recovery
      // keeps failing.
      const stuckRetry = await retryStuckDecisionAlert({
        orderId,
        paymentId,
        state: gate.state as CaptureFulfillmentState,
        nowMs,
      });
      if (stuckRetry === "delivered") stats.escalated += 1;
      else if (stuckRetry === "pending") stats.escalationPending += 1;

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
        await clearCaptureStallOnRecovery({
          orderId,
          paymentId,
          outcome: "compensated",
          nowMs,
        });
        continue;
      }
      if (outcome.outcome === "refund_failed") {
        // Only reachable from the owed branch above; kept defensive so a future
        // call path cannot silently drop a failure.
        const stall = await recordCaptureRecoveryFailure({
          orderId,
          paymentId,
          state: gate.state as CaptureFulfillmentState,
          nowMs,
        });
        if (stall === "escalated") stats.escalated += 1;
        else if (stall === "pending") stats.escalationPending += 1;
        stats.retried += 1;
        continue;
      }
      if (outcome.outcome === "refund_exhausted") {
        stats.escalated += 1;
        continue;
      }
      if (outcome.outcome === "pending") {
        // Another actor took the lease while we looked: leave it alone. This is
        // NOT a recovery failure and must never count toward a stall.
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

        // ── FED-AND-REFUNDED GUARD ─────────────────────────────────────────
        // Only for a row a human was already paged about (an escalated stall
        // case exists): staff can refund in the Razorpay dashboard at any
        // moment, and confirming afterwards would cook food that has already
        // been returned. A healthy row never pays for this extra read.
        const escalatedCase = await gateCaseRef(paymentId).get().catch(() => null);
        const caseData = escalatedCase?.exists
          ? ((escalatedCase.data() || {}) as any)
          : null;
        const staffResolved =
          !!caseData &&
          typeof caseData.status === "string" &&
          caseData.status !== "needs_review";

        if (caseData && !staffResolved) {
          const { probeGatewayRefund } = await import("./razorpay.service");
          const probe = await probeGatewayRefund(paymentId);
          if (probe !== "clean") {
            // `refunded` -> record it and stand down; `unknown` -> fail CLOSED
            // for this tick without counting a recovery failure (an unreadable
            // gateway is not evidence the customer is stuck).
            if (probe === "refunded") {
              await markCaseRefundedExternally({ orderId, paymentId });
              stats.skipped += 1;
            } else {
              await captureErrorSnapshot({
                source: "payments",
                severity: "medium",
                message:
                  `Refund probe unreadable for escalated order ${orderId} — automatic ` +
                  `confirmation withheld this tick (fail closed)`,
                orderId,
                razorpayPaymentId: paymentId,
              }).catch(() => undefined);
              stats.skipped += 1;
            }
            continue;
          }
        }

        const { completeRecoveredCapture } = await import("./razorpay.service");
        // HONEST LIMIT: a dashboard refund can still land between this gateway
        // read and the confirmation transaction below; that window is small
        // (one order-doc write) and unavoidable without a gateway-side lock, so
        // the follow-up alert is the backstop rather than a claim of
        // impossibility.
        const confirmed = await completeRecoveredCapture({
          orderId,
          razorpayPaymentId: paymentId,
          orderData: live,
        });
        if (confirmed) {
          stats.confirmed += 1;
          stats.completed += 1;
          await clearCaptureStallOnRecovery({
            orderId,
            paymentId,
            outcome: "confirmed",
            nowMs,
          });
        } else {
          // A paid customer whose confirmation keeps failing must reach a human.
          // The stall is counted transactionally and escalated on the SAME
          // durable outbox once it has lasted an hour; the gate state, the money
          // and the automatic retries are all left untouched, so a later success
          // still wins.
          const stall = await recordCaptureRecoveryFailure({
            orderId,
            paymentId,
            state: gate.state as CaptureFulfillmentState,
            nowMs,
          });
          if (stall === "escalated") stats.escalated += 1;
          else if (stall === "pending") stats.escalationPending += 1;
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

      // ── EXCEPTION PATH ESCALATION ──────────────────────────────────────────
      // A row that THROWS on every sweep (malformed order, datastore fault) is
      // exactly as stuck as one whose confirmation returns false — and before
      // this it looped forever, because the normal stall counter was never
      // reached. Only DECISION lanes are counted here: the owed refund lanes
      // (`refund_failed`/`refund_pending`/`refund_exhausted`) have their own
      // budget and escalation, and a lease refusal or a skip never reaches the
      // catch at all.
      //
      // Best effort: if recording throws too, the medium snapshot below still
      // runs and the sweep loop continues with the next order.
      const decisionLane =
        !!gate &&
        !!paymentId &&
        (gate.state === "checking" || gate.state === "fulfillable");
      if (decisionLane) {
        try {
          const stall = await recordCaptureRecoveryFailure({
            orderId,
            paymentId,
            state: gate!.state as CaptureFulfillmentState,
            nowMs,
          });
          if (stall === "escalated") stats.escalated += 1;
          else if (stall === "pending") stats.escalationPending += 1;
        } catch (recordErr: any) {
          console.warn(
            `[Capture Recovery] stall recording failed for order ${orderId} ` +
              `(the row stays retried, not escalated):`,
            recordErr?.message || recordErr
          );
        }
      }

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
