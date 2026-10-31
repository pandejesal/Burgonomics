import { randomUUID } from "node:crypto";
import * as admin from "firebase-admin";
import { db } from "../../core/firebase";
import { dispatchQuote } from "../dispatch/dispatch.router";
import {
  dropGpsMissingError,
  isRealCoordinatePair,
  pickupGpsMissingError,
  resolvePickupCoordinates,
} from "../../core/utils/pickupCoords";
import { resolveBranchId } from "./branchResolver";
import { computePackagingFee, resolveBranchPricingConfig } from "./branchPricing";
import { DELIVERY_FEE_QUOTES } from "./deliveryQuotes";

/**
 * POST /checkout/fees (owner decision 2026-10-31, R5).
 *
 * The checkout screen no longer computes a fee: it asks the server, which
 *   1. resolves the branch exactly like createPaymentOrder,
 *   2. takes PACKAGING from the same shared branch source the engine uses,
 *   3. for delivery, quotes the couriers with SERVER-ONLY pickup coordinates
 *      (the client cannot name where the rider collects from), and
 *   4. persists the winning fare as a single-use quote.
 *
 * There is no static fare, no markup, and no free-delivery threshold anywhere
 * in this path. A non-delivery order returns instantly and calls no provider.
 */

export interface CheckoutFeesInput {
  storeId?: string;
  branchId?: string;
  orderType: "delivery" | "takeaway" | "dinein";
  dropLat?: number;
  dropLng?: number;
  /** Authenticated caller. The route binds this from the verified token. */
  customerId: string | null | undefined;
}

export interface CheckoutFeesResult {
  serviceable: boolean;
  packagingFee: number;
  /** Present only when serviceable (never a zero placeholder). */
  deliveryFee?: number;
  deliveryQuoteId?: string;
  provider?: string;
  expiresAt?: number;
  reason?: string;
  message?: string;
}

function unauthenticatedError(): Error {
  const err: any = new Error("Unauthorized: Authentication required");
  err.statusCode = 401;
  return err;
}

function invalidQuoteError(detail: string): Error {
  const err: any = new Error(
    `No usable courier fare was returned — ${detail}. Please retry the delivery quote.`
  );
  err.statusCode = 503;
  err.code = "NO_SERVICEABLE_PROVIDER";
  return err;
}

export async function resolveCheckoutFees(
  input: CheckoutFeesInput
): Promise<CheckoutFeesResult> {
  // Auth is enforced at the route; this guard makes a direct/internal call
  // without an identity fail closed rather than mint an unowned quote.
  if (typeof input.customerId !== "string" || input.customerId.length === 0) {
    throw unauthenticatedError();
  }

  const branchId = await resolveBranchId({
    branchId: input.branchId,
    storeId: input.storeId,
  });
  const config = await resolveBranchPricingConfig(branchId);
  // P2: the SAME helper the pricing engine uses. Dine-in is 0 inside it, so
  // the screen and the bill cannot disagree about packaging.
  const packagingFee = await computePackagingFee({
    packaging: config.packaging ?? null,
    branchFee: config.branchPackagingFee,
    orderType: input.orderType,
    branchId,
  });

  if (input.orderType !== "delivery") {
    // Non-delivery: no provider call, ever.
    return { serviceable: true, packagingFee, deliveryFee: 0 };
  }

  if (!isRealCoordinatePair(input.dropLat, input.dropLng)) {
    throw dropGpsMissingError();
  }

  // R5: pickup comes ONLY from server data for this branch/store. The request
  // body carries just the drop pin; there is no accepted pickup field at all.
  const pickup = await resolvePickupCoordinates({ branchId });
  if (!pickup) throw pickupGpsMissingError();

  const quote = await dispatchQuote({
    pickupLat: pickup.lat,
    pickupLng: pickup.lng,
    dropLat: Number(input.dropLat),
    dropLng: Number(input.dropLng),
  });

  // Out of zone is a 200 with serviceable:false — the address is simply not
  // served, which is not an error the client should retry as a failure.
  if (quote?.serviceable !== true) {
    return {
      serviceable: false,
      packagingFee,
      reason: String(quote?.reason || "not_serviced"),
      message: String(
        quote?.message || "Delivery isn't available to this address."
      ),
    };
  }

  const fee = Math.round(Number(quote?.estimatedFare) * 100) / 100;
  // Never a static or zero fare: an unusable winner fare is a provider
  // failure, not a price.
  if (!Number.isFinite(fee) || fee <= 0) {
    throw invalidQuoteError("the winning provider returned no fare");
  }

  const nowMs = Date.now();
  const validForSeconds = Number(quote?.validForSeconds) > 0 ? Number(quote.validForSeconds) : 600;
  const expiresAt =
    Number(quote?.expiresAt) > nowMs ? Number(quote.expiresAt) : nowMs + validForSeconds * 1000;
  const deliveryQuoteId = `dfq_${randomUUID()}`;

  await db
    .collection(DELIVERY_FEE_QUOTES)
    .doc(deliveryQuoteId)
    .set({
      uid: input.customerId,
      branchId,
      storeId: input.storeId || null,
      dropLat: Number(input.dropLat),
      dropLng: Number(input.dropLng),
      fee,
      provider: String(quote?.winner || ""),
      providerQuoteId: typeof quote?.quoteId === "string" ? quote.quoteId : null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      // Numeric clock for the expiry check (a serverTimestamp sentinel has no
      // toMillis on a later read).
      createdAtMs: nowMs,
      expiresAt,
      usedByOrderId: null,
    });

  return {
    serviceable: true,
    packagingFee,
    deliveryFee: fee,
    deliveryQuoteId,
    provider: String(quote?.winner || ""),
    expiresAt,
  };
}
