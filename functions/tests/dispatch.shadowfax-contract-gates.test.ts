import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";

/**
 * Shadowfax contract-gate pins (lane9, fresh-team 2026-10-20).
 *
 * Scope of this file (and of the source change it guards):
 *   1. A MISSING API TOKEN must refuse BEFORE any provider wire call. The
 *      router never gets here (isEligible() requires the key), so this is a
 *      defence-in-depth pin for a direct adapter call: without it,
 *      `shadowfaxHeaders()` would send `Authorization: Token ` and the resulting
 *      provider 401 is classified `transient`, i.e. a silent failover to another
 *      courier for a LOCAL config fault. The refusal is a plain Error (not a
 *      ProviderDispatchError), so the router cannot walk the ranked list.
 *   2. The existing CONTRACT gate is unchanged: credentials alone stay
 *      ineligible until a human records SHADOWFAX_CONTRACT_VERIFIED.
 *
 * Deliberately NOT pinned here (main-scoped decisions, no policy change in this
 * commit): declared `order_value`/`paid` semantics (F4) and any provider
 * payload/path claim — the vendor contract remains unverified.
 *
 * Harness: real `Response`, stubbed `global.fetch` (same technique as
 * tests/dispatch.provider-contract.test.ts). No firebase-admin, no provider
 * call, no credentials.
 */

import { shadowfaxAdapter } from "../src/modules/dispatch/providers/shadowfax.adapter";
import { config } from "../src/config/env";
import { ProviderDispatchError, type DispatchQuoteContext } from "../src/modules/dispatch/types";

const PICKUP = { lat: 23.0131, lng: 72.5085 };
const DROP = { lat: 23.0338, lng: 72.5262 };

const okJson = (data: any, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

function ctx(overrides: Partial<DispatchQuoteContext> = {}): DispatchQuoteContext {
  return {
    pickup: PICKUP,
    drop: DROP,
    customerName: "Aarav Shah",
    customerPhone: "+91 99999 88888",
    orderId: "ord_sfx_gate",
    order: {
      branchName: "Burgonomics CG Road",
      store: { name: "Burgonomics CG Road", phone: "+91 98250 12345" },
      deliveryAddress: {
        full: "102, Shivalik Highstreet, Vastrapur",
        city: "Ahmedabad",
        lat: DROP.lat,
        lng: DROP.lng,
      },
      // A prepaid marker already accepted by paidFlag() — NOT a policy pin: the
      // authoritative paid-marker decision belongs to the payments lane.
      paymentStatus: "completed",
    },
    ...overrides,
  };
}

const originalFetch = globalThis.fetch;
let fetchCalls: Array<{ url: string; init: any }> = [];
let fetchHandler: ((url: string, init: any) => Response) | null = null;
let saved: { shadowfax: any; mock: any };

beforeAll(() => {
  globalThis.fetch = vi.fn(async (url: any, init: any) => {
    const u = String(url);
    fetchCalls.push({ url: u, init });
    if (fetchHandler) return fetchHandler(u, init);
    return okJson({ message: "no fetch handler registered" }, 404);
  }) as any;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

beforeEach(() => {
  saved = { shadowfax: { ...config.shadowfax }, mock: { ...config.mock } };
  fetchCalls = [];
  fetchHandler = null;
  config.shadowfax.enabled = true;
  config.shadowfax.baseUrl = "https://hlbackend.staging.shadowfax.in";
  config.shadowfax.apiKey = "";
  config.shadowfax.clientCode = "test_sfx_client";
  config.shadowfax.webhookSecret = "";
  config.shadowfax.contractVerified = false;
  config.mock.shadowfaxDispatch = false;
});

afterEach(() => {
  config.shadowfax = { ...saved.shadowfax };
  config.mock = { ...saved.mock };
});

/** Resolves with the rejection reason — fails if the call resolved. */
async function capture(promise: Promise<unknown>): Promise<any> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected the adapter call to reject, but it resolved");
}

describe("shadowfax empty-credential refusal (pre-wire)", () => {
  it("quote() refuses with a typed LOCAL config error and never reaches the wire", async () => {
    const err = await capture(shadowfaxAdapter.quote(ctx()));

    expect(err.code).toBe("DISPATCH_PROVIDER_UNCONFIGURED");
    expect(err.statusCode).toBe(503);
    expect(err.message).toMatch(/SHADOWFAX_API_KEY/);
    // Plain Error: the router only walks on ProviderDispatchError, so a config
    // fault cannot release the claim and book a different real courier.
    expect(err).not.toBeInstanceOf(ProviderDispatchError);
    expect(err.kind).toBeUndefined();
    expect(fetchCalls).toHaveLength(0);
  });

  it("book() refuses the same way before any create-order call", async () => {
    const err = await capture(
      shadowfaxAdapter.book({ ...ctx(), orderId: "ord_sfx_gate_book", quote: undefined as any })
    );

    expect(err.code).toBe("DISPATCH_PROVIDER_UNCONFIGURED");
    expect(err.statusCode).toBe(503);
    expect(err).not.toBeInstanceOf(ProviderDispatchError);
    expect(fetchCalls).toHaveLength(0);
  });

  it("a whitespace-only token is treated as missing (isEligible only checks truthiness)", async () => {
    config.shadowfax.apiKey = "   ";

    const err = await capture(shadowfaxAdapter.quote(ctx()));

    expect(err.code).toBe("DISPATCH_PROVIDER_UNCONFIGURED");
    expect(fetchCalls).toHaveLength(0);
  });

  it("book() refuses a whitespace-only token BEFORE the clientCode check", async () => {
    // Empty clientCode would otherwise throw a walkable transient error; the
    // credential guard must win, otherwise the ordering hides a config fault
    // behind a provider-failure class.
    config.shadowfax.apiKey = "   ";
    config.shadowfax.clientCode = "";

    const err = await capture(
      shadowfaxAdapter.book({ ...ctx(), orderId: "ord_sfx_gate_ws_book", quote: undefined as any })
    );

    expect(err.code).toBe("DISPATCH_PROVIDER_UNCONFIGURED");
    expect(err).not.toBeInstanceOf(ProviderDispatchError);
    expect(fetchCalls).toHaveLength(0);
  });

  it("a padded token is sent TRIMMED — validate what you actually send", async () => {
    config.shadowfax.apiKey = "  test_sfx_token  ";
    fetchHandler = () => okJson({ serviceable: true, delivery_cost: 42 });

    await shadowfaxAdapter.quote(ctx());

    expect(fetchCalls).toHaveLength(1);
    // A newline/space pasted into the secret would otherwise reach the wire and
    // be rejected 401 -> transient -> a silent walk for a local config fault.
    expect(fetchCalls[0].init.headers.Authorization).toBe("Token test_sfx_token");
  });

  it("positive control: a keyed quote reaches the wire exactly once with the Token header", async () => {
    config.shadowfax.apiKey = "test_sfx_token";
    fetchHandler = () => okJson({ serviceable: true, delivery_cost: 42, pickup_eta: 6 });

    const quote = await shadowfaxAdapter.quote(ctx());

    expect(quote.fare).toBe(42);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe(
      "https://hlbackend.staging.shadowfax.in/api/v1/order-serviceability/"
    );
    expect(fetchCalls[0].init.method).toBe("PUT");
    expect(fetchCalls[0].init.headers.Authorization).toBe("Token test_sfx_token");
  });

  it("positive control: a keyed book reaches the wire and returns the provider order id", async () => {
    config.shadowfax.apiKey = "test_sfx_token";
    fetchHandler = () => okJson({ sfx_order_id: "SFX-GATE-1", track_url: "https://sfx/track/1" });

    const booked = await shadowfaxAdapter.book({
      ...ctx(),
      orderId: "ord_sfx_gate_book_ok",
      quote: undefined as any,
    });

    expect(booked.kind).toBe("booked");
    expect(booked.providerOrderId).toBe("SFX-GATE-1");
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe(
      "https://hlbackend.staging.shadowfax.in/api/v2/orders/"
    );
    const sent = JSON.parse(String(fetchCalls[0].init.body));
    expect(sent.client_code).toBe("test_sfx_client");
  });

  it("the mock path still runs with no key and makes no wire call", async () => {
    config.mock.shadowfaxDispatch = true;

    const quote = await shadowfaxAdapter.quote(ctx());

    expect(quote.source).toBe("shadowfax_mock_rate_card");
    expect(fetchCalls).toHaveLength(0);
  });
});

describe("shadowfax contract gate (unchanged)", () => {
  it("credentials alone cannot enable the provider", () => {
    config.shadowfax.apiKey = "test_sfx_token";
    config.shadowfax.clientCode = "test_sfx_client";
    config.shadowfax.contractVerified = false;

    expect(shadowfaxAdapter.isEligible()).toBe(false);
  });

  it("the explicit human contract flag is what enables it", () => {
    config.shadowfax.apiKey = "test_sfx_token";
    config.shadowfax.clientCode = "test_sfx_client";
    config.shadowfax.contractVerified = true;

    expect(shadowfaxAdapter.isEligible()).toBe(true);
  });

  it("an empty token keeps it ineligible even with the flag set", () => {
    config.shadowfax.apiKey = "";
    config.shadowfax.clientCode = "test_sfx_client";
    config.shadowfax.contractVerified = true;

    expect(shadowfaxAdapter.isEligible()).toBe(false);
  });

  it("the mock flag is the only keyless path, and a disabled provider stays out", () => {
    config.mock.shadowfaxDispatch = true;
    config.shadowfax.apiKey = "";
    config.shadowfax.enabled = true;
    expect(shadowfaxAdapter.isEligible()).toBe(true);

    config.shadowfax.enabled = false;
    expect(shadowfaxAdapter.isEligible()).toBe(false);
  });
});
