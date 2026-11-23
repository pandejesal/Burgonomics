import { db } from "../../core/firebase";
import * as admin from "firebase-admin";
import { assertOrderBranchAccess, isBrandAdminClaim, type StaffCaller } from "../../core/middleware";
import { computeHmacSha256, getOtpHmacSecret, timingSafeEqual } from "../../core/security";
import { captureErrorSnapshot } from "../../core/errors";
import { receiptEvidenceStamp } from "../payments/receiptEvidence";
import {
  assertDeliveryOrderId, assertDeliveryOtpOrderActive, computeDeliveryOtpHash, DeliveryOtpError, readVersionedDeliveryOtp,
} from "./deliveryOtp";

export interface DeliveryOtpOwnerCaller {
  readonly uid?: string;
  readonly role?: string;
  readonly firebase?: { readonly sign_in_provider?: string };
}

export interface OwnerDeliveryOtpResult {
  readonly orderId: string;
  readonly deliveryOtp: string;
  readonly version: 2;
}

function isCustomerIdentity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim() &&
    !/^(?:guest(?:[_-].*)?|cust_walkin|walk[_-]?in|anonymous)$/i.test(value);
}

/** No role/branch/admin override: this service is an owner-only, read-only boundary. */
export async function getOwnerDeliveryOtp(orderId: string, caller: DeliveryOtpOwnerCaller | undefined): Promise<OwnerDeliveryOtpResult> {
  assertDeliveryOrderId(orderId);
  if (!caller?.uid) throw new DeliveryOtpError("UNAUTHENTICATED", "Authentication is required", 401);
  if (!isCustomerIdentity(caller.uid) || caller.role === "guest" || caller.firebase?.sign_in_provider === "anonymous") {
    throw new DeliveryOtpError("FORBIDDEN", "Only the signed-in order owner may read this delivery code", 403);
  }
  const orderRef = db.collection("orders").doc(orderId);
  const snapshot = await orderRef.get();
  if (!snapshot.exists) throw new DeliveryOtpError("ORDER_NOT_FOUND", "Order not found", 404);
  const order = snapshot.data()!;
  // A present but invalid canonical identity is NOT absence. A conflicting
  // legacy alias must not be used to steal another customer's code.
  const customerId = order.customerId === undefined ? order.userId : order.customerId;
  if (!isCustomerIdentity(customerId) || customerId !== caller.uid ||
      (order.userId !== undefined && order.userId !== customerId) || order.isGuest === true) {
    throw new DeliveryOtpError("FORBIDDEN", "Only the signed-in order owner may read this delivery code", 403);
  }
  assertDeliveryOtpOrderActive(order);
  return { orderId: orderRef.id, deliveryOtp: readVersionedDeliveryOtp(order, orderRef.id), version: 2 };
}

export interface VerifyDeliveryOtpParams {
  readonly orderId: string;
  readonly otp: string;
  readonly staffName?: string;
  /** Required even for internal callers: possession of the code is not staff authorization. */
  readonly caller: StaffCaller | undefined;
}

export const OTP_MAX_ATTEMPTS = 3;
export const OTP_LOCKOUT_MS = 15 * 60 * 1000;

/**
 * The "cash is now in the branch's hand" stamp for a COD hand-over.
 *
 * Deliberately NOT a gateway shape: the amount comes from the server-written
 * `cashDuePaise` (never from the request), it is recorded as
 * `cashCollectedPaise` rather than `capturedAmountPaise`, and `paymentChannel`
 * stays `"cash"` so no refund/Route/reconciliation lane can mistake a collected
 * banknote for a captured card payment.
 */
export function cashCollectedPatch(order: Record<string, any>): Record<string, any> {
  const due = Number(order?.cashDuePaise);
  const existing =
    order?.payment && typeof order.payment === "object" && !Array.isArray(order.payment)
      ? order.payment
      : {};
  const collectedAt = admin.firestore.FieldValue.serverTimestamp();
  return {
    payment: {
      ...existing,
      method: "cod",
      status: "completed",
      cashCollectedPaise: due,
      cashCollectedAt: collectedAt,
    },
    paymentStatus: "paid",
    cashCollectedPaise: due,
    cashCollectedAt: collectedAt,
    // M8 r4: receipt may claim "Collected" only with the server stamp written
    // in the same patch as the collected amount.
    receiptEvidence: receiptEvidenceStamp("cash", due),
  };
}

export interface DeliveryHandoverResult {
  readonly success: true;
  readonly orderId: string;
  readonly deliveredAt: string;
}

/** Authorization, failed guesses and one-time consumption share a single fresh transaction. */
export async function verifyDeliveryOtp(params: VerifyDeliveryOtpParams): Promise<DeliveryHandoverResult> {
  const { orderId, otp, caller, staffName } = params;
  assertDeliveryOrderId(orderId);
  if (!caller?.uid) throw new DeliveryOtpError("UNAUTHENTICATED", "Unauthorized: staff authentication required", 401);
  if (typeof otp !== "string" || !/^[0-9]{4}$/.test(otp)) {
    throw new DeliveryOtpError("INVALID_DELIVERY_OTP_FORMAT", "Delivery OTP must be exactly 4 digits", 400);
  }
  if (typeof db.runTransaction !== "function") {
    throw new DeliveryOtpError("TRANSACTION_UNAVAILABLE", "Delivery handover requires transactional storage", 503);
  }
  const orderRef = db.collection("orders").doc(orderId);
  const outcome = await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(orderRef);
    if (!snapshot.exists) throw new DeliveryOtpError("ORDER_NOT_FOUND", "Order not found", 404);
    const order = snapshot.data()!;
    // Preserve the route's admins-collection fallback, but include its read in
    // the same authorization snapshot instead of trusting middleware alone.
    let staffCaller = caller;
    if (!isBrandAdminClaim(staffCaller) && !["branch_owner", "branch_staff"].includes(staffCaller.role ?? "")) {
      const staffSnapshot = await transaction.get(db.collection("admins").doc(caller.uid!));
      const staffData = staffSnapshot.data();
      const role: unknown = staffData?.role;
      if (typeof role !== "string" || !["brand_owner", "developer", "branch_owner", "branch_staff"].includes(role)) {
        throw new DeliveryOtpError("FORBIDDEN", "Forbidden: staff authorization required", 403);
      }
      const adminBranchIds = Array.isArray(staffData?.branchIds)
        ? staffData.branchIds.filter((b: unknown): b is string => typeof b === "string")
        : (typeof staffData?.branchId === "string" && staffData.branchId ? [staffData.branchId] : undefined);
      staffCaller = {
        ...caller,
        role,
        branchIds: adminBranchIds ?? caller.branchIds,
        isBrandAdmin: typeof staffData?.isBrandAdmin === "boolean" ? staffData.isBrandAdmin : caller.isBrandAdmin,
      };
    }
    await assertOrderBranchAccess(staffCaller, order, transaction);
    assertDeliveryOtpOrderActive(order, true);
    const storedHash = typeof order.deliveryOtpHash === "string" ? order.deliveryOtpHash.trim() : "";
    const legacyOtp = typeof order.deliveryOtp === "string" ? order.deliveryOtp.trim() : "";
    if (order.deliveryOtpVersion != null) readVersionedDeliveryOtp(order, orderRef.id);
    if (!storedHash && !/^[0-9]{4}$/.test(legacyOtp)) {
      throw new DeliveryOtpError("DELIVERY_OTP_UNAVAILABLE", "No delivery OTP found on order record");
    }
    const now = Date.now();
    const lockedUntil = Number(order.deliveryOtpLockedUntil || 0);
    const hasLock = Number.isFinite(lockedUntil) && lockedUntil > 0;
    if (hasLock && lockedUntil > now) return { kind: "locked" as const };
    const lockoutExpired = hasLock && lockedUntil <= now;

    const version = typeof order.deliveryOtpVersion === "number" ? order.deliveryOtpVersion : undefined;
    const expectedHash = storedHash
      ? computeDeliveryOtpHash(otp, orderRef.id, version)
      : "";
    const valid = storedHash
      ? timingSafeEqual(expectedHash, storedHash)
      : timingSafeEqual(otp, legacyOtp);
    if (!valid) {
      const prior = lockoutExpired ? 0 : Number(order.deliveryOtpAttempts || 0);
      const safePrior = Number.isSafeInteger(prior) && prior >= 0 ? prior : 0;
      const attempts = safePrior + 1;
      const locked = attempts >= OTP_MAX_ATTEMPTS;
      transaction.set(orderRef, {
        deliveryOtpAttempts: attempts,
        deliveryOtpLockedUntil: locked ? now + OTP_LOCKOUT_MS : null,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      // Returning (not throwing) commits the failed-guess counter first.
      return { kind: "invalid" as const, attempts, locked };
    }
    const isCashOrder = order.paymentChannel === "cash";
    transaction.set(orderRef, {
      deliveryOtpAttempts: 0, deliveryOtpLockedUntil: null,
      deliveryOtpHash: null, deliveryOtp: null,
      deliveryOtpConsumedAt: admin.firestore.FieldValue.serverTimestamp(),
      status: { code: "DELIVERED", label: "Delivered", kind: "completed", terminal: true },
      deliveryStatus: "delivered",
      deliveredAt: admin.firestore.FieldValue.serverTimestamp(),
      deliveryVerifiedBy: "customer_otp",
      verifiedByStaff: caller.email || caller.uid || staffName || "Branch Staff",
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      // Owner decision 2026-11-20: cash is collected AT HAND-OFF, and the
      // hand-over code is the proof of hand-off. So this is the one moment a
      // COD order becomes paid — and it is recorded as CASH, never as a
      // gateway capture: no `capturedAmountPaise`, no `paymentChannel`
      // rewrite, and the server's own `cashDuePaise` is the amount recorded.
      ...(isCashOrder ? cashCollectedPatch(order) : {}),
    }, { merge: true });
    return { kind: "delivered" as const };
  });
  if (outcome.kind === "invalid") {
    await captureErrorSnapshot({
      source: "porter", severity: outcome.locked ? "high" : "medium", orderId,
      message: "Invalid delivery handover attempt", context: { attempts: outcome.attempts, locked: outcome.locked },
    });
  }
  if (outcome.kind === "locked" || (outcome.kind === "invalid" && outcome.locked)) {
    throw new DeliveryOtpError("DELIVERY_OTP_LOCKED", "Too many wrong attempts. Retry after the lockout expires.", 429);
  }
  if (outcome.kind === "invalid") {
    throw new DeliveryOtpError("DELIVERY_OTP_INVALID", "Invalid Delivery OTP. Please verify the code on the customer screen.", 400);
  }
  return { success: true, orderId: orderRef.id, deliveredAt: new Date().toISOString() };
}
