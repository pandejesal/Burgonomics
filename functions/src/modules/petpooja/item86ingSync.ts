import { db } from "../../core/firebase";
import { config } from "../../config/env";
import { getPetpoojaConfig } from "./client";
import { autoRefund } from "../payments/razorpay.service";
import * as admin from "firebase-admin";

/**
 * Normalizes Petpooja order status codes into canonical Burgonomics order statuses.
 */
export function normalizePetpoojaStatus(rawStatus: any): string {
  if (rawStatus === null || rawStatus === undefined) {
    return "unknown";
  }

  const statusStr = String(rawStatus).toUpperCase().trim();

  // Numeric codes
  if (statusStr === "-1") return "cancelled";
  if (statusStr === "1" || statusStr === "2" || statusStr === "3") return "accepted";
  if (statusStr === "4") return "out_for_delivery";
  if (statusStr === "5") return "ready";
  if (statusStr === "10") return "delivered";

  // Named constants
  if (statusStr.includes("CANCEL")) return "cancelled";
  if (statusStr.includes("ACCEPT") || statusStr.includes("KITCHEN")) return "accepted";
  if (statusStr.includes("READY")) return "ready";
  if (statusStr.includes("DISPATCH") || statusStr.includes("OUT_FOR_DELIVERY"))
    return "out_for_delivery";
  if (statusStr.includes("DELIVER")) return "delivered";

  return "unknown";
}

/**
 * Instant stock-out (86ing) webhook handler from Petpooja physical POS.
 */
export async function handlePetpoojaStockWebhook(payload: any): Promise<void> {
  const { rest_id, item_id, in_stock } = payload;
  const inStockBool = in_stock === 1 || in_stock === "1" || in_stock === true;

  if (item_id) {
    const productId = `prod_${item_id}`;
    await db.collection("products").doc(productId).set(
      {
        inStock: inStockBool,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  }

  console.log(`[Petpooja 86ing] Item ${item_id} at branch ${rest_id} set inStock=${inStockBool}`);
}

/**
 * Outgoing stock toggle from Partner POS App to Petpooja Cloud API.
 */
export async function pushItemStockToPetpooja(
  branchId: string,
  itemId: string,
  inStock: boolean
): Promise<boolean> {
  if (config.mock.petpoojaPos) {
    console.log(`[Mock Petpooja 86ing] Pushed branch=${branchId} item=${itemId} inStock=${inStock}`);
    return true;
  }

  try {
    const petpoojaConfig = getPetpoojaConfig();
    const response = await fetch(petpoojaConfig.stockUrl, {
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
        rest_id: branchId,
        item_id: itemId,
        in_stock: inStock ? 1 : 0,
      }),
    });

    const result = await response.json();
    return result.status === "success";
  } catch (err: any) {
    console.warn(`[Petpooja Stock Push Error] Failed for item ${itemId}:`, err.message);
    return false;
  }
}

/**
 * Handles incoming order lifecycle webhook updates (e.g. food ready, driver assigned, cancellation).
 */
export async function handlePetpoojaWebhook(payload: any): Promise<void> {
  const orderId = payload.order_id || payload.clientOrderID || payload.client_order_id;
  if (!orderId) {
    throw new Error("Missing order_id in Petpooja status webhook payload");
  }

  const orderDoc = await db.collection("orders").doc(orderId).get();
  if (!orderDoc.exists) {
    console.warn(`[Petpooja Webhook] Order ${orderId} not found in Firestore.`);
    return;
  }

  const rawStatus = payload.status || payload.order_status;
  const canonicalStatus = normalizePetpoojaStatus(rawStatus);

  const updateData: Record<string, any> = {
    petpoojaKitchenStatus: rawStatus,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  // Canonical object form (both apps + triggers accept it; bare strings with
  // lowercase codes break Delivery tracking).
  const statusMeta: Record<string, { code: string; label: string; kind: string; terminal: boolean }> = {
    accepted: { code: "CONFIRMED", label: "Order confirmed", kind: "upcoming", terminal: false },
    ready: { code: "READY_FOR_PICKUP", label: "Ready for pickup", kind: "in_progress", terminal: false },
    out_for_delivery: { code: "OUT_FOR_DELIVERY", label: "Out for delivery", kind: "in_progress", terminal: false },
    delivered: { code: "DELIVERED", label: "Delivered", kind: "completed", terminal: true },
    cancelled: { code: "CANCELLED", label: "Cancelled", kind: "cancelled", terminal: true },
  };

  if (canonicalStatus !== "unknown" && statusMeta[canonicalStatus]) {
    updateData.status = statusMeta[canonicalStatus];
  }

  if (canonicalStatus === "cancelled") {
    updateData.cancelledAt = admin.firestore.FieldValue.serverTimestamp();
    updateData.cancellationReason =
      payload.cancel_reason || payload.reason || "Cancelled by kitchen operator in Petpooja POS";

    const orderData = orderDoc.data()!;
    const payment = orderData.payment;
    if (payment?.razorpayPaymentId && !payment.refunded) {
      try {
        await autoRefund({
          orderId,
          razorpayPaymentId: payment.razorpayPaymentId,
          reason: "POS_CANCELLED",
        });
        updateData["payment.refundStatus"] = "INITIATED";
      } catch (err) {
        console.error(`Auto-refund failed on Petpooja cancel for ${orderId}:`, err);
      }
    }
  }

  await orderDoc.ref.set(updateData, { merge: true });
}
