import { createHash } from "node:crypto";
import * as admin from "firebase-admin";
import { z } from "zod";
import { db } from "../../core/firebase";
import {
  assertCashOnDeliveryAllowed,
  DEFAULT_MONTHLY_FEE_RUPEES,
  DEFAULT_PACKAGING_FEE,
  resolveCashOnDeliveryConfig,
  type BranchPricingConfig,
} from "../payments/branchPricing";
import {
  computeSnapshotPricing,
  type PricingBreakdown,
  type PricingLineItem,
  type SnapshotProduct,
} from "../payments/pricing.engine";
import {
  STORE_CLOSED,
  assertOutletOpenForOnlineOrders,
} from "../payments/outletStatus";
import { DELIVERY_FEE_QUOTES, assertDeliveryQuoteBindable } from "../payments/deliveryQuotes";

/**
 * COD / pay-at-counter order creation (owner decision 2026-11-20: cash on
 * delivery is in the launch scope).
 *
 * WHY THE SERVER CREATES THIS DOCUMENT
 * An online order is created by the customer app and only *priced* by the
 * server, because Razorpay will not open without an `orders/{id}` to bind to.
 * Cash has no gateway, so nothing forces a client-written order — and a
 * client-written cash order is exactly the shape that cannot be trusted: its
 * `total` is the amount the rider will collect at the door.
 *
 * So this module owns the whole cash order:
 *   - the branch is resolved from the STORE link (a client `branchId` that
 *     disagrees with the store's link is refused),
 *   - every line is priced from the CATALOG inside the same transaction that
 *     creates the order (`computeSnapshotPricing`), never from the request,
 *   - a delivery is priced from the persisted courier quote, claimed in the
 *     same transaction,
 *   - the branch's COD switch + per-order ceiling are enforced here,
 *   - and the doc is born with the server-only `paymentChannel: "cash"` marker.
 *
 * That marker is what the rest of the system keys on:
 *   - `petpooja/orderPush` sends the KOT immediately for it (the kitchen does
 *     not wait for a payment that will never arrive),
 *   - `orders/deliveryOtp` allows the hand-over code and marks the cash
 *     collected,
 *   - the Partner analytics count it in the cash stream, never as online money.
 * A client-written `payment.method: "cod"` without this marker keeps the old
 * staff-acceptance KOT rule (see `orderPush.isCashKotAcceptTransition`), so
 * nobody can mint a printed ticket by typing "cod" into a payload.
 *
 * Idempotency mirrors `createWalkIn`: the client names the order id, the doc
 * stores a hash of the request, and a retry of the SAME request returns the
 * stored receipt instead of creating a second order or repricing it.
 */

const documentId = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .refine((value) => !value.includes("/") && value !== "." && value !== "..");

const optionSchema = z
  .object({
    id: z.string().trim().max(128).optional(),
    optionId: z.string().trim().max(128).optional(),
    name: z.string().trim().max(200).optional(),
    groupName: z.string().trim().max(200).optional(),
    optionName: z.string().trim().max(200).optional(),
    price: z.number().finite().min(0).max(100000).optional(),
    priceDelta: z.number().finite().min(0).max(100000).optional(),
  })
  .passthrough();

const cashItemSchema = z
  .object({
    productId: documentId,
    quantity: z.number().int().min(1).max(99),
    customizations: z.array(optionSchema).max(20).optional(),
    modifiers: z.array(optionSchema).max(20).optional(),
    notes: z.string().trim().max(240).optional(),
  })
  .strict();

/**
 * Display-only passthroughs. These are the SAME snapshots the customer app
 * already writes on an online order (`store`, `address`, `promo`); none of them
 * decides money — every rupee is recomputed below — so they are stored for the
 * confirmation/partner screens and nothing else.
 */
const displayRecord = z.record(z.string(), z.unknown());

export const createCashOrderSchema = z
  .object({
    orderId: documentId,
    storeId: documentId.optional(),
    branchId: documentId.optional(),
    orderType: z.enum(["delivery", "takeaway", "dinein"]),
    items: z.array(cashItemSchema).min(1).max(100),
    /** The bill the customer saw. A mismatch is refused, never silently moved. */
    expectedTotalPaise: z.number().int().nonnegative().safe(),
    deliveryQuoteId: z.string().trim().min(8).max(128).optional(),
    couponCode: z.string().trim().max(64).optional(),
    tipAmount: z.number().finite().min(0).max(100000).optional(),
    notes: z.string().trim().max(1000).optional(),
    fulfillmentInstructions: z.string().trim().max(500).optional(),
    tableNumber: z.string().trim().max(64).optional(),
    customerName: z.string().trim().max(200).optional(),
    customerPhone: z.string().trim().max(32).optional(),
    whatsappOptIn: z.boolean().optional(),
    estimatedAt: z.string().trim().max(64).optional(),
    store: displayRecord.optional(),
    address: displayRecord.optional(),
    deliveryAddress: displayRecord.optional(),
    promo: displayRecord.nullable().optional(),
  })
  .strict();

export type CreateCashOrderRequest = z.infer<typeof createCashOrderSchema>;

export interface CashOrderReceipt {
  orderId: string;
  replayed: boolean;
  paymentMethod: "cod";
  paymentChannel: "cash";
  /** What the rider/counter must collect, from the SERVER's own bill. */
  cashDuePaise: number;
  totals: PricingBreakdown;
  status: { code: "PLACED"; label: "Order placed"; kind: "upcoming"; terminal: false };
}

export class CashOrderError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly totals?: PricingBreakdown
  ) {
    super(message);
  }
}

const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
const placed: CashOrderReceipt["status"] = {
  code: "PLACED",
  label: "Order placed",
  kind: "upcoming",
  terminal: false,
};

/** Deterministic, order-independent hash of the request that created the doc. */
function requestHashOf(input: CreateCashOrderRequest): string {
  return digest(
    JSON.stringify({
      orderId: input.orderId,
      storeId: input.storeId ?? null,
      branchId: input.branchId ?? null,
      orderType: input.orderType,
      items: input.items.map((item) => ({
        productId: item.productId,
        quantity: item.quantity,
        customizations: item.customizations ?? null,
        modifiers: item.modifiers ?? null,
        notes: item.notes ?? null,
      })),
      expectedTotalPaise: input.expectedTotalPaise,
      deliveryQuoteId: input.deliveryQuoteId ?? null,
      couponCode: input.couponCode ?? null,
      tipAmount: input.tipAmount ?? null,
      notes: input.notes ?? null,
      fulfillmentInstructions: input.fulfillmentInstructions ?? null,
      tableNumber: input.tableNumber ?? null,
      customerName: input.customerName ?? null,
      customerPhone: input.customerPhone ?? null,
    })
  );
}

/**
 * The branch's own doc is the pricing + COD authority. Read inside the
 * transaction so the switch, the ceiling and the packaging fee are all one
 * consistent snapshot with the order that is being created.
 */
function branchConfigFromDoc(branch: any, branchId: string): BranchPricingConfig {
  const branchFee = branch?.packagingFee;
  if (branchFee !== undefined && (typeof branchFee !== "number" || !Number.isFinite(branchFee) || branchFee < 0)) {
    throw new CashOrderError(503, "BRANCH_UNAVAILABLE", "Branch pricing is unavailable.");
  }
  let cashOnDelivery;
  try {
    cashOnDelivery = resolveCashOnDeliveryConfig(branch?.cashOnDelivery, branchId);
  } catch {
    throw new CashOrderError(503, "BRANCH_UNAVAILABLE", "Branch configuration is unavailable.");
  }
  return {
    packagingFee: branchFee ?? DEFAULT_PACKAGING_FEE,
    monthlyFeePaise: DEFAULT_MONTHLY_FEE_RUPEES * 100,
    ...(branchFee !== undefined ? { branchPackagingFee: branchFee } : {}),
    packaging: branch?.packaging ?? null,
    cashOnDelivery,
  };
}

/** Creates a server-owned COD / pay-at-counter order with server-computed totals. */
export async function createCashOrder(
  actorUid: string,
  raw: unknown
): Promise<CashOrderReceipt> {
  if (!actorUid) throw new CashOrderError(401, "UNAUTHENTICATED", "Authentication required.");
  const parsed = createCashOrderSchema.safeParse(raw);
  if (!parsed.success) throw new CashOrderError(400, "INVALID_INPUT", "Invalid cash order request.");
  const input = parsed.data;
  const requestHash = requestHashOf(input);
  const orderRef = db.collection("orders").doc(input.orderId);

  // F2 (staging 2026-11-21, Test 9): a closed outlet must not take new cash
  // orders either — the server created the order and told the kitchen about it
  // while `stores/{id}.isOpen` was false. Refused BEFORE the transaction, so
  // nothing is written and no KOT is dispatched.
  try {
    await assertOutletOpenForOnlineOrders({ storeId: input.storeId, branchId: input.branchId });
  } catch (err: any) {
    if (err?.code === STORE_CLOSED) {
      throw new CashOrderError(409, STORE_CLOSED, err.message);
    }
    throw err;
  }

  try {
    return await db.runTransaction(async (tx) => {
      // 1. Idempotency first: a retry of the same request converges on the
      // stored receipt, and never reprices against a moved menu.
      const orderSnap = await tx.get(orderRef);
      if (orderSnap.exists) {
        const existing = orderSnap.data() || {};
        if (existing.customerId !== actorUid && existing.userId !== actorUid) {
          throw new CashOrderError(403, "ORDER_NOT_OWNED", "This order belongs to a different account.");
        }
        if (existing.cashRequestHash !== requestHash) {
          throw new CashOrderError(
            409,
            "IDEMPOTENCY_CONFLICT",
            "This order id was already used for a different order."
          );
        }
        if (!existing.cashReceipt) {
          throw new CashOrderError(503, "RECEIPT_UNAVAILABLE", "Original receipt is unavailable.");
        }
        return { ...(existing.cashReceipt as CashOrderReceipt), replayed: true };
      }

      // 2. The branch comes from the STORE link, and a client branchId must
      // agree with it — a caller cannot point a store's order at another
      // outlet's packaging, COD switch or cash ceiling.
      let branchId = input.branchId ?? null;
      if (input.storeId) {
        const storeSnap = await tx.get(db.collection("stores").doc(input.storeId));
        if (!storeSnap.exists) {
          throw new CashOrderError(409, "STORE_NOT_LINKED", "This outlet isn't taking orders yet.");
        }
        const linked = (storeSnap.data() || {}).partnerBranchId;
        if (typeof linked !== "string" || !linked) {
          throw new CashOrderError(409, "STORE_NOT_LINKED", "This outlet isn't taking orders yet.");
        }
        if (branchId && branchId !== linked) {
          throw new CashOrderError(409, "STORE_NOT_LINKED", "This outlet isn't linked to that branch.");
        }
        branchId = linked;
      }
      if (!branchId) throw new CashOrderError(400, "BRANCH_REQUIRED", "branchId or storeId is required.");

      const branchSnap = await tx.get(db.collection("branches").doc(branchId));
      if (!branchSnap.exists) {
        throw new CashOrderError(503, "BRANCH_UNAVAILABLE", "Branch configuration is unavailable.");
      }
      const branch = branchSnap.data() || {};
      const config = branchConfigFromDoc(branch, branchId);

      // 3. Catalog-priced lines: the product docs are read HERE, in the same
      // transaction, so availability and price cannot move between the check
      // and the write.
      const products = new Map<string, SnapshotProduct>();
      const lines: PricingLineItem[] = [];
      for (const item of input.items) {
        const snapshot = await tx.get(db.collection("products").doc(item.productId));
        const product = snapshot.data();
        if (
          !snapshot.exists ||
          !product ||
          product.branchId !== branchId ||
          product.inStock !== true ||
          typeof product.price !== "number" ||
          !Number.isFinite(product.price) ||
          product.price < 0 ||
          product.price > 100000 ||
          typeof product.name !== "string" ||
          !product.name.trim() ||
          product.priceAvailable === false
        ) {
          throw new CashOrderError(409, "ITEM_UNAVAILABLE", "An item is unavailable or cannot be verified.");
        }
        products.set(item.productId, {
          price: product.price,
          inStock: product.inStock,
          customizations: product.customizations,
        });
        lines.push({
          id: item.productId,
          productId: item.productId,
          name: product.name,
          // The catalog price is the authority; the request carries no price
          // at all (the schema refuses one), so this is never a client number.
          price: product.price,
          quantity: item.quantity,
          ...(item.customizations ? { customizations: item.customizations as any } : {}),
          ...(item.modifiers ? { modifiers: item.modifiers as any } : {}),
        });
      }

      // 4. A delivery is priced from the persisted courier quote ONLY, claimed
      // in this same transaction (same rule as the online path: no static fee,
      // no default, and one quote can never back two orders).
      let serverDeliveryFee: number | undefined;
      const quoteId = input.deliveryQuoteId;
      if (input.orderType === "delivery") {
        if (!quoteId) {
          throw new CashOrderError(
            409,
            "DELIVERY_QUOTE_REQUIRED",
            "A delivery checkout needs a delivery price — get one and retry."
          );
        }
        const quoteSnap = await tx.get(db.collection(DELIVERY_FEE_QUOTES).doc(quoteId));
        const drop = (input.deliveryAddress ?? input.address ?? {}) as Record<string, unknown>;
        serverDeliveryFee = assertDeliveryQuoteBindable({
          quote: quoteSnap.exists ? quoteSnap.data() : null,
          orderId: input.orderId,
          uid: actorUid,
          branchId,
          dropLat: typeof drop.lat === "number" ? drop.lat : undefined,
          dropLng: typeof drop.lng === "number" ? drop.lng : undefined,
        });
        tx.set(
          db.collection(DELIVERY_FEE_QUOTES).doc(quoteId),
          {
            usedByOrderId: input.orderId,
            usedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
      } else if (quoteId) {
        // Off-delivery a quote id means nothing; refusing is louder than
        // silently dropping a field the caller thought was used.
        throw new CashOrderError(
          422,
          "DELIVERY_QUOTE_UNSUPPORTED",
          "A delivery quote can only be used on a delivery order."
        );
      }

      // 5. The coupon is the ONLY discount authority (never the request).
      let coupon: any = null;
      const couponCode = input.couponCode?.trim().toUpperCase();
      if (couponCode) {
        const couponSnap = await tx.get(db.collection("coupons").doc(couponCode));
        coupon = couponSnap.exists ? couponSnap.data() : null;
      }

      const { packagingUsedFallback: _fallback, ...totals } = computeSnapshotPricing({
        items: lines,
        products,
        branchConfig: config,
        branchId,
        orderType: input.orderType,
        ...(couponCode ? { coupon } : {}),
        ...(serverDeliveryFee !== undefined ? { serverDeliveryFee } : {}),
      });

      // 6. The customer agreed to a bill; if the menu moved, refuse and hand
      // back the server's number instead of charging a different one.
      if (totals.split.totalAmountPaise !== input.expectedTotalPaise) {
        throw new CashOrderError(
          409,
          "PRICE_CHANGED",
          "The order price changed; please reconfirm.",
          totals
        );
      }

      // 7. Branch switch + per-order cash ceiling, against the SERVER's total.
      try {
        assertCashOnDeliveryAllowed(config.cashOnDelivery, totals.split.totalAmountPaise);
      } catch (err: any) {
        throw new CashOrderError(
          typeof err?.statusCode === "number" ? err.statusCode : 409,
          typeof err?.code === "string" ? err.code : "COD_UNAVAILABLE",
          err?.message || "Cash on delivery is not available for this order."
        );
      }

      const cashDuePaise = totals.split.totalAmountPaise;
      const paymentLabel =
        input.orderType === "delivery" ? "Cash on Delivery" : "Pay at Store";
      const receipt: CashOrderReceipt = {
        orderId: input.orderId,
        replayed: false,
        paymentMethod: "cod",
        paymentChannel: "cash",
        cashDuePaise,
        totals,
        status: placed,
      };
      const timestamp = admin.firestore.FieldValue.serverTimestamp();
      const storeId =
        input.storeId ??
        (input.store && typeof input.store.id === "string" ? input.store.id : undefined);
      const address = input.deliveryAddress ?? input.address;

      tx.create(orderRef, {
        // Ownership — both fields, exactly as the customer create rule requires.
        customerId: actorUid,
        userId: actorUid,
        branchId,
        ...(storeId ? { storeId } : {}),
        shortCode: `BG-${input.orderId.slice(-6).toUpperCase()}`,
        // Fulfillment (canonical + the legacy aliases the KOT builder reads).
        orderType: input.orderType,
        fulfillment: input.orderType,
        fulfillmentType: input.orderType,
        // Display snapshots (never money).
        ...(input.store ? { store: input.store } : {}),
        ...(address ? { address } : {}),
        ...(address ? { deliveryAddress: address } : {}),
        ...(input.customerName ? { customerName: input.customerName } : {}),
        ...(input.customerPhone ? { customerPhone: input.customerPhone } : {}),
        items: lines,
        ...(input.promo !== undefined && input.promo !== null ? { promo: input.promo } : {}),
        tipAmount: input.tipAmount ?? 0,
        loyaltyPointsRedeemed: 0,
        ...(input.notes ? { notes: input.notes } : {}),
        ...(input.fulfillmentInstructions
          ? { fulfillmentInstructions: input.fulfillmentInstructions }
          : {}),
        ...(input.tableNumber ? { tableNumber: input.tableNumber } : {}),
        whatsappOptIn: input.whatsappOptIn !== false,
        ...(input.estimatedAt ? { estimatedAt: input.estimatedAt } : {}),
        ...(quoteId ? { deliveryQuoteId: quoteId } : {}),
        // Server-owned state.
        status: placed,
        paymentMethod: "cod",
        paymentStatus: "pending",
        payment: { method: "cod", label: paymentLabel, status: "pending" },
        // THE marker. Only this module writes it, and every cash-aware reader
        // (KOT-on-create, delivery OTP, Partner cash stream) keys on it.
        paymentChannel: "cash",
        cashDuePaise,
        cashOnDelivery: {
          maxOrderValuePaise: config.cashOnDelivery?.maxOrderValuePaise ?? null,
        },
        pricing: totals,
        totals,
        // Flat mirrors the Partner lists/reports read without normalising.
        subtotal: totals.foodSubtotal,
        tax: totals.gst,
        deliveryFee: totals.deliveryFee,
        total: totals.grandTotal,
        cashRequestHash: requestHash,
        cashReceipt: receipt,
        createdAt: timestamp,
        updatedAt: timestamp,
        placedAt: timestamp,
      });

      return receipt;
    });
  } catch (error: unknown) {
    if (error instanceof CashOrderError) throw error;
    const statusCode = Number((error as any)?.statusCode);
    const code = String((error as any)?.code || "");
    if (Number.isFinite(statusCode) && statusCode >= 400 && statusCode < 500 && code) {
      // A pricing/quote refusal carries its own typed code + message.
      throw new CashOrderError(statusCode, code, (error as any)?.message || "Cash order refused.");
    }
    throw new CashOrderError(503, "CASH_ORDER_UNAVAILABLE", "Cash ordering is temporarily unavailable.");
  }
}
