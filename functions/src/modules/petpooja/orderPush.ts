import { db } from "../../core/firebase";
import { config } from "../../config/env";
import { captureErrorSnapshot } from "../../core/errors";
import { getPetpoojaConfig } from "./client";
import * as admin from "firebase-admin";

function getCallbackUrl(): string {
  return (
    (config.petpooja as { callbackUrl?: string }).callbackUrl ||
    `https://asia-south1-${config.firebase.projectId}.cloudfunctions.net/api/petpooja/webhook`
  );
}

export function formatPetpoojaOrderPayload(order: any, branch: any) {
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

  return {
    // callback_url tells Petpooja where to POST KOT status updates
    // (accept/reject/ready/delivered). Without it our webhook is unreachable.
    callback_url: getCallbackUrl(),
    orderinfo: {
      orderID: order.orderNumber || order.id,
      clientOrderID: order.id,
      // Branch registry first; fall back to the Delivery store snapshot so
      // KOT push works even before ops links the outlet (branchId=null).
      resID:
        branch?.petpoojaStoreId ||
        branch?.id ||
        order.branchId ||
        order.store?.petpoojaRestId ||
        order.store?.id,
      order_type: orderType,
      payment_type: paymentType,
      total: grandTotal,
      tax: gstAmount,
      discount: discountAmount,
      delivery_charges: deliveryFee,
      packing_charges: packagingFee,
      customer_name: order.customerName || order.customer?.name || "Customer",
      // Never invent a phone number: an empty string fails visibly at Petpooja
      // instead of dispatching a rider to a fake contact. Counter orders must
      // capture a real number (Partner modal enforces this for delivery).
      customer_phone: order.customerPhone || order.customer?.phone || "",
      customer_address:
        orderType === "1" ? order.address?.street || order.customerAddress || "" : "",
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

export async function pushOrderToPetpooja(orderId: string): Promise<boolean> {
  const orderDoc = await db.collection("orders").doc(orderId).get();
  if (!orderDoc.exists) {
    throw new Error(`Order ${orderId} does not exist`);
  }

  const order = orderDoc.data()!;
  const branchId = order.branchId;

  // Mock Mode Return
  if (config.mock.petpoojaPos) {
    const mockPetpoojaOrderId = `pp_kot_${Date.now()}`;
    await orderDoc.ref.set(
      {
        petpoojaOrderId: mockPetpoojaOrderId,
        petpoojaStatus: "synced",
        petpoojaSyncStatus: "synced",
        kotPrinted: true,
        kotPrintedAt: admin.firestore.FieldValue.serverTimestamp(),
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
    const payload = formatPetpoojaOrderPayload(order, branchData);

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
