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
  /** True when GPS was missing and fallback coordinates priced the quote. */
  isEstimate?: boolean;
  validForSeconds: number;
  expiresAt: number;
}

/**
 * Calculates live Porter delivery fare quote based on pickup & drop GPS with 10-minute fee lock TTL.
 */
export async function getDeliveryQuote(params: PorterQuoteParams): Promise<PorterQuoteResult> {
  // Missing/zero GPS silently produced a "live-looking" fare for a fixed
  // Ahmedabad hop — the fee charged at checkout then mismatched the address.
  // Flag it: callers must label estimates and re-quote with real GPS before
  // charging. (Not a hard 400: branch consoles legitimately pre-quote before
  // the customer pins their address.)
  const isEstimate =
    !params.pickupLat || !params.pickupLng || !params.dropLat || !params.dropLng;
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
          isEstimate,
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
    source: isEstimate ? "fallback_estimate" : "porter_standard_rate_card",
    isEstimate,
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

/** Pending-claim lease: a crash between claim and POST must not park the
 * order in dispatch_pending forever (every future book would 202). */
const PORTER_DISPATCH_CLAIM_TTL_MS = 10 * 60 * 1000;

function porterClaimFreshMs(claimedAt: any): number {
  return claimedAt && typeof claimedAt.toMillis === "function" ? claimedAt.toMillis() : 0;
}

function dispatchInProgressError(): Error {
  // Immediate 202 (no blocking poll): the client retries book/rebook with the
  // same order — by then the winning tap has settled. Posting our own booking
  // here is exactly the double-book this guards.
  const retry: any = new Error(
    "Dispatch already in progress for this order — please retry in a couple of seconds (no second rider will be booked)."
  );
  retry.statusCode = 202;
  retry.code = "DISPATCH_IN_PROGRESS";
  retry.retryAfterMs = 2000;
  return retry;
}

function storedDispatchSummary(d: any): any {
  return {
    porterOrderId: d.porterOrderId,
    riderName: d.riderName,
    riderPhone: d.riderPhone,
    riderVehicleNumber: d.riderVehicleNumber,
    trackingUrl: d.riderTrackingUrl,
    status: "dispatched",
    dispatchSource: d.dispatchSource,
    geoSource: d.dispatchGeoSource,
    reused: true as const,
  };
}

/**
 * Per-order dispatch gate (B2-S1): returns a stored summary for idempotent
 * replay, throws 202 on a fresh competing claim, or claims dispatch_pending
 * and returns null (caller proceeds to POST). Claim-then-work inside a
 * transaction when available; read-check + direct claim on shims without it.
 */
async function claimPorterDispatch(orderDoc: any, order: any): Promise<any | null> {
  const isDispatched = (d: any): boolean =>
    !!d?.porterOrderId && ["dispatched", "in_transit"].includes(d?.deliveryStatus);
  const isFreshPending = (d: any): boolean =>
    d?.porterDispatchStatus === "dispatch_pending" &&
    Date.now() - porterClaimFreshMs(d?.porterDispatchClaimedAt) < PORTER_DISPATCH_CLAIM_TTL_MS;
  const claimWrite = {
    porterDispatchStatus: "dispatch_pending",
    porterDispatchClaimedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  if (db && typeof (db as any).runTransaction === "function") {
    const outcome: any = await (db as any).runTransaction(async (tx: any) => {
      const fresh = await tx.get(orderDoc.ref);
      const d = (fresh.exists ? fresh.data() : undefined) as any;
      if (!d) return { claimed: true };
      if (isDispatched(d)) return { reuse: true, data: d };
      // Another tap owns the booking right now — never POST ours. Stale
      // claims (>10 min, owner crashed) are taken over below.
      if (isFreshPending(d)) return { busy: true };
      tx.set(orderDoc.ref, claimWrite, { merge: true });
      return { claimed: true };
    });
    if (outcome?.reuse) return storedDispatchSummary(outcome.data);
    if (outcome?.busy) throw dispatchInProgressError();
    return null;
  }

  // Fallback for Firestore shims without transactions (tests): same rules on
  // the already-read order. Concurrent taps are serialized by the caller's
  // per-order pending UI state (partner H-M8 fix); this is the last guard.
  if (isDispatched(order)) return storedDispatchSummary(order);
  if (isFreshPending(order)) throw dispatchInProgressError();
  await orderDoc.ref.set(claimWrite, { merge: true });
  return null;
}

/**
 * Dispatches Porter 3PL courier rider for an order from the Partner POS.
 *
 * Idempotent per order (B2-S1, H-M8 double-book): an already-dispatched order
 * replays its stored dispatch instead of POSTing a second booking; concurrent
 * taps serialize on a per-order pending claim (fresh claim → immediate 202
 * retry signal, stale claim → takeover). Fail-closed GPS: delivery dispatch
 * without drop coordinates is refused (422) — never sent to fallback
 * defaults. Claim lifecycle: dispatch_pending → dispatched | dispatch_failed.
 */
export async function bookPorterRider(
  orderId: string,
  staffName?: string,
  caller?: StaffCaller,
  opts?: { idempotencyKey?: string }
) {
  const orderDoc = await db.collection("orders").doc(orderId).get();
  if (!orderDoc.exists) {
    const missing: any = new Error(`Order ${orderId} not found`);
    missing.statusCode = 404;
    missing.code = "ORDER_NOT_FOUND";
    throw missing;
  }

  const order = orderDoc.data()!;
  if (caller) await assertOrderBranchAccess(caller, order);

  // Fail loudly: booking a rider against a fake/missing contact or address
  // produces a "successful" dispatch nobody can complete. Real data or error.
  // Copy is staff-actionable with no raw ids (orderId rides in logs/snapshots).
  if (!order.customerPhone) {
    throw new Error("Customer phone number is missing — edit the order to add it, then retry dispatch.");
  }
  const orderType = order.orderType || order.fulfillment || "delivery";
  const drop = order.deliveryAddress;
  if (orderType === "delivery" && !(drop?.street || drop?.full || (drop?.lat && drop?.lng))) {
    throw new Error("Delivery address is incomplete — add street or map pin, then retry dispatch.");
  }
  // Fail-closed GPS (B2-S1, H-R19): a textual address without coordinates must
  // never dispatch a rider to fallback defaults — the courier would drive to
  // the wrong pin on a paid booking. Pin the address first (422, retryable).
  if (orderType === "delivery" && !(drop?.lat && drop?.lng)) {
    const noGps: any = new Error(
      "Delivery location is missing map coordinates — pin the customer address on the map, then retry dispatch."
    );
    noGps.statusCode = 422;
    noGps.code = "DISPATCH_GPS_MISSING";
    throw noGps;
  }

  // Per-order idempotency gate: replay + pending claim live here (before any
  // external POST) so neither the mock path nor the live path can double-book.
  const reuse = await claimPorterDispatch(orderDoc, order);
  if (reuse) return reuse;

  const pickupLat = order.branchCoordinates?.lat || 23.0131;
  const pickupLng = order.branchCoordinates?.lng || 72.5085;
  const dropLat = order.deliveryAddress?.lat || 23.0338;
  const dropLng = order.deliveryAddress?.lng || 72.5262;

  const usedFallbackCoords =
    !(order.branchCoordinates?.lat && order.branchCoordinates?.lng) ||
    !(order.deliveryAddress?.lat && order.deliveryAddress?.lng);
  const dispatchGeoSource = usedFallbackCoords ? "fallback_default" : "live_gps";

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
      geoSource: dispatchGeoSource,
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
        geoSource: dispatchGeoSource,
      };
    } catch (err: any) {
      await captureErrorSnapshot({
        source: "porter",
        severity: "high",
        message: `Failed to book Porter rider for order ${orderId}: ${err.message}`,
        orderId,
        branchId: order.branchId,
      });
      // Release the pending claim as failed (retryable): without this a
      // gateway outage parks every affected order in dispatch_pending until
      // the 10-minute stale-takeover — with it, staff can retry immediately.
      try {
        await orderDoc.ref.set(
          {
            porterDispatchStatus: "dispatch_failed",
            porterDispatchError: err?.message || "Porter booking failed",
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
      } catch {
        // Best-effort: the snapshot above is the durable trail.
      }
      throw err;
    }
  }

  // Update order in Firestore
  await orderDoc.ref.set(
    {
      porterOrderId: dispatchResult.porterOrderId,
      deliveryStatus: "dispatched",
      porterDispatchStatus: "dispatched",
      porterDispatchError: null,
      riderName: dispatchResult.riderName,
      riderPhone: dispatchResult.riderPhone,
      riderVehicleNumber: dispatchResult.riderVehicleNumber,
      riderTrackingUrl: dispatchResult.trackingUrl,
      dispatchGeoSource,
      dispatchedBy: staffName || "Branch Staff",
      dispatchedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  return dispatchResult;
}

/**
 * Deterministic parked-event doc id: same webhook retry → same doc (merge,
 * no duplicates). Sanitizes the event/order refs and mixes in a short hash
 * of the raw body so distinct payloads sharing a ref never collide.
 */
export function porterParkDocId(
  rawEvent: unknown,
  porterOrderId: unknown,
  orderId: unknown,
  rawBody: string
): string {
  const slug = (v: unknown, fallback: string): string => {
    const s = String(v ?? "").replace(/[^A-Za-z0-9_-]/g, "");
    return (s || fallback).slice(0, 48);
  };
  const bodyHash = crypto
    .createHash("sha256")
    .update(rawBody || "")
    .digest("hex")
    .slice(0, 12);
  return `upe_${slug(rawEvent, "unknown")}_${slug(
    porterOrderId || orderId,
    "noref"
  )}_${bodyHash}`;
}

/**
 * Handles Porter Webhook driver lifecycle events with HMAC validation and normalized events.
 */
export async function handlePorterWebhook(
  rawBody: string,
  signature: string,
  payload: any
): Promise<void> {
  // Fail-closed (H-M3/C4): the single inbound webhook secret is ALWAYS
  // verified — no mock bypass. An empty/unset secret denies (verify returns
  // false on empty), so an empty env can never accept a forged webhook.
  const isValid = verifyPorterWebhookSignature(
    rawBody,
    signature,
    config.porter.webhookSecret
  );
  if (!isValid) {
    // statusCode lets the route map auth failures to 401 (never 500-retry);
    // the route itself is owned by B1-S1/batch-2 — this throw changes no logic.
    const authErr: any = new Error("Invalid Porter webhook signature");
    authErr.statusCode = 401;
    throw authErr;
  }

  const rawEvent = payload.event;
  const event = normalizePorterEvent(rawEvent);
  const porterOrderId = payload.order_id;
  const orderId = payload.request_id ? payload.request_id.replace("REQ-", "") : null;

  // Parked-event idempotency keys: deterministic per (event, order
  // reference, body hash) so a retried webhook merges into ONE parked doc
  // instead of minting upe_<Date.now()> duplicates on every retry.
  const parkId = porterParkDocId(rawEvent, porterOrderId, orderId, rawBody);

  if (!orderId && !porterOrderId) {
    console.warn("[Porter Webhook] Dropping event with no order reference:", rawEvent);
    try {
      await db
        .collection("unmatched_porter_events")
        .doc(parkId)
        .set(
          {
            rawEvent: rawEvent || null,
            payloadOrderId: porterOrderId || null,
            status: "needs_review",
            reason: "no_order_reference",
            receivedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
      await captureErrorSnapshot({
        source: "porter",
        severity: "medium",
        message: "Porter webhook with no order reference parked for review",
      });
    } catch (err) {
      console.warn("[Porter Webhook] Failed to park event with no order reference:", err);
    }
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
    try {
      await db
        .collection("unmatched_porter_events")
        .doc(parkId)
        .set(
          {
            orderId: orderId || null,
            porterOrderId: porterOrderId || null,
            rawEvent: rawEvent || null,
            status: "needs_review",
            reason: "no_matching_order",
            receivedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
      await captureErrorSnapshot({
        source: "porter",
        severity: "medium",
        message: "Porter webhook for unmatched order parked for review",
      });
    } catch (err) {
      console.warn("[Porter Webhook] Failed to park unmatched order event:", err);
    }
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
    case "NO_RIDERS_FOUND": {
      // Canonical status flip (not just sidecar deliveryStatus): the old code
      // left status.code frozen, so both apps kept showing OUT_FOR_DELIVERY
      // and the status-change trigger (customer push) never fired. Core
      // renders the server label verbatim; partner maps RIDER_CANCELLED into
      // the actionable dispatch bucket (see orderContract).
      updateData.status = {
        code: "RIDER_CANCELLED",
        label: "Rider cancelled — rebook required",
        kind: "in_progress",
        terminal: false,
      };
      updateData.deliveryStatus = "rider_cancelled";
      updateData.needsRebook = true;
      updateData.riderCancellationReason = payload.reason || "Driver cancelled dispatch";
      break;
    }
  }

  await orderRef.set(updateData, { merge: true });

  // Branch alert: without it nobody knows to hit /porter/rebook and the
  // order rots. Customer push rides the existing status-change trigger.
  if (event === "RIDER_CANCELLED" || event === "NO_RIDERS_FOUND") {
    try {
      const snap = await orderRef.get();
      const branchId = snap.data()?.branchId;
      if (typeof branchId === "string" && branchId) {
        const { dispatchFCM } = await import("../notifications/fcm.service");
        await dispatchFCM({
          topic: `branch_${branchId}_orders`,
          title: "Rider cancelled — rebook needed",
          body: `Order #${orderRef.id.substring(0, 6)} lost its rider. Open the delivery queue to rebook.`,
          data: { type: "rider_cancelled", orderId: orderRef.id, needsRebook: "true" },
        });
      }
    } catch (err: any) {
      console.warn("[Porter Webhook] branch rebook alert failed:", err?.message || err);
    }
  }
}

/**
 * 1-Click re-booking for cancelled Porter riders.
 *
 * Guarded (B2-S1, H-M8/H22): only orders the courier actually dropped
 * (rider_cancelled / needs_review / dispatch_failed, or an explicit
 * needsRebook flag) may rebook — rebooking a live dispatch would pay for a
 * second rider on the same order.
 */
export async function rebookPorterRider(
  orderId: string,
  staffName?: string,
  caller?: StaffCaller,
  opts?: { idempotencyKey?: string }
) {
  const orderSnap = await db.collection("orders").doc(orderId).get();
  const order = (orderSnap.exists ? orderSnap.data() : undefined) as any;
  const rebookable =
    order?.needsRebook === true ||
    ["rider_cancelled", "needs_review", "dispatch_failed"].includes(order?.deliveryStatus);
  if (!rebookable) {
    const err: any = new Error(
      "This order is not waiting for a rebook — only cancelled, failed, or review-flagged dispatches can be rebooked."
    );
    err.statusCode = 409;
    err.code = "NOT_REBOOKABLE";
    throw err;
  }
  return await bookPorterRider(orderId, staffName, caller, opts);
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

  const order = orderDoc.data() || {};
  // Branch-scoped authorization BEFORE touching OTP state: an anonymous
  // caller must never be able to burn attempts or flip an order to DELIVERED.
  if (caller) await assertOrderBranchAccess(caller, order);
  const storedHash =
    typeof order.deliveryOtpHash === "string" ? order.deliveryOtpHash.trim() : "";
  const legacyOtp = typeof order.deliveryOtp === "string" ? order.deliveryOtp.trim() : "";

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
        computeHmacSha256(enteredOtp, getOtpHmacSecret()),
        storedHash
      )
    : timingSafeEqual(enteredOtp, legacyOtp);

  if (!isValid) {
    // Integer-coerced counter: a corrupt non-numeric value (console edit,
    // partial write) used to yield NaN, and NaN >= MAX is always false — the
    // lockout never engaged and guesses were unlimited.
    const priorAttempts = Number(order.deliveryOtpAttempts || 0);
    const attempts = (Number.isInteger(priorAttempts) ? priorAttempts : 0) + 1;
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
      // Dead-letter accounting: unbounded polling during a Porter outage
      // re-GETs stale orders forever. After MAX_POLLS failures (or 2h
      // staleness) the order moves to needs_review with a branch alert.
      const MAX_FAILED_POLLS = 12;
      const STALE_MS = 2 * 60 * 60 * 1000;
      const failCount = Number(order.porterPollCount || 0) + 1;
      const recordPollFailure = async (reason: string) => {
        if (failCount >= MAX_FAILED_POLLS || timeSinceUpdate >= STALE_MS) {
          await doc.ref.set(
            {
              deliveryStatus: "needs_review",
              needsRebook: true,
              porterPollCount: failCount,
              porterLastPollError: reason,
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
          const { captureErrorSnapshot } = await import("../../core/errors");
          await captureErrorSnapshot({
            source: "porter",
            severity: "high",
            message: `Porter tracking dark for order ${doc.id} (${failCount} failed polls) — needs manual review/rebook`,
            orderId: doc.id,
            branchId: order.branchId,
          });
          const branchId = order.branchId;
          if (typeof branchId === "string" && branchId) {
            try {
              const { dispatchFCM } = await import("../notifications/fcm.service");
              await dispatchFCM({
                topic: `branch_${branchId}_orders`,
                title: "Delivery tracking lost — review needed",
                body: `Order #${doc.id.substring(0, 6)} has no courier updates. Check Porter or rebook.`,
                data: { type: "porter_tracking_lost", orderId: doc.id, needsRebook: "true" },
              });
            } catch {
              // Alert best-effort; snapshot above is the durable trail.
            }
          }
        } else {
          await doc.ref.set(
            {
              porterPollCount: failCount,
              porterLastPollError: reason,
              lastPolledAt: admin.firestore.FieldValue.serverTimestamp(),
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
        }
      };
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
            // Successful poll resets the dead-letter counter.
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

            updatePayload.porterPollCount = 0;
            updatePayload.porterLastPollError = null;
            await doc.ref.set(updatePayload, { merge: true });
            updatedCount++;
          } else {
            await recordPollFailure(`Porter API HTTP ${response.status}`);
          }
        }
      } catch (err: any) {
        console.warn(`[Porter Polling Worker] Failed to poll order ${doc.id}: ${err.message}`);
        await recordPollFailure(err?.message || "poll exception").catch(() => undefined);
      }
    }
  }

  return { polledCount, updatedCount };
}
