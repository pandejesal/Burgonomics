import { db } from "../../core/firebase";
import * as admin from "firebase-admin";
import { captureErrorSnapshot } from "../../core/errors";
import { refundUnfulfillableCapture } from "./lateCaptureRefund";

/**
 * One guarded FIRST-CAPTURE path, shared by the two channels that can confirm a
 * capture (client `verifyPayment` and the authoritative `payment.captured`
 * webhook).
 *
 * Why it is a LOCK and not a hint. The previous version let a racing sibling
 * read "not first" and go straight on to confirm and ring the KOT while the
 * owner was still deciding availability; when the owner then refunded, the
 * customer got food AND a refund. So the decision is written down on the order
 * (`captureFulfillment`) and BOTH confirmation transactions refuse to confirm
 * unless that record says `fulfillable` for THIS payment:
 *
 *   checking       → someone is deciding. Nobody may confirm.
 *   fulfillable    → confirmed by the owner. Safe to confirm (idempotent).
 *   refunded       → the capture was compensated. NEVER confirm, never KOT.
 *   refund_failed  → compensation was attempted and failed. NEVER confirm;
 *                    park for a human and make the provider retry.
 *
 * A crashed owner is recoverable: `checking` carries a lease (`atMs`), and a
 * stale lease is taken over by the next caller. The channel that finds a live
 * `checking` lease returns a RETRYABLE signal (webhook: non-2xx so Razorpay
 * redelivers; verify: 202) instead of confirming.
 *
 * An unreadable catalogue is an OUTAGE, never proof of unavailability: only a
 * product document that explicitly records `inStock === false` is refunded.
 */

export type CaptureFulfillmentState =
  | "checking"
  | "fulfillable"
  /** Refund decided; POST may or may not have left. Recoverable, never final. */
  | "refund_pending"
  | "refunded"
  /** Transient automatic-refund failure. RETRYABLE, not a terminal verdict. */
  | "refund_failed";

export interface CaptureFulfillmentRecord {
  state: CaptureFulfillmentState;
  paymentId: string;
  atMs: number;
  /** Attempt counter shared by the capture path and the recovery job. */
  attempts?: number;
  /** Last known refund detail (gateway error / item list). */
  detail?: string;
  /** Last gateway error text while a refund keeps failing. */
  lastError?: string;
}

export type CaptureFulfillmentOutcome =
  /**
   * Nothing to decide: the order is already confirmed/later/terminal, or the
   * document is gone. Confirmation logic (which suppresses replays) decides.
   */
  | { outcome: "already_confirmed" }
  /** Duty to decide is OURS: proceed (the record says fulfillable). */
  | { outcome: "fulfillable" }
  /** Another channel is deciding right now: DO NOT confirm; retry. */
  | { outcome: "pending" }
  /** A compensation was recorded for this order: NEVER confirm. */
  | { outcome: "already_compensated"; state: CaptureFulfillmentState }
  | { outcome: "refunded"; refundId: string; reused: boolean }
  | { outcome: "refund_failed"; detail: string };

const CONFIRMED_OR_LATER = new Set([
  "CONFIRMED",
  "PREPARING",
  "READY",
  "READY_FOR_PICKUP",
  "READY_TO_SERVE",
  "OUT_FOR_DELIVERY",
  "IN_TRANSIT",
  "DELIVERED",
  "COMPLETED",
  "PICKED_UP",
  "CANCELLED",
  "REFUNDED",
]);

/** How long one channel may hold the decision before a takeover is allowed. */
export const CAPTURE_GATE_LEASE_MS = 5 * 60_000;

/**
 * Attempts before the recovery job stops retrying and raises a HIGH alert.
 * Small on purpose: a refund that fails this many times needs a human, and a
 * silent infinite retry is exactly the failure mode this lane exists to end.
 */
export const CAPTURE_GATE_MAX_ATTEMPTS = 5;

/**
 * How long past its lease a `refund_pending`/`refund_failed`/`checking` gate
 * may sit before the scheduled recovery job takes it over. Longer than the
 * per-doc lease so a live channel is never raced by the job.
 */
export const CAPTURE_RECOVERY_AFTER_MS = 10 * 60_000;

/**
 * Backoff before retrying a KNOWN-FAILED refund. Deliberately ZERO: a gateway
 * failure means nothing is in flight, the caller already waits a full scheduler
 * tick (5 minutes) between attempts, and the attempt budget — not a timer — is
 * what stops a runaway lane. A non-zero value here would only delay recovery
 * for no safety gain.
 */
export const CAPTURE_REFUND_RETRY_BACKOFF_MS = 0;

function statusCodeOf(order: any): string {
  const raw = typeof order?.status === "string" ? order.status : order?.status?.code;
  return String(raw || "").toUpperCase();
}

/** Has this order already been confirmed (or moved past confirming)? */
export function isOrderConfirmedOrLater(order: any): boolean {
  const code = statusCodeOf(order);
  return (
    order?.paymentStatus === "completed" ||
    CONFIRMED_OR_LATER.has(code) ||
    order?.status?.terminal === true ||
    order?.terminal === true
  );
}

/**
 * Lifecycle-only variant: CONFIRMED/PREPARING/…/terminal, ignoring
 * `paymentStatus`.
 *
 * Compensation stamps `paymentStatus: "completed"` on the order (it must, so
 * refund accounting can prove what it is refunding), which makes the broader
 * check above say "already confirmed" for an order that was never confirmed.
 * Every path that must still SEE a compensation state has to use this one.
 */
export function isOrderLifecycleConfirmedOrLater(order: any): boolean {
  const code = statusCodeOf(order);
  return (
    CONFIRMED_OR_LATER.has(code) ||
    order?.status?.terminal === true ||
    order?.terminal === true
  );
}

function gateRecordOf(order: any): CaptureFulfillmentRecord | null {
  const raw = order?.captureFulfillment;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const state = String((raw as any).state || "");
  const paymentId =
    typeof (raw as any).paymentId === "string" ? (raw as any).paymentId : "";
  if (!paymentId) return null;
  if (
    state !== "checking" &&
    state !== "fulfillable" &&
    state !== "refund_pending" &&
    state !== "refunded" &&
    state !== "refund_failed"
  ) {
    return null;
  }
  return {
    state: state as CaptureFulfillmentState,
    paymentId,
    atMs: Number((raw as any).atMs) || 0,
    attempts: Number((raw as any).attempts) || 0,
    detail: typeof (raw as any).detail === "string" ? (raw as any).detail : undefined,
    lastError:
      typeof (raw as any).lastError === "string" ? (raw as any).lastError : undefined,
  };
}

/** States in which money may already have moved and must not be re-decided. */
export function isCompensationState(state: CaptureFulfillmentState): boolean {
  return (
    state === "refund_pending" || state === "refunded" || state === "refund_failed"
  );
}

/**
 * May THIS capture confirm this order? Exported for BOTH confirmation
 * transactions: it is the single shared rule that keeps a compensated capture
 * from ever becoming a CONFIRMED, rung order.
 *
 * Deliberately permissive in exactly two cases, both of which never write a
 * confirmation:
 *  - the order is already confirmed / later / terminal (the caller's own
 *    later-status guard preserves it and performs no confirm), and
 *  - the order doc does not exist (the caller's ghost refusal handles it).
 * Every OTHER state must carry a `fulfillable` record for this payment; a
 * missing record means the fulfilment decision was never made, so confirming
 * could produce food plus refund.
 */
export function captureGateAllowsConfirm(order: any, razorpayPaymentId: string): boolean {
  if (!order || typeof order !== "object") return true;
  // COMPENSATION OUTRANKS EVERYTHING. A compensated capture stamps payment
  // truth on the order (so `paymentStatus` reads "completed"), which is exactly
  // why this must be checked BEFORE the already-confirmed allowance below —
  // otherwise a later `order.paid` confirms refunded food.
  //
  // `refund_pending` is included: the refund POST may already be on the wire,
  // so confirming would produce exactly the food-plus-refund outcome.
  const record = gateRecordOf(order);
  if (record && isCompensationState(record.state)) return false;
  // Nothing to suppress for an order whose LIFECYCLE is already past
  // confirming: the caller's later-status guard preserves it and performs no
  // confirm. This uses the lifecycle-only check because compensation itself
  // stamps `paymentStatus: "completed"` on an order that was never confirmed.
  if (isOrderLifecycleConfirmedOrLater(order)) return true;
  if (!record) return false;
  return record.state === "fulfillable" && record.paymentId === razorpayPaymentId;
}

/**
 * Transactional decision. Exactly one caller wins `checking`; every other
 * caller learns the state that is on record.
 */
async function claimGate(args: {
  orderRef: any;
  razorpayPaymentId: string;
  nowMs?: number;
}): Promise<
  | { kind: "already_confirmed" }
  | { kind: "claimed" }
  | { kind: "fulfillable" }
  | { kind: "pending" }
  | { kind: "compensated"; state: CaptureFulfillmentState }
  | {
      kind: "resume_compensation";
      state: CaptureFulfillmentState;
      detail?: string;
    }
> {
  if (!db || typeof (db as any).runTransaction !== "function") {
    // Without a transaction there is no way to prove "first" — never compensate
    // and never confirm on an unprovable claim. The caller parks (retryable).
    return { kind: "pending" };
  }
  return (await (db as any).runTransaction(async (tx: any) => {
    const snap = await tx.get(args.orderRef);
    if (!snap || !snap.exists) {
      // A deleted order has nothing to decide and nothing to confirm: let the
      // caller's own ghost/not-found refusal handle it (verify: 404; webhook:
      // parked). Returning "pending" here would hide a real error behind a
      // retry loop.
      return { kind: "already_confirmed" } as const;
    }
    const fresh = (snap.data() || {}) as any;

    // A later LIFECYCLE state (staff already bumped it) is NOT a replay to
    // re-decide: the caller's confirmation logic preserves the status. Running
    // the availability decision here could refund an order in the kitchen, so
    // it is left alone entirely. The lifecycle check ignores `paymentStatus`,
    // which a compensation itself stamps as "completed".
    if (isOrderLifecycleConfirmedOrLater(fresh)) return { kind: "already_confirmed" } as const;

    // COMPENSATION OUTRANKS CONFIRMATION. A compensated capture stamps payment
    // truth on the order (so a naive "is it paid?" read says yes); that must
    // never let a later `order.paid` confirm refunded food.
    //
    // `refund_pending` / `refund_failed` are RESERVED for this payment: the
    // refund identity is already minted, so the caller must resume the SAME
    // refund (idempotent key) rather than re-decide fulfilment. Only a grown
    // lease may take them over.
    const record = gateRecordOf(fresh);
    const nowMs = typeof args.nowMs === "number" ? args.nowMs : Date.now();
    if (record && record.paymentId === args.razorpayPaymentId) {
      if (record.state === "refunded") {
        return { kind: "compensated", state: record.state } as const;
      }
      if (record.state === "refund_pending" || record.state === "refund_failed") {
        const age = nowMs - record.atMs;
        const leaseLive =
          Number.isFinite(record.atMs) && record.atMs > 0 && age < CAPTURE_GATE_LEASE_MS;
        // A FAILED attempt has nothing in flight: it is retryable immediately,
        // so a redelivery or the next sweep can finish it without waiting out a
        // lease that only exists to protect an in-flight POST.
        if (leaseLive && record.state === "refund_pending") {
          return { kind: "compensated", state: record.state } as const;
        }
        if (leaseLive && record.state === "refund_failed") {
          return {
            kind: "resume_compensation",
            state: record.state,
            detail: record.detail,
          } as const;
        }
        // Stale `refund_pending`: this caller RESUMES the refund below (never
        // re-decides it).
        return {
          kind: "resume_compensation",
          state: record.state,
          detail: record.detail,
        } as const;
      }
      if (record.state === "fulfillable") return { kind: "fulfillable" } as const;
      // state === "checking"
      const age = nowMs - record.atMs;
      if (Number.isFinite(record.atMs) && record.atMs > 0 && age < CAPTURE_GATE_LEASE_MS) {
        return { kind: "pending" } as const;
      }
      // Stale lease (crashed owner): take over below.
    } else if (record && record.paymentId !== args.razorpayPaymentId) {
      // A DIFFERENT capture already owns the decision for this order. A
      // compensation for another payment still forbids confirming this one; a
      // second live capture is the existing foreign-capture guards' business.
      if (isCompensationState(record.state)) {
        return { kind: "compensated", state: record.state } as const;
      }
      return { kind: "pending" } as const;
    }

    tx.set(
      args.orderRef,
      {
        captureFulfillment: {
          state: "checking",
          paymentId: args.razorpayPaymentId,
          atMs: Date.now(),
        },
        captureFulfillmentState: "checking",
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    return { kind: "claimed" } as const;
  })) as any;
}

/**
 * Writes the decided state. Merge-only; never touches payment truth.
 *
 * `attempts` is EXPLICIT (never inferred), so the capture path and the recovery
 * job share one counter and neither resets the other's progress.
 */
async function recordGateState(args: {
  orderRef: any;
  razorpayPaymentId: string;
  state: CaptureFulfillmentState;
  detail?: string;
  lastError?: string;
  attempts?: number;
}): Promise<boolean> {
  try {
    await args.orderRef.set(
      {
        captureFulfillment: {
          state: args.state,
          paymentId: args.razorpayPaymentId,
          atMs: Date.now(),
          ...(typeof args.attempts === "number" ? { attempts: args.attempts } : {}),
          ...(args.detail ? { detail: args.detail.slice(0, 300) } : {}),
          ...(args.lastError ? { lastError: args.lastError.slice(0, 300) } : {}),
        },
        // MIRROR of the state at the TOP level. Firestore's automatic index
        // covers a top-level field, and the recovery sweep needs an
        // equality-scannable key with NO composite index. The nested record
        // stays the authority for every decision.
        captureFulfillmentState: args.state,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    return true;
  } catch (err: any) {
    // A failure to record leaves the previous state, which ages out and is
    // retried by the recovery job.
    console.warn(
      `[Payments] capture-gate state write failed for ${args.razorpayPaymentId}:`,
      err?.message || err
    );
    return false;
  }
}

/** Every product id in the order that the catalogue explicitly records as 86'd. */
async function unavailableProductIds(items: any[]): Promise<{
  unavailable: string[];
  readFailed: boolean;
}> {
  const unavailable: string[] = [];
  let readFailed = false;
  for (const item of items) {
    const productId = String((item as any)?.productId ?? (item as any)?.id ?? "").trim();
    if (!productId) continue;
    try {
      const snap = await db.collection("products").doc(productId).get();
      if (snap.exists && (snap.data() as any)?.inStock === false) unavailable.push(productId);
    } catch {
      readFailed = true;
    }
  }
  return { unavailable, readFailed };
}

/**
 * Runs (or RESUMES) the automatic refund for a proven-unfulfillable capture.
 *
 * Order of operations is the whole point:
 *
 *  1. persist `refund_pending` (with the outcome detail and an attempt count)
 *     BEFORE the gateway call, so a crash between the write and the POST leaves
 *     a RECOVERABLE record rather than a false "refunded";
 *  2. call the ONE automatic-refund path. Its identity is deterministic
 *     (`unful_<order>_<payment>`), so a retry from the crash above replays the
 *     stored receipt instead of paying twice;
 *  3. mark `refunded` only after the gateway answered with a refund id;
 *  4. on failure mark `refund_failed` — a RETRYABLE state, not a verdict, so
 *     the next delivery and the recovery job both try again.
 *
 * Returns the outcome plus whether the attempt budget is exhausted.
 */
async function runCompensatingRefund(args: {
  orderRef: any;
  orderId: string;
  razorpayPaymentId: string;
  razorpayOrderId?: string | null;
  capturedAmountPaise?: number;
  detail: string;
  attempts: number;
}): Promise<{
  outcome: "refunded" | "refund_failed";
  refundId?: string;
  reused?: boolean;
  detail?: string;
  attempts: number;
}> {
  const attempts = args.attempts + 1;

  const pendingWritten = await recordGateState({
    orderRef: args.orderRef,
    razorpayPaymentId: args.razorpayPaymentId,
    state: "refund_pending",
    detail: args.detail,
    attempts,
  });
  if (!pendingWritten) {
    // Without the pending mark a crash could be mistaken for "nothing spent".
    // Fail the attempt (retryable) rather than move money on an unprovable
    // state; the recovery job will pick the order up from its old state.
    return {
      outcome: "refund_failed",
      detail: "could not persist refund_pending",
      attempts: args.attempts,
    };
  }

  const refund = await refundUnfulfillableCapture({
    orderId: args.orderId,
    razorpayPaymentId: args.razorpayPaymentId,
    razorpayOrderId: args.razorpayOrderId || null,
    capturedAmountPaise: args.capturedAmountPaise,
    reason: "item_unavailable",
    detail: args.detail,
    source: "capture_fulfillment_gate",
  });

  if (!refund.refunded) {
    await recordGateState({
      orderRef: args.orderRef,
      razorpayPaymentId: args.razorpayPaymentId,
      state: "refund_failed",
      detail: args.detail,
      lastError: refund.detail,
      attempts,
    });
    return { outcome: "refund_failed", detail: refund.detail, attempts };
  }

  // Gateway proof in hand: the ONLY write that may claim "refunded".
  await recordGateState({
    orderRef: args.orderRef,
    razorpayPaymentId: args.razorpayPaymentId,
    state: "refunded",
    detail: args.detail,
    attempts,
  });
  return {
    outcome: "refunded",
    refundId: refund.refundId,
    reused: refund.reused,
    attempts,
  };
}

/**
 * Gate a capture before it is confirmed.
 *
 * `fulfillable` / `already_confirmed` → the caller may run its confirm logic
 * (which re-checks the record transactionally). `pending` → DO NOT confirm: the
 * caller must return a retryable signal. `refunded` / `already_compensated` →
 * never confirm, never KOT. `refund_failed` → never confirm; retry the refund.
 */
export async function guardCaptureFulfillment(args: {
  orderRef: any;
  orderId: string;
  razorpayPaymentId: string;
  razorpayOrderId?: string | null;
  orderData: Record<string, any>;
  capturedAmountPaise?: number;
  /** Deterministic clock seam for the recovery job and tests. */
  nowMs?: number;
}): Promise<CaptureFulfillmentOutcome> {
  if (!args.razorpayPaymentId) return { outcome: "pending" };

  const claim = await claimGate({
    orderRef: args.orderRef,
    razorpayPaymentId: args.razorpayPaymentId,
    nowMs: args.nowMs,
  });

  if (claim.kind === "already_confirmed") return { outcome: "already_confirmed" };
  if (claim.kind === "fulfillable") return { outcome: "fulfillable" };
  if (claim.kind === "pending") return { outcome: "pending" };
  if (claim.kind === "compensated") {
    // Only a PROVEN refund is "compensated". A refund that is pending or whose
    // attempt failed is NOT money returned, so it must never be reported as one
    // — the caller retries it instead.
    if (claim.state !== "refunded") {
      return { outcome: "refund_failed", detail: "compensation in progress" };
    }
    return { outcome: "already_compensated", state: claim.state };
  }
  if (claim.kind === "resume_compensation") {
    // The decision was already made and money may already have moved. Resume
    // the SAME refund identity — never re-decide fulfilment.
    const resumed = await resumeCompensatingRefund({
      orderRef: args.orderRef,
      orderId: args.orderId,
      razorpayPaymentId: args.razorpayPaymentId,
      razorpayOrderId: args.razorpayOrderId,
      capturedAmountPaise: args.capturedAmountPaise,
      detail: claim.detail || "resumed",
      staleState: claim.state,
    });
    if (resumed.outcome === "refunded") {
      return { outcome: "refunded", refundId: resumed.refundId!, reused: !!resumed.reused };
    }
    return { outcome: "refund_failed", detail: resumed.detail || "refund retry failed" };
  }

  // We own the decision now.
  const items = Array.isArray(args.orderData?.items) ? args.orderData.items : [];
  if (items.length === 0) {
    await recordGateState({
      orderRef: args.orderRef,
      razorpayPaymentId: args.razorpayPaymentId,
      state: "fulfillable",
      attempts: 1,
    });
    return { outcome: "fulfillable" };
  }

  const { unavailable, readFailed } = await unavailableProductIds(items);
  if (readFailed) {
    await captureErrorSnapshot({
      source: "payments",
      severity: "medium",
      message: `Availability recheck could not read the catalogue for order ${args.orderId} — capture NOT compensated (an outage is never unavailability)`,
      orderId: args.orderId,
      razorpayPaymentId: args.razorpayPaymentId,
    }).catch(() => undefined);
    // The customer paid and the cart is not proven bad: fulfil. The payment is
    // real money and an outage must never refund a good order.
    await recordGateState({
      orderRef: args.orderRef,
      razorpayPaymentId: args.razorpayPaymentId,
      state: "fulfillable",
      detail: "catalogue_read_failed",
      attempts: 1,
    });
    return { outcome: "fulfillable" };
  }
  if (unavailable.length === 0) {
    await recordGateState({
      orderRef: args.orderRef,
      razorpayPaymentId: args.razorpayPaymentId,
      state: "fulfillable",
      attempts: 1,
    });
    return { outcome: "fulfillable" };
  }

  const result = await runCompensatingRefund({
    orderRef: args.orderRef,
    orderId: args.orderId,
    razorpayPaymentId: args.razorpayPaymentId,
    razorpayOrderId: args.razorpayOrderId,
    capturedAmountPaise: args.capturedAmountPaise,
    detail: unavailable.join(","),
    attempts: 0,
  });
  if (result.outcome === "refunded") {
    return { outcome: "refunded", refundId: result.refundId!, reused: !!result.reused };
  }
  return { outcome: "refund_failed", detail: result.detail || "refund failed" };
}

/**
 * Resume a compensation whose owner died (or whose attempt failed) — the path
 * the capture channels take after a stale lease, and the path the scheduled
 * recovery job takes. It NEVER re-decides fulfilment and NEVER changes the
 * refund identity, so it can race a late webhook or verify safely.
 */
async function resumeCompensatingRefund(args: {
  orderRef: any;
  orderId: string;
  razorpayPaymentId: string;
  razorpayOrderId?: string | null;
  capturedAmountPaise?: number;
  detail: string;
  staleState: CaptureFulfillmentState;
}): Promise<{
  outcome: "refunded" | "refund_failed";
  refundId?: string;
  reused?: boolean;
  detail?: string;
  attempts: number;
}> {
  return runCompensatingRefund({
    orderRef: args.orderRef,
    orderId: args.orderId,
    razorpayPaymentId: args.razorpayPaymentId,
    razorpayOrderId: args.razorpayOrderId,
    capturedAmountPaise: args.capturedAmountPaise,
    detail: args.detail,
    attempts: 0,
  });
}
