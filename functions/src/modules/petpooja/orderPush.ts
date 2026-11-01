import { db } from "../../core/firebase";
import { findDeliveryFeeQuoteForOrder, bindDeliveryQuote } from "../payments/deliveryQuotes";
import { allocatePetpoojaTax, sumPetpoojaItemTax } from "./taxAmounts";
import { petpoojaFinancials } from "./financials";
import { config, assertLivePetpoojaContext } from "../../config/env";
import { captureErrorSnapshot } from "../../core/errors";
import { getPetpoojaConfig } from "./client";
import { calculateOrderPricing, applyCatalogBasePrice, validateOptionSelections } from "../payments/pricing.engine";
import * as admin from "firebase-admin";
import { assertOrderBranchAccess, type StaffCaller } from "../../core/middleware";

function getCallbackUrl(): string {
  return (
    (config.petpooja as { callbackUrl?: string }).callbackUrl ||
    `https://asia-south1-${config.firebase.projectId}.cloudfunctions.net/api/petpooja/webhook`
  );
}

/**
 * Normalizes a customer contact to what the Petpooja Save Order API accepts
 * (10-digit Indian mobile, or an E.164 `+<country><number>`).
 * NEVER invents a number: unknown shapes and obvious dummies collapse to ""
 * so the push fails visibly (snapshot below) instead of dispatching a rider
 * to a fabricated contact. Valid inputs pass through unchanged — the
 * normalization is idempotent.
 */
const DUMMY_PHONES = new Set(["1234567890", "9876543210", "0000000000", "1111111111"]);

/** Petpooja's save_order payload prices are strings with 2 decimals. */
const money = (n: number): string => (Number.isFinite(n) ? Number(n).toFixed(2) : "0.00");

/**
 * A payload that cannot be built truthfully (R4b): a line/add-on/variation has
 * no VERIFIED POS id, so relaying would hand the POS a fabricated or empty id
 * and land the food on the wrong item. The order is parked for an operator —
 * there is nothing a blind retry could fix.
 */
export interface PetpoojaStructuralGap {
  field: string;
  reason: string;
}

export class PetpoojaStructuralError extends Error {
  readonly code = "PETPOOJA_STRUCTURAL_BLOCK";
  readonly gaps: PetpoojaStructuralGap[];

  constructor(gaps: PetpoojaStructuralGap[]) {
    super(
      // "BLOCKED_CONFIGURATION" is the operator-facing class name the vendor
      // tooling and both test families grep for; it is not a generic failure.
      `BLOCKED_CONFIGURATION: KOT blocked: ${gaps.length} unverified POS mapping${
        gaps.length === 1 ? "" : "s"
      }. ${gaps.map((g) => `${g.field}: ${g.reason}`).join("; ")}`
    );
    this.name = "PetpoojaStructuralError";
    this.gaps = gaps;
  }
}

/** First non-empty explicit POS id from the given candidates (never a local id). */
function firstPosId(candidates: unknown[]): string {
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null) continue;
    const value = String(candidate).trim();
    if (value !== "") return value;
  }
  return "";
}

/**
 * Per-line / per-order tax rows for the KOT.
 *
 * Petpooja needs tax ids that exist on the OUTLET. The old payload sent
 * `id: "cgst"` / `"sgst"` — labels that name no tax row — and omitted
 * `item_tax` from the lines entirely, so every line arrived untaxed while the
 * order still declared a tax total.
 *
 * A branch declares its own rows as `petpoojaTaxes: [{id, name, rate}]` (what
 * the menu sync writes when it captures the outlet's `taxes[]`). There is NO
 * universal default: an outlet's row ids are outlet-specific, so a branch that
 * has not captured them is BLOCKED (see the positive-GST guard) instead of
 * being sent a guessed id that names no row on that outlet.
 */
function outletTaxes(branch: any): Array<{ id: string; name: string; rate: number }> {
  const declared = branch?.petpoojaTaxes;
  if (Array.isArray(declared) && declared.length > 0) {
    return declared
      .filter((t: any) => t && t.id)
      .map((t: any) => ({
        id: String(t.id),
        name: String(t.name || ""),
        rate: Number(t.rate) || 0,
      }));
  }
  return [];
}

export function normalizeCustomerPhone(raw: any): string {
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim();
  if (!trimmed) return "";
  const digits = trimmed.replace(/\D/g, "");
  if (!digits || DUMMY_PHONES.has(digits)) return "";
  // 10-digit local number (what Petpooja documents).
  if (digits.length === 10) return digits;
  // +91XXXXXXXXXX / 91XXXXXXXXXX → keep the explicit country form.
  if (trimmed.startsWith("+") && digits.length >= 10 && digits.length <= 15) {
    return `+${digits}`;
  }
  if (digits.length === 12 && digits.startsWith("91")) return `+${digits}`;
  // 0XXXXXXXXXX (trunk prefix) → +XXXXXXXXXX.
  if (digits.length === 11 && digits.startsWith("0")) return `+${digits.slice(1)}`;
  return "";
}

/**
 * KOT timestamps must be IST wall-clock time regardless of where the
 * function runs. The old local-zone formatting shifted every preorder/
 * created timestamp by the deploy region's offset (finding: petpoojaClock
 * timezone) — kitchens plan around these fields.
 */
const PETPOOJA_TZ = "Asia/Kolkata";

export function petpoojaClock(now: Date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: PETPOOJA_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value || "00";
  // Some ICU builds render midnight as hour "24" with hourCycle h23 off.
  const hour = get("hour") === "24" ? "00" : get("hour");
  const date = `${get("year")}-${get("month")}-${get("day")}`;
  const time = `${hour}:${get("minute")}:${get("second")}`;
  return { preorderDate: date, preorderTime: time, createdOn: `${date} ${time}` };
}

/**
 * Petpooja item id for an order line.
 *
 * The `orders` document stores the app's `CartLine` shape — `productId`,
 * `unitPrice`, `veg`, and an optional `meta` bag — none of which is a field name
 * this relay used to read (`petpoojaItemId` / `itemId` / `id`). Every line
 * therefore went out with no id at all and the POS had nothing to match.
 *
 * Accepts, in order of authority:
 *   1. an explicit POS id on the line (`petpoojaItemId`)
 *   2. the cart's `meta` bag (`meta.petpoojaItemId`)
 *   3. a legacy `itemId` / `id`
 *   4. the menu doc id the sync writes, `prod_<branchId>_<petpoojaItemId>`,
 *      stripped by exact prefix — never parsed loosely.
 * Returns "" when nothing resolves, so the gap stays visible.
 */
function linePetpoojaItemId(item: any, firestoreBranchId?: string): string {
  const meta = item?.meta || {};
  for (const candidate of [item?.petpoojaItemId, meta.petpoojaItemId, item?.itemId, item?.id]) {
    if (candidate !== undefined && candidate !== null && String(candidate).trim() !== "") {
      return String(candidate);
    }
  }
  const productId = item?.productId;
  if (firestoreBranchId && typeof productId === "string") {
    const prefix = `prod_${firestoreBranchId}_`;
    if (productId.startsWith(prefix)) return productId.slice(prefix.length);
  }
  return "";
}

/** Unit price of a line: the app writes `unitPrice`; legacy shapes write price/basePrice. */
function lineUnitPrice(item: any): number {
  return Number(item?.basePrice ?? item?.price ?? item?.unitPrice ?? 0) || 0;
}

export interface PosAddonRow {
  posId: string;
  posGroupId: number;
  groupName: string;
  name: string;
  price: number;
}

export interface PosCatalogLine {
  /** The unit price the POS line must carry (catalog-derived). */
  unitPrice: number;
  /** Present when the line selects a catalog variation option (M3). */
  variation?: { posItemId: string; posVariationId: string; name: string };
  addons: PosAddonRow[];
}

/**
 * POS-11 + M3: the POS lines for an order, in order, resolved from the
 * CATALOG, or a structural refusal.
 *
 * - Price: `products/{id}.price` plus the CATALOG prices of the selected
 *   options (PAY-16), never the order document's number.
 * - Add-on: POS id and group id come from the catalog option/group, never from
 *   the client's modifier.
 * - Variation: the catalog variation option supplies posItemId (the line `id`),
 *   posVariationId, the option name and its absolute price.
 *
 * Anything unresolvable parks the order (structural): no fabricated ids, no
 * client price.
 */
async function resolveCatalogLines(order: any): Promise<PosCatalogLine[]> {
  const items = Array.isArray(order?.items) ? order.items : [];
  if (items.length === 0) return [];

  const keyOf = (item: any): string => String(item?.productId || item?.id || "");
  const wanted: string[] = Array.from(
    new Set<string>(items.map(keyOf).filter((key: string) => key !== ""))
  );
  const priceByKey = new Map<string, number>();
  // PAY-16: the product's own option data, so selected options are priced from
  // the catalog rather than the order document.
  const optionsByKey = new Map<string, any[] | undefined>();

  if (wanted.length > 0 && db && typeof db.collection === "function") {
    try {
      if (typeof (db as any).getAll === "function") {
        const refs = wanted.map((id) => db.collection("products").doc(id));
        const snaps = await (db as any).getAll(...refs);
        // getAll preserves request order; key by the requested id rather than
        // trusting the snapshot's id field (absent on some datastore shims).
        wanted.forEach((id, index) => {
          const snap = snaps[index];
          const data = snap?.data?.();
          if (snap?.exists && typeof data?.price === "number") {
            priceByKey.set(id, data.price);
            optionsByKey.set(id, data?.customizations);
          }
        });
      } else {
        for (const id of wanted) {
          const snap = await db.collection("products").doc(id).get();
          const data = snap?.data?.();
          if (snap?.exists && typeof data?.price === "number") {
            priceByKey.set(id, data.price);
            optionsByKey.set(id, data?.customizations);
          }
        }
      }
    } catch (err: any) {
      throw new PetpoojaStructuralError([
        {
          field: "products",
          reason: `catalog price read failed (${err?.message || err}) — refusing to price POS lines from the order document`,
        },
      ]);
    }
  }

  const gaps: PetpoojaStructuralGap[] = [];
  const lines = items.map((item: any, index: number): PosCatalogLine => {
    const key = keyOf(item);
    const catalogPrice = priceByKey.get(key);
    if (catalogPrice === undefined) {
      gaps.push({
        field: `OrderItem.details[${index}].price`,
        reason: `item "${item?.name ?? "(unnamed)"}" has no catalog price (product "${key || "(no id)"}") — refusing to relay the order document's price`,
      });
      return { unitPrice: 0, addons: [] };
    }

    const customizations = optionsByKey.get(key);
    // M2a: the same server-side selection rules as the pricing engine, so a
    // cash order with a skipped required option / over-limit group /
    // unavailable option parks instead of printing a wrong KOT.
    validateOptionSelections(item, customizations);
    // option id -> { option, group } across every group on the product.
    const optionIndex = new Map<string, { option: any; group: any }>();
    if (Array.isArray(customizations)) {
      for (const group of customizations) {
        for (const option of Array.isArray(group?.options) ? group.options : []) {
          const id = String(option?.id ?? "").trim();
          if (id) optionIndex.set(id, { option, group });
        }
      }
    }

    const selections: Array<{ id: string; name: string; kind: "customization" | "modifier" }> = [];
    if (Array.isArray(item?.customizations)) {
      for (const c of item.customizations) {
        selections.push({
          id: String((c as any)?.id ?? (c as any)?.optionId ?? "").trim(),
          name: String((c as any)?.name ?? ""),
          kind: "customization",
        });
      }
    }
    if (Array.isArray(item?.modifiers)) {
      for (const m of item.modifiers) {
        selections.push({
          id: String((m as any)?.id ?? (m as any)?.optionId ?? "").trim(),
          name: String((m as any)?.name ?? ""),
          kind: "modifier",
        });
      }
    }

    let variation: PosCatalogLine["variation"];
    const addons: PosAddonRow[] = [];
    let unitPrice = catalogPrice;

    for (const selection of selections) {
      const match = selection.id ? optionIndex.get(selection.id) : undefined;
      if (!match) {
        gaps.push({
          field: `OrderItem.details[${index}].options`,
          reason: `${selection.kind} "${selection.name || selection.id || "(unnamed)"}" is not in the product's catalog option data`,
        });
        continue;
      }
      const { option, group } = match;
      if (group?.kind === "variation") {
        const posItemId = String(option?.posItemId ?? option?.id ?? "").trim();
        const posVariationId = String(option?.posVariationId ?? "").trim();
        if (!posItemId || !posVariationId) {
          gaps.push({
            field: `OrderItem.details[${index}].variation_id`,
            reason: `variation "${option?.name ?? selection.name}" has no verified POS variation id in the catalog`,
          });
          continue;
        }
        const absolute = Number(option?.absolutePrice);
        variation = {
          posItemId,
          posVariationId,
          name: String(option?.name ?? selection.name ?? ""),
        };
        // The variation's absolute price is the line base (not base + delta).
        if (Number.isFinite(absolute) && absolute >= 0) unitPrice = absolute;
      } else {
        const posGroupId = Number(group?.posGroupId);
        const posId = String(option?.id ?? "").trim();
        if (!posId || !Number.isInteger(posGroupId) || posGroupId <= 0) {
          gaps.push({
            field: `OrderItem.details[${index}].AddonItem.details[]`,
            reason: `add-on "${option?.name ?? selection.name}" has no verified POS addon/group id in the catalog`,
          });
          continue;
        }
        const price = Number(option?.price);
        const addonPrice = Number.isFinite(price) && price >= 0 ? price : 0;
        addons.push({
          posId,
          posGroupId,
          groupName: String(group?.name ?? "Addons"),
          name: String(option?.name ?? selection.name ?? ""),
          price: addonPrice,
        });
        unitPrice += addonPrice;
      }
    }

    return {
      unitPrice: Math.round(Math.max(0, unitPrice) * 100) / 100,
      ...(variation ? { variation } : {}),
      addons,
    };
  });

  if (gaps.length > 0) throw new PetpoojaStructuralError(gaps);
  return lines;
}

/** Canonical order type for KOT/pricing purposes. */
function kotOrderType(order: any): "delivery" | "takeaway" | "dinein" {
  const rawType = String(order?.fulfillmentType || order?.orderType || "delivery").toLowerCase();
  return rawType === "takeaway" || rawType === "pickup"
    ? "takeaway"
    : rawType === "dinein" || rawType === "dine_in"
      ? "dinein"
      : "delivery";
}

interface KotDeliveryFeeBinding {
  /** Fee for delivery_charges; undefined only for non-delivery orders. */
  fee?: number;
  /** True when no verified quote could be used — the KOT still relays. */
  unverified: boolean;
  reason?: string;
}

/**
 * R6b — the cash delivery path. A cash order never calls createPaymentOrder,
 * so nothing has bound its courier quote. Before the KOT is built we bind it
 * here, in the same transaction as the online path, with ONE deliberate
 * difference: expiry is judged at the order's server-readable createdAt (+ a
 * small grace), because staff may accept long after the quote's TTL. The fee
 * was quoted while the customer was checking out; that is what must be true.
 *
 * A missing/invalid quote never blocks the kitchen: the caller relays with
 * delivery_charges 0 and an operator-visible flag. A client-written fee on the
 * order is never used as money.
 */
async function resolveKotDeliveryFee(
  order: any,
  orderId: string,
  branchId: string,
  orderType: "delivery" | "takeaway" | "dinein"
): Promise<KotDeliveryFeeBinding> {
  if (orderType !== "delivery") return { unverified: false };

  // Already bound (online payment, or a previous accept): reuse it.
  const bound = await findDeliveryFeeQuoteForOrder(orderId);
  const boundFee = Number(bound?.fee);
  if (Number.isFinite(boundFee) && boundFee > 0) {
    return { fee: Math.round(boundFee * 100) / 100, unverified: false };
  }

  const quoteId =
    typeof order?.deliveryQuoteId === "string" && order.deliveryQuoteId.trim()
      ? order.deliveryQuoteId.trim()
      : null;
  if (!quoteId) {
    return {
      fee: 0,
      unverified: true,
      reason: "no deliveryQuoteId on the order — the courier fee could not be verified",
    };
  }

  try {
    const fee = await bindDeliveryQuote({
      quoteId,
      orderId,
      uid: String(order?.customerId || order?.userId || ""),
      branchId,
      expiryMode: "orderCreated",
    });
    return { fee, unverified: false };
  } catch (err: any) {
    return {
      fee: 0,
      unverified: true,
      reason: `delivery quote ${quoteId} rejected: ${err?.message || err}`,
    };
  }
}

/**
 * Resolve server-authoritative pricing BEFORE a KOT/COD payload is built.
 *
 * Online orders carry `pricing` stamped by createPaymentOrder / the webhook.
 * Legacy and COD orders may have only client-authored `totalAmount` / `total`.
 * The old builder fell back to those values, so a client could choose the cash
 * amount printed on the KOT. This resolver recomputes against the catalog when
 * `pricing` is absent and writes the result back; the builder then refuses to
 * emit a payload without server pricing at all.
 */
async function ensureAuthoritativeOrderPricing(
  order: any,
  orderId: string,
  branchId: string,
  kotDeliveryFee?: KotDeliveryFeeBinding
): Promise<any> {
  const existing = order?.pricing;
  if (existing && Number.isFinite(Number(existing.grandTotal))) return order;

  const items = Array.isArray(order?.items) ? order.items : [];
  if (items.length === 0) {
    const err: any = new Error(
      `Order ${orderId} has no items — refusing KOT without authoritative pricing`
    );
    err.statusCode = 422;
    throw err;
  }

  const orderType = kotOrderType(order);

  const pricing = await calculateOrderPricing({
    // The engine resolves the authoritative catalog price; `price` is only the
    // validated line shape it expects. Product ids and quantities must be the
    // real order values, never fabricated.
    items: items.map((item: any) => ({
      id: String(item?.lineId || item?.id || item?.productId || ""),
      productId: String(item?.productId || item?.id || ""),
      name: String(item?.name || ""),
      price: lineUnitPrice(item),
      quantity: Number(item?.quantity) || 1,
      customizations: item?.customizations,
      modifiers: item?.modifiers || item?.selectedAddons,
    })),
    branchId,
    orderType,
    // R6/R6b: the fee is NEVER read off the order document (client-writable).
    // Only the courier quote already bound to THIS order (or bound moments ago
    // by resolveKotDeliveryFee) may supply it. When no quote could be verified
    // the fee is 0 and the order is flagged — the kitchen still cooks.
    serverDeliveryFee:
      orderType === "delivery" ? (kotDeliveryFee?.fee ?? 0) : undefined,
    couponCode: order?.couponCode,
    // The client always sends zero points after D31–D33; never let a legacy
    // client payload re-introduce a redemption into a POS total.
    loyaltyPointsToRedeem: 0,
  });

  await db
    .collection("orders")
    .doc(orderId)
    .set(
      { pricing, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
      { merge: true }
    );

  return { ...order, pricing };
}

export function formatPetpoojaOrderPayload(
  order: any,
  branch: any,
  resId: string,
  firestoreBranchId?: string,
  orderDocId?: string,
  /**
   * R6b: the courier fee the caller verified for THIS KOT (server-resolved).
   * Overrides `pricing.deliveryFee`; 0 is a real value (unverified quote) and
   * undefined means "not a delivery KOT — use the stored pricing".
   */
  kotDeliveryFee?: number,
  /**
   * M3: catalog-resolved POS lines (price, add-on ids/group ids, variation
   * identity). The push path ALWAYS supplies them; undefined only for
   * direct/fixture callers that have no catalog.
   */
  catalogLines?: PosCatalogLine[]
) {
  const fulfillment = (order.fulfillmentType || order.orderType || "DELIVERY").toUpperCase();
  // Official V2.1.0 order_type is a letter code: H (home delivery),
  // P (parcel/takeaway), D (dine-in). The numeric 1/2/3 form the old code sent
  // is not part of the documented contract — both are emitted so the POS
  // parser reads whichever it implements.
  const orderTypeCode =
    fulfillment === "DELIVERY" ? "H" : fulfillment === "TAKEAWAY" || fulfillment === "PICKUP" ? "P" : "D";
  const orderTypeLegacy = fulfillment === "DELIVERY" ? "1" : fulfillment === "TAKEAWAY" || fulfillment === "PICKUP" ? "2" : "3";

  const paymentMethod = (order.paymentMethod || "").toUpperCase();
  // Petpooja accepts COD / CARD / ONLINE. "Prepaid" is NOT a valid value —
  // anything that is not cash on delivery is an online (captured) payment.
  const paymentType = paymentMethod === "COD" || paymentMethod === "CASH" ? "COD" : "ONLINE";

  // Hoisted so each line can carry its own share of the tax: Petpooja expects
  // `item_tax[]` on the line, and a line's share can only be derived once the
  // order's tax total is known.
  //
  // POS-11: every money figure below comes from the SERVER catalog line price
  // (`catalogLinePrices`), never from the price written on the order document.
  const lineUnit = (item: any, index: number): number => {
    if (!catalogLines) return lineUnitPrice(item);
    const resolved = Number(catalogLines[index]?.unitPrice);
    if (!Number.isFinite(resolved) || resolved < 0) {
      throw new PetpoojaStructuralError([
        {
          field: `OrderItem.details[${index}].price`,
          reason: `item "${item?.name ?? "(unnamed)"}" has no server catalog price`,
        },
      ]);
    }
    return resolved;
  };
  const preItems = order.items || [];
  const preGst = Number(order?.pricing?.gst) || 0;
  const branchTaxes = outletTaxes(branch);
  // R4b: the included GST is divided across lines in EXACT integer paise
  // (largest remainder), so the Tax rows can be the literal sum of the
  // serialized item_tax amounts instead of an independently rounded figure.
  const itemGstAmounts = allocatePetpoojaTax(
    preGst,
    preItems.map((it: any, index: number) => lineUnit(it, index) * (Number(it.quantity) || 1))
  );
  // Structural gaps (unverified POS ids) are collected for the WHOLE order and
  // thrown once, so an operator sees every problem in one refusal.
  const structuralGaps: PetpoojaStructuralGap[] = [];

  const orderItems = (order.items || []).map((item: any, itemIndex: number) => {
    // POS-11: catalog-derived unit price, not the order document's price.
    const unit = lineUnit(item, itemIndex);
    const qty = Number(item.quantity) || 1;
    // M3: when the caller resolved catalog lines, the POS ids, variation and
    // add-on rows come from the CATALOG — never from the client's modifier.
    const catalogLine = catalogLines ? (catalogLines[itemIndex] as PosCatalogLine) : undefined;
    const itemPosId = catalogLine
      ? catalogLine.variation?.posItemId || linePetpoojaItemId(item, firestoreBranchId)
      : linePetpoojaItemId(item, firestoreBranchId);
    if (itemPosId === "") {
      structuralGaps.push({
        field: `OrderItem.details[${itemIndex}].id`,
        reason: `item "${item?.name ?? "(unnamed)"}" has no verified Petpooja item id (no menu-sync mapping)`,
      });
    }

    // R4b: NEVER fabricate an id. An add-on goes out only with the POS's own
    // addon id and numeric group id; the old `mod.id || "addon"` +
    // `Number(...) || 0` fallbacks invented both.
    // M3: with a resolved catalog line, the ids/group/price ADD come from the
    // catalog option; the client's modifier is only the selection key.
    const rawAddons = item.modifiers || item.selectedAddons || [];
    const addons = catalogLine
      ? catalogLine.addons.map((addon) => ({
          id: addon.posId,
          name: addon.name,
          group_name: addon.groupName,
          price: money(addon.price),
          // The vendor sample types group_id as an integer, not a string.
          group_id: addon.posGroupId,
          quantity: "1",
        }))
      : rawAddons.map((mod: any) => {
          const addonId = firstPosId([mod?.petpoojaItemId, mod?.petpoojaAddonId, mod?.petpoojaOptionId]);
          const groupIdRaw = mod?.petpoojaGroupId ?? mod?.petpoojaGroup_id ?? mod?.posGroupId;
          const groupId = Number(groupIdRaw);
          const groupVerified =
            groupIdRaw !== undefined &&
            groupIdRaw !== null &&
            groupIdRaw !== "" &&
            Number.isInteger(groupId) &&
            groupId > 0;
          if (!addonId) {
            structuralGaps.push({
              field: `OrderItem.details[${itemIndex}].AddonItem.details[].id`,
              reason: `add-on "${mod?.name ?? "(unnamed)"}" has no verified Petpooja addon id`,
            });
          }
          if (!groupVerified) {
            structuralGaps.push({
              field: `OrderItem.details[${itemIndex}].AddonItem.details[].group_id`,
              reason: `add-on "${mod?.name ?? "(unnamed)"}" has no verified Petpooja group id`,
            });
          }
          return {
            id: addonId,
            name: mod.name,
            group_name: mod.groupName || "Addons",
            // CartModifier carries `priceDelta`; `price` is the legacy spelling.
            price: money(mod.price ?? mod.priceDelta ?? 0),
            // The vendor sample types group_id as an integer, not a string.
            group_id: groupVerified ? groupId : 0,
            quantity: "1",
          };
        });

    // M3: a variation comes from the catalog. Without a resolved catalog line,
    // keep the legacy behaviour (verified explicit POS fields only).
    let variationId: string;
    let variationName: string;
    let lineName: string;
    if (catalogLine) {
      variationId = catalogLine.variation?.posVariationId || "";
      variationName = catalogLine.variation?.name || "";
      lineName = catalogLine.variation
        ? `${item.name} (${catalogLine.variation.name})`
        : item.name;
    } else {
      // R4b: a variation without a verified POS id cannot be matched by the POS;
      // sending the local name/id would print the wrong dish.
      variationId = firstPosId([item.petpoojaVariationId, item.posVariationId]);
      variationName = item.petpoojaVariationName || item.variationName || "";
      if (variationName && !variationId) {
        structuralGaps.push({
          field: `OrderItem.details[${itemIndex}].variation_id`,
          reason: `item "${item?.name ?? "(unnamed)"}" carries variation "${variationName}" without a verified Petpooja variation id`,
        });
      }
      lineName = item.name;
    }

    // Each line's included GST, split evenly (exactly, in paise) across the
    // outlet's tax rows.
    const lineGst = itemGstAmounts[itemIndex] ?? 0;
    const lineTaxSplit = branchTaxes.length
      ? allocatePetpoojaTax(lineGst, branchTaxes.map(() => 1))
      : [];

    return {
      id: itemPosId,
      name: lineName,
      // Owner decision 2026-10-31 (pricing-contract.md R4): menu prices are
      // GST-INCLUSIVE. `price`/`final_price` below stay the inclusive menu
      // price and `item_tax` carries each line's share of the INCLUDED tax.
      // Declaring false used to tell the POS the amount was ex-GST and let it
      // add the tax on top a second time.
      tax_inclusive: true,
      gst_liability: "restaurant",
      item_tax: branchTaxes.map((t, taxIndex) => ({
        id: t.id,
        name: t.name,
        tax_percentage: String(t.rate),
        amount: money(lineTaxSplit[taxIndex] ?? 0),
      })),
      // No per-line discount exists in this order model; order-level discounts
      // travel as `discount_type` + `discount_total`. The vendor sample defines
      // `final_price = price - item_discount` — a UNIT figure, not the line
      // total. The old line-total form broke that invariant for qty > 1.
      item_discount: money(0),
      price: money(unit),
      final_price: money(unit),
      quantity: String(qty),
      description: item.notes || item.specialInstructions || "",
      variation_name: variationId ? variationName : "",
      variation_id: variationId,
      AddonItem: { details: addons },
    };
  });

  if (structuralGaps.length > 0) {
    throw new PetpoojaStructuralError(structuralGaps);
  }

  const pricing = order?.pricing;
  if (!pricing || !Number.isFinite(Number(pricing.grandTotal))) {
    const err: any = new Error(
      `Order ${orderDocId || order?.id || "(unknown)"} has no server-authoritative pricing — refusing KOT instead of using client totals`
    );
    err.statusCode = 422;
    throw err;
  }
  // Every money field comes from the server-stamped pricing object. Legacy
  // `order.taxAmount` / `order.totalAmount` / `order.total` are client-writable
  // and must never decide a KOT total or COD cash amount.
  const gstAmount = Number(pricing.gst) || 0;
  // POS-11/R4b: a positive GST with NO captured tax rows would print a
  // tax_total the Tax[] section cannot explain — the vendor's own consistency
  // rule. Block instead of emitting an empty tax split.
  if (gstAmount > 0 && branchTaxes.length === 0) {
    throw new PetpoojaStructuralError([
      {
        field: "Tax.details",
        reason:
          "positive order GST has no matched tax rows — capture the outlet's tax catalogue before relaying",
      },
    ]);
  }
  // R6b: the caller's verified courier fee wins; the stored value is only a
  // fallback for callers that did not resolve one (non-delivery never does).
  const deliveryFee =
    kotDeliveryFee !== undefined
      ? Math.round(Number(kotDeliveryFee) * 100) / 100
      : Number(pricing.deliveryFee) || 0;
  const packagingFee = Number(pricing.packagingFee) || 0;
  const discountAmount = Number(pricing.discount) || 0;
  const loyaltyDiscount = Number(pricing.loyaltyDiscount) || 0;
  const grandTotal = Number(pricing.grandTotal);

  // R4b: the POS `total` is the RESTAURANT DUE, not what the customer paid.
  // A third-party courier fee (Borzo/Shadowfax/Porter) is not restaurant
  // revenue: it stays in delivery_charges and out of `total`. Only a
  // restaurant's OWN rider (dispatchType manual_branch_terminal) is
  // self-delivery. Our menu prices are GST-inclusive, so the item net already
  // contains the tax and `taxIncluded: true` keeps it from being added twice.
  const isDelivery = orderTypeLegacy === "1";
  const restaurantDelivery =
    isDelivery && String(order?.dispatchType || "") === "manual_branch_terminal";
  const financials = petpoojaFinancials({
    items: orderItems,
    // Both the coupon discount and the coin (loyalty) discount reduce what the
    // restaurant is owed, so the POS total still reconciles to the customer
    // total minus any courier fee.
    discount: discountAmount + loyaltyDiscount,
    packagingFee,
    deliveryFee,
    customerTotal: grandTotal,
    isDelivery,
    restaurantDelivery,
    paymentType,
    taxIncluded: true,
  });

  // Normalized (never invented) contact + the clock fields Save Order marks
  // required. Table number rides along whenever the order carries one —
  // dine-in KOTs are useless to the floor without it.
  const customerPhone = normalizeCustomerPhone(
    order.customerPhone || order.customer?.phone
  );
  const { preorderDate, preorderTime, createdOn } = petpoojaClock();
  const tableNo = order.tableNumber ? String(order.tableNumber).trim() : "";

  // ---------------------------------------------------------------------------
  // STRUCTURE IS LOCKED TO THE VENDOR'S OWN SAMPLE (2026-10-26).
  //
  // Petpooja rejected the five sandbox test orders as structurally wrong and
  // sent back the exact body they accept. The whole envelope is:
  //
  //   {
  //     app_key, app_secret, access_token,
  //     orderinfo: {
  //       OrderInfo: { Restaurant, Customer, Order, OrderItem, Tax },
  //       udid: "",
  //       device_type: "Web"
  //     }
  //   }
  //
  // Differences from what this builder used to emit, all of them vendor-driven:
  //   - `udid` / `device_type` belong INSIDE `orderinfo`, not at the root.
  //   - There is no `Discount` member (discounts are the two Order scalars).
  //   - No legacy duplicate members under `orderinfo` (Order/Customer/...);
  //     the POS parser expects every sibling to be `OrderInfo`/`udid`/
  //     `device_type`.
  //   - `final_price` is a UNIT figure (`price - item_discount`), never the
  //     line total.
  //   - `Tax[].price` is the numeric percentage ("2.5"), not "2.5%".
  //   - `enable_delivery`, `min_prep_time`, `urgent_time`, `group_id` are
  //     NUMBERS; `no_of_persons`, `collect_cash`, `otp` are strings.
  //   - Order carries `sc_tax_amount`, `dc_tax_amount`, `pc_tax_amount`,
  //     `dc_gst_details`, `pc_gst_details`, `ondc_bap`, `urgent_order`,
  //     `urgent_time`, `no_of_persons`, `description`, `collect_cash`, `otp`.
  // ---------------------------------------------------------------------------
  const restaurantDetails = {
    // The authoritative restaurant identifier in this contract. Fail-closed:
    // this is the verified branch.petpoojaStoreId, never a guess.
    restID: resId,
    res_name: branch?.name || "Burgonomics",
    address: branch?.address || "",
    contact_information: branch?.phone || "",
  };

  // The delivery app saves the address at `deliveryAddress` (full/line1);
  // counter/legacy orders at `address.street`. Read both so the rider never
  // gets a KOT with an empty address. Never invent one.
  const customerAddress =
    orderTypeLegacy === "1"
      ? order.deliveryAddress?.full ||
        order.deliveryAddress?.line1 ||
        order.address?.street ||
        order.customerAddress ||
        ""
      : "";

  const customerLat = order.deliveryAddress?.lat ?? order.address?.lat;
  const customerLng = order.deliveryAddress?.lng ?? order.address?.lng;
  const customerDetails = {
    name: order.customerName || order.customer?.name || "Customer",
    phone: customerPhone,
    address: customerAddress,
    email: order.customerEmail || order.customer?.email || "",
    latitude: customerLat !== undefined && customerLat !== null ? String(customerLat) : "",
    longitude: customerLng !== undefined && customerLng !== null ? String(customerLng) : "",
  };

  const noOfPersons = order.guestCount ?? order.noOfPersons ?? 0;
  const prepTimeMinutes = Number(
    order.prepTimeMinutes ?? branch?.defaultPrepTimeMinutes ?? 0
  );

  const orderDetails = {
    // `orderID` is the CLIENT reference the POS echoes in its order-status
    // callback, and our webhook resolves it with `orders/{orderID}`. It must
    // therefore be the Firestore document id, not the decorative order number.
    orderID: orderDocId || order.id || order.orderNumber || "",
    preorder_date: preorderDate,
    preorder_time: preorderTime,
    service_charge: money(0),
    sc_tax_amount: money(0),
    delivery_charges: money(deliveryFee),
    // Delivery/packing charges carry no separate tax in our pricing engine.
    dc_tax_percentage: "0",
    dc_tax_amount: money(0),
    dc_gst_details: [
      { gst_liable: "restaurant", amount: money(0) },
    ],
    packing_charges: money(packagingFee),
    pc_tax_amount: money(0),
    pc_tax_percentage: "0",
    pc_gst_details: [
      { gst_liable: "restaurant", amount: money(0) },
    ],
    // Documented letter code: H (home delivery), P (parcel/takeaway), D (dine-in).
    order_type: orderTypeCode,
    // Not an ONDC order.
    ondc_bap: "",
    // advanced_order "N" = immediate order (we never schedule), so preorder_*
    // describe "now", never a fake slot.
    advanced_order: "N",
    urgent_order: false,
    urgent_time: 0,
    // Petpooja accepts COD / CARD / ONLINE only.
    payment_type: paymentType,
    table_no: tableNo,
    no_of_persons: String(noOfPersons),
    discount_total: money(discountAmount),
    // R4: the INCLUDED GST amount. The POS backs it out of the inclusive line
    // prices; it is never added to them.
    tax_total: money(gstAmount),
    // Discounts are sent as discount_type + discount_total (spec §8).
    discount_type: "F",
    // R4b: RESTAURANT DUE — item net (already GST-inclusive) less discounts,
    // plus packing, plus delivery ONLY when the restaurant delivers itself.
    // A third-party courier fee is not restaurant revenue.
    total: financials.total,
    description: order.notes || order.specialInstructions || "",
    created_on: createdOn,
    // R4b: 1 only for restaurant self-delivery.
    enable_delivery: financials.enable_delivery,
    min_prep_time: Number.isFinite(prepTimeMinutes) && prepTimeMinutes > 0 ? prepTimeMinutes : 0,
    // The POS reads the URL it POSTs order-status updates (Accept / Food Ready
    // / Reject) from Order.details.
    callback_url: getCallbackUrl(),
    // R4b: the restaurant's own rider collects cash only on self-delivery COD.
    collect_cash: financials.collect_cash,
    // Deliberately empty: the delivery OTP is the customer/rider verification
    // secret and must not be printed on a kitchen ticket.
    otp: "",
  };

  // Official Tax[] shape: id / title / type / price / tax / restaurant_liable_amt.
  // The ids must name rows that exist on the outlet. `price` is the numeric
  // percentage, matching the vendor sample (not "2.5%").
  // R4b: each row is the EXACT sum of the serialized item_tax amounts of that
  // id, so the summary can never disagree with the lines.
  const taxDetails = branchTaxes.map((t) => {
    const rowTotal = sumPetpoojaItemTax(orderItems, t.id);
    return {
      id: t.id,
      title: t.name,
      type: "P",
      price: String(t.rate),
      tax: money(rowTotal),
      restaurant_liable_amt: money(rowTotal),
    };
  });

  return {
    orderinfo: {
      OrderInfo: {
        Restaurant: { details: restaurantDetails },
        Customer: { details: customerDetails },
        Order: { details: orderDetails },
        OrderItem: { details: orderItems },
        Tax: { details: taxDetails },
      },
      // Vendor sample: both are siblings of OrderInfo, inside the `orderinfo`
      // envelope. They used to be emitted at the ROOT, where the POS ignores
      // them.
      udid: "",
      device_type: "Web",
    },
  };
}

const recentBusyPushes = new Map<string, number>();

export function wasPushDeferredBusy(orderId: string): boolean {
  const ts = recentBusyPushes.get(orderId);
  if (!ts) return false;
  if (Date.now() - ts > 60_000) {
    recentBusyPushes.delete(orderId);
    return false;
  }
  return true;
}

/**
 * CASH-KOT: is this an order the kitchen must see without any gateway capture?
 *
 * The customer app writes `payment.method: "cod"` for both cash-on-delivery
 * and pay-at-store/counter orders (OrderRepository maps `cash` → `cod`), and
 * legacy/caller payloads may still say `cash` directly. Online methods
 * (online/upi/card/netbanking/wallet) get their KOT from the Razorpay capture
 * webhook, so this gate must stay false for them.
 *
 * NOTE: `payment.method` is client-written, so this predicate is a ROUTING
 * hint, never proof of payment. It must only decide whether a STAFF-accepted
 * order (see below) gets a KOT — never whether an unpaid order is printed at
 * creation.
 */
export function isCashOrPayAtStoreOrder(order: any): boolean {
  const method = String(order?.payment?.method ?? order?.paymentMethod ?? "").toLowerCase();
  return method === "cod" || method === "cash";
}

/** Statuses that never warrant a KOT even as a first departure from PLACED. */
function statusCodeOf(order: any): string {
  return String(
    typeof order?.status === "object" ? order?.status?.code ?? "" : order?.status ?? ""
  ).toUpperCase();
}

function isCancelledOrTerminal(order: any): boolean {
  const code = statusCodeOf(order);
  if (code === "CANCELLED") return true;
  if (order?.status?.terminal === true) return true;
  return String(order?.status?.kind ?? "").toLowerCase() === "cancelled";
}

/**
 * The one transition that may push a cash KOT: the FIRST departure from PLACED
 * into any non-terminal, non-cancelled status (the KDS accept bump normally
 * lands on PREPARING; a direct PLACED → READY or CONFIRMED must not silently
 * skip the ticket). Both snapshots are required, so an unrelated update
 * (totals, rider, notes) or a later bump (PREPARING → READY, DELIVERED,
 * CANCELLED) does nothing.
 */
export function isCashKotAcceptTransition(before: any, after: any): boolean {
  if (statusCodeOf(before) !== "PLACED") return false;
  const afterCode = statusCodeOf(after);
  // A non-departure (PLACED → PLACED, e.g. a totals/notes update) is not an
  // acceptance.
  if (!afterCode || afterCode === "PLACED") return false;
  if (isCancelledOrTerminal(after)) return false;
  return isCashOrPayAtStoreOrder(after);
}

/**
 * CASH-KOT server entry: send the KOT for a cash / pay-at-store order when a
 * STAFF member accepts it (the first departure from PLACED), never at creation.
 *
 * Cash orders never reach the Razorpay capture webhook (the online KOT path),
 * and the client's own POST /petpooja/pushOrder is rejected for customers
 * (staff-only route). Gatekeeping on staff acceptance is what makes a
 * client-written "cod" flag safe: the ticket only prints after a staff member
 * has decided the order is real. The push is the same idempotent path the
 * webhook and retry worker use, so a redelivered update event cannot duplicate
 * a KOT.
 *
 * Returns null when this is not the accept transition (nothing to do).
 */
export async function pushKotForCashOrderOnAccept(
  orderId: string,
  before: any,
  after: any
): Promise<boolean | null> {
  if (!isCashKotAcceptTransition(before, after)) return null;
  return pushOrderToPetpooja(orderId);
}

export async function pushOrderToPetpooja(orderId: string, caller?: StaffCaller): Promise<boolean> {
  const orderDoc = await db.collection("orders").doc(orderId).get();
  if (!orderDoc.exists) {
    throw new Error(`Order ${orderId} does not exist`);
  }

  const order = orderDoc.data()!;
  // Staff boundary: branch-A staff cannot push Branch-B's KOT. System
  // callers (scheduler) pass no caller and skip the check.
  if (caller) await assertOrderBranchAccess(caller, order);
  const branchId = order.branchId;

  // ZERO-MOCK runtime gate: in a declared-production process the mock branch
  // below would stamp a synthetic `pp_kot_*` id and mark the KOT printed when
  // nothing was sent — refuse instead (boot assert is the first line, this is
  // the belt-and-braces check for a config flipped after boot).
  assertLivePetpoojaContext(`KOT push for order ${orderId}`);

  // Idempotency: the relayed marker is written ONLY on a successful push, so
  // its presence IS the already-pushed marker — independent of the status
  // field, which later bookkeeping may have moved off "synced". Replays (a
  // second Razorpay event, a double-tapped KDS button, the retry worker
  // racing a completed push) must never fire a duplicate KOT at the kitchen.
  //
  // TWO accepted shapes, because Petpooja does not always return an id:
  //  - `petpoojaOrderId`  — accepted, POS told us its id.
  //  - `petpoojaAcceptedNoId` — accepted, POS omitted the id (see the ack
  //    handling below). The order IS at the POS either way, so both dedupe.
  if (order.petpoojaOrderId || order.petpoojaAcceptedNoId) {
    console.warn(
      `[Petpooja KOT Push] Order ${orderId} already pushed (${
        order.petpoojaOrderId || "accepted, POS returned no id"
      }) — deduped, no duplicate KOT`
    );
    return true;
  }

  // Manual reconciliation guard: an order flagged as ambiguous or parked for
  // reconciliation must NEVER be blindly re-pushed by direct callers or retry
  // loops. Operator intervention is required to verify physical POS/kitchen state first.
  if (
    order.petpoojaStatus === "reconciliation_required" ||
    order.petpoojaAmbiguousProcessing === true ||
    (order.kotSyncFailed && (order.petpoojaStatus === "failed" || order.petpoojaStatus === "reconciliation_required"))
  ) {
    console.warn(
      `[Petpooja KOT Push] Order ${orderId} is parked for manual reconciliation (reconciliation marker / kotSyncFailed) — blocking blind direct push until operator resolves ambiguity`
    );
    return false;
  }

  // Transactional claim (finding: duplicate-KOT race): the read above is
  // NOT a lock — `payment.captured` + `order.paid` webhooks, a KDS double
  // tap, and the retry worker can all pass the dedupe concurrently and each
  // POST a KOT, ringing the kitchen N times for one paid order. This claim
  // serializes them exactly like the scheduler's pending_retry lease, on a
  // DEDICATED field (petpoojaPushClaimedAt) so the scheduler's own
  // petpoojaClaimedAt lease (taken BEFORE it calls this function) is never
  // mistaken for a competing push. Datastores without runTransaction keep
  // the read-based dedupe above (best effort, same as the scheduler).
  const PUSH_CLAIM_TTL_MS = 10 * 60 * 1000;
  if (db && typeof (db as any).runTransaction === "function") {
    let claim: "claimed" | "dup" | "busy" | "gone" | "blocked";
    try {
      claim = await (db as any).runTransaction(async (tx: any) => {
        const fresh = await tx.get(orderDoc.ref);
        const data = (fresh.exists ? fresh.data() : undefined) as any;
        if (!data) return "gone";
        // Manual reconciliation guard inside claim transaction (pre-read race check)
        if (
          data.petpoojaStatus === "reconciliation_required" ||
          data.petpoojaAmbiguousProcessing === true ||
          (data.kotSyncFailed && (data.petpoojaStatus === "failed" || data.petpoojaStatus === "reconciliation_required"))
        ) {
          return "blocked";
        }
        // A racing caller finished the push while we were reading — reuse
        // its outcome, never POST a second KOT. Both accepted shapes count.
        if (data.petpoojaOrderId || data.petpoojaAcceptedNoId) return "dup";
        // Numeric-first lease read (same trap as the scheduler): a
        // serverTimestamp sentinel has no toMillis and would read as 0,
        // causing instant false takeover and a duplicate KOT POST.
        const claimedRaw = data.petpoojaPushClaimedAt;
        const claimedAt =
          typeof claimedRaw === "number" && Number.isFinite(claimedRaw)
            ? claimedRaw
            : claimedRaw && typeof claimedRaw.toMillis === "function"
              ? claimedRaw.toMillis()
              : 0;
        if (data.petpoojaPushClaimedAt && Date.now() - claimedAt < PUSH_CLAIM_TTL_MS) {
          return "busy"; // another push is in flight right now — yield to it
        }
        tx.set(
          orderDoc.ref,
          {
            petpoojaPushClaimedAt: Date.now(),
            // F5 (claim visibility): a hard kill mid-POST must be VISIBLE to
            // the crash lane, which scans `petpoojaStatus == "processing"`.
            // The lease alone is not enough once the process dies before the
            // post-ack write.
            petpoojaStatus: "processing",
            petpoojaSyncStatus: "processing",
          },
          { merge: true }
        );
        return "claimed";
      });
    } catch (err: any) {
      console.warn(
        `[Petpooja KOT Push] claim transaction failed for order ${orderId} — skipping push:`,
        err?.message || err
      );
      return false;
    }
    if (claim === "blocked") {
      console.warn(
        `[Petpooja KOT Push] Order ${orderId} is parked for manual reconciliation inside claim transaction — blocking push`
      );
      return false;
    }
    if (claim === "dup") {
      console.warn(
        `[Petpooja KOT Push] Order ${orderId} already pushed by a concurrent caller — deduped, no duplicate KOT`
      );
      return true;
    }
    if (claim === "busy") {
      // The in-flight owner either completes (KOT at the kitchen) or its
      // catch below parks pending_retry for the retry worker — either way
      // this caller must not stack a second POST on top of it.
      // Honest failure/deferred return: busy is NOT confirmed success.
      if (recentBusyPushes.size > 500) {
        const now = Date.now();
        for (const [k, v] of recentBusyPushes.entries()) {
          if (now - v > 60_000) recentBusyPushes.delete(k);
        }
      }
      recentBusyPushes.set(orderId, Date.now());
      console.warn(
        `[Petpooja KOT Push] Order ${orderId} push already in flight — yielding to the owner`
      );
      return false;
    }
    if (claim === "gone") {
      console.warn(`[Petpooja KOT Push] Order ${orderId} vanished before push — refusing`);
      return false;
    }
  }

  // Mock Mode Return
  if (config.mock.petpoojaPos) {
    const mockPetpoojaOrderId = `pp_kot_${Date.now()}`;
    await orderDoc.ref.set(
      {
        petpoojaOrderId: mockPetpoojaOrderId,
        petpoojaStatus: "synced",
        petpoojaSyncStatus: "synced",
        petpoojaMock: true,
        // KOT Truth: network relay acceptance or mock delivery is NOT physical printer proof.
        // kotPrinted / kotPrintedAt are never manufactured without physical printer proof.
        kotPushedAt: admin.firestore.FieldValue.serverTimestamp(),
        petpoojaPushClaimedAt: null,
        petpoojaClaimedAt: null,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    return true;
  }

  // Point of no return (F3): true once the POS ACKNOWLEDGED a POST. Any later
  // failure (including Firestore writes) must never become a retry.
  let posAccepted = false;
  let posAcceptedOrderId = "";
  let posAcceptedAckBody: string | null = null;

  try {
    let branchData: any = null;
    if (branchId) {
      const branchSnap = await db.collection("branches").doc(branchId).get();
      if (branchSnap.exists) {
        branchData = branchSnap.data();
      }
    }

    const petpoojaConfig = getPetpoojaConfig();

    // Fail-closed: resID must come from branch.petpoojaStoreId only.
    // Fallback chains (branch.id, order.branchId, order.store.*) could send
    // KOT to the wrong outlet — fail instead of guessing.
    const resId = branchData?.petpoojaStoreId;
    if (!resId) {
      await captureErrorSnapshot({
        source: "petpooja",
        severity: "p0_critical",
        message: `Order ${orderId} missing branch.petpoojaStoreId — cannot push KOT to unknown outlet`,
        orderId,
        branchId,
      });
      const err: any = new Error("Branch Petpooja Store ID not configured — cannot push KOT");
      err.statusCode = 503;
      throw err;
    }

    // B02: never build a KOT/COD payload from client-authored totals. Resolve
    // and persist server pricing first; the formatter itself also fails closed.
    // R6b: cash delivery orders bind their courier quote HERE (nothing else
    // did), and an unverifiable quote flags the order instead of blocking food.
    const deliveryBinding = await resolveKotDeliveryFee(
      order,
      orderId,
      branchId,
      kotOrderType(order)
    );
    if (deliveryBinding.unverified) {
      console.warn(
        `[Petpooja KOT Push] Order ${orderId}: courier fee UNVERIFIED — relaying with delivery_charges 0. ${deliveryBinding.reason}`
      );
      await captureErrorSnapshot({
        source: "petpooja",
        severity: "high",
        message: `Courier fee unverified for order ${orderId} — KOT relayed with delivery_charges 0 (${deliveryBinding.reason})`,
        orderId,
        branchId,
      });
    }
    await orderDoc.ref.set(
      {
        deliveryFeeUnverified: deliveryBinding.unverified,
        deliveryFeeUnverifiedReason: deliveryBinding.unverified
          ? deliveryBinding.reason || "delivery quote could not be verified"
          : null,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    const pricedOrder = await ensureAuthoritativeOrderPricing(
      order,
      orderId,
      branchId,
      deliveryBinding
    );
    // POS-11 + M3: price every POS line from the catalog and take the add-on /
    // variation POS ids from it too; park instead of relaying the order
    // document's (client-written) price or modifier ids.
    const catalogLines = await resolveCatalogLines(pricedOrder);
    const payload = formatPetpoojaOrderPayload(
      pricedOrder,
      branchData,
      resId,
      branchId,
      orderId,
      deliveryBinding.fee,
      catalogLines
    );

    // Debug visibility: missing contact or zero totals push a broken KOT that
    // looks successful. Flag loudly instead of masking with fallbacks.
    if (!payload.orderinfo.OrderInfo.Customer.details.phone) {
      await captureErrorSnapshot({
        source: "petpooja",
        severity: "medium",
        message: `KOT push for order ${orderId} has no customer phone — rider contact will fail`,
        orderId,
        branchId,
      });
    }
    if (!(Number(payload.orderinfo.OrderInfo.Order.details.total) > 0)) {
      await captureErrorSnapshot({
        source: "petpooja",
        severity: "medium",
        message: `KOT push for order ${orderId} resolved total=0 — pricing data missing upstream`,
        orderId,
        branchId,
      });
    }

    const response = await fetch(petpoojaConfig.orderUrl, {
            method: "POST",
            // Loop: hung gateway held the function until platform timeout.
            signal: AbortSignal.timeout(15_000),
      headers: {
        "Content-Type": "application/json",
        // Headers used by the tested sandbox relay (all five scenarios
        // returned HTTP 200 with them). `Content_key` is kept for the older
        // gateway build that reads that spelling.
        "Content-Type-Override": "application/json",
        "app-key": petpoojaConfig.appKey,
        "app-secret": petpoojaConfig.appSecret,
        "access-token": petpoojaConfig.accessToken,
        Content_key: petpoojaConfig.appKey,
        Authorization: `Bearer ${petpoojaConfig.accessToken}`,
      },
      body: JSON.stringify({
        app_key: petpoojaConfig.appKey,
        app_secret: petpoojaConfig.appSecret,
        access_token: petpoojaConfig.accessToken,
        ...payload,
      }),
    });

    // TRANSPORT TRUTH, before any body parsing. The ack below inspects only the
    // JSON body, so an HTTP failure whose body still says success:"1" - a
    // gateway/proxy error page, a WAF interstitial, a 5xx from a half-broken
    // upstream - was accepted as a registered KOT. That is a fabricated success:
    // the order is marked synced, kotPrinted:true and the claim released, so the
    // retry worker never looks at it again. Fail closed instead and let the catch
    // below park it as pending_retry, which is the state that is retried.
    if (!response.ok) {
      throw new Error(
        `Petpooja KOT push HTTP ${response.status ?? "(no status)"}${
          response.statusText ? ` ${response.statusText}` : ""
        } - refusing to read an acceptance from a failed response`
      );
    }

    const result = await response.json();

    // Official SaveOrderResponse signals success as success:"1" (variants seen:
    // true / "success"). Accept all three — a missed ack loses the KOT.
    const ok =
      result.success === "1" || result.success === 1 || result.success === true || result.status === "success";

    // An ack WITHOUT an order id confirms network relay acceptance by the POS server.
    // Petpooja's sandbox answers {"success":"1","message":"Your order is
    // saved.","restID":"31z58ciw0h","clientOrderID":"<our id>","orderID":"",
    // "code":200} and leaves `orderID` empty. An acceptance confirms that the POS
    // cloud server accepted the payload, NOT that a physical kitchen ticket printed.
    //
    // Deduplication rules:
    //  - When the response is acknowledged with an order ID, record `petpoojaOrderId`.
    //  - When acknowledged without an order ID, record `petpoojaAcceptedNoId: true`.
    //  - NEVER invent a fake POS id or claim `kotPrinted: true` from a relay response.
    //  - Stamp `kotPushedAt` to record when the relay succeeded.
    // Both shapes prevent retry loops from firing duplicate KOTs.
    const petpoojaOrderId =
      result.petpooja_order_id || result.order_id || result.orderID || result.orderId || "";
    // F3 (polish stress sweep): from here on the POS has ACCEPTED the ticket.
    // Recorded in memory BEFORE the first write so a rejected write cannot
    // erase the fact that the POST was acknowledged.
    if (ok) {
      posAccepted = true;
      posAcceptedOrderId = String(petpoojaOrderId || "");
      try {
        posAcceptedAckBody = JSON.stringify(result).slice(0, 500);
      } catch {
        posAcceptedAckBody = null;
      }
    }
    if (ok && petpoojaOrderId) {
      await orderDoc.ref.set(
        {
          petpoojaOrderId,
          petpoojaStatus: "synced",
          petpoojaSyncStatus: "synced",
          // KOT Truth: A relay response is network acceptance by the POS server,
          // NOT physical-printer proof. Do NOT manufacture kotPrinted or kotPrintedAt.
          // kotPushedAt records the successful relay timestamp; genuine historical
          // printer evidence (if any) is preserved via merge.
          kotPushedAt: admin.firestore.FieldValue.serverTimestamp(),
          petpoojaPushClaimedAt: null,
          petpoojaClaimedAt: null,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      return true;
    }
    if (ok) {
      await orderDoc.ref.set(
        {
          petpoojaAcceptedNoId: true,
          petpoojaAcceptedNoIdAt: admin.firestore.FieldValue.serverTimestamp(),
          // Kept verbatim so an operator can see the vendor really did omit
          // the id rather than trusting our summary of it.
          petpoojaAcceptedNoIdAck: JSON.stringify(result).slice(0, 500),
          // Accepted-but-unconfirmed: the POS relay took the payload but issued
          // no id we can reconcile against. Never "synced" (that asserts the
          // KOT is traceable at the outlet) and never pending_retry (a retry
          // could print a DUPLICATE KOT). The pending-alert worker watches this
          // state so an operator verifies the ticket at the POS.
          petpoojaStatus: "accepted_unconfirmed",
          petpoojaSyncStatus: "accepted_unconfirmed",
          // KOT Truth: An ID-less relay acceptance confirms the POS server accepted
          // the payload, NOT that a physical kitchen ticket was printed.
          // Do NOT manufacture kotPrinted or kotPrintedAt.
          kotPushedAt: admin.firestore.FieldValue.serverTimestamp(),
          petpoojaPushClaimedAt: null,
          petpoojaClaimedAt: null,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      console.warn(
        `[Petpooja KOT Push] Order ${orderId} accepted by POS but the response carried no order id — marked accepted_unconfirmed, NOT queued for retry (a retry would duplicate the KOT) and alerted for operator verification`
      );
      return true;
    }
    throw new Error(result.message || "Petpooja KOT push rejected by POS server");
  } catch (err: any) {
    console.warn(`[Petpooja KOT Push Error] Order ${orderId}: ${err.message}`);

    // Guarded re-read (finding: duplicate-KOT race): if a racing caller's
    // push landed while ours failed, the order IS at the kitchen — never
    // regress it to pending_retry (the retry would ring the kitchen twice)
    // and never lose the winner's synced state. The transaction also reads
    // the FRESH retry count so two concurrent failures don't both write +1
    // off the same stale base. Releases our claim either way.
    let pushedByRacer = false;
    let parked = false;
    // R4b: a structural refusal (unverified POS ids) is NOT retryable — the
    // mapping will not fix itself. Park it for an operator instead of feeding
    // the retry worker a guaranteed failure. PAY-16: an option that is not on
    // the menu is the same class (the kitchen cannot cook an unknown add-on).
    const structural =
      err instanceof PetpoojaStructuralError
        ? err
        : ["ITEM_OPTION_UNVERIFIED", "ITEM_OPTION_REQUIRED", "ITEM_OPTION_LIMIT", "ITEM_OPTION_UNAVAILABLE"].includes(
              String(err?.code || "")
            )
          ? new PetpoojaStructuralError([
              {
                field: "OrderItem.details[].options",
                reason: String(err?.message || "order option could not be verified"),
              },
            ])
          : null;
    const parkedStatus = structural ? "blocked_configuration" : "pending_retry";
    const fallbackRetry = structural ? (order.petpoojaRetryCount || 0) : (order.petpoojaRetryCount || 0) + 1;
    let retryForSnapshot = fallbackRetry;

    // TRANSPORT-AMBIGUITY (stress sweep 2026-10-24, K1): a POST whose fetch
    // TIMED OUT / was Aborted after the request was written has an unknown
    // KOT state — the POS cloud may already have registered the ticket.
    // Parking it `pending_retry` re-POSTs the same paid order (a duplicate
    // kitchen ticket). The crash lane (petpooja.scheduler) already parks
    // this shape `reconciliation_required` with NO new POST; the in-process
    // path now agrees. HTTP 5xx stays retryable on purpose — the origin
    // provably did not process it cleanly (pinned by the retry-lifecycle
    // suite).
    const kotTransportAmbiguous =
      err?.name === "TimeoutError" || err?.name === "AbortError";

    // F3: the ack landed but we could not persist it. This write is the
    // reconciliation park; it is intentionally NOT a retry and does NOT touch
    // petpoojaRetryCount. It also records the acceptance marker (POS id, or the
    // accepted-no-id flag) so every later dedupe short-circuits before the POS
    // is ever contacted again. `petpoojaAcceptedUnrecorded` distinguishes this
    // from the transport-ambiguous case for the operator.
    const parkAcceptedUnrecorded = () => ({
      petpoojaStatus: "reconciliation_required",
      petpoojaSyncStatus: "reconciliation_required",
      kotSyncFailed: true,
      // Reuses the existing "do not blind-push" guards (orderPush pre-read +
      // claim transaction) until an operator has verified the physical ticket.
      petpoojaAmbiguousProcessing: true,
      petpoojaAcceptedUnrecorded: true,
      ...(posAcceptedOrderId
        ? { petpoojaOrderId: posAcceptedOrderId }
        : {
            petpoojaAcceptedNoId: true,
            petpoojaAcceptedNoIdAt: admin.firestore.FieldValue.serverTimestamp(),
            petpoojaAcceptedNoIdSource: "order_push_ack_unpersisted",
          }),
      ...(posAcceptedAckBody ? { petpoojaAcceptedAck: posAcceptedAckBody } : {}),
      lastPetpoojaError: `POS acknowledged the KOT but persisting the acceptance failed: ${err.message}`,
      petpoojaPushClaimedAt: null,
      petpoojaClaimedAt: null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    /** K1: the POS may already hold this KOT — never re-POST it blindly. */
    const parkTransportAmbiguous = () => ({
      petpoojaStatus: "reconciliation_required",
      petpoojaSyncStatus: "reconciliation_required",
      kotSyncFailed: true,
      petpoojaAmbiguousProcessing: true,
      lastPetpoojaError: err.message,
      petpoojaPushClaimedAt: null,
      petpoojaClaimedAt: null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    if (db && typeof (db as any).runTransaction === "function") {
      try {
        const outcome = await (db as any).runTransaction(async (tx: any) => {
          const fresh = await tx.get(orderDoc.ref);
          const data = (fresh.exists ? fresh.data() : undefined) as any;
          if (data?.petpoojaOrderId || data?.petpoojaAcceptedNoId) {
            tx.set(
              orderDoc.ref,
              {
                petpoojaClaimedAt: null,
                petpoojaPushClaimedAt: null,
              },
              { merge: true }
            );
            return "won";
          }
          // F3: never re-POST an accepted KOT. Checked before the structural
          // and transport-ambiguity branches because acceptance is PROVEN.
          if (posAccepted) {
            tx.set(orderDoc.ref, parkAcceptedUnrecorded(), { merge: true });
            return "parked_accepted_unsaved";
          }
          // K1: transport-ambiguous POST (timeout/abort after the request was
          // written) — the POS may already hold this KOT. Park for manual
          // reconciliation: NO retry, NO retry-count burn.
          if (!structural && kotTransportAmbiguous) {
            tx.set(orderDoc.ref, parkTransportAmbiguous(), { merge: true });
            return "parked_ambiguous";
          }
          const freshRetry = structural
            ? Number(data?.petpoojaRetryCount) || 0
            : (Number(data?.petpoojaRetryCount) || 0) + 1;
          retryForSnapshot = freshRetry;
          tx.set(
            orderDoc.ref,
            {
              petpoojaStatus: parkedStatus,
              petpoojaSyncStatus: parkedStatus,
              petpoojaRetryCount: freshRetry,
              lastPetpoojaError: err.message,
              ...(structural ? { kotSyncFailed: true } : {}),
              petpoojaPushClaimedAt: null,
              petpoojaClaimedAt: null,
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
          return "parked";
        });
        if (outcome === "won") pushedByRacer = true;
        // Every other outcome committed a park: leaving `parked === false` let
        // the plain fallback write below clobber a concurrent racer's
        // successful push that landed after the transaction.
        if (
          outcome === "parked" ||
          outcome === "parked_ambiguous" ||
          outcome === "parked_accepted_unsaved"
        ) {
          parked = true;
        }
      } catch (txErr: any) {
        // Transactional write failed — fall back to the legacy write below.
        console.warn(
          `[Petpooja KOT Push] guarded failure write failed for order ${orderId}:`,
          txErr?.message || txErr
        );
      }
    }
    if (pushedByRacer) {
      console.warn(
        `[Petpooja KOT Push] Order ${orderId} was pushed by a concurrent caller — keeping synced state, no pending_retry`
      );
      return true;
    }

    if (!parked) {
      await orderDoc.ref.set(
        posAccepted
          ? // F3: same rule as the transactional path — an acknowledged POST is
            // never a retry candidate, even when the transaction itself failed.
            parkAcceptedUnrecorded()
          : !structural && kotTransportAmbiguous
            ? parkTransportAmbiguous()
            : {
                petpoojaStatus: parkedStatus,
                petpoojaSyncStatus: parkedStatus,
                petpoojaRetryCount: fallbackRetry,
                lastPetpoojaError: err.message,
                ...(structural ? { kotSyncFailed: true } : {}),
                petpoojaPushClaimedAt: null,
                petpoojaClaimedAt: null,
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              },
        { merge: true }
      );
    }

    await captureErrorSnapshot({
      source: "petpooja",
      // A structural refusal is an operator action, not a transient failure; a
      // KOT the POS accepted but we could not record is a lost-ticket hazard
      // (the kitchen may be cooking an order no system tracks) — page, do not
      // bury it at medium.
      severity: posAccepted || structural ? "high" : "medium",
      message: posAccepted
        ? `Petpooja POS ACKNOWLEDGED the KOT for order ${orderId} but the acceptance could not be persisted — parked reconciliation_required with NO retry (an automatic re-POST would duplicate the ticket): ${err.message}`
        : structural
          ? `Petpooja KOT blocked for order ${orderId} — unverified POS ids: ${err.message}`
          : `Petpooja KOT Push failed for order ${orderId} (Attempt ${retryForSnapshot}): ${err.message}`,
      orderId,
      branchId,
    });

    return false;
  }
}
