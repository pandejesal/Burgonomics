import * as admin from "firebase-admin";
import { db } from "../../core/firebase";
import type { ProviderId } from "./types";

/**
 * Durable record of a local release whose REMOTE cancellation is not proven.
 *
 * WHY. `dispatchCancel` is a LOCAL release for providers with no cancel API in
 * our adapter (Borzo: cancellation is a dashboard step or a provider webhook;
 * Porter: dashboard only). It also settles the order `rider_cancelled` +
 * `needsRebook: true` and retires the binding into `dispatchReleasedBindings` so
 * a late callback parks instead of mutating the order. That left the order
 * looking "ready to rebook" while the courier may still have a rider on the
 * road: pressing Rebook booked a second rider for one delivery.
 *
 * The record below is the missing ownership link. While it is un-confirmed,
 * every replacement dispatch is refused. It is cleared ONLY by evidence:
 *   - a provider cancellation callback for that exact booking,
 *   - a successful provider cancel call (Shadowfax), or
 *   - an explicit staff confirmation that the dashboard cancel was done.
 *
 * States:
 *   pending         — a provider cancel call is owed/being retried (Shadowfax).
 *   manual_required — no cancel API; staff must cancel in the dashboard.
 *   dead_lettered   — retries exhausted; still blocking, now escalated.
 *   confirmed       — the remote cancellation is proven; replacement allowed.
 *
 * Every field is always written, `null` instead of `undefined`: Firestore
 * rejects `undefined` anywhere inside a write payload, including a nested map.
 */

export type PendingCancelState = "pending" | "manual_required" | "dead_lettered" | "confirmed";

export type PendingCancelReason = "staff_cancelled" | "order_cancelled" | "carrier_cancelled";

export type PendingCancelConfirmation =
  | "provider_cancel"
  | "provider_webhook"
  | "staff_confirmation";

export interface PendingDispatchCancel {
  provider: ProviderId | null;
  providerOrderId: string | null;
  reason: PendingCancelReason;
  state: PendingCancelState;
  /** True when this adapter can perform the cancellation itself. */
  providerCanCancel: boolean;
  requestedAt: any;
  requestedBy: string;
  attempts: number;
  lastAttemptAt: any;
  lastError: string | null;
  confirmedAt: any;
  confirmedBy: PendingCancelConfirmation | null;
  confirmedByName: string | null;
  /** Staff note recorded with a manual confirmation (dashboard reference). */
  confirmedNote: string | null;
  /** Staff-facing instruction while un-confirmed; null once resolved. */
  staffActionRequired: string | null;
}

/** States that still own the order and block a replacement dispatch. */
const BLOCKING_STATES: readonly PendingCancelState[] = [
  "pending",
  "manual_required",
  "dead_lettered",
];

export function providerDashboardLabel(provider: ProviderId | null): string {
  if (provider === "borzo") return "Borzo dashboard";
  if (provider === "porter") return "Porter enterprise dashboard";
  if (provider === "shadowfax") return "Shadowfax dashboard";
  return "provider dashboard";
}

/**
 * Shadowfax is the only provider our adapter can cancel remotely (documented
 * `PUT /api/v2/orders/{id}/cancel/`). Borzo and Porter expose no cancel API we
 * have evidence for, so their release is a dashboard step by a human.
 */
export function providerCanCancelRemotely(provider: ProviderId | null): boolean {
  return provider === "shadowfax";
}

export function manualCancelInstruction(
  provider: ProviderId | null,
  providerOrderId: string | null
): string {
  const booking = providerOrderId ? `booking ${providerOrderId}` : "the booking";
  return (
    `Cancel ${booking} in the ${providerDashboardLabel(provider)}, then confirm the ` +
    `cancellation (POST /dispatch/cancel/confirm). Booking another rider before that ` +
    `would put two riders on this order.`
  );
}

export function pendingCancelBlocking(order: any): PendingDispatchCancel | null {
  const record = order?.dispatchPendingCancel;
  if (!record || typeof record !== "object") return null;
  if (!BLOCKING_STATES.includes(record.state)) return null;
  return record as PendingDispatchCancel;
}

/** Serializable copy for API error bodies (timestamps stay as-is). */
export function pendingCancelSummary(record: PendingDispatchCancel): Record<string, any> {
  return {
    provider: record.provider ?? null,
    providerOrderId: record.providerOrderId ?? null,
    reason: record.reason,
    state: record.state,
    requestedBy: record.requestedBy ?? null,
    attempts: typeof record.attempts === "number" ? record.attempts : 0,
    lastError: record.lastError ?? null,
    staffActionRequired: record.staffActionRequired ?? null,
  };
}

/**
 * The single refusal every replacement dispatch returns. It carries the machine
 * code, the record (so the Partner app can render the exact reason), and copy
 * that names the provider dashboard and the confirm endpoint.
 */
export function dispatchCancelUnconfirmedError(record: PendingDispatchCancel): any {
  const provider = record.provider ?? null;
  const label = providerDashboardLabel(provider);
  let message: string;
  if (record.state === "pending") {
    message =
      `The ${label.replace(" dashboard", "")} cancellation for booking ` +
      `${record.providerOrderId || "?"} is still unconfirmed` +
      (record.attempts > 0 ? ` (attempt ${record.attempts})` : "") +
      ` — a rider may still be on the way. No replacement rider will be booked ` +
      `until the provider confirms it.`;
  } else if (record.state === "dead_lettered") {
    message =
      `The ${label.replace(" dashboard", "")} cancellation for booking ` +
      `${record.providerOrderId || "?"} could not be confirmed automatically. ` +
      `Cancel it in the ${label} and confirm it (POST /dispatch/cancel/confirm) ` +
      `before booking another rider — two riders on one order is worse than a delay.`;
  } else {
    message =
      `Booking ${record.providerOrderId || "?"} was released locally but was never ` +
      `confirmed cancelled with ${label.replace(" dashboard", "")} — no public cancel API. ` +
      `Cancel it in the ${label} and confirm it (POST /dispatch/cancel/confirm). ` +
      `Booking another rider now would put two riders on this order.`;
  }
  const err: any = new Error(message);
  err.statusCode = 409;
  err.code = "DISPATCH_CANCEL_UNCONFIRMED";
  err.pendingCancel = pendingCancelSummary(record);
  err.staffActionRequired =
    record.staffActionRequired || manualCancelInstruction(provider, record.providerOrderId);
  return err;
}

export interface PendingCancelWriteParams {
  provider: ProviderId | null;
  providerOrderId: string | null;
  reason: PendingCancelReason;
  requestedBy: string;
  state?: PendingCancelState;
  lastError?: string | null;
}

/** The write payload for a NEW un-confirmed record (all fields defined). */
export function buildPendingCancelWrite(
  params: PendingCancelWriteParams
): PendingDispatchCancel {
  const provider = params.provider ?? null;
  const providerOrderId = params.providerOrderId ?? null;
  const state: PendingCancelState =
    params.state ?? (providerCanCancelRemotely(provider) ? "pending" : "manual_required");
  return {
    provider,
    providerOrderId,
    reason: params.reason,
    state,
    providerCanCancel: providerCanCancelRemotely(provider),
    requestedAt: admin.firestore.FieldValue.serverTimestamp(),
    requestedBy: params.requestedBy || "Branch Staff",
    attempts: 0,
    lastAttemptAt: null,
    lastError: params.lastError ?? null,
    confirmedAt: null,
    confirmedBy: null,
    confirmedByName: null,
    confirmedNote: null,
    staffActionRequired:
      providerCanCancelRemotely(provider) ? null : manualCancelInstruction(provider, providerOrderId),
  };
}

/** The write payload for a CONFIRMED record. `record` is the pre-read value. */
export function buildPendingCancelConfirmation(
  record: PendingDispatchCancel,
  confirmedBy: PendingCancelConfirmation,
  confirmedByName: string | null,
  confirmedNote: string | null = null
): PendingDispatchCancel {
  return {
    ...record,
    state: "confirmed",
    confirmedAt: admin.firestore.FieldValue.serverTimestamp(),
    confirmedBy,
    confirmedByName: confirmedByName ?? null,
    confirmedNote: confirmedNote ?? null,
    staffActionRequired: null,
  };
}

/**
 * True when this record names the booking the provider just reported. Compared
 * on the normalized pair so `12` / `"12"` / `"0012"` are the same booking (the
 * same rule the webhook ownership proof uses).
 */
export function pendingCancelMatchesBooking(
  record: PendingDispatchCancel | null,
  provider: string,
  providerOrderId: unknown
): boolean {
  if (!record) return false;
  if (record.state === "confirmed") return false;
  if ((record.provider || "") !== provider) return false;
  const expected = normalizeBookingId(record.providerOrderId);
  const actual = normalizeBookingId(providerOrderId);
  if (!expected || !actual) return false;
  return expected === actual;
}

function normalizeBookingId(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = typeof value === "string" ? value.trim() : String(value);
  if (!s) return null;
  return /^\d+$/.test(s) ? s.replace(/^0+(?=\d)/, "") : s;
}

/**
 * Records provider evidence that a released booking is cancelled. Deliberately
 * touches ONLY `dispatchPendingCancel`: the order's delivery/status fields stay
 * exactly as they are (a released booking's callback never mutates the order).
 * Returns true when a record was confirmed.
 */
export async function confirmPendingCancelFromProvider(
  orderId: string,
  provider: string,
  providerOrderId: unknown,
  confirmedBy: PendingCancelConfirmation,
  expectedProviderOrderId?: string | null
): Promise<boolean> {
  try {
    const orderRef = db.collection("orders").doc(orderId);
    const snap = await orderRef.get();
    if (!snap.exists) return false;
    const order = (snap.data() || {}) as any;
    const record = order.dispatchPendingCancel;
    if (!pendingCancelMatchesBooking(record, provider, providerOrderId)) {
      // A stale/normalized mismatch is not proof about THIS record.
      if (expectedProviderOrderId != null) {
        if (!pendingCancelMatchesBooking(record, provider, expectedProviderOrderId)) return false;
      } else {
        return false;
      }
    }
    if ((order.dispatchPendingCancel?.state || "") === "confirmed") return false;
    await orderRef.set(
      {
        dispatchPendingCancel: buildPendingCancelConfirmation(
          order.dispatchPendingCancel as PendingDispatchCancel,
          confirmedBy,
          null
        ),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    return true;
  } catch (err: any) {
    console.warn(
      `[Dispatch Cancel] could not record provider confirmation for order ${orderId}:`,
      err?.message || err
    );
    return false;
  }
}
