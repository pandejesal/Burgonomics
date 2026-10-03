import {
  ProviderDispatchError,
  type DispatchQuoteContext,
  type ProviderId,
} from "../types";
import { config } from "../../../config/env";

/**
 * Shared provider plumbing: HTTP classification (DR3), address assembly from
 * the order doc, and the fare-delta confirm math (DR7). Provider-specific
 * payload shapes stay in their adapters — only these generic rules live here.
 */

const FETCH_TIMEOUT_MS = 15_000;

/**
 * HTTP → failure class (DR3). Auth/rate/5xx/network are the provider having a
 * bad day (retry the NEXT provider); other 4xx means this address/request is
 * wrong for them (not_serviced — do not walk into the same wall again).
 */
export function classifyHttpStatus(
  provider: ProviderId,
  status: number,
  detail?: string
): ProviderDispatchError {
  const tail = detail ? `: ${detail}` : "";
  if (status === 401 || status === 403 || status === 429 || status >= 500) {
    return new ProviderDispatchError(
      provider,
      "transient",
      `${provider} HTTP ${status} (transient)${tail}`
    );
  }
  return new ProviderDispatchError(
    provider,
    "not_serviced",
    `${provider} HTTP ${status} (not_serviced)${tail}`
  );
}

/** Network failure / abort timeout / DNS — always transient, never not_serviced. */
export function classifyThrown(provider: ProviderId, err: any): ProviderDispatchError {
  if (err instanceof ProviderDispatchError) return err;
  const msg = err?.message || String(err);
  return new ProviderDispatchError(provider, "transient", `${provider} request failed: ${msg}`);
}

export interface ProviderHttpResponse {
  status: number;
  ok: boolean;
  /** Parsed JSON body (null when the body was empty/non-JSON). */
  data: any;
  text: string;
}

/**
 * fetch → classified response. Throws ProviderDispatchError(transient) on
 * network/timeout only; HTTP error statuses come back for the caller to
 * classify (4xx vs 5xx differs by class).
 */
export async function fetchProviderJson(
  provider: ProviderId,
  url: string,
  init: RequestInit
): Promise<ProviderHttpResponse> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      // Loop precedent (porter.service): a hung gateway must not hold the
      // function until platform timeout — bound every provider call.
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    throw classifyThrown(provider, err);
  }
  const text = await response.text().catch(() => "");
  let data: any = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  return { status: response.status, ok: response.ok, data, text };
}

/** Non-OK HTTP → classified throw (DR3); OK responses pass through. */
export function assertProviderOk(res: ProviderHttpResponse, provider: ProviderId): void {
  if (!res.ok) {
    const detail =
      (res.data && (res.data.message || res.data.error)) ||
      res.text.slice(0, 200) ||
      undefined;
    throw classifyHttpStatus(provider, res.status, detail);
  }
}

/** Defensive fare extraction — provider payload keys are verified at key grant. */
export function pickFiniteNumber(...candidates: unknown[]): number | null {
  for (const c of candidates) {
    const n = typeof c === "string" ? Number(c) : c;
    if (typeof n === "number" && Number.isFinite(n) && n >= 0) return n;
  }
  return null;
}

/** Provider response without a parseable fare/id is a transient provider fault (DR3). */
export function unparseable(provider: ProviderId, what: string): ProviderDispatchError {
  return new ProviderDispatchError(
    provider,
    "transient",
    `${provider} returned an unparseable ${what} — response shape differs from spec (verify at key grant)`
  );
}

function contactLine(name: string | undefined, phone: string | undefined): string {
  return [name || "", phone || ""].filter(Boolean).join(" · ");
}

/**
 * Address blocks assembled from the order doc for provider create/quote
 * payloads. Built from REAL order fields only — a provider must never be
 * handed a fabricated address (H-R19: wrong-pin dispatches).
 */
export function pickupAddressBlock(order: Record<string, any> | undefined): string {
  const o = order || {};
  return [o.branchName, o.branchAddress, o.branchCity, o.branchState, o.branchPincode]
    .filter((v) => typeof v === "string" && v.trim())
    .join(", ");
}

export function dropAddressBlock(order: Record<string, any> | undefined): any {
  const drop = order?.deliveryAddress || {};
  return {
    house: drop.house || drop.flat || "",
    street: drop.street || drop.full || "",
    city: drop.city || "Ahmedabad",
    state: drop.state || "Gujarat",
    pincode: drop.pincode || "380015",
    line: [drop.house || drop.flat, drop.street || drop.full, drop.city, drop.pincode]
      .filter((v) => typeof v === "string" && v.trim())
      .join(", "),
  };
}

export function pickupContact(order: Record<string, any> | undefined): {
  name?: string;
  phone?: string;
} {
  const o = order || {};
  return {
    name: o.branchName || "Burgonomics Branch Staff",
    phone: o.branchPhone || undefined,
  };
}

export function dropContact(ctx: DispatchQuoteContext): { name?: string; phone?: string } {
  return {
    name: ctx.customerName || ctx.order?.customerName || "Customer",
    phone: ctx.customerPhone || ctx.order?.customerPhone || undefined,
  };
}

export { contactLine };

/**
 * DR7 fare gate: the delta the staff must confirm before the router commits a
 * booking that drifted from what the card showed them.
 * threshold = max(DISPATCH_FARE_CONFIRM_DELTA_INR, 10% of quoted).
 */
export function fareConfirmCheck(
  quotedFare: number,
  newFare: number,
  deltaInrConfig: number
): { needsConfirm: boolean; delta: number; threshold: number } {
  const delta = Math.abs(newFare - quotedFare);
  const threshold = Math.max(deltaInrConfig, quotedFare * 0.1);
  return { needsConfirm: delta >= threshold, delta, threshold };
}

/** Deterministic [TEST]-marked mock rider pools (DR11 — never indistinguishable). */
export function mockRider(provider: ProviderId, suffix: string): {
  name: string;
  phone: string;
  vehicle: string;
} {
  const pools: Record<ProviderId, Array<{ name: string; phone: string; vehicle: string }>> = {
    borzo: [
      { name: "Borzo Rider Kiran", phone: "+91 98250 11001", vehicle: "GJ-01-BZ-1001" },
      { name: "Borzo Rider Mehul", phone: "+91 97123 41002", vehicle: "GJ-27-BZ-2002" },
    ],
    shadowfax: [
      { name: "Shadowfax Rider Jignesh", phone: "+91 99090 71003", vehicle: "GJ-01-SF-3003" },
      { name: "Shadowfax Rider Pratik", phone: "+91 91234 51004", vehicle: "GJ-06-SF-4004" },
    ],
    porter: [
      { name: "Porter Rider Nimesh", phone: "+91 98765 11005", vehicle: "GJ-01-PR-5005" },
      { name: "Porter Rider Bhavesh", phone: "+91 99887 11006", vehicle: "GJ-05-PR-6006" },
    ],
  };
  const pool = pools[provider];
  const pick = pool[Math.abs(hashCode(suffix)) % pool.length];
  // DR11: mock riders carry the [TEST] prefix everywhere they surface.
  return { ...pick, name: `[TEST] ${pick.name}` };
}

function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

/** Quote TTL shared by every provider (D6/DR7: fares live 10 minutes). */
export const QUOTE_TTL_MS = 600 * 1000;

/** Standard mock rate cards (deterministic; see delivery_routing.md DR11). */
export function mockRateFare(provider: ProviderId, distanceKm: number): number {
  if (provider === "borzo") return Math.round(38 + 9 * distanceKm);
  if (provider === "shadowfax") return Math.round(42 + 10 * distanceKm);
  return Math.round(40 + Math.max(0, distanceKm - 2) * 10);
}

export function dispatchTimeoutMs(): number {
  return config.dispatch.quoteTimeoutMs;
}
