import { db } from "../../core/firebase";
import {
  COUPON_OBLIGATION_HOLD_MS,
  COUPON_OBLIGATIONS,
  GATEWAY_RELEASE_SAFETY_MARGIN_MS,
  commitCouponRedemption,
  releaseCouponRedemption,
  releaseExpiredGatewaySlot,
} from "./couponAuthority";

export type GatewayCheck =
  | { state: "non_capturable"; gatewayOrderId: string; checkedAtMs: number }
  | { state: "capturable"; gatewayOrderId: string; checkedAtMs: number }
  | { state: "uncertain"; gatewayOrderId: string; checkedAtMs: number; reason?: string };

export interface WorkerDeps {
  nowMs?: number;
  /** Provider boundary. In production it is wired to Razorpay; tests inject mocks. */
  gatewayVerifier?: (gatewayOrderId: string) => Promise<GatewayCheck>;
}

/**
 * r5: decide whether a gateway order can no longer capture. A payment that is
 * captured, authorised/authorized or otherwise in-flight makes the order
 * CAPTURABLE; an empty/invalid/unreadable answer is UNCERTAIN and keeps the
 * hold. Only a well-formed empty payment list proves NON-CAPTURABLE.
 */
export async function verifyGatewayNonCapturable(
  gatewayOrderId: string,
  payments: any[],
  nowMs: number
): Promise<GatewayCheck> {
  if (!gatewayOrderId || !Array.isArray(payments)) {
    return { state: "uncertain", gatewayOrderId, checkedAtMs: nowMs, reason: "invalid_provider_answer" };
  }
  const blocking = payments.some((p: any) => {
    const status = String(p?.status ?? "").toLowerCase();
    return (
      status === "captured" || status === "authorized" || status === "authorised" ||
      status === "pending" || status === "processing" || status === "created" ||
      (typeof p?.amount === "number" && p.amount > 0 && Number(p?.amount_refunded ?? 0) < p.amount)
    );
  });
  return { state: blocking ? "capturable" : "non_capturable", gatewayOrderId, checkedAtMs: nowMs };
}

/**
 * M3 — the drain for durable coupon obligations.
 *
 * An online checkout reserves a slot and records an obligation in the SAME
 * transaction. Capture used to reconcile on a best-effort call; if the process
 * died between the two, the obligation sat pending for ever and the slot was
 * eventually lost. This worker is the durable resolver: it settles captured
 * sales, releases terminal/cancelled ones, and leaves live ones pending. The
 * slot is held for COUPON_OBLIGATION_HOLD_MS until this drainage decides.
 */
export interface DrainResult {
  committed: number;
  released: number;
  left: number;
  flagged: number;
}

function isCaptured(order: any): boolean {
  if (!order) return false;
  if (order.paymentChannel === "razorpay") return true;
  const status = String(order.paymentStatus ?? order.payment?.status ?? "").toLowerCase();
  return status === "completed" || status === "captured" || status === "paid";
}

function isTerminalWithoutSale(order: any): boolean {
  if (!order) return false;
  const status = String(order.paymentStatus ?? order.payment?.status ?? "").toLowerCase();
  const code = String(order.status?.code ?? "").toUpperCase();
  // IMPORTANT (M2): a DECLINED ATTEMPT (`payment.status: "failed"`) is NOT
  // terminal — the gateway order stays payable and the retry needs the slot.
  // Only an order-level cancellation/refund, or an expired intent, frees it.
  return status === "cancelled" || status === "refunded" || code === "CANCELLED";
}

export async function drainCouponObligations(limit = 50, deps: WorkerDeps = {}): Promise<DrainResult> {
  const result: DrainResult = { committed: 0, released: 0, left: 0, flagged: 0 };
  const nowMs = deps.nowMs ?? Date.now();
  const ref: any = db.collection(COUPON_OBLIGATIONS);
  if (typeof ref?.where !== "function") return result;

  const cursorRef = db.collection('scheduler_cursors').doc('coupon_obligations_v1');
  const cursor = (await cursorRef.get()).data()?.after;
  let query = ref.where("status", "==", "pending").orderBy('__name__');
  if (cursor) query = query.startAfter(cursor);
  const snap = await query.limit(limit).get();
  const docs = Array.isArray(snap?.docs) ? snap.docs : [];
  for (const doc of docs) {
    const obligation = doc.data() as any;
    if (!obligation?.orderId) continue;
    let order: any = null;
    try {
      const orderSnap = await db.collection("orders").doc(obligation.orderId).get();
      order = orderSnap?.exists ? orderSnap.data() : null;
    } catch {
      // Unreadable order: never guess — leave the obligation pending.
      result.flagged += 1;
      continue;
    }

    try {
      if (isCaptured(order)) {
        const gateway = order?.payment?.razorpayOrderId ?? order?.['payment.razorpayOrderId'];
        if (obligation.gatewayOrderId && (order.paymentChannel !== 'razorpay' || obligation.gatewayOrderId !== gateway)) {result.flagged++;continue;}
        const outcome = await commitCouponRedemption(obligation.orderId,gateway);
        if (outcome === "committed") result.committed += 1;
        else result.flagged += 1;
        continue;
      }
      const expired =
        typeof obligation.createdAtMs === "number" &&
        nowMs - obligation.createdAtMs > COUPON_OBLIGATION_HOLD_MS + GATEWAY_RELEASE_SAFETY_MARGIN_MS;
      if (obligation.gatewayOrderId && expired) {
        // r5: a gateway-bound slot is NEVER released on a local TTL guess.
        // Verify with the provider (mocked in tests) that no capture or
        // authorisation can still land, then release fenced and atomic.
        if (!deps.gatewayVerifier) { result.flagged += 1; continue; }
        let check: GatewayCheck;
        try {
          check = await deps.gatewayVerifier(obligation.gatewayOrderId);
        } catch {
          result.flagged += 1;
          continue;
        }
        if (check.state !== "non_capturable" || check.gatewayOrderId !== obligation.gatewayOrderId) {
          result.flagged += 1;
          continue;
        }
        const outcome = await releaseExpiredGatewaySlot({
          orderId: obligation.orderId,
          gatewayOrderId: obligation.gatewayOrderId,
          slotId: obligation.slotId ?? doc.id,
          version: obligation.version,
          nowMs,
        });
        if (outcome === "released") result.released += 1;
        else result.flagged += 1;
        continue;
      }
      if (isTerminalWithoutSale(order) || expired) {
        const release = await releaseCouponRedemption({
          orderId: obligation.orderId,
          reason: expired ? "intent_expired" : "order_terminal",
        });
        if (release.released) result.released++;
        else if (release.reason === 'gateway_still_bound') result.left++;
        else result.flagged++;
        continue;
      }
      result.left += 1;
    } catch (err: any) {
      console.warn(`[Coupons] obligation drain failed for ${obligation.orderId}:`, err?.message || err);
      result.flagged += 1;
    }
  }
  await cursorRef.set({after: docs.length === limit ? docs[docs.length-1].id : null});
  return result;
}

/**
 * Production provider boundary. No live calls happen here in tests: unit tests
 * inject their own verifier into drainCouponObligations directly. This wrapper
 * is the only place that talks to Razorpay, and any uncertainty (including a
 * transport error) is surfaced as `uncertain` so the slot stays held.
 */
async function productionGatewayVerifier(gatewayOrderId: string): Promise<GatewayCheck> {
  const nowMs = Date.now();
  try {
    const { getRazorpayClient } = await import("../payments/razorpayClient");
    const rzp: any = getRazorpayClient();
    let payments: any[];
    if (typeof rzp?.orders?.fetchPayments === "function") {
      const res = await rzp.orders.fetchPayments(gatewayOrderId);
      payments = Array.isArray(res) ? res : Array.isArray(res?.items) ? res.items : [];
      if (!payments.length && res?.count !== 0 && !Array.isArray(res)) {
        return { state: "uncertain", gatewayOrderId, checkedAtMs: nowMs, reason: "invalid_provider_answer" };
      }
    } else if (typeof rzp?.payments?.all === "function") {
      const res = await rzp.payments.all({ order_id: gatewayOrderId, count: 100 });
      payments = Array.isArray(res) ? res : Array.isArray(res?.items) ? res.items : [];
    } else {
      return { state: "uncertain", gatewayOrderId, checkedAtMs: nowMs, reason: "provider_unavailable" };
    }
    return verifyGatewayNonCapturable(gatewayOrderId, payments, nowMs);
  } catch (err: any) {
    return { state: "uncertain", gatewayOrderId, checkedAtMs: nowMs, reason: err?.message || "provider_error" };
  }
}

/** Convenience wrapper so a scheduler registers one named callable. */
export async function drainCouponObligationsScheduled(): Promise<DrainResult> {
  return drainCouponObligations(100, { gatewayVerifier: productionGatewayVerifier });
}
