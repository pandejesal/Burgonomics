import { createHash } from "node:crypto";
import * as admin from "firebase-admin";
import { db } from "../../core/firebase";
import type { PricingBreakdown, PricingLineItem, SnapshotProduct } from "../payments/pricing.engine";
import {
  assertWalkInScope,
  priceWalkInLines,
  walkInBranchConfig,
  walkInLineFor,
} from "./walkInBill";
import { WalkInError } from "./walkInErrors";
import { createWalkInSchema, type CreateWalkInRequest } from "./walkInSchema";

/** Re-exported so the route wiring and its tests keep one import site. */
export { createWalkInSchema };
export type { CreateWalkInRequest };

export interface WalkInReceipt {
  orderId: string;
  replayed: boolean;
  status: { code: "PLACED"; label: "Order placed"; kind: "upcoming"; terminal: false };
  paymentStatus: "pending";
  totals: PricingBreakdown;
  settlementAvailable: false;
  /** The REAL outlet this order belongs to (never a client guess). */
  branchId: string;
  branchName: string;
}

/** Re-exported so `createWalkInRoute` and its tests keep one import site. */
export { WalkInError };

const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
const placed: WalkInReceipt["status"] = {
  code: "PLACED",
  label: "Order placed",
  kind: "upcoming",
  terminal: false,
};

/**
 * The ORDER identity of a counter request: the cashier's request id, the outlet,
 * the tender, the cart and the notes. The confirmed total is deliberately NOT
 * part of it (F5).
 *
 * A counter bill is confirmed in two steps: the till posts the total it
 * previewed, the server re-prices the cart and refuses a stale figure with
 * PRICE_CHANGED, then the till posts the server's total under the SAME request
 * id. Hashing the total made the refused body and the accepted body differ, so
 * a replay of either answered IDEMPOTENCY_CONFLICT instead of the receipt. The
 * expected total is a CONFIRMATION of the server's price, not a second identity:
 * one cashier + one request id + one cart is one order, at whatever price the
 * server sanctioned. A genuinely different cart/outlet/tender still conflicts.
 */
export function walkInIdentityHash(input: CreateWalkInRequest): string {
  // Reconstruct a fixed-key object so JSON property ordering sent by clients is irrelevant.
  const canonical = {
    requestId: input.requestId,
    branchId: input.branchId,
    orderType: input.orderType,
    tender: input.tender,
    items: input.items.map(({ productId, quantity }) => ({ productId, quantity })),
    tableNumber: input.tableNumber ?? null,
    notes: input.notes ?? null,
    customerName: input.customerName ?? null,
    customerPhone: input.customerPhone ?? null,
  };
  return digest(JSON.stringify(canonical));
}

/**
 * The pre-F5 hash, expected total included. Kept ONLY so counter orders written
 * before this fix stay replayable: their stored `walkInRequestHash` is this
 * value, and comparing it against the identity hash would turn an honest replay
 * of yesterday's bill into a conflict. New orders never store it.
 */
export function walkInLegacyHash(input: CreateWalkInRequest): string {
  const canonical = {
    requestId: input.requestId,
    branchId: input.branchId,
    orderType: input.orderType,
    tender: input.tender,
    items: input.items.map(({ productId, quantity }) => ({ productId, quantity })),
    expectedTotalPaise: input.expectedTotalPaise,
    tableNumber: input.tableNumber ?? null,
    notes: input.notes ?? null,
    customerName: input.customerName ?? null,
    customerPhone: input.customerPhone ?? null,
  };
  return digest(JSON.stringify(canonical));
}

/** Creates a pending-payment walk-in and audit receipt atomically. */
export async function createWalkIn(actorUid: string, raw: unknown): Promise<WalkInReceipt> {
  if (!actorUid) throw new WalkInError(401, "UNAUTHENTICATED", "Authentication required.");
  const parsed = createWalkInSchema.safeParse(raw);
  if (!parsed.success) throw new WalkInError(400, "INVALID_INPUT", "Invalid walk-in request.");
  const input = parsed.data;
  // The till offers no coupon entry and no opt-in flag exists. Refuse loudly
  // with the coupon vocabulary instead of silently dropping the code or
  // charging a discount no till can explain (F9, 2026-11-22).
  if (input.couponCode?.trim()) {
    throw new WalkInError(
      400,
      "COUPON_NOT_SUPPORTED_FOR_WALKIN",
      "Coupons are not available on the Partner till. Remove the coupon or use the customer app."
    );
  }
  if (input.orderType === "delivery") {
    throw new WalkInError(
      422,
      "ORDER_TYPE_UNSUPPORTED",
      "Delivery is not supported for walk-ins."
    );
  }
  const orderType = input.orderType;
  const requestHash = walkInIdentityHash(input);
  const legacyHash = walkInLegacyHash(input);
  const orderId = `walkin_${digest(JSON.stringify([actorUid, input.requestId]))}`;
  const orderRef = db.collection("orders").doc(orderId);
  const auditRef = db.collection("admin_audit_logs").doc(orderId);
  try {
    return await db.runTransaction(async (tx) => {
      const adminSnap = await tx.get(db.collection("admins").doc(actorUid));
      assertWalkInScope(adminSnap.exists ? adminSnap.data() : undefined, input.branchId, "create");
      const branchSnap = await tx.get(db.collection("branches").doc(input.branchId));
      if (!branchSnap.exists) {
        throw new WalkInError(
          503,
          "BRANCH_UNAVAILABLE",
          "Branch configuration is unavailable."
        );
      }
      const orderSnap = await tx.get(orderRef);
      if (orderSnap.exists) {
        const existing = orderSnap.data();
        const stored = existing?.walkInRequestHash;
        // Two accepted hashes because two honest writers exist: the identity
        // hash (this fix) and the legacy price-included hash for a counter order
        // booked before it. Anything else is a different order.
        if (stored !== requestHash && stored !== legacyHash) {
          throw new WalkInError(
            409,
            "IDEMPOTENCY_CONFLICT",
            "Request ID was already used for a different order."
          );
        }
        if (!existing?.walkInReceipt) {
          throw new WalkInError(
            503,
            "RECEIPT_UNAVAILABLE",
            "Original receipt is unavailable."
          );
        }
        return { ...(existing.walkInReceipt as WalkInReceipt), replayed: true };
      }
      const products = new Map<string, SnapshotProduct>();
      const lines: PricingLineItem[] = [];
      for (const item of input.items) {
        const snapshot = await tx.get(db.collection("products").doc(item.productId));
        const { snapshot: product, line } = walkInLineFor(
          snapshot.data(),
          snapshot.exists,
          input.branchId,
          item.productId,
          item.quantity
        );
        products.set(item.productId, product);
        lines.push(line);
      }
      const branch = branchSnap.data() ?? {};
      const totals = priceWalkInLines({
        lines,
        products,
        branchConfig: walkInBranchConfig(branch, input.branchId),
        branchId: input.branchId,
        orderType,
      });
      if (totals.split.totalAmountPaise !== input.expectedTotalPaise) {
        throw new WalkInError(
          409,
          "PRICE_CHANGED",
          "The order price changed; please reconfirm.",
          totals
        );
      }
      const receipt: WalkInReceipt = {
        orderId,
        replayed: false,
        status: placed,
        paymentStatus: "pending",
        totals,
        settlementAvailable: false,
        branchId: input.branchId,
        branchName: "",
      };
      const timestamp = admin.firestore.FieldValue.serverTimestamp();
      // The REAL outlet identity, read from the branch document that was just
      // authorised. The Partner modal used to guess it from a two-value ternary
      // on the branch id, so 15 of 17 outlets recorded counter revenue under the
      // wrong store name. Never fall back to a guess: an unnamed branch keeps
      // its id and an empty name, which is visibly wrong instead of plausibly
      // wrong.
      const branchName =
        typeof branch.name === "string" && branch.name.trim() ? branch.name.trim() : "";
      const city =
        typeof branch.city === "string" && branch.city.trim() ? branch.city.trim() : "";
      const tenderMethod = input.tender === "cash" ? "cod" : "upi";
      receipt.branchName = branchName;
      tx.create(orderRef, {
        customerId: "cust_walkin",
        userId: actorUid,
        branchId: input.branchId,
        branchName,
        city,
        shortCode: `BG-${orderId.slice(-6).toUpperCase()}`,
        orderType,
        fulfillment: orderType,
        fulfillmentType: orderType,
        items: lines,
        status: placed,
        paymentMethod: tenderMethod,
        paymentStatus: "pending",
        payment: { method: tenderMethod, status: "pending" },
        pricing: totals,
        totals,
        subtotal: totals.foodSubtotal,
        tax: totals.gst,
        deliveryFee: totals.deliveryFee,
        total: totals.grandTotal,
        ...(input.tableNumber !== undefined ? { tableNumber: input.tableNumber } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
        ...(input.customerName !== undefined ? { customerName: input.customerName } : {}),
        ...(input.customerPhone !== undefined ? { customerPhone: input.customerPhone } : {}),
        walkInRequestHash: requestHash,
        walkInReceipt: receipt,
        createdAt: timestamp,
        updatedAt: timestamp,
        placedAt: timestamp,
      });
      tx.create(auditRef, {
        actorUid,
        actorEmail: null,
        action: "walkin_created",
        targetType: "order",
        targetId: orderId,
        metadata: { branchId: input.branchId, tender: input.tender },
        createdAt: timestamp,
      });
      return receipt;
    });
  } catch (error: unknown) {
    if (error instanceof WalkInError) throw error;
    throw new WalkInError(
      503,
      "WALKIN_UNAVAILABLE",
      "Walk-in creation is temporarily unavailable."
    );
  }
}
