import { onlineDraftBindingHash } from "../../src/modules/orders/createOnlineDraft";

/** Build an intact server-draft fixture for payment-handler tests. */
export function serverOnlineDraft(order: Record<string, any>): Record<string, any> {
  const customerId = order.customerId ?? order.userId ?? "guest";
  const draft: Record<string, any> = {
    id: order.id ?? order.orderId ?? "ord_test",
    orderId: order.id ?? order.orderId ?? "ord_test",
    customerId,
    userId: customerId,
    orderType: order.orderType ?? "takeaway",
    fulfillment: order.fulfillment ?? order.orderType ?? "takeaway",
    fulfillmentType: order.fulfillmentType ?? order.orderType ?? "takeaway",
    status: { code: "PLACED", label: "Order placed", kind: "upcoming", terminal: false },
    paymentMethod: "online",
    paymentStatus: "pending",
    payment: { method: "online", label: "Pay Online", status: "pending" },
    ...order,
  };
  draft.onlineDraft = {
    version: 1,
    source: "server_online_draft",
    orderId: draft.orderId,
    customerId,
    attemptId: order.onlineDraft?.attemptId ?? "attempt_test",
    requestHash: onlineDraftBindingHash(draft),
    createdAtMs: 1,
  };
  return draft;
}
