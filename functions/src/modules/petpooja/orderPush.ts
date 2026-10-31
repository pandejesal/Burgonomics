import { db } from "../../core/firebase";
import { config, assertLivePetpoojaContext } from "../../config/env";
import { captureErrorSnapshot } from "../../core/errors";
import { getPetpoojaConfig } from "./client";
import { calculateOrderPricing } from "../payments/pricing.engine";
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
 * Per-line / per-order tax rows for the KOT.
 *
 * Petpooja needs tax ids that exist on the OUTLET. The old payload sent
 * `id: "cgst"` / `"sgst"` — labels that name no tax row — and omitted
 * `item_tax` from the lines entirely, so every line arrived untaxed while the
 * order still declared a tax total.
 *
 * A branch may declare its own rows as `petpoojaTaxes: [{id, name, rate}]`
 * (what the menu sync should write once it captures the outlet's `taxes[]`).
 * Until a branch does, the rows published by the outlet currently linked are
 * used — CGST `3928` and SGST `3929`, both 2.5%.
 */
const DEFAULT_OUTLET_TAXES = [
  { id: "3928", name: "CGST", rate: 2.5 },
  { id: "3929", name: "SGST", rate: 2.5 },
];

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
  return DEFAULT_OUTLET_TAXES.map((t) => ({ ...t }));
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
  branchId: string
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

  const rawType = String(order?.fulfillmentType || order?.orderType || "delivery").toLowerCase();
  const orderType =
    rawType === "takeaway" || rawType === "pickup"
      ? "takeaway"
      : rawType === "dinein" || rawType === "dine_in"
        ? "dinein"
        : "delivery";

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
    deliveryFee: order?.deliveryFee,
    packagingFee: order?.packagingFee,
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
  orderDocId?: string
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
  const preItems = order.items || [];
  const preGst = Number(order?.pricing?.gst) || 0;
  const preItemTotal = preItems.reduce(
    (sum: number, it: any) => sum + lineUnitPrice(it) * (it.quantity || 1),
    0
  );
  const branchTaxes = outletTaxes(branch);

  const orderItems = (order.items || []).map((item: any) => {
    const unit = lineUnitPrice(item);
    const qty = Number(item.quantity) || 1;
    const lineTotal = unit * qty;
    // `CartLine.unitPrice` is ALL-IN: the cart stores base + modifier deltas in
    // it, and PaymentRepository persists that same figure as `price`. Petpooja
    // defines `price` as the per-unit value including add-ons, so the add-on
    // rows below are descriptive only and must not be added a second time.
    const addons = (item.modifiers || item.selectedAddons || []).map((mod: any) => ({
      id: mod.id || mod.optionId || "addon",
      name: mod.name,
      group_name: mod.groupName || "Addons",
      // CartModifier carries `priceDelta`; `price` is the legacy spelling.
      price: money(mod.price ?? mod.priceDelta ?? 0),
      // The vendor sample types group_id as an integer, not a string.
      group_id: Number(mod.groupId ?? mod.group_id) || 0,
      quantity: "1",
    }));

    return {
      id: linePetpoojaItemId(item, firestoreBranchId),
      name: item.name,
      // Our checkout prices are TAX-EXCLUSIVE: pricing.engine adds 5% GST on
      // top of the net food subtotal, and the outlet menu declares
      // tax_inclusive:false. Declaring true told the POS the price already
      // contained the tax and let it back the GST out a second time.
      tax_inclusive: false,
      gst_liability: "restaurant",
      item_tax: branchTaxes.map((t) => ({
        id: t.id,
        name: t.name,
        tax_percentage: String(t.rate),
        amount: money(
          preItemTotal > 0 && branchTaxes.length > 0
            ? (preGst * (lineTotal / preItemTotal)) / branchTaxes.length
            : 0
        ),
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
      variation_name: item.petpoojaVariationName || item.variationName || "",
      variation_id: item.petpoojaVariationId || item.variationId || "",
      AddonItem: { details: addons },
    };
  });

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
  const deliveryFee = Number(pricing.deliveryFee) || 0;
  const packagingFee = Number(pricing.packagingFee) || 0;
  const discountAmount = Number(pricing.discount) || 0;
  const grandTotal = Number(pricing.grandTotal);

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
  const collectCash = paymentType === "COD" ? grandTotal : 0;
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
      { gst_liable: "vendor", amount: money(0) },
      { gst_liable: "restaurant", amount: money(0) },
    ],
    packing_charges: money(packagingFee),
    pc_tax_amount: money(0),
    pc_tax_percentage: "0",
    pc_gst_details: [
      { gst_liable: "vendor", amount: money(0) },
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
    tax_total: money(gstAmount),
    // Discounts are sent as discount_type + discount_total (spec §8).
    discount_type: "F",
    total: money(grandTotal),
    description: order.notes || order.specialInstructions || "",
    created_on: createdOn,
    // Riders are always third-party (Porter/Borzo/Shadowfax), never ours.
    enable_delivery: 0,
    min_prep_time: Number.isFinite(prepTimeMinutes) && prepTimeMinutes > 0 ? prepTimeMinutes : 0,
    // The POS reads the URL it POSTs order-status updates (Accept / Food Ready
    // / Reject) from Order.details.
    callback_url: getCallbackUrl(),
    // COD: the rider collects the full order value. ONLINE: nothing to collect.
    collect_cash: money(collectCash),
    // Deliberately empty: the delivery OTP is the customer/rider verification
    // secret and must not be printed on a kitchen ticket.
    otp: "",
  };

  // Official Tax[] shape: id / title / type / price / tax / restaurant_liable_amt.
  // The ids must name rows that exist on the outlet. `price` is the numeric
  // percentage, matching the vendor sample (not "2.5%").
  const taxDetails = branchTaxes.map((t) => ({
    id: t.id,
    title: t.name,
    type: "P",
    price: String(t.rate),
    tax: money(branchTaxes.length > 0 ? gstAmount / branchTaxes.length : 0),
    restaurant_liable_amt: money(
      branchTaxes.length > 0 ? gstAmount / branchTaxes.length : 0
    ),
  }));

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
        tx.set(orderDoc.ref, { petpoojaPushClaimedAt: Date.now() }, { merge: true });
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
    const pricedOrder = await ensureAuthoritativeOrderPricing(order, orderId, branchId);
    const payload = formatPetpoojaOrderPayload(pricedOrder, branchData, resId, branchId, orderId);

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
          petpoojaStatus: "synced",
          petpoojaSyncStatus: "synced",
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
        `[Petpooja KOT Push] Order ${orderId} accepted by POS but the response carried no order id — marked synced (accepted-no-id), NOT queued for retry (a retry would duplicate the KOT)`
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
    const fallbackRetry = (order.petpoojaRetryCount || 0) + 1;
    let retryForSnapshot = fallbackRetry;
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
          const freshRetry = (Number(data?.petpoojaRetryCount) || 0) + 1;
          retryForSnapshot = freshRetry;
          tx.set(
            orderDoc.ref,
            {
              petpoojaStatus: "pending_retry",
              petpoojaSyncStatus: "pending_retry",
              petpoojaRetryCount: freshRetry,
              lastPetpoojaError: err.message,
              petpoojaPushClaimedAt: null,
              petpoojaClaimedAt: null,
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
          return "parked";
        });
        if (outcome === "won") pushedByRacer = true;
        if (outcome === "parked") parked = true;
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
        {
          petpoojaStatus: "pending_retry",
          petpoojaSyncStatus: "pending_retry",
          petpoojaRetryCount: fallbackRetry,
          lastPetpoojaError: err.message,
          petpoojaPushClaimedAt: null,
          petpoojaClaimedAt: null,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    }

    await captureErrorSnapshot({
      source: "petpooja",
      severity: "medium",
      message: `Petpooja KOT Push failed for order ${orderId} (Attempt ${retryForSnapshot}): ${err.message}`,
      orderId,
      branchId,
    });

    return false;
  }
}
