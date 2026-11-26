import { onDocumentUpdated, onDocumentCreated } from "firebase-functions/v2/firestore";
import { db } from "../../core/firebase";
import { buildKotAlertMessage, buildCustomerOrderUpdateMessage, buildTicketAlertMessage, buildRefundReviewAlertMessage } from "./templates";
import { sendFcmMessage, sendMulticastFcm } from "./fcmClient";
import { TRUSTED_SERVER_ACTOR } from "./sendGate";
import { captureErrorSnapshot } from "../../core/errors";
import { pushKotForCashOrderOnAccept, pushKotForServerCashOrderOnCreate } from "../petpooja/orderPush";
import { PetpoojaDisabledError } from "../petpooja/client";
import {
  ensureCancelledPaidRefundObligation,
  claimRefundReviewAlert,
  settleRefundReviewAlert,
  planCancelRefundObligation,
} from "../orders/cancelRefundObligation";
import { hasServerPaymentChannel, requiresServerCaptureForKitchen } from "../orders/paymentGate";
import { claimAdmissionNotice, isNotifiableCustomer, releaseAdmissionNotice } from "./admission";

const REGION = "asia-south1";

/**
 * The ONLY fields this module writes for its own bookkeeping. An update whose
 * diff is confined to these is a self-write and must not re-enter reconcile.
 *
 * `payment.refundStatus` is deliberately NOT here: autoRefund and the
 * refund.processed webhook settle money by stamping exactly that field, and
 * filtering it would skip a genuine settle. A `refundStatus`-only change is
 * therefore a REAL event (it reconciles and may withdraw our row); the loop
 * protection comes from the obligation marker and from the queue being
 * idempotent, not from ignoring settlement.
 */
const REFUND_OBLIGATION_SELF_WRITE_KEYS = new Set(["refundObligation"]);

/**
 * True only when every changed key is one this module provably wrote as its
 * own queue marker. Anything else — a capture, a settlement stamp, a staff
 * action — is a genuine event and reconciles.
 */
function isRefundObligationSelfWrite(before: any, after: any): boolean {
  const a = before || {};
  const b = after || {};
  const touched = new Set<string>([...Object.keys(a), ...Object.keys(b)]);
  let sawSelfKey = false;
  for (const key of touched) {
    const av = a[key];
    const bv = b[key];
    if (JSON.stringify(av) === JSON.stringify(bv)) continue;
    if (REFUND_OBLIGATION_SELF_WRITE_KEYS.has(key)) {
      sawSelfKey = true;
      continue;
    }
    return false;
  }
  return sawSelfKey;
}

/** Kitchen admission, reusing the ONE predicate the rest of the system uses. */
function kitchenAdmitted(order: any): boolean {
  // `requiresServerCaptureForKitchen` names the LANE (an online order needs a
  // capture; cash/walk-in do not). The capture marker is what then admits an
  // online order — the same two-step `assertKitchenAdmissionPaid` performs.
  return !requiresServerCaptureForKitchen(order) || hasServerPaymentChannel(order);
}

function orderLabelOf(order: any, orderId: string): string {
  return order.shortCode || order.orderNumber || orderId.substring(0, 6).toUpperCase();
}

/**
 * A2 #1 (preprod audit cycle 11): the ONLY place an order is announced — the
 * kitchen chime and the customer's "Order Confirmed!" — behind the same
 * admission predicate that gates the kitchen everywhere else, and behind an
 * exactly-once receipt so a redelivered Firestore event (or a direct retry of
 * the status handler) cannot double-chime.
 *
 * Called from two places:
 *   - creation: a server cash order / walk-in counter sale is admitted at birth;
 *     an online draft is NOT (it exists before Razorpay opens);
 *   - status change: the moment a capture turns a draft into an admitted order.
 */
async function announceAdmittedOrder(
  orderId: string,
  order: any,
  source: "create" | "capture"
): Promise<void> {
  if (!kitchenAdmitted(order)) return;

  const branchId = order.branchId || order.store?.id;
  if (!branchId) {
    console.warn(`[onOrderAdmission] Order ${orderId} has no branchId`);
    return;
  }

  // --- Kitchen acoustic KOT chime -------------------------------------------
  if (await claimAdmissionNotice(orderId, "kitchen_kot", { branchId, source })) {
    try {
      const kotMessage = buildKotAlertMessage(branchId, {
        id: orderId,
        orderNumber: orderLabelOf(order, orderId),
        fulfillmentType: order.fulfillment || order.fulfillmentType || "DELIVERY",
        totalAmount: order.totals?.grandTotal || order.pricing?.grandTotal || order.total || 0,
        tableNumber: order.tableNumber,
      });

      const sent = await sendFcmMessage(kotMessage, {
        purpose: "operational",
        actor: TRUSTED_SERVER_ACTOR,
        critical: true,
      });
      if (sent) {
        console.log(`[onOrderAdmission] Dispatched acoustic KOT alert to branch_${branchId}_orders`);
      } else {
        // Loop 5: kitchen got no acoustic alert — snapshot so ops can
        // investigate / re-push; never pretend the chime went out.
        await captureErrorSnapshot({
          source: "notifications",
          severity: "high",
          message: `KOT push for order ${orderId} returned false (no transport or mock) — kitchen may be silent`,
          orderId,
          branchId,
        });
      }
    } catch (err: any) {
      // The chime did NOT go out: release the receipt so a retry is still owed.
      await releaseAdmissionNotice(orderId, "kitchen_kot");
      console.error("[onOrderAdmission] Failed to dispatch KOT notification:", err?.message || err);
      await captureErrorSnapshot({
        source: "notifications",
        severity: "high",
        message: `KOT push notification failed for order ${orderId} — kitchen may be blind`,
        orderId,
        branchId,
        errorStack: err?.stack,
      });
    }
  }

  // --- Customer admission confirmation -------------------------------------
  // Only the admission copy ("we have your order, track it live"). Every later
  // status has its own dedicated push below, so a PREPARING bump must never be
  // relabelled "Order Confirmed!".
  const statusCode = String(
    typeof order.status === "object" ? order.status?.code : order.status
  ).toUpperCase();
  if (statusCode !== "PLACED" && statusCode !== "CONFIRMED") return;

  // B5-S1: only backend-backed copy leaves this path (eta/partner from the doc;
  // veg/refund flags only when the doc actually carries them).
  const customerId = order.customerId || order.userId || order.customer?.id;
  // Walk-in counter sales have no customer account: `users/cust_walkin` is not a
  // person, and the inbox row it produced was unreadable by anyone.
  if (!isNotifiableCustomer(customerId)) return;

  if (!(await claimAdmissionNotice(orderId, "customer_confirmed", { customerId }))) return;

  try {
    if (typeof db.collection === "function") {
      const userDoc = await db.collection("users").doc(customerId).get();
      const fcmTokens: string[] = userDoc.data()?.fcmTokens || [];
      const confirmMessage = buildCustomerOrderUpdateMessage(
        fcmTokens[0] || "",
        {
          id: orderId,
          orderNumber: orderLabelOf(order, orderId),
          fulfillmentType: order.fulfillment || order.fulfillmentType || "delivery",
          storeName: order.store?.name || "Burgonomics",
          etaMinutes: order.etaMinutes,
          deliveryPartnerName: order.deliveryPartner?.name,
          allVeg: order.allVeg === true ? true : undefined,
          refundInitiated: order.refundStatus === "refunded" || order.refundStatus === "INITIATED" ? true : undefined,
          paymentMethod: order.payment?.method,
        },
        statusCode || "PLACED"
      );
      // Zero tokens is not a reason to lose the message: the shared sender
      // persists the inbox row first, then no transport call happens.
      await sendMulticastFcm(
        fcmTokens,
        {
          notification: confirmMessage.notification,
          data: confirmMessage.data,
          android: confirmMessage.android,
          apns: confirmMessage.apns,
        },
        customerId,
        { purpose: "orderUpdates", actor: TRUSTED_SERVER_ACTOR, critical: true }
      );
    }
  } catch (err: any) {
    // Give the claim back so a retry can deliver it WITHOUT re-ringing the
    // kitchen (the kitchen receipt is a separate, already-claimed document).
    await releaseAdmissionNotice(orderId, "customer_confirmed");
    console.error("[onOrderAdmission] Failed to dispatch customer confirmation:", err?.message || err);
    await captureErrorSnapshot({
      source: "notifications",
      severity: "medium",
      message: `customer order-confirmation push failed for order ${orderId} — customer silent; check user fcmTokens then re-push from the order page`,
      orderId,
      branchId,
      customerId,
      errorStack: err?.stack,
    });
  }
}

/**
 * Trigger: Fires when an order is first created in Firestore.
 *
 * A2 #1 (preprod audit cycle 11): NOT every order is announced here. The online
 * checkout draft is created before Razorpay opens, so chiming the kitchen and
 * telling the customer "Order Confirmed!" for it fired the one signal that means
 * "food is coming" on every abandoned payment. Admission is decided by
 * `requiresServerCaptureForKitchen` (server cash marker or the walk-in counter
 * stream); an online order is announced when its capture lands (see the
 * status-change handler below).
 */
export const onOrderCreatedNotificationTrigger = onDocumentCreated(
  {
    region: REGION,
    document: "orders/{orderId}",
  },
  async (event) => {
    const snap = event.data;
    if (!snap) return;

    const order = snap.data();
    const orderId = event.params.orderId;
    const branchId = order.branchId || order.store?.id;

    await announceAdmittedOrder(orderId, order, "create");

    // Owner decision 2026-11-20: a COD order the SERVER created goes to the
    // kitchen NOW. Strictly last and in its own try/catch, exactly like the
    // staff-acceptance cash KOT below: a POS rejection or timeout can never
    // fail the create event (which would replay the whole trigger).
    try {
      const pushed = await pushKotForServerCashOrderOnCreate(orderId, order);
      if (pushed === false) {
        await captureErrorSnapshot({
          source: "petpooja",
          severity: "high",
          message: `COD order ${orderId} was not accepted by the POS — kitchen may not have the ticket`,
          orderId,
          branchId,
        });
      }
    } catch (err: any) {
      // An intentionally disabled POS bridge is not a kitchen failure: the
      // order still reached the KDS, and the bridge resumes when re-enabled.
      // Every OTHER fault is a real "the kitchen may be blind" alert.
      if (err instanceof PetpoojaDisabledError) {
        console.log(`[onOrderCreatedTrigger] COD KOT deferred — POS bridge disabled for ${orderId}`);
      } else {
        console.error("[onOrderCreatedTrigger] COD KOT push failed:", err?.message || err);
        await captureErrorSnapshot({
          source: "petpooja",
          severity: "high",
          message: `COD KOT push failed for order ${orderId} — kitchen may be blind`,
          orderId,
          branchId,
          errorStack: err?.stack,
        });
      }
    }
  }
);

/**
 * Order status-change side effects, in order:
 *   1. customer status notification (unchanged),
 *   2. CASH-KOT push for a staff-accepted cash / pay-at-store order.
 *
 * The KOT push runs LAST, in its own try/catch: a POS rejection or the 15s
 * POS timeout can never block the customer notification nor fail/reject the
 * trigger (a rejected Firestore trigger is retried, replaying every effect).
 *
 * Exported so the transition gate can be exercised without a trigger harness.
 */
export async function handleOrderStatusChanged(
  orderId: string,
  before: any,
  after: any
): Promise<void> {
  const beforeStatusCode =
    typeof before.status === "object" ? before.status?.code : before.status;
  const afterStatusCode =
    typeof after.status === "object" ? after.status?.code : after.status;

  const isCancelled = String(afterStatusCode || "").toUpperCase() === "CANCELLED";

  // A write this module itself made (obligation marker / alert claim) must
  // never re-enter the reconcile below — that is the loop that produced
  // unbounded timestamp writes. Genuine CANCELLED→CANCELLED updates (a capture
  // landing after the cancel, a refund settling) are NOT self-writes and DO
  // reconcile; only notifications stay behind the status-delta gate.
  if (isCancelled && isRefundObligationSelfWrite(before, after)) {
    return;
  }

  // Cancelled-order refund obligation: a server-confirmed Razorpay capture on
  // a cancelled order owes a refund REVIEW, never an automatic refund. This
  // runs BEFORE the status-delta gate so a capture that lands after the
  // cancellation, and the retry after a failed queue write, both reconcile on
  // the next genuine order update. It also runs before the customer push so
  // that copy can honestly say the refund is awaiting review.
  //
  // Bounded retry, honestly: the retry trigger is a LATER GENUINE UPDATE of
  // the order. There is no self-scheduled retry and no timer here — if the
  // order is never touched again, the queue-failure snapshot is the operator
  // path (documented residual, not a promise).
  let refundReview: {
    created: boolean;
    amountPaise?: number;
    pendingRefundId?: string;
    refundedPaise?: number;
  } = { created: false };
  if (isCancelled) {
    try {
      const outcome = await ensureCancelledPaidRefundObligation({
        orderId,
        after,
        reason: after.cancellationReason || "ORDER_CANCELLED_AFTER_PAYMENT",
      });
      refundReview = {
        created: outcome.created,
        amountPaise: outcome.reviewAmountPaise ?? outcome.amountPaise,
        pendingRefundId: outcome.pendingRefundId,
        refundedPaise: planCancelRefundObligation(after).refundedPaise,
      };
    } catch (err: any) {
      // The helper is total (it reports queue_failed); this is belt-and-braces
      // so a refund-obligation fault can never fail/replay the whole trigger.
      console.error(
        `[onOrderStatusChangedTrigger] Refund obligation failed for ${orderId}:`,
        err?.message || err
      );
      await captureErrorSnapshot({
        source: "payments",
        severity: "high",
        message: `Cancelled PAID order ${orderId} refund obligation threw — refund is owed and must be queued manually`,
        orderId,
        errorStack: err?.stack,
      }).catch(() => undefined);
    }

    // Claim on the REFUND ROW, not the immutable event. Acknowledged delivery
    // dedupes ordinary replay; bounded retries after an ambiguous send or failed
    // settlement can still duplicate the alert. No exactly-once guarantee.
    const branchId = after.branchId || after.store?.id;
    if (refundReview.pendingRefundId && branchId) {
      const claim = await claimRefundReviewAlert({ refundId: refundReview.pendingRefundId });
      if (claim.claimed && claim.token) {
        let delivered = false;
        let failure = "";
        try {
          delivered = await sendFcmMessage(
            buildRefundReviewAlertMessage(branchId, {
              orderId,
              orderNumber:
                after.shortCode || after.orderNumber || orderId.substring(0, 6).toUpperCase(),
              // The ROW's amount at claim time is authoritative — the event
              // snapshot can be stale after a partial refund re-cut the row.
              amountPaise: claim.amountPaise ?? refundReview.amountPaise ?? 0,
            }),
            { purpose: "operational", actor: TRUSTED_SERVER_ACTOR, critical: false }
          );
          if (!delivered) failure = "transport returned false";
        } catch (err: any) {
          failure = err?.message || String(err);
        }
        await settleRefundReviewAlert({
          refundId: refundReview.pendingRefundId,
          token: claim.token,
          delivered,
          error: failure,
        });
        if (!delivered) {
          // Observable, not silent: the queue row is durable and the claim is
          // released for a later retry.
          await captureErrorSnapshot({
            source: "notifications",
            severity: "medium",
            message: `Refund review alert for order ${orderId} was not delivered — refund queue row exists, staff may be unaware`,
            orderId,
            branchId,
          }).catch(() => undefined);
        }
      }
    }
  }

  // Strict state-delta check: notifications only fire on a real transition.
  if (beforeStatusCode === afterStatusCode) {
    return;
  }

  console.log(
    `[onOrderStatusChangedTrigger] Order ${orderId} status changed: ${beforeStatusCode} -> ${afterStatusCode}`
  );

  const customerId = after.customerId || after.userId || after.customer?.id;

  // A2 #1 (preprod audit cycle 11): the CAPTURE is the admission event for an
  // online order. Before it, the document is a pre-payment draft and nobody was
  // told about it (the creation trigger is gated on the same predicate); the
  // moment the server marker lands, the kitchen is chimed and the customer gets
  // the admission confirmation — exactly once, through the same claim receipt.
  // The generic status push below is skipped for this ONE transition so a
  // captured order is not confirmed twice.
  const admitsNow = !kitchenAdmitted(before) && kitchenAdmitted(after);
  if (admitsNow) {
    await announceAdmittedOrder(orderId, after, "capture");
    return;
  }

  if (isNotifiableCustomer(customerId)) {

    try {
      // Fetch customer FCM tokens if Firestore db is available
      if (typeof db.collection === "function") {
        const userDoc = await db.collection("users").doc(customerId).get();
        const userData = userDoc.data();
        const fcmTokens: string[] = userData?.fcmTokens || [];

        const sampleToken = fcmTokens[0] || "";
        const updateMessage = buildCustomerOrderUpdateMessage(
          sampleToken,
          {
            id: orderId,
            orderNumber:
              after.shortCode || after.orderNumber || orderId.substring(0, 6).toUpperCase(),
            fulfillmentType: after.fulfillment || after.fulfillmentType || "delivery",
            storeName: after.store?.name || "Burgonomics",
            etaMinutes: after.etaMinutes || after.deliveryPartner?.etaMinutes,
            deliveryPartnerName: after.deliveryPartner?.name,
            allVeg: after.allVeg === true ? true : undefined,
            refundInitiated:
              after.refundStatus === "refunded" || after.refundStatus === "INITIATED"
                ? true
                : undefined,
            paymentMethod: after.payment?.method,
            // Copy honesty for cancels: a captured payment is "money recorded",
            // never "no money charged"; a queued row means the refund awaits
            // review (it is NOT initiated — nothing moved yet).
            paymentCaptured: hasServerPaymentChannel(after) && String(afterStatusCode || "").toUpperCase() === "CANCELLED",
            refundAwaitingReview: refundReview.pendingRefundId !== undefined,
            // Truthful partial copy: money already returned is never described
            // as "nothing refunded yet".
            partiallyRefundedPaise: refundReview.refundedPaise || undefined,
          },
          afterStatusCode
        );

        // Inbox persistence happens before FCM inside the shared sender, so a
        // customer with no registered token still receives the update in-app.
        await sendMulticastFcm(
          fcmTokens,
          {
            notification: updateMessage.notification,
            data: updateMessage.data,
            android: updateMessage.android,
            apns: updateMessage.apns,
          },
          customerId,
          { purpose: "orderUpdates", actor: TRUSTED_SERVER_ACTOR, critical: true }
        );
      }
    } catch (err: any) {
      // Never interpolate raw customerId into log text (PII boundary).
      console.error("[onOrderStatusChangedTrigger] Error sending status push:", err?.message || err);
      await captureErrorSnapshot({
        source: "notifications",
        severity: "medium",
        message: `status push failed for order ${orderId}`,
        orderId,
        customerId,
        errorStack: err?.stack,
      });
    }
  }

  // CASH-KOT: the first staff departure from PLACED (the "Accept KOT (Start
  // Prep)" bump, or a direct move to READY) is the gate for cash /
  // pay-at-store orders (never creation — `payment.method` is client-written,
  // so a creation push could print an unpaid ticket on demand). Cancelled and
  // terminal transitions send nothing. Same idempotent
  // push as the capture webhook/retry worker, so a redelivered update event
  // finds the dedupe marker and does not ring the kitchen twice.
  try {
    const pushed = await pushKotForCashOrderOnAccept(orderId, before, after);
    if (pushed === false) {
      console.warn(
        `[onOrderStatusChangedTrigger] Cash-order KOT for ${orderId} is pending_retry — POS sync outstanding, retry worker owns it`
      );
    }
  } catch (err: any) {
    console.warn(
      `[onOrderStatusChangedTrigger] Cash-order KOT push failed for ${orderId}:`,
      err?.message || err
    );
  }
}

/**
 * Trigger: Fires when an existing order document is updated in Firestore.
 * Applies strict state-delta checks to prevent duplicate push loops.
 */
export const onOrderStatusChangedNotificationTrigger = onDocumentUpdated(
  {
    region: REGION,
    document: "orders/{orderId}",
  },
  async (event) => {
    const change = event.data;
    if (!change) return;
    await handleOrderStatusChanged(
      event.params.orderId,
      change.before.data(),
      change.after.data()
    );
  }
);

/**
 * Trigger: Fires when a support ticket is CREATED already urgent.
 * The update trigger only catches escalation-to-urgent — without this,
 * born-urgent tickets never alert anyone.
 */
export const onTicketCreatedUrgentTrigger = onDocumentCreated(
  {
    region: REGION,
    // Canonical collection: tickets.service writes support_tickets. The old
    // `tickets/` path NEVER fired — born-urgent tickets alerted nobody.
    document: "support_tickets/{ticketId}",
  },
  async (event) => {
    const snap = event.data;
    if (!snap) return;
    const ticket = snap.data();
    const ticketId = event.params.ticketId;
    if (ticket.priority !== "urgent") return;

    try {
      const branchId = ticket.branchId || "global";
      // B5-S1 (H17): the free-text subject stays in Firestore only — the
      // builder renders generic copy with IDs in data.
      const message = buildTicketAlertMessage(branchId, {
        id: ticketId,
        ticketNumber: ticket.ticketNumber || ticketId.substring(0, 6),
        priority: ticket.priority,
      });
      await sendFcmMessage(message, {
        purpose: "operational",
        actor: TRUSTED_SERVER_ACTOR,
        critical: true,
      });
    } catch (err: any) {
      console.error("[onTicketCreatedUrgentTrigger] Failed:", err?.message || err);
      await captureErrorSnapshot({
        source: "notifications",
        severity: "high",
        message: `urgent-ticket alert failed for ticket ${ticketId} — SLA clock runs silently`,
        errorStack: err?.stack,
      });
    }
  }
);

/**
 * Trigger: Fires when a support ticket is created or escalated.
 */
export const onTicketEscalatedNotificationTrigger = onDocumentUpdated(
  {
    region: REGION,
    // Canonical collection (see above) — the old path never fired.
    document: "support_tickets/{ticketId}",
  },
  async (event) => {
    const change = event.data;
    if (!change) return;

    const before = change.before.data();
    const after = change.after.data();
    const ticketId = event.params.ticketId;

    if (before.priority !== after.priority && after.priority === "urgent") {
      // P2: same guard as the born-urgent trigger — an escalation alert that
      // throws must not blow up the Firestore trigger (retries + silent SLA
      // clock); it snapshots loudly instead.
      try {
        const branchId = after.branchId || "global";
        const message = buildTicketAlertMessage(branchId, {
          id: ticketId,
          ticketNumber: after.ticketNumber || ticketId.substring(0, 6),
          priority: after.priority,
        });

        await sendFcmMessage(message, {
        purpose: "operational",
        actor: TRUSTED_SERVER_ACTOR,
        critical: true,
      });
      } catch (err: any) {
        console.error("[onTicketEscalatedNotificationTrigger] Failed:", err?.message || err);
        await captureErrorSnapshot({
          source: "notifications",
          severity: "high",
          message: `escalation alert failed for ticket ${ticketId} — SLA clock runs silently`,
          errorStack: err?.stack,
        });
      }
    }
  }
);
