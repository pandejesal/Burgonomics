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

/** `yyyy-mm-dd HH:mm:ss` (local) + date/time parts required by Save Order. */
function petpoojaClock(now: Date = new Date()) {
  const pad = (n: number) => String(n).padStart(2, "0");
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  return { preorderDate: date, preorderTime: time, createdOn: `${date} ${time}` };
}

export function formatPetpoojaOrderPayload(order: any, branch: any, resId: string) {
  const fulfillment = (order.fulfillmentType || order.orderType || "DELIVERY").toUpperCase();
  const orderType =
    fulfillment === "DELIVERY"
      ? "1"
      : fulfillment === "TAKEAWAY" || fulfillment === "PICKUP"
      ? "2"
      : "3";

  const paymentMethod = (order.paymentMethod || "").toUpperCase();
  const paymentType = paymentMethod === "COD" || paymentMethod === "CASH" ? "COD" : "Prepaid";

  const orderItems = (order.items || []).map((item: any) => ({
    item_id: item.petpoojaItemId || item.itemId || item.id,
    item_name: item.name,
    price: item.basePrice || item.price || 0,
    quantity: item.quantity || 1,
    final_price: (item.price || item.basePrice || 0) * (item.quantity || 1),
    addons: (item.modifiers || item.selectedAddons || []).map((mod: any) => ({
      addon_id: mod.id || mod.optionId || "addon",
      addon_name: mod.name,
      price: mod.price || 0,
    })),
    item_attribute: item.isVeg !== false ? "1" : "2",
  }));

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
    orderinfo: {
      orderID: order.orderNumber || order.id,
      clientOrderID: order.id,
      // Fail-closed: resID must be the verified branch.petpoojaStoreId.
      // No fallback chain — wrong resID sends KOT to wrong kitchen.
      resID: resId,
      // Published V2.1.0 spec names this key `restID` (menu sharing code);
      // we send BOTH spellings with the SAME verified value — the POS reads
      // whichever it implements, and neither can point at another outlet.
      restID: resId,
      order_type: orderType,
      payment_type: paymentType,
      total: grandTotal,
      tax: gstAmount,
      tax_total: gstAmount,
      discount: discountAmount,
      // Discounts are sent as discount_type + discount_total (spec §8) —
      // `discount` stays for backwards compatibility with the POS parser.
      discount_type: "F",
      discount_total: discountAmount,
      delivery_charges: deliveryFee,
      packing_charges: packagingFee,
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
      customer_name: order.customerName || order.customer?.name || "Customer",
      // Never invent a phone number: an empty string fails visibly at Petpooja
      // instead of dispatching a rider to a fake contact. Counter orders must
      // capture a real number (Partner modal enforces this for delivery).
      customer_phone: customerPhone,
      // Delivery app saves the address at `deliveryAddress` (full/line1
      // parts), counter/legacy orders at `address.street` — read both so the
      // rider never gets a KOT with an empty address. Never invent one.
      customer_address:
        orderType === "1"
          ? order.deliveryAddress?.full ||
            order.deliveryAddress?.line1 ||
            order.address?.street ||
            order.customerAddress ||
            ""
          : "",
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
  // "synced + petpoojaOrderId" IS the already-pushed marker. Replays (a
  // second Razorpay event, a double-tapped KDS button, the retry worker
  // racing a completed push) must never fire a duplicate KOT at the kitchen.
  if (order.petpoojaStatus === "synced" && order.petpoojaOrderId) {
    console.warn(
      `[Petpooja KOT Push] Order ${orderId} already pushed (${order.petpoojaOrderId}) — deduped, no duplicate KOT`
    );
    return true;
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
    if (!payload.orderinfo.customer_phone) {
      await captureErrorSnapshot({
        source: "petpooja",
        severity: "medium",
        message: `KOT push for order ${orderId} has no customer phone — rider contact will fail`,
        orderId,
        branchId,
      });
    }
    if (!(payload.orderinfo.total > 0)) {
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
    if (ok) {
      await orderDoc.ref.set(
        {
          petpoojaOrderId: result.petpooja_order_id || result.order_id || `pp_${Date.now()}`,
          petpoojaStatus: "synced",
          petpoojaSyncStatus: "synced",
          kotPrinted: true,
          kotPrintedAt: admin.firestore.FieldValue.serverTimestamp(),
          kotPushedAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      return true;
    } else {
      throw new Error(result.message || "Petpooja KOT push rejected by POS server");
    }
  } catch (err: any) {
    console.warn(`[Petpooja KOT Push Error] Order ${orderId}: ${err.message}`);
    const currentRetry = (order.petpoojaRetryCount || 0) + 1;

    await orderDoc.ref.set(
      {
        petpoojaStatus: "pending_retry",
        petpoojaSyncStatus: "pending_retry",
        petpoojaRetryCount: currentRetry,
        lastPetpoojaError: err.message,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    await captureErrorSnapshot({
      source: "petpooja",
      severity: "medium",
      message: `Petpooja KOT Push failed for order ${orderId} (Attempt ${currentRetry}): ${err.message}`,
      orderId,
      branchId,
    });

    return false;
  }
}
