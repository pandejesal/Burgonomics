import { captureErrorSnapshot } from "../../core/errors";
import { db } from "../../core/firebase";

/**
 * F24 — the ONE place an order cancellation's post-commit obligations live.
 *
 * Extracted behaviour-identically from orderStatus.ts so that BOTH the staff
 * KDS bump (`POST /orders/bumpStatus`) and the customer-owned cancel
 * (`POST /orders/customerCancel`) converge on the same three helpers:
 *
 *   1. a DURABLE provider-cancel intent recorded on the order BEFORE the wire
 *      call (retried by the existing 5-minute reconciler tick),
 *   2. the idempotent Grill-Coins restore (deterministic ledger id
 *      `coin_redemption_restore_{orderId}`), and
 *   3. the POS cancel (Petpooja "Update Order Status", status "-1") for an
 *      order the POS actually received — see modules/petpooja/orderCancel.ts.
 *      Fix wave 2026-11-20: the vendor API was sandbox-proven but unwired, so a
 *      cancelled order stayed live in the kitchen queue. Every cancellation
 *      source (customer F24, staff KDS cancel, and the payment-not-completed
 *      expiry, which calls the same bumpOrderStatus) lands here, so this is the
 *      one place that has to hold.
 *
 * Contract: NEVER throws. The status write is already durable when this runs,
 * and a provider/coin/POS fault must surface as an alert, not as a failed
 * cancel. Retrying the cancel is safe: the provider intent is read from the
 * order (a second attempt reuses the recorded intent), the coin restore is keyed
 * by the order id, and the POS cancel is leased and idempotent (a second
 * "cancel" for the same order is a no-op at the vendor).
 */
export interface CancelSideEffectsResult {
  providerCancelAttempted: boolean;
  providerCancelSkipped?: string;
  coinsRestored: "restored" | "noop" | "failed";
  /** Petpooja cancel outcome — absent when the POS never received the order. */
  posCancel?: string;
}

/**
 * Applies both cancellation obligations in order. `requestedBy` is only used
 * for the audit trail on the provider-cancel record (staff name or
 * `customer:{uid}` — never a client-supplied string).
 */
export async function applyCancelSideEffects(input: {
  orderId: string;
  requestedBy: string;
  reason?: "order_cancelled" | "staff_cancelled";
}): Promise<CancelSideEffectsResult> {
  const orderId = String(input.orderId || "").trim();
  if (!orderId) {
    return {
      providerCancelAttempted: false,
      providerCancelSkipped: "missing_order_id",
      coinsRestored: "noop",
    };
  }
  const reason = input.reason ?? "order_cancelled";
  const requestedBy = String(input.requestedBy || "").trim() || "System";
  const result: CancelSideEffectsResult = {
    providerCancelAttempted: false,
    coinsRestored: "noop",
  };

  const orderRef = db.collection("orders").doc(orderId);

  // --- 1. Rider: record the intent durably, then attempt exactly one call ----
  try {
    const fresh = await orderRef.get();
    const live = fresh.exists ? ((fresh.data() || {}) as any) : {};
    const { recordAndAttemptProviderCancel } = await import("../dispatch/shadowfax.reconcile");
    const provider = (live.dispatchProvider || null) as "borzo" | "shadowfax" | "porter" | null;
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
        reason,
        requestedBy,
      });
      result.providerCancelAttempted = true;
    } else {
      result.providerCancelSkipped = "no_live_booking";
    }
  } catch (err: any) {
    // recordAndAttemptProviderCancel does not throw; a failed import/read is
    // still never allowed to surface as a cancel error.
    result.providerCancelSkipped = "helper_fault";
    console.warn(
      `[CancelSideEffects] provider cancellation skipped for cancelled order ${orderId}:`,
      err?.message || err
    );
  }

  // --- 2. POS: cancel the order at Petpooja, exactly once --------------------
  // Placed after the rider intent (a courier on the road is the more urgent
  // cleanup) and before the coin restore. `requestPetpoojaOrderCancel` is
  // contracted never to throw, and it refuses outright when the POS never
  // received the order — so a locally-cancelled order costs no vendor call.
  try {
    const { requestPetpoojaOrderCancel } = await import("../petpooja/orderCancel");
    result.posCancel = await requestPetpoojaOrderCancel({
      orderId,
      reason,
      requestedBy,
    });
  } catch (err: any) {
    // A failed import or an unexpected fault must not fail the cancel; the
    // order doc keeps whatever cancel state it had, and the 5-minute worker
    // owns any recorded intent.
    result.posCancel = "helper_fault";
    console.warn(
      `[CancelSideEffects] POS cancel skipped for cancelled order ${orderId}:`,
      err?.message || err
    );
  }

  // --- 3. Grill Coins: deterministic, idempotent restore --------------------
  // No-op while `config.loyalty.redemptionEnabled` is false (no debit row can
  // exist), but wired so enabling redemption cannot silently strand coins.
  try {
    const { restoreRedeemedCoins } = await import("../customers/customerCoins");
    const restored = await restoreRedeemedCoins({ orderId });
    result.coinsRestored = restored?.alreadyDone ? "noop" : "restored";
  } catch (err: any) {
    result.coinsRestored = "failed";
    console.warn(
      `[CancelSideEffects] Grill-Coins restore failed for cancelled order ${orderId}:`,
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

  return result;
}
