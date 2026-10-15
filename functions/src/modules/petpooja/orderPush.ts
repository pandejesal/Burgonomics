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

export function formatPetpoojaOrderPayload(order: any, branch: any, resId: string) {
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

  const orderItems = (order.items || []).map((item: any) => {
    const unit = item.basePrice || item.price || 0;
    const qty = item.quantity || 1;
    const addons = (item.modifiers || item.selectedAddons || []).map((mod: any) => ({
      // official AddonItem names: id / name / group_name / price
      id: mod.id || mod.optionId || "addon",
      name: mod.name,
      group_name: mod.groupName || "Addons",
      price: money(mod.price || 0),
      // legacy spelling the POS parser may still read
      addon_id: mod.id || mod.optionId || "addon",
      addon_name: mod.name,
    }));
    const lineTotal = unit * qty;

    return {
      // ---- official V2.1.0 OrderItem names ----
      id: item.petpoojaItemId || item.itemId || item.id,
      name: item.name,
      price: money(unit),
      final_price: money(lineTotal),
      quantity: String(qty),
      gst_liability: "restaurant",
      tax_inclusive: true,
      variation_id: item.petpoojaVariationId || item.variationId || "",
      variation_name: item.petpoojaVariationName || item.variationName || "",
      AddonItem: addons,
      // ---- legacy spellings ----
      // The flat contract in the official PDF names this key `addon_items`.
      // It was never emitted, so a POS implementing the documented contract
      // saw every line item as addon-free. Sent alongside the other spellings
      // because the multi-contract relay exists precisely to satisfy
      // whichever contract the target implements.
      addon_items: addons,
      item_id: item.petpoojaItemId || item.itemId || item.id,
      item_name: item.name,
      addons: addons.map((a: { id: string; name: string; price: string }) => ({
        addon_id: a.id,
        addon_name: a.name,
        price: a.price,
      })),
      item_attribute: item.isVeg !== false ? "1" : "2",
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

  return {
    // callback_url tells Petpooja where to POST KOT status updates
    // (accept/reject/ready/delivered). Without it our webhook is unreachable.
    callback_url: getCallbackUrl(),
    // The API guide's flat contract marks customer `name` and `address` as
    // REQUIRED top-level fields; they are mirrored inside orderinfo.Customer.
    // Unknown keys are ignored by the live API, so both spellings are safe.
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
      // Official V2.1.0 shape: Customer / Order / OrderItem / Tax / Discount.
      Customer: {
        name: order.customerName || order.customer?.name || "Customer",
        phone: customerPhone,
        address:
          orderTypeLegacy === "1"
            ? order.deliveryAddress?.full ||
              order.deliveryAddress?.line1 ||
              order.address?.street ||
              order.customerAddress ||
              ""
            : "",
        email: order.customerEmail || order.customer?.email || "",
      },
      Order: {
        orderID: order.orderNumber || order.id,
        clientOrderID: order.id,
        // Fail-closed: resID must be the verified branch.petpoojaStoreId.
        // No fallback chain — wrong resID sends KOT to wrong kitchen.
        resID: resId,
        // Published V2.1.0 spec names this key `restID` (menu sharing code);
        // we send BOTH spellings with the SAME verified value — the POS reads
        // whichever it implements, and neither can point at another outlet.
        restID: resId,
        // Documented letter code (H/P/D) — the numeric form stays as a legacy
        // alias for POS parsers that still read it.
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
        // Required-by-spec clock fields. advanced_order "N" = immediate order
        // (we never schedule), so preorder_* describe "now", never a fake slot.
        advanced_order: "N",
        preorder_date: preorderDate,
        preorder_time: preorderTime,
        created_on: createdOn,
        // Delivery/packing charges carry no separate tax in our pricing engine.
        dc_tax_percentage: "0",
        pc_tax_percentage: "0",
        // Riders are always third-party (Porter/Borzo/Shadowfax), never ours.
        enable_delivery: "0",
        ...(tableNo ? { table_no: tableNo } : {}),
        // legacy flat customer keys
        customer_name: order.customerName || order.customer?.name || "Customer",
        // Never invent a phone number: an empty string fails visibly at Petpooja
        // instead of dispatching a rider to a fake contact. Counter orders must
        // capture a real number (Partner modal enforces this for delivery).
        customer_phone: customerPhone,
        // Delivery app saves the address at `deliveryAddress` (full/line1
        // parts), counter/legacy orders at `address.street` — read both so the
        // rider never gets a KOT with an empty address. Never invent one.
        customer_address:
          orderTypeLegacy === "1"
            ? order.deliveryAddress?.full ||
              order.deliveryAddress?.line1 ||
              order.address?.street ||
              order.customerAddress ||
              ""
            : "",
      },
      OrderItem: orderItems,
      // Official Tax[] shape: id / title / type / price / tax.
      Tax: [
        { id: "cgst", title: "CGST", type: "P", price: "2.5%", tax: money(gstAmount / 2) },
        { id: "sgst", title: "SGST", type: "P", price: "2.5%", tax: money(gstAmount / 2) },
      ],
      Discount: { id: "", title: "Discount", type: "F", price: money(discountAmount) },
      // legacy tax_details the POS parser may still read
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

    const payload = formatPetpoojaOrderPayload(order, branchData, resId);

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
