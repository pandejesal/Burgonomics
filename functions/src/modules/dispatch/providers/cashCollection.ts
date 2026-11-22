/**
 * Courier cash-collection contract (fix wave `cod-courier`, 2026-11-22).
 *
 * Pure helpers shared by the branch COD gate and the two courier adapters.
 * No Firestore, no network, no client input: the amount always comes from the
 * server-written `cashDuePaise`. The one imported type lets a provider-specific
 * refusal walk to the branch's other ready courier at book time.
 *
 * Owner decision 2026-11-22: Burgonomics has no in-house riders yet, so every
 * COD DELIVERY is carried by Borzo or Shadowfax and that rider must collect the
 * cash. Until the owner explicitly configures a branch/provider readiness flag,
 * delivery COD stays OFF and the customer is told cash is takeaway-only.
 */

import { ProviderDispatchError } from "../types";

export type CourierProviderId = "borzo" | "shadowfax";

export interface CodCourierReadiness {
  enabled: boolean;
  providers: Record<CourierProviderId, boolean>;
}

export const COURIER_COD_DISABLED_MESSAGE =
  "Courier cash collection is not enabled for this branch yet. " +
  "Cash is available for takeaway only. Please pay online or choose takeaway.";

export const DEFAULT_COURIER_COD_READINESS: CodCourierReadiness = {
  enabled: false,
  providers: { borzo: false, shadowfax: false },
};

const COURIER_PROVIDERS: readonly CourierProviderId[] = ["borzo", "shadowfax"];

function codError(code: string, message: string): Error {
  const err: any = new Error(message);
  err.code = code;
  err.statusCode = 409;
  return err;
}

/** Clone the OFF default so callers cannot mutate the shared constant. */
export function defaultCourierCodReadiness(): CodCourierReadiness {
  return {
    enabled: DEFAULT_COURIER_COD_READINESS.enabled,
    providers: { ...DEFAULT_COURIER_COD_READINESS.providers },
  };
}

/**
 * Parse `branches/{id}.cashOnDelivery.courierCod` (or the snapshot on an order).
 * Absent/falsy means OFF. A malformed flag refuses loudly — never "assume ready".
 */
export function resolveCourierCodReadiness(raw: unknown, branchId?: string): CodCourierReadiness {
  if (raw === undefined || raw === null) return defaultCourierCodReadiness();
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      `branch courierCod config is not an object for ${branchId || "(unknown)"} — refusing cash delivery`
    );
  }
  const block = raw as Record<string, unknown>;
  if (block.enabled !== undefined && typeof block.enabled !== "boolean") {
    throw new Error(
      `branch courierCod.enabled is not a boolean for ${branchId || "(unknown)"} — refusing cash delivery`
    );
  }
  const rawProviders = block.providers;
  const providers = defaultCourierCodReadiness().providers;
  if (rawProviders !== undefined && rawProviders !== null) {
    if (typeof rawProviders !== "object" || Array.isArray(rawProviders)) {
      throw new Error(
        `branch courierCod.providers is not an object for ${branchId || "(unknown)"} — refusing cash delivery`
      );
    }
    for (const key of Object.keys(rawProviders)) {
      if (!COURIER_PROVIDERS.includes(key as CourierProviderId)) {
        throw new Error(
          `branch courierCod.providers names unknown provider "${key}" for ${branchId || "(unknown)"} — refusing cash delivery`
        );
      }
    }
    for (const provider of COURIER_PROVIDERS) {
      const value = (rawProviders as Record<string, unknown>)[provider];
      if (value !== undefined && typeof value !== "boolean") {
        throw new Error(
          `branch courierCod.providers.${provider} is not a boolean for ${branchId || "(unknown)"} — refusing cash delivery`
        );
      }
      providers[provider] = value === true;
    }
  }
  return { enabled: block.enabled === true, providers };
}

/** A provider is ready only when BOTH the branch switch and its own flag are on. */
export function courierCodReady(
  readiness: CodCourierReadiness | undefined | null,
  provider: CourierProviderId
): boolean {
  return readiness?.enabled === true && readiness.providers?.[provider] === true;
}

/** At least one courier must be explicitly ready before delivery COD is offered. */
export function anyCourierCodReady(readiness: CodCourierReadiness | undefined | null): boolean {
  return COURIER_PROVIDERS.some((provider) => courierCodReady(readiness, provider));
}

/**
 * Only Borzo/Shadowfax quotes approved BOTH at checkout (order snapshot) and
 * now (live branch) survive COD ranking. A courier enabled after checkout must
 * not win the fare confirmation or the booking.
 */
export function codReadyQuotes<T extends { provider: string }>(
  quotes: T[],
  current: CodCourierReadiness | undefined | null,
  snapshot?: CodCourierReadiness | null
): T[] {
  return quotes.filter(
    (q) =>
      (q.provider === "borzo" || q.provider === "shadowfax") &&
      courierCodReady(current, q.provider) &&
      (snapshot === undefined || courierCodReady(snapshot, q.provider))
  );
}

/** Server marker only — a body-supplied "cash" claim is never trusted here. */
export function isServerCashOrder(order: Record<string, any> | undefined): boolean {
  if (!order || typeof order !== "object") return false;
  if (order.paymentChannel === "cash" || order.payment?.channel === "cash") return true;
  const method = String(
    order.payment?.method ?? order.paymentMethod ?? order.orderPaymentMethod ?? ""
  )
    .trim()
    .toLowerCase();
  return method === "cod" || method === "cash";
}

function isDeliveryOrder(order: Record<string, any> | undefined): boolean {
  const type = order?.orderType ?? order?.fulfillment ?? order?.fulfillmentType;
  return typeof type !== "string" || type === "delivery";
}

/** A COD order whose money must be collected at the door by a courier. */
export function isCourierCashDelivery(order: Record<string, any> | undefined): boolean {
  return isServerCashOrder(order) && isDeliveryOrder(order);
}

/** The only amount a courier may be told to collect: the server's cashDuePaise. */
export function courierCashDuePaise(order: Record<string, any> | undefined): number | null {
  if (!isServerCashOrder(order)) return null;
  const raw = order?.cashDuePaise;
  // Never coerce: Number(null) / Number("") are 0 and a blank string is not a
  // promise to collect nothing. Only a raw non-negative safe integer is money.
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0) {
    throw codError("COD_CASH_DUE_MISSING", "COD order has no valid server cashDuePaise — refusing to book");
  }
  return raw;
}

/** Borzo `money` is a JSON string with exactly two decimals (docs, line 141-144). */
export function borzoMoneyString(paise: number): string {
  if (typeof paise !== "number" || !Number.isSafeInteger(paise) || paise < 0) {
    throw new Error(`Invalid Borzo money amount: ${paise}`);
  }
  const rupees = Math.floor(paise / 100);
  const remainder = paise % 100;
  return `${rupees}.${String(remainder).padStart(2, "0")}`;
}

/**
 * Per-provider booking gate. Called by each courier adapter so a branch that
 * enabled only Borzo keeps its Shadowfax quotes for ONLINE orders while never
 * booking a COD delivery with an unready provider. The typed `not_serviced`
 * refusal lets the router walk to the branch's OTHER ready courier.
 */
export function assertCourierCodProviderReady(
  order: Record<string, any> | undefined,
  provider: CourierProviderId,
  current?: CodCourierReadiness
): void {
  if (!isCourierCashDelivery(order)) return;
  const snapshot = resolveCourierCodReadiness(order?.cashOnDelivery?.courierCod);
  // The order snapshot proves the checkout decision; the CURRENT branch flag
  // proves it was not revoked afterwards. Booking/rebooking requires both.
  if (!courierCodReady(snapshot, provider) || (current !== undefined && !courierCodReady(current, provider))) {
    throw new ProviderDispatchError(
      provider,
      "not_serviced",
      `${provider} cash collection is not enabled for this branch yet. ` +
        "Cash is available for takeaway only. Please pay online or choose takeaway."
    );
  }
}

/**
 * Live branch approval for courier cash. Read fresh (no pricing cache) so a
 * revocation stops the next booking; any read/parse failure is OFF.
 */
export async function loadCurrentCourierCodReadiness(
  branchId?: string
): Promise<CodCourierReadiness> {
  if (!branchId) return defaultCourierCodReadiness();
  try {
    const { db } = await import("../../../core/firebase");
    if (!db || typeof db.collection !== "function") return defaultCourierCodReadiness();
    const snap = await db.collection("branches").doc(branchId).get();
    if (!snap.exists) return defaultCourierCodReadiness();
    return resolveCourierCodReadiness(snap.data()?.cashOnDelivery?.courierCod, branchId);
  } catch (err: any) {
    console.error(
      `[dispatch] courier COD readiness unreadable for ${branchId}; refusing cash delivery`,
      err?.message || err
    );
    return defaultCourierCodReadiness();
  }
}

/** Booking/rebooking gate: order snapshot AND the branch's current approval. */
export async function assertCourierCodBookingAllowed(
  order: Record<string, any> | undefined,
  provider: CourierProviderId
): Promise<void> {
  if (!isCourierCashDelivery(order)) return;
  const current = await loadCurrentCourierCodReadiness(order?.branchId);
  assertCourierCodProviderReady(order, provider, current);
}
