import { Request, Response } from "express";
import * as admin from "firebase-admin";
import { db } from "../../core/firebase";
import { config, assertLivePaymentsContext } from "../../config/env";
import { verifyRazorpayWebhookSignature, isSafeDocId } from "../../core/security";
import { captureErrorSnapshot } from "../../core/errors";
import { markOrderReconciliation } from "./reconciliation";
import { pushOrderToPetpooja } from "../petpooja";

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

  // Freshness window: Razorpay stamps top-level `created_at` (Unix seconds).
  // Deliveries older than the window are stale replays — reject. Payloads
  // without the stamp predate this check and stay accepted (the idempotency
  // claim below still dedups them).
  //
  // ORDERING (stress sweep 2026-10-24): the freshness check runs AFTER the
  // idempotency claim so a CRASHED delivery can be recovered by gateway
  // redelivery. Razorpay's retry cadence jumps past the 10–15 min takeover
  // band; a redelivery of a dead claim is by definition a recovery attempt,
  // and the claim doc — not the payload timestamp — is the replay defense.
  // Only a genuinely-NEW claim (no prior attempt) is subject to the
  // freshness reject, and the claim doc is released so a plain rejection
  // leaves no phantom lease behind.
  const auditDocRef = db.collection("payment_audits").doc(`aud_evt_${eventId}`);
  const CLAIM_TTL_MS = 10 * 60 * 1000;
  // Tri-state lease: "new" (we claimed it — process), "done" (a prior
  // attempt completed — 200 ack), "inflight" (a prior attempt claimed
  // recently but never completed: crash or still working — 500 so Razorpay
  // retries. The old code 200-acked inflight claims, and a crash between
  // claim and completion silently dropped real money forever).
  const acquireClaim = async (): Promise<"new" | "takeover" | "done" | "inflight"> => {
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
        // re-stamping a fresh numeric lease, then process. A takeover is a
        // RECOVERY attempt — it is exempt from the payload freshness reject
        // (the caller distinguishes "takeover" from "new").
        if (Date.now() - claimedMs >= CLAIM_TTL_MS) {
          await auditDocRef.set({ claimedAt: Date.now() }, { merge: true });
          return "takeover";
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
  let claim: "new" | "takeover" | "done" | "inflight";
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

  // Freshness window (relocated: claim-first so dead claims stay recoverable —
  // see the ordering note above). Applies ONLY to genuinely-new claims: a
  // takeover already owns a dead lease, and rejecting it would strand real
  // money forever (audit doc carries the evidence, claim released on reject).
  const FRESHNESS_WINDOW_MS = 15 * 60 * 1000;
  const createdAtSec = typeof payload.created_at === "number" ? payload.created_at : null;
  if (
    claim === "new" &&
    createdAtSec !== null &&
    Date.now() - createdAtSec * 1000 > FRESHNESS_WINDOW_MS
  ) {
    console.warn("[Razorpay Webhook] stale event delivery — rejecting", { eventId, event });
    try {
      // Release the just-created claim: a plain rejection must not shadow
      // the event with a phantom lease (no order writes happened).
      await auditDocRef.delete();
    } catch (e) {
      // Best effort — the claim will age out via CLAIM_TTL_MS either way.
      console.warn("[Razorpay Webhook] claim release after stale reject failed:", e);
    }
    res.status(401).json({ error: "Stale webhook event" });
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
         const basePayload = {
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
          // B5: a successful confirmation RETIRES any earlier reconciliation
          // marker (see razorpay.service.ts) so a resolved park can never leave
          // a confirmed order still telling the payer not to pay again.
          reconciliation: null,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        };
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

          // Preserve a later/terminal status and an already-captured foreign
          // payment instead of regressing the order under a racing confirmation.
          if (laterState || foreignAttempt) {
            suppressedReason = foreignAttempt ? "suppressed_foreign_capture" : "suppressed_later_state";
            return { written: false, reason: suppressedReason, recordedPaymentId, fresh };
          }
          // Same transaction as CONFIRMED: mint the delivery OTP hash when the
          // order is eligible and has none. An existing hash is left untouched,
          // so a redelivery (payment.captured vs order.paid) or a verify that
          // already confirmed is idempotent rather than re-minting.
          const mintedOtp = mintDeliveryOtp(fresh);
          tx.set(
            orderRef,
            mintedOtp
              ? { ...basePayload, deliveryOtpHash: mintedOtp.deliveryOtpHash }
              : basePayload,
            { merge: true }
          );
          return { written: true, reason: null, recordedPaymentId, fresh, otpMinted: !!mintedOtp };
         });
         confirmWritten = !!txOutcome?.written;
         suppressedReason = txOutcome?.reason ?? suppressedReason;
         otpMinted = !!txOutcome?.otpMinted;
         const freshOrder = txOutcome?.fresh || orderData;

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
        if (confirmWritten) {
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
        // twice for one paid order. The relayed marker is written only on a
        // successful push, so its presence IS the "already pushed" marker,
        // and a crashed push leaves it absent so a later retry still pushes.
        // TWO accepted shapes: a POS-issued `petpoojaOrderId`, or
        // `petpoojaAcceptedNoId` for an ack whose response omitted the id
        // (which is every ack Petpooja's sandbox sends — the order still
        // registers at the outlet, so it must dedupe too).
        const kotSnap = await db.collection("orders").doc(orderId).get();
        const kotData = kotSnap.exists ? ((kotSnap.data() as any) ?? {}) : {};
        if (kotData.petpoojaOrderId || kotData.petpoojaAcceptedNoId) {
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
        } else {
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
              reason: suppressedReason || "suppressed_confirmation",
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

