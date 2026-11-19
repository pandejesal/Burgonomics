import {
  ProviderDispatchError,
  type DispatchQuoteContext,
  type ProviderId,
} from "../types";
import { config } from "../../../config/env";
import { normalizePhone } from "../dropContact";

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

/**
 * Network failure / abort timeout / DNS — always transient, never not_serviced.
 *
 * The ORIGINAL transport cause is retained (audit F08): the old version kept
 * only the top-level message, so a caller could not tell a pre-send DNS failure
 * from a post-send connection reset. The walk below is bounded (6 hops) and
 * cycle-safe via a seen set, and reads properties defensively because a
 * hostile/odd error object can throw from a getter.
 */
export function classifyThrown(
  provider: ProviderId,
  err: any,
  opts: { fromWire?: boolean } = {}
): ProviderDispatchError {
  // A LOCAL throw that is ALREADY typed (built before any fetch) keeps its exact
  // identity and zero-fetch classification. A typed error thrown FROM the wire
  // (inside fetch) is NOT local evidence, so it must be wrapped with its
  // original cause and default to ambiguity downstream (audit F08 R4).
  if (err instanceof ProviderDispatchError && !opts.fromWire) return err;
  const summary = summarizeThrown(err);
  const tail = summary.messages.length > 0 ? `: ${summary.messages.join(" <- ")}` : "";
  const dispatchErr = new ProviderDispatchError(provider, "transient", `${provider} request failed${tail}`);
  // (F08) Retain the ORIGINAL throwable and its bounded code list. Without this
  // a caller could not tell a proven pre-send DNS failure (safe to fail over)
  // from a post-send reset (uncertainty that must park). Only codes/messages
  // are retained — never request headers, bodies or credentials.
  (dispatchErr as any).cause = err;
  (dispatchErr as any).transportCodes = summary.codes;
  (dispatchErr as any).thrownFromWire = opts.fromWire === true;
  return dispatchErr;
}

/** Bounded, cycle-safe transport-cause summary (never logs headers or bodies). */
export interface ThrownSummary {
  codes: string[];
  messages: string[];
  hops: number;
}

const MAX_CAUSE_HOPS = 6;
/** Property read that survives a throwing getter or a non-object throwable. */
function safeRead(value: any, key: string): any {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "object" && typeof value !== "function") return undefined;
  try {
    return (value as any)[key];
  } catch {
    return undefined;
  }
}

function clip(value: unknown, max = 200): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

/**
 * Walks `err` then its `cause` chain (max 4 hops, stopping on repeat) collecting
 * the transport codes and bounded messages. `code` may be a string, an array
 * (AggregateError), or absent (undici's "fetch failed" wrapper).
 */
export function summarizeThrown(err: unknown): ThrownSummary {
  const codes: string[] = [];
  const messages: string[] = [];
  const seen = new Set<unknown>();
  let node: any = err;
  let hops = 0;
  while (node !== undefined && node !== null && hops < MAX_CAUSE_HOPS) {
    if (seen.has(node)) break;
    seen.add(node);
    hops += 1;
    const code = safeRead(node, "code");
    if (typeof code === "string" && code.trim()) codes.push(code.trim());
    else if (Array.isArray(code)) {
      for (const entry of code) {
        const c = clip(entry, 40);
        if (c) codes.push(c);
      }
    }
    const message = clip(safeRead(node, "message"));
    if (message) messages.push(message);
    node = safeRead(node, "cause");
  }
  // De-duplicate message fragments (undici often repeats the same text).
  const uniqueMessages = messages.filter((m, i) => messages.indexOf(m) === i);
  const uniqueCodes = codes.filter((c, i) => codes.indexOf(c) === i);
  // A code found ONLY deeper in the chain is still the decisive signal (a
  // wrapper message like "socket wrapper" is not). Surface the deepest distinct
  // code on the shallow message so operators/receipts see ECONNRESET, and keep
  // the full list in `codes`.
  if (uniqueCodes.length > 0 && uniqueMessages.length > 0) {
    const last = uniqueMessages[uniqueMessages.length - 1];
    const missing = uniqueCodes.filter((c) => !last.includes(c));
    if (missing.length > 0) uniqueMessages.push(missing.join(","));
  }
  return { codes: uniqueCodes, messages: uniqueMessages, hops };
}

/** First transport code found anywhere in the bounded cause chain. */
export function thrownCodes(err: unknown): string[] {
  return summarizeThrown(err).codes;
}

/**
 * Codes that PROVE the create-order never left the process: name resolution
 * failed or the peer refused the connection. Only these may still fail over.
 * (A reset/timeout/abort happens AFTER bytes may have been sent and is
 * therefore uncertainty — see `createOrderUncertain`.)
 */
const PRE_SEND_TRANSPORT_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED"]);

/**
 * TRUE only for a PROVEN pre-send transport failure (safe to walk).
 *
 * (F08 R3) Proof requires EVERY observed transport code to be a pre-send code
 * AND at least one to be present. A chain carrying both an `ECONNRESET` (bytes
 * may have gone out) and an `ENOTFOUND` proves nothing — conflicting evidence is
 * uncertainty, which must win. Only a chain made purely of DNS/refused codes
 * (the justified failover cases) is walkable.
 */
export function isProvenPreSendFailure(err: unknown): boolean {
  const codes = thrownCodes(err);
  if (codes.length === 0) return false;
  return codes.every((code) => PRE_SEND_TRANSPORT_CODES.has(code));
}

/**
 * Create-order acceptance ambiguity (F08). A PLAIN error (no `kind`) so the
 * router cannot treat it as a walkable provider fault: it releases the claim,
 * parks `needs_reconciliation` and books nothing else. `provider` is carried so
 * the parked record and staff-visible error name the carrier that may hold the
 * booking.
 *
 * (F08 R5) The PUBLIC text carries only: the caller's fixed safe reason, an
 * allowlisted transport code list, and validated order-id evidence. The nested
 * provider/transport messages are NEVER appended — a provider body, an auth
 * header or customer PII could otherwise reach `dispatchError`. The ORIGINAL
 * throwable is retained as a NON-ENUMERABLE `cause` for reconciliation.
 */
const PUBLIC_TRANSPORT_CODES = new Set([
  "ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EPIPE", "ENOTFOUND", "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET", "ABORT_ERR", "ERR_SOCKET_CONNECTION_TIMEOUT",
]);
const transportLabel = (codes: string[]): string => {
  const safe = codes.filter((c) => PUBLIC_TRANSPORT_CODES.has(c));
  return safe.length > 0 ? ` [${safe.join(",")}]` : "";
};
/** Bounded, sanitised order-id echo: only a plausible id shape reaches text. */
const MAX_ECHO_ID = 64;
const orderIdLabel = (id?: string): string =>
  typeof id === "string" && id.trim() && id.trim().length <= MAX_ECHO_ID && /^[A-Za-z0-9_.:\-]+$/.test(id.trim())
    ? ` (provider order id: ${id.trim()})`
    : "";

export function bookAmbiguous(
  provider: ProviderId,
  message: string,
  cause?: unknown,
  providerOrderId?: string
): Error {
  const codes = cause === undefined ? [] : summarizeThrown(cause).codes;
  const err: any = new Error(`${message}${orderIdLabel(providerOrderId)}${transportLabel(codes)}`);
  err.statusCode = 502;
  err.code = "PROVIDER_BOOK_AMBIGUOUS";
  err.provider = provider;
  if (providerOrderId) err.providerOrderId = providerOrderId;
  if (cause !== undefined) {
    // Non-enumerable: invisible to JSON/Object.keys and any log that serialises
    // the error, but still inspectable by a reconciliation operator.
    Object.defineProperty(err, "cause", { value: cause, enumerable: false, configurable: true });
    const safeCodes = codes.filter((c) => PUBLIC_TRANSPORT_CODES.has(c));
    if (safeCodes.length > 0) {
      Object.defineProperty(err, "transportCodes", { value: safeCodes, enumerable: false, configurable: true });
    }
  }
  return err;
}

/**
 * A create-order HTTP response that cannot prove REJECTION: a 5xx gateway/
 * provider fault or a response whose body could not be read at all. Either way
 * the request was accepted by the wire and the order MAY exist, so the caller
 * must park, not walk.
 */
export function createOrderResponseUncertain(res: ProviderHttpResponse): boolean {
  return res.status >= 500 || res.textReadError === true;
}


export interface ProviderHttpResponse {
  status: number;
  ok: boolean;
  /** Parsed JSON body (null when the body was empty/non-JSON). */
  data: any;
  text: string;
  /**
   * TRUE when `response.text()` itself threw (F08): the HTTP status is known but
   * the receipt is not. A booking path must treat that as uncertainty — the
   * provider may have accepted — never as a rejection it can walk past.
   */
  textReadError?: boolean;
  /** Bounded message from the failed body read (never the raw body). */
  textReadErrorMessage?: string;
}

/**
 * fetch → classified response. Throws ProviderDispatchError(transient) on
 * network/timeout only; HTTP error statuses come back for the caller to
 * classify (4xx vs 5xx differs by class). A body-read failure is NOT swallowed:
 * it comes back as `textReadError` so a create-order path cannot mistake an
 * unreadable acceptance for a rejection (audit F08).
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
    // fromWire: this throw came from INSIDE fetch, so even a typed error is not
    // local pre-wire evidence (F08 R4).
    throw classifyThrown(provider, err, { fromWire: true });
  }
  let text = "";
  let textReadError = false;
  let textReadErrorMessage: string | undefined;
  try {
    text = (await response.text()) ?? "";
  } catch (err) {
    textReadError = true;
    const summary = summarizeThrown(err);
    textReadErrorMessage =
      summary.messages[summary.messages.length - 1] ||
      `unreadable ${provider} response body`;
  }
  let data: any = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  return {
    status: response.status,
    ok: response.ok,
    data,
    text,
    ...(textReadError ? { textReadError, textReadErrorMessage } : {}),
  };
}

/** Non-OK HTTP → classified throw (DR3); OK responses pass through. */
export function assertProviderOk(res: ProviderHttpResponse, provider: ProviderId): void {
  if (!res.ok) {
    const detail =
      (res.data && (res.data.message || res.data.error || res.data.detail)) ||
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
  const drop = order?.deliveryAddress || order?.address || {};
  return {
    house: drop.house || drop.flat || drop.line1 || "",
    street: drop.street || drop.full || drop.line2 || "",
    // Locality keys carry ONLY what the order actually has: defaulting to
    // Ahmedabad/Gujarat/380015 geocoded a drop pin in another city to the wrong
    // locality (audit finding 6). Empty means "unknown", never "somewhere else".
    city: drop.city || "",
    state: drop.state || "",
    pincode: drop.pincode || "",
    line: [
      drop.house || drop.flat || drop.line1,
      drop.street || drop.full || drop.line2,
      drop.city,
      drop.pincode,
    ]
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
    name: o.store?.name || o.branchName || "Burgonomics Branch Staff",
    // The branch's own number. Real orders carry it as `store.phone` — a
    // REQUIRED field of the client's OrderStoreSnapshot, written at order
    // creation (OrderRepository/PaymentRepository). `branchPhone` is a legacy
    // alias. There is deliberately NO fallback to the customer's number: the
    // courier would be told to ring a different person to find the store
    // (audit 2026-10-17 findings 4/5, bridge removed on review). A pre-snapshot
    // order therefore sends no pickup contact — `store.phone` needs backfilling
    // there — instead of a wrong one.
    phone: o.store?.phone || o.branchPhone || undefined,
  };
}

export function dropContact(ctx: DispatchQuoteContext): { name?: string; phone?: string } {
  // P1-F: the router resolves the contact (order → address → verified Auth
  // profile) and passes it in `ctx`. This fallback reads the same order fields
  // in the same order so an adapter reached without the router context (a direct
  // call, a test harness) cannot resurrect the old "only order.customerPhone"
  // gap that made every real delivery order unbookable. No invented number: a
  // miss stays undefined and the adapter's own gate refuses the booking.
  const orderPhone =
    normalizePhone(ctx.customerPhone) ??
    normalizePhone(ctx.order?.customerPhone) ??
    normalizePhone(ctx.order?.deliveryAddress?.contactPhone) ??
    normalizePhone(ctx.order?.address?.contactPhone);
  return {
    name:
      ctx.customerName ||
      ctx.order?.deliveryAddress?.contactName ||
      ctx.order?.address?.contactName ||
      ctx.order?.customerName ||
      "Customer",
    phone: orderPhone || undefined,
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
