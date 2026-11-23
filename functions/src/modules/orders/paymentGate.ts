import { serviceError } from "../../core/errors";

/**
 * CUS-16 payment gates for order progression.
 *
 * An online customer order is created BEFORE Razorpay opens, with
 * `payment.method: "online"`, `payment.status: "pending"` and no server marker.
 * Only a confirmed capture writes `paymentChannel: "razorpay"` (verify and the
 * `payment.captured` webhook, both server-only). Until that marker exists the
 * money is not ours, so the kitchen must not start and a courier must not be
 * booked. Cash, COD and walk-in counter orders are a different stream and are
 * never gated here.
 */
export function paymentMethodOf(order: any): string {
  const method = order?.payment?.method ?? order?.paymentMethod ?? order?.orderPaymentMethod;
  return typeof method === "string" ? method.trim().toLowerCase() : "";
}

export function isOnlineCustomerOrder(order: any): boolean {
  return paymentMethodOf(order) === "online";
}

/** The server-only proof that a gateway capture confirmed this order. */
export function hasServerPaymentChannel(order: any): boolean {
  return order?.paymentChannel === "razorpay";
}

/** The server-only proof that this is a real cash order (never a client label). */
export function hasServerCashChannel(order: any): boolean {
  // A2: ONLY the server-owned marker admits customer cash. `paymentMethod` and
  // `cashReceipt` were staff-writable in firestore.rules, so the old legacy
  // exception could be forged by an operator; a bare "cod" label is refused.
  return order?.paymentChannel === "cash";
}

export function hasCapturedPayment(order: any): boolean {
  const captured =
    order?.payment?.capturedAmountPaise ?? order?.["payment.capturedAmountPaise"];
  if (typeof captured === "number" && Number.isFinite(captured) && captured > 0) return true;
  const status = String(order?.payment?.status ?? order?.paymentStatus ?? "").toLowerCase();
  return status === "completed" || status === "captured" || status === "paid";
}

/**
 * P1-C layer 1 — an in-flight verify/webhook confirm, as observed on the order
 * doc. Razorpay gives us no way to close an order, so between the sweep's
 * gateway check ("nothing captured") and its cancel transaction the customer
 * can pay and a confirm can be mid-flight. `verifyPayment` has not yet written
 * any capture truth at that point, so the doc still looks "pending" — the
 * marker below is the only thing that distinguishes "nobody is paying" from
 * "somebody is paying RIGHT NOW".
 *
 * Writing it is best-effort (a marker failure must never fail a verify); the
 * cancel refuses on a FRESH marker only, so a crashed verify cannot wedge an
 * order out of expiry forever.
 */
export const PAYMENT_ATTEMPT_MARKER_TTL_MS = 10 * 60_000;

export function paymentAttemptMarkerOf(order: any): Record<string, any> | null {
  const attempt = order?.paymentAttempt;
  if (!attempt || typeof attempt !== "object" || Array.isArray(attempt)) return null;
  return attempt as Record<string, any>;
}

/** True when a confirm is demonstrably in flight (fresh marker, verifying). */
export function hasLivePaymentAttempt(
  order: any,
  nowMs: number = Date.now()
): boolean {
  const attempt = paymentAttemptMarkerOf(order);
  if (!attempt) return false;
  const status = String(attempt.status || "").toLowerCase();
  if (status !== "verifying") return false;
  const startedAt = Number(attempt.startedAt);
  if (!Number.isFinite(startedAt) || startedAt <= 0) return false;
  return nowMs - startedAt < PAYMENT_ATTEMPT_MARKER_TTL_MS;
}

/**
 * Every reason an order is NOT safe to expire. Evaluated inside the cancel
 * transaction on the FRESH doc (see `isAbandonedUnpaidOnlineOrder` callers):
 * a capture, a captured amount, an authorized/uncaptured hold, or a live
 * verify marker all mean "money may be moving" — the cancel must lose.
 */
export function isUnsafeToExpire(order: any, nowMs: number = Date.now()): boolean {
  if (hasServerPaymentChannel(order)) return true;
  if (hasCapturedPayment(order)) return true;
  if (hasLivePaymentAttempt(order, nowMs)) return true;
  const nested = String(order?.payment?.status ?? "").toLowerCase();
  // An authorization is a reserved hold on the customer's money: cancelling it
  // would strand a charge we never captured, and capturing it later would
  // charge for food nobody cooked.
  if (nested === "authorized" || nested === "awaiting_capture") return true;
  const top = String(order?.paymentStatus ?? "").toLowerCase();
  if (top === "authorized" || top === "awaiting_capture") return true;
  return false;
}

/**
 * P1-C layer 1 (writer). Stamps a `verifying` attempt before the verify path
 * touches the gateway, so the expiry sweep — which can only see the order doc —
 * knows a confirm is genuinely in flight. Best-effort and merge-only: a marker
 * write must never fail a customer's payment, and it never rewrites any
 * existing payment truth. Never writes `undefined` (Firestore rejects it).
 */
export async function markPaymentVerificationInFlight(
  orderRef: any,
  params: { razorpayOrderId?: string | null; razorpayPaymentId?: string | null }
): Promise<void> {
  if (!orderRef || typeof orderRef.set !== "function") return;
  try {
    await orderRef.set(
      {
        paymentAttempt: {
          status: "verifying",
          startedAt: Date.now(),
          razorpayOrderId:
            typeof params.razorpayOrderId === "string" && params.razorpayOrderId
              ? params.razorpayOrderId
              : null,
          razorpayPaymentId:
            typeof params.razorpayPaymentId === "string" && params.razorpayPaymentId
              ? params.razorpayPaymentId
              : null,
        },
      },
      { merge: true }
    );
  } catch (err: any) {
    console.warn(
      "[PaymentGate] verifying-marker write failed (non-blocking):",
      err?.message || err
    );
  }
}

/**
 * P1-C layer 1 (releaser). Clears the marker once the attempt reached a
 * decision, so a genuinely unpaid order becomes expirable again (and a crashed
 * verify ages out via PAYMENT_ATTEMPT_MARKER_TTL_MS). `outcome` is stored for
 * audit only — `status` is what the sweep reads.
 */
export async function clearPaymentVerificationInFlight(
  orderRef: any,
  outcome: string
): Promise<void> {
  if (!orderRef || typeof orderRef.set !== "function") return;
  try {
    await orderRef.set(
      {
        paymentAttempt: {
          status: "settled",
          outcome: typeof outcome === "string" && outcome ? outcome : "unknown",
          settledAt: Date.now(),
        },
      },
      { merge: true }
    );
  } catch (err: any) {
    console.warn(
      "[PaymentGate] verifying-marker clear failed (non-blocking):",
      err?.message || err
    );
  }
}

/**
 * Refuses any forward move for an online order with no server capture marker.
 * Cancelling is deliberately NOT routed through this helper: an unpaid order
 * must always remain cancellable (customer, staff, or the expiry worker).
 */
export function assertOnlineOrderPaid(order: any): void {
  if (!isOnlineCustomerOrder(order)) return;
  if (hasServerPaymentChannel(order)) return;
  throw serviceError(
    "ORDER_NOT_PAID",
    "This online order has not been paid, so it cannot move past PLACED. The customer must complete payment first.",
    409
  );
}

/**
 * F04 — the KITCHEN admission question, which is NOT the same question as
 * `isOnlineCustomerOrder`.
 *
 * An ordinary customer order is created before Razorpay opens and may carry
 * `payment.method: "upi" | "card" | "wallet" | "netbanking"`, or no method at
 * all. None of those say "online", so the old kitchen gate (which only compared
 * against "online") admitted orders whose money never arrived.
 *
 * Rule: anything that is NOT the walk-in counter stream needs the EXISTING
 * server-owned `paymentChannel: "razorpay"` marker. Explicit cash/COD is the
 * only exemption. A missing, empty, non-string or unknown method is NOT proof
 * of cash — it fails closed.
 */
export function requiresServerCaptureForKitchen(order: any): boolean {
  // The walk-in counter stream is tendered at the counter and has its own gate
  // (orderStatus.ts refuses pending walk-in UPI); it is never gated here.
  if (order?.customerId === "cust_walkin") return false;
  // A client-writable `payment.method: "cod"` is NOT proof of cash — that label
  // is exactly how a fake order could reach the kitchen without money (A2/F04).
  // Only the server cash marker (or a server-issued legacy cash receipt) admits
  // the customer cash lane.
  if (hasServerCashChannel(order)) return false;
  return true;
}

/**
 * F04 kitchen admission: refuse any forward kitchen move without the server
 * capture marker. Deliberately separate from `assertOnlineOrderPaid`, whose
 * narrower "online" semantics stay binding for dispatch booking and Porter.
 *
 * Client-writable `payment.status` / `paymentStatus` / `capturedAmountPaise`
 * are NOT proof: only the server-written `paymentChannel` marker is.
 */
export function assertKitchenAdmissionPaid(order: any): void {
  if (!requiresServerCaptureForKitchen(order)) return;
  if (hasServerPaymentChannel(order)) return;
  throw serviceError(
    "ORDER_NOT_PAID",
    "This order has no server-confirmed payment, so the kitchen cannot start it. The customer must complete payment first.",
    409
  );
}

/**
 * True only for the abandoned state the expiry worker may cancel: an online
 * customer order still PLACED whose payment never completed, with no capture
 * marker, no recorded capture and no paid status. Re-evaluated INSIDE the cancel
 * transaction so a capture landing in the same moment wins.
 *
 * F3 (staging 2026-11-21, Test 3): `failed` counts as abandoned alongside
 * `pending`. A DECLINED online payment left the order PLACED for ever — nothing
 * cancelled it, so it collected in the order list as a permanent orphan. The
 * money question is unchanged: a failed payment moved nothing, and any
 * authorization or capture still makes the order unsafe to expire
 * (`isUnsafeToExpire`).
 */
export function isAbandonedUnpaidOnlineOrder(order: any): boolean {
  if (!isOnlineCustomerOrder(order)) return false;
  if (hasServerPaymentChannel(order)) return false;
  if (hasCapturedPayment(order)) return false;
  // P1-C: a live verify marker or an authorization means money may be moving.
  if (isUnsafeToExpire(order)) return false;
  if (!isUnpaidTerminalStatus(order?.payment?.status)) return false;
  const topStatus = String(order?.paymentStatus ?? "").toLowerCase();
  if (topStatus && !isUnpaidTerminalStatus(topStatus)) return false;
  const code = String(order?.status?.code ?? "").toUpperCase();
  return code === "PLACED" || code === "PENDING";
}

/**
 * The payment states that mean "this attempt is over and nothing was taken":
 * `pending` (never started/completed) and `failed` (declined by the gateway).
 * An empty/absent status is NOT on this list — it fails closed as "unknown".
 */
function isUnpaidTerminalStatus(raw: unknown): boolean {
  const value = String(raw ?? "").trim().toLowerCase();
  return value === "pending" || value === "failed";
}
