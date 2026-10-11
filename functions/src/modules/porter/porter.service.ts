import * as crypto from "crypto";
import { db } from "../../core/firebase";
import { config } from "../../config/env";
import { extractRiderGps } from "../dispatch/dispatch.webhooks";
import {
  timingSafeEqual,
  verifyPorterWebhookSignature,
  computeHmacSha256,
  getOtpHmacSecret,
  isSafeDocId,
} from "../../core/security";
import { captureErrorSnapshot } from "../../core/errors";
import { assertOrderBranchAccess, type StaffCaller } from "../../core/middleware";
import {
  dropGpsMissingError,
  pickupGpsMissingError,
  resolvePickupCoordinates,
} from "../../core/utils/pickupCoords";
import {
  calculateHaversineDistanceKm,
  calculatePorterFare,
  estimatePickupMinutes,
} from "../../core/geo";
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

  // Fail-closed for live quotes: if GPS is missing and this is NOT an estimate,
  // throw 400. Only pre-quote estimates (isEstimate=true) may use fallback coords.
  if (!isEstimate && (!params.pickupLat || !params.pickupLng || !params.dropLat || !params.dropLng)) {
    const err: any = new Error("Live Porter quote requires pickupLat, pickupLng, dropLat, dropLng");
    err.statusCode = 400;
    throw err;
  }

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

  if (!config.mock.porterDispatch) {
    // Fail-closed: require live API key when mock is disabled
    if (!config.porter.apiKey) {
      const err: any = new Error("Porter API key not configured — cannot fetch live quote");
      err.statusCode = 503;
      throw err;
    }
    if (!config.porter.customerId) {
      const err: any = new Error("Porter Customer ID not configured — cannot fetch live quote");
      err.statusCode = 503;
      throw err;
    }
    if (!config.porter.webhookSecret) {
      const err: any = new Error("Porter webhook secret not configured — cannot verify webhooks");
      err.statusCode = 503;
      throw err;
    }

    try {
      const response = await fetch(`${config.porter.baseUrl}/v1/orders/quote`, {
              method: "POST",
              // Loop: hung gateway held the function until platform timeout.
              signal: AbortSignal.timeout(15_000),
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
      // Non-OK response from Porter API - fail closed
      const errorText = await response.text().catch(() => "");
      const err: any = new Error(`Porter API error ${response.status}: ${errorText}`);
      err.statusCode = 503;
      throw err;
    } catch (err: any) {
      // Network or timeout error - fail closed, don't fall back to rate card
      console.error("[Porter Quote] Live quote failed:", err?.message || err);
      throw err;
    }
  }

  // Mock mode enabled - return estimate with clear labeling
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
  // Numeric local-clock lease (never a serverTimestamp sentinel: it has no
  // toMillis on a fast re-read, which read as 0 and caused instant false
  // takeover — a second booking while the winner was still in-flight).
  if (typeof claimedAt === "number" && Number.isFinite(claimedAt)) return claimedAt;
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

/** Drops undefined values — Firestore rejects them inside any write payload. */
function definedFields(o: Record<string, any>): Record<string, any> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
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
  // Cross-provider guards (multi-provider dispatch layer): the generic router
  // (/dispatch/book) runs its own claim over the same order doc. A direct
  // /porter/book tap must never race it or hijack another provider's booking.
  const crossProvider = (d: any): "busy" | "conflict" | null => {
    const active = ["dispatched", "in_transit", "driver_allocated"].includes(d?.deliveryStatus);
    // Another provider owns an active dispatch (porterOrderId absent = not ours).
    if (active && d?.dispatchOrderId && !d?.porterOrderId) return "conflict";
    // The router holds a fresh generic claim — same 202 retry contract.
    if (
      d?.dispatchStatus === "dispatch_pending" &&
      Date.now() - porterClaimFreshMs(d?.dispatchClaimedAt) < PORTER_DISPATCH_CLAIM_TTL_MS
    ) {
      return "busy";
    }
    return null;
  };
  const conflictError = (d: any): Error => {
    const err: any = new Error(
      `This order is already dispatched via ${d?.dispatchProvider || "another provider"} — cancel that dispatch before booking Porter.`
    );
    err.statusCode = 409;
    err.code = "DISPATCH_EXISTS";
    return err;
  };
  const claimWrite = {
    porterDispatchStatus: "dispatch_pending",
    porterDispatchClaimedAt: Date.now(),
  };

  if (db && typeof (db as any).runTransaction === "function") {
    const outcome: any = await (db as any).runTransaction(async (tx: any) => {
      const fresh = await tx.get(orderDoc.ref);
      const d = (fresh.exists ? fresh.data() : undefined) as any;
      if (!d) return { claimed: true };
      if (isDispatched(d)) return { reuse: true, data: d };
      const cross = crossProvider(d);
      if (cross === "conflict") return { conflict: true, data: d };
      if (cross === "busy") return { busy: true };
      // Another tap owns the booking right now — never POST ours. Stale
      // claims (>10 min, owner crashed) are taken over below.
      if (isFreshPending(d)) return { busy: true };
      tx.set(orderDoc.ref, claimWrite, { merge: true });
      return { claimed: true };
    });
    if (outcome?.reuse) return storedDispatchSummary(outcome.data);
    if (outcome?.conflict) throw conflictError(outcome.data);
    if (outcome?.busy) throw dispatchInProgressError();
    return null;
  }

  // Fallback for Firestore shims without transactions (tests): same rules on
  // the already-read order. Concurrent taps are serialized by the caller's
  // per-order pending UI state (partner H-M8 fix); this is the last guard.
  if (isDispatched(order)) return storedDispatchSummary(order);
  const cross = crossProvider(order);
  if (cross === "conflict") throw conflictError(order);
  if (cross === "busy") throw dispatchInProgressError();
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
  opts?: { idempotencyKey?: string; preclaimed?: boolean }
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
  const drop = order.deliveryAddress || order.address;
  if (orderType === "delivery" && !(drop?.street || drop?.full || (drop?.lat && drop?.lng))) {
    throw new Error("Delivery address is incomplete — add street or map pin, then retry dispatch.");
  }
  // Fail-closed GPS (B2-S1, H-R19): a textual address without coordinates must
  // never dispatch a rider to fallback defaults — the courier would drive to
  // the wrong pin on a paid booking. Pin the address first (422, retryable).
  // Unconditional (parity with the dispatch router): NO order type dispatches
  // against a fabricated drop pin.
  if (!(drop?.lat && drop?.lng)) throw dropGpsMissingError();
  // Fail-closed PICKUP GPS (H-R19 parity): never book a courier to a default
  // store pin. Real coordinates only: order.branchCoordinates (snapshot) →
  // order.store → branches/{branchId}.coordinates (the canonical branch doc).
  const pickupCoords = await resolvePickupCoordinates(order);
  if (!pickupCoords) throw pickupGpsMissingError();

  // Per-order idempotency gate: replay + pending claim live here (before any
  // external POST) so neither the mock path nor the live path can double-book.
  // preclaimed = the multi-provider router already holds its own generic claim
  // and its guards — claiming again here would self-conflict (202).
  if (!opts?.preclaimed) {
    const reuse = await claimPorterDispatch(orderDoc, order);
    if (reuse) return reuse;
  }

  const pickupLat = pickupCoords.lat;
  const pickupLng = pickupCoords.lng;
  const dropLat = drop.lat;
  const dropLng = drop.lng;

  // Every coordinate above is real GPS — no fallback source can exist here.
  const dispatchGeoSource = "live_gps";

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
            apartment_address: drop?.house || drop?.flat || drop?.line1 || "",
            street_address1:
              drop?.street ||
              drop?.full ||
              drop?.line2 ||
              drop?.landmark ||
              "Customer Delivery Address",
            city: drop?.city || "Ahmedabad",
            state: drop?.state || "Gujarat",
            pincode: drop?.pincode || "380015",
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
              // Loop: hung gateway held the function until platform timeout.
              signal: AbortSignal.timeout(15_000),
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
      // `order.delivery` mirror (customer tracking contract): the customer map
      // reads this path for rider identity + live GPS + tracking link. Real
      // values only, and a NEW booking clears the previous rider's stale GPS.
      delivery: definedFields({
        ...(order.delivery && typeof order.delivery === "object" ? order.delivery : {}),
        provider: "porter",
        providerOrderId: String(dispatchResult.porterOrderId),
        status: dispatchResult.riderName ? "rider_assigned" : "pending",
        riderName: dispatchResult.riderName ?? null,
        riderPhone: dispatchResult.riderPhone ?? null,
        riderVehicleNumber: dispatchResult.riderVehicleNumber ?? null,
        trackingUrl: dispatchResult.trackingUrl || null,
        riderLocation: null,
        riderLocationAt: null,
        assignedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }),
      // A live booking settles any pending rebook request — otherwise the
      // auto-rebook worker would re-dispatch this order with a SECOND carrier
      // (double rider) on its next sweep. Mirrors dispatchBook's book write.
      needsRebook: false,
      rebookTrigger: null,
      autoRebookAttempts: 0,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  // Server orderId mapping (B4-S1): bind the server-issued porterOrderId to
  // our orderId so the webhook resolves through this map instead of trusting
  // the echoed request_id. Best-effort — a map-write failure must never fail
  // a dispatch that already succeeded.
  try {
    await db
      .collection("porter_order_map")
      .doc(String(dispatchResult.porterOrderId))
      .set(
        {
          orderId,
          branchId: order.branchId || null,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
  } catch (mapErr: any) {
    console.warn("[Porter] order-map write failed (non-blocking):", mapErr?.message || mapErr);
  }

  return dispatchResult;
}

/**
 * Staff-initiated cancellation of a Porter booking. HONESTY CONTRACT: Porter
 * (porter.in enterprise) publishes no documented cancel endpoint — the
 * runbook's verify-live list confirms only quote/book shapes. This function
 * therefore NEVER claims a provider-side cancellation. It releases the order
 * locally (rider_cancelled + needsRebook so the rebook/in-house flows take
 * over) and marks porterProviderCancel:"manual-required" so staff confirm
 * the cancellation in the Porter enterprise dashboard. A blind POST to an
 * unconfirmed endpoint would be fake traffic.
 *
 * Refuses when no active Porter booking exists (409 NOTHING_TO_CANCEL).
 */
export async function cancelPorterBooking(
  orderId: string,
  staffName?: string,
  caller?: StaffCaller
): Promise<{ success: boolean; orderId: string; providerCancel: string; message: string }> {
  const orderDoc = await db.collection("orders").doc(orderId).get();
  if (!orderDoc.exists) {
    const missing: any = new Error(`Order ${orderId} not found`);
    missing.statusCode = 404;
    missing.code = "ORDER_NOT_FOUND";
    throw missing;
  }

  const order = orderDoc.data()!;
  if (caller) await assertOrderBranchAccess(caller, order);

  const deliveryStatus = (order as any).deliveryStatus as string | undefined;
  const porterOrderId = (order as any).porterOrderId as string | undefined;
  const active =
    !!porterOrderId &&
    (deliveryStatus === "dispatched" ||
      deliveryStatus === "in_transit" ||
      deliveryStatus === "driver_allocated");
  if (!active) {
    const nothing: any = new Error("No active Porter booking to cancel for this order.");
    nothing.statusCode = 409;
    nothing.code = "NOTHING_TO_CANCEL";
    throw nothing;
  }

  await orderDoc.ref.set(
    {
      deliveryStatus: "rider_cancelled",
      porterDispatchStatus: "cancelled_by_store",
      porterProviderCancel: "manual-required",
      needsRebook: true,
      // Staff-initiated cancel: stomp any stale `carrier_cancelled` trigger so
      // the auto-rebook worker never re-dispatches a cancel the staff chose.
      rebookTrigger: "staff_cancelled",
      riderCancellationReason: `Booking cancelled by ${staffName || "Branch Staff"} — confirm cancellation in the Porter dashboard`,
      cancelledBy: staffName || "Branch Staff",
      cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  return {
    success: true,
    orderId,
    providerCancel: "manual-required",
    message:
      "Local booking released. Confirm the cancellation in the Porter enterprise dashboard — no provider cancel API is documented.",
  };
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
 * Freshness window for Porter webhook events (B4-S1): a stale retry arriving
 * >15 min late must never flip a newer state backwards (e.g. a retried
 * IN_TRANSIT overwriting DELIVERED). Events carrying no timestamp are
 * accepted — Porter does not guarantee one — and ordered by arrival.
 */
export const PORTER_WEBHOOK_FRESHNESS_MS = 15 * 60 * 1000;
const PORTER_WEBHOOK_FUTURE_SKEW_MS = 5 * 60 * 1000;

function porterEventTimestampMs(payload: any): number | null {
  const raw =
    payload?.timestamp ?? payload?.event_time ?? payload?.eventTime ?? payload?.created_at ?? null;
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "number") {
    return raw < 1e12 ? raw * 1000 : raw;
  }
  const ms = Date.parse(String(raw));
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Handles Porter Webhook driver lifecycle events with HMAC validation and normalized events.
 *
 * B4-S1 bridge hardening (quote/book semantics untouched):
 * - event-id dedup: the deterministic parkId (event + order refs + body hash)
 *   doubles as the processed-event id. A redelivered webhook merges into the
 *   same `porter_webhook_events` doc and is skipped — never applied twice.
 * - server orderId mapping: the echoed `request_id` is a hint only. When the
 *   resolved order already carries a server-issued porterOrderId that differs
 *   from the webhook's, the event is parked (no blind flip to a wrong order).
 * - freshness: stale timestamped events park instead of rewinding state.
 * - unknown events park instead of touching the order (no blind merge-flip).
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

  // Event-id dedup: same redelivered webhook → same processed-event doc.
  // Status-gated (not exists-gated) so datastores that materialize missing
  // docs still proceed on first delivery and skip on true redelivery.
  try {
    const seenSnap = await db.collection("porter_webhook_events").doc(parkId).get();
    if (seenSnap.data?.()?.status === "processed") {
      console.log(`[Porter Webhook] Duplicate ${rawEvent} delivery skipped (${parkId})`);
      return;
    }
  } catch (err: any) {
    // Fail-closed: a failed dedup read must not drop a live event.
    // Log and rethrow so the webhook returns 500 and Porter retries.
    console.error(`[Porter Webhook] Dedup read failed for ${parkId}:`, err?.message || err);
    throw new Error(`Dedup read failed: ${err?.message || err}`);
  }
  const markProcessed = async () => {
    try {
      await db.collection("porter_webhook_events").doc(parkId).set(
        {
          rawEvent: rawEvent || null,
          orderId: orderId || null,
          porterOrderId: porterOrderId || null,
          status: "processed",
          receivedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    } catch {
      // Best-effort: the order write below is the durable trail.
    }
  };

  // Freshness: a stale timestamped retry must not rewind newer state.
  const eventTs = porterEventTimestampMs(payload);
  if (eventTs !== null) {
    const skew = Date.now() - eventTs;
    if (skew > PORTER_WEBHOOK_FRESHNESS_MS || skew < -PORTER_WEBHOOK_FUTURE_SKEW_MS) {
      console.warn(`[Porter Webhook] Stale event ${rawEvent} parked (skew ${Math.round(skew / 1000)}s)`);
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
              reason: "stale_event",
              receivedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
        await captureErrorSnapshot({
          source: "porter",
          severity: "medium",
          message: `Stale Porter event ${rawEvent || "unknown"} parked for review (no state rewind)`,
        });
      } catch (err) {
        console.warn("[Porter Webhook] Failed to park stale event:", (err as any)?.message || err);
      }
      return;
    }
  }

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
      console.warn("[Porter Webhook] Failed to park event with no order reference:", (err as any)?.message || err);
    }
    await markProcessed();
    return;
  }

  // Locate order — server mapping first, echoed hint second. `request_id`
  // is Porter echoing OUR value back, so it is a hint, not proof. The
  // server-side `porter_order_map` (written at book time, both mock and live
  // paths) binds each server-issued porterOrderId to exactly one orderId. A
  // webhook whose hint points at a DIFFERENT order than the map is parked —
  // applying it would flip the wrong order's state.
  const parkMismatch = async (mappedOrderId: string) => {
    console.warn(
      `[Porter Webhook] request_id/order_id conflict parked: map says ${mappedOrderId}, hint says ${orderId}`
    );
    try {
      await db
        .collection("unmatched_porter_events")
        .doc(parkId)
        .set(
          {
            orderId: orderId || null,
            porterOrderId: porterOrderId || null,
            mappedOrderId,
            rawEvent: rawEvent || null,
            status: "needs_review",
            reason: "order_id_conflict",
            receivedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
      await captureErrorSnapshot({
        source: "porter",
        severity: "high",
        message: `Porter webhook order-id conflict parked (hint ${orderId} vs mapped ${mappedOrderId}) — no state flipped`,
      });
    } catch (err) {
      console.warn("[Porter Webhook] Failed to park conflicted event:", err);
    }
    await markProcessed();
  };

  let orderRef: admin.firestore.DocumentReference | null = null;
  if (porterOrderId) {
    try {
      const mapSnap = await db.collection("porter_order_map").doc(String(porterOrderId)).get();
      const mapped = mapSnap.data?.();
      const mappedOrderId =
        mapped && typeof mapped.orderId === "string" && mapped.orderId ? mapped.orderId : null;
      if (mappedOrderId) {
        if (orderId && orderId !== mappedOrderId) {
          await parkMismatch(mappedOrderId);
          return;
        }
        orderRef = db.collection("orders").doc(mappedOrderId);
      }
    } catch (err: any) {
      // Fail-closed: map read failure must not silently fall through to hint/query paths
      // which could match the wrong order. Log and rethrow.
      console.error(`[Porter Webhook] Map read failed for porterOrderId=${porterOrderId}:`, err?.message || err);
      throw new Error(`Map read failed: ${err?.message || err}`);
    }
  }
  if (!orderRef) {
    if (orderId) {
      // Fail-closed id shape: the echoed request_id hint is attacker-
      // adjacent input — slashes/empties would throw or path-escape at
      // doc() time. Park visibly instead of 500-retrying.
      if (!isSafeDocId(orderId)) {
        console.warn("[Porter Webhook] unsafe order hint parked:", JSON.stringify(orderId).slice(0, 80));
        try {
          await db
            .collection("unmatched_porter_events")
            .doc(parkId)
            .set(
              {
                porterOrderId: porterOrderId || null,
                rawEvent: rawEvent || null,
                status: "needs_review",
                reason: "unsafe_order_id",
                receivedAt: admin.firestore.FieldValue.serverTimestamp(),
              },
              { merge: true }
            );
        } catch {
          /* parking is best-effort; the warn above is the trail */
        }
        await markProcessed();
        return;
      }
      orderRef = db.collection("orders").doc(orderId);
    } else {
      const q = await db.collection("orders").where("porterOrderId", "==", porterOrderId).limit(1).get();
      if (!q.empty) {
        orderRef = q.docs[0].ref;
      }
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
    await markProcessed();
    return;
  }

  const driverDetails = payload.driver_details || payload.driver || payload.rider || {};

  // Unknown events park — never blind merge-flip an order on an event we do
  // not understand (a renamed upstream event used to write a bare
  // porterWebhookEvent touch, masking the gap).
  const KNOWN_PORTER_EVENTS = new Set([
    "DRIVER_ALLOCATED",
    "ARRIVED_AT_PICKUP",
    "STARTED_DELIVERY",
    "DELIVERED",
    "RIDER_CANCELLED",
    "NO_RIDERS_FOUND",
  ]);
  if (!KNOWN_PORTER_EVENTS.has(event)) {
    console.warn(`[Porter Webhook] Unknown event parked: ${rawEvent}`);
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
            reason: "unknown_event",
            receivedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
      await captureErrorSnapshot({
        source: "porter",
        severity: "medium",
        message: `Unknown Porter event ${rawEvent || "unknown"} parked for review — order untouched`,
      });
    } catch (err) {
      console.warn("[Porter Webhook] Failed to park unknown event:", err);
    }
    await markProcessed();
    return;
  }

  // ONE pre-write order read: it feeds the terminal guard AND the
  // `order.delivery` mirror merge base below.
  let currentOrder: Record<string, any> = {};
  try {
    const current = await orderRef.get();
    currentOrder = (current.data() || {}) as Record<string, any>;
  } catch (err: any) {
    // Fail closed: if we cannot prove the order is not yet delivered, skip
    // the flip rather than risk rewinding DELIVERED state.
    console.error(`[Porter Webhook] pre-write order read failed:`, err?.message || err);
    throw new Error(`Pre-write order read failed: ${err?.message || err}`);
  }

  // Terminal-state guard: after `delivered`, every event except DELIVERED
  // itself is ignored. Provider retries replay courier updates out of order
  // inside the freshness window — a late CANCELLED/IN_TRANSIT would otherwise
  // resurrect a DELIVERED order (and pay for a second rider).
  if (event !== "DELIVERED" && currentOrder.deliveryStatus === "delivered") {
    console.log(`[Porter Webhook] Late ${rawEvent} after delivery ignored (no rewind)`);
    await markProcessed();
    return;
  }

  // `order.delivery` sub-object mirror — the customer tracking map reads
  // exactly this path for rider identity, live GPS and the tracking link.
  // Always built from the PRE-WRITE snapshot + this event's fields, so every
  // write is a complete snapshot (Firestore deep merge and the shallow-merge
  // test shims converge; a field an earlier event wrote is never dropped).
  const deliveryMirror = (patch: Record<string, any>): Record<string, any> =>
    definedFields({
      ...(currentOrder.delivery && typeof currentOrder.delivery === "object"
        ? currentOrder.delivery
        : {}),
      provider: currentOrder.dispatchProvider || "porter",
      providerOrderId:
        currentOrder.porterOrderId != null
          ? String(currentOrder.porterOrderId)
          : porterOrderId != null
          ? String(porterOrderId)
          : undefined,
      ...patch,
    });

  // Real rider GPS only — a callback without a genuine courier position
  // leaves the mirror untouched (customer map hides the pin, never fakes one).
  const riderGps = extractRiderGps(payload);
  // A courier that already left the store must never be rewound to "rider
  // assigned" by a late/out-of-order ALLOTTED retry.
  const alreadyMoving =
    currentOrder.deliveryStatus === "in_transit" ||
    currentOrder.deliveryStatus === "delivered";

  const firstNonEmpty = (...candidates: any[]): string | undefined =>
    candidates.find((c) => typeof c === "string" && c.trim());

  const updateData: Record<string, any> = {
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    porterWebhookEvent: rawEvent,
  };

  switch (event) {
    case "DRIVER_ALLOCATED": {
      const riderName = firstNonEmpty(
        driverDetails.name,
        payload.driver_name,
        payload.rider_name
      );
      const riderPhone = firstNonEmpty(
        driverDetails.phone,
        payload.driver_phone,
        payload.rider_contact,
        payload.rider_phone
      );
      const riderVehicleNumber = firstNonEmpty(
        driverDetails.vehicle_number,
        payload.driver_vehicle_number,
        payload.rider_vehicle_number
      );
      const trackingUrl = firstNonEmpty(
        payload.tracking_url,
        payload.tracking_link,
        payload.track_url
      );
      // Only fields actually present are written — an `undefined` Firestore
      // value rejects the whole write (the webhook would 500-loop forever).
      if (riderName) updateData.riderName = riderName;
      if (riderPhone) updateData.riderPhone = riderPhone;
      if (riderVehicleNumber) updateData.riderVehicleNumber = riderVehicleNumber;
      if (trackingUrl) updateData.riderTrackingUrl = trackingUrl;
      const mirrorPatch: Record<string, any> = {
        riderName,
        riderPhone,
        riderVehicleNumber,
        trackingUrl,
      };
      if (!alreadyMoving) {
        updateData.deliveryStatus = "dispatched";
        mirrorPatch.status = "rider_assigned";
        mirrorPatch.assignedAt = admin.firestore.FieldValue.serverTimestamp();
      }
      updateData.delivery = deliveryMirror(mirrorPatch);
      break;
    }

    case "ARRIVED_AT_PICKUP":
      updateData.riderArrivedAtStore = true;
      updateData.riderArrivedAt = admin.firestore.FieldValue.serverTimestamp();
      updateData.delivery = deliveryMirror({
        status: "at_pickup",
        riderArrivedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
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
      updateData.delivery = deliveryMirror({ status: "in_transit" });
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
      updateData.delivery = deliveryMirror({
        status: "delivered",
        deliveredAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      break;

    case "RIDER_CANCELLED":
    case "NO_RIDERS_FOUND": {
      // Canonical status flip (not just sidecar deliveryStatus): the old code
      // left status.code frozen, so both apps kept showing OUT_FOR_DELIVERY
      // and the status-change trigger (customer push) never fired. Core
      // renders the server label verbatim; partner maps RIDER_CANCELLED into
      // the actionable dispatch bucket (see orderContract).
      const reason = firstNonEmpty(payload.reason, payload.reason_text) || "Driver cancelled dispatch";
      updateData.status = {
        code: "RIDER_CANCELLED",
        label: "Rider cancelled — rebook required",
        kind: "in_progress",
        terminal: false,
      };
      updateData.deliveryStatus = "rider_cancelled";
      updateData.needsRebook = true;
      // Auto-rebook trigger (mission §3): the scheduled worker re-dispatches
      // this order with the NEXT provider, never the one that cancelled —
      // without this stamp a Porter cancel was never auto-rebooked at all.
      updateData.rebookTrigger = "carrier_cancelled";
      updateData.riderCancellationReason = reason;
      updateData.delivery = deliveryMirror({
        status: "rider_cancelled",
        riderCancellationReason: reason,
      });
      break;
    }
  }

  // Live rider coordinates ride every callback that actually carries them.
  if (riderGps) {
    updateData.delivery = {
      ...(updateData.delivery || deliveryMirror({})),
      riderLocation: riderGps,
      riderLocationAt: admin.firestore.FieldValue.serverTimestamp(),
    };
  }

  await orderRef.set(updateData, { merge: true });
  await markProcessed();

  // Branch alert: without it nobody knows to hit /porter/rebook and the
  // order rots. Customer push rides the existing status-change trigger.
  if (event === "RIDER_CANCELLED" || event === "NO_RIDERS_FOUND") {
    try {
      const branchId = currentOrder.branchId;
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
    // An in-house rider settles any pending auto-rebook: leaving needsRebook
    // set would make the worker book a 3PL rider ALONGSIDE this one (double
    // rider on one order).
    needsRebook: false,
    rebookTrigger: null,
    autoRebookAttempts: 0,
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

  // Stale-only fan-out: orders with fresh webhook updates are skipped without
  // any fetch (M31 cost discipline preserved from the serial version).
  const staleDocs = (activeOrdersSnap.docs || []).filter((doc: any) => {
    const order = doc.data();
    if (!order?.porterOrderId) return false;
    const lastUpdated = order.updatedAt?.toMillis ? order.updatedAt.toMillis() : 0;
    return now - lastUpdated >= FIFTEEN_MINUTES_MS;
  });

  // Skip empty ticks: nothing stale → no fetches, no writes.
  if (staleDocs.length === 0) {
    return { polledCount, updatedCount };
  }

  const pollOne = async (doc: any): Promise<"updated" | "polled"> => {
    const order = doc.data();
    const porterOrderId = order.porterOrderId;
    const lastUpdated = order.updatedAt?.toMillis ? order.updatedAt.toMillis() : 0;
    const timeSinceUpdate = now - lastUpdated;

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
          return "updated";
        }
        return "polled";
      } else if (config.porter.apiKey) {
        const response = await fetch(`${config.porter.baseUrl}/v1/orders/${porterOrderId}`, {
        // Loop: hung gateway held the function until platform timeout.
        signal: AbortSignal.timeout(15_000),
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
          return "updated";
        } else {
          await recordPollFailure(`Porter API HTTP ${response.status}`);
          return "polled";
        }
      }
      return "polled";
    } catch (err: any) {
      console.warn(`[Porter Polling Worker] Failed to poll order ${doc.id}: ${err.message}`);
      await recordPollFailure(err?.message || "poll exception");
      // Re-throw so Promise.allSettled captures the failure properly
      throw err;
    }
  };

  // Concurrent fetch (B4-S1, M32): the serial loop did up to 25 blocking
  // GETs per 5-min tick — one slow Porter response stalled the rest. Bounded
  // chunks of 5 keep latency flat without hammering the courier API. One bad
  // order still never aborts the rest (allSettled per chunk).
  const POLL_CHUNK_SIZE = 5;
  for (let i = 0; i < staleDocs.length; i += POLL_CHUNK_SIZE) {
    const chunk = staleDocs.slice(i, i + POLL_CHUNK_SIZE);
    const results = await Promise.allSettled(chunk.map((doc: any) => pollOne(doc)));
    for (const res of results) {
      if (res.status === "fulfilled") {
        polledCount++;
        if (res.value === "updated") updatedCount++;
      } else {
        polledCount++;
        console.warn("[Porter Polling Worker] chunk item threw, continuing batch:", res.reason);
      }
    }
  }

  return { polledCount, updatedCount };
}
