import { createHash } from "node:crypto";
import * as admin from "firebase-admin";
import { z } from "zod";
import { db } from "../../core/firebase";
import {
  applyCatalogBasePrice,
  computeSnapshotPricing,
  GST_RATE,
  type PricingBreakdown,
  type PricingLineItem,
  type SnapshotProduct,
} from "../payments/pricing.engine";
import {
  STORE_CLOSED,
  assertStorefrontOpenAndMatching,
} from "../payments/outletStatus";
import { staffCloseOverrideInForce } from "../stores/storeStatus";
import { checkoutEstimatedAt } from "./checkoutEta";
import { DELIVERY_FEE_QUOTES, assertDeliveryQuoteBindable } from "../payments/deliveryQuotes";
import {
  evaluateCoupon,
  isCouponRefusal,
  normalizeCoupon,
} from "../coupons/couponAuthority";
import { branchConfigFromDoc } from "./createCashOrder";
import { planShortCodeReservation } from "./shortCode";
import { whatsappConsentFields } from "../notifications/whatsappConsent";

/**
 * Server-owned online order draft. The client sends only catalogue selections
 * and references; identity, outlet state, address, quote, coupon and every
 * rupee are resolved in this transaction. No client may birth an order doc.
 */
const documentId = z.string().trim().min(1).max(128).refine((value) => !value.includes("/") && value !== "." && value !== "..");
const optionSchema = z.object({
  id: z.string().trim().max(128).optional(),
  optionId: z.string().trim().max(128).optional(),
  name: z.string().trim().max(200).optional(),
  groupName: z.string().trim().max(200).optional(),
  optionName: z.string().trim().max(200).optional(),
  price: z.number().finite().min(0).max(100000).optional(),
  priceDelta: z.number().finite().min(0).max(100000).optional(),
}).passthrough();
const itemSchema = z.object({
  productId: documentId,
  quantity: z.number().int().min(1).max(99),
  customizations: z.array(optionSchema).max(20).optional(),
  modifiers: z.array(optionSchema).max(20).optional(),
  notes: z.string().trim().max(240).optional(),
}).strict();

export const createOnlineDraftSchema = z.object({
  orderId: documentId,
  attemptId: documentId,
  storeId: documentId,
  branchId: documentId.optional(),
  orderType: z.enum(["delivery", "takeaway", "dinein"]),
  items: z.array(itemSchema).min(1).max(100),
  deliveryQuoteId: z.string().trim().min(8).max(128).optional(),
  addressId: documentId.optional(),
  couponCode: z.string().trim().max(64).optional(),
  tipAmount: z.number().finite().min(0).max(100000).optional(),
  notes: z.string().trim().max(1000).optional(),
  fulfillmentInstructions: z.string().trim().max(500).optional(),
  tableNumber: z.string().trim().max(64).optional(),
  whatsappOptIn: z.boolean().optional(),
}).strict();

export type CreateOnlineDraftRequest = z.infer<typeof createOnlineDraftSchema>;

const retireOnlineDraftSchema = z.object({
  operation: z.literal("retire"),
  orderId: documentId,
  attemptId: documentId,
}).strict();

export const onlineDraftRouteSchema = z.union([createOnlineDraftSchema, retireOnlineDraftSchema]);

export interface OnlineDraftReceipt {
  orderId: string;
  attemptId: string;
  replayed: boolean;
  amountPaise: number;
  estimatedAt?: string;
  totals: PricingBreakdown;
  status: { code: "PLACED"; label: "Order placed"; kind: "upcoming"; terminal: false };
}

export class OnlineDraftError extends Error {
  constructor(public readonly statusCode: number, public readonly code: string, message: string) {
    super(message);
  }
}

const placed = { code: "PLACED", label: "Order placed", kind: "upcoming", terminal: false } as const;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Identity of the immutable basket/context, excluding later server payment stamps. */
export function onlineDraftBindingHash(order: any): string {
  return digest({
    customerId: order?.customerId ?? null,
    userId: order?.userId ?? null,
    orderId: order?.orderId ?? null,
    branchId: order?.branchId ?? null,
    storeId: order?.storeId ?? null,
    orderType: order?.orderType ?? null,
    fulfillment: order?.fulfillment ?? null,
    fulfillmentType: order?.fulfillmentType ?? null,
    items: (order?.items ?? []).map((item: any) => ({
      lineId: item?.lineId ?? null,
      id: item?.id ?? null,
      productId: item?.productId ?? null,
      storeId: item?.storeId ?? null,
      name: item?.name ?? null,
      unitPrice: item?.unitPrice ?? null,
      price: item?.price ?? null,
      quantity: item?.quantity ?? null,
      customizations: item?.customizations ?? null,
      modifiers: item?.modifiers ?? null,
      notes: item?.notes ?? null,
    })),
    couponCode: order?.couponCode ?? null,
    tipAmount: order?.tipAmount ?? null,
    deliveryQuoteId: order?.deliveryQuoteId ?? null,
    tableNumber: order?.tableNumber ?? null,
    address: order?.address ?? null,
    deliveryAddress: order?.deliveryAddress ?? null,
    notes: order?.notes ?? null,
    fulfillmentInstructions: order?.fulfillmentInstructions ?? null,
  });
}

/** Fail closed before any gateway call: only an intact server draft is payable. */
export function assertServerOnlineDraft(order: any, orderId: string, customerId: string): void {
  const proof = order?.onlineDraft;
  const invalid = () => {
    const error: any = new Error("This order was not created by the server checkout draft path.");
    error.statusCode = 409;
    error.code = "ORDER_DRAFT_INVALID";
    throw error;
  };
  if (!proof || proof.version !== 1 || proof.source !== "server_online_draft") invalid();
  if (proof.orderId !== orderId || proof.customerId !== customerId || order.customerId !== customerId || order.userId !== customerId) invalid();
  if (typeof proof.attemptId !== "string" || !proof.attemptId || typeof proof.requestHash !== "string") invalid();
  if (onlineDraftBindingHash(order) !== proof.requestHash) invalid();
  const pendingStates = new Set(["pending", "failed"]);
  if (order.paymentChannel !== undefined || order.paymentMethod !== "online" ||
      !pendingStates.has(String(order.paymentStatus)) || order.payment?.method !== "online" ||
      !pendingStates.has(String(order.payment?.status))) invalid();
  if (order.status?.code !== "PLACED" || order.status?.terminal === true) invalid();
  if (order.orderType === "delivery" && typeof order.deliveryQuoteId !== "string") invalid();
}

function requestHash(input: CreateOnlineDraftRequest, actorUid: string): string {
  // Free text and display opt-in are not checkout identity: the durable client
  // replay record intentionally omits them, so a second tab/reload must still
  // converge on the same attempt. The draft binding hash remains stricter.
  const { notes: _notes, fulfillmentInstructions: _instructions, whatsappOptIn: _optIn, ...identity } = input;
  return digest({ actorUid, ...identity, items: identity.items.map(({ notes: _lineNote, ...item }) => item) });
}

const draftAttemptRef = (uid: string, attemptId: string) =>
  db.collection("online_checkout_attempts").doc(digest([uid, attemptId]));

/** Fence delayed creates and terminalize only a positively never-payable draft. */
export async function retireOnlineDraft(actorUid: string, raw: unknown) {
  if (!actorUid) throw new OnlineDraftError(401, "UNAUTHENTICATED", "Authentication required.");
  const parsed = retireOnlineDraftSchema.safeParse(raw);
  if (!parsed.success) throw new OnlineDraftError(400, "INVALID_INPUT", "Invalid checkout attempt.");
  const { orderId, attemptId } = parsed.data;
  const orderRef = db.collection("orders").doc(orderId);
  const attemptRef = draftAttemptRef(actorUid, attemptId);
  return db.runTransaction(async (tx) => {
    const attempt = (await tx.get(attemptRef)).data();
    if (attempt?.actorUid === actorUid && attempt?.retiredOrderId === orderId) return { retired: true, orderId, attemptId };
    if (attempt && (attempt.actorUid !== actorUid || attempt.receipt?.orderId !== orderId)) {
      throw new OnlineDraftError(409, "IDEMPOTENCY_CONFLICT", "This checkout attempt belongs to a different order.");
    }
    const order = (await tx.get(orderRef)).data();
    if (order) {
      assertServerOnlineDraft(order, orderId, actorUid);
      if (order.onlineDraft.attemptId !== attemptId) {
        throw new OnlineDraftError(409, "IDEMPOTENCY_CONFLICT", "This draft belongs to a different attempt.");
      }
      if (order.onlineDraft.paymentStarted !== false || order.paymentStatus !== "pending" ||
          order.payment?.status !== "pending" || order.couponIntentId || order.razorpayOrderId || order.payment?.razorpayOrderId) {
        throw new OnlineDraftError(409, "DRAFT_PAYMENT_IN_PROGRESS", "Finish the previous online payment before starting another checkout.");
      }
      const quoteRef = order.deliveryQuoteId ? db.collection(DELIVERY_FEE_QUOTES).doc(order.deliveryQuoteId) : null;
      if (quoteRef && (await tx.get(quoteRef)).data()?.usedByOrderId === orderId) {
        tx.set(quoteRef, { usedByOrderId: null, usedAt: null }, { merge: true });
      }
      const stamp = admin.firestore.FieldValue.serverTimestamp();
      tx.update(orderRef, {
        status: { code: "CANCELLED", label: "Cancelled", kind: "cancelled", terminal: true },
        cancellationReason: "checkout_draft_replaced",
        completedAt: stamp,
        updatedAt: stamp,
      });
    } else if (attempt?.receipt) {
      // A missing read does not disprove the previously recorded order.
      throw new OnlineDraftError(503, "DRAFT_UNAVAILABLE", "The original checkout draft is unavailable.");
    }
    tx.set(attemptRef, { actorUid, retiredOrderId: orderId }, { merge: true });
    return { retired: true, orderId, attemptId };
  });
}

function receiptOf(order: any, replayed: boolean): OnlineDraftReceipt {
  return {
    orderId: order.orderId,
    attemptId: order.onlineDraft.attemptId,
    replayed,
    amountPaise: Math.round(Number(order.pricing.grandTotal) * 100),
    ...(order.estimatedAt ? { estimatedAt: order.estimatedAt } : {}),
    totals: order.pricing,
    status: placed,
  };
}

export async function createOnlineDraft(actorUid: string, raw: unknown): Promise<OnlineDraftReceipt> {
  if (!actorUid) throw new OnlineDraftError(401, "UNAUTHENTICATED", "Authentication required.");
  const parsed = createOnlineDraftSchema.safeParse(raw);
  if (!parsed.success) throw new OnlineDraftError(400, "INVALID_INPUT", "Invalid online order draft.");
  const input = parsed.data;
  const hash = requestHash(input, actorUid);
  const orderRef = db.collection("orders").doc(input.orderId);
  const attemptRef = draftAttemptRef(actorUid, input.attemptId);
  const couponCode = input.couponCode?.trim().toUpperCase();

  try {
    return await db.runTransaction(async (tx) => {
      const attempt = (await tx.get(attemptRef)).data();
      if (attempt) {
        if (attempt.actorUid === actorUid && attempt.retiredOrderId === input.orderId) {
          throw new OnlineDraftError(409, "DRAFT_RETIRED", "This checkout attempt has been retired.");
        }
        if (attempt.actorUid !== actorUid || attempt.requestHash !== hash || !attempt.receipt) {
          throw new OnlineDraftError(409, "IDEMPOTENCY_CONFLICT", "This checkout attempt already has a different draft.");
        }
        const existing = await tx.get(orderRef);
        if (!existing.exists) throw new OnlineDraftError(503, "DRAFT_UNAVAILABLE", "The original checkout draft is unavailable.");
        const order = existing.data();
        if (order?.checkoutFingerprint !== hash) {
          throw new OnlineDraftError(409, "IDEMPOTENCY_CONFLICT", "The original checkout context could not be verified.");
        }
        assertServerOnlineDraft(order, input.orderId, actorUid);
        return { ...attempt.receipt, replayed: true } as OnlineDraftReceipt;
      }

      const existing = await tx.get(orderRef);
      if (existing.exists) {
        const order = existing.data() || {};
        if (order.customerId !== actorUid && order.userId !== actorUid) {
          throw new OnlineDraftError(403, "ORDER_NOT_OWNED", "This order belongs to a different account.");
        }
        if (order.onlineDraft?.attemptId !== input.attemptId || order.checkoutFingerprint !== hash || !order.onlineDraftReceipt) {
          throw new OnlineDraftError(409, "IDEMPOTENCY_CONFLICT", "This order id was already used for a different checkout.");
        }
        assertServerOnlineDraft(order, input.orderId, actorUid);
        return { ...order.onlineDraftReceipt, replayed: true } as OnlineDraftReceipt;
      }

      let storeData: Record<string, any> | null = null;
      for (const collection of ["stores", "admin_stores"] as const) {
        const snapshot = await tx.get(db.collection(collection).doc(input.storeId));
        if (snapshot.exists) {
          storeData = snapshot.data() || {};
          break;
        }
      }
      if (!storeData) throw new OnlineDraftError(409, "STORE_NOT_LINKED", "This outlet isn't taking orders yet.");
      const linkedBranch = storeData.partnerBranchId;
      if (typeof linkedBranch !== "string" || !linkedBranch) {
        throw new OnlineDraftError(409, "STORE_NOT_LINKED", "This outlet isn't linked to a branch.");
      }
      if (input.branchId && input.branchId !== linkedBranch) {
        throw new OnlineDraftError(409, "STORE_NOT_LINKED", "This outlet isn't linked to that branch.");
      }
      assertStorefrontOpenAndMatching({ ...storeData, id: input.storeId }, input.storeId, input.branchId ?? null);
      const branchId = linkedBranch;
      const branchSnap = await tx.get(db.collection("branches").doc(branchId));
      if (!branchSnap.exists) throw new OnlineDraftError(503, "BRANCH_UNAVAILABLE", "Branch configuration is unavailable.");
      const branch = branchSnap.data() || {};
      if (staffCloseOverrideInForce(storeData, branch)) throw new OnlineDraftError(409, STORE_CLOSED, "This outlet is closed right now.");
      const branchConfig = branchConfigFromDoc(branch, branchId);

      const products = new Map<string, SnapshotProduct>();
      const lines: PricingLineItem[] = [];
      for (const item of input.items) {
        const snapshot = await tx.get(db.collection("products").doc(item.productId));
        const product = snapshot.data();
        if (!snapshot.exists || !product || product.branchId !== branchId || product.inStock !== true ||
            typeof product.price !== "number" || !Number.isFinite(product.price) || product.price < 0 ||
            product.price > 100000 || typeof product.name !== "string" || !product.name.trim() || product.priceAvailable === false) {
          throw new OnlineDraftError(409, "ITEM_UNAVAILABLE", "An item is unavailable or cannot be verified.");
        }
        products.set(item.productId, { price: product.price, inStock: true, customizations: product.customizations });
        lines.push({
          id: item.productId, productId: item.productId, name: product.name, price: product.price,
          quantity: item.quantity,
          ...(item.customizations ? { customizations: item.customizations as any } : {}),
          ...(item.modifiers ? { modifiers: item.modifiers as any } : {}),
          ...(item.notes ? { notes: item.notes } : {}),
        });
      }

      let address: Record<string, any> | undefined;
      let serverDeliveryFee: number | undefined;
      if (input.orderType === "delivery") {
        if (!input.addressId) throw new OnlineDraftError(422, "ADDRESS_REQUIRED", "Select a saved delivery address.");
        const addressSnap = await tx.get(db.collection("users").doc(actorUid).collection("addresses").doc(input.addressId));
        const savedAddress = addressSnap.data();
        if (!savedAddress || !Number.isFinite(savedAddress.lat) || !Number.isFinite(savedAddress.lng)) {
          throw new OnlineDraftError(422, "ADDRESS_REQUIRED", "Select a saved delivery address.");
        }
        address = savedAddress;
        if (!input.deliveryQuoteId) throw new OnlineDraftError(409, "DELIVERY_QUOTE_REQUIRED", "A delivery checkout needs a delivery price.");
        const quote = await tx.get(db.collection(DELIVERY_FEE_QUOTES).doc(input.deliveryQuoteId));
        serverDeliveryFee = assertDeliveryQuoteBindable({
          quote: quote.exists ? quote.data() : null,
          orderId: input.orderId,
          uid: actorUid,
          branchId,
          dropLat: savedAddress.lat,
          dropLng: savedAddress.lng,
        });
      } else {
        if (input.addressId) throw new OnlineDraftError(422, "ADDRESS_UNSUPPORTED", "A delivery address is only valid for delivery.");
        if (input.deliveryQuoteId) throw new OnlineDraftError(422, "DELIVERY_QUOTE_UNSUPPORTED", "A delivery quote is only valid for delivery.");
        if (input.orderType === "dinein" && !input.tableNumber) throw new OnlineDraftError(422, "TABLE_REQUIRED", "A dine-in draft needs a table number.");
      }

      let coupon: any = null;
      if (couponCode) {
        const couponSnap = await tx.get(db.collection("coupons").doc(couponCode));
        coupon = couponSnap.exists ? couponSnap.data() : null;
      }
      // A2 #4: server-derived, uniquely reserved display code. Planned here (a
      // read) and claimed with the order create below, because Firestore forbids
      // a read after the first write.
      const shortCodePlan = await planShortCodeReservation(tx, input.orderId, { branchId });
      const { packagingUsedFallback: _fallback, ...totals } = computeSnapshotPricing({
        items: lines,
        products,
        branchConfig,
        branchId,
        orderType: input.orderType,
        ...(couponCode ? { coupon, customerId: actorUid } : {}),
        ...(serverDeliveryFee !== undefined ? { serverDeliveryFee } : {}),
      });
      if (couponCode) {
        const evaluation = evaluateCoupon(normalizeCoupon(couponCode, coupon), {
          foodSubtotal: totals.foodSubtotal, branchId, nowMs: Date.now(), customerId: actorUid,
        });
        if (!evaluation.eligible) throw new OnlineDraftError(400, evaluation.reason, evaluation.message);
      }

      const customerLines = lines.map((line, index) => {
        const product = products.get(String(line.productId || line.id));
        return {
          lineId: `line_online_${input.orderId}_${index + 1}`,
          id: String(line.productId || line.id), productId: String(line.productId || line.id),
          storeId: input.storeId,
          name: line.name,
          unitPrice: product ? applyCatalogBasePrice(line, Number(product.price), product.customizations) : Number(line.price) || 0,
          price: Number(line.price) || 0,
          quantity: line.quantity,
          modifiers: line.modifiers ?? [],
          availability: "available",
          ...(line.customizations ? { customizations: line.customizations } : {}),
          ...((line as any).notes ? { notes: (line as any).notes } : {}),
        };
      });
      const customerTotals = {
        ...totals,
        subtotal: totals.foodSubtotal,
        itemDiscount: 0,
        promoDiscount: totals.discount,
        taxes: totals.gst,
        gstRate: GST_RATE,
        packingFee: totals.packagingFee,
        currency: "INR",
      };
      const estimatedAt = checkoutEstimatedAt(storeData, input.orderType);
      const timestamp = admin.firestore.FieldValue.serverTimestamp();
      const order: Record<string, any> = {
        id: input.orderId, orderId: input.orderId, customerId: actorUid, userId: actorUid,
        branchId, storeId: input.storeId, shortCode: shortCodePlan.code,
        orderType: input.orderType, fulfillment: input.orderType, fulfillmentType: input.orderType,
        store: {
          id: input.storeId,
          ...(typeof storeData.name === "string" ? { name: storeData.name } : {}),
          ...(typeof storeData.address === "string" ? { address: storeData.address } : {}),
          ...(typeof storeData.area === "string" ? { area: storeData.area } : {}),
          ...(typeof storeData.city === "string" ? { city: storeData.city } : {}),
          ...(typeof storeData.phone === "string" ? { phone: storeData.phone } : {}),
          ...(typeof storeData.etaMinutes === "number" ? { etaMinutes: storeData.etaMinutes } : {}),
          ...(typeof storeData.pickupEtaMinutes === "number" ? { pickupEtaMinutes: storeData.pickupEtaMinutes } : {}),
          ...(typeof storeData.lat === "number" ? { lat: storeData.lat } : {}),
          ...(typeof storeData.lng === "number" ? { lng: storeData.lng } : {}),
          partnerBranchId: branchId,
        },
        ...(address ? { address, deliveryAddress: address } : {}),
        items: customerLines,
        ...(couponCode ? { couponCode, promo: { code: couponCode, discount: totals.discount } } : {}),
        tipAmount: input.tipAmount ?? 0,
        loyaltyPointsRedeemed: 0,
        ...(input.notes ? { notes: input.notes } : {}),
        ...(input.fulfillmentInstructions ? { fulfillmentInstructions: input.fulfillmentInstructions } : {}),
        ...(input.tableNumber ? { tableNumber: input.tableNumber } : {}),
        // Owner decision 2026-11-25 #3: OFF unless the customer explicitly said
        // yes, with a server-stamped consent time. Never inferred from absence.
        ...whatsappConsentFields(input.whatsappOptIn),
        ...(input.deliveryQuoteId ? { deliveryQuoteId: input.deliveryQuoteId } : {}),
        status: placed,
        paymentMethod: "online",
        paymentStatus: "pending",
        payment: { method: "online", label: "Pay Online", status: "pending" },
        pricing: customerTotals,
        totals: customerTotals,
        subtotal: totals.foodSubtotal,
        tax: totals.gst,
        deliveryFee: totals.deliveryFee,
        total: totals.grandTotal,
        checkoutFingerprint: hash,
        createdAt: timestamp,
        updatedAt: timestamp,
        placedAt: new Date().toISOString(),
        ...(estimatedAt ? { estimatedAt } : {}),
      };
      order.onlineDraft = {
        version: 1,
        source: "server_online_draft",
        orderId: input.orderId,
        customerId: actorUid,
        attemptId: input.attemptId,
        requestHash: onlineDraftBindingHash(order),
        // Missing on older drafts is deliberately NOT proof of no payment.
        paymentStarted: false,
        createdAtMs: Date.now(),
      };
      const receipt = receiptOf(order, false);
      order.onlineDraftReceipt = receipt;

      // All reads above are complete. Writes are committed atomically below.
      shortCodePlan.reserve();
      if (input.deliveryQuoteId) {
        tx.set(db.collection(DELIVERY_FEE_QUOTES).doc(input.deliveryQuoteId), {
          usedByOrderId: input.orderId,
          usedAt: timestamp,
        }, { merge: true });
      }
      tx.create(orderRef, order);
      tx.create(attemptRef, { actorUid, requestHash: hash, receipt, createdAt: timestamp });
      return receipt;
    });
  } catch (error: unknown) {
    if (error instanceof OnlineDraftError) throw error;
    if (isCouponRefusal(error)) {
      const refusal = error as Error & { code: string; statusCode: number };
      throw new OnlineDraftError(refusal.statusCode, refusal.code, refusal.message);
    }
    const statusCode = Number((error as any)?.statusCode);
    const code = String((error as any)?.code || "");
    if (Number.isFinite(statusCode) && statusCode >= 400 && statusCode < 500 && code) {
      throw new OnlineDraftError(statusCode, code, (error as any)?.message || "Online draft refused.");
    }
    throw new OnlineDraftError(503, "ONLINE_DRAFT_UNAVAILABLE", "Online checkout is temporarily unavailable.");
  }
}
