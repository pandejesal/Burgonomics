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
  escalated: number;
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
 * Escalates a refund whose retry budget is spent, and MOVES the row into the
 * separately-monitored `refund_exhausted` state so it stops occupying the retry
 * pages. The refund identity (payment id, detail, attempts) is preserved, so the
 * claim is never lost and a human can still act on it.
 *
 * OWNERSHIP FIRST, ALERT SECOND. The transition is claimed in ONE transaction
 * that revalidates the payment id, the gate state, the attempt count and the
 * absence of a live lease. Only a worker that genuinely owns an exhausted,
 * re-validated failure proceeds. This matters because the alert is AWAITED: a
 * live sibling can finish the refund while we wait, and the old code then did a
 * blind `set` that clobbered `refunded` back to `refund_exhausted` (and raised a
 * false "manual refund required" alert for money that had just been returned).
 *
 * Returns true only when THIS caller owned the transition.
 */
async function escalateExhaustedRefund(args: {
  orderId: string;
  paymentId: string;
  attempts: number;
  detail?: string;
}): Promise<boolean> {
  const claimed = await claimExhaustion(args);
  if (!claimed) return false;

  // Record the transition (outbox-style park + audit) BEFORE any alert, so the
  // ownership proof is durable and the alert can never outlive the truth.
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
          reason: "refund_retries_exhausted",
          gateState: "refund_exhausted",
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
      `refund budget spent after ${args.attempts} attempt(s) — manual intervention required ` +
      `(see unmatched_payments/ump_gate_${args.paymentId})`,
    orderId: args.orderId,
    razorpayPaymentId: args.paymentId,
  }).catch(() => undefined);
  return true;
}

/**
 * The exhaustion CAS. Revalidates EVERYTHING that makes this worker the owner
 * of the exhausted transition, inside the same transaction that writes it:
 *
 *  - the order's gate must still name THIS payment;
 *  - the gate must still be an OWED state (`refund_failed`/`refund_pending`),
 *    never `refunded` and never an already-`refund_exhausted` record;
 *  - no live lease may exist (a sibling may be mid-refund right now);
 *  - the persisted attempt count must still be at/over the budget.
 *
 * Any mismatch means someone else already settled it: return false and emit
 * nothing.
 */
async function claimExhaustion(args: {
  orderId: string;
  paymentId: string;
  attempts: number;
  detail?: string;
}): Promise<boolean> {
  if (!db || typeof (db as any).runTransaction !== "function") return false;
  try {
    return !!(await (db as any).runTransaction(async (tx: any) => {
      const ref = db.collection("orders").doc(args.orderId);
      const snap = await tx.get(ref);
      if (!snap || !snap.exists) return false;
      const fresh = (snap.data() || {}) as any;
      const record = gateOf(fresh);
      if (!record) return false;
      if (record.paymentId !== args.paymentId) return false;
      if (record.state !== "refund_failed" && record.state !== "refund_pending") {
        return false;
      }
      if (record.attempts < CAPTURE_GATE_MAX_ATTEMPTS) return false;

      const age = Date.now() - record.atMs;
      const leaseLive =
        Number.isFinite(record.atMs) && record.atMs > 0 && age < CAPTURE_GATE_LEASE_MS;
      // A live lease belongs to an in-flight refund attempt: never steal it.
      if (leaseLive && record.state === "refund_pending") return false;

      tx.set(
        ref,
        {
          captureFulfillment: {
            state: "refund_exhausted",
            paymentId: args.paymentId,
            atMs: Date.now(),
            attempts: record.attempts,
            ...(record.detail || args.detail
              ? { detail: record.detail || args.detail }
              : {}),
          },
          captureFulfillmentState: "refund_exhausted",
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      return true;
    }));
  } catch (err: any) {
    console.warn(
      `[Capture Recovery] exhaustion claim failed for order ${args.orderId} — leaving it owed:`,
      err?.message || err
    );
    return false;
  }
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
 *  - `refund_exhausted` rows are ESCALATED (staff-visible) and then moved out of
 *    the retry lane entirely, so they cannot occupy the retry pages forever;
 *  - `fulfillable` confirmation candidates come LAST with their own budget,
 *    because a healthy backlog must never starve an owed refund.
 *
 * The cursor is `captureRecoveryCursor` on the scheduler-lock document: it is a
 * plain bounded-query offset record, not a source of truth, and a lost cursor
 * only ever means "scan from the start" (never a skipped order).
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

      const paymentId = gate.paymentId || capturedPaymentIdOf(order);
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
          // Budget spent: the CAS revalidates ownership before anything is
          // written or alerted. A live sibling that already settled it wins.
          const owned = await escalateExhaustedRefund({
            orderId,
            paymentId,
            attempts: Math.max(gate.attempts, CAPTURE_GATE_MAX_ATTEMPTS),
            detail: gate.detail,
          });
          if (owned) stats.escalated += 1;
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
          const owned = await escalateExhaustedRefund({
            orderId,
            paymentId,
            attempts: CAPTURE_GATE_MAX_ATTEMPTS,
            detail: gate.detail,
          });
          if (owned) stats.escalated += 1;
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
            const owned = await escalateExhaustedRefund({
              orderId,
              paymentId,
              attempts: used,
              detail: outcome.detail,
            });
            if (owned) stats.escalated += 1;
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
        // Only reachable from the owed branch above; kept defensive so a future
        // call path cannot silently drop a failure.
        stats.retried += 1;
        continue;
      }
      if (outcome.outcome === "refund_exhausted") {
        stats.escalated += 1;
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
