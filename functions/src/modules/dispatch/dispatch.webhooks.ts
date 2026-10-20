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
 *   6. Late non-terminal events after a terminal delivery status
 *      (`delivered`/`cancelled` — same set dispatchBook locks) are ignored.
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

function webhookSecretFor(provider: DispatchWebhookProvider): string {
  return provider === "borzo" ? config.borzo.webhookSecret : config.shadowfax.webhookSecret;
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
      payload?.request_id ??
      payload?.merchant_order_id ??
      payload?.order_ref ??
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
  const orderIdHint = typeof hintRaw === "string" ? hintRaw.replace(/^REQ-/, "") : null;

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
  // `parkId`, so a redelivery never appends a second row. That idempotency is
  // exact for BYTE-IDENTICAL redeliveries (the shape providers actually retry) —
  // `parkId` derives from a hash of the raw body, so a reserialized body (key
  // order/whitespace) yields a different row (audit finding 15, left open).
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
    // A real binding that matches is the ONLY resolution. `!binding` parks
    // (finding 8): an unbound order must not be flipped by an attacker-chosen
    // hint. This branch is ordered BEFORE the conflict branch so an unbound
    // order reports `unbound_order` rather than a conflict against `null`.
    if (hintOrder && binding && providerOrderId && binding === providerOrderId) {
      orderRef = hintDoc.ref;
    } else if (hintOrder && !binding) {
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
    } else if (hintOrder && providerOrderId && binding !== providerOrderId) {
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

  const nonEmpty = (...candidates: any[]): string | undefined =>
    candidates.find((c) => typeof c === "string" && c.trim()) as string | undefined;

  const driver =
    payload?.driver_details ||
    payload?.rider_details ||
    payload?.driver ||
    payload?.rider ||
    payload?.delivery?.courier || // Borzo delivery callback nests courier
    payload?.order?.courier ||
    {};

  const composedDriverName =
    typeof driver?.surname === "string" && driver.surname && typeof driver?.name === "string"
      ? `${driver.surname} ${driver.name}`
      : undefined;

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

  // `order.delivery` sub-object mirror (customer tracking reads exactly this
  // path). Always built from the PRE-WRITE snapshot + this event's fields, so
  // the write is a complete snapshot — deterministic under Firestore's deep
  // merge AND under the shallow-merge test shims (never drops a field the
  // previous event wrote).
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

  // Real rider GPS only — null when the callback carries no genuine courier
  // position (the mirror then keeps whatever real value it already had).
  const riderGps = extractRiderGps(payload);

  const updateData: Record<string, any> = {
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    dispatchWebhookEvent: rawEvent,
    dispatchWebhookProvider: provider,
  };

  switch (event) {
    case "DRIVER_ALLOCATED": {
      // No rewind: a late/duplicate courier_assigned must not drag an order that
      // is already on the road back to "dispatched". (DELIVERED/CANCELLED are
      // handled by the terminal guard above.)
      if (currentOrder.deliveryStatus === "in_transit") {
        log(`Late ${rawEvent} after in_transit ignored (no rewind)`);
        await markProcessed();
        return;
      }
      // Rider identity fields are written only when actually present — an
      // `undefined` Firestore value would reject the whole batch write.
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
      // Truthful status: only claim a rider when one is actually present. A
      // courier_assigned callback carrying no courier must leave the customer
      // view at `pending`, never a fabricated "rider assigned".
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

    case "ARRIVED_AT_PICKUP":
      updateData.riderArrivedAtStore = true;
      updateData.riderArrivedAt = admin.firestore.FieldValue.serverTimestamp();
      updateData.delivery = deliveryMirror({
        status: "at_pickup",
        riderArrivedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      break;

    case "STARTED_DELIVERY":
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

    case "RIDER_CANCELLED": {
      const reason =
        nonEmpty(
          payload?.reason_text,
          payload?.cancel_reason_text,
          typeof payload?.reason === "string" ? payload.reason : undefined,
          payload?.status_description
        ) || "Driver cancelled dispatch";
      updateData.status = {
        code: "RIDER_CANCELLED",
        label: "Rider cancelled — rebook required",
        kind: "in_progress",
        terminal: false,
      };
      updateData.deliveryStatus = "rider_cancelled";
      updateData.needsRebook = true;
      // Auto-rebook trigger (mission §3): the scheduled auto-rebook worker
      // re-dispatches this order with the NEXT provider, never the one that
      // cancelled. Staff-initiated cancels clear this flag, so they never
      // auto-rebook.
      updateData.rebookTrigger = "carrier_cancelled";
      updateData.riderCancellationReason = reason;
      updateData.delivery = deliveryMirror({
        status: "rider_cancelled",
        riderCancellationReason: reason,
      });
      break;
    }
  }

  // Live rider coordinates ride every callback that actually carries them
  // (mission §3: live GPS). Real numbers only — see extractRiderGps.
  if (riderGps) {
    updateData.delivery = {
      ...(updateData.delivery || deliveryMirror({})),
      riderLocation: riderGps,
      riderLocationAt: admin.firestore.FieldValue.serverTimestamp(),
    };
  }

  await orderRef.set(updateData, { merge: true });
  await markProcessed();

  // Branch alert so nobody has to notice a silent rebook need.
  if (event === "RIDER_CANCELLED") {
    try {
      const snap = await orderRef.get();
      const branchId = snap.data()?.branchId;
      if (typeof branchId === "string" && branchId) {
        await dispatchFCM({
          topic: `branch_${branchId}_orders`,
          title: "Rider cancelled — rebook needed",
          body: `Order #${orderRef.id.substring(0, 6)} lost its rider. Open the delivery queue to rebook.`,
          data: { type: "rider_cancelled", orderId: orderRef.id, needsRebook: "true" },
        });
      }
    } catch (err: any) {
      console.warn(`[Dispatch Webhook/${provider}] branch rebook alert failed:`, err?.message || err);
    }
  }
}
