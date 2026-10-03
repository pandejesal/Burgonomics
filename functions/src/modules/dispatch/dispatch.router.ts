import * as admin from "firebase-admin";
import { db } from "../../core/firebase";
import { config } from "../../config/env";
import { isSafeDocId } from "../../core/security";
import { captureErrorSnapshot } from "../../core/errors";
import { assertOrderBranchAccess, type StaffCaller } from "../../core/middleware";
import {
  checkBranchDeliveryServiceability,
  calculateHaversineDistanceKm,
} from "@burgonomics/shared/geo";
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
  const outcomes = await Promise.all(eligible.map((a) => quoteWithTimeout(a, ctx)));
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
  const drop = order.deliveryAddress;
  if (orderType === "delivery" && !(drop?.street || drop?.full || (drop?.lat && drop?.lng))) {
    throw new Error("Delivery address is incomplete — add street or map pin, then retry dispatch.");
  }
  // Fail-closed GPS for EVERY dispatch (H-R19): dispatch quote/book never
  // invents a drop pin — a textual address without coordinates is refused
  // (422, retryable), never routed to fallback defaults.
  if (!(drop?.lat && drop?.lng)) {
    const noGps: any = new Error(
      "Delivery location is missing map coordinates — pin the customer address on the map, then retry dispatch."
    );
    noGps.statusCode = 422;
    noGps.code = "DISPATCH_GPS_MISSING";
    throw noGps;
  }
}

function assertDispatchNotLocked(order: any): void {
  const ds = order?.deliveryStatus;
  if (ds === "delivered" || ds === "cancelled") throw terminalError(ds);
}

function buildQuoteContext(
  order: any,
  params: Partial<DispatchQuoteParams> & { staffName?: string; caller?: StaffCaller }
): { ctx: DispatchQuoteContext; geoSource: "live_gps" | "fallback_default" } {
  const pickupLat = order.branchCoordinates?.lat || 23.0131;
  const pickupLng = order.branchCoordinates?.lng || 72.5085;
  const usedFallbackCoords = !(order.branchCoordinates?.lat && order.branchCoordinates?.lng);
  return {
    ctx: {
      pickup: { lat: pickupLat, lng: pickupLng },
      drop: { lat: order.deliveryAddress?.lat, lng: order.deliveryAddress?.lng },
      customerName: order.customerName || params.customerName,
      customerPhone: order.customerPhone || params.customerPhone,
      orderId: params.orderId,
      order,
      staffName: params.staffName,
      caller: params.caller,
    },
    geoSource: usedFallbackCoords ? "fallback_default" : "live_gps",
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
 * POST /dispatch/quote: radius gate (DR4) → parallel fan-out (DR5) →
 * cheapest serviceable wins (DR1). Radius failure is a 200 with
 * serviceable:false (the address simply is not in zone); a fan-out with zero
 * ok providers fails closed 503 — never a static fare (DR2).
 */
export async function dispatchQuote(params: DispatchQuoteParams): Promise<any> {
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
    quoteId: winner.quoteId,
    vehicleType: "2-Wheeler (Bike Express)",
    source: winner.source,
    expiresAt: winner.expiresAt,
    validForSeconds: QUOTE_TTL_SECONDS,
  };
}

function noServiceableProviderError(outcomes: ProviderQuoteOutcome[]): Error {
  const err: any = new Error(
    "No delivery provider currently services this address — delivery unavailable."
  );
  err.statusCode = 503;
  err.code = "NO_SERVICEABLE_PROVIDER";
  err.serviceable = false;
  err.reason = "NO_SERVICEABLE_PROVIDER";
  err.providers = outcomes;
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
}

/**
 * POST /dispatch/book (§3): claim → fresh fan-out (DR7) → fare confirm →
 * bounded ranked walk (DR6) → Porter manual lane (DR8) → normalized persist.
 */
export async function dispatchBook(params: DispatchBookParams): Promise<any> {
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

  // Per-order idempotency gate before any provider call (double-book guard).
  const reuse = await claimDispatch(orderDoc, order);
  if (reuse) return reuse;

  const { ctx, geoSource } = buildQuoteContext(order, params);

  try {
    const gate = checkBranchDeliveryServiceability(
      ctx.pickup.lat,
      ctx.pickup.lng,
      order.deliveryAddress.lat,
      order.deliveryAddress.lng,
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

    // DR7: a fare that drifted past the confirm threshold needs staff sign-off
    // before anything is committed. Claim released — the confirm retry
    // re-claims (no parked dispatch_pending on an unbooked confirm step).
    if (typeof params.quotedFare === "number" && params.confirmFare !== true) {
      const check = fareConfirmCheck(
        params.quotedFare,
        ranked[0].fare,
        config.dispatch.fareConfirmDeltaInr
      );
      if (check.needsConfirm) {
        await releaseClaimIdle(orderDoc, { dispatchQuote: quoteSnapshot });
        return {
          needsFareConfirm: true,
          provider: ranked[0].provider,
          quotedFare: params.quotedFare,
          newFare: ranked[0].fare,
          delta: Math.round(check.delta * 100) / 100,
          threshold: Math.round(check.threshold * 100) / 100,
          confirmEndpoint: "/dispatch/book",
          message: `Fare changed since the quote (₹${check.delta.toFixed(2)}). Confirm to book at the new fare.`,
        };
      }
    }

    // Ranked walk order: preferred provider first when it quoted ok (staff
    // override), otherwise pure cheapest-wins order (DR1).
    let walk = ranked;
    if (params.preferredProvider) {
      const preferred = ranked.filter((q) => q.provider === params.preferredProvider);
      const rest = ranked.filter((q) => q.provider !== params.preferredProvider);
      walk = [...preferred, ...rest];
    }
    const cheapest = ranked[0].provider;

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
      dispatchedBy: staffName || "Branch Staff",
      dispatchedAt: admin.firestore.FieldValue.serverTimestamp(),
      needsRebook: false,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    // Porter alias: the poller + porter webhook key on porterOrderId.
    if (booked.provider === "porter") {
      write.porterOrderId = booked.providerOrderId;
    }
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
  } catch (err: any) {
    // Route-visible status passthrough for every typed error above.
    throw err;
  }
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

  const deliveryStatus = order.deliveryStatus as string | undefined;
  const active = (ACTIVE_DELIVERY_STATUSES as readonly string[]).includes(deliveryStatus || "");

  // Replay: already dispatched WITH this porter id → idempotent success.
  if (active && (order.dispatchOrderId || order.porterOrderId) === pid) {
    return storedDispatchSummary(order);
  }
  // Another provider owns this active dispatch — never overwrite its ids.
  if (active && (order.dispatchOrderId || order.porterOrderId) && order.dispatchProvider !== "porter") {
    const err: any = new Error(
      `This order is already dispatched via ${order.dispatchProvider || "another provider"} — cancel that dispatch before pasting a Porter order.`
    );
    err.statusCode = 409;
    err.code = "DISPATCH_EXISTS";
    throw err;
  }
  // A live API book is in flight — pasting now would race it.
  if (isFreshGenericPending(order)) throw dispatchInProgressError();

  const now = admin.firestore.FieldValue.serverTimestamp();
  await orderDoc.ref.set(
    {
      deliveryStatus: "dispatched",
      dispatchProvider: "porter",
      dispatchOrderId: pid,
      porterOrderId: pid,
      riderTrackingUrl: trackingUrl,
      dispatchStatus: "dispatched",
      dispatchClaimedAt: null,
      dispatchSource: "manual_paste",
      dispatchedBy: staffName || "Branch Staff",
      dispatchedAt: now,
      needsRebook: false,
      updatedAt: now,
    },
    { merge: true }
  );

  // Both bindings: dispatch webhook resolution + porter's own webhook/poller.
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
            createdAt: now,
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
