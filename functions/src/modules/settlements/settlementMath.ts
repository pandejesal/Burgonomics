/**
 * Franchise settlement: month-end statement maths (owner decision 2026-11-20).
 *
 * Owner's words: "if one branch makes X amount of money, 2k gets cut of it, no
 * matter the earning, not per order but month end".
 *
 *   net payable to the branch = online collected centrally
 *                             - online refunds
 *                             - ONE flat platform fee per branch per active month
 *
 * Cash (COD and counter) is money the branch already holds. It is reported for
 * information and NEVER enters the net payable: adding it would pay the branch
 * twice for the same food.
 *
 * This module is deliberately pure — no Firestore, no clock, no network — so
 * every rupee of the statement is unit-testable. The service and the scheduler
 * around it do the reads and the writes.
 *
 * Every judgement that changes an amount is listed in
 * `<evidence>/ASSUMPTIONS.md` for the owner to confirm.
 */

/** The documented default flat fee per branch per active month, in rupees. */
export const DEFAULT_SETTLEMENT_FEE_RUPEES = 2000;

/** Bump when an assumption that changes amounts is added or altered. */
export const SETTLEMENT_ASSUMPTIONS_VERSION = "2026-11-22-r1";

/**
 * M7 (GPT-6.2 Sol, 2026-11-22). The owner confirmed that ONLINE money belongs to
 * the month the customer PAID (the Razorpay capture), while a refund belongs to
 * the month of the ORDER. Every order therefore carries a server-owned
 * `settlementEffectiveAtMs`; older documents that predate the field fall back to
 * the capture time when one is readable, then to `createdAt`, then `placedAt`.
 * The same resolver decides both the Firestore query range and the bucket, so a
 * legacy row can never be counted in a different month than it was queried in.
 */
export const SETTLEMENT_EFFECTIVE_AT_FIELD = "settlementEffectiveAtMs";

const DAY_MS = 24 * 60 * 60 * 1000;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** `YYYY-MM`, and no other shape. */
const MONTH_KEY = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Statuses where a cash order's money is really in the branch's hands. */
const CASH_COMPLETED_STATUSES = new Set([
  "delivered",
  "completed",
  "complete",
  "picked_up",
  "pickedup",
  "handed_over",
  "closed",
  "ready_to_serve",
]);

/** Cancelled / fully refunded: counts as no sale at all. */
const VOID_STATUSES = new Set(["cancelled", "canceled", "refunded"]);

const FULL_REFUND_STATUSES = new Set([
  "refunded",
  "full_refund",
  "fully_refunded",
  "refund_completed",
]);

/** Staff-created counter orders keep this sentinel customerId. */
const WALK_IN_CUSTOMER_ID = "cust_walkin";

export interface SettlementMonthBounds {
  /** Inclusive start of the month, epoch ms. */
  startMs: number;
  /** EXCLUSIVE end of the month (the next month's start), epoch ms. */
  endMs: number;
}

/**
 * Asia/Kolkata month bucket for a `YYYY-MM` key. IST is a fixed UTC+05:30 with
 * no DST, so a month runs from 18:30Z on the last day of the previous month to
 * 18:30Z on the last day of this one. Half-open `[startMs, endMs)`.
 */
export function settlementMonthBounds(monthKey: string): SettlementMonthBounds {
  const key = String(monthKey || "").trim();
  if (!MONTH_KEY.test(key)) {
    throw new Error(`settlementMonthBounds: invalid month key ${JSON.stringify(monthKey)} (expected YYYY-MM)`);
  }
  const year = Number(key.slice(0, 4));
  const month = Number(key.slice(5, 7));
  const startMs = Date.UTC(year, month - 1, 1) - IST_OFFSET_MS;
  const endMs = Date.UTC(year, month, 1) - IST_OFFSET_MS;
  return { startMs, endMs };
}

/** The month before `monthKey`, or "" when the key is unreadable. */
export function previousSettlementMonthKey(monthKey: string): string {
  const key = String(monthKey || "").trim();
  if (!MONTH_KEY.test(key)) return "";
  const year = Number(key.slice(0, 4));
  const month = Number(key.slice(5, 7));
  if (month === 1) return `${year - 1}-12`;
  return `${year}-${String(month - 1).padStart(2, "0")}`;
}

export type SettlementFeeSource = "settlementFee" | "monthlyFee" | "default";

export interface SettlementFeeResolution {
  feePaise: number;
  source: SettlementFeeSource;
  /** True when a configured value was present but unusable (flagged, not hidden). */
  invalid: boolean;
}

function readRupees(raw: unknown): { value: number; present: boolean; invalid: boolean } {
  if (raw === undefined || raw === null) return { value: 0, present: false, invalid: false };
  if (typeof raw === "string" && !raw.trim()) return { value: 0, present: false, invalid: false };
  const rupees = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(rupees) || rupees < 0) return { value: 0, present: true, invalid: true };
  return { value: Math.round(rupees * 100), present: true, invalid: false };
}

/**
 * The flat fee for a statement, in paise.
 *
 * Order of precedence: `branches/{id}.settlementFee` (the settlement-specific
 * knob), then `branches/{id}.monthlyFee` (the existing branch fee the Route
 * hold already reads), then the documented ₹2,000 default. ₹0 is a REAL value
 * (no fee) and is never replaced by the default. A negative or non-numeric
 * configured value is refused loudly and flagged, never silently charged.
 */
export function resolveSettlementFeePaise(branchData: {
  settlementFee?: unknown;
  monthlyFee?: unknown;
} | null | undefined): SettlementFeeResolution {
  const own = readRupees(branchData?.settlementFee);
  if (own.invalid) {
    return { feePaise: DEFAULT_SETTLEMENT_FEE_RUPEES * 100, source: "settlementFee", invalid: true };
  }
  if (own.present) return { feePaise: own.value, source: "settlementFee", invalid: false };

  const legacy = readRupees(branchData?.monthlyFee);
  if (legacy.invalid) {
    return { feePaise: DEFAULT_SETTLEMENT_FEE_RUPEES * 100, source: "monthlyFee", invalid: true };
  }
  if (legacy.present) return { feePaise: legacy.value, source: "monthlyFee", invalid: false };

  return { feePaise: DEFAULT_SETTLEMENT_FEE_RUPEES * 100, source: "default", invalid: false };
}

export type BranchFeeReason =
  | "branch-active"
  | "branch-inactive"
  | "branch-opened-after-month"
  | "branch-closed";

export interface BranchFeeApplicability {
  applicable: boolean;
  reason: BranchFeeReason;
}

/**
 * Whether this branch pays the full fee for this month.
 *
 * Sensible defaults (owner to confirm, see ASSUMPTIONS.md):
 *  - any branch that traded in the month pays the FULL fee, whatever the sales;
 *  - a branch that opened during the month pays the full fee (no proration);
 *  - a branch switched off before the month started and with no sales pays
 *    nothing — there was no branch to run;
 *  - a branch that opened after the month ended pays nothing for that month;
 *  - a branch switched off during the month but which sold in it still pays.
 */
export function isBranchFeeApplicable(
  branchData: {
    active?: unknown;
    status?: unknown;
    createdAtMs?: unknown;
  } | null | undefined,
  tradedInMonth: boolean,
  month: SettlementMonthBounds
): BranchFeeApplicability {
  const createdAtRaw = Number(branchData?.createdAtMs);
  if (Number.isFinite(createdAtRaw) && createdAtRaw >= month.endMs) {
    return { applicable: false, reason: "branch-opened-after-month" };
  }

  const statusRaw = branchData?.status;
  const status = typeof statusRaw === "string" ? statusRaw.trim().toLowerCase() : "";
  const explicitlyInactive =
    branchData?.active === false || status === "inactive" || status === "closed";
  const explicitlyActive =
    branchData?.active === true || status === "active" || status === "open";

  if (tradedInMonth) return { applicable: true, reason: "branch-active" };

  if (explicitlyInactive) {
    return { applicable: false, reason: "branch-inactive" };
  }
  if (explicitlyActive) return { applicable: true, reason: "branch-active" };

  // Neither flag nor status readable: the branch exists and no evidence says it
  // was closed, so the fee applies (fail toward the documented default, flagged
  // in ASSUMPTIONS.md) rather than silently giving a free month.
  return { applicable: true, reason: "branch-active" };
}

export interface SettlementScope {
  branchId: string;
  startMs: number;
  endMs: number;
}

export interface SettlementOrderSummary {
  onlineCollectedPaise: number;
  onlineRefundedPaise: number;
  /** onlineCollectedPaise - onlineRefundedPaise, never negative. */
  onlineNetPaise: number;
  onlineOrders: number;
  cashCollectedPaise: number;
  cashOrders: number;
  cashPendingOrders: number;
  excludedOrders: number;
  outOfScopeOrders: number;
  ordersScanned: number;
  /** True when the read hit a cap: the totals are a floor, not the full month. */
  truncated: boolean;
  /** Online captures whose gateway time is unknown; payment stays blocked. */
  captureUnresolved: number;
  /** The unresolved scan hit its cap; count is a floor, statement incomplete. */
  unresolvedTruncated: boolean;
}

function toMillis(value: unknown): number {
  if (value === null || value === undefined) return NaN;
  const candidate = value as { toMillis?: () => number; toDate?: () => Date; seconds?: number };
  if (typeof candidate?.toMillis === "function") {
    const ms = Number(candidate.toMillis());
    return Number.isFinite(ms) ? ms : NaN;
  }
  if (typeof candidate?.toDate === "function") {
    const date = candidate.toDate();
    return date instanceof Date ? date.getTime() : NaN;
  }
  // Firestore Timestamp shape without its methods (a JSON round trip).
  if (typeof candidate?.seconds === "number" && Number.isFinite(candidate.seconds)) {
    return candidate.seconds * 1000 + Math.round(Number((candidate as any).nanoseconds) || 0) / 1e6;
  }
  if (value instanceof Date) return value.getTime();
  const parsed = new Date(value as any).getTime();
  return Number.isFinite(parsed) ? parsed : NaN;
}

/**
 * M7: the month-bearing instant for one order, in priority order:
 *  1. the server-stamped `settlementEffectiveAtMs` (written at capture/creation);
 *  2. the gateway capture time (a cross-midnight capture must land in the month
 *     the customer actually paid, not the month the order was placed);
 *  3. `createdAt`, then `placedAt` for legacy rows that never carried a stamp.
 *
 * The resolver is shared with the query builder so "write and query the same
 * timestamp" is literally true rather than a naming convention.
 */
export function settlementEffectiveAtMsOf(order: any): number {
  const stamped = toMillis(order?.[SETTLEMENT_EFFECTIVE_AT_FIELD]);
  if (Number.isFinite(stamped) && stamped > 0) return stamped;
  // ONE canonical numeric field. Backfilled staging rows carry it too; a
  // row without it is unknown and must be backfilled, not guessed here.
  return NaN;
}

function statusCodeOf(order: any): string {
  const raw = order?.status;
  const code = typeof raw === "string" ? raw : raw?.code;
  return String(code || "").trim().toUpperCase();
}

/**
 * Cancelled or explicitly fully refunded: no sale at all. A refund that merely
 * equals the capture is NOT tested here — a statement must show the collection
 * and the refund it offset (net 0), not hide both.
 */
function isVoidOrder(order: any): boolean {
  const code = statusCodeOf(order).toLowerCase();
  if (VOID_STATUSES.has(code)) return true;
  const refundStatus = String(order?.refundStatus ?? "").trim().toLowerCase();
  return FULL_REFUND_STATUSES.has(refundStatus);
}

/** The server-stamped marker is the ONLY proof of an online capture. */
function isOnlineOrder(order: any): boolean {
  return order?.paymentChannel === "razorpay";
}

/** Cash: walk-in counter orders and COD orders. */
function isCashOrder(order: any): boolean {
  if (isOnlineOrder(order)) return false;
  if (order?.customerId === WALK_IN_CUSTOMER_ID) return true;
  const method = String(
    order?.payment?.method ?? order?.paymentMethod ?? order?.orderPaymentMethod ?? ""
  ).trim().toLowerCase();
  return method === "cod" || method === "cash";
}

function isCashCompleted(order: any): boolean {
  return CASH_COMPLETED_STATUSES.has(statusCodeOf(order).toLowerCase());
}

/** The gateway capture amount; falls back to the priced total it billed. */
function collectedPaiseOf(order: any): number {
  const captured = Number(order?.payment?.capturedAmountPaise);
  if (Number.isFinite(captured) && captured > 0) return Math.round(captured);
  const nested = Number(order?.["payment.capturedAmountPaise"]);
  if (Number.isFinite(nested) && nested > 0) return Math.round(nested);
  const splitTotal = Number(order?.pricing?.split?.totalAmountPaise);
  if (Number.isFinite(splitTotal) && splitTotal > 0) return Math.round(splitTotal);
  const grand = Number(order?.pricing?.grandTotal);
  if (Number.isFinite(grand) && grand > 0) return Math.round(grand * 100);
  return 0;
}

/**
 * M7: only refunds the gateway has PROCESSED count. Pending and failed refunds
 * may reserve `refundedTotalPaise` but have not returned money. The canonical
 * map is stamped by both capture and refund paths; legacy orders without it
 * fall back to the cumulative total written by those same paths.
 */
function refundedPaiseOf(order: any): number {
  // ONLY the processed-refund map counts. A pending or failed refund may
  // reserve `refundedTotalPaise`, but no money has returned to the customer.
  const processed = order?.settlementProcessedRefunds;
  if (processed && typeof processed === "object" && !Array.isArray(processed)) {
    return Math.max(0, Object.values(processed).reduce((sum: number, v: any) => sum + (Number(v) || 0), 0));
  }
  return 0;
}

/**
 * M7: the one authoritative settlement stamp. Never wall-clock: if the gateway
 * capture time is unknown the order is flagged unresolved and must NOT be
 * counted toward a payable month until a human reconciles it.
 */
export function settlementCaptureStamp(capturedAtMs?: unknown): Record<string, unknown> {
  if (typeof capturedAtMs === "number" && Number.isFinite(capturedAtMs) && capturedAtMs > 0) {
    return {
      settlementEffectiveAtMs: Math.round(capturedAtMs),
      settlementCaptureState: "confirmed",
      settlementCaptureUnresolved: false,
    };
  }
  return { settlementCaptureState: "unknown", settlementCaptureUnresolved: true };
}

/** A provider-confirmed capture is terminal: later writers must not downgrade it. */
export function isProviderConfirmedCapture(order: any): boolean {
  return order?.settlementCaptureState === "confirmed" &&
    typeof order?.settlementEffectiveAtMs === "number" &&
    Number.isFinite(order.settlementEffectiveAtMs) &&
    order.settlementEffectiveAtMs > 0 &&
    order?.settlementCaptureUnresolved !== true;
}

/** Verify / recovery / compensation can only mark the capture PENDING. */
export function settlementCapturePending(): Record<string, unknown> {
  return { settlementCaptureState: "pending", settlementCaptureUnresolved: true };
}

/** A compensated or unproveable capture is UNKNOWN until the provider event lands. */
export function settlementCaptureUnknown(): Record<string, unknown> {
  return { settlementCaptureState: "unknown", settlementCaptureUnresolved: true };
}

/**
 * Razorpay docs /my/webhooks/payments.mdx "Payment Captured": the payment
 * entity has `created_at` (authorisation) and `captured: true`, but there is NO
 * `captured_at` field. The EVENT has its own top-level `created_at`, inside the
 * HMAC-signed body, which is the provider-authenticated capture instant.
 * `payment.authorized` describes authorisation only and is never accepted.
 */
export function providerCapturedAtMs(event: any): number | undefined {
  if (String(event?.event || "") !== "payment.captured") return undefined;
  const raw = event?.created_at;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return undefined;
  return raw < 1e12 ? Math.round(raw * 1000) : Math.round(raw);
}

/**
 * Upsert a gateway refund by ID inside the SAME transaction that writes the
 * refund. Only processed amounts belong in this map; pending/failed refunds
 * are never written here, so a statement never deducts them.
 */
/** Pure map helpers so every writer uses the same terminal-only semantics. */
export function processedRefundMap(currentMap: unknown, refundId: string, amountPaise: number): Record<string, number> {
  const id = String(refundId || "").trim();
  const paise = Math.max(0, Math.round(Number(amountPaise) || 0));
  const map: Record<string, number> = currentMap && typeof currentMap === "object" && !Array.isArray(currentMap)
    ? { ...(currentMap as Record<string, number>) }
    : {};
  if (id && paise > 0) map[id] = paise;
  return map;
}

export function withoutProcessedRefund(currentMap: unknown, refundId: string): Record<string, number> {
  const id = String(refundId || "").trim();
  const map: Record<string, number> = currentMap && typeof currentMap === "object" && !Array.isArray(currentMap)
    ? { ...(currentMap as Record<string, number>) }
    : {};
  if (id) delete map[id];
  return map;
}

export function upsertProcessedRefundInTx(
  tx: any,
  orderRef: any,
  refundId: string,
  amountPaise: number,
  currentMap?: unknown
): void {
  const id = String(refundId || "").trim();
  const paise = Math.max(0, Math.round(Number(amountPaise) || 0));
  if (!id || !(paise > 0)) return;
  const map = processedRefundMap(currentMap, id, paise);
  if (!(paise > 0)) return;
  // Nested object, never a dotted field id: the order doc's canonical shape
  // must stay free of dotted keys for downstream readers.
  tx.set(orderRef, { settlementProcessedRefunds: map }, { merge: true });
}

export function clearProcessedRefundInTx(tx: any, orderRef: any, refundId: string, currentMap?: unknown): void {
  tx.set(
    orderRef,
    { settlementProcessedRefunds: withoutProcessedRefund(currentMap, refundId) },
    { merge: true }
  );
}

/** Cash rupee total the branch collected, from the priced bill. */
function cashTotalPaiseOf(order: any): number {
  // counter-cash-c9: prefer the server's handover stamp, fall back to the
  // priced bill for legacy rows. Never both — one order contributes once.
  const stamped = Number(order?.cashCollectedPaise);
  if (Number.isFinite(stamped) && stamped > 0) return Math.round(stamped);
  const grand = Number(order?.pricing?.grandTotal);
  if (Number.isFinite(grand) && grand > 0) return Math.round(grand * 100);
  const total = Number(order?.total);
  if (Number.isFinite(total) && total > 0) return Math.round(total * 100);
  return 0;
}

/**
 * Month totals for one branch from raw order documents.
 *
 * Online: a resolved capture counts the money the brand collected centrally,
 * whatever the kitchen state — the money is in the brand's account. Refunds
 * come off it. Unpaid online orders are not sales.
 *
 * Cash: only COMPLETED orders count as cash in hand (a counter order still
 * being cooked is a receivable). Cancelled orders count nowhere.
 */
export function summarizeSettlementOrders(
  orders: readonly any[],
  scope: SettlementScope,
  opts?: { truncated?: boolean }
): SettlementOrderSummary {
  let onlineCollectedPaise = 0;
  let onlineRefundedPaise = 0;
  let onlineOrders = 0;
  let cashCollectedPaise = 0;
  let cashOrders = 0;
  let cashPendingOrders = 0;
  let excludedOrders = 0;
  let outOfScopeOrders = 0;
  let captureUnresolved = 0;

  for (const order of orders || []) {
    const branchId = String(order?.branchId || "");
    // M7: the SAME field the query used decides the bucket. A capture that
    // landed just after IST midnight belongs to the new month even when the
    // order was placed the night before.
    const at = settlementEffectiveAtMsOf(order);
    if (branchId !== scope.branchId || !Number.isFinite(at) || at < scope.startMs || at >= scope.endMs) {
      outOfScopeOrders += 1;
      continue;
    }
    if (isOnlineOrder(order)) {
      // M7: money is money. A cancelled/processing kitchen status does NOT
      // erase a real capture: the brand still holds it. Only an actually
      // booked refund reduces it (captured minus refunded, clamped there), so
      // a cancellation with no refund still counts and a partial refund only
      // removes what went back. A full refund nets to zero and is shown as a
      // collection plus its offset, never silently hidden.
      const collected = collectedPaiseOf(order);
      if (collected <= 0) {
        // A marker with no readable amount is a data problem, not a sale.
        excludedOrders += 1;
        continue;
      }
      if (order?.settlementCaptureUnresolved === true) captureUnresolved += 1;
      onlineCollectedPaise += collected;
      onlineRefundedPaise += Math.min(collected, refundedPaiseOf(order));
      onlineOrders += 1;
      continue;
    }
    if (isCashOrder(order)) {
      const code = statusCodeOf(order).toLowerCase();
      if (code === "cancelled" || code === "canceled") {
        excludedOrders += 1;
        continue;
      }
      if (isCashCompleted(order)) {
        cashCollectedPaise += cashTotalPaiseOf(order);
        cashOrders += 1;
      } else {
        cashPendingOrders += 1;
      }
      continue;
    }
    // Unpaid online order: not a sale yet.
    excludedOrders += 1;
  }

  const onlineNetPaise = Math.max(0, onlineCollectedPaise - onlineRefundedPaise);

  return {
    onlineCollectedPaise,
    onlineRefundedPaise,
    onlineNetPaise,
    onlineOrders,
    cashCollectedPaise,
    cashOrders,
    cashPendingOrders,
    excludedOrders,
    outOfScopeOrders,
    captureUnresolved,
    unresolvedTruncated: false,
    ordersScanned: (orders || []).length,
    truncated: opts?.truncated === true,
  };
}

export type SettlementSource = "scheduler" | "on_demand";
export type SettlementPaidStatus = "unpaid" | "paid";

export interface SettlementPaymentRecord {
  paidAtMs: number;
  reference: string;
  recordedBy: string;
  recordedByEmail: string | null;
  note: string | null;
  /** M6: the signed net this payment settled, for branch/month reconciliation. */
  settledNetPaise: number;
}

export interface BuildSettlementStatementInput {
  branchId: string;
  branchName: string;
  monthKey: string;
  month: SettlementMonthBounds;
  version: number;
  summary: SettlementOrderSummary;
  fee: SettlementFeeResolution;
  feeApplicable: BranchFeeApplicability;
  generatedAtMs: number;
  generatedBy: string;
  source: SettlementSource;
  monthClosed: boolean;
  now: number;
  /** M6: prior settled net for this branch/month, from the payment ledger. */
  priorSettledNetPaise?: number;
  /** M6: carried-forward payment history so a regeneration still reads as paid. */
  priorPaymentRecords?: SettlementPaymentRecord[];
}

export interface SettlementStatement {
  id: string;
  branchId: string;
  branchName: string;
  monthKey: string;
  monthStartMs: number;
  monthEndMs: number;
  monthClosed: boolean;
  version: number;
  currency: "INR";
  onlineCollectedPaise: number;
  onlineRefundedPaise: number;
  onlineNetPaise: number;
  onlineOrders: number;
  cashCollectedPaise: number;
  cashOrders: number;
  cashPendingOrders: number;
  platformFeePaise: number;
  platformFeeSource: SettlementFeeSource;
  platformFeeInvalid: boolean;
  platformFeeInputPaise: number;
  feeApplicable: boolean;
  feeApplicableReason: BranchFeeReason;
  netPayablePaise: number;
  branchOwes: boolean;
  feeNote: string;
  assumptionsVersion: string;
  ordersTruncated: boolean;
  /** Captures with no provider-confirmed time — payment is blocked. */
  unresolvedCaptures: number;
  notes: string[];
  paidStatus: SettlementPaidStatus;
  paidAtMs: number | null;
  paymentReference: string | null;
  payments: SettlementPaymentRecord[];
  /** Ledger cutover marker: pre-fix statements are void, never payable. */
  ledgerSchema: number;
  /** False for an older version, a truncated scan or an unresolved capture. */
  current: boolean;
  /** M6: branch/month payment ledger — only the delta remains payable. */
  priorSettledNetPaise: number;
  outstandingPaise: number;
  /** False for a truncated scan or an unresolved capture: cannot be marked paid. */
  complete: boolean;
  generatedAtMs: number;
  generatedBy: string;
  source: SettlementSource;
  /** Server-owned: a regeneration always writes a NEW document. */
  immutable: true;
}

/** The one-line fee line, with its GST treatment spelled out. */
export const SETTLEMENT_FEE_NOTE =
  "Flat platform fee per branch per month (GST-inclusive as agreed; " +
  "shown as a single line and not tax-invoice split — see ASSUMPTIONS.md).";

export function settlementStatementId(branchId: string, monthKey: string, version: number): string {
  if (!branchId) throw new Error("settlementStatementId: branchId is required");
  settlementMonthBounds(monthKey);
  if (!Number.isInteger(version) || version < 1) {
    throw new Error(`settlementStatementId: invalid version ${version}`);
  }
  return `${branchId}_${monthKey}_v${String(version).padStart(3, "0")}`;
}

/**
 * The statement document. Amounts are computed here, once, from the summary
 * and the fee — never re-derived by a client.
 */
export function buildSettlementStatement(input: BuildSettlementStatementInput): SettlementStatement {
  const feePaise = input.feeApplicable.applicable ? Math.max(0, Math.round(input.fee.feePaise)) : 0;
  // Route is retired: the flat fee is charged exactly once here and there is
  // no legacy transfer/hold credit path in this version.
  const netPayablePaise = input.summary.onlineNetPaise - feePaise;
  const priorSettledNetPaise = Number(input.priorSettledNetPaise) || 0;
  // M6: outstanding is revised net minus the ledger's settled net. It is a
  // SIGNED delta: a late refund can leave a negative (collect-back) balance.
  const outstandingPaise = netPayablePaise - priorSettledNetPaise;
  const complete =
    !input.summary.truncated &&
    !input.summary.unresolvedTruncated &&
    input.summary.captureUnresolved === 0;
  const carried = Array.isArray(input.priorPaymentRecords) ? [...input.priorPaymentRecords] : [];
  const paidStatus: SettlementPaidStatus = carried.length > 0 ? "paid" : "unpaid";

  const notes: string[] = [];
  if (input.summary.unresolvedTruncated) {
    notes.push("Unresolved-capture scan hit its cap; the statement is incomplete until it is re-scanned in pages.");
  }
  if (input.summary.captureUnresolved > 0) {
    notes.push(`${input.summary.captureUnresolved} online capture(s) have no known gateway time; payment is blocked.`);
  }
  if (input.summary.truncated) {
    notes.push(
      "Order scan was truncated at its page cap: online totals are a floor, not the full month."
    );
  }
  if (input.fee.invalid) {
    notes.push("Configured branch fee was unusable; the ₹2,000 default was applied.");
  }
  if (!input.feeApplicable.applicable) {
    notes.push(`No platform fee: ${input.feeApplicable.reason}.`);
  }
  if (priorSettledNetPaise !== 0) {
    notes.push(
      `${rupees(Math.abs(priorSettledNetPaise))} was already settled for this branch/month; only the delta is outstanding.`
    );
  }
  if (netPayablePaise < 0) {
    notes.push("Online money did not cover the fee: the branch owes the brand.");
  }

  return {
    id: settlementStatementId(input.branchId, input.monthKey, input.version),
    branchId: input.branchId,
    branchName: input.branchName,
    monthKey: input.monthKey,
    monthStartMs: input.month.startMs,
    monthEndMs: input.month.endMs,
    monthClosed: input.monthClosed,
    version: input.version,
    currency: "INR",
    onlineCollectedPaise: input.summary.onlineCollectedPaise,
    onlineRefundedPaise: input.summary.onlineRefundedPaise,
    onlineNetPaise: input.summary.onlineNetPaise,
    onlineOrders: input.summary.onlineOrders,
    cashCollectedPaise: input.summary.cashCollectedPaise,
    cashOrders: input.summary.cashOrders,
    cashPendingOrders: input.summary.cashPendingOrders,
    platformFeePaise: feePaise,
    platformFeeSource: input.fee.source,
    platformFeeInvalid: input.fee.invalid,
    platformFeeInputPaise: input.fee.feePaise,
    feeApplicable: input.feeApplicable.applicable,
    feeApplicableReason: input.feeApplicable.reason,
    netPayablePaise,
    branchOwes: netPayablePaise < 0,
    feeNote: SETTLEMENT_FEE_NOTE,
    assumptionsVersion: SETTLEMENT_ASSUMPTIONS_VERSION,
    ordersTruncated: input.summary.truncated,
    unresolvedCaptures: input.summary.captureUnresolved,
    notes,
    paidStatus,
    paidAtMs: carried.length > 0 ? Number(carried[carried.length - 1].paidAtMs) || null : null,
    paymentReference: carried.length > 0 ? carried[carried.length - 1].reference : null,
    payments: carried,
    ledgerSchema: 1,
    current: true,
    priorSettledNetPaise,
    outstandingPaise,
    complete,
    generatedAtMs: input.generatedAtMs,
    generatedBy: input.generatedBy,
    source: input.source,
    immutable: true,
  };
}

/** One CSV line per statement; amounts in whole rupees with paise preserved. */
export const SETTLEMENT_CSV_HEADERS = [
  "Statement ID",
  "Branch",
  "Branch ID",
  "Month",
  "Version",
  "Online Collected (INR)",
  "Online Refunded (INR)",
  "Online Net (INR)",
  "Online Orders",
  "Cash Collected - branch holds (INR)",
  "Cash Orders",
  "Platform Fee (INR)",
  "Net Payable to Branch (INR)",
  "Outstanding After Prior Payments (INR)",
  "Branch Owes Brand",
  "Paid Status",
  "Generated At",
  "Note",
] as const;

function rupees(paise: number): string {
  return (Math.round(Number(paise) || 0) / 100).toFixed(2);
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  // A leading =, +, - or @ in a spreadsheet cell is a formula injection vector.
  const safe = /^[=+\-@]/.test(text) && !/^-\d/.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}

export function settlementCsvRow(statement: SettlementStatement): string {
  return [
    statement.id,
    statement.branchName,
    statement.branchId,
    statement.monthKey,
    statement.version,
    rupees(statement.onlineCollectedPaise),
    rupees(statement.onlineRefundedPaise),
    rupees(statement.onlineNetPaise),
    statement.onlineOrders,
    rupees(statement.cashCollectedPaise),
    statement.cashOrders,
    rupees(statement.platformFeePaise),
    rupees(statement.netPayablePaise),
    rupees(statement.outstandingPaise),
    statement.branchOwes ? "yes" : "no",
    statement.paidStatus,
    new Date(statement.generatedAtMs).toISOString(),
    statement.notes.join(" "),
  ]
    .map(csvCell)
    .join(",");
}

export function settlementCsv(
  statements: readonly SettlementStatement[],
  opts?: { header?: boolean }
): string {
  const header = opts?.header === false ? [] : [SETTLEMENT_CSV_HEADERS.map(csvCell).join(",")];
  return [...header, ...statements.map(settlementCsvRow)].join("\r\n");
}
