import { Request, Response } from "express";
import * as admin from "firebase-admin";
import { db } from "../../core/firebase";
import { config, assertLivePaymentsContext } from "../../config/env";
import { verifyRazorpayWebhookSignature, isSafeDocId } from "../../core/security";
import { captureErrorSnapshot } from "../../core/errors";
import { pushOrderToPetpooja } from "../petpooja";

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
  // Fail-closed idempotency key: a payload without a real Razorpay event id
  // is rejected outright. The old `|| evt_Date.now()` fallback minted a fresh
  // key per delivery, so every Razorpay retry double-fired KOT + status flips.
  const eventId = typeof payload.id === "string" && payload.id.length > 0 ? payload.id : null;
  if (!eventId) {
    console.warn("[Razorpay Webhook] missing payload.id — rejecting (fail-closed, no order write)");
    res.status(401).json({ error: "Missing webhook event id" });
    return;
  }

  // Freshness window: Razorpay stamps top-level `created_at` (Unix seconds).
  // Deliveries older than the window are stale replays — reject. Payloads
  // without the stamp predate this check and stay accepted (the idempotency
  // claim below still dedups them).
  const FRESHNESS_WINDOW_MS = 15 * 60 * 1000;
  const createdAtSec = typeof payload.created_at === "number" ? payload.created_at : null;
  if (createdAtSec !== null && Date.now() - createdAtSec * 1000 > FRESHNESS_WINDOW_MS) {
    console.warn("[Razorpay Webhook] stale event delivery — rejecting", { eventId, event });
    res.status(401).json({ error: "Stale webhook event" });
    return;
  }

  // Idempotency CLAIM (not check-then-act): the old code wrote the audit doc
  // only AFTER the slow FCM + KOT push, so a Razorpay retry landing mid-push
  // re-passed this check and double-pushed the KOT. create() fails when the
  // doc exists, serializing concurrent deliveries; a stale claim (previous
  // attempt died >10 min ago without completing) is taken over.
  const auditDocRef = db.collection("payment_audits").doc(`aud_evt_${eventId}`);
  const CLAIM_TTL_MS = 10 * 60 * 1000;
  // Tri-state lease: "new" (we claimed it — process), "done" (a prior
  // attempt completed — 200 ack), "inflight" (a prior attempt claimed
  // recently but never completed: crash or still working — 500 so Razorpay
  // retries. The old code 200-acked inflight claims, and a crash between
  // claim and completion silently dropped real money forever).
  const acquireClaim = async (): Promise<"new" | "done" | "inflight"> => {
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
        // Stale claim (previous attempt died >10 min ago): take over by
        // re-stamping a fresh numeric lease, then process.
        if (Date.now() - claimedMs >= CLAIM_TTL_MS) {
          await auditDocRef.set({ claimedAt: Date.now() }, { merge: true });
          return "new";
        }
        return "inflight";
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
  let claim: "new" | "done" | "inflight";
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
  if (claim === "inflight") {
    res.status(500).json({ error: "Event is being processed — retry shortly" });
    return;
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
        const storedPaise =
          Number.isFinite(storedTotal) && storedTotal > 0 ? Math.round(storedTotal * 100) : null;
        const capturedPaise =
          typeof paymentEntity?.amount === "number" ? paymentEntity.amount : null;
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
        } else {
        await db.collection("orders").doc(orderId).set(
          {
            paymentStatus: "completed",
            "payment.status": "completed",
            // order.paid carries no payment id — never write undefined.
            ...(razorpayPaymentId ? { "payment.razorpayPaymentId": razorpayPaymentId } : {}),
            // Live gateway truth in paise for the Route split over-transfer
            // guard and the retry worker's transfer-cap check.
            ...(typeof capturedPaise === "number"
              ? { "payment.capturedAmountPaise": capturedPaise }
              : {}),
            // Canonical object form (see verifyPayment): both apps + triggers
            // accept it; bare-string writes break Delivery tracking.
            status: {
              code: "CONFIRMED",
              label: "Order confirmed",
              kind: "upcoming",
              terminal: false,
            },
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );

        // No branch push here: onOrderCreatedNotificationTrigger already sent
        // the KOT alert when the order doc was created. The old code sent a
        // SECOND push per paid order (this one with a mojibake title) —
        // double chimes for every online payment. (branchId from notes is
        // intentionally unused from here on.)

        // Route split (RZ2): the webhook is the AUTHORITATIVE settlement
        // channel — a payer who closes the app right after paying never calls
        // verifyPayment, so without this the franchise branch payout would
        // never execute at all. executeRouteSplit is the same claim-serialized
        // routine verifyPayment uses, so webhook + client verify + `order.paid`
        // duplicates can never double-POST the non-idempotent transfer API.
        // Errors here propagate to a 500 on purpose: Razorpay then retries the
        // delivery instead of letting a real payout silently drop.
        const { executeRouteSplit } = await import("./razorpay.service");
        const splitOutcome = await executeRouteSplit({
          orderRef,
          orderId,
          orderData,
          razorpayPaymentId: String(razorpayPaymentId || paymentEntity?.id || ""),
          capturedAmountPaise: typeof capturedPaise === "number" ? capturedPaise : undefined,
        });
        if (splitOutcome.state === "busy") {
          // Another actor (client verify / retry worker) owns the payout and
          // will finish it — ack this delivery instead of double-POSTing.
          console.warn(
            `[Razorpay Webhook] Route split already in flight for order ${orderId} — acking without a second POST`
          );
        } else if (splitOutcome.state === "flagged") {
          console.warn(
            `[Razorpay Webhook] Route split flagged for order ${orderId}: ${splitOutcome.error}`
          );
        }

        // Loop 63/120: confirm-time Grill-Coins debit. Trusted intent only
        // (Razorpay order id → server-written intent) — never the client
        // order doc. Best-effort after confirm: money is captured, so a
        // debit failure parks a high-severity snapshot for manual remedy
        // (adjustCustomerCoins) instead of failing the confirmation.
        // Webhook retries converge via the deterministic ledger id.
        try {
          const rzpOrderId =
            typeof paymentEntity?.order_id === "string" ? paymentEntity.order_id : "";
          const { resolveIntentRedemption } = await import("./razorpay.service");
          const redemption = rzpOrderId ? await resolveIntentRedemption(rzpOrderId) : null;
          if (redemption) {
            const { debitRedeemedCoins } = await import("../customers/customerCoins");
            await debitRedeemedCoins({ ...redemption, orderId, razorpayOrderId: rzpOrderId });
          }
        } catch (err: any) {
          console.warn(
            `[Razorpay Webhook] confirm-time coin debit failed for order ${orderId}:`,
            err?.message || err
          );
          await captureErrorSnapshot({
            source: "payments",
            severity: "high",
            message: `Confirm-time Grill-Coins debit failed for order ${orderId} — remediate via adjustCustomerCoins`,
            orderId,
            errorStack: err?.stack,
          });
        }

        // Auto-push KOT to Petpooja POS upon payment confirmation.
        // pushOrderToPetpooja returns false (not throw) on POS rejection —
        // ignoring the return hid outstanding POS syncs behind a 200 ok.
        //
        // Duplicate-capture guard: `payment.captured` AND `order.paid` are
        // both delivered for one payment under DIFFERENT event ids, so the
        // event-id claim above cannot dedupe them — the kitchen would ring
        // twice for one paid order. petpoojaOrderId is only written on a
        // successful push, so its presence IS the "already pushed" marker,
        // and a crashed push leaves it absent so a later retry still pushes.
        const kotSnap = await db.collection("orders").doc(orderId).get();
        if (kotSnap.exists && (kotSnap.data() as any)?.petpoojaOrderId) {
          console.warn(
            `[Razorpay Webhook] KOT already pushed for order ${orderId} — skipping duplicate push`
          );
        } else {
        try {
          const pushed = await pushOrderToPetpooja(orderId);
          if (!pushed) {
            console.warn(
              `[Razorpay Webhook] KOT push pending_retry for order ${orderId} — POS sync outstanding, retry worker owns it`
            );
          }
        } catch (err) {
          console.warn(`[Razorpay Webhook] KOT push queued for order ${orderId}:`, (err as any)?.message || err);
        }
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
        const orderSnap = await orderRef.get();
        const orderData = (orderSnap.exists ? orderSnap.data() : undefined) as any;
        if (!orderSnap.exists || !orderData) {
          // Never resurrect a ghost order doc with a merged "failed" write
          // (the mirror image of the confirm-path ghost guard).
          await parkFailed("failed_unknown_order");
        } else {
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
          } else {
            await orderRef.set(
              {
                paymentStatus: "failed",
                "payment.status": "failed",
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              },
              { merge: true }
            );
            // The customer otherwise stares at a spinner: tell them plainly.
            // (Status code is untouched, so no status trigger fires — push here.)
            try {
              const { pushToCustomer } = await import("../notifications/fcmClient");
              await pushToCustomer(
                orderData?.customerId || orderData?.userId,
                "⚠️ Payment failed",
                `Payment for order #${orderId.substring(0, 6)} did not go through. No money was charged — please try again.`,
                { type: "payment_failed", orderId }
              );
            } catch {
              // Non-blocking (see pushToCustomer).
            }
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
    } else if (event === "refund.processed") {
      const refundEntity = payload.payload?.refund?.entity;
      const paymentId = refundEntity?.payment_id;
      const refundId = refundEntity?.id;
      const amount = refundEntity?.amount ? refundEntity.amount / 100 : 0;

      // Find order by paymentId. More than one match (reused payment
      // intent) is ambiguous — park for review instead of picking an
      // arbitrary doc and stamping the wrong order refunded.
      const ordersSnap = await db
        .collection("orders")
        .where("payment.razorpayPaymentId", "==", paymentId)
        .limit(2)
        .get();

      if (ordersSnap.size > 1) {
        await captureErrorSnapshot({
          source: "payments",
          severity: "high",
          message: `Ambiguous processed refund ${refundId} (payment ${paymentId}, amount ${amount}) — ${ordersSnap.size} orders share this payment id; manual review required`,
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
      } else if (!ordersSnap.empty) {
        const orderDoc = ordersSnap.docs[0];
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
        const refundNewlyRecorded = await db.runTransaction(async (tx) => {
          const snap = await tx.get(orderDoc.ref);
          const data = (snap.exists ? snap.data() : {}) as any;
          const existingTotal = Number(data.refundedTotalPaise) || 0;
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
          const ledgerTotal = Object.values(ledger).reduce(
            (sum, v) => sum + (Number(v) || 0),
            0
          );
          // Monotonic: never move the recorded total downwards (a smaller
          // replayed amount must never mask a larger recorded refund).
          const nextTotal = Math.max(existingTotal, ledgerTotal);
          tx.set(
            orderDoc.ref,
            {
              refundStatus: "refunded",
              refundId,
              refundAmount: nextTotal / 100,
              refundedTotalPaise: nextTotal,
              refundLedger: ledger,
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
          return isNewRefund;
        });
        // Customer notice only for a refund we had not recorded yet — a
        // duplicate delivery must not re-announce the same money.
        if (refundNewlyRecorded) {
        try {
          const orderData = orderDoc.data() as any;
          const { pushToCustomer } = await import("../notifications/fcmClient");
          await pushToCustomer(
            orderData?.customerId || orderData?.userId,
            "↩️ Refund processed",
            `₹${amount} refund for order #${orderDoc.id.substring(0, 6)} is on its way (5–7 business days).`,
            { type: "refund_processed", orderId: orderDoc.id }
          );
        } catch {
          // Non-blocking (see pushToCustomer).
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
    await auditDocRef.set(
      {
        eventId,
        event,
        payloadSummary: {
          paymentId: payload.payload?.payment?.entity?.id,
          orderId: payload.payload?.payment?.entity?.notes?.orderId,
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

