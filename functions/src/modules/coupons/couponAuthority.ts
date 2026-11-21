import * as admin from "firebase-admin";
import { db } from "../../core/firebase";
import { COUPON_RESERVATION_TTL_MS } from "../payments/lifetimes";

/**
 * THE coupon authority. One collection (`coupons`), one formula, one
 * redemption ledger (`coupon_redemptions`), one place that decides whether a
 * code is usable and how many rupees it takes off.
 *
 * Why this module exists (audit 2026-11-20, §1.6): the customer app previewed
 * discounts from `petpooja_offers` (a collection nothing writes) while the
 * server charged from `coupons` — two authorities, two answers, and a customer
 * could be shown "You saved ₹150" and then charged full price. The client also
 * decided its own preview total. Both paths are gone: the client asks the
 * server, and only this module computes a discount.
 *
 * The rules for a coupon are deliberately small and explicit (owner decision
 * 2026-11-20: offers ship, loyalty does not):
 *
 *   code             the document id, upper-cased
 *   discountType     "percent" | "flat"
 *   value            percent points, or rupees for a flat coupon
 *   minOrder         food subtotal (₹, GST-inclusive) required to use it
 *   maxDiscount      rupee ceiling for a percent coupon (null = no ceiling)
 *   validFrom/validTo  absolute window; both ends inclusive
 *   perCustomerLimit max redemptions by one customer (null = unlimited)
 *   totalCap         max redemptions overall (null = unlimited)
 *   branchScope      "all" or a list of branch ids
 *   customerScope    a single uid when the coupon was issued to one customer
 *   active           the kill switch staff flip in the Partner app
 *
 * Redemption is ATOMIC and IDEMPOTENT. A slot is held the moment a payment
 * intent becomes payable (`reserveCouponInTx`, inside the same transaction that
 * stamps the server price on the order), committed when the payment is
 * confirmed, and released when the order is cancelled, the payment fails or the
 * intent expires. Every counter lives on a single document per coupon (and per
 * coupon+customer), so two concurrent checkouts CONFLICT instead of both
 * reading "one left" — the double-redemption bug is closed by construction.
 *
 * A `reserved` slot that is never committed or released (a process died
 * mid-checkout) ages out on its own TTL: usage counts only live reservations
 * plus committed ones, so an abandoned checkout cannot permanently burn the
 * last slot.
 */

export const COUPONS = "coupons";
export const COUPON_REDEMPTIONS = "coupon_redemptions";
export const COUPON_STATS = "coupon_stats";
export const COUPON_CUSTOMER_USAGE = "coupon_customer_usage";
export const COUPON_ISSUES = "coupon_issues";

export { COUPON_RESERVATION_TTL_MS };

export type CouponDiscountType = "percent" | "flat";

export interface Coupon {
  code: string;
  active: boolean;
  discountType: CouponDiscountType;
  /** Percent points (percent coupon) or rupees (flat coupon). */
  value: number;
  /** Rupee ceiling for a percent coupon. null = uncapped. */
  maxDiscount: number | null;
  /** Minimum food subtotal in rupees. */
  minOrder: number;
  validFromMs: number | null;
  validToMs: number | null;
  perCustomerLimit: number | null;
  totalCap: number | null;
  branchScope: "all" | string[];
  /** A single uid, when the coupon was issued to one customer. */
  customerScope: string | null;
  title: string;
  createdBy: string | null;
  createdAtMs: number | null;
}

export type CouponReason =
  | "OK"
  | "COUPON_INVALID"
  | "COUPON_INACTIVE"
  | "COUPON_NOT_STARTED"
  | "COUPON_EXPIRED"
  | "MIN_ORDER_NOT_MET"
  | "COUPON_BRANCH_MISMATCH"
  | "COUPON_CUSTOMER_MISMATCH"
  | "COUPON_PER_CUSTOMER_LIMIT"
  | "COUPON_SIGN_IN_REQUIRED"
  | "COUPON_EXHAUSTED"
  | "COUPON_NO_DISCOUNT"
  | "COUPON_USAGE_UNAVAILABLE";

export interface CouponEvaluation {
  eligible: boolean;
  discount: number;
  reason: CouponReason;
  message: string;
}

/** Customer-facing copy. One place, so the app never invents its own text. */
export const COUPON_MESSAGES: Record<CouponReason, string> = {
  OK: "Coupon applied.",
  COUPON_INVALID: "That code isn't valid. Check the spelling and try again.",
  COUPON_INACTIVE: "This coupon is no longer active.",
  COUPON_NOT_STARTED: "This coupon isn't available yet.",
  COUPON_EXPIRED: "This coupon has expired.",
  MIN_ORDER_NOT_MET: "Your order is below the minimum for this coupon.",
  COUPON_BRANCH_MISMATCH: "This coupon isn't valid at this store.",
  COUPON_CUSTOMER_MISMATCH: "This coupon was issued to a different account.",
  COUPON_PER_CUSTOMER_LIMIT: "You have already used this coupon.",
  COUPON_SIGN_IN_REQUIRED: "Sign in to use this coupon — it is limited per customer.",
  COUPON_EXHAUSTED: "This coupon has been fully redeemed.",
  COUPON_NO_DISCOUNT:
    "This coupon doesn't take anything off this order, so it can't be applied.",
  COUPON_USAGE_UNAVAILABLE:
    "We couldn't check this coupon just now — please try again in a moment.",
};

export function couponMessage(reason: CouponReason): string {
  return COUPON_MESSAGES[reason] ?? COUPON_MESSAGES.COUPON_INVALID;
}

/**
 * Every reason a coupon can be REFUSED with, plus the order/coupon conflicts
 * `reserveCouponInTx` raises. Callers must pass these back to the customer
 * verbatim; they are never infrastructure failures.
 *
 * Explicit rather than `startsWith("COUPON_")` because `MIN_ORDER_NOT_MET` does
 * not carry the prefix — matching the prefix alone turned "add ₹99 more" into
 * "payment service temporarily unavailable".
 */
export const COUPON_REFUSAL_CODES = new Set<string>([
  "COUPON_INVALID",
  "COUPON_INACTIVE",
  "COUPON_NOT_STARTED",
  "COUPON_EXPIRED",
  "MIN_ORDER_NOT_MET",
  "COUPON_BRANCH_MISMATCH",
  "COUPON_CUSTOMER_MISMATCH",
  "COUPON_PER_CUSTOMER_LIMIT",
  "COUPON_SIGN_IN_REQUIRED",
  "COUPON_EXHAUSTED",
  "COUPON_NO_DISCOUNT",
  "COUPON_USAGE_UNAVAILABLE",
  "COUPON_ORDER_CONFLICT",
  "COUPON_PRICE_CHANGED",
  // The Partner till has no coupon control (F9, 2026-11-22). A coupon sent by
  // a walk-in caller is a known, customer/staff-facing refusal, not an outage.
  "COUPON_NOT_SUPPORTED_FOR_WALKIN",
  "ORDER_ID_REQUIRED",
]);

/**
 * True when an error thrown while reserving a coupon is the CUSTOMER's to fix
 * (400/409) rather than an infrastructure failure. `createPaymentOrder` uses
 * this to rethrow the authority's message instead of masking it behind a 503.
 */
export function isCouponRefusal(err: any): boolean {
  if (!err || typeof err.code !== "string") return false;
  const status = Number(err.statusCode);
  if (status !== 400 && status !== 409) return false;
  return COUPON_REFUSAL_CODES.has(err.code);
}

/** The document id for a code. Codes are case-insensitive; storage is upper. */
export function normalizeCouponCode(raw: unknown): string {
  return String(raw ?? "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "")
    .slice(0, 64);
}

/**
 * A per-customer limit needs a real identity. The payments lane labels an
 * unauthenticated payer "guest", which is a sentinel, not a person — treating it
 * as one would give every guest in the country a shared quota.
 */
export function normalizeCouponCustomer(raw: unknown): string | null {
  const value = String(raw ?? "").trim();
  if (!value || value === "guest") return null;
  return value;
}

function finiteNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Firestore Timestamp | ISO string | epoch ms → epoch ms (null when absent). */
function toEpochMs(value: any): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof value?.toMillis === "function") {
    const ms = value.toMillis();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value?.toDate === "function") {
    const date = value.toDate();
    return date instanceof Date && Number.isFinite(date.getTime()) ? date.getTime() : null;
  }
  if (typeof value?.seconds === "number") return value.seconds * 1000;
  if (typeof value?._seconds === "number") return value._seconds * 1000;
  return null;
}

/**
 * A stored counter read as a whole number, or null for "no limit".
 *
 * F1 (staging 2026-11-21): `createCoupon` writes an EXPLICIT `maxDiscount: null`
 * for a flat coupon and for a percent coupon created without a cap, and this
 * helper used to run it through `Number()` — `Number(null)` is 0, finite and
 * non-negative, so "no cap" was stored as a cap of ZERO and every discount was
 * clamped to nothing while still answering "Coupon applied.". An ABSENT field
 * behaved correctly (`Number(undefined)` is NaN), which is exactly why the bug
 * was easy to miss.
 *
 * An explicit null, an empty string or any other absent marker therefore means
 * "no limit", never "zero of something".
 */
function positiveIntOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = finiteNumber(value);
  if (n === null || n < 0) return null;
  return Math.floor(n);
}

/**
 * Reads a coupon document into the canonical shape.
 *
 * Legacy shapes are ACCEPTED, not silently reinterpreted: the pre-2026-11-20
 * documents used `discount`/`value`/`amount` for the number, `type`/
 * `discountType` for "percent", `expiresAt` for the end of the window and
 * `branchId` for a single branch. Reading them through one normaliser means an
 * existing seeded code keeps working and there is still only one formula.
 * Returns null when the document cannot be a coupon at all (no numeric value).
 */
export function normalizeCoupon(code: string, raw: any): Coupon | null {
  if (!raw || typeof raw !== "object") return null;
  // The code is informational for evaluation; legacy documents written before
  // the canonical shape may omit it, so an empty code is not a refusal here.
  // Callers that need the id (management routes, redemptions) supply it.
  const normalizedCode = normalizeCouponCode(raw.code ?? code);

  const rawType = String(raw.discountType ?? raw.type ?? "").toLowerCase();
  const value =
    finiteNumber(raw.value) ?? finiteNumber(raw.discount) ?? finiteNumber(raw.amount);
  const discountType: CouponDiscountType = rawType === "percent" ? "percent" : "flat";

  // A percent coupon with no number is unusable; a flat coupon with no number
  // is unusable too. Never treat a missing value as "free".
  if (value === null || value <= 0) return null;

  const branchScopeRaw = raw.branchScope ?? raw.branchIds ?? raw.branchId;
  let branchScope: "all" | string[] = "all";
  if (Array.isArray(branchScopeRaw)) {
    branchScope = branchScopeRaw.map((b: any) => String(b)).filter(Boolean);
  } else if (typeof branchScopeRaw === "string" && branchScopeRaw.trim()) {
    // "all" is the canonical all-branches value, not a branch named "all".
    branchScope =
      branchScopeRaw.trim().toLowerCase() === "all" ? "all" : [branchScopeRaw.trim()];
  }

  const validFromMs = toEpochMs(raw.validFrom ?? raw.startsAt ?? raw.validFromMs);
  const validToMs = toEpochMs(
    raw.validTo ?? raw.expiresAt ?? raw.validUntil ?? raw.validToMs
  );

  return {
    code: normalizedCode,
    active: raw.active !== false,
    discountType,
    value,
    maxDiscount: positiveIntOrNull(raw.maxDiscount),
    minOrder: Math.max(0, finiteNumber(raw.minOrder ?? raw.min_order) ?? 0),
    validFromMs,
    validToMs,
    perCustomerLimit: positiveIntOrNull(
      raw.perCustomerLimit ?? raw.perCustomer ?? raw.usageLimitPerCustomer
    ),
    totalCap: positiveIntOrNull(raw.totalCap ?? raw.usageLimit ?? raw.maxRedemptions),
    branchScope,
    customerScope:
      typeof raw.customerScope === "string" && raw.customerScope.trim()
        ? raw.customerScope.trim()
        : typeof raw.customerId === "string" && raw.customerId.trim()
          ? raw.customerId.trim()
          : null,
    title: String(raw.title ?? raw.name ?? "").trim() || normalizedCode,
    createdBy: typeof raw.createdBy === "string" ? raw.createdBy : null,
    createdAtMs: toEpochMs(raw.createdAtMs ?? raw.createdAt),
  };
}

export interface CouponEvaluationContext {
  foodSubtotal: number;
  branchId?: string | null;
  nowMs: number;
  customerId?: string | null;
  /** Committed + live-reserved redemptions of this coupon (all customers). */
  totalUsed?: number;
  /** Committed + live-reserved redemptions by this customer. */
  customerUsed?: number;
}

/**
 * The ONE eligibility + discount formula. Pure: no I/O, clock passed in.
 *
 * The discount is bounded three ways and can never exceed the food subtotal:
 * percent points are clamped to (0,100], `maxDiscount` caps a percent coupon,
 * and a flat coupon is capped at what the customer is actually buying. A
 * corrupt document therefore cannot inflate the bill or produce a negative one.
 */
export function evaluateCoupon(
  coupon: Coupon | null,
  ctx: CouponEvaluationContext
): CouponEvaluation {
  const fail = (reason: CouponReason, message?: string): CouponEvaluation => ({
    eligible: false,
    discount: 0,
    reason,
    message: message ?? couponMessage(reason),
  });

  if (!coupon) return fail("COUPON_INVALID");
  if (!coupon.active) return fail("COUPON_INACTIVE");

  const nowMs = ctx.nowMs;
  if (coupon.validFromMs !== null && nowMs < coupon.validFromMs) {
    return fail("COUPON_NOT_STARTED");
  }
  if (coupon.validToMs !== null && nowMs > coupon.validToMs) {
    return fail("COUPON_EXPIRED");
  }

  if (
    coupon.customerScope &&
    String(ctx.customerId ?? "") !== coupon.customerScope
  ) {
    return fail("COUPON_CUSTOMER_MISMATCH");
  }

  if (coupon.branchScope !== "all") {
    const branchId = String(ctx.branchId ?? "");
    if (!branchId || !coupon.branchScope.includes(branchId)) {
      return fail("COUPON_BRANCH_MISMATCH");
    }
  }

  const subtotal = Math.max(0, Number(ctx.foodSubtotal) || 0);
  if (subtotal < coupon.minOrder) {
    const shortfall = Math.round((coupon.minOrder - subtotal) * 100) / 100;
    return fail(
      "MIN_ORDER_NOT_MET",
      `Add items worth ₹${shortfall} more to use this coupon.`
    );
  }

  if (
    coupon.totalCap !== null &&
    Math.max(0, Number(ctx.totalUsed) || 0) >= coupon.totalCap
  ) {
    return fail("COUPON_EXHAUSTED");
  }

  if (
    coupon.perCustomerLimit !== null &&
    !ctx.customerId
  ) {
    // The limit is per ACCOUNT. Without an identity the server cannot enforce
    // it, and a guest could redeem a one-per-customer code forever. Refuse
    // rather than quietly hand out an unlimited coupon.
    return fail("COUPON_SIGN_IN_REQUIRED");
  }

  if (
    coupon.perCustomerLimit !== null &&
    ctx.customerId &&
    Math.max(0, Number(ctx.customerUsed) || 0) >= coupon.perCustomerLimit
  ) {
    return fail("COUPON_PER_CUSTOMER_LIMIT");
  }

  const raw =
    coupon.discountType === "percent"
      ? Math.round((subtotal * Math.min(100, Math.max(0, coupon.value))) / 100)
      : Math.round(coupon.value);
  const capped =
    coupon.maxDiscount !== null ? Math.min(raw, coupon.maxDiscount) : raw;
  const discount = Math.max(0, Math.min(capped, subtotal));

  // F1 (staging 2026-11-21): "Coupon applied." may only be said when money
  // actually comes off. A coupon that would take ₹0 (a corrupt document, a
  // percentage that rounds to nothing on a small bill, or a cap of 0) is
  // REFUSED with its own reason, so the customer is never told a discount
  // applied while paying full price.
  if (discount <= 0) {
    return fail("COUPON_NO_DISCOUNT");
  }

  return {
    eligible: true,
    discount,
    reason: "OK",
    message: couponMessage("OK"),
  };
}

// ---------------------------------------------------------------------------
// Usage counters
// ---------------------------------------------------------------------------

interface UsageCounter {
  committed: number;
  reservations: Record<string, { expiresAtMs: number }>;
}

function counterFrom(data: any): UsageCounter {
  const reservations: Record<string, { expiresAtMs: number }> = {};
  const raw = data?.reservations;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [key, value] of Object.entries(raw as Record<string, any>)) {
      const expiresAtMs = Number((value as any)?.expiresAtMs);
      if (Number.isFinite(expiresAtMs)) reservations[key] = { expiresAtMs };
    }
  }
  return {
    committed: Math.max(0, Math.floor(Number(data?.committed) || 0)),
    reservations,
  };
}

/** Committed + live-reserved. An expired reservation no longer holds a slot. */
export function liveUsage(counter: UsageCounter, nowMs: number): number {
  let live = 0;
  for (const entry of Object.values(counter.reservations)) {
    if (entry.expiresAtMs > nowMs) live += 1;
  }
  return counter.committed + live;
}

export function couponStatsRef(code: string): any {
  return db.collection(COUPON_STATS).doc(normalizeCouponCode(code));
}

export function couponUsageRef(code: string, customerId: string): any {
  const safe = String(customerId).replace(/[^A-Za-z0-9_-]/g, "_");
  return db.collection(COUPON_CUSTOMER_USAGE).doc(`${normalizeCouponCode(code)}__${safe}`);
}

export function couponRedemptionId(orderId: string): string {
  return String(orderId || "").replace(/[^A-Za-z0-9_-]/g, "_");
}

function deleteField(): any {
  const fieldValue: any = (admin as any)?.firestore?.FieldValue;
  if (fieldValue && typeof fieldValue.delete === "function") return fieldValue.delete();
  return { __fieldDelete: true };
}

/** Reads the coupon document. Throws only on a datastore failure. */
export async function readCoupon(code: string): Promise<Coupon | null> {
  const normalized = normalizeCouponCode(code);
  if (!normalized) return null;
  const snap = await db.collection(COUPONS).doc(normalized).get();
  if (!snap.exists) return null;
  return normalizeCoupon(normalized, snap.data());
}

export interface CouponUsageSnapshot {
  totalUsed: number;
  customerUsed: number;
}

/** Reads both usage counters. Failure is an outage, never "unused". */
export async function readCouponUsage(
  code: string,
  customerId?: string | null,
  nowMs: number = Date.now()
): Promise<CouponUsageSnapshot> {
  const statsSnap = await couponStatsRef(code).get();
  const stats = counterFrom(statsSnap.exists ? statsSnap.data() : null);
  let customerUsed = 0;
  if (customerId) {
    const usageSnap = await couponUsageRef(code, customerId).get();
    customerUsed = liveUsage(counterFrom(usageSnap.exists ? usageSnap.data() : null), nowMs);
  }
  return { totalUsed: liveUsage(stats, nowMs), customerUsed };
}

// ---------------------------------------------------------------------------
// Quote (the customer app's only preview)
// ---------------------------------------------------------------------------

export interface CouponQuoteInput {
  code: string;
  foodSubtotal: number;
  branchId?: string | null;
  customerId?: string | null;
  nowMs?: number;
}

export interface CouponQuote extends CouponEvaluation {
  code: string;
  title: string;
  subtotal: number;
  /** Food subtotal after the server's discount. Never negative. */
  totalAfterDiscount: number;
}

/**
 * The authoritative preview. Reads the coupon AND its usage counters, so a
 * per-customer limit or an exhausted cap is reported here instead of surfacing
 * as a refusal at payment.
 */
export async function quoteCoupon(input: CouponQuoteInput): Promise<CouponQuote> {
  const code = normalizeCouponCode(input.code);
  const nowMs = input.nowMs ?? Date.now();
  const subtotal = Math.max(0, Number(input.foodSubtotal) || 0);
  const customerId = normalizeCouponCustomer(input.customerId);
  const coupon = await readCoupon(code);
  if (!coupon) {
    return {
      code,
      title: code,
      subtotal,
      totalAfterDiscount: subtotal,
      ...evaluateCoupon(null, { foodSubtotal: subtotal, nowMs }),
    };
  }
  let usage: CouponUsageSnapshot;
  try {
    usage = await readCouponUsage(code, customerId, nowMs);
  } catch {
    return {
      code,
      title: coupon.title,
      subtotal,
      totalAfterDiscount: subtotal,
      eligible: false,
      discount: 0,
      reason: "COUPON_USAGE_UNAVAILABLE",
      message: couponMessage("COUPON_USAGE_UNAVAILABLE"),
    };
  }
  const evaluation = evaluateCoupon(coupon, {
    foodSubtotal: subtotal,
    branchId: input.branchId,
    customerId,
    nowMs,
    totalUsed: usage.totalUsed,
    customerUsed: usage.customerUsed,
  });
  return {
    code: coupon.code,
    title: coupon.title,
    subtotal,
    totalAfterDiscount: Math.max(0, Math.round((subtotal - evaluation.discount) * 100) / 100),
    ...evaluation,
  };
}

// ---------------------------------------------------------------------------
// Reserve / commit / release
// ---------------------------------------------------------------------------

export interface CouponReservation {
  code: string;
  orderId: string;
  customerId: string;
  branchId: string | null;
  discount: number;
  status: "reserved" | "committed" | "released";
  reservedAtMs: number;
  expiresAtMs: number;
  committedAtMs?: number;
  releasedAtMs?: number;
  releaseReason?: string;
}

function couponError(
  code: string,
  message: string,
  statusCode: number
): Error & { code: string; statusCode: number } {
  const err = new Error(message) as Error & { code: string; statusCode: number };
  err.code = code;
  err.statusCode = statusCode;
  return err;
}

/**
 * Holds one redemption for `orderId` and re-validates the coupon, INSIDE the
 * caller's transaction. All reads happen before any write, as Firestore
 * requires. Two concurrent checkouts of the same last slot conflict on the
 * stats document and the loser is re-run against the winner's write — so the
 * cap and the per-customer limit cannot both be satisfied twice.
 *
 * Throws a typed 400 for an ineligible coupon (the caller has minted nothing
 * yet) and rethrows datastore failures untouched.
 */
export async function reserveCouponInTx(
  tx: any,
  params: {
    code: string;
    orderId: string;
    customerId: string;
    branchId?: string | null;
    foodSubtotal: number;
    /** The discount the caller already priced the order with, in rupees. */
    expectedDiscount: number;
    nowMs?: number;
  }
): Promise<CouponReservation> {
  const code = normalizeCouponCode(params.code);
  const nowMs = params.nowMs ?? Date.now();
  const orderId = String(params.orderId || "").trim();
  if (!code) throw couponError("COUPON_INVALID", couponMessage("COUPON_INVALID"), 400);
  if (!orderId) {
    throw couponError("ORDER_ID_REQUIRED", "orderId is required", 400);
  }

  const couponSnap = await tx.get(db.collection(COUPONS).doc(code));
  const coupon = couponSnap.exists ? normalizeCoupon(code, couponSnap.data()) : null;
  // "guest" is a sentinel, not an identity: a per-customer limit cannot be
  // enforced for it, and the authority refuses such a coupon instead of giving
  // every guest a shared quota.
  const customerId = normalizeCouponCustomer(params.customerId);

  const statsRef = couponStatsRef(code);
  const statsSnap = await tx.get(statsRef);
  const stats = counterFrom(statsSnap.exists ? statsSnap.data() : null);

  const usageRef = customerId ? couponUsageRef(code, customerId) : null;
  const usageSnap = usageRef ? await tx.get(usageRef) : null;
  const usage = counterFrom(usageSnap?.exists ? usageSnap.data() : null);

  const redemptionRef = db
    .collection(COUPON_REDEMPTIONS)
    .doc(couponRedemptionId(orderId));
  const existingSnap = await tx.get(redemptionRef);
  const existing = (existingSnap.exists ? existingSnap.data() : null) as
    | CouponReservation
    | null;

  // Idempotent retry: this order already holds (or spent) a slot.
  if (existing && existing.status !== "released") {
    if (existing.code !== code) {
      throw couponError(
        "COUPON_ORDER_CONFLICT",
        "A different coupon is already attached to this order — refresh checkout.",
        409
      );
    }
    return existing;
  }

  const evaluation = evaluateCoupon(coupon, {
    foodSubtotal: params.foodSubtotal,
    branchId: params.branchId,
    customerId,
    nowMs,
    totalUsed: liveUsage(stats, nowMs),
    customerUsed: liveUsage(usage, nowMs),
  });
  if (!evaluation.eligible) {
    throw couponError(evaluation.reason, evaluation.message, 400);
  }
  // Fail closed if the bill the customer is about to pay was priced with a
  // different discount than the one this transaction just proved.
  if (Math.round(evaluation.discount * 100) !== Math.round(params.expectedDiscount * 100)) {
    throw couponError(
      "COUPON_PRICE_CHANGED",
      "This coupon's value changed — please review the new total and try again.",
      409
    );
  }

  const reservation: CouponReservation = {
    code,
    orderId,
    customerId: customerId ?? "",
    branchId: params.branchId ? String(params.branchId) : null,
    discount: evaluation.discount,
    status: "reserved",
    reservedAtMs: nowMs,
    expiresAtMs: nowMs + COUPON_RESERVATION_TTL_MS,
  };

  const expiresAtMs = reservation.expiresAtMs;
  tx.set(
    statsRef,
    {
      code,
      committed: stats.committed,
      reservations: {
        ...stats.reservations,
        [couponRedemptionId(orderId)]: { expiresAtMs },
      },
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
  if (usageRef) {
    tx.set(
      usageRef,
      {
        code,
        customerId: reservation.customerId,
        committed: usage.committed,
        reservations: {
          ...usage.reservations,
          [couponRedemptionId(orderId)]: { expiresAtMs },
        },
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  }
  tx.set(redemptionRef, reservation, { merge: true });
  return reservation;
}

/** Convenience wrapper that owns its transaction (used outside a wider tx). */
export async function reserveCoupon(params: {
  code: string;
  orderId: string;
  customerId: string;
  branchId?: string | null;
  foodSubtotal: number;
  expectedDiscount: number;
  nowMs?: number;
}): Promise<CouponReservation> {
  return db.runTransaction((tx: any) => reserveCouponInTx(tx, params));
}

/**
 * Marks the redemption `committed`. Idempotent: a replay is a no-op, and a
 * released redemption is never resurrected (the slot was returned).
 */
export async function commitCouponRedemption(
  orderId: string
): Promise<"committed" | "noop" | "none"> {
  const id = couponRedemptionId(orderId);
  if (!id) return "none";
  return db.runTransaction(async (tx: any) => {
    const ref = db.collection(COUPON_REDEMPTIONS).doc(id);
    const snap = await tx.get(ref);
    if (!snap.exists) return "none";
    const redemption = snap.data() as CouponReservation;
    if (!redemption || redemption.status !== "reserved") return "noop";

    const statsRef = couponStatsRef(redemption.code);
    const statsSnap = await tx.get(statsRef);
    const stats = counterFrom(statsSnap.exists ? statsSnap.data() : null);

    const usageRef = redemption.customerId
      ? couponUsageRef(redemption.code, redemption.customerId)
      : null;
    const usageSnap = usageRef ? await tx.get(usageRef) : null;
    const usage = counterFrom(usageSnap?.exists ? usageSnap.data() : null);

    tx.set(
      ref,
      {
        status: "committed",
        committedAtMs: Date.now(),
      },
      { merge: true }
    );
    // The reservation becomes a committed use: the live entry is dropped and
    // `committed` incremented in the same write, so the total is unchanged.
    tx.set(
      statsRef,
      {
        code: redemption.code,
        committed: stats.committed + 1,
        reservations: { [id]: deleteField() },
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    if (usageRef) {
      tx.set(
        usageRef,
        {
          code: redemption.code,
          customerId: redemption.customerId,
          committed: usage.committed + 1,
          reservations: { [id]: deleteField() },
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    }
    return "committed";
  });
}

/**
 * Returns a held slot. Called when the payment fails, the order is cancelled
 * before preparation, or the intent expires. Idempotent: releasing twice, or
 * releasing a redemption that never existed, is a no-op — a replay can never
 * inflate availability.
 *
 * Never throws: callers are post-commit side effects that must not fail a
 * cancellation. A datastore fault is reported through the return value.
 */
export async function releaseCouponRedemption(params: {
  orderId: string;
  reason: string;
}): Promise<{ released: boolean; code: string | null }> {
  const id = couponRedemptionId(params.orderId);
  if (!id) return { released: false, code: null };
  try {
    return await db.runTransaction(async (tx: any) => {
      const ref = db.collection(COUPON_REDEMPTIONS).doc(id);
      const snap = await tx.get(ref);
      if (!snap.exists) return { released: false, code: null };
      const redemption = snap.data() as CouponReservation;
      if (!redemption || redemption.status === "released") {
        return { released: false, code: redemption?.code ?? null };
      }

      const statsRef = couponStatsRef(redemption.code);
      const statsSnap = await tx.get(statsRef);
      const stats = counterFrom(statsSnap.exists ? statsSnap.data() : null);

      const usageRef = redemption.customerId
        ? couponUsageRef(redemption.code, redemption.customerId)
        : null;
      const usageSnap = usageRef ? await tx.get(usageRef) : null;
      const usage = counterFrom(usageSnap?.exists ? usageSnap.data() : null);

      const wasCommitted = redemption.status === "committed";
      tx.set(
        ref,
        {
          status: "released",
          releasedAtMs: Date.now(),
          releaseReason: params.reason || "unknown",
        },
        { merge: true }
      );
      tx.set(
        statsRef,
        {
          code: redemption.code,
          committed: wasCommitted ? Math.max(0, stats.committed - 1) : stats.committed,
          reservations: { [id]: deleteField() },
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      if (usageRef) {
        tx.set(
          usageRef,
          {
            code: redemption.code,
            customerId: redemption.customerId,
            committed: wasCommitted ? Math.max(0, usage.committed - 1) : usage.committed,
            reservations: { [id]: deleteField() },
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
      }
      return { released: true, code: redemption.code };
    });
  } catch (err: any) {
    console.warn(
      `[Coupons] release failed for order ${params.orderId}:`,
      err?.message || err
    );
    return { released: false, code: null };
  }
}

/** The redemption attached to an order, if any. */
export async function readCouponRedemption(
  orderId: string
): Promise<CouponReservation | null> {
  const id = couponRedemptionId(orderId);
  if (!id) return null;
  const snap = await db.collection(COUPON_REDEMPTIONS).doc(id).get();
  return snap.exists ? ((snap.data() as CouponReservation) ?? null) : null;
}
