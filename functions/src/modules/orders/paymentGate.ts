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

export function hasCapturedPayment(order: any): boolean {
  const captured =
    order?.payment?.capturedAmountPaise ?? order?.["payment.capturedAmountPaise"];
  if (typeof captured === "number" && Number.isFinite(captured) && captured > 0) return true;
  const status = String(order?.payment?.status ?? order?.paymentStatus ?? "").toLowerCase();
  return status === "completed" || status === "captured" || status === "paid";
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
 * True only for the abandoned state the expiry worker may cancel: an online
 * customer order still PLACED with a pending payment, no capture marker, no
 * recorded capture and no paid status. Re-evaluated INSIDE the cancel
 * transaction so a capture landing in the same moment wins.
 */
export function isAbandonedUnpaidOnlineOrder(order: any): boolean {
  if (!isOnlineCustomerOrder(order)) return false;
  if (hasServerPaymentChannel(order)) return false;
  if (hasCapturedPayment(order)) return false;
  const nestedStatus = String(order?.payment?.status ?? "").toLowerCase();
  if (nestedStatus !== "pending") return false;
  const topStatus = String(order?.paymentStatus ?? "").toLowerCase();
  if (topStatus && topStatus !== "pending") return false;
  const code = String(order?.status?.code ?? "").toUpperCase();
  return code === "PLACED" || code === "PENDING";
}
