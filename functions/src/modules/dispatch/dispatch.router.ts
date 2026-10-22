import * as admin from "firebase-admin";
import { db } from "../../core/firebase";
import { config } from "../../config/env";
import { isSafeDocId } from "../../core/security";
import { captureErrorSnapshot } from "../../core/errors";
import { assertOrderBranchAccess, type StaffCaller } from "../../core/middleware";
import {
  dropGpsMissingError,
  isRealCoordinatePair,
  pickupGpsMissingError,
  resolvePickupCoordinates,
  type PickupCoordinates,
} from "../../core/utils/pickupCoords";
import {
  checkBranchDeliveryServiceability,
  calculateHaversineDistanceKm,
} from "../../core/geo";
import {
  ACTIVE_DELIVERY_STATUSES,
  PROVIDER_PRIORITY,
  ProviderDispatchError,
  isProviderDispatchError,
  type DispatchAttemptRecord,
  type DispatchQuoteContext,
  type ProviderAdapter,
  type ProviderId,
  type ProviderQuoteOk,
  type ProviderQuoteOutcome,
} from "./types";
import { fareConfirmCheck } from "./providers/shared";
import { borzoAdapter } from "./providers/borzo.adapter";
import { shadowfaxAdapter } from "./providers/shadowfax.adapter";
import { porterAdapter } from "./providers/porter.adapter";
import {
  assertDispatchReadinessIfRequired,
  assertDispatchBookingReadinessIfRequired,
} from "./readiness";

/**
 * Multi-provider dispatch router (references/delivery_routing.md DR1–DR11).
 *
 * Quote: radius gate → parallel fan-out → cheapest serviceable wins (ties →
 * borzo > shadowfax > porter). Book: per-order claim → fresh re-quote (DR7) →
 * fare-delta confirm (DR7) → bounded ranked walk (DR6) → Porter manual lane
 * (DR8) → persist one normalized lifecycle (DR9). Per-provider failures are
 * recorded, never silently priced (DR2).
 */

/** Fixed branch-radius for quote contexts without a branch record (DR4). */
const DEFAULT_SERVICED_RADIUS_KM = 8.0;
const QUOTE_TTL_SECONDS = 600;

/** Priority-ordered registry — iteration order IS tie-break + failover order. */
const ADAPTERS: ProviderAdapter[] = [borzoAdapter, shadowfaxAdapter, porterAdapter];

// ---------------------------------------------------------------------------
// Claim (per-order double-book guard, cross-provider)
// ---------------------------------------------------------------------------

/** Pending-claim lease: a crash between claim and POST must not park the
 * order in dispatch_pending forever (every future book would 202). */
const DISPATCH_CLAIM_TTL_MS = 10 * 60 * 1000;

function claimFreshMs(claimedAt: any): number {
  // Numeric local-clock lease (never a serverTimestamp sentinel: no toMillis
  // on re-read — see porter.service porterClaimFreshMs).
  if (typeof claimedAt === "number" && Number.isFinite(claimedAt)) return claimedAt;
  return claimedAt && typeof claimedAt.toMillis === "function" ? claimedAt.toMillis() : 0;
}

/** ProviderDispatchError.kind → the wire-level outcome vocabulary (DR3/DR6). */
function failureOutcome(kind: "not_serviced" | "transient"): "not_serviced" | "transient_failure" {
  return kind === "not_serviced" ? "not_serviced" : "transient_failure";
}

function dispatchInProgressError(): Error {
  // Immediate 202 (no blocking poll): the client retries with the same body —
  // by then the winning tap has settled. Posting here is exactly the
  // double-book this guard exists to prevent.
  const retry: any = new Error(
    "Dispatch already in progress for this order — please retry in a couple of seconds (no second rider will be booked)."
  );
  retry.statusCode = 202;
  retry.code = "DISPATCH_IN_PROGRESS";
  retry.retryAfterMs = 2000;
  return retry;
}

function terminalError(deliveryStatus: string): Error {
  const err: any = new Error(
    `This order is already ${deliveryStatus} — dispatch is locked. Use the order timeline for post-delivery actions.`
  );
  err.statusCode = 409;
  err.code = "DISPATCH_LOCKED";
  return err;
}

/** Drops undefined values — Firestore rejects them inside any write payload. */
function definedFields(o: Record<string, any>): Record<string, any> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}

function isActiveDispatch(d: any): boolean {
  const active = (ACTIVE_DELIVERY_STATUSES as readonly string[]).includes(d?.deliveryStatus);
  const hasProviderOrder = !!(d?.dispatchOrderId || d?.porterOrderId);
  return active && hasProviderOrder;
}

function isFreshGenericPending(d: any): boolean {
  return (
    d?.dispatchStatus === "dispatch_pending" &&
    Date.now() - claimFreshMs(d?.dispatchClaimedAt) < DISPATCH_CLAIM_TTL_MS
  );
}

/** Porter's own claim (direct /porter/book taps) also blocks our book. */
function isFreshPorterPending(d: any): boolean {
  return (
    d?.porterDispatchStatus === "dispatch_pending" &&
    Date.now() - claimFreshMs(d?.porterDispatchClaimedAt) < DISPATCH_CLAIM_TTL_MS
  );
}

function storedDispatchSummary(d: any): any {
  return {
    provider: (d?.dispatchProvider as ProviderId) || (d?.porterOrderId ? "porter" : null),
    providerOrderId: d?.dispatchOrderId || d?.porterOrderId || null,
    porterOrderId: d?.porterOrderId || null,
    riderName: d?.riderName || null,
    riderPhone: d?.riderPhone || null,
    riderVehicleNumber: d?.riderVehicleNumber || null,
    trackingUrl: d?.riderTrackingUrl || null,
    status: "dispatched",
    dispatchSource: d?.dispatchSource || null,
    geoSource: d?.dispatchGeoSource || null,
    reused: true as const,
  };
}

/**
 * Per-order claim across ALL providers: stored summary for idempotent replay,
 * 202 on a fresh competing claim (generic OR porter's own), otherwise claim
 * dispatch_pending and return null (caller proceeds). Transaction-then-work
 * when available; read-check + direct claim on test shims without it.
 */
async function claimDispatch(orderDoc: any, order: any): Promise<any | null> {
  const claimWrite = {
    dispatchStatus: "dispatch_pending",
    dispatchClaimedAt: Date.now(),
  };
  const busyCheck = (d: any) => isFreshGenericPending(d) || isFreshPorterPending(d);

  if (db && typeof (db as any).runTransaction === "function") {
    const outcome: any = await (db as any).runTransaction(async (tx: any) => {
      const fresh = await tx.get(orderDoc.ref);
      const d = (fresh.exists ? fresh.data() : undefined) as any;
      if (!d) return { claimed: true };
      if (isActiveDispatch(d)) return { reuse: true, data: d };
      if (busyCheck(d)) return { busy: true };
      tx.set(orderDoc.ref, claimWrite, { merge: true });
      return { claimed: true };
    });
    if (outcome?.reuse) return storedDispatchSummary(outcome.data);
    if (outcome?.busy) throw dispatchInProgressError();
    return null;
  }

  // Fallback for Firestore shims without transactions (tests): same rules.
  if (isActiveDispatch(order)) return storedDispatchSummary(order);
  if (busyCheck(order)) throw dispatchInProgressError();
  await orderDoc.ref.set(claimWrite, { merge: true });
  return null;
}

async function releaseClaimIdle(orderDoc: any, extra: Record<string, any> = {}): Promise<void> {
  try {
    await orderDoc.ref.set(
      {
        dispatchStatus: null,
        dispatchClaimedAt: null,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        ...extra,
      },
      { merge: true }
    );
  } catch {
    // Best-effort: the caller surfaces the outcome either way.
  }
}

async function releaseClaimFailed(
  orderDoc: any,
  message: string,
  attempts: DispatchAttemptRecord[],
  quoteSnapshot?: any
): Promise<void> {
  try {
    await orderDoc.ref.set(
      {
        dispatchStatus: "dispatch_failed",
        dispatchClaimedAt: null,
        dispatchError: message,
        dispatchAttempts: attempts,
        ...(quoteSnapshot ? { dispatchQuote: quoteSnapshot } : {}),
        // Enables the /dispatch/rebook guard without flipping deliveryStatus.
        needsRebook: true,
        // Auto-rebook trigger (mission §3): the scheduled worker retries a
        // failed dispatch up to AUTO_REBOOK_MAX_ATTEMPTS times. A carrier
        // cancel keeps its own trigger — releaseClaimFailed must not erase it.
        ...(orderDoc.data?.()?.rebookTrigger === "carrier_cancelled"
          ? {}
          : { rebookTrigger: "dispatch_failed" }),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  } catch {
    // Best-effort: snapshot below is the durable trail.
  }
  try {
    await captureErrorSnapshot({
      source: "dispatch",
      severity: "high",
      message: `Dispatch failed for order ${orderDoc.id}: ${message} (${attempts.length} attempt(s))`,
      orderId: orderDoc.id,
    });
  } catch {
    // Snapshot best-effort.
  }
}

// ---------------------------------------------------------------------------
// Quote fan-out (DR2/DR5)
// ---------------------------------------------------------------------------

async function quoteWithTimeout(
  adapter: ProviderAdapter,
  ctx: DispatchQuoteContext
): Promise<ProviderQuoteOutcome> {
  const timeoutMs = config.dispatch.quoteTimeoutMs;
  let timer: any;
  try {
    const result = await Promise.race([
      adapter.quote(ctx),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new ProviderDispatchError(
                adapter.provider,
                "transient",
                `${adapter.provider} quote timed out after ${timeoutMs}ms`
              )
            ),
          timeoutMs
        );
      }),
    ]);
    return result;
  } catch (err: any) {
    if (isProviderDispatchError(err)) {
      return { provider: adapter.provider, outcome: failureOutcome(err.kind), error: err.message };
    }
    return {
      provider: adapter.provider,
      outcome: "transient_failure",
      error: err?.message || `${adapter.provider} quote failed`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Parallel fan-out over every eligible provider (DR5). Never throws for a
 * single provider: each result is ok / not_serviced / transient_failure (DR3),
 * ordered by provider priority for stable UI rendering.
 */
async function runQuoteFanOut(
  ctx: DispatchQuoteContext
): Promise<{ outcomes: ProviderQuoteOutcome[]; ranked: ProviderQuoteOk[] }> {
  const eligible = ADAPTERS.filter((a) => a.isEligible());
  // DR5 names Promise.allSettled: quoteWithTimeout cannot reject today, but the
  // fan-out's safety must not hang off that invariant holding forever.
  const settled = await Promise.allSettled(eligible.map((a) => quoteWithTimeout(a, ctx)));
  const outcomes: ProviderQuoteOutcome[] = settled.map((result, index) => {
    if (result.status === "fulfilled") return result.value;
    const provider = eligible[index].provider;
    const reason: unknown = result.reason;
    return {
      provider,
      outcome: "transient_failure",
      error:
        reason instanceof Error && reason.message
          ? reason.message
          : `${provider} quote failed`,
    };
  });
  const ranked = outcomes
    .filter((o): o is ProviderQuoteOk => o.outcome === "ok")
    .sort((a, b) => a.fare - b.fare || PROVIDER_PRIORITY[a.provider] - PROVIDER_PRIORITY[b.provider]);
  return { outcomes, ranked };
}

// ---------------------------------------------------------------------------
// Order-level preconditions (mirror bookPorterRider, fail-closed GPS)
// ---------------------------------------------------------------------------

function assertOrderDispatchable(order: any): void {
  if (!order.customerPhone) {
    throw new Error(
      "Customer phone number is missing — edit the order to add it, then retry dispatch."
    );
  }
  const orderType = order.orderType || order.fulfillment || "delivery";
  const drop = order.deliveryAddress || order.address;
  if (orderType === "delivery" && !(drop?.street || drop?.full || (drop?.lat && drop?.lng))) {
    throw new Error("Delivery address is incomplete — add street or map pin, then retry dispatch.");
  }
  // Fail-closed GPS for EVERY dispatch (H-R19): dispatch quote/book never
  // invents a drop pin — a textual address without coordinates is refused
  // (422, retryable), never routed to fallback defaults.
  if (!(drop?.lat && drop?.lng)) throw dropGpsMissingError();
  // Fail-closed PICKUP GPS (H-R19 parity): a courier booked against a
  // fabricated pickup would be sent to the wrong store — the same class of
  // fake as a fabricated drop pin. Resolved separately (order snapshot →
  // branch document) by resolvePickupCoordinates, still pre-claim; a miss
  // throws DISPATCH_PICKUP_GPS_MISSING (422, retryable).
}

function assertDispatchNotLocked(order: any): void {
  const ds = order?.deliveryStatus;
  if (ds === "delivered" || ds === "cancelled") throw terminalError(ds);
}

/**
 * Builds the quote context from REAL coordinates only: pickup is resolved
 * pre-claim (order snapshot → branch document — see resolvePickupCoordinates)
 * and the drop was validated in assertOrderDispatchable. No default city pin,
 * no null island: a miss never reaches here (422 upstream).
 */
function buildQuoteContext(
  order: any,
  params: Partial<DispatchQuoteParams> & { staffName?: string; caller?: StaffCaller },
  pickup: PickupCoordinates
): { ctx: DispatchQuoteContext; geoSource: "live_gps" } {
  return {
    ctx: {
      pickup: { lat: pickup.lat, lng: pickup.lng },
      drop: {
        lat: order.deliveryAddress?.lat ?? order.address?.lat,
        lng: order.deliveryAddress?.lng ?? order.address?.lng,
      },
      customerName: order.customerName || params.customerName,
      customerPhone: order.customerPhone || params.customerPhone,
      orderId: params.orderId,
      order,
      staffName: params.staffName,
      caller: params.caller,
    },
    geoSource: "live_gps",
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface DispatchQuoteParams {
  pickupLat: number;
  pickupLng: number;
  dropLat: number;
  dropLng: number;
  customerName?: string;
  customerPhone?: string;
  orderId?: string;
}

/**
 * POST /dispatch/quote: null-island guard (fail closed 422) → radius gate
 * (DR4) → parallel fan-out (DR5) → cheapest serviceable wins (DR1). Radius
 * failure is a 200 with
 * serviceable:false (the address simply is not in zone); a fan-out with zero
 * ok providers fails closed 503 — never a static fare (DR2).
 */
export async function dispatchQuote(params: DispatchQuoteParams): Promise<any> {
  // Opt-in test-window gate (DISPATCH_REQUIRE_LIVE, round-3 N1(b)): refuse before
  // any provider traffic if a dispatch mock is active, the agreed test courier is
  // not genuinely callable, or it would be sent to a live host. Default OFF, so
  // dev and production behaviour is unchanged.
  assertDispatchReadinessIfRequired();
  // NULL-ISLAND GUARD (zero-fake, DR2): a (0,0)/out-of-range pin is not
  // "outside the delivery zone" — it is a broken map pin. Fail closed 422
  // BEFORE the radius gate so we never quote a fare computed from a point in
  // the Gulf of Guinea (or hand garbage coordinates to a live carrier API).
  if (
    !isRealCoordinatePair(params.pickupLat, params.pickupLng) ||
    !isRealCoordinatePair(params.dropLat, params.dropLng)
  ) {
    throw coordinatesInvalidError();
  }

  const gate = checkBranchDeliveryServiceability(
    params.pickupLat,
    params.pickupLng,
    params.dropLat,
    params.dropLng,
    DEFAULT_SERVICED_RADIUS_KM
  );
  if (!gate.isServiced) {
    return {
      serviceable: false,
      reason: "not_serviced",
      distanceKm: gate.distanceKm,
      servicedRadiusKm: gate.servicedRadiusKm,
      message: gate.reason,
    };
  }

  const { outcomes, ranked } = await runQuoteFanOut({
    pickup: { lat: params.pickupLat, lng: params.pickupLng },
    drop: { lat: params.dropLat, lng: params.dropLng },
    customerName: params.customerName,
    customerPhone: params.customerPhone,
    orderId: params.orderId,
  });

  if (ranked.length === 0) throw noServiceableProviderError(outcomes);

  const winner = ranked[0];
  return {
    serviceable: true,
    winner: winner.provider,
    providers: outcomes,
    quotedAt: Date.now(),
    // Flattened winner fields for back-compat with the Porter quote shape.
    estimatedFare: winner.fare,
    estimatedDistanceKm: winner.distanceKm,
    estimatedPickupMinutes: winner.pickupEtaMinutes,
    // TRUE when that ETA is our local estimate rather than provider data, so a
    // consumer never presents a fallback number as the courier's own ETA.
    pickupEtaEstimated: winner.etaEstimated === true,
    quoteId: winner.quoteId,
    vehicleType: "2-Wheeler (Bike Express)",
    source: winner.source,
    expiresAt: winner.expiresAt,
    validForSeconds: QUOTE_TTL_SECONDS,
  };
}

function noServiceableProviderError(outcomes: ProviderQuoteOutcome[]): Error {
  const err: any = new Error(
    "No delivery provider currently services this address — delivery unavailable. Assign an in-house rider to keep this order moving."
  );
  err.statusCode = 503;
  err.code = "NO_SERVICEABLE_PROVIDER";
  err.serviceable = false;
  err.reason = "NO_SERVICEABLE_PROVIDER";
  err.providers = outcomes;
  return err;
}

/** Typed, retryable 422 — one of the quote pins is null-island or garbage. */
function coordinatesInvalidError(): Error {
  const err: any = new Error(
    "Pickup or delivery coordinates are invalid — re-pin the address on the map, then retry the quote."
  );
  err.statusCode = 422;
  err.code = "DISPATCH_COORDINATES_INVALID";
  return err;
}

export interface DispatchBookParams {
  orderId: string;
  staffName?: string;
  caller?: StaffCaller;
  /** Staff-confirmed fare from the quote card — gates the DR7 delta check. */
  quotedFare?: number;
  confirmFare?: boolean;
  /** Optional staff override: book this provider first when it quoted ok. */
  preferredProvider?: ProviderId;
  /**
   * Auto-rebook guard (mission §3): providers the worker must NOT re-book —
   * normally the carrier that just cancelled. Applied AFTER the ranked walk
   * order is built, so an excluded provider is never reached even when it is
   * cheapest. Empty/absent = no exclusion (staff manual rebook keeps DR1).
   */
  excludeProviders?: ProviderId[];
}

/**
 * POST /dispatch/book (§3): claim → fresh fan-out (DR7) → fare confirm →
 * bounded ranked walk (DR6) → Porter manual lane (DR8) → normalized persist.
 */
export async function dispatchBook(params: DispatchBookParams): Promise<any> {
  assertDispatchReadinessIfRequired();
  assertDispatchBookingReadinessIfRequired();
  const { orderId, staffName, caller } = params;
  const orderDoc = await db.collection("orders").doc(orderId).get();
  if (!orderDoc.exists) {
    const missing: any = new Error(`Order ${orderId} not found`);
    missing.statusCode = 404;
    missing.code = "ORDER_NOT_FOUND";
    throw missing;
  }
  const order = orderDoc.data()!;
  if (caller) await assertOrderBranchAccess(caller, order);

  assertDispatchNotLocked(order);
  assertOrderDispatchable(order);
  // Pickup GPS resolved BEFORE the claim (a bad order never parks a lease):
  // branchCoordinates snapshot → order.store → branches/{branchId}.coordinates.
  const pickup = await resolvePickupCoordinates(order);
  if (!pickup) throw pickupGpsMissingError();

  // Per-order idempotency gate before any provider call (double-book guard).
  const reuse = await claimDispatch(orderDoc, order);
  if (reuse) return reuse;

  const { ctx, geoSource } = buildQuoteContext(order, params, pickup);

  const gate = checkBranchDeliveryServiceability(
    ctx.pickup.lat,
    ctx.pickup.lng,
    ctx.drop.lat,
    ctx.drop.lng,
    DEFAULT_SERVICED_RADIUS_KM
  );
  if (!gate.isServiced) {
    await releaseClaimIdle(orderDoc);
    const err: any = new Error(
      gate.reason || "Delivery address is outside the branch delivery zone."
    );
    err.statusCode = 409;
    err.code = "NOT_SERVICED";
    throw err;
  }

  const { outcomes, ranked } = await runQuoteFanOut(ctx);

  if (ranked.length === 0) {
    const eligibleCount = ADAPTERS.filter((a) => a.isEligible()).length;
    if (eligibleCount === 0) {
      // Nothing configured — a config problem, not an order failure: leave
      // the order clean so staff can retry once keys land.
      await releaseClaimIdle(orderDoc);
      throw noServiceableProviderError(outcomes);
    }
    await releaseClaimFailed(
      orderDoc,
      "All eligible providers failed to quote",
      [],
      { winner: null, providers: outcomes, quotedAt: Date.now() }
    );
    throw noServiceableProviderError(outcomes);
  }

  const quoteSnapshot = {
    winner: ranked[0].provider,
    providers: outcomes,
    quotedAt: Date.now(),
    expiresAt: ranked[0].expiresAt,
  };

  // Ranked walk order: preferred provider first when it quoted ok (staff
  // override), otherwise pure cheapest-wins order (DR1).
  let walk = ranked;
  if (params.preferredProvider) {
    const preferred = ranked.filter((q) => q.provider === params.preferredProvider);
    const rest = ranked.filter((q) => q.provider !== params.preferredProvider);
    walk = [...preferred, ...rest];
  }
  // Auto-rebook exclusion: the carrier that cancelled (or failed) is never
  // re-booked by the scheduled worker — otherwise the worker would just
  // re-book the same provider and cancel-loop forever.
  if (params.excludeProviders && params.excludeProviders.length > 0) {
    const excluded = new Set<string>(params.excludeProviders);
    walk = walk.filter((q) => !excluded.has(q.provider));
  }
  const cheapest = ranked[0].provider;

  // DR7: a fare that drifted past the confirm threshold needs staff sign-off
  // before anything is committed. Measured against walk[0] — the quote the
  // walk will actually commit — never the fan-out cheapest: the staff must
  // confirm the fare of the provider that will be booked, and an excluded
  // provider must not lend its approved fare to a booking it will not serve.
  // Claim released — the confirm retry re-claims (no parked
  // dispatch_pending on an unbooked confirm step).
  if (walk.length > 0 && typeof params.quotedFare === "number" && params.confirmFare !== true) {
    const commit = walk[0];
    const check = fareConfirmCheck(
      params.quotedFare,
      commit.fare,
      config.dispatch.fareConfirmDeltaInr
    );
    if (check.needsConfirm) {
      await releaseClaimIdle(orderDoc, { dispatchQuote: quoteSnapshot });
      return {
        needsFareConfirm: true,
        provider: commit.provider,
        quotedFare: params.quotedFare,
        newFare: commit.fare,
        delta: Math.round(check.delta * 100) / 100,
        threshold: Math.round(check.threshold * 100) / 100,
        confirmEndpoint: "/dispatch/book",
        message: `Fare changed since the quote (₹${check.delta.toFixed(2)}). Confirm to book at the new fare.`,
      };
    }
  }

  const attempts: DispatchAttemptRecord[] = [];
  let manual: any = null;
  let booked: any = null;

  for (const quote of walk) {
    const adapter = ADAPTERS.find((a) => a.provider === quote.provider)!;
    try {
      const result = await adapter.book({ ...ctx, orderId, quote });
      if (result.kind === "booked") {
        booked = { ...result, quote };
        attempts.push({ provider: quote.provider, outcome: "booked", at: Date.now() });
        break;
      }
      manual = { ...result, quote };
      attempts.push({ provider: quote.provider, outcome: "manual_required", at: Date.now() });
      break;
    } catch (err: any) {
      if (isProviderDispatchError(err)) {
        // DR6 (bounded failover): transient AND book-time not_serviced both
        // walk on to the next serviceable quote; the attempt is recorded.
        attempts.push({
          provider: quote.provider,
          outcome: failureOutcome(err.kind),
          error: err.message,
          at: Date.now(),
        });
        continue;
      }
      // Unexpected error = a bug or an order-level abort: release the claim
      // so staff can retry, then surface loudly (never half-book silently).
      await releaseClaimFailed(
        orderDoc,
        err?.message || "Unexpected dispatch error",
        attempts,
        quoteSnapshot
      );
      throw err;
    }
  }

  if (manual) {
    // DR8: no status flip — order stays actionable, paste form takes over.
    await orderDoc.ref.set(
      {
        dispatchStatus: "manual_pending",
        dispatchClaimedAt: null,
        // The staff paste lane now owns this order: clear any auto-rebook
        // flag/trigger so the scheduled worker cannot race the paste flow
        // with a second (automatic) booking.
        needsRebook: false,
        rebookTrigger: null,
        dispatchQuote: quoteSnapshot,
        dispatchAttempts: attempts,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    return {
      manual_action_required: true,
      provider: manual.provider,
      instructions: manual.instructions,
      pasteEndpoint: manual.pasteEndpoint,
      orderId,
      quotes: quoteSnapshot,
      attempts,
    };
  }

  if (!booked) {
    const detail = attempts
      .map((a) => `${a.provider}: ${a.outcome}${a.error ? ` (${a.error})` : ""}`)
      .join("; ");
    await releaseClaimFailed(orderDoc, `All providers failed — ${detail}`, attempts, quoteSnapshot);
    const err: any = new Error(
      "All delivery providers failed to accept this booking — retry, or assign an in-house rider."
    );
    err.statusCode = 502;
    err.code = "DISPATCH_FAILED";
    err.attempts = attempts;
    throw err;
  }

  // DR9: one normalized lifecycle regardless of which provider booked.
  const write: Record<string, any> = {
    dispatchProvider: booked.provider,
    dispatchOrderId: booked.providerOrderId,
    deliveryStatus: "dispatched",
    dispatchStatus: "dispatched",
    dispatchClaimedAt: null,
    dispatchError: null,
    riderName: booked.riderName,
    riderPhone: booked.riderPhone,
    riderVehicleNumber: booked.riderVehicleNumber,
    riderTrackingUrl: booked.trackingUrl || null,
    dispatchQuote: quoteSnapshot,
    dispatchAttempts: attempts,
    dispatchGeoSource: booked.geoSource || geoSource,
    dispatchSource: booked.source || "api",
    dispatchedBy: staffName || "unattributed",
    dispatchedAt: admin.firestore.FieldValue.serverTimestamp(),
    needsRebook: false,
    // A successful book clears the auto-rebook trigger: the order is live
    // again, so the scheduled worker must stop seeing it as pending.
    rebookTrigger: null,
    autoRebookAttempts: 0,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  // Provider aliases: exactly ONE is non-null per order (the active
  // dispatch). Stale ids from a previous carrier are nulled so a late
  // webhook/poller can never bind an OLD booking to the new dispatch.
  write.porterOrderId = booked.provider === "porter" ? booked.providerOrderId : null;
  write.borzoOrderId = booked.provider === "borzo" ? booked.providerOrderId : null;
  write.shadowfaxOrderId = booked.provider === "shadowfax" ? booked.providerOrderId : null;

  // `order.delivery` sub-object mirror (frontend tracking contract): a
  // COMPLETE snapshot built from the pre-write order + this book result, so
  // Firestore's deep merge and the shallow-merge test shims converge on the
  // same object. `undefined` is stripped — Firestore rejects it inside a
  // write payload.
  const prevDelivery =
    order.delivery && typeof order.delivery === "object" ? order.delivery : {};
  write.delivery = definedFields({
    ...prevDelivery,
    provider: booked.provider,
    providerOrderId: String(booked.providerOrderId),
    status: booked.riderName ? "rider_assigned" : "pending",
    riderName: booked.riderName ?? null,
    riderPhone: booked.riderPhone ?? null,
    riderVehicleNumber: booked.riderVehicleNumber ?? null,
    trackingUrl: booked.trackingUrl || null,
    // New dispatch = the previous rider's GPS is stale (and would be fake
    // data for the new carrier). Cleared until a real callback lands.
    riderLocation: null,
    riderLocationAt: null,
    assignedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  await orderDoc.ref.set(write, { merge: true });

  // Server orderId mapping: bind provider order id → our orderId so the
  // webhook resolves through the map (hint stays a hint, DR10).
  try {
    if (isSafeDocId(booked.providerOrderId)) {
      await db
        .collection("dispatch_order_map")
        .doc(booked.providerOrderId)
        .set(
          {
            orderId,
            provider: booked.provider,
            branchId: order.branchId || null,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
    }
  } catch (mapErr: any) {
    console.warn("[Dispatch] order-map write failed (non-blocking):", mapErr?.message || mapErr);
  }

  // Failover = the first provider we tried to book did NOT succeed; a
  // staff-preferred provider booking over a cheaper quote is not a failover.
  const firstAttempted = walk[0].provider;
  const failover =
    booked.provider !== firstAttempted
      ? { from: firstAttempted, to: booked.provider, cheapestProvider: cheapest }
      : undefined;

  return {
    provider: booked.provider,
    providerOrderId: booked.providerOrderId,
    riderName: booked.riderName,
    riderPhone: booked.riderPhone,
    riderVehicleNumber: booked.riderVehicleNumber,
    trackingUrl: booked.trackingUrl || "",
    status: "dispatched",
    source: booked.source || "api",
    attempts,
    failover,
    reused: booked.reused === true,
    orderId,
  };
}

/** POST /dispatch/rebook: mirrors the porter rebook guard, re-enters §3. */
export async function dispatchRebook(params: DispatchBookParams): Promise<any> {
  const orderSnap = await db.collection("orders").doc(params.orderId).get();
  const order = (orderSnap.exists ? orderSnap.data() : undefined) as any;
  if (!order) {
    const missing: any = new Error(`Order ${params.orderId} not found`);
    missing.statusCode = 404;
    missing.code = "ORDER_NOT_FOUND";
    throw missing;
  }
  const rebookable =
    order?.needsRebook === true ||
    // `dispatchStatus` covers failed dispatches whose `needsRebook` flag the
    // auto-rebook worker clears after exhausting its attempts (see
    // autoRebookDispatchWorker) — staff must still be able to rebook those.
    order?.dispatchStatus === "dispatch_failed" ||
    ["rider_cancelled", "needs_review", "dispatch_failed"].includes(order?.deliveryStatus);
  if (!rebookable) {
    const err: any = new Error(
      "This order is not waiting for a rebook — only cancelled, failed, or review-flagged dispatches can be rebooked."
    );
    err.statusCode = 409;
    err.code = "NOT_REBOOKABLE";
    throw err;
  }
  return dispatchBook(params);
}

// ---------------------------------------------------------------------------
// Auto-rebook worker (mission §3): a carrier cancel or a dispatch failure
// re-dispatches the order with the NEXT provider automatically, bounded —
// never the provider that cancelled, never more than AUTO_REBOOK_MAX_ATTEMPTS
// automatic tries, never for a staff-initiated cancel (`staff_cancelled`).
// ---------------------------------------------------------------------------

export const AUTO_REBOOK_MAX_ATTEMPTS = 2;
export const AUTO_REBOOK_QUERY_LIMIT = 25;

export interface AutoRebookWorkerResult {
  scanned: number;
  rebooked: number;
  failed: number;
  busy: number;
  skipped: number;
  exhausted: number;
}

/** Providers that must NOT be re-booked: whoever last owned this dispatch. */
function excludedProvidersFor(order: any): ProviderId[] {
  const excluded = new Set<ProviderId>();
  if (order?.dispatchProvider) excluded.add(order.dispatchProvider as ProviderId);
  if (order?.porterOrderId) excluded.add("porter");
  if (order?.borzoOrderId) excluded.add("borzo");
  if (order?.shadowfaxOrderId) excluded.add("shadowfax");
  return [...excluded];
}

/**
 * Clears `needsRebook` for an order the worker will never act on (terminal,
 * staff-owned, or exhausted). Without this, poison rows keep matching the
 * `needsRebook == true` scan forever and, past AUTO_REBOOK_QUERY_LIMIT of
 * them, crowd every legitimate rebook out of the window — the starvation
 * half of the auto-rebook livelock. Manual rebook stays open afterwards via
 * the deliveryStatus/dispatchStatus guards in dispatchRebook.
 */
async function clearRebookFlag(doc: any, extra: Record<string, any> = {}): Promise<void> {
  try {
    await doc.ref.set(
      {
        needsRebook: false,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        ...extra,
      },
      { merge: true }
    );
  } catch (writeErr: any) {
    console.error("[Auto Rebook] flag-clear write failed:", writeErr?.message || writeErr);
  }
}

/**
 * Scheduled (5-min) auto-rebook: scans `needsRebook` orders and re-enters §3
 * for the ones a CARRIER (or a dispatch failure) flagged. Staff cancels are
 * filtered out by trigger, terminal states are filtered out defensively, and
 * every automatic attempt is counted so a poison order stops after
 * AUTO_REBOOK_MAX_ATTEMPTS instead of paying for riders forever.
 *
 * Every order the worker skips or exhausts has its `needsRebook` flag
 * cleared, so it drops out of the scan window on the next run instead of
 * starving actionable orders once the window (AUTO_REBOOK_QUERY_LIMIT) is
 * full. Note: FIFO ordering of the window would need a composite
 * `orders(needsRebook, updatedAt)` index, which is not in
 * firestore.indexes.json (outside this module's ownership) — draining the
 * window is what actually prevents the starvation/livelock.
 */
export async function autoRebookDispatchWorker(): Promise<AutoRebookWorkerResult> {
  const result: AutoRebookWorkerResult = {
    scanned: 0,
    rebooked: 0,
    failed: 0,
    busy: 0,
    skipped: 0,
    exhausted: 0,
  };

  let snap: any;
  try {
    snap = await db
      .collection("orders")
      .where("needsRebook", "==", true)
      .limit(AUTO_REBOOK_QUERY_LIMIT)
      .get();
  } catch (err: any) {
    // Fail closed: a worker that cannot read must not dispatch anything.
    console.error("[Auto Rebook] query failed:", err?.message || err);
    return result;
  }

  for (const doc of snap?.docs || []) {
    const order = doc.data ? doc.data() : undefined;
    if (!order) continue;
    result.scanned++;

    const trigger = order.rebookTrigger;
    // Only automatic triggers: `staff_cancelled` (and legacy rows with no
    // trigger) stay with staff — the worker never re-dispatches them. The
    // flag is cleared so the row leaves the scan window (staff rebook stays
    // open via the rider_cancelled/dispatch_failed deliveryStatus guards).
    if (trigger !== "carrier_cancelled" && trigger !== "dispatch_failed") {
      result.skipped++;
      await clearRebookFlag(doc);
      continue;
    }
    // Defensive terminal guard: never pay for a rider on a done/cancelled order.
    if (
      order.deliveryStatus === "delivered" ||
      order.deliveryStatus === "cancelled" ||
      order.status?.terminal === true ||
      order.status?.code === "DELIVERED"
    ) {
      result.skipped++;
      await clearRebookFlag(doc);
      continue;
    }
    const attempts = Number.isInteger(order.autoRebookAttempts)
      ? order.autoRebookAttempts
      : 0;
    if (attempts >= AUTO_REBOOK_MAX_ATTEMPTS) {
      result.exhausted++;
      await clearRebookFlag(doc, { autoRebookExhaustedAt: admin.firestore.FieldValue.serverTimestamp() });
      continue;
    }

    try {
      await dispatchBook({
        orderId: doc.id,
        staffName: "Auto Rebook",
        excludeProviders: excludedProvidersFor(order),
      });
      result.rebooked++;
    } catch (err: any) {
      // 202 = a staff book is in flight right now — not an attempt, no count.
      if (err?.statusCode === 202) {
        result.busy++;
        continue;
      }
      result.failed++;
      const nextAttempts = attempts + 1;
      const exhaustedNow = nextAttempts >= AUTO_REBOOK_MAX_ATTEMPTS;
      try {
        await doc.ref.set(
          {
            autoRebookAttempts: nextAttempts,
            autoRebookLastError: String(err?.message || err).slice(0, 300),
            // On the final failed attempt the flag is cleared so the order
            // stops matching the scan window; staff rebook stays open via
            // dispatchRebook's dispatchStatus === "dispatch_failed" guard.
            ...(exhaustedNow
              ? {
                  needsRebook: false,
                  autoRebookExhaustedAt: admin.firestore.FieldValue.serverTimestamp(),
                }
              : {}),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
      } catch (writeErr: any) {
        console.error(
          "[Auto Rebook] attempt-count write failed:",
          writeErr?.message || writeErr
        );
      }
      if (exhaustedNow) {
        result.exhausted++;
        try {
          await captureErrorSnapshot({
            source: "dispatch",
            severity: "high",
            message: `Auto-rebook exhausted for order ${doc.id} after ${nextAttempts} attempts: ${String(
              err?.message || err
            ).slice(0, 200)}`,
            orderId: doc.id,
            branchId: order.branchId,
          });
        } catch {
          // Snapshot best-effort — the attempt count above is the guard.
        }
      }
      console.warn(
        `[Auto Rebook] ${doc.id} attempt ${nextAttempts}/${AUTO_REBOOK_MAX_ATTEMPTS} failed:`,
        err?.message || err
      );
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Porter manual-hybrid lane (DR8)
// ---------------------------------------------------------------------------

export interface PorterManualParams {
  orderId: string;
  porterOrderId: string;
  trackingUrl?: string;
  staffName?: string;
  caller?: StaffCaller;
}

/**
 * POST /dispatch/porter-manual: staff pastes the Porter-app booking after
 * manual_action_required. Writes exactly the fields an API book would (rider
 * slot pending) + both map bindings, so the Porter webhook and polling worker
 * track the pasted order like an API-booked one. deliveryStatus flips to
 * "dispatched" (rider identity pending) because the 5-minute poller only
 * tracks dispatched/in_transit orders carrying a porterOrderId.
 */
export async function savePorterManualBooking(params: PorterManualParams): Promise<any> {
  const { orderId, staffName, caller } = params;
  const orderDoc = await db.collection("orders").doc(orderId).get();
  if (!orderDoc.exists) {
    const missing: any = new Error(`Order ${orderId} not found`);
    missing.statusCode = 404;
    missing.code = "ORDER_NOT_FOUND";
    throw missing;
  }
  const order = orderDoc.data()!;
  if (caller) await assertOrderBranchAccess(caller, order);
  // Terminal guard (audit finding 1): `delivered`/`cancelled` are NOT in
  // ACTIVE_DELIVERY_STATUSES, so the active-dispatch guards below skip exactly
  // the orders this lane must never touch — and the write rewinded
  // deliveryStatus to "dispatched". Same typed 409 dispatchBook throws.
  assertDispatchNotLocked(order);

  const pid = String(params.porterOrderId || "").trim();
  if (!isSafeDocId(pid)) {
    const err: any = new Error(
      "Porter order id contains unsupported characters — copy it exactly from the Porter app."
    );
    err.statusCode = 400;
    err.code = "INVALID_PORTER_ORDER_ID";
    throw err;
  }

  let trackingUrl: string | null = (params.trackingUrl || "").trim() || null;
  if (trackingUrl) {
    // Local porter.in-only allowlist (https + exact/suffix host match).
    let valid = false;
    try {
      const u = new URL(trackingUrl);
      const host = u.hostname.toLowerCase();
      valid =
        u.protocol === "https:" &&
        (host === "porter.in" || host.endsWith(".porter.in"));
    } catch {
      valid = false;
    }
    if (!valid) {
      const err: any = new Error(
        "Tracking URL must be an https:// link on porter.in — paste the link from the Porter app."
      );
      err.statusCode = 400;
      err.code = "TRACKING_URL_INVALID";
      throw err;
    }
  }

  // ---- Guard + write decision (one snapshot of truth) ----
  // The guards and the flip must observe the SAME document state. The paste
  // lane previously decided from a pre-read snapshot and then wrote directly
  // (check-then-act TOCTOU): a /porter/book claim landing after the pre-read
  // sailed through and flipped the order while a real rider was being booked.
  // Transaction-then-decide when the runtime supports it (same posture as
  // claimDispatch above); a shim fallback re-applies the IDENTICAL rules on
  // the pre-read for Firestore shims without transactions.
  const buildPasteWrite = (baseDelivery: any) => {
    const now = admin.firestore.FieldValue.serverTimestamp();
    return {
      deliveryStatus: "dispatched",
      dispatchProvider: "porter",
      dispatchOrderId: pid,
      porterOrderId: pid,
      // Mirror porter.service's SUCCESS write shape (bookPorterRider) — same
      // settled status fields, plus clearing the claim lease (claimedAt):
      // a stale dispatch_pending marker on a successfully pasted order is
      // exactly the "is this claim live?" ambiguity this lane's guard
      // exists for, and the lease must not be re-readable from a settled doc.
      porterDispatchStatus: "dispatched",
      porterDispatchError: null,
      porterDispatchClaimedAt: null,
      // One active alias per order — the pasted Porter id supersedes any
      // stale id left by a previous carrier's dispatch.
      borzoOrderId: null,
      shadowfaxOrderId: null,
      riderTrackingUrl: trackingUrl,
      dispatchStatus: "dispatched",
      dispatchClaimedAt: null,
      dispatchSource: "manual_paste",
      dispatchedBy: staffName || "unattributed",
      dispatchedAt: now,
      needsRebook: false,
      // Staff resolved the dispatch by hand — the auto-rebook worker stops.
      rebookTrigger: null,
      autoRebookAttempts: 0,
      // Tracking mirror for the customer app (rider identity arrives with the
      // porter webhook — never invented here).
      delivery: definedFields({
        ...(baseDelivery && typeof baseDelivery === "object" ? baseDelivery : {}),
        provider: "porter",
        providerOrderId: pid,
        status: "pending",
        trackingUrl: trackingUrl || null,
        riderName: null,
        riderPhone: null,
        riderVehicleNumber: null,
        riderLocation: null,
        riderLocationAt: null,
        updatedAt: now,
      }),
      updatedAt: now,
    };
  };

  const foreignDispatchError = (d: any) => {
    // Truthful copy (DS review of 70a09be): a direct /porter/book never writes
    // dispatchProvider, so "status set + porterOrderId present" is a PORTER
    // dispatch — telling staff to "cancel another provider" would be false.
    const provider = typeof d?.dispatchProvider === "string" ? d.dispatchProvider : null;
    const isPorterDispatch = provider === "porter" || (!provider && d?.porterOrderId);
    const message = isPorterDispatch
      ? "This order is already dispatched via Porter — cancel that dispatch before pasting a different Porter order."
      : `This order is already dispatched via ${provider || "another provider"} — cancel that dispatch before pasting a Porter order.`;
    const err: any = new Error(message);
    err.statusCode = 409;
    err.code = "DISPATCH_EXISTS";
    return err;
  };
  const orderMissingError = () => {
    const err: any = new Error(`Order ${orderId} not found`);
    err.statusCode = 404;
    err.code = "ORDER_NOT_FOUND";
    return err;
  };

  if (db && typeof (db as any).runTransaction === "function") {
    const outcome: any = await (db as any).runTransaction(async (tx: any) => {
      const fresh = await tx.get(orderDoc.ref);
      const d = fresh.exists ? (fresh.data() as any) : undefined;
      if (!d) return { missing: true as const };
      // Terminal orders stay frozen for BOTH callers of the snapshot (the
      // pre-read already refused the common case; this re-check closes the
      // same race window for a delivered/cancelled flip landing in-flight).
      assertDispatchNotLocked(d);
      const active = (ACTIVE_DELIVERY_STATUSES as readonly string[]).includes(d.deliveryStatus || "");
      const holder = d.dispatchOrderId || d.porterOrderId;
      // Replay: already dispatched WITH this porter id → idempotent success.
      if (active && holder === pid) return { reuse: d };
      // Another provider owns this active dispatch — never overwrite its ids.
      if (active && holder && d.dispatchProvider !== "porter") {
        return { foreignDispatch: d };
      }
      // Both claim classes block (generic book claim AND Porter's own
      // direct-tap claim — the identical pair claimDispatch checks).
      if (isFreshGenericPending(d) || isFreshPorterPending(d)) return { busy: true as const };
      // The mirror base is the FRESH delivery snapshot — never the pre-read.
      tx.set(orderDoc.ref, buildPasteWrite(d.delivery), { merge: true });
      return { ok: true as const };
    });
    if (outcome?.missing) throw orderMissingError();
    if (outcome?.reuse) return storedDispatchSummary(outcome.reuse);
    if (outcome?.foreignDispatch) throw foreignDispatchError(outcome.foreignDispatch);
    if (outcome?.busy) throw dispatchInProgressError();
    // Fail closed on an unrecognised outcome: a future return shape must not
    // silently degrade to "maps written, success reported, order unflipped".
    if (!outcome?.ok) throw new Error("savePorterManualBooking: unrecognised transaction outcome");
  } else {
    // Fallback for Firestore shims without transactions: same rules, one
    // snapshot (the pre-read), no weaker guarantee than before.
    assertDispatchNotLocked(order);
    const active = (ACTIVE_DELIVERY_STATUSES as readonly string[]).includes(order.deliveryStatus || "");
    const holder = order.dispatchOrderId || order.porterOrderId;
    if (active && holder === pid) return storedDispatchSummary(order);
    if (active && holder && order.dispatchProvider !== "porter") {
      throw foreignDispatchError(order);
    }
    if (isFreshGenericPending(order) || isFreshPorterPending(order)) throw dispatchInProgressError();
    await orderDoc.ref.set(buildPasteWrite(order.delivery), { merge: true });
  }

  // Both bindings: dispatch webhook resolution + porter's own webhook/poller.
  const mapTs = admin.firestore.FieldValue.serverTimestamp();
  for (const [col, id] of [
    ["dispatch_order_map", pid],
    ["porter_order_map", pid],
  ] as const) {
    try {
      await db
        .collection(col)
        .doc(id)
        .set(
          {
            orderId,
            branchId: order.branchId || null,
            createdAt: mapTs,
            ...(col === "dispatch_order_map" ? { provider: "porter" } : {}),
          },
          { merge: true }
        );
    } catch (mapErr: any) {
      console.warn(`[Dispatch] ${col} write failed (non-blocking):`, mapErr?.message || mapErr);
    }
  }

  return {
    success: true,
    provider: "porter",
    orderId,
    porterOrderId: pid,
    trackingUrl,
    status: "dispatched",
    source: "manual_paste",
  };
}

// ---------------------------------------------------------------------------
// Cancel
// ---------------------------------------------------------------------------

export interface DispatchCancelParams {
  orderId: string;
  staffName?: string;
  caller?: StaffCaller;
}

/**
 * POST /dispatch/cancel: Porter bookings delegate to cancelPorterBooking
 * (honesty contract — no provider cancel API is documented). Borzo/Shadowfax
 * release locally (rider_cancelled + needsRebook) with
 * dispatchProviderCancel:"manual-required" so staff cancel in the provider
 * dashboard. 409 when nothing is active.
 */
export async function dispatchCancel(params: DispatchCancelParams): Promise<any> {
  const { orderId, staffName, caller } = params;
  const orderDoc = await db.collection("orders").doc(orderId).get();
  if (!orderDoc.exists) {
    const missing: any = new Error(`Order ${orderId} not found`);
    missing.statusCode = 404;
    missing.code = "ORDER_NOT_FOUND";
    throw missing;
  }
  const order = orderDoc.data()!;
  if (caller) await assertOrderBranchAccess(caller, order);

  const deliveryStatus = order.deliveryStatus as string | undefined;
  const active = (ACTIVE_DELIVERY_STATUSES as readonly string[]).includes(deliveryStatus || "");
  if (!active) {
    const err: any = new Error("No active dispatch to cancel for this order.");
    err.statusCode = 409;
    err.code = "NOTHING_TO_CANCEL";
    throw err;
  }

  const provider: ProviderId | null =
    (order.dispatchProvider as ProviderId) || (order.porterOrderId ? "porter" : null);

  if (provider === "porter") {
    const { cancelPorterBooking } = await import("../porter/porter.service");
    const result = await cancelPorterBooking(orderId, staffName, caller);
    return { ...result, provider: "porter" };
  }

  await orderDoc.ref.set(
    {
      deliveryStatus: "rider_cancelled",
      dispatchStatus: "cancelled_by_store",
      dispatchProviderCancel: "manual-required",
      needsRebook: true,
      // Staff-initiated cancel: the auto-rebook worker must NEVER re-dispatch
      // this one (only carrier_cancelled / dispatch_failed triggers auto-rebook).
      rebookTrigger: "staff_cancelled",
      riderCancellationReason: `Booking cancelled by ${staffName || "Branch Staff"} — confirm the cancellation in the ${provider || "provider"} dashboard`,
      cancelledBy: staffName || "Branch Staff",
      cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  return {
    success: true,
    orderId,
    provider,
    providerCancel: "manual-required",
    message:
      "Local dispatch released. Confirm the cancellation in the provider dashboard — no provider cancel API is documented.",
  };
}

/** Exposed for tests/tools: distance helper parity with the radius gate. */
export function dispatchDistanceKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  return calculateHaversineDistanceKm(a.lat, a.lng, b.lat, b.lng);
}
