import { db } from "../../core/firebase";
import { config } from "../../config/env";
import { verifyPorterWebhookSignature, timingSafeEqual } from "../../core/security";
import * as admin from "firebase-admin";

export interface PorterWebhookPayload {
  event_id?: string;
  order_id: string;
  event: string;
  timestamp?: number;
  driver_details?: {
    name?: string;
    phone?: string;
    vehicle_number?: string;
    lat?: number;
    lng?: number;
  };
  location?: {
    lat: number;
    lng: number;
  };
  tracking_url?: string;
  cancellation_reason?: string;
}

export function normalizePorterEvent(event: string | undefined | null): string {
  if (!event) return "UNKNOWN";
  const e = String(event).toUpperCase().trim();
  if (["ASSIGNED", "DRIVER_ALLOCATED", "ALLOCATED", "DRIVER_ASSIGNED"].includes(e)) {
    return "DRIVER_ALLOCATED";
  }
  if (["ARRIVED_AT_PICKUP", "ARRIVED_PICKUP", "AT_STORE", "ARRIVED"].includes(e)) {
    return "ARRIVED_AT_PICKUP";
  }
  if (["IN_TRANSIT", "STARTED_DELIVERY", "PICKED_UP", "OUT_FOR_DELIVERY", "DISPATCHED"].includes(e)) {
    return "STARTED_DELIVERY";
  }
  if (["DELIVERED", "COMPLETED", "DROP_COMPLETED"].includes(e)) {
    return "DELIVERED";
  }
  if (["CANCELLED", "RIDER_CANCELLED", "NO_RIDERS_AVAILABLE", "FAILED"].includes(e)) {
    return "CANCELLED";
  }
  return e;
}

/**
 * Handles incoming Porter Logistics Webhook events with signature validation and Firestore sync
 */
export async function handlePorterWebhookEvent(
  rawBody: string | Buffer,
  signatureHeader: string | undefined,
  payload: PorterWebhookPayload
): Promise<{ success: boolean; message: string; orderId?: string }> {
  // 1. Signature Verification
  const webhookSecret = config.porter.webhookSecret;
  if (webhookSecret && signatureHeader) {
    const isValid = verifyPorterWebhookSignature(
      rawBody.toString("utf8"),
      signatureHeader,
      webhookSecret
    );
    if (!isValid) {
      return { success: false, message: "Invalid Porter webhook signature" };
    }
  }

  const { order_id, event, driver_details, location, tracking_url, cancellation_reason } = payload;
  if (!order_id) {
    return { success: false, message: "Missing order_id in Porter payload" };
  }

  // 2. Query matching order in Firestore
  const ordersRef = db.collection("orders");
  const querySnap = await ordersRef.where("porterOrderId", "==", order_id).limit(1).get();

  let targetOrderRef: admin.firestore.DocumentReference | null = null;
  if (!querySnap.empty) {
    targetOrderRef = querySnap.docs[0].ref;
  } else {
    // Check direct docId fallback
    const directDoc = await ordersRef.doc(order_id).get();
    if (directDoc.exists) {
      targetOrderRef = directDoc.ref;
    }
  }

  if (!targetOrderRef) {
    console.warn(`[Porter Webhook] No matching order found for Porter order ID: ${order_id}`);
    return { success: false, message: `Order not found for Porter ID ${order_id}` };
  }

  const normalized = normalizePorterEvent(event);
  const updateData: Record<string, any> = {
    "delivery.lastWebhookEvent": normalized,
    "delivery.lastWebhookAt": admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  if (tracking_url) {
    updateData["delivery.trackingUrl"] = tracking_url;
  }

  // 3. Update Rider Details & Live GPS Coordinates
  const riderLat = location?.lat || driver_details?.lat;
  const riderLng = location?.lng || driver_details?.lng;

  if (typeof riderLat === "number" && typeof riderLng === "number") {
    updateData["delivery.riderLocation"] = {
      lat: riderLat,
      lng: riderLng,
      updatedAt: Date.now(),
    };
  }

  if (driver_details) {
    if (driver_details.name) updateData["delivery.riderName"] = driver_details.name;
    if (driver_details.phone) updateData["delivery.riderPhone"] = driver_details.phone;
    if (driver_details.vehicle_number) updateData["delivery.riderVehicleNumber"] = driver_details.vehicle_number;
  }

  // 4. Map Porter Lifecycle Event to Order Status
  switch (normalized) {
    case "DRIVER_ALLOCATED":
      updateData["deliveryStatus"] = "in_transit";
      updateData["delivery.status"] = "driver_allocated";
      break;

    case "ARRIVED_AT_PICKUP":
      updateData["deliveryStatus"] = "in_transit";
      updateData["delivery.status"] = "arrived_at_store";
      break;

    case "STARTED_DELIVERY":
      // Canonical object form (both apps + triggers accept it; bare strings
      // break Delivery tracking).
      updateData["status"] = {
        code: "OUT_FOR_DELIVERY",
        label: "Out for delivery",
        kind: "in_progress",
        terminal: false,
      };
      updateData["deliveryStatus"] = "in_transit";
      updateData["delivery.status"] = "out_for_delivery";
      updateData["dispatchedAt"] = admin.firestore.FieldValue.serverTimestamp();
      break;

    case "DELIVERED":
      updateData["status"] = {
        code: "DELIVERED",
        label: "Delivered",
        kind: "completed",
        terminal: true,
      };
      updateData["deliveryStatus"] = "delivered";
      updateData["delivery.status"] = "delivered";
      updateData["deliveredAt"] = admin.firestore.FieldValue.serverTimestamp();
      break;

    case "CANCELLED":
      updateData["deliveryStatus"] = "rider_cancelled";
      updateData["delivery.status"] = "cancelled";
      if (cancellation_reason) {
        updateData["delivery.cancellationReason"] = cancellation_reason;
      }
      break;

    default:
      console.log(`[Porter Webhook] Event ${normalized} processed.`);
  }

  await targetOrderRef.set(updateData, { merge: true });

  return {
    success: true,
    message: `Processed Porter event: ${normalized}`,
    orderId: targetOrderRef.id,
  };
}
