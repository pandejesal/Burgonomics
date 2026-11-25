import * as admin from "firebase-admin";
import * as crypto from "crypto";
import { config } from "../../config/env";
import { db } from "../../core/firebase";
import {
  getShadowfaxOrderStatus,
  markShadowfaxDispatchReady,
  cancelShadowfaxOrder,
} from "./providers/shadowfax.adapter";
import {
  buildPendingCancelConfirmation,
  buildPendingCancelWrite,
  manualCancelInstruction,
  providerCanCancelRemotely,
  type PendingDispatchCancel,
} from "./dispatch.cancelPending";
import { ACTIVE_SCAN_PAGE, scanActiveDocuments, staleEnough } from "./activeScan";

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

  // A8-7: scan the whole active set with a cursor; the per-tick provider-call
  // budget stays SHADOWFAX_POLL_QUERY_LIMIT (cost discipline preserved).
  let staleDocs: any[] = [];
  try {
    staleDocs = await scanActiveDocuments(
      (startAfterDoc?: any) => {
        const base = db
          .collection("orders")
          .where("deliveryStatus", "in", ["dispatched", "in_transit"])
          .limit(ACTIVE_SCAN_PAGE);
        return startAfterDoc ? (base as any).startAfter(startAfterDoc) : base;
      },
      (order: any) => {
        if (order.dispatchProvider !== "shadowfax") return false;
        const providerOrderId = String(order.dispatchOrderId ?? order.shadowfaxOrderId ?? "");
        if (!/^\d+$/.test(providerOrderId)) return false;
        return staleEnough(order, now, SHADOWFAX_POLL_MIN_STALENESS_MS);
      },
      SHADOWFAX_POLL_QUERY_LIMIT
    );
  } catch (err: any) {
    // A worker that cannot read must not poll: returning zero keeps the tick
    // honest instead of reporting phantom coverage.
    console.error("[Shadowfax Poll] query failed:", err?.message || err);
    return result;
  }

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

  /**
   * A8-2: contain a poll-observed cancellation exactly like the webhook does.
   *
   * The webhook RIDER_CANCELLED path parks the order `deliveryStatus:
   * "needs_review"` with `needsRebook: false` and a `rebookTrigger`, then alerts
   * the branch. The poller used to write only the evidence row and refresh
   * `updatedAt`, so the customer tracker kept showing a live delivery that no
   * longer existed, no human was told, and the refreshed timestamp reset the
   * dead-letter clock so nothing escalated either.
   *
   * The cause is unverifiable from a pull (the pull body carries no
   * `cancel_reason_text` classification guarantee we can trust for a rebook
   * decision), so this is the MANUAL REVIEW shape: `cancellation_unverified`,
   * never an automatic rebook. Rebooking stays a human step, exactly as the
   * scope comment above promises.
   *
   * Returns true when the containment was applied on a still-owned booking.
   */
  const containProviderCancelled = async (
    doc: any,
    order: any,
    data: any
  ): Promise<boolean> => {
    const providerOrderId = String(order.dispatchOrderId ?? order.shadowfaxOrderId ?? "");
    let contained = false;
    const apply = async (tx: any) => {
      const freshSnap = await tx.get(doc.ref);
      const fresh = freshSnap.exists ? freshSnap.data() : undefined;
      if (!fresh) return;
      // A rebook / staff teardown that landed mid-pull must win: this carrier's
      // cancellation says nothing about the booking now on the order.
      if (fresh.dispatchProvider !== "shadowfax") return;
      if (String(fresh.dispatchOrderId ?? fresh.shadowfaxOrderId ?? "") !== providerOrderId) {
        return;
      }
      // Already contained / closed: idempotent, nothing to write or alert.
      if (fresh.deliveryStatus === "needs_review" || fresh.deliveryStatus === "cancelled" || fresh.deliveryStatus === "delivered") {
        return;
      }
      const reasonText =
        typeof data?.cancel_reason_text === "string" && data.cancel_reason_text.trim()
          ? data.cancel_reason_text.trim().slice(0, 300)
          : "The provider cancelled the booking (observed by status polling)";
      const deliveryStatusBefore = String(fresh.deliveryStatus || "dispatched");
      tx.set(
        doc.ref,
        {
          // Same containment shape as dispatch.webhooks.ts RIDER_CANCELLED's
          // manual-review arm.
          deliveryStatus: "needs_review",
          needsRebook: false,
          rebookTrigger: "cancellation_unverified",
          riderCancellationReason: reasonText,
          delivery: withDeliveryMirror(fresh, {
            status: "needs_review",
            riderCancellationReason: reasonText,
          }),
          shadowfaxLastPulledStatus: pullStatus(data) || null,
          shadowfaxLastPollError: null,
          // A cancellation is a WIND-DOWN, not a healthy heartbeat: the dead
          // letter counter is NOT reset here, and `updatedAt` is deliberately
          // left alone so the silence clock keeps its true age.
          shadowfaxPolledAt: nowTs(),
          shadowfaxPollContained: {
            reason: "provider_cancelled",
            observedBy: "poll",
            providerOrderId,
            deliveryStatusBefore,
            containedAt: nowTs(),
          },
        },
        { merge: true }
      );
      contained = true;
    };

    if (db && typeof (db as any).runTransaction === "function") {
      await (db as any).runTransaction(apply);
    } else {
      await apply({
        get: (ref: any) => ref.get(),
        set: (ref: any, payload: any, opts?: any) => ref.set(payload, opts),
      });
    }
    return contained;
  };

  const pollOne = async (doc: any): Promise<"updated" | "polled"> => {
    const order = doc.data();
    const providerOrderId = String(order.dispatchOrderId ?? order.shadowfaxOrderId ?? "");
    try {
      const data = await getShadowfaxOrderStatus(providerOrderId);

      if (CANCELLED_PULL_STATUSES.has(pullStatus(data))) {
        await parkProviderCancelled(doc, order, data);
        // A8-2: contain the order (stop the tracker, alert staff, no rebook)
        // exactly like a webhook cancellation. `updatedAt` is NOT refreshed.
        const contained = await containProviderCancelled(doc, order, data);
        if (contained) {
          try {
            const { captureErrorSnapshot } = await import("../../core/errors");
            await captureErrorSnapshot({
              source: "dispatch",
              severity: "high",
              message:
                `Shadowfax cancelled booking ${String(order.dispatchOrderId ?? "").slice(0, 64)} ` +
                `for order ${doc.id} (observed by status polling, callback missed) — order ` +
                `parked for manual review, no rebook attempted`,
              orderId: doc.id,
              branchId: order.branchId,
              context: {
                provider: "shadowfax",
                providerOrderId: String(order.dispatchOrderId ?? "").slice(0, 64),
                observedBy: "poll",
              },
            });
          } catch {
            // Alert best-effort: the containment write is the durable state.
          }
          try {
            const branchId = typeof order.branchId === "string" ? order.branchId : "";
            if (branchId) {
              const { dispatchFCM } = await import("../notifications/fcm.service");
              await dispatchFCM({
                topic: `branch_${branchId}_orders`,
                title: "Delivery cancelled — manual review",
                body: `Order #${doc.id.substring(0, 6)}: Shadowfax cancelled the booking and the callback was missed (poll-confirmed). Staff must review — no rebook will be attempted.`,
                data: {
                  type: "dispatch_manual_review",
                  orderId: doc.id,
                  needsRebook: "false",
                  provider: "shadowfax",
                  observedBy: "poll",
                },
                purpose: "operational",
                actor: { trusted: true },
              });
            }
          } catch (err: any) {
            console.warn(
              "[Shadowfax Poll] branch alert for a contained cancellation failed:",
              err?.message || err
            );
          }
        }
        await doc.ref.set(
          {
            shadowfaxPolledAt: nowTs(),
            shadowfaxLastPollError: null,
          },
          { merge: true }
        );
        return "updated";
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

// ---------------------------------------------------------------------------
// Durable cancellation of a live remote booking (order cancelled by staff)
// ---------------------------------------------------------------------------
//
// P1-E. When the KITCHEN cancels an order (`bumpOrderStatus` "cancelled") that
// still has a live paid rider, the order becomes terminal — and the existing
// `dispatchCancel` route refuses terminal orders, so the rider kept driving to a
// cancelled order. The cancel must therefore happen as part of the order cancel,
// and it must survive a provider fault without failing the kitchen or refund.
//
// The mechanism is the SAME one the dispatch-ready signal uses, and the same
// 5-minute tick drives it: record the intent durably on the order, attempt it
// inline, and let `retryPendingShadowfaxCancels` finish the job. A failure is
// never silent: `dispatchCancelAlert` is written for staff, and the record
// dead-letters after SHADOWFAX_MAX_CANCEL_ATTEMPTS with a HIGH error snapshot.
//
// No blind retry of an ambiguous booking: only the documented `PUT .../cancel/`
// for the EXACT provider order id recorded at the stop, never a new booking, and
// a confirmation stops all further attempts.

/** Consecutive failed cancel attempts before the record dead-letters. */
export const SHADOWFAX_MAX_CANCEL_ATTEMPTS = 6;

export interface PendingCancelAttemptResult {
  state: "confirmed" | "pending" | "dead_lettered" | "not_attempted";
  attempts: number;
  lastError: string | null;
}

/**
 * A8-3: deliver the "you must cancel this in the provider dashboard" alert.
 *
 * Borzo and Porter expose no cancel API in our adapter, so the human step is
 * unavoidable — but it must REACH a human. Before this, the whole alert was a
 * `dispatchCancelAlert` field on the order document, so staff discovered the
 * live rider only when the rider called. This pushes through the existing
 * branch operational channel (`branch_<id>_orders`), the same lane the
 * Shadowfax dead-letter branch and the webhook rider-cancel alerts use.
 *
 * DEDUPED: a retried cancel (the customer retries, the order tick re-runs)
 * must not ring the branch twice for the SAME booking. The claim is a
 * deterministic marker document on the order (`dispatchCancelAlert` already
 * carries the booking pair), so the key is the provider + provider order id
 * and it is written before the send. A genuinely different booking (a rebook)
 * has a different key and does alert.
 *
 * Never throws: the caller's durable record is already the trail, and a
 * notification fault must never fail a cancellation.
 */
async function deliverManualCancelAlert(params: {
  orderId: string;
  provider: "borzo" | "porter" | "shadowfax";
  providerOrderId: string;
  reason: "staff_cancelled" | "order_cancelled";
  requestedBy: string;
}): Promise<{ alerted: boolean; channel: "branch" | null; reason: string }> {
  const { orderId, provider, providerOrderId, reason } = params;
  try {
    let branchId = "";
    try {
      const snap = await db.collection("orders").doc(orderId).get();
      const order = (snap?.exists ? snap.data() : undefined) as any;
      branchId = typeof order?.branchId === "string" ? order.branchId : "";
    } catch (err: any) {
      console.warn(
        `[Dispatch Cancel] could not read branch for order ${orderId}:`,
        err?.message || err
      );
    }

    const { captureErrorSnapshot } = await import("../../core/errors");
    const message =
      `Order ${orderId} was cancelled with a live ${provider} booking ${providerOrderId} that ` +
      `cannot be cancelled from here — a rider may still be driving to it. Cancel it in the ` +
      `${provider === "porter" ? "Porter enterprise" : "Borzo"} dashboard, then confirm ` +
      `(POST /dispatch/cancel/confirm).`;
    await captureErrorSnapshot({
      source: "dispatch",
      severity: "high",
      message,
      orderId,
      branchId: branchId || undefined,
      context: { provider, providerOrderId, reason, requestedBy: params.requestedBy },
    }).catch(() => undefined);

    if (!branchId) {
      // No branch → no topic to push to. The durable record + snapshot above are
      // the honest trail; never claim an alert that could not be sent.
      return { alerted: false, channel: null, reason: "no_branch" };
    }

    // Dedupe marker on the order itself: one alert per (provider, booking).
    // A retry for the same booking finds the marker and stays silent.
    const markerRef = db.collection("orders").doc(orderId);
    const previous = await markerRef.get().catch(() => undefined);
    const previousAlert = previous?.exists
      ? ((previous.data() as any)?.dispatchCancelAlert ?? null)
      : null;
    if (
      previousAlert &&
      previousAlert.code === "DISPATCH_CANCEL_MANUAL_REQUIRED" &&
      previousAlert.provider === provider &&
      String(previousAlert.providerOrderId ?? "") === providerOrderId &&
      previousAlert.alerted === true
    ) {
      return { alerted: true, channel: "branch", reason: "already_alerted" };
    }

    const { dispatchFCM } = await import("../notifications/fcm.service");
    const delivered = await dispatchFCM({
      topic: `branch_${branchId}_orders`,
      title: "Cancel this booking — order already cancelled",
      body: `Order #${orderId.substring(0, 6)} is cancelled but ${provider} booking ${providerOrderId} is still live. Cancel it in the ${provider === "porter" ? "Porter" : "Borzo"} dashboard now — a rider may be on the way.`,
      data: {
        type: "dispatch_cancel_manual_required",
        orderId,
        provider,
        providerOrderId: String(providerOrderId).slice(0, 64),
        reason,
        needsRebook: "false",
      },
      purpose: "operational",
      actor: { trusted: true },
    });
    if (delivered === false) {
      return { alerted: false, channel: null, reason: "transport_false" };
    }
    return { alerted: true, channel: "branch", reason: "sent" };
  } catch (err: any) {
    console.warn(
      `[Dispatch Cancel] manual cancel alert for order ${orderId} failed:`,
      err?.message || err
    );
    return { alerted: false, channel: null, reason: "send_failed" };
  }
}

/**
 * Records the cancel intent and makes ONE bounded attempt.
 *
 * `provider`: whichever provider holds the booking. Only Shadowfax can actually
 * be cancelled from here; Borzo/Porter raise a staff alert and stop, because a
 * blind call to an unconfirmed endpoint is fake traffic and a made-up success.
 *
 * The write is a plain per-field merge (never `undefined`), so the test shims and
 * Firestore converge on the same document.
 */
export async function recordAndAttemptProviderCancel(params: {
  orderId: string;
  provider: "borzo" | "shadowfax" | "porter" | null;
  providerOrderId: string | null;
  reason: "staff_cancelled" | "order_cancelled";
  requestedBy: string;
}): Promise<PendingCancelAttemptResult> {
  const { orderId, provider, reason, requestedBy } = params;
  const providerOrderId =
    params.providerOrderId != null && String(params.providerOrderId).trim()
      ? String(params.providerOrderId).trim()
      : null;

  const orderRef = db.collection("orders").doc(orderId);
  const base = buildPendingCancelWrite({
    provider,
    providerOrderId,
    reason,
    requestedBy,
  });

  // No provider / no booking: nothing remote to cancel, so nothing is recorded.
  if (!provider || !providerOrderId) {
    return { state: "not_attempted", attempts: 0, lastError: null };
  }

  if (!providerCanCancelRemotely(provider)) {
    // Borzo/Porter: no cancel API in our adapter, so a human must cancel it in
    // the provider dashboard. A8-3: the record alone is NOT an alert — a rider
    // can keep driving to a cancelled order while nobody looks at the order
    // document. The durable record stays exactly as it was (it still blocks a
    // replacement dispatch until staff confirm), and the alert is DELIVERED
    // through the existing staff notification channel, deduped per booking.
    const delivery = await deliverManualCancelAlert({
      orderId,
      provider,
      providerOrderId,
      reason,
      requestedBy,
    });
    await orderRef.set(
      {
        dispatchPendingCancel: base,
        dispatchCancelAlert: {
          code: "DISPATCH_CANCEL_MANUAL_REQUIRED",
          provider,
          providerOrderId,
          reason,
          requestedBy,
          message: manualCancelInstruction(provider, providerOrderId),
          // A8-3: honest delivery state. `alerted` is true only when the push
          // was actually handed to the staff channel (or was already delivered
          // for this booking); a branch-less order records `false` and escalates
          // through the snapshot instead of pretending it rang.
          alerted: delivery.alerted,
          alertChannel: delivery.channel,
          alertReason: delivery.reason,
          raisedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    return { state: "pending", attempts: 0, lastError: null };
  }

  // Ambiguous provider id: fail closed, no wire call, still visible to staff.
  if (!/^\d+$/.test(providerOrderId)) {
    const message = `Shadowfax cancellation needs the numeric booking id — got ${JSON.stringify(
      providerOrderId
    ).slice(0, 60)}. Cancel it in the Shadowfax dashboard and confirm.`;
    const delivery = await deliverManualCancelAlert({
      orderId,
      provider: "shadowfax",
      providerOrderId,
      reason,
      requestedBy,
    });
    await orderRef.set(
      {
        dispatchPendingCancel: { ...base, state: "dead_lettered", staffActionRequired: message },
        dispatchCancelAlert: {
          code: "DISPATCH_CANCEL_DEAD_LETTERED",
          provider,
          providerOrderId,
          reason,
          requestedBy,
          message,
          alerted: delivery.alerted,
          alertChannel: delivery.channel,
          alertReason: delivery.reason,
          raisedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    return { state: "dead_lettered", attempts: 0, lastError: message };
  }

  // Write the intent BEFORE the call so a crash mid-call still leaves the trail.
  await orderRef.set(
    { dispatchPendingCancel: { ...base, state: "pending" } },
    { merge: true }
  );
  return await attemptPendingProviderCancel(orderId, providerOrderId, base);
}

/**
 * One attempt against the provider for a record already on the order.
 * Never throws to its caller: the kitchen/refund flow must not depend on it.
 */
async function attemptPendingProviderCancel(
  orderId: string,
  providerOrderId: string,
  base: PendingDispatchCancel
): Promise<PendingCancelAttemptResult> {
  const orderRef = db.collection("orders").doc(orderId);
  const attempts = (typeof base.attempts === "number" ? base.attempts : 0) + 1;
  const now = admin.firestore.FieldValue.serverTimestamp();
  try {
    await cancelShadowfaxOrder(providerOrderId, "Cancelled by restaurant");
    const confirmed = buildPendingCancelConfirmation(
      { ...base, attempts, state: "pending" },
      "provider_cancel",
      null
    );
    await orderRef.set(
      {
        dispatchPendingCancel: confirmed,
        dispatchCancelAlert: null,
        updatedAt: now,
      },
      { merge: true }
    );
    return { state: "confirmed", attempts, lastError: null };
  } catch (err: any) {
    const message = String(err?.message || err).slice(0, 300);
    const deadLettered = attempts >= SHADOWFAX_MAX_CANCEL_ATTEMPTS;
    const staffActionRequired = deadLettered
      ? `${manualCancelInstruction("shadowfax", providerOrderId)} Automatic retries have stopped.`
      : null;
    try {
      await orderRef.set(
        {
          dispatchPendingCancel: {
            ...base,
            state: deadLettered ? "dead_lettered" : "pending",
            attempts,
            lastAttemptAt: now,
            lastError: message,
            staffActionRequired,
          },
          dispatchCancelAlert: {
            code: deadLettered ? "DISPATCH_CANCEL_DEAD_LETTERED" : "DISPATCH_CANCEL_PENDING",
            provider: "shadowfax",
            providerOrderId,
            reason: base.reason,
            requestedBy: base.requestedBy,
            message: deadLettered
              ? `A rider may still be driving to order ${orderId.slice(0, 8)}: the Shadowfax cancellation failed ${attempts} times (${message}). Cancel it in the Shadowfax dashboard now.`
              : `A rider may still be driving to order ${orderId.slice(0, 8)}: the Shadowfax cancellation failed (${message}). It is retried every 5 minutes.`,
            raisedAt: now,
          },
          updatedAt: now,
        },
        { merge: true }
      );
    } catch (writeErr: any) {
      console.error(
        `[Shadowfax Cancel] could not record the failed cancellation for order ${orderId}:`,
        writeErr?.message || writeErr
      );
    }
    if (deadLettered) {
      try {
        const { captureErrorSnapshot } = await import("../../core/errors");
        await captureErrorSnapshot({
          source: "dispatch",
          severity: "high",
          message: `Shadowfax cancellation dead-lettered for order ${orderId} after ${attempts} attempts — a rider may still be en route; cancel it in the dashboard`,
          orderId,
          context: { provider: "shadowfax", providerOrderId },
        });
      } catch {
        // Alert best-effort: the order document already carries the flag.
      }
    }
    return { state: deadLettered ? "dead_lettered" : "pending", attempts, lastError: message };
  }
}

export interface ShadowfaxCancelRetryResult {
  scanned: number;
  retriedCount: number;
  deadLetteredCount: number;
}

/**
 * Resends cancellation for order-cancel records that never landed.
 *
 * Only `reason: "order_cancelled"` records are retried here: a `staff_cancelled`
 * record is the P1-D "did you cancel it in the dashboard?" question, and only a
 * human can answer that. Dead-lettered records are excluded (they stop consuming
 * the window) but keep blocking a replacement dispatch — an un-cancelled rider
 * still owns the order.
 */
export async function retryPendingShadowfaxCancels(): Promise<ShadowfaxCancelRetryResult> {
  const result: ShadowfaxCancelRetryResult = { scanned: 0, retriedCount: 0, deadLetteredCount: 0 };
  if (!(config.shadowfax.apiKey || "").trim()) return result;

  let snap: any;
  try {
    // A8-7: the SCAN covers the whole `pending` set (cursor pages); only the
    // number of provider CALL attempts stays bounded per tick. A staff-cancelled
    // row used to fill the 25-row window and defer every order-cancelled retry
    // queued behind it indefinitely.
    snap = {
      docs: await scanActiveDocuments(
        (startAfterDoc?: any) => {
          const base = db
            .collection("orders")
            .where("dispatchPendingCancel.state", "==", "pending")
            .limit(ACTIVE_SCAN_PAGE);
          return startAfterDoc ? (base as any).startAfter(startAfterDoc) : base;
        },
        (order: any) => {
          const record = order?.dispatchPendingCancel;
          if (!record || record.state !== "pending") return false;
          // A staff release is a question only a human can answer (P1-D); this
          // worker only finishes cancellations that came from an ORDER cancel.
          if (record.reason !== "order_cancelled") return false;
          if (record.provider !== "shadowfax" || !record.providerOrderId) return false;
          return true;
        },
        SHADOWFAX_POLL_QUERY_LIMIT
      ),
    };
  } catch (err: any) {
    console.error("[Shadowfax Cancel] query failed:", err?.message || err);
    return result;
  }

  for (const doc of snap?.docs || []) {
    const order = doc.data ? doc.data() : undefined;
    const record = order?.dispatchPendingCancel as PendingDispatchCancel | undefined;
    if (!record || record.state !== "pending") continue;
    // Re-checked per document: the scan already filtered, and a row that
    // changed between the page read and this iteration is skipped, not guessed.
    if (record.reason !== "order_cancelled") continue;
    if (record.provider !== "shadowfax" || !record.providerOrderId) continue;
    result.scanned++;
    const outcome = await attemptPendingProviderCancel(
      doc.id,
      String(record.providerOrderId),
      record
    );
    if (outcome.state === "confirmed") result.retriedCount++;
    else if (outcome.state === "dead_lettered") result.deadLetteredCount++;
  }
  return result;
}

