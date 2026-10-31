import { db } from "../../core/firebase";
import { config, assertLivePetpoojaContext } from "../../config/env";
import { captureErrorSnapshot } from "../../core/errors";
import { getPetpoojaConfig } from "./client";
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

export function formatPetpoojaOrderPayload(
  order: any,
  branch: any,
  resId: string,
  firestoreBranchId?: string
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
  const preGst = (order.pricing || {}).gst || order.taxAmount || order.tax || 0;
  const preItemTotal = preItems.reduce(
    (sum: number, it: any) => sum + lineUnitPrice(it) * (it.quantity || 1),
    0
  );
  const branchTaxes = outletTaxes(branch);
  const branchTaxPct = branchTaxes.reduce((sum, t) => sum + t.rate, 0);

  const orderItems = (order.items || []).map((item: any) => {
    const unit = lineUnitPrice(item);
    const qty = item.quantity || 1;
    const addons = (item.modifiers || item.selectedAddons || []).map((mod: any) => ({
      // official AddonItem names: id / name / group_name / price
      id: mod.id || mod.optionId || "addon",
      name: mod.name,
      group_name: mod.groupName || "Addons",
      // CartModifier carries `priceDelta`; `price` is the legacy spelling.
      price: money(mod.price ?? mod.priceDelta ?? 0),
      // legacy spelling the POS parser may still read
      addon_id: mod.id || mod.optionId || "addon",
      addon_name: mod.name,
    }));
    const lineTotal = unit * qty;

    return {
      // ---- official V2.1.0 OrderItem names ----
      id: linePetpoojaItemId(item, firestoreBranchId),
      name: item.name,
      price: money(unit),
      // DELIBERATE DEVIATION from the guide's field description - do not
      // "correct" it without vendor confirmation. The vendor "API Guide for
      // Placing Orders on Petpooja POS" describes `final_price` (p.6) as
      // "Item Price - Item level discount if any", i.e. a UNIT figure, and its
      // OrderItem example pairs price "250.00" with final_price "250" at
      // quantity "2". We emit the LINE total (unit x qty) instead, because the
      // SAME guide's `total` formula (p.4) is "Item Final Price [- Order level
      // Discount If Any] + GST + packing charges": summing our line totals
      // reproduces the order total we send, while unit figures would require
      // the POS to re-multiply by quantity before that formula balances. The
      // vendor's own Order List totals matched ours for the acceptance cases
      // it listed. The two readings coincide at quantity 1, so a wrong choice
      // stays invisible until a multi-quantity line - which is exactly why
      // this is pinned by tests instead of being changed on a hunch.
      final_price: money(lineTotal),
      quantity: String(qty),
      gst_liability: "restaurant",
      // Our own order prices are GST-INCLUSIVE: `CartTotals.subtotal` documents
      // the 5% GST as already inside the line price, and `pricing.gst`/`taxes`
      // is that embedded portion, not an addition. So the payload must declare
      // `true` — the POS then treats `tax`/`tax_total` as the tax contained in
      // the total we sent. (The sandbox runner is the opposite: it computes GST
      // on top of its item prices, so it declares `false`.)
      tax_inclusive: true,
      // Petpooja expects the line's own tax. It was omitted entirely, so every
      // line reached the POS untaxed even though the order carried a tax total.
      tax_percentage: String(branchTaxPct),
      item_discount: money(0),
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
      variation_id: item.petpoojaVariationId || item.variationId || "",
      variation_name: item.petpoojaVariationName || item.variationName || "",
      // The documented OrderItem carries its add-ons as `AddonItem.details`.
      AddonItem: { details: addons },
      // ---- legacy spellings ----
      // The flat contract in the official PDF names this key `addon_items`.
      // It was never emitted, so a POS implementing the documented contract
      // saw every line item as addon-free. Sent alongside the other spellings
      // because the multi-contract relay exists precisely to satisfy
      // whichever contract the target implements.
      addon_items: addons,
      item_id: linePetpoojaItemId(item, firestoreBranchId),
      item_name: item.name,
      addons: addons.map((a: { id: string; name: string; price: string }) => ({
        addon_id: a.id,
        addon_name: a.name,
        price: a.price,
      })),
      // `CartLine` names the flag `veg`; `isVeg` is the legacy spelling. Reading
      // only `isVeg` meant every line was reported as veg.
      item_attribute: (item.isVeg ?? item.veg) !== false ? "1" : "2",
    };
  });

  const pricing = order.pricing || {};
  const gstAmount = pricing.gst || order.taxAmount || order.tax || 0;
  const deliveryFee = pricing.deliveryFee || order.deliveryFee || 0;
  const packagingFee = pricing.packagingFee || order.packagingFee || 0;
  const discountAmount = pricing.discount || order.discountAmount || 0;
  const grandTotal = pricing.grandTotal || order.totalAmount || order.total || 0;

  // Normalized (never invented) contact + the clock fields Save Order marks
  // required. Table number rides along whenever the order carries one —
  // dine-in KOTs are useless to the floor without it.
  const customerPhone = normalizeCustomerPhone(
    order.customerPhone || order.customer?.phone
  );
  const { preorderDate, preorderTime, createdOn } = petpoojaClock();
  const tableNo = order.tableNumber ? String(order.tableNumber).trim() : "";

  // ---------------------------------------------------------------------------
  // The published Orders API — the OpenAPI `OrderInfo` component and that
  // spec's Postman example body — carries every member under
  // `orderinfo.OrderInfo`, and wraps each member in a `details` object, with
  // OrderItem / Tax / Discount holding a `details` ARRAY:
  //
  //   orderinfo.OrderInfo.{Restaurant,Customer,Order,OrderItem,Tax,Discount}
  //
  // BOTH levels are REQUIRED for the payload to be PARSED. Without them the
  // endpoint still answers `success:"1"` but parses nothing: it echoes empty
  // restID/clientOrderID. That was previously misread as "the sandbox endpoint
  // is a stub" — it was this envelope. The live probe in §12 of
  // references/petpooja_save_order_api.md shows the difference directly: empty
  // ids without these levels, our real restID/clientOrderID echoed with them.
  //
  // Note the LIMIT of that evidence: an empty echo proves the payload was not
  // parsed, NOT that no order was registered. The endpoint returns an empty
  // `orderID` even for a fully parsed POST whose order does register (proven
  // against the outlet's Order List, §16.8), so never treat an empty id as
  // proof that nothing landed at the POS.
  // ---------------------------------------------------------------------------
  const restaurantDetails = {
    // The authoritative restaurant identifier in this contract. Fail-closed:
    // this is the verified branch.petpoojaStoreId, never a guess.
    restID: resId,
    resID: resId,
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

  const customerDetails = {
    name: order.customerName || order.customer?.name || "Customer",
    phone: customerPhone,
    address: customerAddress,
    email: order.customerEmail || order.customer?.email || "",
    latitude: "",
    longitude: "",
  };

  const orderDetails = {
    orderID: order.orderNumber || order.id,
    clientOrderID: order.id,
    // Documented letter code (H/P/D); the numeric form stays as a legacy alias
    // for POS parsers that still read it.
    order_type: orderTypeCode,
    order_type_legacy: orderTypeLegacy,
    // Petpooja accepts COD / CARD / ONLINE only.
    payment_type: paymentType,
    total: money(grandTotal),
    tax: money(gstAmount),
    tax_total: money(gstAmount),
    discount: money(discountAmount),
    // Discounts are sent as discount_type + discount_total (spec §8).
    discount_type: "F",
    discount_total: money(discountAmount),
    delivery_charges: money(deliveryFee),
    packing_charges: money(packagingFee),
    service_charge: money(0),
    // advanced_order "N" = immediate order (we never schedule), so preorder_*
    // describe "now", never a fake slot.
    advanced_order: "N",
    preorder_date: preorderDate,
    preorder_time: preorderTime,
    created_on: createdOn,
    // Delivery/packing charges carry no separate tax in our pricing engine.
    dc_tax_percentage: "0",
    pc_tax_percentage: "0",
    min_prep_time: "0",
    // Riders are always third-party (Porter/Borzo/Shadowfax), never ours.
    enable_delivery: "0",
    // The spec documents the callback on Order.details, and that is where the
    // POS reads the URL it POSTs order-status updates (Accept / Food Ready /
    // Reject) to. Emitting it only at the top level — as this builder used to —
    // is consistent with no status callback ever reaching our webhook.
    callback_url: getCallbackUrl(),
    ...(tableNo ? { table_no: tableNo } : {}),
    // ---- legacy aliases (absent from the documented contract; ignorable) ----
    // resID must be the verified branch.petpoojaStoreId — no fallback chain,
    // because a wrong resID sends the KOT to the wrong kitchen.
    resID: resId,
    restID: resId,
    customer_name: order.customerName || order.customer?.name || "Customer",
    // Never invent a phone number: an empty string fails visibly at Petpooja
    // instead of dispatching a rider to a fake contact. Counter orders must
    // capture a real number (Partner modal enforces this for delivery).
    customer_phone: customerPhone,
    customer_address: customerAddress,
  };

  // Official Tax[] shape: id / title / type / price / tax / restaurant_liable_amt.
  // The ids must name rows that exist on the outlet; the previous payload sent
  // the labels "cgst"/"sgst", which match no tax row, and omitted
  // `restaurant_liable_amt`.
  const taxDetails = branchTaxes.map((t) => ({
    id: t.id,
    title: t.name,
    type: "P",
    price: `${t.rate}%`,
    tax: money(branchTaxes.length > 0 ? gstAmount / branchTaxes.length : 0),
    restaurant_liable_amt: money(
      branchTaxes.length > 0 ? gstAmount / branchTaxes.length : 0
    ),
  }));

  return {
    // callback_url tells Petpooja where to POST KOT status updates
    // (accept/reject/ready/delivered). Without it our webhook is unreachable.
    callback_url: getCallbackUrl(),
    // The API guide's flat contract marks customer `name`/`address` and
    // `restID` as required TOP-LEVEL fields; the published API carries them
    // under orderinfo.OrderInfo instead. Unknown keys are ignored, so both are
    // safe and either contract is satisfied.
    name: order.customerName || order.customer?.name || "Customer",
    phone: customerPhone,
    email: order.customerEmail || order.customer?.email || "",
    latitude: "",
    longitude: "",
    res_name: branch?.name || "Burgonomics",
    address: branch?.address || "",
    contact_information: branch?.phone || "",
    restID: resId,
    orderinfo: {
      OrderInfo: {
        Restaurant: { details: restaurantDetails },
        Customer: { details: customerDetails },
        Order: { details: orderDetails },
        OrderItem: { details: orderItems },
        Tax: { details: taxDetails },
        // The contract defines no `Discount` object — discounts are the
        // `discount_type` + `discount_total` scalars on Order (spec §8) — but
        // the documented example body includes the member, so it is declared
        // empty rather than omitted.
        Discount: { details: [] },
      },
      // ---- legacy aliases ----
      // The members directly under `orderinfo` (the shape this builder used
      // before the missing OrderInfo level was found) plus the flat-PDF
      // spellings the POS parser may still read.
      Customer: customerDetails,
      Order: orderDetails,
      OrderItem: orderItems,
      Tax: taxDetails,
      tax_details: [
        {
          tax_name: "CGST",
          tax_percent: 2.5,
          tax_amount: parseFloat((gstAmount / 2).toFixed(2)),
        },
        {
          tax_name: "SGST",
          tax_percent: 2.5,
          tax_amount: parseFloat((gstAmount / 2).toFixed(2)),
        },
      ],
      order_items: orderItems,
      items: orderItems,
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
        // F5 (silent-drop integrity): the lease is not enough on its own. A hard
        // kill between this write and the success write used to leave a doc with
        // ONLY `petpoojaPushClaimedAt` set — and neither lane in the retry worker
        // looks at that field: the crash lane scans `petpoojaStatus ==
        // "processing"` and the retry lane scans `pending_retry`. The order then
        // belonged to no lane at all (no KOT, no retry, no alert). Marking
        // `processing` in the SAME claim write (exactly what the scheduler's own
        // claim does) makes the crash lane find it and park it
        // `reconciliation_required` with an alert once the lease expires.
        tx.set(
          orderDoc.ref,
          { petpoojaStatus: "processing", petpoojaPushClaimedAt: Date.now() },
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

  // ---------------------------------------------------------------------------
  // F3 (duplicate-KOT integrity): a POS ACK and the Firestore write recording it
  // are two different failure domains. The previous shape kept both inside ONE
  // try, so a write failure AFTER the POS had already accepted the ticket fell
  // into the generic catch, which parked `pending_retry` — and the retry worker
  // then re-POSTed an order the kitchen already had. These flags capture the
  // point of no return: once `posAccepted` is true the order may exist at the
  // POS even though we failed to persist the id, so the ONLY safe state is
  // `reconciliation_required` (no retry, no retry-count burn, no re-POST).
  // ---------------------------------------------------------------------------
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

    const payload = formatPetpoojaOrderPayload(order, branchData, resId, branchId);

    // Debug visibility: missing contact or zero totals push a broken KOT that
    // looks successful. Flag loudly instead of masking with fallbacks.
    if (!payload.orderinfo.Order.customer_phone) {
      await captureErrorSnapshot({
        source: "petpooja",
        severity: "medium",
        message: `KOT push for order ${orderId} has no customer phone — rider contact will fail`,
        orderId,
        branchId,
      });
    }
    if (!(Number(payload.orderinfo.Order.total) > 0)) {
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

    // Point of no return (F3): from here on the POS has ACCEPTED the ticket. Any
    // later failure (including the Firestore writes below) must never fall
    // through to `pending_retry`. Recorded in memory BEFORE the first write so a
    // rejected write cannot erase the fact that the POST was acknowledged.
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
    // accepted-no-id flag) so every later dedupe short-circuits before the POS is
    // ever contacted again. `petpoojaAcceptedUnrecorded` distinguishes this from
    // the transport-ambiguous case for the operator.
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
          // F3: never re-POST an accepted KOT. Checked before the
          // transport-ambiguity branch because acceptance is PROVEN here.
          if (posAccepted) {
            tx.set(orderDoc.ref, parkAcceptedUnrecorded(), { merge: true });
            return "parked_accepted_unsaved";
          }
          // K1 stress sweep: transport-ambiguous POST (timeout/abort after
          // request written) — the POS may already hold this KOT. Park for
          // manual reconciliation, NO retry, NO retry-count burn.
          if (kotTransportAmbiguous) {
            tx.set(
              orderDoc.ref,
              {
                petpoojaStatus: "reconciliation_required",
                petpoojaSyncStatus: "reconciliation_required",
                kotSyncFailed: true,
                petpoojaAmbiguousProcessing: true,
                lastPetpoojaError: err.message,
                petpoojaPushClaimedAt: null,
                petpoojaClaimedAt: null,
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              },
              { merge: true }
            );
            return "parked_ambiguous";
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
        // K1 reviewer fix: parked_ambiguous ALSO parked the doc (the
        // transaction already committed reconciliation_required). Leaving
        // `parked === false` let the plain fallback write below clobber a
        // concurrent racer's successful push that landed after the tx.
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
            // never a retry candidate, even when the tx itself failed.
            parkAcceptedUnrecorded()
          : kotTransportAmbiguous
            ? {
                petpoojaStatus: "reconciliation_required",
                petpoojaSyncStatus: "reconciliation_required",
                kotSyncFailed: true,
                petpoojaAmbiguousProcessing: true,
                lastPetpoojaError: err.message,
                petpoojaPushClaimedAt: null,
                petpoojaClaimedAt: null,
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              }
            : {
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
      // A KOT the POS accepted but we could not record is a lost-ticket hazard
      // (the kitchen may be cooking an order no system tracks) — page, do not
      // bury it at medium.
      severity: posAccepted ? "high" : "medium",
      message: posAccepted
        ? `Petpooja POS ACKNOWLEDGED the KOT for order ${orderId} but the acceptance could not be persisted — parked reconciliation_required with NO retry (an automatic re-POST would duplicate the ticket): ${err.message}`
        : `Petpooja KOT Push failed for order ${orderId} (Attempt ${retryForSnapshot}): ${err.message}`,
      orderId,
      branchId,
    });

    return false;
  }
}
