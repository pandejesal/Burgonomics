/**
 * counter-cash-c9: one authoritative way to read the cash an order owes/held.
 *
 * A completed cash order's `cashCollectedPaise` is the server stamp written at
 * handover; older rows have only the server-priced bill. Statements must count
 * exactly one of them, never both.
 */
export function cashDuePaiseOf(order: any): number {
  const collected = Number(order?.cashCollectedPaise);
  if (Number.isFinite(collected) && collected > 0) return Math.round(collected);
  const split = Number(order?.pricing?.split?.totalAmountPaise);
  if (Number.isFinite(split) && split > 0) return Math.round(split);
  const grand = Number(order?.pricing?.grandTotal);
  if (Number.isFinite(grand) && grand > 0) return Math.round(grand * 100);
  const total = Number(order?.total);
  if (Number.isFinite(total) && total > 0) return Math.round(total * 100);
  return 0;
}

const CASH_HANDOVER_CODES = new Set(["picked_up", "completed", "delivered"]);
function statusCodeOf(order: any): string {
  return String(order?.status?.code ?? order?.status ?? "").toLowerCase();
}
export function isCashHandover(order: any): boolean {
  return CASH_HANDOVER_CODES.has(statusCodeOf(order));
}

/** Total cash actually held across the given (already filtered) cash orders. */
export function statementCashFromOrders(orders: any[]): { cashCollectedPaise: number; cashOrders: number } {
  let cashCollectedPaise = 0;
  let cashOrders = 0;
  for (const order of orders) {
    if (!order || !isCashHandover(order)) continue;
    cashCollectedPaise += cashDuePaiseOf(order);
    cashOrders += 1;
  }
  return { cashCollectedPaise, cashOrders };
}
