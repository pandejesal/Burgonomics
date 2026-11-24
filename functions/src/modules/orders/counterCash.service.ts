import { receiptEvidenceStamp } from "../payments/receiptEvidence";
import { cashDuePaiseOf } from "../settlements/cashEvidence";

/**
 * counter-cash-c9: the counter handover IS the payment event. Amount comes from
 * the server-priced bill (never the request), and the receipt evidence is the
 * same server-only shape the capture and COD hand-over paths write, extended
 * with the counter source and the acting staff uid.
 */
export function isCounterCashOrder(order: any): boolean {
  if (!order) return false;
  if (order.paymentChannel === "razorpay") return false;
  const method = String(order.paymentMethod ?? order.payment?.method ?? "").toLowerCase();
  if (order.paymentChannel === "cash") return true;
  return (
    order.customerId === "cust_walkin" &&
    (method === "cod" || method === "cash")
  );
}

export function counterCashCollectedPatch(
  order: any,
  staff: { uid?: string } | undefined,
  handoverCode: "PICKED_UP" | "COMPLETED"
): Record<string, any> | null {
  if (!isCounterCashOrder(order)) return null;
  if (String(order.status?.code ?? "").toUpperCase() === "CANCELLED") return null;
  if (Number.isFinite(Number(order.cashCollectedPaise)) && Number(order.cashCollectedPaise) > 0) return null;
  const due = cashDuePaiseOf(order);
  if (!(due > 0)) return null;
  const evidence = receiptEvidenceStamp("cash", due) as any;
  evidence.source = "counter_handover";
  evidence.staffUid = typeof staff?.uid === "string" ? staff.uid : "unknown";
  evidence.handover = handoverCode;
  return {
    cashCollectedPaise: due,
    cashDuePaise: due,
    paymentStatus: "paid",
    payment: { ...(order.payment && typeof order.payment === "object" ? order.payment : {}), status: "completed", method: "cod", cashCollectedPaise: due },
    receiptEvidence: evidence,
  };
}
