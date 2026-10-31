import * as crypto from "crypto";
import * as admin from "firebase-admin";
import { config } from "../../config/env";
import { captureErrorSnapshot } from "../../core/errors";
import { computeHmacSha256, isSafeDocId, timingSafeEqual } from "../../core/security";
import { db } from "../../core/firebase";
import { dispatchFCM } from "../notifications/fcm.service";

/**
 * Borzo / Shadowfax webhook intake (DR10).
 *
 * Porter's webhook lives in porter.service.ts and is untouched — this file
 * mirrors its fail-closed shape for the other two providers:
 *   1. Signature verify (empty secret denies; no mock bypass). Borzo sends
 *      HMAC-SHA256 in X-DV-Signature (Callback Secret Key, doc-confirmed);
 *      Shadowfax has NO native HMAC — the configured secret is accepted as a
 *      static shared value in x-shadowfax-signature (custom header arranged
 *      with the Shadowfax team), with HMAC accepted as an alternative form.
 *   2. Provider-aware payload extraction (real doc shapes): Borzo wraps
 *      `{event_type, event_datetime, order|delivery:{status, order_id,
 *      client_order_id, courier}}`, Shadowfax sends
 *      `{order_status, sfx_order_id, client_order_id, rider_*}`; generic
 *      `event`/`order_id` payloads keep working for tests/legacy.
 *   3. Event normalization → canonical lifecycle events; known-but-inert
 *      lifecycle noise (Borzo order `new`/`available`/…) marks processed
 *      silently; a documented-but-unmapped return/reattempt status is recorded
 *      for review WITHOUT an error snapshot; unknown parks.
 *   4. Deterministic dedup + freshness gate. Only `processed` dedups — a
 *      PARKED event stays re-attemptable on provider redelivery. To make that
 *      real on the wire, the race class (a provider order with no binding yet)
 *      answers non-2XX via DispatchWebhookRetryRequested so the vendor's own
 *      retry schedule keeps running; terminal parks still answer 2XX.
 *   5. Order resolution via dispatch_order_map FIRST, hint only when the
 *      order's own dispatchOrderId confirms it (conflict AND an unbound order
 *      → park, never guess).
 *      5b. Pre-mutation OWNERSHIP proof: the resolved order's CURRENT binding
 *      (dispatchProvider + dispatchOrderId, rewritten by every book/rebook)
 *      must match the callback — a superseded rebook binding (the stale map
 *      entry), a foreign provider, or binding-less metadata parks HIGH before
 *      any order/rider/status/rebook field is written.
 *   6. Late non-terminal events after a terminal delivery status
 *      (`delivered`/`cancelled` — same set dispatchBook locks) are ignored.
 *   6b. Cancel containment: customer-cancel / returned-parcel causes are
 *      manual-review outcomes on the existing `needs_review` dispatch state
 *      (needsRebook=false, cause in rebookTrigger/reason; order.status is
 *      NOT written) and the containment is STICKY — a later carrier cancel
 *      or arrival on the same booking cannot unwed it onto the auto-rebook
 *      flow. The cause comes from the canonical event name AND the vendor's
 *      free-text cancellation reason (Borzo `reason_text` /
 *      `status_description`): an unclassifiable reason is ALSO manual review
 *      (`rebookTrigger: "cancellation_unverified"`), never an automatic
 *      rebook. Ordinary carrier cancels keep rider_cancelled + needsRebook.
 *   7. Canonical field switch (duplicated from porter — deliberate: do NOT
 *      refactor porter's webhook, its tests must stay green).
 */

export type DispatchWebhookProvider = "borzo" | "shadowfax";

/**
 * "Parked, but ask the provider to retry."
 *
 * Thrown AFTER the event is parked, for the one park class that a retry can
 * still resolve: an event that names a real provider order with no binding yet
 * (the callback raced our `dispatch_order_map` write, which happens after the
 * provider's book response). Evidence: Borzo's Integration doc retries a
 * callback with increasing intervals for 24h until it receives a 2XX — so
 * returning 200 on a race would silently END the retry schedule and leave the
 * order stuck until a human reads the review row. A non-2XX keeps the vendor's
 * own retry loop alive, and parked events are re-attemptable by design (only
 * `processed` dedups).
 *
 * Deliberately NOT thrown for terminal parks (id conflict, unsafe hint, unknown
 * event, no reference at all): retrying cannot change those, and 24h of retries
 * would be noise. This is a plain Error with a statusCode, so index.ts's
 * existing error path maps it without a handler change.
 */
export class DispatchWebhookRetryRequested extends Error {
  statusCode: number;
  code: string;
  constructor(message: string) {
    super(message);
    this.name = "DispatchWebhookRetryRequested";
    this.statusCode = 503;
    this.code = "DISPATCH_WEBHOOK_RETRY";
  }
}

const DISPATCH_WEBHOOK_FRESHNESS_MS = 15 * 60 * 1000;
const DISPATCH_WEBHOOK_FUTURE_SKEW_MS = 5 * 60 * 1000;

/**
 * Terminal delivery states — identical to dispatchBook's own locked set
 * (`dispatch.router.ts:assertDispatchNotLocked`). A late callback must not
 * rewind EITHER state: a `cancelled` order is as final as a `delivered` one,
 * otherwise a late `courier_assigned` resurrects it as `dispatched` (finding 10).
 */
const TERMINAL_DELIVERY_STATUSES: readonly string[] = ["delivered", "cancelled"];

function terminalDeliveryStatus(d: any): string | null {
  const ds = d?.deliveryStatus;
  if (ds === "delivered" || ds === "cancelled") return ds;
  if (d?.status?.terminal === true || d?.status?.kind === "completed") return "completed";
  return null;
}

/**
 * Normalizes a provider order id for binding comparison. Borzo ids arrive as
 * JSON numbers, stored bindings may be numbers or (padded/legacy) strings —
 * `12`, `"12"` and `"0012"` are the same booking. String ids keep their exact
 * case (Shadowfax ids are case-sensitive); only pure-digit forms normalize.
 */
function normalizeProviderOrderId(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = typeof value === "string" ? value.trim() : String(value);
  if (!s) return null;
  // DS final-review: strip leading padding WITHOUT Number() — digit strings
  // beyond ~15 chars lose precision through float conversion and could make
  // two distinct ids compare equal. A regex strip keeps big ids exact.
  return /^\d+$/.test(s) ? s.replace(/^0+(?=\d)/, "") : s;
}

/**
 * True once the ACTIVE booking is already parked for manual review after a
 * customer-cancel / returned parcel / unverifiable cancel cause (F6/F12
 * containment). `needs_review` is the existing dispatch state for that outcome;
 * the rebookTrigger cause strings are the belt-and-suspenders half. dispatchBook
 * resets BOTH on every successful rebook (deliveryStatus "dispatched",
 * rebookTrigger null), so containment is per-booking and releases exactly when
 * staff re-dispatch — a fresh carrier cancel on the new booking still
 * auto-rebooks like before.
 */
function isContainedManualReview(order: Record<string, any>): boolean {
  if (order?.deliveryStatus === "needs_review") return true;
  return (
    order?.rebookTrigger === "customer_cancelled" ||
    order?.rebookTrigger === "returned_to_seller" ||
    order?.rebookTrigger === "cancellation_unverified"
  );
}

function webhookSecretFor(provider: DispatchWebhookProvider): string {
  return provider === "borzo" ? config.borzo.webhookSecret : config.shadowfax.webhookSecret;
}

/**
 * F12 (stress sweep 2026-10-24): the vendor's cancellation CAUSE.
 *
 * Borzo/Delivery carries a documented free-text `reason_text` (and
 * `status_description`) describing why the delivery was cancelled; the umbrella
 * `delivery.status: "canceled"` alone says nothing about WHO cancelled. Before
 * this classifier every generic cancel became `carrier_cancelled` with
 * `needsRebook: true`, so the scheduled worker bought a fresh rider for
 * deliveries the customer had already called off.
 *
 * Customer/client cancellations and returned parcels are manual-review
 * outcomes (needsRebook=false) exactly like their canonical event names. A
 * reason we cannot classify is ALSO not safe to auto-rebook — the worker only
 * buys a rider on an explicit carrier-side cause; anything else asks staff to
 * look first.
 */
type CancelCause = "carrier" | "customer" | "returned" | "unverified";

/** Case/space-insensitive cancellation text from either callback envelope. */
function cancelReasonText(payload: any): string {
  const candidates: any[] = [
    payload?.reason_text,
    payload?.cancel_reason_text,
    payload?.delivery?.reason_text,
    payload?.delivery?.cancel_reason_text,
    payload?.delivery?.status_description,
    payload?.order?.reason_text,
    payload?.order?.status_description,
    typeof payload?.reason === "string" ? payload.reason : undefined,
    payload?.status_description,
  ];
  const found = candidates.find((c) => typeof c === "string" && c.trim());
  return found ? String(found).trim().slice(0, 300) : "";
}

/** Reason-text signals. Order matters: customer/returned win over carrier. */
const CUSTOMER_CANCEL_TEXT = /\b(customer|client|buyer|consumer)\b/i;
const RETURNED_TEXT = /\b(return(ed|ing)?|rts)\b/i;
const SELLER_TEXT = /\b(seller|store|merchant|restaurant|vendor|branch)\b/i;
const CARRIER_CANCEL_TEXT =
  /\b(no riders?|no couriers?|no drivers?|no captains?|no partners?)\b|\b(rider|courier|driver|captain|partner|delivery)\b.{0,40}\b(too busy|busy|unavailable|not available|cancell?ed|cancel|rejected|dropped|did not|didn'?t|refused|no show|no-show|absent)\b|\bunfulfillable\b|\bunable to (deliver|fulfil|fulfill)\b|\bdelivery (failed|unavailable|not possible)\b|\bout of (coverage|range)\b|\bnot serviceable\b|\b(rejected|refused)\b/i;

export function classifyCancelCause(rawEvent: string, reasonText: string): CancelCause {
  const key = normalizeEventKey(rawEvent);
  if (key === "CANCELLED_BY_CUSTOMER") return "customer";
  if (key === "RETURNED_TO_SELLER") return "returned";
  // Shadowfax's documented no-riders status is explicitly a carrier fault.
  if (key === "NO_RIDERS_FOUND") return "carrier";
  if (reasonText) {
    const text = reasonText.replace(/[\s_-]+/g, " ");
    const mentionsCancel = /cancel|refus|rts|return/i.test(text);
    if (CUSTOMER_CANCEL_TEXT.test(text) && (mentionsCancel || /no.?show/i.test(text))) {
      return "customer";
    }
    if (RETURNED_TEXT.test(text) && SELLER_TEXT.test(text)) return "returned";
    if (RETURNED_TEXT.test(text) && mentionsCancel) return "returned";
    if (CARRIER_CANCEL_TEXT.test(text)) return "carrier";
  }
  return "unverified";
}

/**
 * Fail-closed signature check: empty/missing secret always denies (401).
 * Borzo: HMAC-SHA256(rawBody, Callback Secret Key) in `X-DV-Signature`
 * (doc-confirmed); bare hex or `sha256=<hex>` prefix accepted. Shadowfax has
 * no native HMAC — their callbacks carry a custom header we ask the team to
 * configure with SHADOWFAX_WEBHOOK_SECRET as a static shared value; a plain
 * HMAC over the body is also accepted so either contract verifies.
 */
export function verifyDispatchWebhookSignature(
  provider: DispatchWebhookProvider,
  rawBody: string,
  signature: string
): boolean {
  const secret = webhookSecretFor(provider);
  if (!rawBody || !signature || !secret) return false;
  if (provider === "shadowfax" && timingSafeEqual(secret, signature.trim())) {
    return true;
  }
  // The vendor doc specifies "a HMAC hash using SHA256 and Callback Secret Key"
  // but NOT the encoding of the header value. Our verifier historically used
  // hex only, so a base64-sending Borzo would 401 forever and the status leg
  // would silently die (their retry ladder gives up after 24h). Accept both
  // standard forms of the SAME digest plus the common `sha256=` prefix.
  // This is not an auth weakening: every accepted form must equal
  // HMAC-SHA256(rawBody, secret), which nobody without the secret can produce.
  const trimmed = signature.trim();
  const prefixed = /^sha256=/i.exec(trimmed);
  const bare = prefixed ? trimmed.slice(prefixed[0].length) : trimmed;
  const expectedHex = computeHmacSha256(rawBody, secret);
  const expectedBase64 = Buffer.from(expectedHex, "hex").toString("base64");
  // Hex is case-insensitive; normalise only when it really looks like hex.
  const hexCandidate = /^[0-9a-fA-F]+$/.test(bare) ? bare.toLowerCase() : bare;
  return (
    timingSafeEqual(expectedHex, hexCandidate) ||
    timingSafeEqual(expectedBase64, bare)
  );
}

const EVENT_ALIASES: Record<string, string> = {
  DRIVER_ALLOCATED: "DRIVER_ALLOCATED",
  RIDER_ASSIGNED: "DRIVER_ALLOCATED",
  DRIVER_ASSIGNED: "DRIVER_ALLOCATED",
  ORDER_ACCEPTED: "DRIVER_ALLOCATED",
  ACCEPTED: "DRIVER_ALLOCATED",
  CONFIRMED: "DRIVER_ALLOCATED",
  ARRIVED_AT_PICKUP: "ARRIVED_AT_PICKUP",
  AT_PICKUP: "ARRIVED_AT_PICKUP",
  // Parcel in the courier's hands = the order LEFT the store → OUT_FOR_DELIVERY
  // (mission §3: picked_up → OUT_FOR_DELIVERY; matches Porter's own
  // normalizePorterEvent and Borzo's PARCEL_PICKED_UP mapping below). The
  // "rider is standing at the store" stage is ARRIVED_AT_PICKUP / AT_PICKUP.
  PICKED_UP: "STARTED_DELIVERY",
  ORDER_PICKED_UP: "STARTED_DELIVERY",
  STARTED_DELIVERY: "STARTED_DELIVERY",
  OUT_FOR_DELIVERY: "STARTED_DELIVERY",
  DELIVERY_STARTED: "STARTED_DELIVERY",
  IN_TRANSIT: "STARTED_DELIVERY",
  DELIVERED: "DELIVERED",
  ORDER_DELIVERED: "DELIVERED",
  COMPLETED: "DELIVERED",
  RIDER_CANCELLED: "RIDER_CANCELLED",
  NO_RIDERS_FOUND: "RIDER_CANCELLED",
  CANCELLED: "RIDER_CANCELLED",
  CANCELED: "RIDER_CANCELLED",
  ORDER_CANCELLED: "RIDER_CANCELLED",
  FAILED: "RIDER_CANCELLED",
  // Borzo delivery statuses (Business API 1.8 status model, doc-confirmed).
  COURIER_ASSIGNED: "DRIVER_ALLOCATED",
  COURIER_DEPARTED: "DRIVER_ALLOCATED",
  COURIER_AT_PICKUP: "ARRIVED_AT_PICKUP",
  PARCEL_PICKED_UP: "STARTED_DELIVERY",
  COURIER_ARRIVED: "STARTED_DELIVERY",
  FINISHED: "DELIVERED",
  // Shadowfax Hyperlocal order_status callbacks (doc-confirmed).
  ALLOTTED: "DRIVER_ALLOCATED",
  ARRIVED: "ARRIVED_AT_PICKUP",
  DISPATCHED: "STARTED_DELIVERY",
  ARRIVED_CUSTOMER_DOORSTEP: "STARTED_DELIVERY",
  CANCELLED_BY_CUSTOMER: "RIDER_CANCELLED",
  RETURNED_TO_SELLER: "RIDER_CANCELLED",
};

/**
 * Borzo `active` means different things by scope: order-level = "courier
 * assigned" (DRIVER_ALLOCATED), delivery-level = "courier on the way"
 * (STARTED_DELIVERY). Scoped lookup wins over EVENT_ALIASES.
 */
const SCOPED_EVENT_ALIASES: Record<"order" | "delivery", Record<string, string>> = {
  order: { ACTIVE: "DRIVER_ALLOCATED" },
  delivery: { ACTIVE: "STARTED_DELIVERY" },
};

/**
 * Known lifecycle noise that carries nothing to flip. Marked processed
 * silently (no park, no alert): Borzo order pre-courier states, delivery
 * pre-courier/dup states, and callback envelope types that surface only when
 * the nested status is missing. Anything else unmapped parks (DR10).
 */
const IGNORED_DISPATCH_EVENTS = new Set([
  "NEW",
  "AVAILABLE",
  "REACTIVATED",
  "DRAFT",
  "DELAYED",
  "PLANNED",
  "INVALID",
  "DELETED",
  "ORDER_CREATED",
  "ORDER_CHANGED",
  "DELIVERY_CREATED",
  "DELIVERY_CHANGED",
]);

function normalizeEventKey(rawEvent: any): string {
  return typeof rawEvent === "string"
    ? rawEvent.trim().toUpperCase().replace(/[\s-]+/g, "_")
    : "";
}

export function isIgnoredDispatchEvent(rawEvent: any): boolean {
  return IGNORED_DISPATCH_EVENTS.has(normalizeEventKey(rawEvent));
}

/**
 * Documented provider lifecycle statuses we deliberately do NOT map to a
 * canonical event: a return-to-seller (`return_*`) or a reattempt
 * (`reattempt_*`) is a normal delivery outcome, not an order-state flip and
 * NOT an error. They are recorded in `unmatched_dispatch_events` (so they stay
 * traceable) and parked, but no error snapshot is raised — an operator alert
 * per returned parcel is review noise, not a defect (finding 16).
 *
 * RESIDUAL (owner to decide): staff still get no alert when a parcel comes
 * back. A return/reattempt is visible only in `unmatched_dispatch_events`
 * until a purpose-built UI/reporting surface exists.
 */
const UNMAPPED_LIFECYCLE_STATUS_PREFIXES: readonly string[] = ["RETURN", "REATTEMPT"];

export function isUnmappedLifecycleStatus(rawEvent: any): boolean {
  const key = normalizeEventKey(rawEvent);
  return UNMAPPED_LIFECYCLE_STATUS_PREFIXES.some((prefix) => key.startsWith(prefix));
}

export function normalizeDispatchEvent(
  rawEvent: any,
  scope?: "order" | "delivery" | "generic"
): string | null {
  if (typeof rawEvent !== "string" || !rawEvent.trim()) return null;
  const key = normalizeEventKey(rawEvent);
  if (scope && scope !== "generic" && SCOPED_EVENT_ALIASES[scope]?.[key]) {
    return SCOPED_EVENT_ALIASES[scope][key];
  }
  return EVENT_ALIASES[key] || null;
}

function hash12(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 12);
}

/**
 * A canonical form of a JSON body: object keys sorted recursively, array order
 * and every value preserved. Providers re-send the SAME event with different
 * key order, whitespace or number formatting; hashing the raw bytes made that
 * look like a brand-new event, so the mirror wrote `riderLocation` twice and
 * re-sent RIDER_CANCELLED pushes (audit finding 15). Content that actually
 * differs still hashes differently. Non-JSON bodies keep their raw bytes.
 *
 * This is a dedup key only — the HMAC is verified over the raw bytes before we
 * ever get here, so canonicalisation cannot affect authenticity.
 */
function canonicalJson(raw: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw;
  }
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object") {
      const source = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(source).sort()) out[key] = walk(source[key]);
      return out;
    }
    return value;
  };
  return JSON.stringify(walk(parsed));
}

/**
 * Real rider GPS extraction — ZERO-FAKE rule. Only rider/driver/courier-
 * prefixed coordinate pairs are accepted, and only when BOTH values coerce to
 * finite in-range numbers. Nothing is interpolated, defaulted, or derived: a
 * callback without a genuine courier position yields null and the mirror keeps
 * its previous value (customer map hides the pin instead of faking one).
 */
export function extractRiderGps(payload: any): { lat: number; lng: number } | null {
  const p = payload || {};
  const pairs: Array<[unknown, unknown]> = [
    [p.rider_latitude, p.rider_longitude],
    [p.driver_latitude, p.driver_longitude],
    [p.courier_latitude, p.courier_longitude],
    [p.rider_location?.lat ?? p.rider_location?.latitude, p.rider_location?.lng ?? p.rider_location?.longitude],
    [p.driver_location?.lat ?? p.driver_location?.latitude, p.driver_location?.lng ?? p.driver_location?.longitude],
    [p.courier_location?.lat ?? p.courier_location?.latitude, p.courier_location?.lng ?? p.courier_location?.longitude],
    [p.rider?.lat ?? p.rider?.latitude, p.rider?.lng ?? p.rider?.longitude],
    [p.driver?.lat ?? p.driver?.latitude, p.driver?.lng ?? p.driver?.longitude],
    [p.courier?.lat ?? p.courier?.latitude, p.courier?.lng ?? p.courier?.longitude],
    [p.rider_details?.latitude, p.rider_details?.longitude],
    [p.driver_details?.latitude, p.driver_details?.longitude],
    [p.delivery?.courier?.latitude ?? p.delivery?.courier?.lat, p.delivery?.courier?.longitude ?? p.delivery?.courier?.lng],
    [p.order?.courier?.latitude ?? p.order?.courier?.lat, p.order?.courier?.longitude ?? p.order?.courier?.lng],
  ];
  for (const [rawLat, rawLng] of pairs) {
    const lat = typeof rawLat === "string" ? Number(rawLat) : rawLat;
    const lng = typeof rawLng === "string" ? Number(rawLng) : rawLng;
    if (typeof lat !== "number" || typeof lng !== "number") continue;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
    if (lat === 0 && lng === 0) continue; // (0,0) is a null-island placeholder
    return { lat, lng };
  }
  return null;
}

/** Drops undefined values — Firestore rejects them inside any write payload. */
function definedFields(o: Record<string, any>): Record<string, any> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}

function computeWebhookEventPatch(
  currentOrder: Record<string, any>,
  event: string | null,
  rawEvent: string,
  provider: DispatchWebhookProvider,
  providerOrderId: string | number | null,
  payload: any,
  driver: any,
  composedDriverName?: string,
  riderGps?: { lat: number; lng: number } | null
): {
  updateData: Record<string, any>;
  riderCancelOutcome: "carrier" | "customer" | "returned" | "unverified" | null;
  ignoredAfter: string | null;
  ignoredDeliveryMirror?: Record<string, any>;
} {
  const deliveryMirror = (patch: Record<string, any>): Record<string, any> =>
    definedFields({
      ...(currentOrder.delivery && typeof currentOrder.delivery === "object"
        ? currentOrder.delivery
        : {}),
      provider: currentOrder.dispatchProvider || provider,
      providerOrderId:
        currentOrder.dispatchOrderId != null
          ? String(currentOrder.dispatchOrderId)
          : providerOrderId != null
          ? String(providerOrderId)
          : undefined,
      ...patch,
    });

  const nonEmpty = (...candidates: any[]): string | undefined =>
    candidates.find((c) => typeof c === "string" && c.trim()) as string | undefined;

  const updateData: Record<string, any> = {
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    dispatchWebhookEvent: rawEvent,
    dispatchWebhookProvider: provider,
  };

  let riderCancelOutcome: "carrier" | "customer" | "returned" | "unverified" | null = null;
  let ignoredAfter: string | null = null;

  switch (event) {
    case "DRIVER_ALLOCATED": {
      // No rewind: a late/duplicate courier_assigned must not drag an order that
      // is already on the road back to "dispatched". (DELIVERED/CANCELLED are
      // handled by the terminal guard above.)
      if (currentOrder.deliveryStatus === "in_transit") {
        ignoredAfter = "in_transit";
        break;
      }
      const riderName = nonEmpty(
        composedDriverName,
        driver?.name,
        payload?.driver_name,
        payload?.rider_name
      );
      const riderPhone = nonEmpty(
        driver?.phone,
        payload?.driver_phone,
        payload?.rider_phone,
        payload?.rider_contact,
        payload?.driver_contact
      );
      const riderVehicle = nonEmpty(
        driver?.vehicle_number,
        payload?.driver_vehicle_number,
        payload?.rider_vehicle_number
      );
      const trackingUrl = nonEmpty(
        payload?.tracking_url,
        payload?.tracking_link,
        payload?.track_url,
        payload?.track,
        payload?.delivery?.tracking_url
      );
      if (riderName) updateData.riderName = riderName;
      if (riderPhone) updateData.riderPhone = riderPhone;
      if (riderVehicle) updateData.riderVehicleNumber = riderVehicle;
      if (trackingUrl) updateData.riderTrackingUrl = trackingUrl;

      const hasRiderIdentity = !!(riderName || riderPhone);
      updateData.deliveryStatus = "dispatched";
      // courier_assigned: order status itself stays PREPARING/READY — only
      // rider details attach (mission §3).
      updateData.delivery = deliveryMirror({
        status: hasRiderIdentity ? "rider_assigned" : "pending",
        riderName,
        riderPhone,
        riderVehicleNumber: riderVehicle,
        trackingUrl,
        ...(hasRiderIdentity
          ? { assignedAt: admin.firestore.FieldValue.serverTimestamp() }
          : {}),
      });
      break;
    }
    case "ARRIVED_AT_PICKUP": {
      // No rewind (F2, DS-review allowlist): late/out-of-order ARRIVED events
      // must not rewrite the mirror in any terminal or wind-down state
      // (in_transit parcel, cancelled/returned dispatch after a rebook, manual
      // assignment). The guard processes only fresh pre-pickup stages; the
      // terminal guard above already freezes delivered/cancelled.
      const currentDeliveryStatus = typeof currentOrder.deliveryStatus === "string"
        ? currentOrder.deliveryStatus
        : "";
      const freshPickupStage =
        !currentDeliveryStatus ||
        ["pending", "dispatched", "at_pickup"].includes(currentDeliveryStatus);
      if (!freshPickupStage) {
        ignoredAfter = currentDeliveryStatus;
        break;
      }
      updateData.riderArrivedAtStore = true;
      updateData.riderArrivedAt = admin.firestore.FieldValue.serverTimestamp();
      updateData.delivery = deliveryMirror({
        status: "at_pickup",
        riderArrivedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      break;
    }
    case "STARTED_DELIVERY": {
      updateData.status = {
        code: "OUT_FOR_DELIVERY",
        label: "Out for delivery",
        kind: "in_progress",
        terminal: false,
      };
      updateData.deliveryStatus = "in_transit";
      updateData.delivery = deliveryMirror({ status: "in_transit" });
      break;
    }
    case "DELIVERED": {
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
    }
    case "RIDER_CANCELLED": {
      // F12: the umbrella status is not the cause. Classify the vendor's own
      // reason text so a customer call-off / returned parcel (or an
      // unrecognised reason) is manual review, not an automatic rebook.
      const reasonText = cancelReasonText(payload);
      riderCancelOutcome = classifyCancelCause(rawEvent, reasonText);
      const manualReview = riderCancelOutcome !== "carrier";
      const reason =
        reasonText ||
        (riderCancelOutcome === "customer"
          ? "Delivery cancelled by customer"
          : riderCancelOutcome === "returned"
          ? "Parcel returned to seller"
          : riderCancelOutcome === "unverified"
          ? "Cancellation reason not provided by the provider — manual review required"
          : "Driver cancelled dispatch");
      if (manualReview) {
        updateData.needsRebook = false;
        updateData.rebookTrigger =
          riderCancelOutcome === "customer"
            ? "customer_cancelled"
            : riderCancelOutcome === "returned"
            ? "returned_to_seller"
            : // Not one of the auto-rebook triggers: the scheduled worker
              // ignores it, so an unverifiable cancel can never buy a rider.
              "cancellation_unverified";
        updateData.deliveryStatus = "needs_review";
        updateData.delivery = deliveryMirror({
          status: "needs_review",
          riderCancellationReason: reason,
        });
      } else {
        updateData.status = {
          code: "RIDER_CANCELLED",
          label: "Rider cancelled — rebook required",
          kind: "in_progress",
          terminal: false,
        };
        updateData.deliveryStatus = "rider_cancelled";
        updateData.needsRebook = true;
        updateData.rebookTrigger = "carrier_cancelled";
        updateData.delivery = deliveryMirror({
          status: "rider_cancelled",
          riderCancellationReason: reason,
        });
      }
      updateData.riderCancellationReason = reason;
      break;
    }
  }

  if (ignoredAfter) {
    return {
      updateData: {},
      riderCancelOutcome: null,
      ignoredAfter,
      ignoredDeliveryMirror: deliveryMirror({}),
    };
  }

  if (riderGps) {
    updateData.delivery = {
      ...(updateData.delivery || deliveryMirror({})),
      riderLocation: riderGps,
      riderLocationAt: admin.firestore.FieldValue.serverTimestamp(),
    };
  }

  return { updateData, riderCancelOutcome, ignoredAfter: null };
}

function riderCancelBranchAlert(
  orderId: string,
  riderCancelOutcome: "carrier" | "customer" | "returned" | "unverified"
): { title: string; body: string; data: Record<string, string> } {
  const carrierCancelled = riderCancelOutcome === "carrier";
  return {
    title: carrierCancelled
      ? "Rider cancelled — rebook needed"
      : riderCancelOutcome === "customer"
      ? "Delivery cancelled by customer — manual review"
      : riderCancelOutcome === "returned"
      ? "Parcel returned — manual review"
      : "Delivery cancelled — manual review",
    body: carrierCancelled
      ? `Order #${orderId.substring(0, 6)} lost its rider. Open the delivery queue to rebook.`
      : riderCancelOutcome === "customer"
      ? `Order #${orderId.substring(0, 6)}: delivery cancelled by the customer. Staff must review manually — no rebook will be attempted.`
      : riderCancelOutcome === "returned"
      ? `Order #${orderId.substring(0, 6)}: parcel returned to the seller. Staff must review manually — no rebook will be attempted.`
      : `Order #${orderId.substring(0, 6)}: the provider cancelled without a recognisable cause. Check the provider dashboard before rebooking — no automatic rebook will be attempted.`,
    data: {
      type: carrierCancelled ? "rider_cancelled" : "dispatch_manual_review",
      orderId,
      needsRebook: carrierCancelled ? "true" : "false",
    },
  };
}

function eventDocId(
  provider: string,
  rawEvent: string,
  ref: string,
  rawBody: string
): string {
  const safeRef = ref.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40) || "noref";
  const safeEvent = (rawEvent || "unknown").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 32);
  // Hash the CANONICAL body, not the raw bytes (finding 15): a reserialized
  // redelivery of the same event must land on the same dedup doc id. Content
  // that really differs still yields a distinct id.
  return `dwe_${provider}_${safeEvent}_${safeRef}_${hash12(canonicalJson(rawBody))}`;
}

function eventTimestampMs(payload: any): number | null {
  const raw =
    payload?.timestamp ??
    payload?.event_time ??
    payload?.created_at ??
    payload?.updated_at ??
    payload?.occurred_at ??
    // Borzo callbacks: `event_datetime` (both order + delivery envelopes).
    payload?.event_datetime ??
    payload?.delivery?.status_datetime ??
    payload?.order?.status_datetime ??
    // Shadowfax per-status time fields (whichever the payload carries).
    payload?.allot_time ??
    payload?.arrival_time ??
    payload?.dispatch_time ??
    payload?.customer_doorstep_arrival_time ??
    payload?.delivery_time ??
    payload?.return_time ??
    payload?.rts_time;
  if (raw === undefined || raw === null) return null;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw < 1e12 ? raw * 1000 : raw;
  }
  if (typeof raw === "string") {
    const parsed = Date.parse(raw);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

async function parkDispatchEvent(
  provider: DispatchWebhookProvider,
  parkId: string,
  fields: Record<string, any>,
  snapshotMessage: string,
  severity: "low" | "medium" | "high",
  // Unmapped-but-documented lifecycle statuses are traceable without an
  // operator alert (normal delivery flow, not an error — finding 16).
  options: { snapshot?: boolean } = {}
): Promise<void> {
  try {
    // A redelivery of an already-parked event re-parks it — that re-attempt is
    // the point of finding 3 — but it must NOT re-alert. The operator already
    // has the row; only a first park raises a snapshot (review finding on
    // 39efc40: the snapshot ran once per redelivery).
    const preState = await db
      .collection("dispatch_webhook_events")
      .doc(parkId)
      .get()
      .catch(() => null);
    const alreadyParked = preState?.data?.()?.status === "parked";

    await db
      .collection("unmatched_dispatch_events")
      .doc(parkId)
      .set(
        {
          provider,
          status: "needs_review",
          receivedAt: admin.firestore.FieldValue.serverTimestamp(),
          ...fields,
        },
        { merge: true }
      );
    if (options.snapshot !== false && !alreadyParked) {
      await captureErrorSnapshot({
        source: "dispatch",
        severity,
        message: snapshotMessage,
        context: { provider },
      });
    }
  } catch (err: any) {
    console.warn(`[Dispatch Webhook/${provider}] failed to park event:`, err?.message || err);
  }
}

export async function handleDispatchWebhook(
  provider: DispatchWebhookProvider,
  rawBody: string,
  signature: string,
  payload: any
): Promise<void> {
  const log = (msg: string) => console.log(`[Dispatch Webhook/${provider}] ${msg}`);

  if (!verifyDispatchWebhookSignature(provider, rawBody, signature)) {
    const authErr: any = new Error(`Invalid ${provider} webhook signature`);
    authErr.statusCode = 401;
    throw authErr;
  }

  // ---- Provider-aware extraction (real doc payload shapes) ----
  let rawEvent = "";
  let scope: "order" | "delivery" | "generic" = "generic";
  let providerOrderId: string | number | null = null;
  let hintRaw: string | number | null = null;

  if (provider === "borzo") {
    const delivery = payload?.delivery;
    const order = payload?.order;
    if (delivery && typeof delivery.status === "string" && delivery.status) {
      rawEvent = delivery.status;
      scope = "delivery";
    } else if (order && typeof order.status === "string" && order.status) {
      rawEvent = order.status;
      scope = "order";
    } else {
      rawEvent = payload?.event || payload?.event_type || payload?.type || payload?.status || "";
    }
    providerOrderId =
      order?.order_id ??
      delivery?.order_id ??
      payload?.order_id ??
      payload?.provider_order_id ??
      payload?.delivery_id ??
      null;
    hintRaw =
      delivery?.client_order_id ??
      order?.client_order_id ??
      payload?.client_order_id ??
      payload?.request_id ??
      payload?.merchant_order_id ??
      payload?.order_ref ??
      payload?.correlation_id ??
      null;
  } else {
    // shadowfax: `{order_status, sfx_order_id, client_order_id, rider_*}` —
    // generic `event`/`order_id` payloads still fall through for tests.
    rawEvent =
      payload?.order_status ||
      payload?.event ||
      payload?.event_type ||
      payload?.type ||
      payload?.status ||
      "";
    providerOrderId =
      payload?.sfx_order_id ??
      payload?.order_id ??
      payload?.provider_order_id ??
      payload?.delivery_id ??
      null;
    hintRaw =
      payload?.client_order_id ??
      payload?.COID ??
      payload?.request_id ??
      payload?.merchant_order_id ??
      payload?.order_ref ??
      null;
  }

  const event = normalizeDispatchEvent(rawEvent, scope);

  let correlationInfo: {
    orderId: string;
    generation: number;
    provider?: string;
    branchId?: string;
  } | null = null;

  const rawToken = typeof hintRaw === "string" ? hintRaw.trim() : null;
  if (rawToken && isSafeDocId(rawToken)) {
    try {
      const corrSnap = await db.collection("dispatch_correlation_map").doc(rawToken).get();
      if (corrSnap.exists) {
        const cd = corrSnap.data();
        if (cd && typeof cd.orderId === "string" && cd.orderId) {
          correlationInfo = {
            orderId: cd.orderId,
            generation: typeof cd.generation === "number" ? cd.generation : 1,
            provider: cd.provider,
            branchId: cd.branchId,
          };
        }
      }
    } catch {
      // Non-blocking lookup
    }
  }

  const orderIdHint = correlationInfo?.orderId ?? (typeof hintRaw === "string" ? hintRaw.replace(/^REQ-/, "") : null);

  const driver =
    payload?.driver_details ||
    payload?.rider_details ||
    payload?.driver ||
    payload?.rider ||
    payload?.delivery?.courier ||
    payload?.order?.courier ||
    payload?.courier ||
    {};

  const composedDriverName =
    typeof driver?.surname === "string" && driver.surname && typeof driver?.name === "string"
      ? `${driver.surname} ${driver.name}`
      : undefined;

  const riderGps = extractRiderGps(payload);

  // Borzo order_id is a JSON integer — coerce before the doc-id sanitizer.
  const parkId = eventDocId(
    provider,
    rawEvent,
    String(providerOrderId || orderIdHint || ""),
    rawBody
  );

  // Status-gated dedup (same pattern as porter): datastore-missing docs still
  // proceed on first delivery; true redeliveries skip.
  try {
    const seen = await db.collection("dispatch_webhook_events").doc(parkId).get();
    if (seen.data?.()?.status === "processed") {
      log(`Duplicate ${rawEvent} delivery skipped (${parkId})`);
      return;
    }
  } catch (err: any) {
    console.error(`[Dispatch Webhook/${provider}] Dedup read failed for ${parkId}:`, err?.message || err);
    throw new Error(`Dedup read failed: ${err?.message || err}`);
  }
  const markProcessed = async () => {
    try {
      await db.collection("dispatch_webhook_events").doc(parkId).set(
        {
          provider,
          rawEvent: rawEvent || null,
          providerOrderId: providerOrderId || null,
          orderId: orderIdHint || null,
          status: "processed",
          receivedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    } catch {
      // Best-effort: the order write is the durable trail.
    }
  };

  // A PARKED event is deliberately NOT `processed`: the dedup gate above only
  // skips `processed`, so an event parked as e.g. `no_matching_order` (a
  // callback that lost the race against the `dispatch_order_map` write) is
  // re-attempted on provider redelivery instead of being dropped forever
  // (finding 3). The park reason rides the dedup doc so the retry is auditable;
  // the row in `unmatched_dispatch_events` is keyed by the same deterministic
  // `parkId`, so a redelivery never appends a second row. That idempotency
  // covers RESERIALIZED redeliveries too: `parkId` hashes the canonically
  // sorted JSON body, so key-order/whitespace changes land on the same row
  // while genuinely different content still yields a distinct row (audit
  // finding 15 closed).
  const markParked = async (parkReason: string) => {
    try {
      await db.collection("dispatch_webhook_events").doc(parkId).set(
        {
          provider,
          rawEvent: rawEvent || null,
          providerOrderId: providerOrderId || null,
          orderId: orderIdHint || null,
          status: "parked",
          parkReason,
          receivedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    } catch {
      // Best-effort: the park row is the durable review trail.
    }
  };

  // Freshness: a stale retry must not rewind newer order state.
  const eventTs = eventTimestampMs(payload);
  if (eventTs !== null) {
    const skew = Date.now() - eventTs;
    if (skew > DISPATCH_WEBHOOK_FRESHNESS_MS || skew < -DISPATCH_WEBHOOK_FUTURE_SKEW_MS) {
      log(`Stale event ${rawEvent} parked (skew ${Math.round(skew / 1000)}s)`);
      await parkDispatchEvent(
        provider,
        parkId,
        {
          orderId: orderIdHint,
          providerOrderId,
          rawEvent: rawEvent || null,
          reason: "stale_event",
        },
        `Stale ${provider} event ${rawEvent || "unknown"} parked (no state rewind)`,
        "medium"
      );
      await markParked("stale_event");
      return;
    }
  }

  if (!event && isIgnoredDispatchEvent(rawEvent)) {
    // Known-but-inert lifecycle noise (Borzo order `new`/`available`, envelope
    // types): acknowledge so provider retries stop, without a park or alert.
    log(`Ignored lifecycle event ${rawEvent}`);
    await markProcessed();
    return;
  }

  if (!event && isUnmappedLifecycleStatus(rawEvent)) {
    // Documented return/reattempt lifecycle status: traceable in
    // `unmatched_dispatch_events`, never an error snapshot (finding 16). The
    // order is untouched — we do not pretend the status maps to a canonical
    // event.
    log(`Unmapped lifecycle status ${rawEvent} recorded (no canonical event)`);
    await parkDispatchEvent(
      provider,
      parkId,
      {
        orderId: orderIdHint,
        providerOrderId,
        rawEvent: rawEvent || null,
        reason: "unmapped_lifecycle_status",
      },
      `${provider} ${rawEvent || "unknown"} is a documented lifecycle status with no canonical mapping — recorded, no alert`,
      "low",
      { snapshot: false }
    );
    await markParked("unmapped_lifecycle_status");
    return;
  }

  if (!event) {
    log(`Unknown event parked: ${rawEvent}`);
    await parkDispatchEvent(
      provider,
      parkId,
      { orderId: orderIdHint, providerOrderId, rawEvent: rawEvent || null, reason: "unknown_event" },
      `Unknown ${provider} event ${rawEvent || "unknown"} parked — order untouched`,
      "medium"
    );
    await markParked("unknown_event");
    return;
  }

  if (!providerOrderId && !orderIdHint) {
    log(`Dropping event with no order reference: ${rawEvent}`);
    await parkDispatchEvent(
      provider,
      parkId,
      { rawEvent: rawEvent || null, reason: "no_order_reference" },
      `${provider} webhook with no order reference parked`,
      "medium"
    );
    await markParked("no_order_reference");
    return;
  }

  // ---- Order resolution: server map first, hint only when confirmed. ----
  let orderRef: admin.firestore.DocumentReference | null = null;
  let mappedOrderId: string | null = null;

  if (providerOrderId) {
    try {
      const mapSnap = await db.collection("dispatch_order_map").doc(String(providerOrderId)).get();
      const mapped = mapSnap.data?.();
      if (mapped && typeof mapped.orderId === "string" && mapped.orderId) {
        // Fail-closed provider binding (F7): the map row names a DIFFERENT
        // provider than the callback — e.g. two couriers minted the same
        // providerOrderId and one silently rebound the key. Another carrier's
        // callback must never mutate this order (deliveryStatus / rider fields
        // / the terminal DELIVERED flip), so park high BEFORE any resolution.
        // A row without a provider field is NOT a mismatch (we cannot guess a
        // legacy row's provider); it stays governed by the evidence-based
        // orderId/hint binding checks below.
        if (typeof mapped.provider === "string" && mapped.provider && mapped.provider !== provider) {
          log(`provider mismatch parked: map says provider=${mapped.provider}, callback is ${provider}`);
          await parkDispatchEvent(
            provider,
            parkId,
            {
              orderId: mapped.orderId,
              providerOrderId,
              mappedOrderId: mapped.orderId,
              mappedProvider: mapped.provider,
              callbackProvider: provider,
              rawEvent: rawEvent || null,
              reason: "order_id_conflict",
            },
            `${provider} webhook provider mismatch parked (map row bound to ${mapped.provider}) — no state flipped`,
            "high"
          );
          await markParked("order_id_conflict");
          return;
        }
        mappedOrderId = mapped.orderId;
        if (orderIdHint && orderIdHint !== mappedOrderId) {
          log(
            `providerOrderId conflict parked: map says ${mappedOrderId}, hint says ${orderIdHint}`
          );
          await parkDispatchEvent(
            provider,
            parkId,
            {
              orderId: orderIdHint,
              providerOrderId,
              mappedOrderId,
              rawEvent: rawEvent || null,
              reason: "order_id_conflict",
            },
            `${provider} webhook order-id conflict parked (hint ${orderIdHint} vs mapped ${mappedOrderId}) — no state flipped`,
            "high"
          );
          await markParked("order_id_conflict");
          return;
        }
        orderRef = db.collection("orders").doc(mappedOrderId);
      }
    } catch (err: any) {
      // Fail-closed: a map read failure must not fall through to the hint.
      console.error(
        `[Dispatch Webhook/${provider}] Map read failed for providerOrderId=${providerOrderId}:`,
        err?.message || err
      );
      throw new Error(`Map read failed: ${err?.message || err}`);
    }
  }

  if (!orderRef && orderIdHint) {
    if (!isSafeDocId(orderIdHint)) {
      log(`unsafe order hint parked: ${JSON.stringify(orderIdHint).slice(0, 80)}`);
      await parkDispatchEvent(
        provider,
        parkId,
        { providerOrderId, rawEvent: rawEvent || null, reason: "unsafe_order_id" },
        `${provider} webhook unsafe order hint parked`,
        "medium"
      );
      await markParked("unsafe_order_id");
      return;
    }
    const hintDoc = await db.collection("orders").doc(orderIdHint).get();
    const hintOrder = hintDoc.exists ? hintDoc.data() : undefined;
    // Hint is trusted ONLY when the order's OWN dispatch binding confirms the
    // provider order id. An order with NO dispatch binding is not a resolution:
    // the hint (client_order_id/COID) is attacker-chosen in a forged body, and
    // accepting it would flip an unbound order to dispatched/delivered
    // (finding 8). It parks instead — and because a parked event is
    // re-attemptable on redelivery, a legitimate callback that raced the
    // `dispatch_order_map` write still resolves on the provider retry. That
    // retry only happens if we answer non-2XX, so this branch throws
    // DispatchWebhookRetryRequested after parking (see the class doc).
    const binding = hintOrder?.dispatchOrderId || hintOrder?.porterOrderId || null;
    // DS final-review finding (low, applied): the binding comparison must use
    // the SAME id normalization as the pre-mutation ownership proof — a
    // padded/legacy string binding ("0012") and a numeric Borzo callback (12)
    // name the SAME booking, and resolving the hint path through raw ===
    // would false-park that genuinely-matching callback HIGH. Fail direction
    // is closed either way; this only removes a false park.
    const boundHintId = normalizeProviderOrderId(binding);
    const callbackHintId = normalizeProviderOrderId(providerOrderId);
    // A real binding that matches is the ONLY resolution. `!binding` parks
    // (finding 8): an unbound order must not be flipped by an attacker-chosen
    // hint. This branch is ordered BEFORE the conflict branch so an unbound
    // order reports `unbound_order` rather than a conflict against `null`.
    if (hintOrder && boundHintId && callbackHintId && boundHintId === callbackHintId) {
      // F7 (DS review) hint-path extension: binding-equality alone proves this
      // providerOrderId points HERE, not that this PROVIDER owns the order —
      // on a re-dispatch the stale provider's callback can name the old
      // providerOrderId and still resolve. A stored dispatchProvider that
      // differs from the callback provider must park high exactly like the
      // map-row mismatch guard; an ABSENT dispatchProvider (legacy/manual
      // dispatch row) keeps the binding evidence path.
      const boundProvider =
        typeof hintOrder.dispatchProvider === "string" ? hintOrder.dispatchProvider : "";
      if (boundProvider && boundProvider !== provider) {
        log(
          `hint provider mismatch parked: order ${orderIdHint} bound to provider ${boundProvider}, callback is ${provider}`
        );
        await parkDispatchEvent(
          provider,
          parkId,
          {
            orderId: orderIdHint,
            providerOrderId,
            // DS final-review (low, applied): keep mappedOrderId for OUR order
            // ids only; the order-side provider booking id rides boundOrderId.
            boundOrderId: boundHintId,
            mappedProvider: boundProvider,
            callbackProvider: provider,
            rawEvent: rawEvent || null,
            reason: "order_id_conflict",
          },
          `${provider} webhook provider mismatch parked (order binding held by ${boundProvider}) — no state flipped`,
          "high"
        );
        await markParked("order_id_conflict");
        return;
      }
      orderRef = hintDoc.ref;
    } else if (hintOrder && !binding) {
      if (correlationInfo) {
        // Explicit correlation token matched in dispatch_correlation_map!
        if (providerOrderId == null) {
          log(
            `correlated callback for order ${correlationInfo.orderId} carries no provider order id — parking (no binding)`
          );
          await parkDispatchEvent(
            provider,
            parkId,
            {
              orderId: correlationInfo.orderId,
              rawEvent: rawEvent || null,
              reason: "no_matching_order",
            },
            `${provider} webhook correlation for order ${correlationInfo.orderId} has no provider order id — parked, no state flipped`,
            "medium"
          );
          await markParked("no_matching_order");
          return;
        }
        const targetOrderId = correlationInfo.orderId;
        const targetOrderRef = db.collection("orders").doc(targetOrderId);
        const mapDocRef = db.collection("dispatch_order_map").doc(String(providerOrderId));

        if (db && typeof (db as any).runTransaction === "function") {
          const outcome: any = await (db as any).runTransaction(async (tx: any) => {
            const freshOrderSnap = await tx.get(targetOrderRef);
            const freshOrder = freshOrderSnap.exists ? freshOrderSnap.data() : undefined;
            if (!freshOrder) return { missing: true as const };

            const freshMapSnap = await tx.get(mapDocRef);
            const freshMapData = freshMapSnap.exists ? freshMapSnap.data() : undefined;

            // Map collision check on fresh snapshot:
            if (freshMapData && freshMapData.orderId && freshMapData.orderId !== targetOrderId) {
              return { mapConflict: freshMapData };
            }

            // Terminal state check on fresh snapshot (prevents regressing concurrent DELIVERED):
            const terminal = terminalDeliveryStatus(freshOrder);
            if (terminal) return { terminal };

            // Duplicate convergence on fresh snapshot:
            const curProviderId = freshOrder.dispatchOrderId ?? freshOrder.porterOrderId ?? null;
            if (
              freshOrder.deliveryStatus === "dispatched" &&
              curProviderId &&
              normalizeProviderOrderId(curProviderId) === normalizeProviderOrderId(providerOrderId)
            ) {
              return { alreadyBound: true as const, freshOrder };
            }

            // Validate pending correlation on fresh order snapshot:
            const pending = freshOrder.dispatchPendingCorrelation;
            if (freshOrder.dispatchStatus !== "needs_reconciliation" || !pending) {
              return { notPending: true as const, freshOrder };
            }

            // Validate token, provider, branch, generation
            if (pending.token && rawToken && pending.token !== rawToken) {
              return { tokenMismatch: true as const };
            }
            if (pending.provider && pending.provider !== provider) {
              return { foreignProvider: pending.provider };
            }
            if (pending.branchId && freshOrder.branchId && pending.branchId !== freshOrder.branchId) {
              return { branchMismatch: true as const };
            }
            if (typeof pending.generation === "number" && correlationInfo!.generation < pending.generation) {
              return { staleGeneration: { pendingGen: pending.generation, callbackGen: correlationInfo!.generation } };
            }
            if (typeof pending.generation === "number" && correlationInfo!.generation > pending.generation) {
              return { futureGeneration: true as const };
            }

            // Compute the delivery mirror and status/rider patch for this event
            const eventPatch = computeWebhookEventPatch(
              freshOrder,
              event,
              rawEvent,
              provider,
              providerOrderId,
              payload,
              driver,
              composedDriverName,
              riderGps
            );
            const ignoredAfter = eventPatch.ignoredAfter;

            // Write map + order TOGETHER in transaction:
            tx.set(
              mapDocRef,
              {
                orderId: targetOrderId,
                provider,
                generation: pending.generation,
                status: "dispatched",
                boundAt: admin.firestore.FieldValue.serverTimestamp(),
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              },
              { merge: true }
            );

            tx.set(
              targetOrderRef,
              {
                dispatchProvider: provider,
                dispatchOrderId: providerOrderId,
                dispatchStatus: "dispatched",
                dispatchError: null,
                dispatchPendingCorrelation: null,
                dispatchedBy: "provider_callback",
                dispatchedAt: admin.firestore.FieldValue.serverTimestamp(),
                ...(provider === "borzo" ? { borzoOrderId: providerOrderId } : {}),
                ...(provider === "shadowfax" ? { shadowfaxOrderId: providerOrderId } : {}),
                ...(ignoredAfter
                  ? { delivery: eventPatch.ignoredDeliveryMirror }
                  : { deliveryStatus: "dispatched", ...eventPatch.updateData }),
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              },
              { merge: true }
            );

            return {
              ok: true as const,
              freshOrder,
              riderCancelOutcome: eventPatch.riderCancelOutcome,
              ignoredAfter,
            };
          });

          // OUTSIDE TRANSACTION: handle outcomes
          if (outcome?.ignoredAfter) {
            log(
              `Late ${rawEvent} after ${outcome.ignoredAfter}: status patch skipped (no rewind), correlation bound`
            );
            await markProcessed();
            return;
          }

          if (outcome?.mapConflict) {
            log(`providerOrderId ${providerOrderId} already mapped to order ${outcome.mapConflict.orderId}`);
            await parkDispatchEvent(
              provider,
              parkId,
              {
                orderId: targetOrderId,
                providerOrderId,
                mappedOrderId: outcome.mapConflict.orderId,
                rawEvent: rawEvent || null,
                reason: "order_id_conflict",
              },
              `${provider} webhook providerOrderId already mapped to another order — no state flipped`,
              "high"
            );
            await markParked("order_id_conflict");
            return;
          }

          if (outcome?.terminal) {
            log(`correlated callback for already terminal order ${targetOrderId} ignored (no regression)`);
            await markProcessed();
            return;
          }

          if (outcome?.foreignProvider) {
            log(`foreign provider takeover rejected: pending is ${outcome.foreignProvider}, callback is ${provider}`);
            await parkDispatchEvent(
              provider,
              parkId,
              {
                orderId: targetOrderId,
                providerOrderId,
                boundProvider: outcome.foreignProvider,
                callbackProvider: provider,
                rawEvent: rawEvent || null,
                reason: "order_id_conflict",
              },
              `${provider} webhook foreign provider takeover rejected — no state flipped`,
              "high"
            );
            await markParked("order_id_conflict");
            return;
          }

          if (outcome?.branchMismatch) {
            log(`foreign branch takeover rejected for order ${targetOrderId}`);
            await parkDispatchEvent(
              provider,
              parkId,
              {
                orderId: targetOrderId,
                providerOrderId,
                rawEvent: rawEvent || null,
                reason: "order_id_conflict",
              },
              `${provider} webhook foreign branch takeover rejected — no state flipped`,
              "high"
            );
            await markParked("order_id_conflict");
            return;
          }

          if (outcome?.staleGeneration || outcome?.tokenMismatch) {
            log(
              `stale generation or token mismatch callback rejected for order ${targetOrderId}`
            );
            await parkDispatchEvent(
              provider,
              parkId,
              {
                orderId: targetOrderId,
                providerOrderId,
                callbackGeneration: outcome.staleGeneration?.callbackGen ?? correlationInfo?.generation ?? null,
                pendingGeneration: outcome.staleGeneration?.pendingGen ?? null,
                rawEvent: rawEvent || null,
                reason: "order_id_conflict",
              },
              `${provider} webhook stale generation or token mismatch rejected for order ${targetOrderId} — no state flipped`,
              "high"
            );
            await markParked("order_id_conflict");
            return;
          }

          if (outcome?.futureGeneration) {
            log(`future generation callback rejected for order ${targetOrderId}`);
            await parkDispatchEvent(
              provider,
              parkId,
              {
                orderId: targetOrderId,
                providerOrderId,
                rawEvent: rawEvent || null,
                reason: "order_id_conflict",
              },
              `${provider} webhook future generation callback rejected — no state flipped`,
              "high"
            );
            await markParked("order_id_conflict");
            return;
          }

          if (outcome?.alreadyBound) {
            log(`order ${targetOrderId} already bound to ${providerOrderId} (duplicate converged)`);
            await markProcessed();
            return;
          }

          if (outcome?.notPending) {
            log(`unproven correlation parked for order ${targetOrderId}`);
            await parkDispatchEvent(
              provider,
              parkId,
              {
                orderId: targetOrderId,
                providerOrderId,
                rawEvent: rawEvent || null,
                reason: "unbound_order",
              },
              `${provider} webhook unproven correlation for order ${targetOrderId} — parked`,
              "medium"
            );
            await markParked("unbound_order");
            if (providerOrderId) {
              throw new DispatchWebhookRetryRequested(
                `${provider} webhook parked (unproven correlation) for ${String(providerOrderId).slice(0, 64)} - retry requested`
              );
            }
            return;
          }

          if (outcome?.ok) {
            await markProcessed();
            if (outcome.riderCancelOutcome) {
              try {
                const branchId = outcome.freshOrder?.branchId;
                if (typeof branchId === "string" && branchId) {
                  await dispatchFCM({
                    topic: `branch_${branchId}_orders`,
                    ...riderCancelBranchAlert(targetOrderId, outcome.riderCancelOutcome),
                  });
                }
              } catch {
                // Best effort
              }
            }
            return;
          }
        }
      }

      log(`unbound order hint parked: order ${orderIdHint} has no dispatch binding`);
      await parkDispatchEvent(
        provider,
        parkId,
        {
          orderId: orderIdHint,
          providerOrderId,
          rawEvent: rawEvent || null,
          reason: "unbound_order",
        },
        `${provider} webhook hint names an order with no dispatch binding — parked, no state flipped`,
        "medium"
      );
      await markParked("unbound_order");
      // A real provider order is named but not bound YET: only a retry can
      // resolve this, so ask for one instead of answering 200.
      if (providerOrderId) {
        throw new DispatchWebhookRetryRequested(
          `${provider} webhook parked (unbound_order) for ${String(providerOrderId).slice(0, 64)} - retry requested`
        );
      }
      return;
    } else if (hintOrder && boundHintId && callbackHintId && boundHintId !== callbackHintId) {
      log(
        `hint/order conflict parked: order ${orderIdHint} bound to ${binding}, event says ${providerOrderId}`
      );
      await parkDispatchEvent(
        provider,
        parkId,
        {
          orderId: orderIdHint,
          providerOrderId,
          mappedOrderId: binding,
          rawEvent: rawEvent || null,
          reason: "order_id_conflict",
        },
        `${provider} webhook hint/order binding conflict parked — no state flipped`,
        "high"
      );
      await markParked("order_id_conflict");
      return;
    }
  }

  if (!orderRef) {
    log(`No matching order for event ${rawEvent} (providerOrderId=${providerOrderId || "n/a"})`);
    await parkDispatchEvent(
      provider,
      parkId,
      { orderId: orderIdHint, providerOrderId, rawEvent: rawEvent || null, reason: "no_matching_order" },
      `${provider} webhook for unmatched order parked for review`,
      "medium"
    );
    await markParked("no_matching_order");
    // Bindings are written after the provider's book response, so a callback
    // that names a real provider order can legitimately arrive before the map
    // row exists. Retry-signal that case; an event with no usable id at all is
    // terminal (nothing will ever match it).
    if (providerOrderId) {
      throw new DispatchWebhookRetryRequested(
        `${provider} webhook parked (no_matching_order) for ${String(providerOrderId).slice(0, 64)} - retry requested`
      );
    }
    return;
  }

  // ONE pre-write order read — it feeds the terminal guard AND the
  // `order.delivery` mirror merge base below.
  let currentOrder: Record<string, any> = {};
  try {
    const current = await orderRef.get();
    currentOrder = (current.data() || {}) as Record<string, any>;
  } catch (err: any) {
    // Fail closed: if we cannot prove the order is not yet delivered, skip
    // the flip rather than risk rewinding DELIVERED state.
    console.error(
      `[Dispatch Webhook/${provider}] pre-write order read failed:`,
      err?.message || err
    );
    throw new Error(`Pre-write order read failed: ${err?.message || err}`);
  }

  // ---- Pre-mutation ownership proof (stale-map HIGH fix). The map row and
  // the hint prove only WHAT THE CALLBACK CLAIMS; the order's CURRENT binding
  // proves what the order still belongs to. `dispatchBook` rewrites
  // dispatchProvider/dispatchOrderId on every (re)book and re-binds
  // dispatch_order_map/{newId}, but it never deletes the superseded row — so
  // a Borzo->Shadowfax rebook leaves the old Borzo row behind and its late
  // DELIVERED/CANCELLED callback can still resolve through the map (its
  // provider matches the MAP row). Validating the callback against the
  // order's own binding is the actual proof that the event belongs to the
  // CURRENT booking: a provider mismatch, a bound-bookId mismatch, or an
  // order with no binding metadata at all all park HIGH here, BEFORE any
  // order/rider/status/rebook field is written and before any FCM — a stale
  // callback must not deliver (or cancel) the live booking. Numeric/string
  // id forms compare through normalizeProviderOrderId. Absent legacy
  // metadata is not license to guess. NOTE (DS final-review): the read →
  // write window is not transactional — a rebook landing between the order
  // read and the merged write could still let a stale callback through the
  // same read/write hazard class the containment note documents; callers
  // rate-limit via provider retry ladders, not concurrency locks.
  // This runs after resolution but before
  // the terminal guard so mismatches stay visible as parked HIGH rows
  // instead of being silently processed away.
  const callbackBoundId = normalizeProviderOrderId(providerOrderId);
  const orderBoundProvider =
    typeof currentOrder.dispatchProvider === "string" && currentOrder.dispatchProvider
      ? currentOrder.dispatchProvider
      : "";
  const orderBoundId = normalizeProviderOrderId(
    currentOrder.dispatchOrderId ?? currentOrder.porterOrderId ?? null
  );
  // A teardown (staff cancel / failed rebook) retires the ACTIVE fields into
  // `dispatchReleasedBindings` (dispatch.router.ts). A callback naming a
  // released booking must NOT be treated as the order's owner: the branch
  // already released it. Staff cancel is a LOCAL release only (no documented
  // provider cancel API), so a late DELIVERED may still be a real fulfilment —
  // park HIGH for human reconciliation instead of applying it (a terminal flip
  // on a released order) or discarding it (a silent `markProcessed`).
  const releasedBindings = Array.isArray(currentOrder.dispatchReleasedBindings)
    ? currentOrder.dispatchReleasedBindings
    : [];
  const matchedReleasedBinding = callbackBoundId
    ? releasedBindings.find(
        (entry: any) =>
          entry &&
          entry.provider === provider &&
          normalizeProviderOrderId(entry.providerOrderId) === callbackBoundId
      )
    : undefined;
  const parkOrderBindingConflict = async (
    reason: "order_id_conflict" | "order_binding_unproven" | "order_binding_released",
    severity: "high"
  ) => {
    log(
      reason === "order_binding_released"
        ? `order ${orderRef!.id} released booking ${provider}/${callbackBoundId || "?"} — parking ${rawEvent} high (reconciliation, no mutation)`
        : reason === "order_binding_unproven"
        ? `order ${orderRef!.id} carries no current provider binding — parking ${rawEvent} high (no mutation)`
        : `order ${orderRef!.id} binding (${orderBoundProvider || "?"} / ${orderBoundId || "?"}) disagrees with callback ${provider} / ${callbackBoundId || "?"} — parking ${rawEvent} high (no mutation)`
    );
    await parkDispatchEvent(
      provider,
      parkId,
      {
        orderId: orderRef!.id,
        providerOrderId,
        mappedOrderId: orderRef!.id,
        boundProvider: orderBoundProvider || null,
        boundOrderId: orderBoundId || null,
        callbackProvider: provider,
        callbackProviderOrderId: callbackBoundId,
        ...(reason === "order_binding_released"
          ? { releasedReason: matchedReleasedBinding?.reason ?? null }
          : {}),
        rawEvent: rawEvent || null,
        reason,
      },
      reason === "order_binding_released"
        ? `${provider} webhook for ${rawEvent || "unknown"} names a RELEASED booking on order ${orderRef!.id} — parked for reconciliation, no state flipped`
        : `${provider} webhook for ${rawEvent || "unknown"} parked: order ${orderRef!.id}'s current binding does not match the callback — no state flipped`,
      severity
    );
    await markParked(reason);
  };
  // A callback for a booking this order already released is reported under the
  // released reason even when a NEW live booking now owns the order — the
  // reconciliation story ("the old booking reported again") is the actionable
  // one. Still park-only: nothing is mutated either way.
  const mismatchReason = matchedReleasedBinding ? "order_binding_released" : "order_id_conflict";
  if (orderBoundProvider && orderBoundProvider !== provider) {
    await parkOrderBindingConflict(mismatchReason, "high");
    return;
  }
  if (orderBoundId && callbackBoundId && orderBoundId !== callbackBoundId) {
    await parkOrderBindingConflict(mismatchReason, "high");
    return;
  }
  // DS final-review finding (low, applied): a provider bound but NO bound
  // order id is a PARTIAL-metadata state — the stale-map class again (the id
  // side of the callback is never validated). Not license to guess either.
  if (orderBoundProvider && !orderBoundId && callbackBoundId) {
    await parkOrderBindingConflict(
      matchedReleasedBinding ? "order_binding_released" : "order_binding_unproven",
      "high"
    );
    return;
  }
  if (!orderBoundProvider && !orderBoundId) {
    // No active owner. If the callback names a booking this order RELEASED,
    // the fence reason is explicit (reconciliation); otherwise it is still
    // unproven (legacy/map-row-only), never guessed.
    await parkOrderBindingConflict(
      matchedReleasedBinding ? "order_binding_released" : "order_binding_unproven",
      "high"
    );
    return;
  }

  // Terminal-state guard (mission §4): once the order is terminal
  // (`delivered` OR `cancelled` — the same locked set dispatchBook enforces),
  // EVERY event except the terminal DELIVERED flip itself is ignored. Provider
  // retries replay stale courier updates out of order within the freshness
  // window — a late RIDER_CANCELLED would otherwise resurrect a DELIVERED order
  // as rider_cancelled + needsRebook and pay for a second rider, and a late
  // courier_assigned/active would resurrect a CANCELLED order as `dispatched`
  // (finding 10). See the exempt case below.
  // The exempt case is ONLY a DELIVERED re-confirm of an already-delivered
  // order: a late DELIVERED must not turn a CANCELLED order into a paid delivery
  // (review finding on 39efc40), and every other event is still ignored.
  const currentTerminal = TERMINAL_DELIVERY_STATUSES.includes(currentOrder.deliveryStatus);
  const terminalSelfConfirm =
    event === "DELIVERED" && currentOrder.deliveryStatus === "delivered";
  if (currentTerminal && !terminalSelfConfirm) {
    log(`Late ${rawEvent} after terminal delivery status ignored (no rewind)`);
    await markProcessed();
    return;
  }

  // F6-sticky, centralized (DS final-review finding): once the ACTIVE booking
  // is contained for manual review, EVERY non-DELIVERED canonical event on it
  // is consumed — a late DISPATCHED/ALLOTTED/courier_assigned/cancel must not
  // overwrite the needs_review marker onto rider_cancelled/in_transit/
  // dispatched vocabulary (the auto-rebook worker stays disarmed via the
  // surviving rebookTrigger, but the manual-review state and the customer
  // view would lie). DELIVERED stays exempt: if the vendor actually delivered
  // after a customer called the delivery off, that fact wins and the flow
  // above records it. Containment RELEASES when staff re-dispatch: dispatchBook
  // rewrites deliveryStatus/needsRebook/rebookTrigger to the fresh post-rebook
  // state, so a carrier cancel on the new booking still auto-rebooks. This is
  // a pre-write state predicate on a plain read/write, NOT a transaction:
  // different-body events racing on the wire remain last-write-wins
  // (redeliveries of the same body dedup on the deterministic park id).
  if (event !== "DELIVERED" && isContainedManualReview(currentOrder)) {
    log(
      `${rawEvent} on order ${orderRef.id} ignored: booking already contained for manual review (${currentOrder.rebookTrigger || currentOrder.deliveryStatus}) — no rebook flag, no alert, no state overwrite`
    );
    await markProcessed();
    return;
  }

  const eventPatch = computeWebhookEventPatch(
    currentOrder,
    event,
    rawEvent,
    provider,
    providerOrderId,
    payload,
    driver,
    composedDriverName,
    riderGps
  );
  if (eventPatch.ignoredAfter) {
    log(`Late ${rawEvent} after ${eventPatch.ignoredAfter} ignored (no rewind)`);
    await markProcessed();
    return;
  }
  const updateData = eventPatch.updateData;
  const riderCancelOutcome = eventPatch.riderCancelOutcome;

  await orderRef.set(updateData, { merge: true });
  await markProcessed();

  // Branch alert so nobody has to notice a silent rebook need. F6: the alert
  // TEXT follows the cause — a customer-cancelled or returned delivery asks
  // staff for manual review and carries needsRebook:"false"; only a genuine
  // carrier/no-rider cancel asks staff to rebook.
  if (riderCancelOutcome) {
    try {
      const snap = await orderRef.get();
      const branchId = snap.data()?.branchId;
      if (typeof branchId === "string" && branchId) {
        await dispatchFCM({
          topic: `branch_${branchId}_orders`,
          ...riderCancelBranchAlert(orderRef.id, riderCancelOutcome),
        });
      }
    } catch (err: any) {
      console.warn(`[Dispatch Webhook/${provider}] branch rebook alert failed:`, err?.message || err);
    }
  }
}
