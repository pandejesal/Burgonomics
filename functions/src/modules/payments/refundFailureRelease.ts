import * as admin from "firebase-admin";
import * as crypto from "node:crypto";
import { db } from "../../core/firebase";
import { captureErrorSnapshot } from "../../core/errors";
import { dispatchCustomerAccountNotification } from "../tickets/supportNotifications";
import { withoutProcessedRefund } from "../settlements/settlementMath";
import { queueRefundCorrectionInTx } from "./settlementCaptureRecovery";

/**
 * C11 / A1-payments finding 2 (Critical) — the `refund.failed` release.
 *
 * A refund the gateway accepted as `pending` RESERVES its amount:
 * `refundLedger[refundId]`, `refundedTotalPaise`, `refundStatus:
 * "refund_pending"`, the single-current `refundPendingGatewayId`/`Since`
 * markers, and an `IN_FLIGHT` operator row. The webhook used to answer 200 and
 * delete only `settlementProcessedRefunds[refundId]`, so a refund the bank then
 * FAILED (documented causes: bank/account problems, payments older than six
 * months, merchant balance shortfall) left the order permanently wedged:
 *
 *   • the amount still consumed the refundable cap, so a new request was
 *     refused with `400 REFUND_EXCEEDS_REMAINING`;
 *   • `refund_pending` + the still-reserved pending id made the single
 *     in-flight guard answer `409 REFUND_IN_PROGRESS`;
 *   • the console mapped the lingering `IN_FLIGHT` row to a non-actionable
 *     UNKNOWN with no Approve/Retry;
 *   • a retry with the SAME request id hit the "accepted-but-unsettled"
 *     shortcut and returned `{status:"pending", reused:true}` without POSTing
 *     anything — a success message for a refund that would never happen;
 *   • nothing told the customer, and nothing paged anyone. Only a manual
 *     Firestore edit could unwedge it.
 *
 * This module performs the one transaction that releases exactly this refund's
 * own reservation and closes the correlated records, then raises the alert and
 * the customer message outside it. Money truth is never rewritten downwards for
 * a refund that is ALREADY settled: a contradictory late `failed` is recorded
 * beside it and escalated instead.
 */

export interface FailedRefundReleaseInput {
  refundId: string;
  /** Order id named on the refund notes (already shape-checked by the caller). */
  orderId: string | null;
  paymentId: string | null;
  eventId: string;
  /** The gateway's own explanation, for the operator and the customer copy. */
  gatewayReason?: string | null;
}

export interface FailedRefundReleaseOutcome {
  outcome:
    | "released"
    | "already_settled"
    | "order_not_found"
    | "unknown_order"
    | "no_change";
  orderId?: string;
  refundedTotalPaise?: number;
  restoredStatus?: string | null;
  requestDocId?: string | null;
  rowDocId?: string | null;
}

const FAILURE_NOTE_MAX = 300;

/**
 * Rebases a map field WITHOUT one of its keys, for a `set(..., {merge:true})`.
 *
 * `@google-cloud/firestore` states the semantics: "Fields omitted from this
 * set() call remain untouched." So a key that is merely dropped from the copied
 * map keeps its stored value — the dead reservation would survive the merge.
 * `FieldValue.delete()` on the exact path is the only nested-field delete a
 * merge-set can express; it is a no-op when the key is already gone, so the
 * sentinel is only added when the key was actually present.
 */
function mergeWithoutKey(
  current: Record<string, any> | undefined,
  key: string
): Record<string, any> {
  const next: Record<string, any> = { ...(current || {}) };
  if (!Object.prototype.hasOwnProperty.call(next, key)) return next;
  delete next[key];
  next[key] = admin.firestore.FieldValue.delete();
  return next;
}

function boundedReason(raw: unknown): string {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return "The gateway reported this refund as failed";
  return text.length > FAILURE_NOTE_MAX ? `${text.slice(0, FAILURE_NOTE_MAX - 1)}…` : text;
}

/**
 * Locates the order a failed refund belongs to, without ever inventing one.
 *
 * The refund notes carry `orderId` for every refund this server posts. A
 * refund created elsewhere (dashboard, support tool) has no note, so the
 * payment id is the only handle; the SAME dual-shape payment lookup the
 * `refund.processed` branch uses applies. More than one match is ambiguous —
 * resolved as `unknown_order` (parked) rather than guessed.
 */
export async function findOrderForFailedRefund(
  orderId: string | null,
  paymentId: string | null
): Promise<{ ref: any; data: any } | "ambiguous" | null> {
  if (orderId) {
    const ref = db.collection("orders").doc(orderId);
    const snap = await ref.get();
    const data = (snap.exists ? snap.data() : undefined) as any;
    if (data) return { ref, data };
    // The note named an order we do not hold (a deleted/mistyped doc). Fall
    // through to the payment-id lookup instead of declaring the refund orphaned.
  }
  if (!paymentId) return null;
  const canonical = await db
    .collection("orders")
    .where("payment.razorpayPaymentId", "==", paymentId)
    .limit(2)
    .get();
  const docs: any[] = Array.isArray(canonical?.docs) ? canonical.docs : [];
  if (docs.length > 1) return "ambiguous";
  if (docs.length === 1) {
    return { ref: docs[0].ref, data: (docs[0].data() as any) ?? {} };
  }
  // SAME dual-shape lookup the `refund.processed` branch uses: pre-fix writers
  // merge-set the literal dotted field name, which a plain dotted `where` reads
  // as a nested path. An unreadable legacy lookup is not fatal here — the
  // caller parks the event visibly in `unmatched_payments`, never silently.
  const FieldPathCtor: any = (admin as any)?.firestore?.FieldPath;
  if (docs.length === 0 && typeof FieldPathCtor === "function") {
    try {
      const legacy = await db
        .collection("orders")
        .where(new FieldPathCtor("payment.razorpayPaymentId"), "==", paymentId)
        .limit(2)
        .get();
      const legacyDocs: any[] = Array.isArray(legacy?.docs) ? legacy.docs : [];
      if (legacyDocs.length > 1) return "ambiguous";
      if (legacyDocs.length === 1) {
        return { ref: legacyDocs[0].ref, data: (legacyDocs[0].data() as any) ?? {} };
      }
    } catch (err: any) {
      console.warn(
        "[Refund Failed] legacy dotted payment-id lookup failed — parking the event:",
        err?.message || err
      );
    }
  }
  return null;
}

/**
 * Releases the reservation and closes the correlated records in ONE transaction.
 *
 * ALL reads happen before ALL writes (real Firestore rejects the reverse), and
 * every write is merge-shaped so the order's other payment truth survives.
 */
export async function releaseFailedRefund(
  input: FailedRefundReleaseInput
): Promise<FailedRefundReleaseOutcome> {
  const { refundId, orderId, paymentId, eventId } = input;
  if (!refundId) return { outcome: "no_change" };

  const located = await findOrderForFailedRefund(orderId, paymentId);
  if (located === "ambiguous") return { outcome: "unknown_order" };
  if (!located) return { outcome: "order_not_found" };

  const orderRef: any = located.ref;

  const outcome = await (db as any).runTransaction(async (tx: any) => {
    // ---- ALL READS FIRST -------------------------------------------------
    const snap = await tx.get(orderRef);
    const data = (snap && snap.exists ? snap.data() : null) as any;
    if (!data) return { outcome: "order_not_found" as const };

    // Correlation is derived from the TRANSACTION-FRESH document, never the
    // pre-read: a `refundKeyedReceipts` write that lands between the locate and
    // this transaction must still address the record it names.
    const keyedRequestId =
      typeof data?.refundKeyedReceipts?.[refundId] === "string" &&
      data.refundKeyedReceipts[refundId].trim()
        ? String(data.refundKeyedReceipts[refundId]).trim()
        : "";
    // The doc id is the authoritative order identity (a `where`-located order
    // carries no `id` field of its own), so it is read from the REF first.
    const resolvedOrderDocId = String(orderRef?.id || data?.id || orderId || "");
    // The request id is derived from the order's RECORDED payment id when the
    // gateway payload omitted `payment_id` (dashboard refunds can), otherwise
    // the derived doc id would not match the record the release path wrote.
    const recordedPaymentId =
      paymentId ||
      String(data?.payment?.razorpayPaymentId || data?.["payment.razorpayPaymentId"] || "");
    const correlatedRequestDocId = keyedRequestId
      ? deriveRequestDocId(resolvedOrderDocId, recordedPaymentId, keyedRequestId)
      : null;
    const correlatedRowDocId =
      keyedRequestId && keyedRequestId.startsWith("refundreq_")
        ? keyedRequestId.slice("refundreq_".length)
        : null;
    const requestRef = correlatedRequestDocId
      ? db.collection("payment_refund_requests").doc(correlatedRequestDocId)
      : null;
    const requestSnap = requestRef ? await tx.get(requestRef) : null;
    const requestData =
      requestSnap && requestSnap.exists ? (requestSnap.data() as any) : null;

    const rowRef = correlatedRowDocId
      ? db.collection("refunds").doc(correlatedRowDocId)
      : null;
    const rowSnap = rowRef ? await tx.get(rowRef) : null;
    const rowData = rowSnap && rowSnap.exists ? (rowSnap.data() as any) : null;

    const obligation = data?.refundObligation;
    // The reservation is judged on the TRANSACTION-FRESH document, never on the
    // pre-read: a pending write that landed between the locate and this
    // transaction must not be released on stale evidence.
    const txLedger: Record<string, number> =
      data?.refundLedger &&
      typeof data.refundLedger === "object" &&
      !Array.isArray(data.refundLedger)
        ? (data.refundLedger as Record<string, number>)
        : {};
    const txReservedPaise = Number(txLedger[refundId]) || 0;
    // PER-ID PROOF OF SETTLEMENT. A ledger entry is NOT proof (a pending refund
    // reserves its amount there), and a global status word is not either.
    const settledThisRefund =
      obligation?.settledRefundId === refundId ||
      obligation?.settledAfterDecision?.gatewayRefundId === refundId ||
      (String(requestData?.status || "") === "completed" &&
        requestData?.refundId === refundId) ||
      (String(rowData?.status || "").toUpperCase() === "COMPLETED" &&
        rowData?.gatewayRefundId === refundId);

    if (settledThisRefund) {
      // A contradictory signal about money that already moved. Never rewrite
      // the ledger/total downwards on one late event — escalate it.
      return { outcome: "already_settled" as const };
    }

    if (txReservedPaise <= 0) {
      // This order holds no reservation for the refund: still close the
      // records if they name THIS refund, so the console stops offering a
      // retry of a dead attempt. No money field is touched.
      const reason = boundedReason(input.gatewayReason);
      if (requestRef && requestData && requestData.refundId === refundId) {
        tx.set(
          requestRef,
          {
            status: "failed",
            gatewayStatus: "failed",
            failureReason: reason,
            failedAt: Date.now(),
            attemptGeneration: (Number(requestData.attemptGeneration) || 1) + 1,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
      }
      if (rowRef && rowData && rowData.gatewayRefundId === refundId) {
        tx.set(
          rowRef,
          {
            status: "FAILED",
            gatewayStatus: "failed",
            failureReason: reason,
            failedAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
      }
      return { outcome: "no_change" as const };
    }

    // The reservation map is rebased without this refund's key (a merge-set
    // would keep an omitted key, so the helper names it with a delete).
    const ledger: Record<string, any> = mergeWithoutKey(txLedger, refundId);
    const nextTotal = Object.entries(txLedger)
      .filter(([key]) => key !== refundId)
      .reduce((sum, [, v]) => sum + (Number(v) || 0), 0);

    const capturedPaise =
      Number(data?.payment?.capturedAmountPaise) ||
      Number(data?.["payment.capturedAmountPaise"]) ||
      0;

    /**
     * Restore a status that no longer claims a refund is in flight.
     *
     * The pre-pending value is not stored anywhere, so it is derived from the
     * money still reserved: nothing left is the clean state (null), a partial
     * reservation is `partially_refunded`, and a full one is `refunded`.
     * `refund_pending` / `refunding` / `pending` are never restored.
     */
    const restoredStatus: string | null =
      nextTotal <= 0
        ? null
        : capturedPaise > 0 && nextTotal < capturedPaise
          ? "partially_refunded"
          : "refunded";

    const pendingId =
      typeof data?.refundPendingGatewayId === "string"
        ? data.refundPendingGatewayId.trim()
        : "";
    // Only THIS refund's markers are cleared. A different still-reserved
    // pending refund keeps its identity and its status words.
    const ownsPendingMarker = !pendingId || pendingId === refundId;

    const priorPayment =
      data?.payment && typeof data.payment === "object" && !Array.isArray(data.payment)
        ? data.payment
        : {};
    const priorKeyed =
      data?.refundKeyedReceipts && typeof data.refundKeyedReceipts === "object"
        ? mergeWithoutKey(data.refundKeyedReceipts as Record<string, string>, refundId)
        : {};

    const reason = boundedReason(input.gatewayReason);
    const priorObligation =
      obligation && typeof obligation === "object" && !Array.isArray(obligation)
        ? obligation
        : {};
    const obligationWasInFlight =
      String(priorObligation.status || "").toUpperCase() === "IN_FLIGHT" ||
      priorObligation.gatewayRefundId === refundId;

    // REVERSAL OF THE SETTLEMENT CORRECTION (round-b interaction).
    //
    // `settlementProcessedRefunds` is the only signal that money actually
    // returned, so it is also the only thing a statement deducts. A refund
    // which reached the statement map and is only NOW reported as failed
    // (bank decline, expired authorisation, merchant balance shortfall) must
    // not keep its deduction: the map is rebased below, and the closed month
    // that was already published WITH that deduction is re-requested here, from
    // the corrected truth. The helper is write-only and fires on the 0↔amount
    // transition, so a failure for a refund that never entered the map queues
    // nothing, and this write cannot introduce a read-after-write inside the
    // transaction.
    //
    // The rebase itself must use the delete sentinel, not an omitted key: a
    // merge-set keeps a key that is merely omitted, so `withoutProcessedRefund`
    // alone leaves the old entry stored under a recursive-merge reader (the
    // ledger below already has this guard for the same reason).
    const processedAfter = mergeWithoutKey(data?.settlementProcessedRefunds, refundId);
    // The helper compares AMOUNTS, so it is given the plain map; the write
    // below carries the delete sentinel for the same state.
    await queueRefundCorrectionInTx(
      tx,
      resolvedOrderDocId,
      data,
      refundId,
      withoutProcessedRefund(data?.settlementProcessedRefunds, refundId)
    );

    // ---- WRITES ----------------------------------------------------------
    tx.set(
      orderRef,
      {
        refundLedger: ledger,
        refundedTotalPaise: nextTotal,
        settlementProcessedRefunds: processedAfter,
        refundKeyedReceipts: priorKeyed,
        refundStatus: restoredStatus,
        payment: {
          ...priorPayment,
          refundStatus: restoredStatus ?? "none",
        },
        ...(ownsPendingMarker
          ? {
              refundPendingGatewayId: admin.firestore.FieldValue.delete(),
              refundPendingSince: admin.firestore.FieldValue.delete(),
            }
          : {}),
        refundObligation: obligationWasInFlight
          ? {
              ...priorObligation,
              status: "FAILED",
              failedRefundId: refundId,
              failureReason: reason,
              failedAt: admin.firestore.FieldValue.serverTimestamp(),
            }
          : priorObligation,
        refundLastFailure: {
          gatewayRefundId: refundId,
          reason,
          eventId,
          at: admin.firestore.FieldValue.serverTimestamp(),
        },
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    if (requestRef && requestData && requestData.refundId === refundId) {
      tx.set(
        requestRef,
        {
          status: "failed",
          gatewayStatus: "failed",
          failureReason: reason,
          failedAt: Date.now(),
          // The gateway dedupes a retry by idempotency key: replaying the failed
          // key would return the failure again. The retry derives a NEW key from
          // this generation (see autoRefund).
          attemptGeneration: (Number(requestData.attemptGeneration) || 1) + 1,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    }
    if (rowRef && rowData && rowData.gatewayRefundId === refundId) {
      tx.set(
        rowRef,
        {
          status: "FAILED",
          gatewayStatus: "failed",
          failureReason: reason,
          failedAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    }

    return {
      outcome: "released" as const,
      refundedTotalPaise: nextTotal,
      restoredStatus,
      requestDocId: correlatedRequestDocId,
      rowDocId: correlatedRowDocId,
    };
  });

  const resolvedOrderId = String(located.data?.id || orderRef?.id || orderId || "");
  return {
    ...outcome,
    orderId: resolvedOrderId,
  } as FailedRefundReleaseOutcome;
}

/** Same derivation as `refundRequestDocId` (razorpay.service.ts) — behavioural. */
function deriveRequestDocId(orderId: string, paymentId: string, requestId: string): string {
  const digest = crypto
    .createHash("sha256")
    .update(JSON.stringify([orderId, paymentId, requestId]))
    .digest("hex");
  return `prfnd_${digest.slice(0, 48)}`;
}

/**
 * The visible consequences of a released failure: an ops alert and a customer
 * message. Both are deliberately non-fatal — the money state is already
 * committed by the transaction above, so a transport hiccup must not turn this
 * into a 500 that makes Razorpay redeliver a settled decision.
 */
export async function announceFailedRefund(
  outcome: FailedRefundReleaseOutcome,
  input: FailedRefundReleaseInput,
  orderData: any
): Promise<void> {
  const reason = boundedReason(input.gatewayReason);
  const orderId = outcome.orderId || input.orderId || "unknown order";

  if (outcome.outcome === "already_settled") {
    await captureErrorSnapshot({
      source: "payments",
      severity: "high",
      message:
        `Gateway reported refund ${input.refundId} as FAILED for order ${orderId}, but that refund is already recorded as settled — ` +
        `money truth left untouched; reconcile the contradiction with Razorpay before acting`,
      orderId: outcome.orderId,
      razorpayPaymentId: input.paymentId || undefined,
    }).catch(() => undefined);
    return;
  }

  const released = outcome.outcome === "released" || outcome.outcome === "no_change";
  await captureErrorSnapshot({
    source: "payments",
    severity: "high",
    message:
      `Refund ${input.refundId} FAILED at the gateway for order ${orderId} (${reason}) — ` +
      (outcome.outcome === "released"
        ? `reservation released, remaining refundable balance reopened; retry with the same request id`
        : `no reservation was held for it; records closed, retry with the same request id`),
    orderId: outcome.orderId,
    razorpayPaymentId: input.paymentId || undefined,
  }).catch(() => undefined);

  if (!released) return;

  const recipientUid =
    (typeof orderData?.customerId === "string" && orderData.customerId) ||
    (typeof orderData?.userId === "string" && orderData.userId) ||
    "";
  if (!recipientUid) return;
  try {
    await dispatchCustomerAccountNotification({
      purpose: "orderUpdates",
      recipientUid,
      targetId: String(outcome.orderId || ""),
      type: "refund_failed",
      title: "Refund could not be completed",
      // No order id, name or amount in the copy: the inbox pointer carries the
      // binding, and a lock screen must not leak order detail.
      body: "Your refund could not be completed by the bank. Our team has been alerted and will process it again — you do not need to do anything.",
    });
  } catch {
    // Non-blocking: the money state is already committed.
  }
}
