import type { StaffCaller } from "../../core/middleware";

/**
 * Multi-provider dispatch contract (references/delivery_routing.md DR1–DR11).
 * Every provider adapter speaks exactly this vocabulary — the router never
 * branches on provider-specific payload shapes.
 */

export type ProviderId = "borzo" | "shadowfax" | "porter";

/** Tie-break + failover order after price (DR1): cheaper ties win, then this. */
export const PROVIDER_PRIORITY: Record<ProviderId, number> = {
  borzo: 0,
  shadowfax: 1,
  porter: 2,
};

export const PROVIDER_IDS: ProviderId[] = ["borzo", "shadowfax", "porter"];

/** Per-provider failure class (DR3): only transient is retryable/failover-safe. */
export type DispatchFailureKind = "not_serviced" | "transient";

/**
 * The ONE error adapters throw (and the router walks past). Any other error
 * escaping an adapter is treated as a bug: the walk aborts loudly instead of
 * silently skipping a provider (never half-book an order without a trail).
 */
export class ProviderDispatchError extends Error {
  readonly provider: ProviderId;
  readonly kind: DispatchFailureKind;

  constructor(provider: ProviderId, kind: DispatchFailureKind, message: string) {
    super(message);
    this.name = "ProviderDispatchError";
    this.provider = provider;
    this.kind = kind;
  }
}

export function isProviderDispatchError(err: unknown): err is ProviderDispatchError {
  return err instanceof ProviderDispatchError;
}

export interface DispatchGeoPoint {
  lat: number;
  lng: number;
}

/** Quote-time input: real GPS only (order-level, never fallback coords). */
export interface DispatchQuoteContext {
  pickup: DispatchGeoPoint;
  drop: DispatchGeoPoint;
  customerName?: string;
  customerPhone?: string;
  /** Order id when quoting for a known order (rider instructions, client refs). */
  orderId?: string;
  /** Set when the adapter needs full order fields (address blocks, branch info). */
  order?: Record<string, any>;
  /** Staff identity rides the context so adapters (porter) can attribute writes. */
  staffName?: string;
  caller?: StaffCaller;
}

export interface ProviderQuoteOk {
  provider: ProviderId;
  outcome: "ok";
  fare: number;
  distanceKm: number;
  pickupEtaMinutes: number;
  /**
   * TRUE when `pickupEtaMinutes` is a LOCAL estimate because the provider sent
   * no ETA. Absent/false means provider data (or a mock/rate-card source that
   * `source` already labels).
   */
  etaEstimated?: boolean;
  quoteId: string;
  expiresAt: number;
  source: string;
}

export interface ProviderQuoteFailure {
  provider: ProviderId;
  outcome: "not_serviced" | "transient_failure";
  error: string;
}

export type ProviderQuoteOutcome = ProviderQuoteOk | ProviderQuoteFailure;

/** Book-time input: quote context + provider-level quote (fare proof). */
export interface DispatchBookContext extends DispatchQuoteContext {
  orderId: string;
  /** Provider-level quote being booked (fare proof for the attempt log). */
  quote: ProviderQuoteOk;
}

export type ProviderBookResult =
  | {
      kind: "booked";
      provider: ProviderId;
      providerOrderId: string;
      riderName: string;
      riderPhone: string;
      riderVehicleNumber: string;
      trackingUrl?: string;
      source?: string;
      geoSource?: string;
      /** True when the provider call replayed an already-active booking. */
      reused?: boolean;
    }
  | {
      kind: "manual_action_required";
      provider: ProviderId;
      instructions: string;
      pasteEndpoint: string;
    };

/**
 * Provider-side booking operations after `book()` succeeded. Kept separate from
 * the quote/book failure vocabulary above: a cancel or dispatch-ready call is
 * a state-changing mutation whose HTTP failure classes are different from a
 * quote's (`404`/`5xx`/timeout may mean the mutation was applied — ambiguity —
 * while a `400` is a definitive rejection).
 */
export type ProviderOperation = "cancel" | "dispatch_ready";

/** Shadowfax's documented cancel actors. */
export type ProviderCancelActor = "Customer" | "Seller" | "Rider";

export interface ProviderCancelContext {
  /** The confirmed provider order id stored on the order (never a client guess). */
  providerOrderId: string;
  orderId?: string;
  /** Free-text reason; adapters truncate to the vendor limit. */
  reason: string;
  actor?: ProviderCancelActor;
}

/**
 * What the provider actually gave us.
 *
 * `confirmed` = a documented response proved the booking is cancelled (Borzo:
 * `is_successful:true` + matching `order.order_id` + `order.status:"canceled"`).
 * `acknowledged` = the provider accepted the request (2xx) but its contract
 * documents NO confirmation body (Shadowfax). An ACK must never be treated as
 * proof of cancellation — the local binding stays live for reconciliation.
 */
export type ProviderCancelResult =
  | {
      outcome: "confirmed";
      provider: ProviderId;
      providerOrderId: string;
      source: string;
    }
  | {
      outcome: "acknowledged";
      provider: ProviderId;
      providerOrderId: string;
      source: string;
      note: string;
    };

export interface ProviderDispatchReadyContext {
  /**
   * Shadowfax COID — the client order id sent at booking (`order_details
   * .client_order_id`), i.e. OUR order id, not the `sfx_order_id`.
   */
  coid: string;
  readyAt: Date;
}

export interface ProviderDispatchReadyResult {
  provider: ProviderId;
  coid: string;
  shipmentReadyTimestamp: string;
  source: string;
}

/**
 * A provider mutation failed. `ambiguous: true` means the provider MAY have
 * applied it (timeout / 5xx / 404-after-send) and the caller must park the
 * booking for manual review instead of retrying or assuming success.
 *
 * Deliberately NOT a ProviderDispatchError: the ranked book walk only treats
 * that class as failover material, and a cancel/ready failure must never book
 * a different courier.
 */
export class ProviderOperationError extends Error {
  readonly provider: ProviderId;
  readonly operation: ProviderOperation;
  readonly ambiguous: boolean;

  constructor(
    provider: ProviderId,
    operation: ProviderOperation,
    message: string,
    options: { ambiguous: boolean }
  ) {
    super(message);
    this.name = "ProviderOperationError";
    this.provider = provider;
    this.operation = operation;
    this.ambiguous = options.ambiguous;
  }
}

export function isProviderOperationError(err: unknown): err is ProviderOperationError {
  return err instanceof ProviderOperationError;
}

export interface ProviderAdapter {
  readonly provider: ProviderId;
  /** Eligible = enabled + keyed (or explicit mock). Ineligible ⇒ excluded, not failed (DR2). */
  isEligible(): boolean;
  /** Resolves ProviderQuoteOk or throws ProviderDispatchError — never a static-rate-card fallback on failure. */
  quote(ctx: DispatchQuoteContext): Promise<ProviderQuoteOk>;
  /** Books the quoted fare, returns booked/manual, or throws ProviderDispatchError (DR6/DR8). */
  book(ctx: DispatchBookContext): Promise<ProviderBookResult>;
  /**
   * Cancels a CONFIRMED booking. Optional: Porter's retirement lane is handled
   * by porter.service, not by the retired provider adapter.
   */
  cancelBooking?(ctx: ProviderCancelContext): Promise<ProviderCancelResult>;
  /** Signals "food is ready for pickup" for a confirmed booking. */
  markDispatchReady?(ctx: ProviderDispatchReadyContext): Promise<ProviderDispatchReadyResult>;
}

/** Provider-attempt ledger persisted on the order after every book attempt. */
export interface DispatchAttemptRecord {
  provider: ProviderId;
  outcome: "booked" | "manual_required" | "not_serviced" | "transient_failure" | "error";
  error?: string;
  at: number;
}

export type DispatchStatus =
  | "dispatch_pending"
  | "dispatched"
  | "dispatch_failed"
  | "manual_pending"
  | "cancelled_by_store";

export const ACTIVE_DELIVERY_STATUSES = ["dispatched", "in_transit", "driver_allocated"] as const;
