import * as admin from "firebase-admin";
import { db } from "../../core/firebase";
import { serviceError, captureErrorSnapshot } from "../../core/errors";
import {
  assertOrderBranchAccess,
  isBrandAdminClaim,
  type StaffCaller,
} from "../../core/middleware";
import {
  assertOnlineOrderPaid,
  isAbandonedUnpaidOnlineOrder,
  isUnsafeToExpire,
} from "./paymentGate";

/**
 * Server-side KDS order-status bump. Mirrors the partner
 * PARTNER_TO_DELIVERY table (burgonomics-partner/src/utils/orderContract.ts)
 * so writes keep the Delivery-compatible object form customer tracking
 * resolves. Legacy aliases (placed, ready_for_pickup) normalize to their
 * canonical partner status first.
 *
 * Every bump is branch-checked: cross-branch status flips (including silent
 * cancels via 'cancelled') are 403. Recall (backward moves) between non-terminal
 * states is allowed — the KDS UI owns the workflow — but every bump now runs in
 * a transaction that (a) freezes terminal orders (delivered/cancelled/…) and
 * (b) honours the client's `expectedStatus` precondition, so a stale screen or
 * a delayed second tap can no longer reverse a newer status.
 */

export type BumpStatus =
  | "pending"
  | "accepted"
  | "preparing"
  | "ready"
  | "out_for_delivery"
  | "delivered"
  | "cancelled"
  | "placed"
  | "ready_for_pickup";

const ALIAS_TO_CANONICAL: Record<string, string> = {
  placed: "pending",
  ready_for_pickup: "ready",
};

interface DeliveryStatusMeta {
  code: string;
  label: string;
  kind: "upcoming" | "in_progress" | "completed" | "cancelled" | "failed" | "unknown";
  terminal: boolean;
}

const PARTNER_TO_DELIVERY: Record<string, DeliveryStatusMeta> = {
  pending: { code: "PLACED", label: "Order placed", kind: "upcoming", terminal: false },
  accepted: { code: "CONFIRMED", label: "Order confirmed", kind: "upcoming", terminal: false },
  preparing: { code: "PREPARING", label: "Preparing your order", kind: "in_progress", terminal: false },
  ready: { code: "READY_FOR_PICKUP", label: "Ready for pickup", kind: "in_progress", terminal: false },
  out_for_delivery: { code: "OUT_FOR_DELIVERY", label: "Out for delivery", kind: "in_progress", terminal: false },
  delivered: { code: "DELIVERED", label: "Delivered", kind: "completed", terminal: true },
  cancelled: { code: "CANCELLED", label: "Cancelled", kind: "cancelled", terminal: true },
};

/**
 * Normalizes an `expectedStatus` into the set of Delivery codes that count as
 * THE SAME visible state (G1): the raw value when the caller already speaks
 * canonical Delivery vocabulary (case-insensitively), plus the fulfillment-
 * specific code for that state via the EXISTING partner tables (pending->PLACED,
 * ready->READY_FOR_PICKUP, dinein ready->READY_TO_SERVE, takeaway/dinein
 * delivered->PICKED_UP/COMPLETED). Unknown vocabulary is empty-safe: it only
 * matches if it happens to be the order's literal current code.
 */
function allowedExpectedCodes(expected: string, fulfillment: string): Set<string> {
  const raw = expected.trim();
  if (!raw) return new Set();
  const codes = new Set<string>([raw.toUpperCase()]);
  // Vocabulary tables are lowercase-keyed, normalized before the lookups so
  // "ACCEPTED" still resolves to CONFIRMED and "READY" to the dinein fork.
  const lower = raw.toLowerCase();
  const canonical = ALIAS_TO_CANONICAL[lower] ?? lower;
  const meta: DeliveryStatusMeta | undefined = (PARTNER_TO_DELIVERY as Record<string, DeliveryStatusMeta>)[canonical];
  if (meta) {
    codes.add(meta.code);
    if (canonical === "ready" && fulfillment === "dinein") codes.add("READY_TO_SERVE");
    // delivered forks (PICKED_UP/COMPLETED) are corruption-tolerance only:
    // those states are terminal (terminal guard throws before this compare),
    // so a matching expectation can never be consultable on healthy docs.
  }
  return codes;
}

export interface BumpOrderStatusParams {
  orderId: string;
  status: BumpStatus;
  /** Status.code the caller's screen currently shows; mismatch → 409 STALE_ORDER_STATUS. */
  expectedStatus?: string;
  cancellationReason?: string;
  timelineEvent?: { title: string; actor?: string; description?: string };
  caller?: StaffCaller;
  /** Staff name for the cancellation audit trail (provider cancel record). */
  staffName?: string;
  /**
   * Expiry-worker guard: inside the cancel transaction, refuse unless the order
   * is STILL the abandoned unpaid online order that was screened. A capture
   * that lands in the same moment writes the payment marker first, this check
   * sees it, and the cancel loses — money and kitchen state stay consistent.
   */
  onlyIfUnpaid?: boolean;
}

export async function bumpOrderStatus(params: BumpOrderStatusParams) {
  const { orderId, status, cancellationReason, timelineEvent, caller } = params;
  const staffNameForCancel = () =>
    (typeof params.staffName === "string" && params.staffName.trim()) ||
    (typeof caller?.email === "string" && caller.email) ||
    (typeof caller?.uid === "string" && caller.uid) ||
    "Branch Staff";
  const canonical = ALIAS_TO_CANONICAL[status] ?? status;
  const meta = PARTNER_TO_DELIVERY[canonical];
  if (!meta) {
    throw serviceError("ORDER_STATUS_UNKNOWN", `Unknown order status: ${status}`, 400);
  }

  const orderRef = db.collection("orders").doc(orderId);
  const preSnap = await orderRef.get();
  if (!preSnap.exists) {
    throw serviceError("ORDER_NOT_FOUND", `Order ${orderId} not found`, 404);
  }
  const preOrder = (preSnap.data() || {}) as any;
  if (caller) await assertOrderBranchAccess(caller, preOrder);

  let finalMeta = { ...meta };
  const fulfillment = (preOrder.fulfillmentType || preOrder.orderType || preOrder.fulfillment || "delivery").toLowerCase();
  if (fulfillment === "dinein") {
    if (canonical === "ready") {
      finalMeta = { code: "READY_TO_SERVE", label: "Ready to serve", kind: "in_progress", terminal: false };
    } else if (canonical === "delivered") {
      finalMeta = { code: "COMPLETED", label: "Completed", kind: "completed", terminal: true };
    }
  } else if (fulfillment === "takeaway") {
    if (canonical === "delivered") {
      finalMeta = { code: "PICKED_UP", label: "Picked up", kind: "completed", terminal: true };
    }
  }

  // OTP-01 (SEC-01): a DELIVERY handover needs customer-possession proof.
  // firestore.rules' directDeliveredBypass() blocks the client write for
  // exactly this reason, and clients can no longer write status at all — so
  // this route became the only path and must carry the same rule. Branch-level
  // callers complete a delivery via POST /orders/verifyDeliveryOtp (or the
  // courier webhook); only a brand-level caller may override, and the route's
  // timeline event is the audit trail. `caller` undefined is a trusted
  // internal/scheduler path, never an HTTP request.
  if (
    (fulfillment === "delivery" || fulfillment === "deliver") &&
    canonical === "delivered" &&
    caller &&
    !isBrandAdminClaim(caller)
  ) {
    throw serviceError(
      "DELIVERY_OTP_REQUIRED",
      "Delivery orders are completed by the customer's handover OTP — use Verify delivery OTP (a brand-level override is required otherwise).",
      409,
    );
  }

  const payload: Record<string, any> = {
    status: finalMeta,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  // Narrow: a reason is a CANCELLATION attribute. The previous unconditional
  // write stamped a cancel reason onto a live cooking order (the scheme let
  // cancellationReason ride any bump).
  if (canonical === "cancelled" && cancellationReason) {
    payload.cancellationReason = cancellationReason;
  }
  if (timelineEvent) {
    payload.timeline = admin.firestore.FieldValue.arrayUnion({
      ...timelineEvent,
      timestamp: new Date().toISOString(),
    });
  }

  // Optimistic-concurrency + terminal guard, enforced inside a transaction so
  // two staff racing on the same order cannot both win (last-write-wins used to
  // let a delayed second tap silently reverse a newer state).
  const expectedRaw = params.expectedStatus;
  const expected = expectedRaw?.trim();
  if (expectedRaw !== undefined && !expected) {
    // An empty precondition is a client bug: refusing is honest, silently
    // dropping the stale-screen guard is not.
    throw serviceError("STALE_ORDER_STATUS", "Order: expectedStatus was empty", 400);
  }
  await db.runTransaction(async (tx) => {
    const live = await tx.get(orderRef);
    if (!live.exists) {
      throw serviceError("ORDER_NOT_FOUND", `Order ${orderId} not found`, 404);
    }
    const freshOrder = (live.data() || {}) as any;
    // Re-AUTHORIZE against the transactional snapshot (stress sweep
    // 2026-10-24, S2): the pre-read above may be stale — an order re-linked
    // to another branch or a claim revoked between read and commit must not
    // let the caller write order state they no longer own. Mirrors the
    // fresh-snapshot authorization in manualBranchDispatch.
    if (caller) await assertOrderBranchAccess(caller, freshOrder);
    const current = freshOrder.status || {};
    // A terminal order (delivered/cancelled/completed/picked up) is frozen:
    // stale taps must never regress it, and a delivered order is not
    // cancellable from a KDS screen.
    if (current.terminal === true) {
      throw serviceError(
        "ORDER_STATUS_CONFLICT",
        `Order ${orderId} is already ${current.code || "closed"}; status can no longer be changed`,
        409,
      );
    }
    // The client told us which state its screen was showing. If the stored
    // state has moved on (another staff member acted, a webhook landed), this
    // bump is stale and must not be applied.
    // G1: the Partner app sends ITS vocabulary (pending/accepted/ready//...) in
    // expectedStatus; the server stores uppercase Delivery codes like
    // READY_TO_SERVE/PICKED_UP, so the raw compare rejected nearly every
    // accompanied bump. Compare through the canonical vocabulary tables.
    if (expected && !allowedExpectedCodes(expected, fulfillment).has(String(current.code || "").toUpperCase())) {
      throw serviceError(
        "STALE_ORDER_STATUS",
        `Order ${orderId} moved to ${current.code || "unknown"} since the screen loaded; refresh before acting`,
        409,
      );
    }
    // CUS-16: an online order becomes kitchen-eligible only once a server
    // capture wrote `paymentChannel: "razorpay"`. PLACED (a no-op re-bump) and
    // cancelled are always allowed; cash/COD/walk-in are not gated.
    if (canonical !== "pending" && canonical !== "cancelled") {
      assertOnlineOrderPaid(freshOrder);
    }
    if (params.onlyIfUnpaid) {
      // P1-C layer 1: the doc was re-read INSIDE this transaction, so this is
      // the freshest truth there is. Refuse on any capture, authorization, or
      // live verify marker — not merely on the old "still looks abandoned"
      // shape — so a payment that started after the gateway check wins.
      if (isUnsafeToExpire(freshOrder)) {
        throw serviceError(
          "ORDER_NOT_PAID",
          `Order ${orderId} has payment activity in flight or recorded; refusing to cancel it`,
          409,
        );
      }
      if (!isAbandonedUnpaidOnlineOrder(freshOrder)) {
        throw serviceError(
          "ORDER_NOT_PAID",
          `Order ${orderId} is no longer an abandoned unpaid order; refusing to cancel it`,
          409,
        );
      }
    }
    tx.update(orderRef, payload);
  });

  // Shadowfax dispatch-ready (docs: "Notify Shadowfax when the shipment is
  // ready for pickup so the rider can collect it"). STRICTLY post-commit: the
  // kitchen's bump is already durable, so this can never fail the transition —
  // a provider fault is recorded on the order and resent by the 5-minute
  // reconciler with the SAME timestamp. Shadowfax bookings only.
  if (canonical === "ready") {
    try {
      const { signalShadowfaxDispatchReady } = await import("../dispatch/shadowfax.reconcile");
      const fresh = await orderRef.get();
      const live = fresh.exists ? ((fresh.data() || {}) as any) : {};
      await signalShadowfaxDispatchReady(orderId, { ...live });
    } catch (err: any) {
      // Belt-and-braces: signalShadowfaxDispatchReady does not throw, but a
      // failed import or read must not surface as a kitchen error either.
      console.warn(
        `[OrderStatus] Shadowfax dispatch-ready skipped for order ${orderId}:`,
        err?.message || err
      );
    }
  }

  // PAY-03: a cancelled order gives back the Grill Coins its payment debited.
  // Partial refunds never reach here — only a cancel (or a full refund in
  // autoRefund) restores. A restore failure must never fail the cancel, and
  // the deterministic restore ledger makes cancel-after-refund idempotent.
  if (canonical === "cancelled") {
    // P1-E: the order is terminal now, so the delivery queue's cancel route
    // will refuse it forever. The RIDER is cancelled here instead, durably:
    // the intent is recorded on the order before the call, a provider fault
    // leaves it retryable on the 5-minute tick, and a provider we cannot call
    // (Borzo/Porter) raises a staff-visible dashboard alert rather than a
    // rider silently continuing to a cancelled order.
    // Strictly post-commit and never rethrown: the kitchen cancel and the coin
    // restore below must succeed even when the provider is down.
    try {
      const fresh = await orderRef.get();
      const live = fresh.exists ? ((fresh.data() || {}) as any) : {};
      const { recordAndAttemptProviderCancel } = await import("../dispatch/shadowfax.reconcile");
      const provider = (live.dispatchProvider || null) as
        | "borzo"
        | "shadowfax"
        | "porter"
        | null;
      const providerOrderId =
        live.dispatchOrderId ??
        live.shadowfaxOrderId ??
        live.borzoOrderId ??
        live.porterOrderId ??
        null;
      // Only a LIVE binding is worth a remote cancel; a delivered booking is a
      // real fulfilment and must never be cancelled from a late order flip.
      const liveBooking = provider && providerOrderId && live.deliveryStatus !== "delivered";
      if (liveBooking) {
        await recordAndAttemptProviderCancel({
          orderId,
          provider,
          providerOrderId: String(providerOrderId),
          reason: "order_cancelled",
          requestedBy: staffNameForCancel(),
        });
      }
    } catch (err: any) {
      // recordAndAttemptProviderCancel does not throw; a failed import/read is
      // still never allowed to surface as a kitchen error.
      console.warn(
        `[OrderStatus] provider cancellation skipped for cancelled order ${orderId}:`,
        err?.message || err
      );
    }

    try {
      const { restoreRedeemedCoins } = await import("../customers/customerCoins");
      await restoreRedeemedCoins({ orderId });
    } catch (err: any) {
      console.warn(
        `[OrderStatus] Grill-Coins restore failed for cancelled order ${orderId}:`,
        err?.message || err
      );
      await captureErrorSnapshot({
        source: "payments",
        severity: "high",
        message: `Grill-Coins restore failed for cancelled order ${orderId} — remediate via adjustCustomerCoins`,
        orderId,
        errorStack: err?.stack,
      }).catch(() => undefined);
    }
  }

  // Return the meta we actually WROTE (fulfillment-specific), not the generic
  // delivery meta - the KDS response is a state artifact and dinein/takeaway
  // bumps must not claim DELIVERED/READY_FOR_PICKUP the doc does not carry.
  return { orderId, status: finalMeta };
}
