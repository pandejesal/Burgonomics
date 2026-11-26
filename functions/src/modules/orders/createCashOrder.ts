import { createHash } from "node:crypto";
import { checkoutEstimatedAt } from "./checkoutEta";
import { planShortCodeReservation } from "./shortCode";
import { whatsappConsentFields } from "../notifications/whatsappConsent";
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
  assertOutletOpenForOnlineOrders,
} from "../payments/outletStatus";
import { staffCloseOverrideInForce } from "../stores/storeStatus";
import { DELIVERY_FEE_QUOTES, assertDeliveryQuoteBindable } from "../payments/deliveryQuotes";
import {
  evaluateCoupon,
  isCouponRefusal,
  normalizeCoupon,
  reserveCouponInTx,
} from "../coupons/couponAuthority";

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
    attemptId: documentId.optional(),
    addressId: documentId.optional(),
    storeId: documentId.optional(),
    branchId: documentId.optional(),
    orderType: z.enum(["delivery", "takeaway", "dinein"]),
    items: z.array(cashItemSchema).min(1).max(100),
    /** The bill the customer saw. A mismatch is refused, never silently moved. */
    expectedTotalPaise: z.number().int().nonnegative().safe(),
    /** Online checkout with nothing to collect, never a positive cash order. */
    zeroDueOnly: z.literal(true).optional(),
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
  estimatedAt?: string;
  totals: PricingBreakdown;
  status: { code: "PLACED"; label: "Order placed"; kind: "upcoming"; terminal: false };
  settlementEffectiveAtMs: number;
  settlementCaptureState: "confirmed";
  settlementCaptureUnresolved: false;
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
      orderId: input.attemptId ?? input.orderId,
      ...(input.addressId ? {addressId: input.addressId} : {}),
      ...(input.attemptId && input.tableNumber ? {tableNumber:input.tableNumber} : {}),
      storeId: input.storeId ?? null,
      branchId: input.branchId ?? null,
      orderType: input.orderType,
      items: input.items.map((item) => ({
        productId: item.productId,
        quantity: item.quantity,
        customizations: item.customizations ?? null,
        modifiers: item.modifiers ?? null,
      })),
      deliveryQuoteId: input.deliveryQuoteId ?? null,
      couponCode: input.couponCode ?? null,
      tipAmount: input.tipAmount ?? null,
      // Distinct receipt authority, without changing existing cash hashes.
      ...(input.zeroDueOnly ? { zeroDueOnly: true } : {}),
      // M4 privacy + reconfirmation: display-only fields (notes, contact,
      // instructions, table) and the confirmation total are NOT identity. They
      // are never persisted in the client replay record, so hashing them would
      // break an honest retry after a PRICE_CHANGED reconfirmation.
    })
  );
}

/**
 * The branch's own doc is the pricing + COD authority. Read inside the
 * transaction so the switch, the ceiling and the packaging fee are all one
 * consistent snapshot with the order that is being created.
 */
export function branchConfigFromDoc(branch: any, branchId: string): BranchPricingConfig {
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
  const attemptRef = input.attemptId ? db.collection("cash_checkout_attempts").doc(digest(JSON.stringify([actorUid,input.attemptId]))) : null;
  const couponCode = input.couponCode?.trim().toUpperCase();

  // A4: the close gate is read INSIDE the write transaction below (after the
  // replay check), from the same canonical storefront doc that supplies the
  // branch link. A close racing this create rejects the NEW order; a replay of
  // an already-received receipt still resolves above, without needing a live
  // storefront (otherwise receipt recovery would break during a close).

  let receipt: CashOrderReceipt;
  try {
    receipt = await db.runTransaction(async (tx) => {
      if (attemptRef) {
        const attempt = (await tx.get(attemptRef)).data();
        if (attempt) {
          if (attempt.actorUid !== actorUid || attempt.requestHash !== requestHash || !attempt.receipt) {
            throw new CashOrderError(409,"IDEMPOTENCY_CONFLICT","This checkout attempt already has a different receipt.");
          }
          return {...attempt.receipt,replayed:true} as CashOrderReceipt;
        }
      }
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
      const resolvedStoreId =
        input.storeId ??
        (input.store && typeof input.store.id === "string" ? input.store.id : undefined);
      let branchId = input.branchId ?? null;
      let storeData: Record<string, any> | null = null;
      if (input.storeId) {
        // A4: the same `stores` → `admin_stores` precedence the canonical
        // storefront resolver applies, so a linked fallback outlet works.
        for (const collection of ["stores", "admin_stores"] as const) {
          const storeSnap = await tx.get(db.collection(collection).doc(input.storeId));
          if (storeSnap.exists) {
            storeData = (storeSnap.data() || {}) as Record<string, any>;
            break;
          }
        }
        if (!storeData) {
          throw new CashOrderError(409, "STORE_NOT_LINKED", "This outlet isn't taking orders yet.");
        }
        const linked = storeData.partnerBranchId;
        if (typeof linked !== "string" || !linked) {
          throw new CashOrderError(409, "STORE_NOT_LINKED", "This outlet isn't taking orders yet.");
        }
        if (branchId && branchId !== linked) {
          throw new CashOrderError(409, "STORE_NOT_LINKED", "This outlet isn't linked to that branch.");
        }
        branchId = linked;
        // A4: gate from THIS doc, in this transaction, after the replay check.
        assertStorefrontOpenAndMatching(
          { ...storeData, id: input.storeId },
          input.storeId,
          input.branchId ?? null
        );
      } else if (input.branchId) {
        // Branch-only API fallback: resolve the same canonical storefront and
        // read its gate here, inside the create transaction.
        const outlet = await assertOutletOpenForOnlineOrders({ branchId: input.branchId }, tx);
        storeData = outlet.data;
      }
      if (!branchId) throw new CashOrderError(400, "BRANCH_REQUIRED", "branchId or storeId is required.");

      const branchSnap = await tx.get(db.collection("branches").doc(branchId));
      if (!branchSnap.exists) {
        throw new CashOrderError(503, "BRANCH_UNAVAILABLE", "Branch configuration is unavailable.");
      }
      const branch = branchSnap.data() || {};
      // A4: a staff close override wins even if the storefront card is still
      // marked open (rule C). Re-read inside the write transaction.
      if (staffCloseOverrideInForce(storeData, branch)) {
        throw new CashOrderError(409, STORE_CLOSED, "This outlet is closed right now.");
      }
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
          ...(item.notes ? { notes: item.notes } : {}),
          ...(item.customizations ? { customizations: item.customizations as any } : {}),
          ...(item.modifiers ? { modifiers: item.modifiers as any } : {}),
        });
      }

      // 4. A delivery is priced from the persisted courier quote ONLY, claimed
      // in this same transaction (same rule as the online path: no static fee,
      // no default, and one quote can never back two orders).
      let serverDeliveryFee: number | undefined;
      let address = input.deliveryAddress ?? input.address;
      const quoteId = input.deliveryQuoteId;
      if (input.orderType === "delivery") {
        if (input.attemptId) {
          if (!input.addressId) throw new CashOrderError(422,'ADDRESS_REQUIRED','Select a saved delivery address.');
          const saved = await tx.get(db.collection('users').doc(actorUid).collection('addresses').doc(input.addressId));
          address = saved.data();
          if (!address || !Number.isFinite(address.lat) || !Number.isFinite(address.lng)) throw new CashOrderError(422,'ADDRESS_REQUIRED','Select a saved delivery address.');
        }
        if (!quoteId) {
          throw new CashOrderError(
            409,
            "DELIVERY_QUOTE_REQUIRED",
            "A delivery checkout needs a delivery price — get one and retry."
          );
        }
        const quoteSnap = await tx.get(db.collection(DELIVERY_FEE_QUOTES).doc(quoteId));
        const drop = address ?? {};
        serverDeliveryFee = assertDeliveryQuoteBindable({
          quote: quoteSnap.exists ? quoteSnap.data() : null,
          orderId: input.orderId,
          uid: actorUid,
          branchId,
          dropLat: typeof drop.lat === "number" ? drop.lat : undefined,
          dropLng: typeof drop.lng === "number" ? drop.lng : undefined,
        });
        // The claim is a WRITE. It is deliberately deferred until after every
        // read (including the coupon authority's reads) — Firestore rejects a
        // tx.get after a tx.set, and the old order of these two lines is the
        // staging 503. See step 7 below.
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
      // This is still a READ: no transaction write has happened yet.
      let coupon: any = null;
      if (couponCode) {
        const couponSnap = await tx.get(db.collection("coupons").doc(couponCode));
        coupon = couponSnap.exists ? couponSnap.data() : null;
      }

      // A2 #4: the order's human-readable code is SERVER-derived and uniquely
      // reserved. This is the transaction's last READ — the coupon reservation
      // and the quote claim below both write, and a tx.get after a tx.set is
      // refused at runtime.
      const shortCodePlan = await planShortCodeReservation(tx, input.orderId, { branchId });

      const { packagingUsedFallback: _fallback, ...totals } = computeSnapshotPricing({
        items: lines,
        products,
        branchConfig: config,
        branchId,
        orderType: input.orderType,
        ...(couponCode ? { coupon } : {}),
        ...(couponCode ? { customerId: actorUid } : {}),
        ...(serverDeliveryFee !== undefined ? { serverDeliveryFee } : {}),
      });

      // A bad code is the CUSTOMER's to fix. Check eligibility with the SAME
      // authority the pricing engine used, before the amount check can turn it
      // into a misleading "price changed". Usage limits are re-checked inside
      // reserveCouponInTx below, against the transactional counters.
      if (couponCode) {
        const evaluation = evaluateCoupon(normalizeCoupon(couponCode, coupon), {
          foodSubtotal: totals.foodSubtotal,
          branchId,
          nowMs: Date.now(),
          customerId: actorUid,
        });
        if (!evaluation.eligible) {
          throw new CashOrderError(400, evaluation.reason, evaluation.message);
        }
      }

      // F8 — the Customer app renders the ONLINE field names. Derive them from
      // this one server calculation (never from a client payload), while the
      // original backend names remain in the same object for the receipt, KOT
      // and Partner cash stream. `unitPrice` is the all-in catalogue price,
      // identical to the value the pricing engine used for `foodSubtotal`.
      const customerLines = lines.map((line, index) => {
        // Same key the pricing engine used for the authoritative price.
        const productKey = String(line.productId || line.id || "");
        const product = products.get(productKey);
        return {
          lineId: `line_cash_${input.orderId}_${index + 1}`,
          id: productKey,
          productId: productKey,
          storeId: resolvedStoreId ?? branchId,
          name: line.name,
          unitPrice: product
            ? applyCatalogBasePrice(line, Number(product.price), product.customizations)
            : Number(line.price) || 0,
          price: Number(line.price) || 0,
          quantity: line.quantity,
          modifiers: line.modifiers ?? [],
          ...(line.notes ? { notes: line.notes } : {}),
          availability: "available",
          ...(line.customizations ? { customizations: line.customizations } : {}),
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

      // 6. The customer agreed to a bill; if the menu moved, refuse and hand
      // back the server's number instead of charging a different one.
      // The zero-due lane never places an order with money due, even if a
      // stale client has already recalculated and sent the new positive total.
      const cashDuePaise = totals.split.totalAmountPaise;
      if (cashDuePaise !== input.expectedTotalPaise || (input.zeroDueOnly && cashDuePaise !== 0)) {
        throw new CashOrderError(
          409,
          "PRICE_CHANGED",
          "The order price changed; please reconfirm.",
          totals
        );
      }

      // Ordinary cash still requires COD approval, even if nothing is due.
      // Only the explicitly zero-only lane can skip that tender check.
      if (!input.zeroDueOnly) {
        try {
          assertCashOnDeliveryAllowed(config.cashOnDelivery, cashDuePaise, input.orderType);
        } catch (err: any) {
          throw new CashOrderError(
            typeof err?.statusCode === "number" ? err.statusCode : 409,
            typeof err?.code === "string" ? err.code : "COD_UNAVAILABLE",
            err?.message || "Cash on delivery is not available for this order."
          );
        }
      }

      // 7. Coupon redemption + BOTH counters are committed INSIDE this same
      // transaction (M3) — there is no cash payment callback that could be lost
      // after the order write. `commitNow` writes a committed redemption, bumps
      // the global and per-customer counters and settles the durable obligation
      // together with the order doc. Two cash checkouts of the last slot still
      // conflict on the stats doc. An ineligible coupon throws its typed 400/409
      // here, before any write and before any order exists.
      if (couponCode) {
        try {
          await reserveCouponInTx(tx, {
            code: couponCode,
            orderId: input.orderId,
            customerId: actorUid,
            branchId,
            foodSubtotal: totals.foodSubtotal,
            expectedDiscount: totals.discount,
            paymentIntentId: input.orderId,
            commitNow: true,
          });
        } catch (err: any) {
          if (isCouponRefusal(err)) {
            throw new CashOrderError(err.statusCode, err.code, err.message);
          }
          throw err;
        }
      }
      if (input.orderType === "delivery" && quoteId) {
        tx.set(
          db.collection(DELIVERY_FEE_QUOTES).doc(quoteId),
          {
            usedByOrderId: input.orderId,
            usedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
      }

      const paymentLabel =
        input.orderType === "delivery" ? "Cash on Delivery" : "Pay at Store";
      const placedAtMs = Date.now();
      const estimatedAt = checkoutEstimatedAt(storeData, input.orderType);
      const receipt: CashOrderReceipt = {
        orderId: input.orderId,
        replayed: false,
        paymentMethod: "cod",
        paymentChannel: "cash",
        // One canonical numeric settlement key on every money path.
        settlementEffectiveAtMs: placedAtMs,
        settlementCaptureState: "confirmed",
        settlementCaptureUnresolved: false,
        cashDuePaise,
        ...(estimatedAt ? { estimatedAt } : {}),
        totals,
        status: placed,
      };
      const timestamp = admin.firestore.FieldValue.serverTimestamp();
      // The customer service keys its history map on the body `id` and
      // quarantines docs without an ISO `placedAt` string. The paid path writes
      // both at create; cash must have the same customer-readable shape or a
      // valid order is invisible in Orders and Track.
      const placedAtIso = new Date(placedAtMs).toISOString();
      const storeId = resolvedStoreId;
      // An API caller may omit the display snapshot (the app's own cash path
      // sends one). Derive it from the same store doc that supplied the pricing
      // branch, so the confirmation screen has a real outlet to render.
      const storeSnapshot: Record<string, unknown> | undefined = input.store
        ? input.store
        : storeData && storeId
          ? {
              id: storeId,
              ...(typeof storeData.name === "string" ? { name: storeData.name } : {}),
              ...(typeof storeData.address === "string" ? { address: storeData.address } : {}),
              ...(typeof storeData.area === "string" ? { area: storeData.area } : {}),
              ...(typeof storeData.city === "string" ? { city: storeData.city } : {}),
              ...(typeof storeData.phone === "string" ? { phone: storeData.phone } : {}),
              ...(typeof storeData.lat === "number" ? { lat: storeData.lat } : {}),
              ...(typeof storeData.lng === "number" ? { lng: storeData.lng } : {}),
              partnerBranchId: branchId,
            }
          : undefined;

      // Claim the reserved code in the SAME commit as the order. A crash before
      // the commit leaks one candidate (never a wrong code); the retry finds its
      // own reservation and reuses it.
      shortCodePlan.reserve();
      tx.create(orderRef, {
        // Ownership — both fields, exactly as the customer create rule requires.
        customerId: actorUid,
        userId: actorUid,
        // Identity mirrors the paid path: Firestore ref id in the BODY, so the
        // customer list/track can key it without guessing from the ref.
        id: input.orderId,
        orderId: input.orderId,
        branchId,
        ...(storeId ? { storeId } : {}),
        shortCode: shortCodePlan.code,
        // Fulfillment (canonical + the legacy aliases the KOT builder reads).
        orderType: input.orderType,
        fulfillment: input.orderType,
        fulfillmentType: input.orderType,
        // Display snapshots (never money).
        ...(storeSnapshot ? { store: storeSnapshot } : {}),
        ...(address ? { address } : {}),
        ...(address ? { deliveryAddress: address } : {}),
        ...(input.customerName ? { customerName: input.customerName } : {}),
        ...(input.customerPhone ? { customerPhone: input.customerPhone } : {}),
        items: customerLines,
        ...(input.promo !== undefined && input.promo !== null ? { promo: input.promo } : {}),
        // Stamp the code the SERVER priced with, as the online path does, so
        // the KOT, receipt, cancel release and support trail agree.
        ...(couponCode ? { couponCode } : {}),
        tipAmount: input.tipAmount ?? 0,
        loyaltyPointsRedeemed: 0,
        ...(input.notes ? { notes: input.notes } : {}),
        ...(input.fulfillmentInstructions
          ? { fulfillmentInstructions: input.fulfillmentInstructions }
          : {}),
        ...(input.tableNumber ? { tableNumber: input.tableNumber } : {}),
        // Owner decision 2026-11-25 #3: OFF unless the customer explicitly said
        // yes, with a server-stamped consent time. Never inferred from absence.
        ...whatsappConsentFields(input.whatsappOptIn),
        ...(estimatedAt ? { estimatedAt } : {}),
        ...(quoteId ? { deliveryQuoteId: quoteId } : {}),
        // Server-owned state.
        status: placed,
        paymentMethod: "cod",
        paymentStatus: "pending",
        payment: { method: "cod", label: paymentLabel, status: "pending" },
        // THE marker. Only this module writes it, and every cash-aware reader
        // (KOT-on-create, delivery OTP, Partner cash stream) keys on it.
        paymentChannel: "cash",
        // cycle 9c: the canonical settlement key belongs on the ORDER DOC,
        // not only inside `cashReceipt` (settlementMath queries this field).
        settlementEffectiveAtMs: placedAtMs,
        settlementCaptureState: "confirmed",
        settlementCaptureUnresolved: false,
        cashDuePaise,
        cashOnDelivery: {
          maxOrderValuePaise: config.cashOnDelivery?.maxOrderValuePaise ?? null,
          // Snapshot for dispatch: an unready provider must never book COD,
          // even if the branch config changed after checkout.
          ...(config.cashOnDelivery?.courierCod
            ? {
                courierCod: {
                  enabled: config.cashOnDelivery.courierCod.enabled,
                  providers: { ...config.cashOnDelivery.courierCod.providers },
                },
              }
            : {}),
        },
        pricing: customerTotals,
        totals: customerTotals,
        // Flat mirrors the Partner lists/reports read without normalising.
        subtotal: totals.foodSubtotal,
        tax: totals.gst,
        deliveryFee: totals.deliveryFee,
        total: totals.grandTotal,
        cashRequestHash: requestHash,
        cashReceipt: receipt,
        createdAt: timestamp,
        updatedAt: timestamp,
        placedAt: placedAtIso,
      });

      if (attemptRef) tx.create(attemptRef, {actorUid, requestHash, receipt, createdAt:timestamp});
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
  return receipt;
}
