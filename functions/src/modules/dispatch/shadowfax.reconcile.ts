import * as admin from "firebase-admin";
import * as crypto from "crypto";
import { config } from "../../config/env";
import { db } from "../../core/firebase";
import {
  getShadowfaxOrderStatus,
  markShadowfaxDispatchReady,
} from "./providers/shadowfax.adapter";

/**
 * Shadowfax status-poll reconciliation (Hyperlocal Marketplace).
 *
 * WHY THIS EXISTS. The provider's own callback page sets the retry budget:
 * "Retry on failure: 5-minute intervals, up to 7 attempts" (35 minutes) — after
 * that a missed callback is gone for good. The SAME page's Best Practices lists
 * "Use Get Order Details as a reconciliation fallback", and the Order Lifecycle
 * page repeats it. Without this worker a single missed ALLOTTED/DISPATCHED/
 * DELIVERED callback left the order on the Shadowfax binding forever, with the
 * customer tracker frozen and no automated recovery.
 *
 * SCOPE (deliberate):
 *   - Shadowfax orders ONLY. Porter has its own poller; Borzo has none by
 *     design (its status leg is webhook-only, see references/delivery_routing.md).
 *   - ADVANCING states only (ALLOTTED / DISPATCHED / DELIVERED). `ARRIVED` and
 *     `ARRIVED_CUSTOMER_DOORSTEP` are documented as callback-only and never
 *     appear in this pull API, so their absence proves nothing.
 *   - A pull-observed CANCELLED is PARKED, never applied. A cancel carries a
 *     rider-recovery/rebook decision (`delivery.webhooks.ts` RIDER_CANCELLED
 *     containment) and this worker must not indirectly buy a rider for an order
 *     whose rider may still be serving it. Parked rows are re-attemptable by
 *     staff, exactly like a webhook park.
 *   - NEVER a "second rider" path: nothing here books, rebooks, or cancels.
 *
 * Freshness + ownership:
 *   - Only orders with no update for at least `MIN_STALENESS_MS` are polled: a
 *     healthy webhook stream already carries every transition, and the pull API
 *     is rate-limited value per call (serviceability is 1200/min; the order
 *     endpoints publish no quota, so assume the stricter read).
 *   - The binding is re-checked against the LIVE document inside a transaction
 *     before any write, and the booking id must still be the one we polled: a
 *     staff rebook that lands mid-flight must never receive another carrier's
 *     status. Same fresh-binding rule as the webhook ownership proof.
 *
 * Dead-letter: 12 consecutive failed polls (1 hour at the 5-minute cadence) or
 * 2 hours of silence parks the order `needs_review` with `needsRebook: false`,
 * mirroring the Porter poller's honest-dead-letter behaviour. Parking asks a
 * human to look; it never spends money on a duplicate rider.
 */

/** Only poll once the webhook stream has been quiet this long. */
export const SHADOWFAX_POLL_MIN_STALENESS_MS = 15 * 60 * 1000;
/** Per-tick ceiling. The pull API publishes no order-endpoint quota. */
export const SHADOWFAX_POLL_QUERY_LIMIT = 25;
/** Consecutive failed polls before the order is parked for review. */
export const SHADOWFAX_MAX_FAILED_POLLS = 12;
/** Total silence (from the last order update) that also parks the order. */
export const SHADOWFAX_STALE_MS = 2 * 60 * 60 * 1000;

export interface ShadowfaxPollResult {
  /** Orders actually polled (provider called). */
  polledCount: number;
  /** Orders whose document changed as a result of the poll. */
  updatedCount: number;
  /** Orders parked for review (dead letter). */
  parkedCount: number;
}

/**
 * Documented OrderData.status values that may appear in the pull API and mean
 * something must change locally. ARRIVED / ARRIVED_CUSTOMER_DOORSTEP /
 * RETURNED_TO_SELLER are absent on purpose (callback-only per the lifecycle
 * table; RETURNED_TO_SELLER additionally carries a returns decision).
 */
const PULL_STATUS_ALIASES: Record<string, "ALLOTTED" | "DISPATCHED" | "DELIVERED"> = {
  ACCEPTED: "ALLOTTED",
  ALLOTTED: "ALLOTTED",
  DISPATCHED: "DISPATCHED",
  DELIVERED: "DELIVERED",
};

const CANCELLED_PULL_STATUSES = new Set(["CANCELLED", "CANCELLED_BY_CUSTOMER"]);

function pullStatus(data: any): string {
  const raw = data?.status;
  return typeof raw === "string" ? raw.trim().toUpperCase().replace(/[\s-]+/g, "_") : "";
}

function riderFromPull(data: any): {
  name?: string;
  phone?: string;
  location?: { lat: number; lng: number };
} {
  const rider = data?.rider_details || {};
  const out: { name?: string; phone?: string; location?: { lat: number; lng: number } } = {};
  if (typeof rider.rider_name === "string" && rider.rider_name.trim()) {
    out.name = rider.rider_name.trim().slice(0, 120);
  }
  if (typeof rider.rider_phone === "string" && rider.rider_phone.trim()) {
    out.phone = rider.rider_phone.trim().slice(0, 20);
  }
  const loc = rider.rider_location;
  // ZERO-FAKE: only a genuine in-range pair is a courier position.
  const lat = typeof loc?.lat === "number" ? loc.lat : Number(loc?.latitude);
  const lng = typeof loc?.lng === "number" ? loc.lng : Number(loc?.longitude);
  if (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lng) <= 180 &&
    !(lat === 0 && lng === 0)
  ) {
    out.location = { lat, lng };
  }
  return out;
}

function toMillis(value: any): number {
  if (typeof value?.toMillis === "function") {
    try {
      const ms = value.toMillis();
      return Number.isFinite(ms) ? ms : 0;
    } catch {
      return 0;
    }
  }
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function withDeliveryMirror(
  current: Record<string, any>,
  patch: Record<string, any>
): Record<string, any> {
  const base =
    current.delivery && typeof current.delivery === "object" ? current.delivery : {};
  return {
    ...base,
    provider: current.dispatchProvider || "shadowfax",
    providerOrderId: String(current.dispatchOrderId ?? ""),
    ...patch,
  };
}

/**
 * Build the order patch for a documented pull status. Returns `null` when the
 * status carries nothing to change locally (unknown value, or a state the
 * order has already passed — the pull API is not a rewind source).
 */
export function buildShadowfaxPollPatch(
  current: Record<string, any>,
  data: any,
  nowTs: any
): Record<string, any> | null {
  const status = pullStatus(data);
  const canonical = PULL_STATUS_ALIASES[status];
  if (!canonical) return null;

  const deliveryStatus = current.deliveryStatus;
  const rider = riderFromPull(data);
  const riderPatch: Record<string, any> = {};
  if (rider.name) riderPatch.riderName = rider.name;
  if (rider.phone) riderPatch.riderPhone = rider.phone;
  const locationPatch = rider.location
    ? { riderLocation: rider.location, riderLocationAt: nowTs }
    : {};

  if (canonical === "ALLOTTED") {
    // Already on the road: a pull ALLOTTED is older news. No rewind.
    if (deliveryStatus === "in_transit" || deliveryStatus === "delivered") return null;
    const hasRider = !!(rider.name || rider.phone);
    return {
      ...riderPatch,
      deliveryStatus: "dispatched",
      delivery: withDeliveryMirror(current, {
        status: hasRider ? "rider_assigned" : "pending",
        ...riderPatch,
        ...locationPatch,
        ...(hasRider ? { assignedAt: nowTs } : {}),
      }),
      shadowfaxLastPulledStatus: status,
      shadowfaxPolledAt: nowTs,
      shadowfaxPollCount: 0,
      shadowfaxLastPollError: null,
      updatedAt: nowTs,
    };
  }

  if (canonical === "DISPATCHED") {
    if (deliveryStatus === "delivered") return null;
    return {
      ...riderPatch,
      status: {
        code: "OUT_FOR_DELIVERY",
        label: "Out for delivery",
        kind: "in_progress",
        terminal: false,
      },
      deliveryStatus: "in_transit",
      delivery: withDeliveryMirror(current, { status: "in_transit", ...locationPatch }),
      shadowfaxLastPulledStatus: status,
      shadowfaxPolledAt: nowTs,
      shadowfaxPollCount: 0,
      shadowfaxLastPollError: null,
      updatedAt: nowTs,
    };
  }

  // DELIVERED. The delivery OTP gate (orderStatus.ts DELIVERY_OTP_REQUIRED)
  // governs the KDS handover route; the courier's own terminal callback is the
  // provider-side proof of possession and already closes orders in
  // dispatch.webhooks.ts. This is the same courier signal, recovered.
  if (deliveryStatus === "delivered") return null;
  return {
    ...riderPatch,
    status: {
      code: "DELIVERED",
      label: "Delivered",
      kind: "completed",
      terminal: true,
    },
    deliveryStatus: "delivered",
    deliveredAt: nowTs,
    delivery: withDeliveryMirror(current, { status: "delivered", deliveredAt: nowTs, ...locationPatch }),
    needsRebook: false,
    rebookTrigger: null,
    shadowfaxLastPulledStatus: status,
    shadowfaxPolledAt: nowTs,
    shadowfaxPollCount: 0,
    shadowfaxLastPollError: null,
    updatedAt: nowTs,
  };
}

/**
 * 5-minute scheduled reconciliation for Shadowfax orders whose callbacks have
 * gone quiet. Read-only against the provider (GET status); the only writes are
 * to OUR order document, and only under a re-checked binding.
 */
export async function pollActiveShadowfaxOrdersWorker(): Promise<ShadowfaxPollResult> {
  const result: ShadowfaxPollResult = { polledCount: 0, updatedCount: 0, parkedCount: 0 };

  // Fail closed: an unconfigured provider makes no call and writes nothing.
  // (`isEligible()` also needs the contract flag, which is a GO-LIVE gate, not
  // a reason to skip a configured read-only reconciliation.)
  if (!(config.shadowfax.apiKey || "").trim()) return result;

  const now = Date.now();

  let snap: any;
  try {
    snap = await db
      .collection("orders")
      .where("deliveryStatus", "in", ["dispatched", "in_transit"])
      .limit(SHADOWFAX_POLL_QUERY_LIMIT)
      .get();
  } catch (err: any) {
    // A worker that cannot read must not poll: returning zero keeps the tick
    // honest instead of reporting phantom coverage.
    console.error("[Shadowfax Poll] query failed:", err?.message || err);
    return result;
  }

  const staleDocs = (snap?.docs || []).filter((doc: any) => {
    const order = doc.data ? doc.data() : undefined;
    if (!order) return false;
    if (order.dispatchProvider !== "shadowfax") return false;
    const providerOrderId = String(order.dispatchOrderId ?? order.shadowfaxOrderId ?? "");
    if (!/^\d+$/.test(providerOrderId)) return false;
    return now - toMillis(order.updatedAt) >= SHADOWFAX_POLL_MIN_STALENESS_MS;
  });

  if (staleDocs.length === 0) return result;

  const nowTs = () => admin.firestore.FieldValue.serverTimestamp();

  const recordPollFailure = async (doc: any, order: any, reason: string) => {
    const failCount = Number(order.shadowfaxPollCount || 0) + 1;
    const silentFor = now - toMillis(order.updatedAt);
    if (failCount >= SHADOWFAX_MAX_FAILED_POLLS || silentFor >= SHADOWFAX_STALE_MS) {
      await doc.ref.set(
        {
          deliveryStatus: "needs_review",
          // Never an automatic rebook: a booking we cannot observe may still
          // have a rider on it. A human decides.
          needsRebook: false,
          shadowfaxPollCount: failCount,
          shadowfaxLastPollError: reason,
          updatedAt: nowTs(),
        },
        { merge: true }
      );
      result.parkedCount++;
      const { captureErrorSnapshot } = await import("../../core/errors");
      await captureErrorSnapshot({
        source: "dispatch",
        severity: "high",
        message: `Shadowfax tracking dark for order ${doc.id} (${failCount} failed polls) — parked for manual review, no rebook attempted`,
        orderId: doc.id,
        branchId: order.branchId,
        context: { provider: "shadowfax" },
      });
      return;
    }
    await doc.ref.set(
      {
        shadowfaxPollCount: failCount,
        shadowfaxLastPollError: reason,
        shadowfaxPolledAt: nowTs(),
        updatedAt: nowTs(),
      },
      { merge: true }
    );
  };

  const parkProviderCancelled = async (doc: any, order: any, data: any) => {
    const parkId = `sfx_poll_cancel_${doc.id}_${String(order.dispatchOrderId ?? "")}`;
    await db
      .collection("unmatched_dispatch_events")
      .doc(parkId)
      .set(
        {
          provider: "shadowfax",
          status: "needs_review",
          reason: "poll_provider_cancelled",
          orderId: doc.id,
          providerOrderId: String(order.dispatchOrderId ?? "") || null,
          rawEvent: pullStatus(data) || null,
          // Documented CANCELLED cause fields (0-24 code + text). Recorded,
          // never acted on: the rebook decision belongs to a human.
          cancelReason:
            typeof data?.cancel_reason === "number" ? data.cancel_reason : null,
          cancelReasonText:
            typeof data?.cancel_reason_text === "string"
              ? data.cancel_reason_text.slice(0, 300)
              : null,
          receivedAt: nowTs(),
        },
        { merge: true }
      );
  };

  const pollOne = async (doc: any): Promise<"updated" | "polled"> => {
    const order = doc.data();
    const providerOrderId = String(order.dispatchOrderId ?? order.shadowfaxOrderId ?? "");
    try {
      const data = await getShadowfaxOrderStatus(providerOrderId);

      if (CANCELLED_PULL_STATUSES.has(pullStatus(data))) {
        await parkProviderCancelled(doc, order, data);
        await doc.ref.set(
          {
            shadowfaxPolledAt: nowTs(),
            updatedAt: nowTs(),
            shadowfaxLastPollError: null,
          },
          { merge: true }
        );
        return "polled";
      }

      // Fresh-binding recheck + write in ONE transaction: a rebook that landed
      // while the pull was in flight must not inherit this carrier's status.
      let applied = false;
      const apply = async (tx: any) => {
        const freshSnap = await tx.get(doc.ref);
        const fresh = freshSnap.exists ? freshSnap.data() : undefined;
        if (!fresh) return;
        if (fresh.dispatchProvider !== "shadowfax") return;
        if (String(fresh.dispatchOrderId ?? fresh.shadowfaxOrderId ?? "") !== providerOrderId) {
          return;
        }
        if (fresh.deliveryStatus === "delivered" || fresh.deliveryStatus === "cancelled") return;
        const patch = buildShadowfaxPollPatch(fresh, data, nowTs());
        if (!patch) {
          // Nothing to change, but the poll did happen and the provider is
          // healthy: reset the dead-letter counter so a long ARRIVED-only
          // stretch does not park a perfectly live order.
          tx.set(
            doc.ref,
            {
              shadowfaxPollCount: 0,
              shadowfaxLastPollError: null,
              shadowfaxPolledAt: nowTs(),
              shadowfaxLastPulledStatus: pullStatus(data) || null,
            },
            { merge: true }
          );
          return;
        }
        tx.set(doc.ref, patch, { merge: true });
        applied = true;
      };

      if (db && typeof (db as any).runTransaction === "function") {
        await (db as any).runTransaction(apply);
      } else {
        // Test shims without transactions: the same rules on one read.
        await apply({
          get: (ref: any) => ref.get(),
          set: (ref: any, payload: any, opts?: any) => ref.set(payload, opts),
        });
      }
      return applied ? "updated" : "polled";
    } catch (err: any) {
      console.warn(
        `[Shadowfax Poll] order ${doc.id} poll failed:`,
        err?.message || err
      );
      await recordPollFailure(doc, order, String(err?.message || "poll exception").slice(0, 300));
      return "polled";
    }
  };

  // Bounded chunks: one slow provider response must not stall the tick, and one
  // bad order must never abort the rest.
  const CHUNK_SIZE = 5;
  for (let i = 0; i < staleDocs.length; i += CHUNK_SIZE) {
    const chunk = staleDocs.slice(i, i + CHUNK_SIZE);
    const settled = await Promise.allSettled(chunk.map((doc: any) => pollOne(doc)));
    for (const res of settled) {
      result.polledCount++;
      if (res.status === "fulfilled" && res.value === "updated") result.updatedCount++;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Dispatch-ready indicator (KDS ready transition)
// ---------------------------------------------------------------------------

/**
 * The COID Shadowfax must be told. `PUT /api/v2/orders/{coid}/dispatch-ready/`
 * identifies the order by the CLIENT order id we sent at placement, and the
 * dispatcher mints that as its durable correlation token (recorded on the order
 * as `dispatchClientOrderId`). Orders booked before that stamp existed are
 * recomputed from the SAME deterministic formula (orderId + dispatchGeneration)
 * rather than guessed: an unknown COID would 404 at the provider and silently
 * keep the rider uninformed.
 */
function shadowfaxClientOrderId(orderId: string, order: any): string | null {
  const stamped = order?.dispatchClientOrderId;
  if (typeof stamped === "string" && stamped.trim()) return stamped.trim();
  const generation = typeof order?.dispatchGeneration === "number" ? order.dispatchGeneration : null;
  if (generation === null || generation < 1) return null;
  // Local recompute of dispatch.router.mintDispatchCorrelationToken. Kept as a
  // copy, not an import: orderStatus -> router -> adapters would be a cycle for
  // two lines of hashing, and the formula is pinned by test.
  const hash = crypto.createHash("sha256").update(`${orderId}:${generation}`).digest("hex").slice(0, 16);
  return `cr_${hash}_${generation}`;
}

function isShadowfaxBookingLive(order: any): boolean {
  if (order?.dispatchProvider !== "shadowfax") return false;
  if (!String(order?.dispatchOrderId ?? order?.shadowfaxOrderId ?? "")) return false;
  if (order?.needsRebook === true) return false;
  return (
    order?.deliveryStatus === "dispatched" ||
    order?.deliveryStatus === "in_transit" ||
    order?.deliveryStatus === "driver_allocated"
  );
}

/**
 * PUT the dispatch-ready signal for one order and record the outcome.
 *
 * NEVER THROWS to its caller: it runs after the KDS bump has committed, and a
 * provider fault must not turn a successful kitchen transition into a 500 that
 * makes staff re-tap (the second tap then 409s as stale). A failure sets
 * `shadowfaxDispatchReady.pending = true` with the SAME timestamp, which
 * `retryPendingShadowfaxReadySignals` resends — the provider must learn when
 * the food was actually ready, not when the retry happened.
 */
export async function signalShadowfaxDispatchReady(
  orderId: string,
  order: Record<string, any>
): Promise<{ sent: boolean; reason?: string }> {
  if (!isShadowfaxBookingLive(order)) return { sent: false, reason: "not_a_live_shadowfax_booking" };

  const clientOrderId =
    (typeof order.dispatchClientOrderId === "string" && order.dispatchClientOrderId.trim()) ||
    shadowfaxClientOrderId(orderId, order);
  if (!clientOrderId) return { sent: false, reason: "no_client_order_id" };

  // Already signalled for THIS booking: a duplicate signal is provider noise
  // (and the docs require callbacks to be idempotent, so we owe the same).
  const previous = order.shadowfaxDispatchReady;
  const bookingId = String(order.dispatchOrderId ?? order.shadowfaxOrderId ?? "");
  if (
    previous &&
    previous.pending === false &&
    previous.clientOrderId === clientOrderId &&
    previous.sentAtBookingId === bookingId
  ) {
    return { sent: false, reason: "already_signalled" };
  }

  const timestamp =
    previous?.pending === true &&
    typeof previous.timestamp === "string" &&
    previous.clientOrderId === clientOrderId &&
    !Number.isNaN(Date.parse(previous.timestamp))
      ? previous.timestamp
      : new Date().toISOString();

  try {
    await markShadowfaxDispatchReady(clientOrderId, timestamp);
    await db
      .collection("orders")
      .doc(orderId)
      .set(
        {
          shadowfaxDispatchReady: {
            pending: false,
            clientOrderId,
            timestamp,
            sentAtBookingId: bookingId,
            attempts: Number(previous?.attempts || 0) + 1,
            lastError: null,
            sentAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    return { sent: true };
  } catch (err: any) {
    const message = String(err?.message || err).slice(0, 300);
    console.warn(
      `[Shadowfax Ready] dispatch-ready failed for order ${orderId} (kitchen bump already committed, signal left retryable):`,
      message
    );
    try {
      await db
        .collection("orders")
        .doc(orderId)
        .set(
          {
            shadowfaxDispatchReady: {
              pending: true,
              clientOrderId,
              timestamp,
              sentAtBookingId: null,
              attempts: Number(previous?.attempts || 0) + 1,
              lastError: message,
            },
          },
          { merge: true }
        );
    } catch (writeErr: any) {
      // The bump already succeeded; record-keeping for the retry is best-effort
      // and a failed stamp must not surface as a kitchen error.
      console.warn(
        `[Shadowfax Ready] could not record the pending signal for order ${orderId}:`,
        writeErr?.message || writeErr
      );
    }
    return { sent: false, reason: "provider_error" };
  }
}

export interface ShadowfaxReadyRetryResult {
  scanned: number;
  retriedCount: number;
  failedCount: number;
}

/**
 * Resends dispatch-ready for signals that never landed. Same 5-minute schedule
 * as the status poll; bounded per tick; each retry reuses the ORIGINAL
 * timestamp so the rider learns the real ready time.
 */
export async function retryPendingShadowfaxReadySignals(): Promise<ShadowfaxReadyRetryResult> {
  const result: ShadowfaxReadyRetryResult = { scanned: 0, retriedCount: 0, failedCount: 0 };
  if (!(config.shadowfax.apiKey || "").trim()) return result;

  let snap: any;
  try {
    snap = await db
      .collection("orders")
      .where("shadowfaxDispatchReady.pending", "==", true)
      .limit(SHADOWFAX_POLL_QUERY_LIMIT)
      .get();
  } catch (err: any) {
    console.error("[Shadowfax Ready] query failed:", err?.message || err);
    return result;
  }

  for (const doc of snap?.docs || []) {
    result.scanned++;
    const order = doc.data ? doc.data() : undefined;
    if (!order) continue;
    const outcome = await signalShadowfaxDispatchReady(doc.id, order);
    if (outcome.sent) result.retriedCount++;
    else if (outcome.reason === "provider_error") result.failedCount++;
  }
  return result;
}

