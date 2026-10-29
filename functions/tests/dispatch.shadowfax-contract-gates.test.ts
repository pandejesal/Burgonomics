import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";

/**
 * Shadowfax contract-gate pins (lane9, fresh-team 2026-10-20).
 *
 * Scope of this file (and of the source change it guards):
 *   1. A MISSING API TOKEN must refuse BEFORE any provider wire call. The
 *      router never gets here (isEligible() requires the key), so this is a
 *      defence-in-depth pin for a direct adapter call: without it,
 *      `shadowfaxHeaders()` would send `Authorization: Bearer ` and the resulting
 *      provider 401 is classified `transient`, i.e. a silent failover to another
 *      courier for a LOCAL config fault. The refusal is a plain Error (not a
 *      ProviderDispatchError), so the router cannot walk the ranked list.
 *   2. The existing CONTRACT gate is unchanged: credentials alone stay
 *      ineligible until a human records SHADOWFAX_CONTRACT_VERIFIED.
 *
 * The official Shadowfax developer docs captured 2026-10-29 now pin the
 * serviceability/book paths, Bearer auth and the nested `{message,data}`
 * response shape. Live traffic remains behind SHADOWFAX_CONTRACT_VERIFIED
 * until a human confirms the vendor-issued packet and credentials.
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
    expect(fetchCalls[0].init.headers.Authorization).toBe("Bearer test_sfx_token");
  });

  it("positive control: a keyed quote reaches the wire exactly once with the Bearer header", async () => {
    config.shadowfax.apiKey = "test_sfx_token";
    fetchHandler = () => okJson({ serviceable: true, delivery_cost: 42, pickup_eta: 6 });

    const quote = await shadowfaxAdapter.quote(ctx());

    expect(quote.fare).toBe(42);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe(
      "https://hlbackend.staging.shadowfax.in/api/v1/order-serviceability/"
    );
    expect(fetchCalls[0].init.method).toBe("PUT");
    expect(fetchCalls[0].init.headers.Authorization).toBe("Bearer test_sfx_token");
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

  it("unwraps the documented { message, data } booking response", async () => {
    config.shadowfax.apiKey = "test_sfx_token";
    fetchHandler = () =>
      okJson(
        {
          message: "Order placed successfully",
          data: {
            sfx_order_id: 12345,
            track_url: "https://sfx/track/nested",
            rider_details: {
              name: "Nested Rider",
              contact_number: "9999999999",
              vehicle_number: "GJ01AB1234",
            },
          },
        },
        201
      );

    const booked = await shadowfaxAdapter.book({
      ...ctx(),
      orderId: "ord_sfx_nested_ok",
      quote: undefined as any,
    });

    expect(booked.kind).toBe("booked");
    expect(booked.providerOrderId).toBe("12345");
    expect(booked.trackingUrl).toBe("https://sfx/track/nested");
    expect(booked.riderName).toBe("Nested Rider");
    expect(booked.riderPhone).toBe("9999999999");
    expect(booked.riderVehicleNumber).toBe("GJ01AB1234");
  });

  it("the mock path still runs with no key and makes no wire call", async () => {
    config.mock.shadowfaxDispatch = true;

    const quote = await shadowfaxAdapter.quote(ctx());

    expect(quote.source).toBe("shadowfax_mock_rate_card");
    expect(fetchCalls).toHaveLength(0);
  });
});

describe("shadowfax base-url guard (pre-wire)", () => {
  /**
   * SHADOWFAX_BASE_URL got no pre-wire guard: a truthy-but-garbage env value
   * (paste whitespace, a scheme-less host, an http:// base) reached `fetch`
   * verbatim and `new URL` threw `TypeError: Failed to parse URL` INSIDE
   * fetchProviderJson — where classifyThrown() relabels EVERY throw as a
   * provider `transient`. That is the same defect class the empty-token guard
   * closed in 4be553b (local config fault -> opaque provider failure -> silent
   * walk to another courier), plus a cleartext bearer token on http. The guard
   * under test refuses BEFORE the wire as a plain local-config Error the router
   * never walks on.
   */

  it("a whitespace-only SHADOWFAX_BASE_URL refuses pre-wire as a LOCAL config fault", async () => {
    config.shadowfax.apiKey = "test_sfx_token";
    config.shadowfax.baseUrl = "   ";

    const err = await capture(shadowfaxAdapter.quote(ctx()));

    expect(err.code).toBe("DISPATCH_PROVIDER_MISCONFIGURED");
    expect(err.statusCode).toBe(503);
    expect(err.message).toMatch(/SHADOWFAX_BASE_URL/);
    expect(err).not.toBeInstanceOf(ProviderDispatchError);
    expect(err.kind).toBeUndefined();
    expect(fetchCalls).toHaveLength(0);
  });

  it("a scheme-less host refuses pre-wire at book instead of crashing inside fetch as transient", async () => {
    config.shadowfax.apiKey = "test_sfx_token";
    config.shadowfax.baseUrl = "hlbackend.staging.shadowfax.in";

    const err = await capture(
      shadowfaxAdapter.book({ ...ctx(), orderId: "ord_sfx_baseurl_book", quote: undefined as any })
    );

    expect(err.code).toBe("DISPATCH_PROVIDER_MISCONFIGURED");
    expect(err.message).toMatch(/SHADOWFAX_BASE_URL/);
    expect(err).not.toBeInstanceOf(ProviderDispatchError);
    expect(fetchCalls).toHaveLength(0);
  });

  it("an http:// base refuses — the auth token must never leave over cleartext", async () => {
    config.shadowfax.apiKey = "test_sfx_token";
    config.shadowfax.baseUrl = "http://api.shadowfax.in";

    const err = await capture(shadowfaxAdapter.quote(ctx()));

    expect(err.code).toBe("DISPATCH_PROVIDER_MISCONFIGURED");
    // The echoed config value proves the refusal came from the SCHEME check,
    // not from some later hostname/parse rule (DS review finding 5).
    expect(err.message).toMatch(/http:\/\/api\.shadowfax\.in/);
    expect(err.message).not.toMatch(/parse URL/);
    expect(err).not.toBeInstanceOf(ProviderDispatchError);
    expect(fetchCalls).toHaveLength(0);
  });

  it("a credential-bearing base refuses and the failure echo never leaks the userinfo", async () => {
    // DS review finding 1/2: `fetch` rejects credential-bearing URLs INSIDE
    // fetchProviderJson (walkable transient) and the thrown message embeds the
    // credential — the guard must refuse pre-wire AND redact the echo.
    config.shadowfax.apiKey = "test_sfx_token";
    config.shadowfax.baseUrl = "https://key:secret@api.shadowfax.in";

    const err = await capture(shadowfaxAdapter.quote(ctx()));

    expect(err.code).toBe("DISPATCH_PROVIDER_MISCONFIGURED");
    expect(err.message).toMatch(/\[redacted\]@api\.shadowfax\.in/);
    expect(err.message).not.toMatch(/key:secret/);
    expect(err.message).not.toMatch(/secret@/);
    expect(fetchCalls).toHaveLength(0);
  });

  it("a base with query or fragment refuses — it silently rewrites every endpoint into a guaranteed 4xx walk", async () => {
    config.shadowfax.apiKey = "test_sfx_token";
    config.shadowfax.baseUrl = "https://api.shadowfax.in?token=s3cret";

    const queryErr = await capture(shadowfaxAdapter.quote(ctx()));

    expect(queryErr.code).toBe("DISPATCH_PROVIDER_MISCONFIGURED");
    expect(queryErr.message).toMatch(/api\.shadowfax\.in/);
    expect(queryErr.message).not.toMatch(/s3cret/);
    expect(queryErr.message).not.toMatch(/serviceability|parse URL/);
    expect(fetchCalls).toHaveLength(0);

    config.shadowfax.baseUrl = "https://api.shadowfax.in/#frag";
    const hashErr = await capture(shadowfaxAdapter.quote(ctx()));

    expect(hashErr.code).toBe("DISPATCH_PROVIDER_MISCONFIGURED");
    expect(hashErr.message).toMatch(/SHADOWFAX_BASE_URL/);
    expect(fetchCalls).toHaveLength(0);
  });

  it("bare query/fragment markers ('https://host?') refuse — an empty parsed search would swallow the endpoint path", async () => {
    // DS r2 finding 1: `https://host?` parses with search === "" so parsed
    // truthiness misses it; base()+path would yield
    // "https://api.shadowfax.in?/api/v1/…" whose search swallows the path —
    // a guaranteed 4xx mislabelled not_serviced.
    config.shadowfax.apiKey = "test_sfx_token";
    config.shadowfax.baseUrl = "https://api.shadowfax.in?";

    const qErr = await capture(shadowfaxAdapter.quote(ctx()));

    expect(qErr.code).toBe("DISPATCH_PROVIDER_MISCONFIGURED");
    expect(qErr.message).toMatch(/SHADOWFAX_BASE_URL/);
    expect(qErr.message).not.toMatch(/serviceability/);
    expect(fetchCalls).toHaveLength(0);

    config.shadowfax.baseUrl = "https://api.shadowfax.in#";
    const hErr = await capture(shadowfaxAdapter.book({
      ...ctx(),
      orderId: "ord_sfx_barehash",
      quote: undefined as any,
    }));

    expect(hErr.code).toBe("DISPATCH_PROVIDER_MISCONFIGURED");
    expect(fetchCalls).toHaveLength(0);
  });

  it("a non-root base path ('https://host/v1') refuses — the reply endpoints are appended, never joined", async () => {
    // DS r2 finding 2: /v1 + /api/v1/order-serviceability/ joins into
    // "/v1/api/v1/…" — a guaranteed 404 mislabelled not_serviced.
    config.shadowfax.apiKey = "test_sfx_token";
    config.shadowfax.baseUrl = "https://api.shadowfax.in/v1";

    const err = await capture(shadowfaxAdapter.quote(ctx()));

    expect(err.code).toBe("DISPATCH_PROVIDER_MISCONFIGURED");
    expect(fetchCalls).toHaveLength(0);
  });

  it("scheme-less credential pastes never echo verbatim", async () => {
    // DS r2 finding 3: no :// anchor means the scheme-anchored redaction
    // skipped these; the message lands in the /dispatch/book 503 body,
    // order.dispatchError and Slack/Discord snapshots.
    config.shadowfax.apiKey = "test_sfx_token";
    config.shadowfax.baseUrl = "key:secret@api.shadowfax.in";

    const atHost = await capture(shadowfaxAdapter.quote(ctx()));

    expect(atHost.code).toBe("DISPATCH_PROVIDER_MISCONFIGURED");
    expect(atHost.message).toMatch(/\[redacted\]@api\.shadowfax\.in/);
    expect(atHost.message).not.toMatch(/key:secret/);
    expect(fetchCalls).toHaveLength(0);

    config.shadowfax.baseUrl = "mailto:key:secret";
    const mailto = await capture(shadowfaxAdapter.quote(ctx()));

    expect(mailto.message).toMatch(/\[value elided\]/);
    expect(mailto.message).not.toMatch(/key:secret/);
    expect(fetchCalls).toHaveLength(0);

    config.shadowfax.baseUrl = "//key:secret@host";
    const protoRel = await capture(shadowfaxAdapter.quote(ctx()));

    expect(protoRel.message).toMatch(/\[redacted\]@host/);
    expect(protoRel.message).not.toMatch(/key:secret/);
    expect(fetchCalls).toHaveLength(0);
  });

  it("a host:port authority stays visible in the echo (only credential-shaped colons elide)", async () => {
    // GLM r2 finding 2: "https://host:8443/v1" used to echo as
    // "https://[authority elided]", hiding the host/port the operator needs.
    config.shadowfax.apiKey = "test_sfx_token";
    config.shadowfax.baseUrl = "https://api.shadowfax.in:8443?q";

    const err = await capture(shadowfaxAdapter.quote(ctx()));

    expect(err.code).toBe("DISPATCH_PROVIDER_MISCONFIGURED");
    expect(err.message).toMatch(/api\.shadowfax\.in:8443/);
    expect(err.message).not.toMatch(/authority elided/);
    expect(fetchCalls).toHaveLength(0);
  });

  it("a whitespace-only SHADOWFAX_CLIENT_CODE refuses pre-wire instead of reaching the wire verbatim", async () => {
    // GLM r2 finding 3: same paste-damage class as the token; the client_code
    // transient (walkable by design for a less-than-kinded provider) fires
    // BEFORE any wire call so the garbage never gets sent.
    config.shadowfax.apiKey = "test_sfx_token";
    config.shadowfax.clientCode = "   ";

    const err = await capture(
      shadowfaxAdapter.book({ ...ctx(), orderId: "ord_sfx_ws_clientcode", quote: undefined as any })
    );

    expect(err).toBeInstanceOf(ProviderDispatchError);
    expect(err.message).toMatch(/SHADOWFAX_CLIENT_CODE/);
    expect(fetchCalls).toHaveLength(0);
  });

  it("a padded SHADOWFAX_CLIENT_CODE is sent TRIMMED — validate what you send", async () => {
    config.shadowfax.apiKey = "test_sfx_token";
    config.shadowfax.clientCode = "  test_sfx_client  ";
    fetchHandler = () =>
      okJson({ sfx_order_id: "SFX-GATE-CC", track_url: "https://sfx/track/cc" });

    const booked = await shadowfaxAdapter.book({
      ...ctx(),
      orderId: "ord_sfx_cc_trim",
      quote: undefined as any,
    });

    expect(booked.providerOrderId).toBe("SFX-GATE-CC");
    expect(fetchCalls).toHaveLength(1);
    expect(JSON.parse(String(fetchCalls[0].init.body)).client_code).toBe("test_sfx_client");
  });

  it("a credential-shaped base WITHOUT @ (https://key:secret) refuses and the echo elides the authority", async () => {
    // GLM verify finding 1: the @-redaction cannot match a userinfo-shaped
    // authority with no @, and the value used to echo verbatim into
    // staff-visible dispatchError; elide the authority, keep the scheme.
    config.shadowfax.apiKey = "test_sfx_token";
    config.shadowfax.baseUrl = "https://key:secret";

    const err = await capture(shadowfaxAdapter.quote(ctx()));

    expect(err.code).toBe("DISPATCH_PROVIDER_MISCONFIGURED");
    expect(err.message).toMatch(/https:\/\/\[authority elided\]/);
    expect(err.message).not.toMatch(/key:secret/);
    expect(fetchCalls).toHaveLength(0);
  });

  it("book(): a misconfigured base url refuses BEFORE the walkable missing-clientCode transient", async () => {
    // Ordering pin: a local config fault must surface as the local-config
    // Error, not be outrun by the walkable ProviderDispatchError so the
    // operator chases a provider outage that never existed.
    config.shadowfax.apiKey = "test_sfx_token";
    config.shadowfax.clientCode = "";
    config.shadowfax.baseUrl = "   ";

    const err = await capture(
      shadowfaxAdapter.book({ ...ctx(), orderId: "ord_sfx_baseurl_order", quote: undefined as any })
    );

    expect(err.code).toBe("DISPATCH_PROVIDER_MISCONFIGURED");
    expect(err).not.toBeInstanceOf(ProviderDispatchError);
    expect(fetchCalls).toHaveLength(0);
  });

  it("book(): the 4be553b ordering holds — a missing TOKEN still outranks a bad BASE URL", async () => {
    // DS review finding 6: only base-before-clientCode was pinned; this pins
    // credentials-before-base so a reshuffle cannot silently change which local
    // config fault the staff-facing error names.
    config.shadowfax.apiKey = "   ";
    config.shadowfax.clientCode = "";
    config.shadowfax.baseUrl = "   ";

    const err = await capture(
      shadowfaxAdapter.book({ ...ctx(), orderId: "ord_sfx_token_first", quote: undefined as any })
    );

    expect(err.code).toBe("DISPATCH_PROVIDER_UNCONFIGURED");
    expect(err.message).toMatch(/SHADOWFAX_API_KEY/);
    expect(err).not.toBeInstanceOf(ProviderDispatchError);
    expect(fetchCalls).toHaveLength(0);
  });

  it("intent pins: a garbage base keeps a fully-keyed provider ELIGIBLE (loud refusal, not silent exclusion)", () => {
    // DS review finding 7: the deliberate non-change in isEligible() must be
    // indistinguishable from an oversight. Exclusion would hide the operator
    // typo behind a clean fan-out miss; the loud pre-wire MISCONFIGURED plain
    // Error is embargoed as the operator-visible surfacing.
    config.shadowfax.enabled = true;
    config.shadowfax.apiKey = "test_sfx_token";
    config.shadowfax.clientCode = "test_sfx_client";
    config.shadowfax.contractVerified = true;
    config.shadowfax.baseUrl = "not a url";

    expect(shadowfaxAdapter.isEligible()).toBe(true);
  });

  it("intent pins: the mock path is indifferent to the base and makes zero wire calls", async () => {
    config.mock.shadowfaxDispatch = true;
    config.shadowfax.baseUrl = "garbage";

    const quote = await shadowfaxAdapter.quote(ctx());

    expect(quote.source).toBe("shadowfax_mock_rate_card");
    expect(fetchCalls).toHaveLength(0);
  });

  it("paste damage is repaired: surrounding whitespace and trailing slash are trimmed off the wire url", async () => {
    config.shadowfax.apiKey = "test_sfx_token";
    config.shadowfax.baseUrl = "  https://hlbackend.staging.shadowfax.in/  ";
    fetchHandler = () => okJson({ serviceable: true, delivery_cost: 40 });

    const quote = await shadowfaxAdapter.quote(ctx());

    expect(quote.fare).toBe(40);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe(
      "https://hlbackend.staging.shadowfax.in/api/v1/order-serviceability/"
    );
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
