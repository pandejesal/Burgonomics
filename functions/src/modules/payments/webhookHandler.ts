import { Request, Response } from "express";
import * as admin from "firebase-admin";
import * as crypto from "crypto";
import { db } from "../../core/firebase";
import { config, assertLivePaymentsContext } from "../../config/env";
import { verifyRazorpayWebhookSignature, isSafeDocId } from "../../core/security";
import { captureErrorSnapshot } from "../../core/errors";
import { markOrderReconciliation, claimCapturedPaymentInTx } from "./reconciliation";
import { receiptEvidenceStamp } from "./receiptEvidence";
import { guardCaptureFulfillment, captureGateAllowsConfirm } from "./captureFulfillment";
import { applyRefundToMonthlyFee } from "./monthlyFee";
import { deliverCaptureRecoveryAlert, queueRefundCorrectionInTx, repairSettlementCaptureInTx } from "./settlementCaptureRecovery";
import { settlementCaptureStamp, providerCapturedAtMs, isProviderConfirmedCapture, processedRefundMap, withoutProcessedRefund } from "../settlements/settlementMath";
import { releaseFailedRefund, announceFailedRefund } from "./refundFailureRelease";
import { dispatchCustomerAccountNotification } from "../tickets/supportNotifications";

/**
 * Reads a legacy DOT-LITERAL field path — `"payment.razorpayPaymentId"` as a
 * field NAME, which is what merge-set writers produced before the canonical
 * nested `payment` map existed. Firestore parses a plain dotted string in
 * `where()` as a NESTED path, so the literal field can only be queried through
 * a single-segment `FieldPath`. Returns null when the datastore exposes no
 * FieldPath constructor (test shims): the canonical query still runs.
 */
function legacyDottedFieldPath(field: string): any | null {
  const FieldPathCtor: any = (admin as any)?.firestore?.FieldPath;
  if (typeof FieldPathCtor !== "function") return null;
  try {
    return new FieldPathCtor(field);
  } catch {
    return null;
  }
}

/**
 * The `payment_refund_requests` document id for one [order, payment, request]
 * identity. The same derivation exists in razorpay.service.ts as
 * `refundRequestDocId`; it is duplicated here rather than imported because a
 * module-level dependency on the refund service would change the module graph
 * of every webhook suite. What keeps the two copies honest is behavioural: the
 * promotion cases in refund.pending-lifecycle.test.ts require this handler to
 * find and complete the record the release path created for the same identity.
 * (The two functions are not byte-compared by any test.)
 */
function refundRequestDocIdFor(
  orderId: string,
  paymentId: string,
  requestId: string
): string {
  const digest = crypto
    .createHash("sha256")
    .update(JSON.stringify([orderId, paymentId, requestId]))
    .digest("hex");
  return `prfnd_${digest.slice(0, 48)}`;
}

/**
 * Resolves the orders bound to a captured Razorpay payment id across BOTH
 * storage shapes:
 *   • canonical nested `payment.razorpayPaymentId` — what every confirm writer
 *     emits now (and the only shape a `where("payment.razorpayPaymentId")`
 *     query can match);
 *   • legacy top-level literal `"payment.razorpayPaymentId"` — pre-fix docs,
 *     queried through the single-segment FieldPath above.
 * Results are de-duplicated by document path, so a doc carrying BOTH shapes
 * (dual-written during migration) is counted exactly ONCE and never looks
 * ambiguous. Errors fail CLOSED: an unreadable canonical lookup, or an
 * unreadable legacy lookup with no canonical match, throws (→ 500 → gateway
 * retry) instead of parking a real refund as unmatched.
 */
async function findOrdersByCapturedPaymentId(paymentId: string): Promise<any[]> {
  const found = new Map<string, any>();
  const collect = (snap: any) => {
    const docs: any[] = Array.isArray(snap?.docs) ? snap.docs : [];
    for (const d of docs) {
      const key =
        (typeof d?.ref?.path === "string" && d.ref.path) ||
        (typeof d?.id === "string" && d.id) ||
        `idx_${found.size}`;
      if (!found.has(key)) found.set(key, d);
    }
  };

  collect(
    await db
      .collection("orders")
      .where("payment.razorpayPaymentId", "==", paymentId)
      .limit(2)
      .get()
  );

  const legacyPath = legacyDottedFieldPath("payment.razorpayPaymentId");
  if (legacyPath) {
    try {
      collect(
        await db
          .collection("orders")
          .where(legacyPath, "==", paymentId)
          .limit(2)
          .get()
      );
    } catch (err: any) {
      // The migration fallback must not become a refund outage. With a
      // canonical match in hand the refund can proceed (the legacy shape can
      // only add an ambiguity, it can never invalidate the canonical doc);
      // with NO match yet we cannot prove the refund is unmatched, and parking
      // it would strand real money — fail closed so the gateway retries.
      await captureErrorSnapshot({
        source: "payments",
        severity: "high",
        message:
          `Legacy dotted payment-id lookup failed for ${paymentId} — ` +
          (found.size > 0
            ? "canonical shape matched, continuing"
            : "refusing to park an unmatched refund (retry required)"),
        errorStack: err?.stack,
      }).catch(() => undefined);
      if (found.size === 0) throw err;
    }
  }

  return [...found.values()].slice(0, 2);
}

/**
 * F5a: fields the webhook's confirm transaction must add so a settlement is
 * never lost when the process dies between CONFIRMED and the split. Only when
 * the order has no settlement lane yet — an existing lane (including a terminal
 * one) is never rewritten by a confirmation.
 */
export function webhookConfirmSettlementFields(freshOrder: any): Record<string, any> {
  const existing = freshOrder?.routeTransferStatus;
  if (typeof existing === "string" && existing) return {};
  return { routeTransferStatus: "pending_retry", routeTransferRetryCount: 0 };
}

/**
 * C11 finding 1 (Critical) — the confirmation transaction QUEUES the POS sync
 * instead of the handler ringing the kitchen inline.
 *
 * Razorpay gives this endpoint 5 seconds. The old code awaited
 * `pushOrderToPetpooja` (15 s abort) AFTER the money transaction committed and
 * BEFORE `res.status(200)`, so every slow/unreachable outlet made the delivery
 * a failure: Razorpay retried it (each retry hit `500 Event is being processed`
 * while the claim lease was live), and after 24 h of failures it DISABLED the
 * webhook — silently stopping confirmation for every closed-app payer.
 *
 * The status write below is the queue the existing `retryPetpoojaOrders`
 * worker already drains (5-min cron, its own lease, backoff 5/10/20/40 min,
 * dead-letter to `failed` + branch alert), and `pushOrderToPetpooja` dedupes on
 * the acceptance marker, so a redelivery cannot ring a second ticket.
 *
 * Never overwrites a row the retry machinery, a parked state, or a recorded POS
 * acceptance already owns: a `synced` order must not be dragged back into the
 * lane by a duplicate `order.paid`, and a dead-lettered (`failed`) or
 * reconciliation-parked row must not be requeued behind the operator's back.
 */
export function webhookConfirmPosSyncFields(freshOrder: any): Record<string, any> {
  if (!freshOrder || typeof freshOrder !== "object") return {};
  if (freshOrder.petpoojaOrderId || freshOrder.petpoojaAcceptedNoId) return {};
  if (freshOrder.petpoojaAmbiguousProcessing === true) return {};
  const status = typeof freshOrder.petpoojaStatus === "string" ? freshOrder.petpoojaStatus : "";
  if (
    status === "processing" ||
    status === "synced" ||
    status === "reconciliation_required" ||
    status === "blocked_configuration" ||
    status === "pending_configuration" ||
    status === "failed" ||
    status === "not_applicable"
  ) {
    return {};
  }
  // `accepted_unconfirmed` is a RECORDED POS acceptance (the relay acked without
  // a usable id) — `hasRecordedPosAcceptance` treats it as real POS knowledge, so
  // requeueing it here would risk a second ticket at the outlet.
  if (
    status === "accepted_unconfirmed" ||
    freshOrder.petpoojaSyncStatus === "accepted_unconfirmed"
  ) {
    return {};
  }
  return { petpoojaStatus: "pending_retry", petpoojaSyncStatus: "pending_retry" };
}

/**
 * Marks a delivery claim as HELD FOR RETRY instead of deleting it.
 *
 * The previous implementation deleted the claim, which destroyed the only proof
 * that this event had ever been seen. Razorpay's redelivery cadence jumps past
 * the 15-minute freshness window, so the redelivery then looked like a brand
 * new STALE event and was 401'd forever — the order never recovered.
 *
 * The claim now keeps its history and records `retryHeldAt`/`retryReason`. A
 * delivery of an event whose claim is held is a legitimate RETRY: the signature
 * is still verified in full (auth never weakens), and only the freshness rule
 * is relaxed, because this server has first-hand evidence the event is ours and
 * was accepted for retry. The claim stays recoverable by ordinary lease
 * takeover once its TTL passes.
 */
async function holdEventClaimForRetry(
  eventId: string,
  auditDocRef: any,
  reason: string
): Promise<void> {
  try {
    await auditDocRef.set(
      {
        retryHeldAt: Date.now(),
        retryReason: reason,
        retryCount: admin.firestore.FieldValue.increment(1),
      },
      { merge: true }
    );
  } catch (err: any) {
    console.warn(
      `[Razorpay Webhook] claim hold-for-retry failed for ${eventId} (${reason}):`,
      err?.message || err
    );
  }
}

/**
 * Handles incoming webhooks from Razorpay with signature verification & idempotent execution.
 */
export async function handleRazorpayWebhook(req: Request, res: Response): Promise<void> {
  // ZERO-MOCK production guard (defense in depth — the boot assert is the
  // primary gate): a production process must never act on unverified
  // webhook payloads because a mock flag got flipped after boot.
  try {
    assertLivePaymentsContext("handleRazorpayWebhook");
  } catch (err: any) {
    console.error("[Razorpay Webhook]", err?.message || err);
    res.status(500).json({ error: "Webhook processing unavailable" });
    return;
  }

  const signature = req.headers["x-razorpay-signature"] as string;
  const rawBody = (req as any).rawBody
    ? (req as any).rawBody.toString("utf8")
    : typeof req.body === "string"
    ? req.body
    : JSON.stringify(req.body);

  // Fail-closed: without a configured webhook secret there is nothing to
  // verify against — deny instead of checking against a mock/empty secret.
  // (Mock-gateway bypass below is owned by Batch 1 S2 env lockdown.)
  if (!config.mock.paymentGateway && !config.razorpay.webhookSecret) {
    console.warn("[Razorpay Webhook] webhook secret missing — denying webhook (fail-closed)");
    res.status(401).json({ error: "Webhook verification unavailable" });
    return;
  }

  if (!config.mock.paymentGateway) {
    const isValid = verifyRazorpayWebhookSignature(
      rawBody,
      signature,
      config.razorpay.webhookSecret
    );
    if (!isValid) {
      // 401 (never 500): a forged signature is an auth failure, not a
      // retryable server error — Razorpay must not retry forged deliveries
      // into a 500 loop, and 500s page on-call for an attacker probe.
      console.warn("[Razorpay Webhook] Invalid signature received");
      res.status(401).json({ error: "Invalid webhook signature" });
      return;
    }
  }

  const payload = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  const event = payload.event;
  // Fail-closed idempotency key: read official `x-razorpay-event-id` header
  // first, falling back to payload.id. A delivery without a valid event id is
  // rejected outright (fail-closed, no duplicate processing).
  const headerEvtId = req.headers["x-razorpay-event-id"];
  const eventId =
    typeof headerEvtId === "string" && headerEvtId.trim().length > 0
      ? headerEvtId.trim()
      : typeof payload.id === "string" && payload.id.length > 0
        ? payload.id
        : null;
  if (!eventId) {
    console.warn("[Razorpay Webhook] missing x-razorpay-event-id header and payload.id — rejecting (fail-closed, no order write)");
    res.status(401).json({ error: "Missing webhook event id" });
    return;
  }

  // Freshness rule: Razorpay stamps top-level `created_at` (Unix seconds).
  // Payloads without the stamp predate this check and stay accepted (the
  // idempotency claim below still dedups them).
  //
  // ORDERING (stress sweep 2026-10-24): the freshness check runs AFTER the
  // idempotency claim so a CRASHED delivery can be recovered by gateway
  // redelivery. Razorpay's retry cadence jumps past the 10–15 min takeover
  // band; a redelivery of a dead claim is by definition a recovery attempt,
  // and the claim doc — not the payload timestamp — is the replay defense.
  // Only a genuinely-NEW claim is subject to the freshness rule; a takeover
  // and a claim we deliberately HELD FOR RETRY are exempt (see the block below,
  // which answers 2xx for a bounded late delivery and parks anything absurdly
  // old instead of the old permanent 401 — C11 finding 3).
  const auditDocRef = db.collection("payment_audits").doc(`aud_evt_${eventId}`);
  const CLAIM_TTL_MS = 10 * 60 * 1000;
  // Tri-state lease: "new" (we claimed it — process), "done" (a prior
  // attempt completed — 200 ack), "inflight" (a prior attempt claimed
  // recently but never completed: crash or still working — 500 so Razorpay
  // retries. The old code 200-acked inflight claims, and a crash between
  // claim and completion silently dropped real money forever).
  const acquireClaim = async (): Promise<
    "new" | "takeover" | "done" | "inflight" | "retry_held" | "retry_inflight"
  > => {
    try {
      await auditDocRef.create({
        eventId,
        event,
        claimedAt: Date.now(),
        completedAt: null,
      });
      return "new";
    } catch {
      // Lost the race or a prior attempt claimed it — inspect the lease.
      try {
        const snap = await auditDocRef.get();
        const data = (snap.exists ? (snap.data() as any) : undefined) as any;
        if (data?.completedAt) return "done";
        const claimedMs =
          typeof data?.claimedAt?.toMillis === "function"
            ? data.claimedAt.toMillis()
            : typeof data?.claimedAt === "number"
              ? data.claimedAt
              : 0;
        // PROVENANCE: a claim we deliberately HELD FOR RETRY (gate pending,
        // refund failed) is not a crash and not a forgery. Its redelivery is
        // processed as a retry, with only the freshness rule relaxed.
        const heldForRetry =
          typeof data?.retryHeldAt === "number" && Number.isFinite(data.retryHeldAt);
        // Stale claim (previous attempt died >10 min ago): take over by
        // re-stamping a fresh numeric lease, then process. A takeover is a
        // RECOVERY attempt — it is exempt from the payload freshness reject
        // (the caller distinguishes "takeover" from "new").
        if (Date.now() - claimedMs >= CLAIM_TTL_MS) {
          await auditDocRef.set(
            { claimedAt: Date.now(), ...(heldForRetry ? { retryClaimedAt: Date.now() } : {}) },
            { merge: true }
          );
          return heldForRetry ? "retry_held" : "takeover";
        }
        return heldForRetry ? "retry_inflight" : "inflight";
      } catch (leaseErr) {
        // Lease unreadable: we cannot prove a prior attempt completed.
        // Fail LOUD (500 → Razorpay retries) — the old `return true`
        // 200-acked the delivery and silently dropped real money.
        await captureErrorSnapshot({
          source: "payments",
          severity: "high",
          message: `Webhook idempotency lease unreadable for event ${eventId} — retry requested`,
        }).catch(() => undefined);
        throw leaseErr;
      }
    }
  };
  let claim: "new" | "takeover" | "done" | "inflight" | "retry_held" | "retry_inflight";
  try {
    claim = await acquireClaim();
  } catch (leaseErr: any) {
    console.warn(
      "[Razorpay Webhook] idempotency lease unavailable — 500 so Razorpay retries:",
      leaseErr?.message || leaseErr
    );
    res.status(500).json({ error: "Idempotency check unavailable" });
    return;
  }
  if (claim === "done") {
    res.status(200).json({ status: "already_processed" });
    return;
  }
  if (claim === "inflight" || claim === "retry_inflight") {
    res.status(500).json({ error: "Event is being processed — retry shortly" });
    return;
  }

  // PROVEN RETRY: this event was seen and deliberately held for retry. A live
  // claim handled above; here the lease has passed, so the retry proceeds.
  const provenRetry = claim === "retry_held";

  // Freshness rule (relocated: claim-first so dead claims stay recoverable —
  // see the ordering note above). It considers ONLY genuinely-new claims: a
  // takeover already owns a dead lease, and a claim we HELD FOR RETRY is proof
  // this server accepted the event, failed a retryable step, and asked for the
  // delivery again. The signature above was verified in full in every case, so
  // an attacker gains nothing by replaying our own held event.
  // C11 finding 3 (High) — a signature-verified late FIRST delivery is an
  // OPERATIONAL problem, not a forgery, and it must never be answered 401.
  //
  // The old code deleted the claim and answered 401 for any event older than
  // the window. Razorpay stamps `created_at` at event creation, so EVERY
  // redelivery is equally "stale": the next attempt was `new` again, was 401'd
  // again, and the event was permanently dead — while 401 is exactly the code
  // chosen so Razorpay does not retry. An ingress/deploy/Firestore outage
  // longer than 15 minutes therefore lost every capture and every refund
  // settlement created during it, and each of those failures counts toward the
  // 24 h webhook disable.
  //
  // Contract now:
  //   • within LATE_DELIVERY_BOUND_MS: process normally, and stamp
  //     `lateDeliveryAt` on the claim so the lateness is evidence, not silence;
  //   • beyond the bound: park visibly (`unmatched_payments`) and still answer
  //     2xx, so the endpoint is never disabled by an event we simply cannot
  //     trust the age of. The claim is COMPLETED (not deleted) so the park is
  //     traceable and a later redelivery does not re-park.
  // Auth never weakens: the HMAC above was already verified in full.
  const FRESHNESS_WINDOW_MS = 15 * 60 * 1000;
  /** Absolute bound for a late first delivery we will still act on: 30 days. */
  const LATE_DELIVERY_BOUND_MS = 30 * 24 * 60 * 60 * 1000;
  const createdAtSec = typeof payload.created_at === "number" ? payload.created_at : null;
  const eventAgeMs =
    createdAtSec !== null ? Date.now() - createdAtSec * 1000 : null;
  const lateFirstDelivery =
    claim === "new" && eventAgeMs !== null && eventAgeMs > FRESHNESS_WINDOW_MS;
  if (lateFirstDelivery && eventAgeMs !== null && eventAgeMs > LATE_DELIVERY_BOUND_MS) {
    const ageDays = Math.floor(eventAgeMs / (24 * 60 * 60 * 1000));
    console.warn("[Razorpay Webhook] late delivery beyond the absolute bound — parked", {
      eventId,
      event,
      ageDays,
    });
    try {
      await db.collection("unmatched_payments").doc(`ump_${eventId}`).set(
        {
          eventId,
          event,
          razorpayPaymentId:
            payload.payload?.payment?.entity?.id ??
            payload.payload?.refund?.entity?.payment_id ??
            "unknown",
          orderId: payload.payload?.payment?.entity?.notes?.orderId ?? null,
          refundId: payload.payload?.refund?.entity?.id ?? null,
          receivedAt: admin.firestore.FieldValue.serverTimestamp(),
          status: "needs_review",
          reason: "late_delivery_beyond_bound",
          eventAgeDays: ageDays,
        },
        { merge: true }
      );
    } catch (parkErr: any) {
      console.warn(
        "[Razorpay Webhook] late-delivery park write failed (still answering 2xx):",
        parkErr?.message || parkErr
      );
    }
    try {
      // COMPLETE the claim, never delete it: the delivery was seen, signature
      // verified, and parked. Deleting it would make the next redelivery look
      // brand new and park a second time.
      await auditDocRef.set(
        {
          eventId,
          event,
          lateDeliveryAt: Date.now(),
          lateDeliveryParkedAt: Date.now(),
          lateDeliveryParkReason: "late_delivery_beyond_bound",
          completedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    } catch (claimErr: any) {
      console.warn("[Razorpay Webhook] late-delivery claim completion failed:", claimErr?.message || claimErr);
    }
    // 2xx: Razorpay must stop retrying an event we have parked, and a stream of
    // these must never disable the endpoint.
    res.status(200).json({ status: "parked_late_delivery" });
    return;
  }
  if (lateFirstDelivery) {
    console.warn("[Razorpay Webhook] late (but bounded) first delivery — processing", {
      eventId,
      event,
      ageMinutes: Math.floor((eventAgeMs as number) / 60_000),
    });
    try {
      await auditDocRef.set({ lateDeliveryAt: Date.now() }, { merge: true });
    } catch {
      // Evidence is best-effort; the event still processes.
    }
  }

  try {
    if (event === "payment.captured" || event === "order.paid") {
      // Shapes differ: payment.* nests payment.entity, order.paid nests
      // order.entity (which carries no payment id — correlate via notes).
      const paymentEntity =
        event === "order.paid"
          ? payload.payload?.order?.entity
          : payload.payload?.payment?.entity;
      const orderId = paymentEntity?.notes?.orderId;
      const branchId = paymentEntity?.notes?.branchId;
      // payment.* carries the payment id on the entity itself; order.paid
      // nests it under `payments` (either a bare id string or a full payment
      // OBJECT, depending on Razorpay's payload version), then `payment_id`,
      // then the event's own payment.entity. An object entry used to be
      // written verbatim ("[object Object]") into payment.razorpayPaymentId,
      // which breaks refund binding, coin-ledger dedupe, and the
      // failed-attempt guard downstream.
      const firstListedPayment = Array.isArray(paymentEntity?.payments)
        ? paymentEntity.payments[0]
        : undefined;
      const listedPaymentId =
        typeof firstListedPayment === "string"
          ? firstListedPayment
          : typeof firstListedPayment?.id === "string"
          ? firstListedPayment.id
          : undefined;
      const razorpayPaymentId =
        event === "order.paid"
          ? listedPaymentId ||
            (typeof paymentEntity?.payment_id === "string"
              ? paymentEntity.payment_id
              : undefined) ||
            payload.payload?.payment?.entity?.id
          : paymentEntity?.id;

      if (orderId && !isSafeDocId(orderId)) {
        // Fail-closed id shape: crafted notes.orderId values (slashes,
        // empties, overlong) would throw or path-escape at doc() time and
        // 500-retry-storm real money. Park visibly, still 200.
        await captureErrorSnapshot({
          source: "payments",
          severity: "high",
          message: `Webhook ${event} carries an unsafe order id — refusing ghost CONFIRM, parked for review`,
        });
        await db.collection("unmatched_payments").doc(`ump_${eventId}`).set(
          {
            eventId,
            event,
            razorpayPaymentId: razorpayPaymentId || paymentEntity?.id || "unknown",
            amount: paymentEntity?.amount ? paymentEntity.amount / 100 : null,
            currency: paymentEntity?.currency || "INR",
            receivedAt: admin.firestore.FieldValue.serverTimestamp(),
            status: "needs_review",
            reason: "unsafe_order_id",
          },
          { merge: true }
        );
      } else if (!orderId) {
        // Money captured, no order to attach it to (stripped notes, dashboard
        // payment, misconfigured create). The old code acked ok and dropped
        // it — customer shows unpaid, support has nothing to refund against.
        // Park it visibly for ops; still 200 (Razorpay must not retry money).
        const paymentId = razorpayPaymentId || paymentEntity?.id || "unknown";
        await captureErrorSnapshot({
          source: "payments",
          severity: "high",
          message: `Unmatched captured payment ${paymentId} (${event}): no notes.orderId — manual review required`,
        });
        await db.collection("unmatched_payments").doc(`ump_${eventId}`).set(
          {
            eventId,
            event,
            razorpayPaymentId: paymentId,
            amount: paymentEntity?.amount ? paymentEntity.amount / 100 : null,
            currency: paymentEntity?.currency || "INR",
            receivedAt: admin.firestore.FieldValue.serverTimestamp(),
            status: "needs_review",
          },
          { merge: true }
        );
      }

      if (orderId && isSafeDocId(orderId)) {
        // Loop 4: bind BEFORE confirming. Fetch the order first: a typo'd or
        // deleted id must not be resurrected as a partial CONFIRMED doc by the
        // merge-set below, and an under-captured / wrong-order payment must
        // not confirm + fire KOT. Mismatches park visibly; still 200 (money
        // is real — Razorpay must not retry it, ops reconciles).
        const orderRef = db.collection("orders").doc(orderId);
        const orderSnap = await orderRef.get();
        const orderData = (orderSnap.exists ? orderSnap.data() : undefined) as any;
        // Server-stamped `pricing` (createPaymentOrder stamps it at intent
        // time, spec §1) is the primary binding; legacy orders that only
        // carry `totals` still bind instead of silently skipping.
        const storedTotal = Number(
          orderData?.pricing?.grandTotal ?? orderData?.totals?.grandTotal
        );
        let storedPaise =
          Number.isFinite(storedTotal) && storedTotal > 0 ? Math.round(storedTotal * 100) : null;
        const capturedPaise =
          typeof paymentEntity?.amount === "number" ? paymentEntity.amount : null;

        // C03/B8 — an order doc with NO stored total must never be confirmed
        // blind (the old chain simply skipped the amount check and fell
        // through to CONFIRM). The one acceptable fallback is the
        // SERVER-written payment intent, and only when it is sound FOR THIS
        // ORDER:
        //   • order binding  — intent.orderId === the notes.orderId this
        //     signed delivery names (the intent is keyed by the gateway order
        //     id carried on the entity, so the lookup itself is already bound
        //     to this capture);
        //   • ownership binding — the intent's customer must not contradict
        //     the order's owner (customerId, else userId).
        // Anything less (no intent, wrong order, conflicting owner, unusable
        // amount) leaves the amount UNKNOWN: the chain below then parks
        // `confirm_amount_unknown` instead of guessing — never a client
        // amount, never a self-comparison against the captured value.
        let amountSource: "stored" | "intent" | "unknown" = storedPaise !== null ? "stored" : "unknown";
        if (storedPaise === null) {
          const gatewayOrderIdRaw =
            event === "order.paid" ? paymentEntity?.id : paymentEntity?.order_id;
          const gatewayOrderId =
            typeof gatewayOrderIdRaw === "string" && gatewayOrderIdRaw ? gatewayOrderIdRaw : "";
          let intentSound = false;
          if (gatewayOrderId && db && typeof db.collection === "function") {
            try {
              const { loadPaymentIntent } = await import("./razorpay.service");
              const intent = await loadPaymentIntent(gatewayOrderId);
              const rawPaise = Number(intent?.amountPaise);
              const orderBound =
                !!intent && typeof intent.orderId === "string" && intent.orderId === orderId;
              const intentOwner =
                typeof intent?.customerId === "string" ? intent.customerId : "";
              const orderOwner =
                typeof orderData?.customerId === "string" && orderData.customerId
                  ? orderData.customerId
                  : typeof orderData?.userId === "string" && orderData.userId
                    ? orderData.userId
                    : "";
              // A missing owner on either side proves no contradiction; a
              // present-on-both mismatch fails closed (park, never reconcile
              // here — that is an ops decision, not a webhook guess).
              const ownershipBound =
                !intentOwner || !orderOwner || intentOwner === orderOwner;
              if (
                orderBound &&
                ownershipBound &&
                Number.isSafeInteger(rawPaise) &&
                rawPaise > 0
              ) {
                storedPaise = rawPaise;
                amountSource = "intent";
                intentSound = true;
              }
              if (!intentSound) {
                console.warn(
                  `[Razorpay Webhook] ${event}: order ${orderId} has no stored total and no sound server intent (gateway order ${gatewayOrderId}) — amount stays unknown`
                );
              }
            } catch (err: any) {
              // Fail CLOSED: an unreadable intent leaves the amount unknown,
              // which parks below — never a blind confirm on an outage.
              console.warn(
                `[Razorpay Webhook] ${event}: payment-intent lookup failed for order ${orderId} — amount stays unknown:`,
                err?.message || err
              );
            }
          }
        }
        if (!orderSnap.exists) {
          await captureErrorSnapshot({
            source: "payments",
            severity: "high",
            message: `Webhook ${event} names unknown order ${orderId} (payment ${razorpayPaymentId || "unknown"}) — refusing ghost CONFIRM, parked for review`,
            orderId,
            razorpayPaymentId: razorpayPaymentId || undefined,
          });
          await db.collection("unmatched_payments").doc(`ump_${eventId}`).set(
            {
              eventId,
              event,
              razorpayPaymentId: razorpayPaymentId || paymentEntity?.id || "unknown",
              amount: capturedPaise !== null ? capturedPaise / 100 : null,
              currency: paymentEntity?.currency || "INR",
              claimedOrderId: orderId,
              receivedAt: admin.firestore.FieldValue.serverTimestamp(),
              status: "needs_review",
              reason: "confirm_ghost_order",
            },
            { merge: true }
          );
        } else if (paymentEntity?.currency && paymentEntity.currency !== "INR") {
          // INR-only settlement: Route splits, refunds (`reverse_all`), and
          // every ledger on this order are paise-denominated. A non-INR
          // capture (or a tampered currency field) must never flip the order
          // to CONFIRMED or feed the split engine — park it for ops instead.
          // Mirrors verifyPayment's live CURRENCY_MISMATCH refusal; absent
          // currency stays accepted (legacy payloads — our orders.create
          // always stamps INR).
          await captureErrorSnapshot({
            source: "payments",
            severity: "high",
            message: `Webhook ${event} currency mismatch for order ${orderId}: captured in ${paymentEntity.currency} — refusing CONFIRM, parked for review`,
            orderId,
            razorpayPaymentId: razorpayPaymentId || undefined,
          });
          await db.collection("unmatched_payments").doc(`ump_${eventId}`).set(
            {
              eventId,
              event,
              razorpayPaymentId: razorpayPaymentId || paymentEntity?.id || "unknown",
              amount: capturedPaise !== null ? capturedPaise / 100 : null,
              currency: paymentEntity?.currency || null,
              claimedOrderId: orderId,
              receivedAt: admin.firestore.FieldValue.serverTimestamp(),
              status: "needs_review",
              reason: "confirm_currency_mismatch",
            },
            { merge: true }
          );
          await markOrderReconciliation(orderRef, {
            state: "payment_review",
            reason: "confirm_currency_mismatch",
            razorpayPaymentId: razorpayPaymentId || paymentEntity?.id || null,
          });
        } else if (storedPaise !== null && capturedPaise !== null && capturedPaise !== storedPaise) {
          await captureErrorSnapshot({
            source: "payments",
            severity: "high",
            message: `Webhook ${event} amount mismatch for order ${orderId}: captured ${capturedPaise} paise vs priced ${storedPaise} — refusing CONFIRM, parked for review`,
            orderId,
            razorpayPaymentId: razorpayPaymentId || undefined,
          });
          await db.collection("unmatched_payments").doc(`ump_${eventId}`).set(
            {
              eventId,
              event,
              razorpayPaymentId: razorpayPaymentId || paymentEntity?.id || "unknown",
              amount: capturedPaise / 100,
              currency: paymentEntity?.currency || "INR",
              claimedOrderId: orderId,
              expectedAmount: storedPaise / 100,
              receivedAt: admin.firestore.FieldValue.serverTimestamp(),
              status: "needs_review",
              reason: "confirm_amount_mismatch",
            },
            { merge: true }
          );
          await markOrderReconciliation(orderRef, {
            state: "payment_review",
            reason: "confirm_amount_mismatch",
            razorpayPaymentId: razorpayPaymentId || paymentEntity?.id || null,
          });
        } else if (storedPaise === null) {
          // C03/B8 fail-closed park: the order doc carries no server-priced
          // total AND no sound server intent could supply one (fallback
          // above). Confirming anyway would validate the capture against
          // nothing — the blind confirm of a legacy doc this lane exists to
          // remove. The money is real, so the delivery still answers 200
          // (Razorpay must not retry captured money) and ops reconcile from
          // the park doc. No CONFIRM, no split, no coins, no KOT.
          await captureErrorSnapshot({
            source: "payments",
            severity: "high",
            message: `Webhook ${event} amount unknown for order ${orderId}: captured ${
              capturedPaise !== null ? `${capturedPaise} paise` : "an unstated amount"
            } but the order has no stored total and no sound server intent — refusing CONFIRM, parked for review`,
            orderId,
            razorpayPaymentId: razorpayPaymentId || undefined,
          });
          await db.collection("unmatched_payments").doc(`ump_${eventId}`).set(
            {
              eventId,
              event,
              razorpayPaymentId: razorpayPaymentId || paymentEntity?.id || "unknown",
              amount: capturedPaise !== null ? capturedPaise / 100 : null,
              currency: paymentEntity?.currency || "INR",
              claimedOrderId: orderId,
              amountSource,
              receivedAt: admin.firestore.FieldValue.serverTimestamp(),
              status: "needs_review",
              reason: "confirm_amount_unknown",
            },
            { merge: true }
          );
          await markOrderReconciliation(orderRef, {
            state: "payment_review",
            reason: "confirm_amount_unknown",
            razorpayPaymentId: razorpayPaymentId || paymentEntity?.id || null,
          });
        } else {
        // P1-I stale-stock gate — the SAME first-capture gate the client verify
        // channel runs, and for the same reason: the webhook is the
        // authoritative confirm for payers who close the app, so a line the
        // kitchen 86'd between intent and capture was confirmed and pushed to
        // the KOT with no availability check at all. It runs BEFORE the confirm
        // transaction so a compensated (refunded) capture is never written
        // CONFIRMED and never rings the kitchen.
        if (orderData?.couponIntentId) {
          const gateway = event === 'order.paid' ? paymentEntity?.id : paymentEntity?.order_id;
          if (!gateway) throw new Error('Cannot resolve the gateway order of a discounted capture');
          const {commitCouponRedemption} = await import('../coupons/couponAuthority');
          await commitCouponRedemption(orderId,gateway);
        }
        const captureFulfillment = await guardCaptureFulfillment({
          orderRef,
          orderId,
          razorpayPaymentId: String(razorpayPaymentId || paymentEntity?.id || ""),
          razorpayOrderId:
            (event === "order.paid" ? paymentEntity?.id : paymentEntity?.order_id) || null,
          orderData,
          capturedAmountPaise: typeof capturedPaise === "number" ? capturedPaise : undefined,
        });
        if (captureFulfillment.outcome === "pending") {
          // A sibling channel owns the decision and its lease is live. Do NOT
          // confirm (that is the food-plus-refund race). Return a RETRYABLE
          // non-2xx so Razorpay redelivers; the claim is HELD (history kept) so
          // that a redelivery after the 15-minute freshness window is still a
          // recognised retry rather than a "stale forgery".
          await holdEventClaimForRetry(
            eventId,
            auditDocRef,
            provenRetry ? "capture_fulfillment_pending_again" : "capture_fulfillment_pending"
          );
          res.status(503).json({ error: "Fulfilment decision in progress — retry shortly" });
          return;
        }
        if (
          captureFulfillment.outcome === "refunded" ||
          captureFulfillment.outcome === "already_compensated"
        ) {
          // Money is back with the customer; the capture must not be confirmed
          // and must not be rung at the kitchen. 200: Razorpay must not retry
          // money that has already been returned. BOTH arms park the decision,
          // so a suppressed delivery is never a silent 200 with no record.
          await db.collection("unmatched_payments").doc(`ump_${eventId}`).set(
            {
              eventId,
              event,
              razorpayPaymentId: String(razorpayPaymentId || paymentEntity?.id || "unknown"),
              amount: typeof capturedPaise === "number" ? capturedPaise / 100 : null,
              currency: paymentEntity?.currency || "INR",
              claimedOrderId: orderId,
              receivedAt: admin.firestore.FieldValue.serverTimestamp(),
              status:
                captureFulfillment.outcome === "refunded"
                  ? "auto_refunded"
                  : "suppressed_capture_gate",
              reason:
                captureFulfillment.outcome === "refunded"
                  ? "capture_item_unavailable_refunded"
                  : "suppressed_capture_gate",
              ...(captureFulfillment.outcome === "refunded"
                ? { refundId: captureFulfillment.refundId }
                : {}),
            },
            { merge: true }
          );
          res.status(200).json({ status: "captured_unfulfillable" });
          return;
        }
        if (captureFulfillment.outcome === "refund_failed") {
          // Captured money nobody can fulfil and the automatic refund failed.
          // This is NOT a settled outcome and NOT terminal: hold the claim for
          // an immediate retry (the same `unful_` identity replays the stored
          // receipt if the POST actually landed) and ask the provider to
          // redeliver. The scheduled recovery sweep is the path that does not
          // depend on that redelivery ever arriving.
          await db.collection("unmatched_payments").doc(`ump_${eventId}`).set(
            {
              eventId,
              event,
              razorpayPaymentId: String(razorpayPaymentId || paymentEntity?.id || "unknown"),
              amount: typeof capturedPaise === "number" ? capturedPaise / 100 : null,
              currency: paymentEntity?.currency || "INR",
              claimedOrderId: orderId,
              receivedAt: admin.firestore.FieldValue.serverTimestamp(),
              status: "needs_review",
              reason: "capture_item_unavailable_refund_failed",
              detail: captureFulfillment.detail,
            },
            { merge: true }
          );
          await holdEventClaimForRetry(eventId, auditDocRef, "refund_failed");
          res.status(500).json({ error: "Automatic refund failed — retry requested" });
          return;
        }
        // No Grill-Coins gate exists on this channel any more: redemption is
        // refused at intent creation (D31-D33), so a webhook-confirmed order can
        // never carry a coin discount to fund.

        // Atomic confirmation guard (R06): read the current order inside a
        // transaction before (re)writing CONFIRMED. A late/repeated delivery
        // (payment.captured vs order.paid, or a retried verify) must not
        // regress a later/terminal status nor overwrite payment truth already
        // recorded for a different captured payment.
        const WH_CONFIRMED_LATER = new Set([
          "PREPARING",
          // Real KDS/bump vocabulary (orderStatus.ts:48,84). The guard used to
          // list "READY", which no bump writes, so a duplicate payment.captured
          // arriving after a staff bump fell through and regressed the order to
          // CONFIRMED - losing the ready-for-pickup / ready-to-serve truth.
          "READY",
          "READY_FOR_PICKUP",
          "READY_TO_SERVE",
          "OUT_FOR_DELIVERY",
          "IN_TRANSIT",
          "DELIVERED",
          "COMPLETED",
          "PICKED_UP",
          "CANCELLED",
          "REFUNDED",
        ]);
        if (!db || typeof (db as any).runTransaction !== "function") {
          throw new Error("handleRazorpayWebhook requires a transactional datastore");
         }
        // B6/C12: the webhook is the AUTHORITATIVE confirm channel for payers who
        // close the app right after paying, so it must satisfy the SAME delivery
        // OTP invariant the client-verify path does. Before this, a
        // webhook-confirmed delivery order carried no `deliveryOtpHash` at all,
        // and verifyDeliveryOtp threw "No delivery OTP found" for exactly those
        // orders — handover was impossible. Shared implementation: eligible only
        // (delivery / legacy no-orderType), never overwrite an existing hash.
        const { mintDeliveryOtp } = await import("./razorpay.service");
         // F2: the gateway payment's own creation time decides the fee month.
        const gatewayCreatedRaw = Number(paymentEntity?.created_at);
        const gatewayCreatedAtMs =
          Number.isFinite(gatewayCreatedRaw) && gatewayCreatedRaw > 0
            ? Math.round(gatewayCreatedRaw * 1000)
            : undefined;
         // ONLY the provider-confirmed capture instant is authoritative: the
         // signed event's top-level created_at (Razorpay docs
         // /my/webhooks/payments.mdx, "Payment Captured").
         const providerCapturedAt = providerCapturedAtMs(payload);
         const basePayload = {
          // No event type (including order.paid, which has no capture time)
          // may downgrade a capture already confirmed by payment.captured.
          ...(isProviderConfirmedCapture(orderData) || orderData?.settlementCaptureState === "confirmed_manual" ? {} : settlementCaptureStamp(providerCapturedAt)),
          paymentStatus: "completed",
          // CANONICAL nested payment map — the shape the refund.processed
          // branch can QUERY (`payment.razorpayPaymentId`). The dotted literals
          // below are top-level fields whose names merely contain dots; a
          // `where("payment.razorpayPaymentId", …)` never sees them, which is
          // why webhook-confirmed orders also parked their refunds unmatched.
          payment: {
            status: "completed",
            ...(razorpayPaymentId ? { razorpayPaymentId } : {}),
            ...(typeof capturedPaise === "number"
              ? { capturedAmountPaise: capturedPaise }
              : {}),
          },
          "payment.status": "completed",
          // F8: the stream marker survives a suppressed confirm.
          paymentChannel: "razorpay",
          // RECOVERY SCAN STATE: a terminal confirmation means this order is
          // done and must LEAVE the recovery sweep's `fulfillable` lane, so a
          // healthy backlog can never fill the bounded page and starve a later
          // crashed paid order. The nested record stays as the audit trail and
          // the compensation lock.
          captureFulfillmentState: "confirmed",
          ...(typeof gatewayCreatedAtMs === "number"
            ? { "payment.gatewayCreatedAtMs": gatewayCreatedAtMs }
            : {}),
          // order.paid carries no payment id — never write undefined.
          ...(razorpayPaymentId ? { "payment.razorpayPaymentId": razorpayPaymentId } : {}),
          // Live gateway truth in paise for the Route split over-transfer
          // guard and the retry worker's transfer-cap check.
          ...(typeof capturedPaise === "number"
            ? {
                "payment.capturedAmountPaise": capturedPaise,
                // M8 r4: the receipt may claim a capture only with this stamp,
                // written in the same confirm transaction as the amount.
                receiptEvidence: receiptEvidenceStamp("capture", capturedPaise),
              }
            : {}),
          // Canonical object form (see verifyPayment): both apps + triggers
          // accept it; bare-string writes break Delivery tracking.
          status: {
            code: "CONFIRMED",
            label: "Order confirmed",
            kind: "upcoming",
            terminal: false,
          },
          // B5: a successful confirmation RETIRES any earlier reconciliation
          // marker (see razorpay.service.ts) so a resolved park can never leave
          // a confirmed order still telling the payer not to pay again.
          reconciliation: null,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        };
         const gatewayOrderIdRaw =
           event === "order.paid" ? paymentEntity?.id : paymentEntity?.order_id;
         const gatewayOrderId =
           typeof gatewayOrderIdRaw === "string" && gatewayOrderIdRaw ? gatewayOrderIdRaw : null;
         let confirmWritten = false;
         let suppressedReason = null;
         let otpMinted = false;
         const txOutcome = await (db as any).runTransaction(async (tx: any) => {
          const snap = await tx.get(orderRef);
          const fresh = (snap && snap.exists ? snap.data() : {}) || {};
          const statusCode =
            typeof fresh?.status === "string" ? fresh.status : fresh?.status?.code;
          const normalized = String(statusCode || "").toUpperCase();
          const recordedPaymentId =
            fresh?.payment?.razorpayPaymentId ?? fresh?.["payment.razorpayPaymentId"] ?? null;
          const foreignAttempt =
            !!recordedPaymentId && !!razorpayPaymentId && recordedPaymentId !== razorpayPaymentId;
          const laterState =
            WH_CONFIRMED_LATER.has(normalized) ||
            fresh?.status?.terminal === true ||
            fresh?.terminal === true;

          // COMPENSATION LOCK, enforced in the transaction that writes
          // CONFIRMED (mirror of the verify path). Checked BEFORE the
          // later-state guard because a compensated capture stamps payment
          // truth (so the order reads "paid") while its status is still PLACED.
          if (!captureGateAllowsConfirm(fresh, String(razorpayPaymentId || ""))) {
            suppressedReason = "suppressed_capture_gate";
            return {
              written: false,
              reason: suppressedReason,
              recordedPaymentId,
              fresh,
              gateState: fresh?.captureFulfillment?.state ?? null,
            };
          }

          // Preserve a later/terminal status and an already-captured foreign
          // payment instead of regressing the order under a racing confirmation.
          if (laterState || foreignAttempt) {
            suppressedReason = foreignAttempt ? "suppressed_foreign_capture" : "suppressed_later_state";
            return { written: false, reason: suppressedReason, recordedPaymentId, fresh };
          }
          // T3.2 — ATOMIC CAPTURED-PAYMENT CLAIM (gateway-order binding):
          // one captured payment may confirm at most ONE internal order. The
          // per-order foreign-recording guard above cannot see another
          // order's doc; this shared ownership record can. A capture already
          // owned by a DIFFERENT order is suppressed here — before the
          // CONFIRMED write, the OTP mint, the split, the coins and the KOT.
          if (razorpayPaymentId) {
            const captureClaim = await claimCapturedPaymentInTx(tx, db, {
              razorpayPaymentId,
              orderId,
              razorpayOrderId:
                (event === "order.paid" ? paymentEntity?.id : paymentEntity?.order_id) || null,
              amountPaise: typeof capturedPaise === "number" ? capturedPaise : null,
              eventId,
            });
            if (captureClaim.kind === "reused_by_other_order") {
              suppressedReason = "suppressed_reused_capture";
              return {
                written: false,
                reason: suppressedReason,
                recordedPaymentId,
                recordedCaptureOrderId: captureClaim.recordedOrderId,
                fresh,
              };
            }
          }
          // Same transaction as CONFIRMED: mint the delivery OTP hash when the
          // order is eligible and has none. An existing hash is left untouched,
          // so a redelivery (payment.captured vs order.paid) or a verify that
          // already confirmed is idempotent rather than re-minting.
          const mintedOtp = mintDeliveryOtp(fresh, orderRef.id);
          // Keep BOTH storage shapes in lockstep. The app's finalizePaidOrder
          // reads the nested payment object (status + payment id + captured
          // amount); writing only the literal dotted keys leaves it seeing
          // `payment.status: pending` and refuses to finalize a paid order.
          const settledPayment = {
            ...(fresh?.payment && typeof fresh.payment === "object" && !Array.isArray(fresh.payment)
              ? fresh.payment
              : {}),
            status: "completed",
            ...(razorpayPaymentId
              ? { razorpayPaymentId, transactionId: razorpayPaymentId }
              : {}),
            ...(gatewayOrderId ? { razorpayOrderId: gatewayOrderId } : {}),
            ...(typeof capturedPaise === "number"
              ? { capturedAmountPaise: capturedPaise }
              : {}),
            ...(typeof gatewayCreatedAtMs === "number" ? { gatewayCreatedAtMs } : {}),
            verifiedAt: admin.firestore.FieldValue.serverTimestamp(),
          };
          tx.set(
            orderRef,
            {
              ...basePayload,
              payment: settledPayment,
              // F5a: durable settlement lane in the SAME transaction as
              // CONFIRMED, so a crash before the split leaves an order the
              // retry worker can finish.
              ...webhookConfirmSettlementFields(fresh),
              // C11: the POS sync is QUEUED here, never awaited in the request.
              ...webhookConfirmPosSyncFields(fresh),
              ...(mintedOtp ? {
                deliveryOtpHash: mintedOtp.deliveryOtpHash,
                deliveryOtpVersion: mintedOtp.deliveryOtpVersion,
              } : {}),
              // No event type (including order.paid) may downgrade a
              // provider-confirmed capture seen in this transaction.
              ...(isProviderConfirmedCapture(fresh)
                ? {
                    settlementEffectiveAtMs: fresh.settlementEffectiveAtMs,
                    settlementCaptureState: "confirmed",
                    settlementCaptureUnresolved: false,
                  }
                : fresh?.settlementCaptureState === "confirmed_manual"
                ? {
                    settlementEffectiveAtMs: fresh.settlementEffectiveAtMs,
                    settlementCaptureState: "confirmed_manual",
                    settlementCaptureUnresolved: false,
                  }
                : {}),
            },
            { merge: true }
          );
          return { written: true, reason: null, recordedPaymentId, fresh, otpMinted: !!mintedOtp };
         });
         // A signed payment.captured is terminal even when verify/recovery
         // already confirmed the order (written:false). Resolve inside its own
         // transaction with a fresh read so no later writer can downgrade it.
         if (providerCapturedAt && razorpayPaymentId && txOutcome?.reason !== "suppressed_reused_capture") {
           const alert = await db.runTransaction(async tx =>
             repairSettlementCaptureInTx(tx, await tx.get(orderRef), razorpayPaymentId, providerCapturedAt)
           );
           if (alert) await deliverCaptureRecoveryAlert(orderId, alert);
         }
         confirmWritten = !!txOutcome?.written;
         suppressedReason = txOutcome?.reason ?? suppressedReason;
         otpMinted = !!txOutcome?.otpMinted;
         const freshOrder = txOutcome?.fresh || orderData;

        // No branch push here: onOrderCreatedNotificationTrigger already sent
        // the KOT alert when the order doc was created. The old code sent a
        // SECOND push per paid order (this one with a mojibake title) —
        // double chimes for every online payment. (branchId from notes is
        // intentionally unused from here on.)

        // BOTH approved designs hold here:
        // - fr-checkout commits the coupon redemption BEFORE this point, in the
        //   gateway-binding/confirm flow with the resolved gateway order id and
        //   conflict recording (see `couponIntentId` branch above). No second,
        //   best-effort `commitCouponRedemption(orderId)` is added here: that
        //   would re-open the decline/replay hole fr-checkout closed.
        // - fr-settlement retired per-order Razorpay Route. No `executeRouteSplit`
        //   call is restored; payout is the month-end statement. Provider capture
        //   time is stamped in `basePayload` and refunds are handled below.
        if (confirmWritten) {
          // Confirm-time side effects are owned by the coupon commit above and
          // the settlement writer inside the transaction; no Route call here.

        // Grill-Coins capture for this channel already ran BEFORE the confirm
        // (see the P1-H funding gate above), so nothing is left to debit here —
        // the deterministic ledger id makes a verify-channel debit converge.

        // NO POS CALL IN THIS REQUEST (C11 finding 1, Critical). The confirm
        // transaction above queued the sync (`petpoojaStatus` /
        // `petpoojaSyncStatus: "pending_retry"`, see webhookConfirmPosSyncFields)
        // and the existing `retryPetpoojaOrders` worker performs the push with
        // its own lease, backoff and dead-letter lane.
        //
        // The old code awaited `pushOrderToPetpooja` here. Its POST carries a
        // 15 s abort, so any slow outlet held this response far past Razorpay's
        // 5 s budget; the delivery counted as a failure, the retry hit
        // `500 Event is being processed`, and 24 h of that DISABLES the webhook —
        // which silently stops confirming every payer who closed the app.
        //
        // Duplicate KOTs are still impossible: `pushOrderToPetpooja` dedupes on
        // `petpoojaOrderId` / `petpoojaAcceptedNoId` (the acceptance marker is
        // written only by a real push), and the worker's pending_retry lease
        // serialises overlapping ticks. `payment.captured` + `order.paid` for
        // one payment therefore ring the kitchen once, in any arrival order.
        // Customer confirmation is pushed by the order-created trigger, not here.
        } else {
          // P1-C layer 2 — a capture that lands on an order the expiry sweep
          // already CANCELLED (Razorpay cannot close an order, so the window is
          // unavoidable). Parking it left the customer charged for food nobody
          // will cook. The late capture is refunded in FULL through the shared
          // automatic-refund path, idempotently; the order stays CANCELLED.
          // Any other suppressed capture (foreign/staff-cancelled/terminal) is
          // parked only — those are conversations this automation cannot see.
          //
          // The eligibility test reads the TRANSACTION-FRESH snapshot. The
          // pre-transaction `orderData` is stale by design here: the sweep can
          // cancel between that read and this confirmation (that is exactly the
          // race being handled), so deciding on it silently missed the
          // cancellation and acked with neither confirmation nor refund.
          const suppressedStatus = String(freshOrder?.status?.code ?? "").toUpperCase();
          const freshCancellation =
            typeof freshOrder?.cancellationReason === "string"
              ? freshOrder.cancellationReason
              : "";
          const expiryCapture =
            suppressedStatus === "CANCELLED" &&
            freshCancellation === "payment_not_completed" &&
            !!razorpayPaymentId;
          if (expiryCapture) {
            const { refundLateCaptureForExpiredOrder } = await import("./lateCaptureRefund");
            await refundLateCaptureForExpiredOrder({
              orderId,
              razorpayPaymentId: String(razorpayPaymentId),
              razorpayOrderId:
                (event === "order.paid" ? paymentEntity?.id : paymentEntity?.order_id) || null,
              capturedAmountPaise: typeof capturedPaise === "number" ? capturedPaise : null,
              source: "webhook_capture_after_expiry",
            });
          }
          await db.collection("unmatched_payments").doc(`ump_${eventId}`).set(
            {
              eventId,
              event,
              razorpayPaymentId: String(razorpayPaymentId || paymentEntity?.id || "unknown"),
              amount: typeof capturedPaise === "number" ? capturedPaise / 100 : null,
              currency: paymentEntity?.currency || "INR",
              claimedOrderId: orderId,
              receivedAt: admin.firestore.FieldValue.serverTimestamp(),
              status: expiryCapture ? "auto_refunded" : "needs_review",
              reason: expiryCapture
                ? "capture_after_expiry_refunded"
                : suppressedReason || "suppressed_confirmation",
              recordedPaymentId: txOutcome?.recordedPaymentId ?? null,
            },
            { merge: true }
          );
        }
        } // end Loop-4 bound-CONFIRM else (ghost/mismatch parked above)
      }
    } else if (event === "payment.failed") {
      const paymentEntity = payload.payload?.payment?.entity;
      const orderId = paymentEntity?.notes?.orderId;
      const failedPaymentId = typeof paymentEntity?.id === "string" ? paymentEntity.id : null;
      const parkFailed = async (reason: string) => {
        await captureErrorSnapshot({
          source: "payments",
          severity: "high",
          message: `Webhook payment.failed for order ${String(orderId)} — ${reason}, parked for review`,
          razorpayPaymentId: failedPaymentId || undefined,
        }).catch(() => undefined);
        await db.collection("unmatched_payments").doc(`ump_${eventId}`).set(
          {
            eventId,
            event,
            razorpayPaymentId: failedPaymentId || "unknown",
            amount: typeof paymentEntity?.amount === "number" ? paymentEntity.amount / 100 : null,
            currency: paymentEntity?.currency || "INR",
            claimedOrderId: typeof orderId === "string" ? orderId : null,
            receivedAt: admin.firestore.FieldValue.serverTimestamp(),
            status: "needs_review",
            reason,
          },
          { merge: true }
        );
      };

      if (orderId && !isSafeDocId(orderId)) {
        // Crafted notes.orderId (slash, empty, overlong) would throw or
        // path-escape at doc() time and 500-retry-storm the endpoint. Park
        // visibly; still 200.
        await parkFailed("unsafe_order_id");
      } else if (orderId) {
        const orderRef = db.collection("orders").doc(orderId);
        // Transaction (stress sweep 2026-10-24): the confirm path reads and
        // writes money status in ONE transaction, but the failed path read
        // preT-then-wrote plain — a capture landing in the read→write window
        // was silently overwritten by a stale `failed`. The guards below now
        // evaluate against the TRANSACTIONAL snapshot, mirroring the confirm
        // path ("must not regress a later/terminal status").
        const txnOutcome = await (async () => {
          const snap = await db.runTransaction(async (tx) => {
            const fresh = await tx.get(orderRef);
            const orderData = (fresh.exists ? fresh.data() : undefined) as any;
            if (!fresh.exists || !orderData) {
              return { outcome: "unknown" as const, orderData: undefined as any };
            }
            const alreadyPaid =
              orderData.paymentStatus === "completed" ||
              orderData?.payment?.status === "completed";
            const recordedPaymentId =
              orderData.payment?.razorpayPaymentId ??
              orderData["payment.razorpayPaymentId"] ??
              null;
            // Monotonic status guard: a PAID order is never flipped back to
            // failed by a late or replayed failure, and attempt A's failure
            // never fails an order that already carries captured payment B
            // (the pay-fail-retry-pay flow lands in exactly that ordering).
            const foreignAttempt =
              !!recordedPaymentId && !!failedPaymentId && recordedPaymentId !== failedPaymentId;
            if (alreadyPaid || foreignAttempt) {
              console.warn(
                `[Razorpay Webhook] ignored payment.failed for order ${orderId} — ` +
                  `${alreadyPaid ? "order is already paid" : "failure belongs to a different payment attempt"}`
              );
              return { outcome: "ignored" as const, orderData };
            }
            tx.set(
              orderRef,
              {
                paymentStatus: "failed",
                "payment.status": "failed",
                // Keep the nested object the apps read in sync with the
                // literal dotted compatibility fields. A stale nested
                // `pending` makes the payer's order look un-settled.
                payment: {
                  ...(orderData?.payment &&
                  typeof orderData.payment === "object" &&
                  !Array.isArray(orderData.payment)
                    ? orderData.payment
                    : {}),
                  status: "failed",
                  ...(failedPaymentId
                    ? { lastFailedPaymentId: failedPaymentId }
                    : {}),
                  failedAt: admin.firestore.FieldValue.serverTimestamp(),
                },
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              },
              { merge: true }
            );
            return { outcome: "failed" as const, orderData };
          });
          return snap;
        })();

        if (txnOutcome.outcome === "unknown") {
          // Never resurrect a ghost order doc with a merged "failed" write
          // (the mirror image of the confirm-path ghost guard).
          await parkFailed("failed_unknown_order");
        } else if (txnOutcome.outcome === "failed") {
          const orderData = txnOutcome.orderData;
          // M2: a decline is NOT a terminal resolution of the intent. Razorpay
          // leaves the same gateway order payable, so the coupon slot it priced
          // must stay HELD — releasing here let a competing checkout take the
          // last slot and left the successful retry with an uncommittable
          // discount. The slot is released only when the intent is truly done
          // (cancelled order / expired intent), never on a single failed attempt.
          // B5 interaction: if this order still carries a reconciliation
          // marker, an earlier capture was parked and its money may genuinely
          // have moved. The gateway's word about THIS attempt stands (the
          // order flips to failed) and the marker is NOT silently cleared —
          // but a human must see the contradiction instead of one signal
          // quietly outranking the other.
          if (orderData?.reconciliation?.state === "payment_review") {
            await captureErrorSnapshot({
              source: "payments",
              severity: "high",
              message: `Order ${orderId} flipped to failed while a reconciliation marker is still present — an earlier capture on this order may have moved money; review both signals`,
            }).catch(() => undefined);
          }
          // The customer otherwise stares at a spinner: tell them plainly.
          // (Status code is untouched, so no status trigger fires — push here.)
          // Classified `orderUpdates` for the order owner, dispatched after the
          // money transaction committed. Copy carries no order id, name, or
          // amount; `targetId` is the inbox pointer, not tray copy.
          try {
            const recipientUid = orderData?.customerId || orderData?.userId;
            if (recipientUid) {
              await dispatchCustomerAccountNotification({
                purpose: "orderUpdates",
                recipientUid,
                targetId: orderId,
                type: "payment_failed",
                title: "Payment failed",
                body: "Payment for your order did not go through. No money was charged — please try again.",
              });
            }
          } catch {
            // Non-blocking: a push failure never affects the money outcome.
          }
        }
      }
    } else if (event === "transfer.processed" || event === "transfer.failed" || event === "transfer.reversed") {
      const transferEntity = payload.payload?.transfer?.entity;
      const linkedAccount = transferEntity?.recipient;
      if (transferEntity?.id) {
        // Convergent doc id per transfer+event (NOT per Razorpay eventId):
        // the same transfer retried under a new eventId updates one doc
        // instead of forking divergent duplicates.
        await db.collection("route_transfer_events").doc(`rtevt_${transferEntity.id}_${event}`).set(
          {
            eventId,
            event,
            transferId: transferEntity.id,
            recipient: linkedAccount || null,
            amount: transferEntity.amount ? transferEntity.amount / 100 : null,
            status: transferEntity.status || event,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
        if (event === "transfer.failed") {
          await captureErrorSnapshot({
            source: "payments",
            severity: "high",
            message: `Razorpay Route transfer failed: ${transferEntity.id}`,
          });
        }
      }
    } else if (event === "refund.failed") {
      // C11 finding 2 (Critical) — a failed gateway refund must RELEASE what its
      // pending attempt reserved, or the order is wedged for ever: the ledger
      // entry still consumes the refundable cap (400 REFUND_EXCEEDS_REMAINING),
      // `refundStatus: "refund_pending"` + the reserved pending id make the
      // single-in-flight guard answer 409 REFUND_IN_PROGRESS, the operator row
      // stays IN_FLIGHT (the console renders it as a non-actionable UNKNOWN),
      // and a same-request retry hit the "accepted-but-unsettled" shortcut and
      // answered `{status:"pending", reused:true}` without POSTing anything —
      // a success message for money that was never returned.
      //
      // The release (ledger + total + markers + obligation + `refunds/{row}` +
      // `payment_refund_requests/{id}`) runs in ONE transaction in
      // refundFailureRelease.ts, so the money truth and the operator records can
      // never disagree. The request id survives (with an incremented attempt
      // generation) so the operator's retry re-POSTs on a NEW idempotency key —
      // reusing the failed key would replay the gateway's recorded failure.
      const failedEntity = payload.payload?.refund?.entity;
      const failedRefundId = typeof failedEntity?.id === "string" ? failedEntity.id : "";
      const orderIdFromNote = failedEntity?.notes?.orderId;
      const paymentIdFromNote =
        typeof failedEntity?.payment_id === "string" ? failedEntity.payment_id : null;
      const safeNoteOrderId =
        typeof orderIdFromNote === "string" && isSafeDocId(orderIdFromNote)
          ? orderIdFromNote
          : null;
      const gatewayReason =
        (typeof failedEntity?.error_description === "string" && failedEntity.error_description) ||
        (typeof failedEntity?.error_reason === "string" && failedEntity.error_reason) ||
        (typeof failedEntity?.status === "string" ? `gateway status ${failedEntity.status}` : null);

      if (!failedRefundId) {
        // Nothing to address: park it rather than ack a money event silently.
        await db.collection("unmatched_payments").doc(`ump_refund_failed_${eventId}`).set(
          {
            eventId,
            event,
            refundId: null,
            razorpayPaymentId: paymentIdFromNote,
            receivedAt: admin.firestore.FieldValue.serverTimestamp(),
            status: "needs_review",
            reason: "refund_failed_missing_id",
          },
          { merge: true }
        );
        res.status(200).json({ status: "refund_failed_parked" });
        return;
      }

      const release = await releaseFailedRefund({
        refundId: failedRefundId,
        orderId: safeNoteOrderId,
        paymentId: paymentIdFromNote,
        eventId,
        gatewayReason,
      });

      if (release.outcome === "order_not_found" || release.outcome === "unknown_order") {
        // No order to release: park it visibly (the old code silently 200'd
        // with no park doc and no snapshot, so a real failed refund on an
        // unknown/duplicated payment disappeared).
        await captureErrorSnapshot({
          source: "payments",
          severity: "high",
          message:
            `Gateway reported refund ${failedRefundId} as FAILED (${gatewayReason || "no reason given"}) but ` +
            (release.outcome === "unknown_order"
              ? "several orders carry that payment id — "
              : "no order could be resolved — ") +
            "manual review required",
          orderId: safeNoteOrderId || undefined,
          razorpayPaymentId: paymentIdFromNote || undefined,
        }).catch(() => undefined);
        await db.collection("unmatched_payments").doc(`ump_refund_failed_${eventId}`).set(
          {
            eventId,
            event,
            refundId: failedRefundId,
            razorpayPaymentId: paymentIdFromNote,
            claimedOrderId: safeNoteOrderId,
            receivedAt: admin.firestore.FieldValue.serverTimestamp(),
            status: "needs_review",
            reason:
              release.outcome === "unknown_order"
                ? "refund_failed_ambiguous_match"
                : "refund_failed_no_match",
            gatewayReason: gatewayReason || null,
          },
          { merge: true }
        );
        res.status(200).json({ status: "refund_failed_parked" });
        return;
      }

      // Alert + customer message run OUTSIDE the money transaction (the state is
      // already committed; a transport hiccup must not 500 a settled decision).
      const releasedOrder = release.orderId
        ? await db.collection("orders").doc(release.orderId).get().catch(() => null)
        : null;
      await announceFailedRefund(
        release,
        {
          refundId: failedRefundId,
          orderId: safeNoteOrderId,
          paymentId: paymentIdFromNote,
          eventId,
          gatewayReason,
        },
        releasedOrder && releasedOrder.exists ? releasedOrder.data() : null
      );

      res.status(200).json({ status: "refund_failed_released", outcome: release.outcome });
      return;
    } else if (event === "refund.processed") {
      const refundEntity = payload.payload?.refund?.entity;
      const paymentId = refundEntity?.payment_id;
      const refundId = refundEntity?.id;
      const amount = refundEntity?.amount ? refundEntity.amount / 100 : 0;

      // Find order by paymentId across BOTH stored shapes (see
      // findOrdersByCapturedPaymentId — nested canonical plus the legacy
      // dotted-literal field). A missing payment id cannot bind anything and
      // would make a Firestore `where` throw (undefined value) into an endless
      // gateway retry loop, so it is parked visibly instead. More than one
      // match (reused payment intent) is ambiguous — park for review instead
      // of picking an arbitrary doc and stamping the wrong order refunded.
      const missingPaymentId = typeof paymentId !== "string" || !paymentId;
      const matchedOrders = missingPaymentId
        ? []
        : await findOrdersByCapturedPaymentId(paymentId);

      if (missingPaymentId) {
        await captureErrorSnapshot({
          source: "payments",
          severity: "high",
          message: `Processed refund ${refundId} carries no payment_id — cannot bind it to an order; manual review required`,
        });
        await db.collection("unmatched_payments").doc(`ump_refund_${eventId}`).set(
          {
            eventId,
            event,
            refundId: refundId || null,
            amount,
            currency: refundEntity?.currency || "INR",
            receivedAt: admin.firestore.FieldValue.serverTimestamp(),
            status: "needs_review",
            reason: "refund_missing_payment_id",
          },
          { merge: true }
        );
      } else if (matchedOrders.length > 1) {
        await captureErrorSnapshot({
          source: "payments",
          severity: "high",
          message: `Ambiguous processed refund ${refundId} (payment ${paymentId}, amount ${amount}) — ${matchedOrders.length} orders share this payment id; manual review required`,
        });
        await db.collection("unmatched_payments").doc(`ump_refund_${eventId}`).set(
          {
            eventId,
            event,
            razorpayPaymentId: paymentId,
            refundId,
            amount,
            currency: refundEntity?.currency || "INR",
            receivedAt: admin.firestore.FieldValue.serverTimestamp(),
            status: "needs_review",
            reason: "refund_ambiguous_match",
          },
          { merge: true }
        );
      } else if (matchedOrders.length === 1) {
        const orderDoc = matchedOrders[0];
        // Per-refund ledger + monotonic total, computed inside one
        // transaction (compare-and-set). Each gateway refund id is counted
        // EXACTLY ONCE:
        //  - a replay of one refund (same event re-delivered after a stale
        //    claim takeover, or a second event id for the same refund) must
        //    never double-credit refundedTotalPaise;
        //  - SEQUENTIAL partial refunds must all accumulate — the old
        //    max(existing, amount) kept only the largest, understating what
        //    had been returned and inviting a second refund of the rest;
        //  - autoRefund (which POSTs the refund, then records it) and this
        //    webhook converge on the same refund id instead of summing the
        //    same rupees twice.
        const amountPaise = Math.round((Number(amount) || 0) * 100);
        const refundOutcome = await db.runTransaction(async (tx) => {
          // `matchedOrders` comes from the dual-shape lookup and is untyped at
          // the SDK boundary; cast the transaction so the DocumentReference
          // overload is chosen (a bare `any` selects the Query overload and
          // makes `snap` a QuerySnapshot at compile time).
          const snap: any = await (tx as any).get(orderDoc.ref);
          const data = (snap.exists ? snap.data() : {}) as any;
          const existingTotal = Number(data.refundedTotalPaise) || 0;
          let processedMap: Record<string, number> =
            data?.settlementProcessedRefunds && typeof data.settlementProcessedRefunds === "object"
              ? { ...(data.settlementProcessedRefunds as Record<string, number>) }
              : {};
          const ledger: Record<string, number> =
            data.refundLedger &&
            typeof data.refundLedger === "object" &&
            !Array.isArray(data.refundLedger)
              ? { ...(data.refundLedger as Record<string, number>) }
              : {};
          const isNewRefund =
            typeof refundId === "string" && !!refundId && amountPaise > 0 && !(refundId in ledger);
          if (isNewRefund) {
            ledger[refundId] = amountPaise;
          }
          // Promote the processed amount EVEN on a replay (isNewRefund false).
          const gatewayRefundStatus = String(refundEntity?.status || "").toLowerCase();
          if (gatewayRefundStatus === "failed") {
            processedMap = withoutProcessedRefund(processedMap, refundId);
          } else {
            processedMap = processedRefundMap(processedMap, refundId, amountPaise);
          }
          const scalarRefundId =
            typeof data.refundId === "string" && data.refundId.trim() ? data.refundId.trim() : null;
          const scalarRefundPaise =
            typeof data.refundAmount === "number" && Number.isFinite(data.refundAmount)
              ? Math.round(data.refundAmount * 100)
              : 0;
          if (
            scalarRefundId &&
            scalarRefundId !== refundId &&
            scalarRefundPaise > 0 &&
            !(scalarRefundId in ledger)
          ) {
            ledger[scalarRefundId] = scalarRefundPaise;
          }
          const ledgerTotal = Object.values(ledger).reduce(
            (sum, v) => sum + (Number(v) || 0),
            0
          );
          // Monotonic: never move the recorded total downwards (a smaller
          // replayed amount must never mask a larger recorded refund).
          const nextTotal = Math.max(existingTotal, ledgerTotal);
          // Two independent anomalies, both surfaced instead of silently
          // accepted, and neither of which invents a capture or drops money.
          // (1) Over-capture: this refund matched the order BY payment id, so
          // the gateway should never refund more than it captured; when our
          // records disagree the total still moves only UPWARDS (money truth is
          // never rewritten downwards to hide it). (2) Refund with no recorded
          // capture at all: the money is real, but the order we hold still
          // looks unpaid - a contradiction support must see, because the
          // customer would otherwise be shown "unpaid" forever.
          // Capture truth in both storage shapes (B4): the confirm path
          // writes the nested map, merge-set writers the dotted literal.
          const capturedPaise =
            Number(data?.payment?.capturedAmountPaise) ||
            Number(data?.["payment.capturedAmountPaise"]) ||
            0;
          const hasCapture = Number.isFinite(capturedPaise) && capturedPaise > 0;
          const captureRecorded =
            hasCapture ||
            String(data?.paymentStatus || "").toLowerCase() === "completed" ||
            String(data?.["payment.status"] || "").toLowerCase() === "completed";
          const overCapturedPaise =
            hasCapture && nextTotal > capturedPaise ? nextTotal - capturedPaise : 0;
          const refundWithoutCapture = !captureRecorded;
          // A human decision on the obligation (operator reject, superseded
          // withdrawal by the cancel-review queue) is never relabelled by a
          // settlement. Computed from this transaction's fresh read, before any
          // write, so a decision that landed first always wins.
          const priorObligationStatus = String(
            (data?.refundObligation || {}).status || ""
          ).toUpperCase();
          const obligationDecided =
            priorObligationStatus === "REJECTED" || priorObligationStatus === "WITHDRAWN";

          // CORRELATION (contract 4): `data.refundKeyedReceipts[refundId]` is
          // the ONLY trusted binding from a gateway refund id to the refund
          // request that produced it. The refund payload notes carry no request
          // id, a broad unbound row search would relabel another order's money,
          // and the in-flight claim is NOT proof of ownership either: an
          // out-of-band / dashboard refund of the same amount on the same
          // payment can arrive while our POST is still on the wire. When no
          // mapping exists yet (the callback beat our response) this block
          // records the order-level money truth only — the release path owns
          // the request/row closure for that identity, because only IT knows
          // the gateway id the POST actually returned.
          const keyedRequestId =
            typeof data?.refundKeyedReceipts?.[refundId] === "string" &&
            data.refundKeyedReceipts[refundId].trim()
              ? String(data.refundKeyedReceipts[refundId]).trim()
              : "";
          const correlatedRequestId = keyedRequestId;
          const correlatedReqRef =
            correlatedRequestId && isSafeDocId(correlatedRequestId)
              ? db
                  .collection("payment_refund_requests")
                  .doc(refundRequestDocIdFor(orderDoc.id, paymentId, correlatedRequestId))
              : null;
          const correlatedReqSnap = correlatedReqRef ? await (tx as any).get(correlatedReqRef) : null;
          const correlatedReqData =
            correlatedReqSnap && correlatedReqSnap.exists
              ? (correlatedReqSnap.data() as any)
              : null;
          // The request record must PROVE it belongs to this order/payment/
          // request identity AND that any gateway id it already carries is this
          // very refund. A record flushed for a different refund id is a
          // different payment fact and is left alone.
          const correlatedReqTrusted =
            !!correlatedReqData &&
            correlatedReqData.orderId === orderDoc.id &&
            correlatedReqData.paymentId === paymentId &&
            (correlatedReqData.refundRequestId === undefined ||
              correlatedReqData.refundRequestId === correlatedRequestId) &&
            (correlatedReqData.refundId === undefined ||
              correlatedReqData.refundId === null ||
              correlatedReqData.refundId === refundId);

          const rowDocId = correlatedRequestId.replace(/^refundreq_/, "");
          const correlatedRowRef =
            rowDocId && rowDocId !== correlatedRequestId && isSafeDocId(rowDocId)
              ? db.collection("refunds").doc(rowDocId)
              : null;
          const correlatedRowSnap = correlatedRowRef ? await (tx as any).get(correlatedRowRef) : null;
          const correlatedRowData =
            correlatedRowSnap && correlatedRowSnap.exists
              ? (correlatedRowSnap.data() as any)
              : null;
          // Foreign/absent/mismatched rows are NEVER adopted: the row must name
          // this very order, and any gateway refund id it already holds must be
          // this one. The mapping alone is not authority.
          const correlatedRowTrusted =
            !!correlatedRowData &&
            correlatedRowData.orderId === orderDoc.id &&
            (correlatedRowData.gatewayRefundId === undefined ||
              correlatedRowData.gatewayRefundId === null ||
              correlatedRowData.gatewayRefundId === refundId);
          const priorRowStatus = String(correlatedRowData?.status || "").toUpperCase();
          const rowHumanDecided =
            priorRowStatus === "REJECTED" || priorRowStatus === "WITHDRAWN";
          // Contract 4 promotes the operator row for this request once its
          // money is provably settled. "Awaiting settlement" means a MACHINE
          // state: PENDING (not yet claimed) or IN_FLIGHT (claimed, on the
          // wire). A row already COMPLETED belongs to an earlier release and a
          // REJECTED/WITHDRAWN row is a human decision — neither is rewritten.
          const rowAwaitingSettlement =
            priorRowStatus === "IN_FLIGHT" || priorRowStatus === "PENDING";

          // Is the single current pending marker owned by a DIFFERENT gateway
          // refund that is still RESERVED in this order's ledger? Only then
          // must this settlement leave it in place: that is a real, still
          // unsettled refund whose money already occupies the cap. Preserving
          // its ID is not enough — the order-level status words and the
          // obligation must keep saying "still in flight", otherwise the second
          // refund is hidden and the fresh-request guard stops seeing it. A
          // marker pointing at THIS refund (or at an id the ledger never
          // reserved — stale junk from an older writer) is cleared as before.
          const currentPendingId =
            typeof data?.refundPendingGatewayId === "string" && data.refundPendingGatewayId.trim()
              ? data.refundPendingGatewayId.trim()
              : "";
          const otherPendingReservedPaise =
            currentPendingId && currentPendingId !== refundId
              ? Number(ledger[currentPendingId]) || 0
              : 0;
          const keepOtherPendingIdentity = otherPendingReservedPaise > 0;

          const priorObligationMap =
            data?.refundObligation &&
            typeof data.refundObligation === "object" &&
            !Array.isArray(data.refundObligation)
              ? data.refundObligation
              : {};

          await queueRefundCorrectionInTx(tx, orderDoc.id, data, refundId, processedMap);
          tx.set(
            orderDoc.ref,
            {
              // State honesty: BELOW the known capture this is a PARTIAL
              // refund — stamping the terminal "refunded" here both lied to
              // the board and let the refund-claim guard block the designed
              // remainder refund (ALREADY_REFUNDED) after the first partial.
              // Unknown-capture docs keep the legacy "refunded" stamp (the
              // replay tests pin it; nothing downstream can compare totals).
              refundStatus:
                hasCapture && nextTotal < capturedPaise
                  ? "partially_refunded"
                  : "refunded",
              refundId,
              refundAmount: nextTotal / 100,
              refundedTotalPaise: nextTotal,
              refundLedger: ledger,
              settlementProcessedRefunds: processedMap,
              // A refund that was accepted as `pending` becomes final HERE, on
              // the webhook Razorpay documents as the reliable final-status
              // signal. The in-flight markers written by the release path are
              // cleared on the same write, so the console and the customer card
              // stop showing "pending" the moment the gateway says processed.
              // A human REJECTED/WITHDRAWN decision on the obligation is never
              // touched: this only clears the states the machine wrote.
              //
              // ONLY THIS REFUND'S markers are cleared. If the current pending
              // identity points at a DIFFERENT gateway refund that is still
              // reserved on this order, that identity, its reserved amount AND
              // the in-flight status words must survive. This is the existing
              // single current-pending marker, not a new registry.
              ...(keepOtherPendingIdentity
                ? {}
                : {
                    refundPendingSince: admin.firestore.FieldValue.delete(),
                    refundPendingGatewayId: admin.firestore.FieldValue.delete(),
                  }),
              // NESTED MAPS, not dotted keys: `set()` treats a dotted key as a
              // LITERAL field name (dot paths are `update()` syntax), so the old
              // entries created sibling junk fields and left the real
              // `payment.refundStatus` / `refundObligation.status` stale. The
              // fresh maps are carried into the patch so the write lands
              // identically under real Firestore's recursive merge and under a
              // shallow-spread harness.
              payment: {
                ...(data?.payment && typeof data.payment === "object" && !Array.isArray(data.payment)
                  ? data.payment
                  : {}),
                refundStatus: hasCapture && nextTotal < capturedPaise
                  ? "partially_refunded"
                  : "refunded",
              },
              // A DIFFERENT, still-reserved pending refund keeps the order in
              // flight: the settle words above describe THIS refund, and must
              // not hide the other open attempt from readers or from the
              // single-in-flight guard.
              ...(keepOtherPendingIdentity
                ? {
                    refundStatus: "refund_pending",
                    payment: {
                      ...(data?.payment && typeof data.payment === "object" && !Array.isArray(data.payment)
                        ? data.payment
                        : {}),
                      refundStatus: "pending",
                    },
                  }
                : {}),
              refundObligation: keepOtherPendingIdentity
                ? // Another refund is still open: its obligation state stands.
                  priorObligationMap
                : obligationDecided
                  ? {
                      ...priorObligationMap,
                      settledAfterDecision: {
                        gatewayRefundId: refundId,
                        settledAt: admin.firestore.FieldValue.serverTimestamp(),
                      },
                    }
                  : {
                      ...priorObligationMap,
                      status: "SETTLED",
                      settledAt: admin.firestore.FieldValue.serverTimestamp(),
                      settledRefundId: refundId,
                    },
              ...(overCapturedPaise > 0
                ? { refundOverCapturedPaise: overCapturedPaise }
                : {}),
              ...(overCapturedPaise > 0 || refundWithoutCapture
                ? { refundNeedsReview: true }
                : {}),
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
          // F7: the monthly-fee release commits with the refund record.
          applyRefundToMonthlyFee(tx, orderDoc.ref, data, nextTotal);

          // CORRELATED PROMOTION (contract 4). Same transaction as the ledger,
          // so the money truth, the request loop and the operator row can never
          // disagree. Only a record this order provably owns is touched:
          // foreign/absent/mismatched records are left exactly as they were.
          if (correlatedReqRef && correlatedReqData && correlatedReqTrusted) {
            const reqStatus = String(correlatedReqData.status || "").toLowerCase();
            // A record parked for reconciliation is a different, unresolved
            // attempt: settling this refund must not claim it as complete.
            // A record already COMPLETED for this same refund id keeps its own
            // completedAt — a replay is not a second completion.
            const reqAlreadyCompletedThisRefund =
              reqStatus === "completed" && correlatedReqData.refundId === refundId;
            if (reqStatus !== "reconciliation_required" && !reqAlreadyCompletedThisRefund) {
              tx.set(
                correlatedReqRef,
                {
                  status: "completed",
                  refundId,
                  gatewayStatus: "processed",
                  completedAt: Date.now(),
                  updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                },
                { merge: true }
              );
            }
          }
          if (correlatedRowRef && correlatedRowData && correlatedRowTrusted) {
            if (rowHumanDecided) {
              // A human decision stands; the money that moved afterwards is a
              // separate fact recorded BESIDE it, never written over it.
              tx.set(
                correlatedRowRef,
                {
                  refundAfterDecision: {
                    gatewayRefundId: refundId,
                    settledPaise:
                      Number.isFinite(amountPaise) && amountPaise > 0
                        ? amountPaise
                        : Number(correlatedRowData.amountPaise) || null,
                    at: admin.firestore.FieldValue.serverTimestamp(),
                    note: "A refund was processed after this request was already decided — review required.",
                  },
                  updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                },
                { merge: true }
              );
            } else if (rowAwaitingSettlement) {
              // Contract 4 promotes an IN_FLIGHT row. Anything else (already
              // COMPLETED, or an unrecognised state) keeps its own attribution,
              // settled amount and timestamps.
              tx.set(
                correlatedRowRef,
                {
                  status: "COMPLETED",
                  gatewayStatus: "processed",
                  gatewayRefundId: refundId,
                  refundId,
                  settledPaise:
                    Number.isFinite(amountPaise) && amountPaise > 0
                      ? amountPaise
                      : Number(correlatedRowData.amountPaise) || null,
                  processedBy: "server",
                  completedAt: admin.firestore.FieldValue.serverTimestamp(),
                  updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                },
                { merge: true }
              );
            }
          }
          return { isNewRefund, overCapturedPaise, refundWithoutCapture };
        });
        // A refund total above the recorded capture is a money-truth anomaly:
        // surface it for a human rather than accepting it silently. The order
        // doc keeps the monotonic total; this is the alert, not a rewrite.
        if (refundOutcome.overCapturedPaise > 0) {
          await captureErrorSnapshot({
            source: "payments",
            severity: "high",
            message: `Refund total exceeds the recorded capture for order ${orderDoc.id} by ${refundOutcome.overCapturedPaise} paise (payment ${paymentId}) — monotonic truth kept, manual review required`,
          });
        }
        if (refundOutcome.refundWithoutCapture) {
          await captureErrorSnapshot({
            source: "payments",
            severity: "high",
            message: `Refund recorded for order ${orderDoc.id} with no recorded capture (payment ${paymentId}) — the capture is missing on our side; reconcile before treating the order as unpaid`,
          });
        }
        // Customer notice only for a refund we had not recorded yet — a
        // duplicate delivery must not re-announce the same money.
        if (refundOutcome.isNewRefund) {
        try {
          const orderData = orderDoc.data() as any;
          const recipientUid = orderData?.customerId || orderData?.userId;
          // Classified `orderUpdates`, targetId = order id, body carries the
          // amount but never the order id or any name.
          if (recipientUid) {
            await dispatchCustomerAccountNotification({
              purpose: "orderUpdates",
              recipientUid,
              targetId: orderDoc.id,
              type: "refund_processed",
              title: "Refund processed",
              body: `₹${amount} refund for your order is on its way (5–7 business days).`,
            });
          }
        } catch {
          // Non-blocking: a push failure never affects the refund record.
        }
        }
      } else {
        await captureErrorSnapshot({
          source: "payments",
          severity: "high",
          message: `Unmatched processed refund ${refundId} (payment ${paymentId}, amount ${amount}) — no order carries this payment id; manual review required`,
        });
        await db.collection("unmatched_payments").doc(`ump_refund_${eventId}`).set(
          {
            eventId,
            event,
            razorpayPaymentId: paymentId,
            refundId,
            amount,
            currency: refundEntity?.currency || "INR",
            receivedAt: admin.firestore.FieldValue.serverTimestamp(),
            status: "needs_review",
            reason: "refund_no_match",
          },
          { merge: true }
        );
      }
    }

    // Complete the idempotency claim (merge — the claim doc already exists).
    // Refund-only and transfer-only deliveries carry no `payment.entity`, so
    // these two lookups are `undefined` there. Firestore rejects an explicit
    // undefined value, which made the audit write throw AFTER the money event
    // had been handled: the handler answered 500, the claim never completed,
    // and Razorpay retried the same refund forever. Omit absent identifiers.
    const auditedPaymentId = payload.payload?.payment?.entity?.id;
    const auditedOrderId = payload.payload?.payment?.entity?.notes?.orderId;
    await auditDocRef.set(
      {
        eventId,
        event,
        payloadSummary: {
          ...(typeof auditedPaymentId === "string" && auditedPaymentId
            ? { paymentId: auditedPaymentId }
            : {}),
          ...(typeof auditedOrderId === "string" && auditedOrderId
            ? { orderId: auditedOrderId }
            : {}),
        },
        completedAt: admin.firestore.FieldValue.serverTimestamp(),
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    res.status(200).json({ status: "ok" });
  } catch (err: any) {
    await captureErrorSnapshot({
      source: "payments",
      severity: "high",
      message: `Error processing Razorpay webhook event ${event}: ${err.message}`,
      errorStack: err.stack,
    });
    res.status(500).json({ error: "Failed to process webhook" });
  }
}
