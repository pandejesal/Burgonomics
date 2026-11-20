import { z } from "zod";
import * as admin from "firebase-admin";
import { db } from "../../core/firebase";
import { serviceError } from "../../core/errors";
import {
  COUPONS,
  COUPON_REDEMPTIONS,
  COUPON_ISSUES,
  COUPON_MESSAGES,
  couponMessage,
  couponRedemptionId,
  couponStatsRef,
  couponUsageRef,
  normalizeCoupon,
  normalizeCouponCode,
  readCoupon,
  readCouponUsage,
  liveUsage,
  type Coupon,
} from "./couponAuthority";

/**
 * Staff-facing coupon management. Every write in this file goes through the
 * Admin SDK on the server: Firestore rules deny all client writes to `coupons`,
 * `coupon_redemptions`, `coupon_stats` and `coupon_customer_usage`.
 *
 * This replaces the Partner app's fixture screen (`AdminCouponsPage`, which
 * said in its own copy "this screen does not read or write the Firestore
 * /coupons collection") and the false-success actions in `customersData.ts`,
 * where "coupon issued" and "tier updated" toasted a confirmation for a write
 * that never left the browser.
 */

const MAX_DISCOUNT_RUPEES = 100000;
const MAX_VALUE = 100000;

export const createCouponSchema = z.object({
  code: z.string().trim().min(2).max(64),
  title: z.string().trim().max(120).optional(),
  discountType: z.enum(["percent", "flat"]),
  value: z.number().positive().max(MAX_VALUE),
  maxDiscount: z.number().min(0).max(MAX_DISCOUNT_RUPEES).nullable().optional(),
  minOrder: z.number().min(0).max(MAX_DISCOUNT_RUPEES).optional(),
  validFromMs: z.number().int().nonnegative().nullable().optional(),
  validToMs: z.number().int().nonnegative().nullable().optional(),
  perCustomerLimit: z.number().int().min(0).max(1000).nullable().optional(),
  totalCap: z.number().int().min(0).max(1000000).nullable().optional(),
  branchScope: z.union([z.literal("all"), z.array(z.string().trim().min(1))]).optional(),
  active: z.boolean().optional(),
});

export type CreateCouponInput = z.infer<typeof createCouponSchema>;

export const setCouponActiveSchema = z.object({
  code: z.string().trim().min(2).max(64),
  active: z.boolean(),
});

export const issueCouponSchema = z.object({
  code: z.string().trim().min(2).max(64),
  customerId: z.string().trim().min(1).max(128),
  title: z.string().trim().max(120).optional(),
  discountType: z.enum(["percent", "flat"]),
  value: z.number().positive().max(MAX_VALUE),
  maxDiscount: z.number().min(0).max(MAX_DISCOUNT_RUPEES).nullable().optional(),
  minOrder: z.number().min(0).max(MAX_DISCOUNT_RUPEES).optional(),
  validToMs: z.number().int().nonnegative().nullable().optional(),
  perCustomerLimit: z.number().int().min(1).max(100).optional(),
});

export interface CouponSummary extends Coupon {
  committed: number;
  reserved: number;
  totalUsed: number;
}

function statsDoc(data: any, nowMs: number) {
  const reservations =
    data?.reservations && typeof data.reservations === "object" && !Array.isArray(data.reservations)
      ? (data.reservations as Record<string, any>)
      : {};
  let reserved = 0;
  for (const value of Object.values(reservations)) {
    const expiresAtMs = Number((value as any)?.expiresAtMs);
    if (Number.isFinite(expiresAtMs) && expiresAtMs > nowMs) reserved += 1;
  }
  return { committed: Math.max(0, Math.floor(Number(data?.committed) || 0)), reserved };
}

function toSummary(coupon: Coupon, stats: { committed: number; reserved: number }): CouponSummary {
  return {
    ...coupon,
    committed: stats.committed,
    reserved: stats.reserved,
    totalUsed: stats.committed + stats.reserved,
  };
}

/** Creates (or replaces) a coupon. Idempotent on the code: same code = update. */
export async function createCoupon(
  input: CreateCouponInput,
  actor: { uid: string; role: string }
): Promise<CouponSummary> {
  const code = normalizeCouponCode(input.code);
  if (!code) throw serviceError("COUPON_INVALID", "A coupon code is required.", 400);
  if (input.discountType === "percent" && input.value > 100) {
    throw serviceError("COUPON_INVALID", "A percentage coupon cannot exceed 100%.", 400);
  }
  if (
    input.validFromMs != null &&
    input.validToMs != null &&
    input.validToMs <= input.validFromMs
  ) {
    throw serviceError("COUPON_INVALID", "The end date must be after the start date.", 400);
  }

  const branchScope =
    input.branchScope === "all" || input.branchScope === undefined
      ? "all"
      : input.branchScope.filter(Boolean);

  const existing = await readCoupon(code);
  const nowMs = Date.now();
  const doc = {
    code,
    title: input.title?.trim() || code,
    discountType: input.discountType,
    value: input.value,
    maxDiscount: input.discountType === "percent" ? (input.maxDiscount ?? null) : null,
    minOrder: input.minOrder ?? 0,
    validFromMs: input.validFromMs ?? null,
    validToMs: input.validToMs ?? null,
    perCustomerLimit: input.perCustomerLimit ?? null,
    totalCap: input.totalCap ?? null,
    branchScope,
    // An update keeps the original customer binding only if it had one; a
    // brand-wide create never silently widens an issued-to-one-person coupon.
    customerScope: existing?.customerScope ?? null,
    active: input.active ?? existing?.active ?? true,
    createdBy: existing?.createdBy ?? actor.uid,
    createdAtMs: existing?.createdAtMs ?? nowMs,
    updatedBy: actor.uid,
    updatedAtMs: nowMs,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  await db.collection(COUPONS).doc(code).set(doc, { merge: true });
  const statsSnap = await couponStatsRef(code).get();
  const stats = statsDoc(statsSnap.exists ? statsSnap.data() : null, nowMs);
  return toSummary(normalizeCoupon(code, doc) as Coupon, stats);
}

/** The kill switch. Disabling never deletes history: redemptions stay. */
export async function setCouponActive(input: {
  code: string;
  active: boolean;
}, actor: { uid: string }): Promise<{ code: string; active: boolean }> {
  const code = normalizeCouponCode(input.code);
  const existing = await readCoupon(code);
  if (!existing) throw serviceError("COUPON_NOT_FOUND", `Coupon ${code} was not found.`, 404);
  await db.collection(COUPONS).doc(code).set(
    {
      active: input.active,
      updatedBy: actor.uid,
      updatedAtMs: Date.now(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
  return { code, active: input.active };
}

/**
 * Issues a coupon to ONE customer: a coupon document scoped to that uid plus an
 * audit row in `coupon_issues`. This is the real replacement for the Partner
 * app's in-memory "Issued promotional coupon" toast — the customer can now
 * actually use the code, and only from their own account.
 */
export async function issueCouponToCustomer(
  input: z.infer<typeof issueCouponSchema>,
  actor: { uid: string; role: string }
): Promise<{ code: string; customerId: string; title: string; discountType: string; value: number }> {
  const code = normalizeCouponCode(input.code);
  const customerId = String(input.customerId).trim();
  if (!code) throw serviceError("COUPON_INVALID", "A coupon code is required.", 400);
  if (!customerId) throw serviceError("CUSTOMER_REQUIRED", "A customer is required.", 400);
  if (input.discountType === "percent" && input.value > 100) {
    throw serviceError("COUPON_INVALID", "A percentage coupon cannot exceed 100%.", 400);
  }

  const nowMs = Date.now();
  const existing = await readCoupon(code);
  if (existing && existing.customerScope && existing.customerScope !== customerId) {
    throw serviceError(
      "COUPON_CODE_IN_USE",
      `Coupon ${code} already belongs to a different customer. Use a different code.`,
      409
    );
  }

  const doc = {
    code,
    title: input.title?.trim() || existing?.title || code,
    discountType: input.discountType,
    value: input.value,
    maxDiscount: input.discountType === "percent" ? (input.maxDiscount ?? null) : null,
    minOrder: input.minOrder ?? existing?.minOrder ?? 0,
    validFromMs: existing?.validFromMs ?? null,
    validToMs: input.validToMs ?? existing?.validToMs ?? null,
    perCustomerLimit: input.perCustomerLimit ?? existing?.perCustomerLimit ?? 1,
    totalCap: existing?.totalCap ?? 1,
    branchScope: existing?.branchScope ?? "all",
    customerScope: customerId,
    active: true,
    createdBy: existing?.createdBy ?? actor.uid,
    createdAtMs: existing?.createdAtMs ?? nowMs,
    updatedBy: actor.uid,
    updatedAtMs: nowMs,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  await db.collection(COUPONS).doc(code).set(doc, { merge: true });
  await db
    .collection(COUPON_ISSUES)
    .doc(`${code}__${customerId}`)
    .set(
      {
        code,
        customerId,
        issuedBy: actor.uid,
        issuedByRole: actor.role,
        issuedAtMs: nowMs,
        issuedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

  return {
    code,
    customerId,
    title: doc.title,
    discountType: doc.discountType,
    value: doc.value,
  };
}

/** Every coupon with its live usage. Ordered newest-first by creation. */
export async function listCoupons(): Promise<CouponSummary[]> {
  const snap = await db.collection(COUPONS).limit(200).get();
  const docs = Array.isArray(snap?.docs) ? snap.docs : [];
  const nowMs = Date.now();
  const out: CouponSummary[] = [];
  for (const doc of docs) {
    const coupon = normalizeCoupon(doc.id, typeof doc.data === "function" ? doc.data() : doc);
    if (!coupon) continue;
    let stats = { committed: 0, reserved: 0 };
    try {
      const statsSnap = await couponStatsRef(coupon.code).get();
      stats = statsDoc(statsSnap.exists ? statsSnap.data() : null, nowMs);
    } catch {
      // A counter read failure must not hide the coupon; usage shows 0.
    }
    out.push(toSummary(coupon, stats));
  }
  return out.sort((a, b) => (b.createdAtMs ?? 0) - (a.createdAtMs ?? 0));
}

export interface CouponUsageRow {
  orderId: string;
  customerId: string;
  branchId: string | null;
  discount: number;
  status: string;
  reservedAtMs: number;
  committedAtMs?: number;
  releasedAtMs?: number;
  releaseReason?: string;
}

/** Redemptions for one coupon, newest first. The "view usage" screen's data. */
export async function listCouponUsage(
  code: string,
  limit = 100
): Promise<{ code: string; committed: number; reserved: number; rows: CouponUsageRow[] }> {
  const normalized = normalizeCouponCode(code);
  if (!normalized) throw serviceError("COUPON_INVALID", "A coupon code is required.", 400);
  const nowMs = Date.now();
  const statsSnap = await couponStatsRef(normalized).get();
  const stats = statsDoc(statsSnap.exists ? statsSnap.data() : null, nowMs);

  const snap = await db
    .collection(COUPON_REDEMPTIONS)
    .where("code", "==", normalized)
    .limit(Math.min(500, Math.max(1, limit)))
    .get();
  const docs = Array.isArray(snap?.docs) ? snap.docs : [];
  const rows: CouponUsageRow[] = docs
    .map((doc: any) => {
      const data = typeof doc.data === "function" ? doc.data() : doc;
      return {
        orderId: String(data?.orderId ?? doc.id ?? ""),
        customerId: String(data?.customerId ?? ""),
        branchId: data?.branchId ? String(data.branchId) : null,
        discount: Number(data?.discount) || 0,
        status: String(data?.status ?? ""),
        reservedAtMs: Number(data?.reservedAtMs) || 0,
        committedAtMs: data?.committedAtMs,
        releasedAtMs: data?.releasedAtMs,
        releaseReason: data?.releaseReason,
      } as CouponUsageRow;
    })
    .sort((a: CouponUsageRow, b: CouponUsageRow) => b.reservedAtMs - a.reservedAtMs);

  return { code: normalized, committed: stats.committed, reserved: stats.reserved, rows };
}

/**
 * The coupons a customer may actually use right now, for the offers screen.
 * Only the public-safe fields leave the server — never `totalCap` internals or
 * another customer's id.
 */
export async function listAvailableCoupons(params: {
  branchId?: string | null;
  customerId?: string | null;
  nowMs?: number;
}): Promise<
  Array<{
    code: string;
    title: string;
    discountType: string;
    value: number;
    maxDiscount: number | null;
    minOrder: number;
    validToMs: number | null;
  }>
> {
  const nowMs = params.nowMs ?? Date.now();
  const snap = await db.collection(COUPONS).limit(200).get();
  const docs = Array.isArray(snap?.docs) ? snap.docs : [];
  const out: Array<{
    code: string;
    title: string;
    discountType: string;
    value: number;
    maxDiscount: number | null;
    minOrder: number;
    validToMs: number | null;
  }> = [];

  for (const doc of docs) {
    const coupon = normalizeCoupon(doc.id, typeof doc.data === "function" ? doc.data() : doc);
    if (!coupon || !coupon.active) continue;
    if (coupon.validFromMs !== null && nowMs < coupon.validFromMs) continue;
    if (coupon.validToMs !== null && nowMs > coupon.validToMs) continue;
    if (
      coupon.branchScope !== "all" &&
      (!params.branchId || !coupon.branchScope.includes(params.branchId))
    ) {
      continue;
    }
    // A coupon issued to another customer is not "available" to this one.
    if (coupon.customerScope && coupon.customerScope !== String(params.customerId ?? "")) {
      continue;
    }
    try {
      const usage = await readCouponUsage(coupon.code, params.customerId, nowMs);
      if (coupon.totalCap !== null && usage.totalUsed >= coupon.totalCap) continue;
      if (
        coupon.perCustomerLimit !== null &&
        params.customerId &&
        usage.customerUsed >= coupon.perCustomerLimit
      ) {
        continue;
      }
    } catch {
      // Unverifiable usage: hide it rather than promise a discount we cannot
      // honour. The quote route reports the outage explicitly.
      continue;
    }
    out.push({
      code: coupon.code,
      title: coupon.title,
      discountType: coupon.discountType,
      value: coupon.value,
      maxDiscount: coupon.maxDiscount,
      minOrder: coupon.minOrder,
      validToMs: coupon.validToMs,
    });
  }
  return out;
}

export { COUPON_MESSAGES, couponMessage, couponRedemptionId, couponUsageRef, liveUsage };
