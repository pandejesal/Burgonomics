import * as crypto from "crypto";
import { db } from "../../core/firebase";
import { config } from "../../config/env";
import {
  timingSafeEqual,
  verifyPorterWebhookSignature,
  computeHmacSha256,
  getOtpHmacSecret,
} from "../../core/security";
import { captureErrorSnapshot } from "../../core/errors";
import { assertOrderBranchAccess, type StaffCaller } from "../../core/middleware";
import {
  calculateHaversineDistanceKm,
  calculatePorterFare,
  estimatePickupMinutes,
} from "../../core/utils/geo.utils";
import * as admin from "firebase-admin";

export interface PorterQuoteParams {
  pickupLat?: number;
  pickupLng?: number;
  dropLat?: number;
  dropLng?: number;
  customerName?: string;
  customerPhone?: string;
}

export interface PorterQuoteResult {
  estimatedDistanceKm: number;
  estimatedFare: number;
  estimatedPickupMinutes: number;
  vehicleType: string;
  quoteId: string;
  source: string;
  validForSeconds: number;
  expiresAt: number;
}

/**
 * Calculates live Porter delivery fare quote based on pickup & drop GPS with 10-minute fee lock TTL.
 */
export async function getDeliveryQuote(params: PorterQuoteParams): Promise<PorterQuoteResult> {
  const pickupLat = params.pickupLat || 23.0131;
  const pickupLng = params.pickupLng || 72.5085;
  const dropLat = params.dropLat || 23.0338;
  const dropLng = params.dropLng || 72.5262;

  const estimatedDistanceKm = calculateHaversineDistanceKm(
    pickupLat,
    pickupLng,
    dropLat,
    dropLng
  );

  const TTL_SECONDS = 600; // 10 minutes fee lock
  const expiresAt = Date.now() + TTL_SECONDS * 1000;

  if (!config.mock.porterDispatch && config.porter.apiKey) {
    try {
      const response = await fetch(`${config.porter.baseUrl}/v1/orders/quote`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": config.porter.apiKey,
        },
        body: JSON.stringify({
          pickup_details: { lat: pickupLat, lng: pickupLng },
          drop_details: { lat: dropLat, lng: dropLng },
          vehicle_type: "2_WHEELER",
        }),
      });

      if (response.ok) {
        const data = await response.json();
        const fare = data.fare || calculatePorterFare(data.distance || estimatedDistanceKm);
        return {
          estimatedDistanceKm: data.distance || estimatedDistanceKm,
          estimatedFare: fare,
          estimatedPickupMinutes: data.eta || estimatePickupMinutes(),
          vehicleType: "2-Wheeler (Bike Express)",
          quoteId: data.quote_id || `QTE-PRTR-${Date.now()}`,
          source: "porter_api_live",
          validForSeconds: TTL_SECONDS,
          expiresAt,
        };
      }
    } catch (err: any) {
      console.warn("[Porter Quote] Failed live quote, falling back to standard rate card:", err);
    }
  }

  // Standard 2-Wheeler Rate Card: ₹40 base for 2km + ₹10/km
  const estimatedFare = calculatePorterFare(estimatedDistanceKm);

  return {
    estimatedDistanceKm,
    estimatedFare,
    estimatedPickupMinutes: estimatePickupMinutes(),
    vehicleType: "2-Wheeler (Bike Express)",
    quoteId: `QTE-PRTR-${Math.floor(10000 + Math.random() * 90000)}`,
    source: "porter_standard_rate_card",
    validForSeconds: TTL_SECONDS,
    expiresAt,
  };
}

/**
 * Normalizes Porter webhook event names across standard Porter API events and aliases.
 */
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
  if (["CANCELLED", "RIDER_CANCELLED", "FAILED_DELIVERY", "NO_RIDERS_FOUND", "REJECTED"].includes(e)) {
    return "RIDER_CANCELLED";
  }
  return e;
}

/**
 * Dispatches Porter 3PL courier rider for an order from the Partner POS.
 */
export async function bookPorterRider(
  orderId: string,
  staffName?: string,
  caller?: StaffCaller
) {
  const orderDoc = await db.collection("orders").doc(orderId).get();
  if (!orderDoc.exists) {
    throw new Error(`Order ${orderId} not found`);
  }

  const order = orderDoc.data()!;
  if (caller) await assertOrderBranchAccess(caller, order);

  // Fail loudly: booking a rider against a fake/missing contact or address
  // produces a "successful" dispatch nobody can complete. Real data or error.
  if (!order.customerPhone) {
    throw new Error(
      `Cannot book Porter rider for order ${orderId}: customer phone is missing`
    );
  }
  const orderType = order.orderType || order.fulfillment || "delivery";
  const drop = order.deliveryAddress;
  if (orderType === "delivery" && !(drop?.street || drop?.full || (drop?.lat && drop?.lng))) {
    throw new Error(
      `Cannot book Porter rider for order ${orderId}: delivery address is missing`
    );
  }

  const pickupLat = order.branchCoordinates?.lat || 23.0131;
  const pickupLng = order.branchCoordinates?.lng || 72.5085;
  const dropLat = order.deliveryAddress?.lat || 23.0338;
  const dropLng = order.deliveryAddress?.lng || 72.5262;

  let dispatchResult: any;

  if (config.mock.porterDispatch) {
    const mockRiders = [
      { name: "Ramesh Patel", phone: "+91 98250 11223", vehicle: "GJ-01-EE-8821" },
      { name: "Sanjay Varma", phone: "+91 97123 44556", vehicle: "GJ-27-AK-1029" },
      { name: "Jayesh Parmar", phone: "+91 99090 77881", vehicle: "GJ-06-BQ-5544" },
    ];
    const rider = mockRiders[Math.floor(Math.random() * mockRiders.length)];
    const porterOrderId = `PRTR-ORD-${Math.floor(100000 + Math.random() * 900000)}`;

    // Mock riders are clearly marked: without the [TEST] prefix + source flag,
    // simulated dispatches are indistinguishable from real riders everywhere
    // downstream (KDS, tracking links, audits).
    dispatchResult = {
      porterOrderId,
      riderName: `[TEST] ${rider.name}`,
      riderPhone: rider.phone,
      riderVehicleNumber: rider.vehicle,
      trackingUrl: `https://tracking.porter.in/track/${porterOrderId}`,
      status: "dispatched",
      dispatchSource: "mock",
    };
  } else {
    try {
      const payload = {
        request_id: `REQ-${orderId}`,
        delivery_instructions: order.deliveryInstructions || "Handle fresh food with care",
        pickup_details: {
          address: {
            apartment_address: order.branchName || "Burgonomics Branch",
            street_address1: order.branchAddress || "Store Location",
            city: order.branchCity || "Ahmedabad",
            state: order.branchState || "Gujarat",
            pincode: order.branchPincode || "380015",
            country: "India",
            lat: pickupLat,
            lng: pickupLng,
            contact_details: {
              name: order.branchName || "Burgonomics Branch Staff",
              phone_number: order.branchPhone || "+919876543210",
            },
          },
          lat: pickupLat,
          lng: pickupLng,
        },
        drop_details: {
          address: {
            apartment_address: order.deliveryAddress?.house || order.deliveryAddress?.flat || "",
            street_address1:
              order.deliveryAddress?.street ||
              order.deliveryAddress?.full ||
              "Customer Delivery Address",
            city: order.deliveryAddress?.city || "Ahmedabad",
            state: order.deliveryAddress?.state || "Gujarat",
            pincode: order.deliveryAddress?.pincode || "380015",
            country: "India",
            lat: dropLat,
            lng: dropLng,
            contact_details: {
              name: order.customerName || "Customer",
              phone_number: order.customerPhone,
            },
          },
          lat: dropLat,
          lng: dropLng,
          contact_number: order.customerPhone,
        },
        vehicle_type: "2_WHEELER",
      };

      const response = await fetch(`${config.porter.baseUrl}/v1/orders/create`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": config.porter.apiKey,
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        let errMessage = `Porter order dispatch rejected (HTTP ${response.status})`;
        try {
          const errData = await response.json();
          if (errData?.message) errMessage = errData.message;
        } catch {
          // Non-JSON error body (e.g. 502/504 gateway response)
        }
        throw new Error(errMessage);
      }

      const data = await response.json();

      dispatchResult = {
        porterOrderId: data.order_id,
        riderName: data.driver_details?.name || data.driver?.name || "Porter Driver",
        riderPhone: data.driver_details?.phone || data.driver?.phone || "",
        riderVehicleNumber: data.driver_details?.vehicle_number || data.driver?.vehicle_number || "",
        trackingUrl: data.tracking_url || "",
        status: "dispatched",
      };
    } catch (err: any) {
      await captureErrorSnapshot({
        source: "porter",
        severity: "high",
        message: `Failed to book Porter rider for order ${orderId}: ${err.message}`,
        orderId,
        branchId: order.branchId,
      });
      throw err;
    }
  }

  // Update order in Firestore
  await orderDoc.ref.set(
    {
      porterOrderId: dispatchResult.porterOrderId,
      deliveryStatus: "dispatched",
      riderName: dispatchResult.riderName,
      riderPhone: dispatchResult.riderPhone,
      riderVehicleNumber: dispatchResult.riderVehicleNumber,
      riderTrackingUrl: dispatchResult.trackingUrl,
      dispatchedBy: staffName || "Branch Staff",
      dispatchedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  return dispatchResult;
}

/**
 * Handles Porter Webhook driver lifecycle events with HMAC validation and normalized events.
 */
export async function handlePorterWebhook(
  rawBody: string,
  signature: string,
  payload: any
): Promise<void> {
  if (!config.mock.porterDispatch) {
    const isValid = verifyPorterWebhookSignature(
      rawBody,
      signature,
      config.porter.webhookSecret
    );
    if (!isValid) {
      throw new Error("Invalid Porter webhook signature");
    }
  }

  const rawEvent = payload.event;
  const event = normalizePorterEvent(rawEvent);
  const porterOrderId = payload.order_id;
  const orderId = payload.request_id ? payload.request_id.replace("REQ-", "") : null;

  if (!orderId && !porterOrderId) {
    console.warn("[Porter Webhook] Dropping event with no order reference:", rawEvent);
    return;
  }

  // Locate order
  let orderRef: admin.firestore.DocumentReference | null = null;
  if (orderId) {
    orderRef = db.collection("orders").doc(orderId);
  } else {
    const q = await db.collection("orders").where("porterOrderId", "==", porterOrderId).limit(1).get();
    if (!q.empty) {
      orderRef = q.docs[0].ref;
    }
  }

  if (!orderRef) {
    // Unknown order: retrying won't help, but silence loses the trail.
    console.warn(
      `[Porter Webhook] No matching order for event ${rawEvent} (porterOrderId=${porterOrderId || "n/a"})`
    );
    return;
  }

  const driverDetails = payload.driver_details || payload.driver || payload.rider || {};

  const updateData: Record<string, any> = {
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    porterWebhookEvent: rawEvent,
  };

  switch (event) {
    case "DRIVER_ALLOCATED":
      updateData.riderName = driverDetails.name || payload.driver_name;
      updateData.riderPhone = driverDetails.phone || payload.driver_phone;
      updateData.riderVehicleNumber = driverDetails.vehicle_number || payload.driver_vehicle_number;
      updateData.riderTrackingUrl = payload.tracking_url || payload.tracking_link;
      updateData.deliveryStatus = "dispatched";
      break;

    case "ARRIVED_AT_PICKUP":
      updateData.riderArrivedAtStore = true;
      updateData.riderArrivedAt = admin.firestore.FieldValue.serverTimestamp();
      break;

    case "STARTED_DELIVERY":
      // Canonical object form (both apps + triggers accept it).
      updateData.status = {
        code: "OUT_FOR_DELIVERY",
        label: "Out for delivery",
        kind: "in_progress",
        terminal: false,
      };
      updateData.deliveryStatus = "in_transit";
      break;

    case "DELIVERED":
      updateData.status = {
        code: "DELIVERED",
        label: "Delivered",
        kind: "completed",
        terminal: true,
      };
      updateData.deliveryStatus = "delivered";
      updateData.deliveredAt = admin.firestore.FieldValue.serverTimestamp();
      break;

    case "RIDER_CANCELLED":
    case "NO_RIDERS_FOUND":
      updateData.deliveryStatus = "rider_cancelled";
      updateData.riderCancellationReason = payload.reason || "Driver cancelled dispatch";
      break;
  }

  await orderRef.set(updateData, { merge: true });
}

/**
 * 1-Click re-booking for cancelled Porter riders.
 */
export async function rebookPorterRider(
  orderId: string,
  staffName?: string,
  caller?: StaffCaller
) {
  return await bookPorterRider(orderId, staffName, caller);
}

/**
 * Generates a cryptographically secure 4-digit delivery verification OTP (India QSR handover compliance).
 */
export function generateDeliveryOtp(): string {
  return String(crypto.randomInt(1000, 10000));
}

export interface VerifyDeliveryOtpParams {
  orderId: string;
  otp: string;
  staffName?: string;
  /** Authenticated staff caller — enforced when present (all HTTP routes pass it). */
  caller?: StaffCaller;
}

export const OTP_MAX_ATTEMPTS = 3;
export const OTP_LOCKOUT_MS = 15 * 60 * 1000;

/**
 * Verifies Customer 4-digit Delivery OTP on handover to finalize order delivery.
 * 3-attempt lockout (15 min) stops brute-forcing the 10k OTP space.
 */
export async function verifyDeliveryOtp(params: VerifyDeliveryOtpParams): Promise<{
  success: boolean;
  orderId: string;
  deliveredAt: string;
}> {
  const { orderId, otp, staffName, caller } = params;
  if (!orderId || !otp) {
    throw new Error("orderId and 4-digit OTP are required for delivery verification");
  }

  const orderDoc = await db.collection("orders").doc(orderId).get();
  if (!orderDoc.exists) {
    throw new Error(`Order ${orderId} not found`);
  }

  const order = orderDoc.data()!;
  // Branch-scoped authorization BEFORE touching OTP state: an anonymous
  // caller must never be able to burn attempts or flip an order to DELIVERED.
  if (caller) await assertOrderBranchAccess(caller, order);
  const storedHash = String(order.deliveryOtpHash || "").trim();
  const legacyOtp = String(order.deliveryOtp || "").trim();

  if (!storedHash && !legacyOtp) {
    throw new Error("No delivery OTP found on order record");
  }

  const lockedUntil = Number(order.deliveryOtpLockedUntil || 0);
  if (lockedUntil > Date.now()) {
    const retryIn = Math.ceil((lockedUntil - Date.now()) / 60000);
    throw new Error(
      `Too many wrong attempts. Retry in ${retryIn} minute${retryIn === 1 ? "" : "s"}.`
    );
  }

  const enteredOtp = String(otp).trim();
  if (enteredOtp.length !== 4) {
    throw new Error("Delivery OTP must be exactly 4 digits");
  }

  // Timing-safe OTP comparison (prevents timing oracle).
  // Hash-first: new orders persist only an HMAC-SHA256 hash; legacy plaintext
  // orders are still verified until they are re-verified and migrated.
  const isValid = storedHash
    ? timingSafeEqual(
        computeHmacSha256(enteredOtp, getOtpHmacSecret(config.razorpay.webhookSecret)),
        storedHash
      )
    : timingSafeEqual(enteredOtp, legacyOtp);

  if (!isValid) {
    const attempts = Number(order.deliveryOtpAttempts || 0) + 1;
    const locked = attempts >= OTP_MAX_ATTEMPTS;
    await orderDoc.ref.set(
      {
        deliveryOtpAttempts: attempts,
        ...(locked ? { deliveryOtpLockedUntil: Date.now() + OTP_LOCKOUT_MS } : {}),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    await captureErrorSnapshot({
      source: "porter",
      severity: locked ? "high" : "medium",
      message: `Invalid Delivery OTP attempt ${attempts}/${OTP_MAX_ATTEMPTS} for order ${orderId}${locked ? " — LOCKED" : ""}`,
      orderId,
    });
    if (locked) {
      throw new Error(
        `Too many wrong attempts. Retry in ${OTP_LOCKOUT_MS / 60000} minutes.`
      );
    }
    throw new Error("Invalid Delivery OTP. Please verify the code on the customer screen.");
  }

  // Canonical object form (both apps + triggers accept it; bare strings with
  // invalid kinds like "delivered" break Delivery tracking).
  // Successful verification also clears the attempt counter + lockout.
  const updateData = {
    deliveryOtpAttempts: 0,
    deliveryOtpLockedUntil: null,
    status: {
      code: "DELIVERED",
      label: "Delivered",
      kind: "completed",
      terminal: true,
    },
    deliveryStatus: "delivered",
    deliveredAt: admin.firestore.FieldValue.serverTimestamp(),
    deliveryVerifiedBy: "customer_otp",
    verifiedByStaff: staffName || "Branch Staff",
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  await orderDoc.ref.set(updateData, { merge: true });

  return {
    success: true,
    orderId,
    deliveredAt: new Date().toISOString(),
  };
}

export interface ManualBranchDispatchParams {
  orderId: string;
  riderName: string;
  riderPhone: string;
  staffName?: string;
  notes?: string;
  /** Authenticated staff caller — enforced when present (all HTTP routes pass it). */
  caller?: StaffCaller;
}

/**
 * Manual Dispatch from Branch POS Terminal device when Porter 3PL courier is unavailable.
 */
export async function manualBranchDispatch(params: ManualBranchDispatchParams) {
  const { orderId, riderName, riderPhone, staffName, notes, caller } = params;
  if (!orderId || !riderName || !riderPhone) {
    throw new Error("orderId, riderName, and riderPhone are required for manual branch dispatch");
  }

  const orderDoc = await db.collection("orders").doc(orderId).get();
  if (!orderDoc.exists) {
    throw new Error(`Order ${orderId} not found`);
  }
  if (caller) await assertOrderBranchAccess(caller, orderDoc.data()!);

  const dispatchResult = {
    dispatchType: "manual_branch_terminal",
    deliveryStatus: "dispatched",
    riderName: riderName.trim(),
    riderPhone: riderPhone.trim(),
    riderVehicleNumber: "Local / In-Store",
    dispatchedBy: staffName || "Branch Manager",
    dispatchedAt: admin.firestore.FieldValue.serverTimestamp(),
    manualDispatchNotes: notes || "Dispatched via Branch POS Terminal fallback",
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  await orderDoc.ref.set(dispatchResult, { merge: true });

  return {
    success: true,
    orderId,
    ...dispatchResult,
  };
}

/**
 * 5-Minute Polling Fallback Worker for active Porter deliveries with delayed webhooks (> 15 minutes).
 */
export async function pollActivePorterOrdersWorker(): Promise<{
  polledCount: number;
  updatedCount: number;
}> {
  // Query orders currently in dispatched or in_transit state
  const activeOrdersSnap = await db
    .collection("orders")
    .where("deliveryStatus", "in", ["dispatched", "in_transit"])
    .limit(25)
    .get();

  let polledCount = 0;
  let updatedCount = 0;
  const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;
  const now = Date.now();

  for (const doc of activeOrdersSnap.docs) {
    const order = doc.data();
    const porterOrderId = order.porterOrderId;
    if (!porterOrderId) continue;

    const lastUpdated = order.updatedAt?.toMillis ? order.updatedAt.toMillis() : 0;
    const timeSinceUpdate = now - lastUpdated;

    // Only poll if no updates received for > 15 minutes
    if (timeSinceUpdate >= FIFTEEN_MINUTES_MS) {
      polledCount++;
      try {
        if (config.mock.porterDispatch) {
          // Advance mock order if in transit > 20 mins
          if (timeSinceUpdate >= 20 * 60 * 1000) {
            await doc.ref.set(
              {
                status: {
                  code: "OUT_FOR_DELIVERY",
                  label: "Out for delivery",
                  kind: "in_progress",
                  terminal: false,
                },
                deliveryStatus: "in_transit",
                lastPolledAt: admin.firestore.FieldValue.serverTimestamp(),
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              },
              { merge: true }
            );
            updatedCount++;
          }
        } else if (config.porter.apiKey) {
          const response = await fetch(`${config.porter.baseUrl}/v1/orders/${porterOrderId}`, {
            headers: {
              "x-api-key": config.porter.apiKey,
              "Content-Type": "application/json",
            },
          });

          if (response.ok) {
            const data = await response.json();
            const normalized = normalizePorterEvent(data.status || data.event);
            const driver = data.driver_details || data.driver || {};

            const updatePayload: Record<string, any> = {
              lastPolledAt: admin.firestore.FieldValue.serverTimestamp(),
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            };

            if (driver.name) updatePayload.riderName = driver.name;
            if (driver.phone) updatePayload.riderPhone = driver.phone;
            if (driver.vehicle_number) updatePayload.riderVehicleNumber = driver.vehicle_number;

            if (normalized === "STARTED_DELIVERY") {
              updatePayload.status = {
                code: "OUT_FOR_DELIVERY",
                label: "Out for delivery",
                kind: "in_progress",
                terminal: false,
              };
              updatePayload.deliveryStatus = "in_transit";
            } else if (normalized === "DELIVERED") {
              updatePayload.status = {
                code: "DELIVERED",
                label: "Delivered",
                kind: "completed",
                terminal: true,
              };
              updatePayload.deliveryStatus = "delivered";
            }

            await doc.ref.set(updatePayload, { merge: true });
            updatedCount++;
          }
        }
      } catch (err: any) {
        console.warn(`[Porter Polling Worker] Failed to poll order ${doc.id}: ${err.message}`);
      }
    }
  }

  return { polledCount, updatedCount };
}
