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
  // BOTH levels are REQUIRED. Without them the endpoint still answers
  // `success:"1"` but parses nothing: it echoes empty restID/clientOrderID and
  // registers no order. That behaviour was previously misread as "the sandbox
  // endpoint is a stub" — it was this envelope. The live probe in §12 of
  // references/petpooja_save_order_api.md shows the difference directly: empty
  // ids without these levels, our real restID/clientOrderID echoed with them.
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

  // Idempotency: petpoojaOrderId is written ONLY on a successful push, so
  // its presence IS the already-pushed marker — independent of the status
  // field, which later bookkeeping may have moved off "synced". Replays (a
  // second Razorpay event, a double-tapped KDS button, the retry worker
  // racing a completed push) must never fire a duplicate KOT at the kitchen.
  if (order.petpoojaOrderId) {
    console.warn(
      `[Petpooja KOT Push] Order ${orderId} already pushed (${order.petpoojaOrderId}) — deduped, no duplicate KOT`
    );
    return true;
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
    let claim: "claimed" | "dup" | "busy" | "gone";
    try {
      claim = await (db as any).runTransaction(async (tx: any) => {
        const fresh = await tx.get(orderDoc.ref);
        const data = (fresh.exists ? fresh.data() : undefined) as any;
        if (!data) return "gone";
        // A racing caller finished the push while we were reading — reuse
        // its outcome, never POST a second KOT.
        if (data.petpoojaOrderId) return "dup";
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
      console.warn(
        `[Petpooja KOT Push] Order ${orderId} push already in flight — yielding to the owner`
      );
      return true;
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
        kotPrinted: true,
        kotPrintedAt: admin.firestore.FieldValue.serverTimestamp(),
        kotPushedAt: admin.firestore.FieldValue.serverTimestamp(),
        petpoojaPushClaimedAt: null,
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

    const result = await response.json();

    // Official SaveOrderResponse signals success as success:"1" (variants seen:
    // true / "success"). Accept all three — a missed ack loses the KOT.
    const ok =
      result.success === "1" || result.success === 1 || result.success === true || result.status === "success";

    // An ack WITHOUT an order id is NOT a successful relay. Petpooja's live
    // sandbox answers {"success":"1","message":"Your order is saved.",
    // "restID":"","clientOrderID":"","orderID":"","code":200} for every
    // request. Treating that as success fabricated a `pp_<epoch>` id and
    // stamped kotPrinted:true, so the kitchen believed a KOT had printed that
    // Petpooja never registered. Worse, the fabricated id is a truthy
    // `petpoojaOrderId`, so the dedupe at the top of this function skipped
    // every later retry — the order could never be recovered. Echo only the
    // POS's own id, under any spelling it uses; never invent one.
    const petpoojaOrderId =
      result.petpooja_order_id || result.order_id || result.orderID || result.orderId || "";
    if (ok && petpoojaOrderId) {
      await orderDoc.ref.set(
        {
          petpoojaOrderId,
          petpoojaStatus: "synced",
          petpoojaSyncStatus: "synced",
          kotPrinted: true,
          kotPrintedAt: admin.firestore.FieldValue.serverTimestamp(),
          kotPushedAt: admin.firestore.FieldValue.serverTimestamp(),
          petpoojaPushClaimedAt: null,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      return true;
    }
    if (ok) {
      // Park for the retry worker via the catch below rather than lying.
      throw new Error(
        `Petpooja acked order ${orderId} (success:"1") but returned no order id — refusing to mark the KOT printed. Raw response: ${JSON.stringify(
          result
        ).slice(0, 300)}`
      );
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
          if (data?.petpoojaOrderId) return "won";
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
