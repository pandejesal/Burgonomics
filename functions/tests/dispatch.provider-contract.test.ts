import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";

/**
 * Provider-level dispatch contract tests (audit findings 4, 5, 6, 9, 13, 14 and
 * D1/D2/D3). Harness (firebase-admin double, `global.fetch` stub, `okJson`)
 * mirrors `dispatch.router.test.ts` — only the fixtures differ.
 *
 * The subject is the Borzo Business API 1.8 failure contract: EVERY documented
 * Borzo error is an HTTP 400 with `is_successful:false` + `errors:[code,…]`, so
 * the HTTP status alone cannot choose the failure class.
 */

const { mockDb, savedDocs, defaultOrder } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  const defaultOrder = () => ({
    branchId: "branch_ahmedabad_1",
    branchName: "Burgonomics CG Road",
    branchCoordinates: { lat: 23.0131, lng: 72.5085 },
    deliveryAddress: {
      full: "102, Shivalik Highstreet, Vastrapur",
      lat: 23.0338,
      lng: 72.5262,
    },
    customerPhone: "+91 99999 88888",
    customerName: "Aarav Shah",
    status: "ready",
  });
  const mergeSet = (colName: string, docId: string, data: any) => {
    savedDocs[`${colName}/${docId}`] = {
      ...(savedDocs[`${colName}/${docId}`] || {}),
      ...data,
    };
  };
  // Refreshable snapshot: ref.get() re-reads savedDocs so transaction
  // re-reads (claim-then-work) observe writes, exactly like Firestore.
  const readDoc: any = (colName: string, docId: string) => {
    const snap: any = {
      exists: true,
      data: () => savedDocs[`${colName}/${docId}`] || defaultOrder(),
      ref: {
        get: vi.fn(async () => readDoc(colName, docId)),
        set: vi.fn(async (data: any) => mergeSet(colName, docId, data)),
      },
    };
    return snap;
  };
  const mockDb: any = {
    collection: (colName: string) => ({
      doc: (docId: string) => ({
        id: docId,
        set: vi.fn(async (data: any) => mergeSet(colName, docId, data)),
        get: vi.fn(async () => readDoc(colName, docId)),
      }),
      where: (_field: string, _op: string, _val: any) => ({
        limit: (_n: number) => ({
          get: async () => ({ empty: true, docs: [] }),
        }),
      }),
    }),
    runTransaction: vi.fn(async (fn: any) =>
      fn({
        get: (ref: any) => ref.get(),
        set: (ref: any, data: any, opts?: any) => ref.set(data, opts),
      })
    ),
  };
  return { mockDb, savedDocs, defaultOrder };
});

vi.mock("firebase-admin", () => {
  const FieldValue = {
    serverTimestamp: () => "MOCK_TIMESTAMP",
    increment: (n: number) => n,
    arrayUnion: (item: any) => [item],
  };

  const firestoreFn: any = vi.fn(() => mockDb);
  firestoreFn.FieldValue = FieldValue;

  return {
    default: {
      firestore: firestoreFn,
      auth: vi.fn(() => ({})),
      messaging: vi.fn(() => ({})),
      initializeApp: vi.fn(),
      apps: [{ name: "mock" }],
    },
    firestore: firestoreFn,
    auth: vi.fn(() => ({})),
    messaging: vi.fn(() => ({})),
    initializeApp: vi.fn(),
    apps: [{ name: "mock" }],
  };
});

import { borzoAdapter, classifyBorzoError } from "../src/modules/dispatch/providers/borzo.adapter";
import { shadowfaxAdapter } from "../src/modules/dispatch/providers/shadowfax.adapter";
import { dropAddressBlock } from "../src/modules/dispatch/providers/shared";
import { dispatchBook } from "../src/modules/dispatch/dispatch.router";
import { ProviderDispatchError, type DispatchQuoteContext } from "../src/modules/dispatch/types";
import { assertLiveDispatchContext, config } from "../src/config/env";

const PICKUP = { lat: 23.0131, lng: 72.5085 };
const DROP = { lat: 23.0338, lng: 72.5262 };

const okJson = (data: any, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/** Documented Borzo failure body: 400 + `is_successful:false` + `errors[]`. */
const borzoBody = (errors: string[], extra: Record<string, any> = {}) => ({
  is_successful: false,
  errors,
  parameter_errors: {},
  ...extra,
});

const MOCK_QUOTE = {
  provider: "borzo" as const,
  outcome: "ok" as const,
  fare: 60,
  distanceKm: 5,
  pickupEtaMinutes: 8,
  quoteId: "QTE-BORZO-test",
  expiresAt: Date.now() + 60_000,
  source: "borzo_mock_rate_card",
};

/** Fully-formed live quote context: real branch phone + real customer phone. */
function borzoContext(overrides: Partial<DispatchQuoteContext> = {}): DispatchQuoteContext {
  return {
    pickup: PICKUP,
    drop: DROP,
    customerName: "Aarav Shah",
    customerPhone: "+91 99999 88888",
    orderId: "ord_provider_contract",
    order: {
      branchName: "Burgonomics CG Road",
      // The real field: OrderStoreSnapshot.phone, required and written at order
      // creation by the client.
      store: { name: "Burgonomics CG Road", phone: "+91 98250 12345" },
      deliveryAddress: {
        full: "102, Shivalik Highstreet, Vastrapur",
        city: "Ahmedabad",
        lat: DROP.lat,
        lng: DROP.lng,
      },
    },
    ...overrides,
  };
}

/** Resolves with the rejection reason — asserts the call actually failed. */
async function capture(promise: Promise<unknown>): Promise<any> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected the provider call to reject, but it resolved");
}

const originalFetch = globalThis.fetch;
let fetchCalls: Array<{ url: string; init: any }> = [];
let fetchHandler: ((url: string, init: any) => Response) | null = null;

let saved: any = {};
let savedBurgonomicsEnv: string | undefined;

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
  saved = {
    borzo: { ...config.borzo },
    shadowfax: { ...config.shadowfax },
    porter: { ...config.porter },
    mock: { ...config.mock },
  };
  // Baseline: Borzo LIVE (keyed, unmocked) is the subject; shadowfax mocked so
  // a Borzo-only failure is still observable; Porter out of the field.
  config.borzo.enabled = true;
  config.borzo.apiKey = "test_borzo_key";
  config.borzo.webhookSecret = "";
  config.shadowfax.enabled = true;
  config.shadowfax.apiKey = "";
  config.shadowfax.clientCode = "";
  config.shadowfax.webhookSecret = "";
  config.porter.enabled = false;
  config.porter.apiKey = "";
  config.porter.customerId = "";
  config.porter.webhookSecret = "";
  config.mock.borzoDispatch = false;
  config.mock.shadowfaxDispatch = true;
  config.mock.porterDispatch = false;
  config.dispatch.quoteTimeoutMs = 6000;
  config.dispatch.fareConfirmDeltaInr = 20;

  savedBurgonomicsEnv = process.env.BURGONOMICS_ENV;
  for (const k of Object.keys(savedDocs)) delete savedDocs[k];
  fetchCalls = [];
  fetchHandler = null;
});

afterEach(() => {
  config.borzo = { ...saved.borzo };
  config.shadowfax = { ...saved.shadowfax };
  config.porter = { ...saved.porter };
  config.mock = { ...saved.mock };
  // Never leave a stray `BURGONOMICS_ENV=undefined` string behind for the
  // production-predicate tests.
  if (savedBurgonomicsEnv === undefined) delete process.env.BURGONOMICS_ENV;
  else process.env.BURGONOMICS_ENV = savedBurgonomicsEnv;
});

describe("borzo failure classification (D1/D2/D3, findings 13/14)", () => {
  it("400 insufficient_balance is transient and the code is in the message", async () => {
    fetchHandler = () => okJson(borzoBody(["insufficient_balance"]), 400);

    const err = await capture(borzoAdapter.quote(borzoContext()));

    expect(err).toBeInstanceOf(ProviderDispatchError);
    expect(err.provider).toBe("borzo");
    // Pins the old behaviour: shared.ts classified HTTP 400 as not_serviced, so
    // an empty prepaid balance read to staff as "address not covered".
    expect(err.kind).toBe("transient");
    expect(err.message).toBe("borzo HTTP 400 insufficient_balance (transient)");
  });

  it("400 invalid_region is not_serviced (the coverage allow-list still works)", async () => {
    fetchHandler = () => okJson(borzoBody(["invalid_region"]), 400);

    const err = await capture(borzoAdapter.quote(borzoContext()));

    expect(err.kind).toBe("not_serviced");
    expect(err.message).toContain("invalid_region");
  });

  it("400 invalid_parameters is transient, names the code, and never blames the address", async () => {
    fetchHandler = () => okJson(borzoBody(["invalid_parameters"]), 400);

    const err = await capture(borzoAdapter.quote(borzoContext()));

    // Pins the old behaviour: every documented Borzo 400 (this one included)
    // was classified not_serviced with the code discarded.
    expect(err.kind).toBe("transient");
    expect(err.message).toContain("invalid_parameters");
    expect(err.message).not.toContain("not_serviced");
  });

  it("200 + is_successful:false + route_not_found is not_serviced", async () => {
    fetchHandler = () => okJson(borzoBody(["route_not_found"]));

    const err = await capture(borzoAdapter.quote(borzoContext()));

    // Pins the inverse misclassification: the old 200-body path was hardcoded
    // transient, so a genuine coverage failure stayed permanently eligible.
    expect(err.kind).toBe("not_serviced");
    expect(err.message).toContain("route_not_found");
  });

  it("reads parameter_errors whether the value is an array or a bare string", async () => {
    fetchHandler = () =>
      okJson(
        {
          is_successful: false,
          errors: [],
          parameter_errors: {
            address: ["total_payment_amount_limit_exceeded"],
            phone: "invalid_parameters",
          },
        },
        400
      );

    const err = await capture(borzoAdapter.quote(borzoContext()));

    // Pins the old behaviour: neither code was read, and 400 meant not_serviced.
    expect(err.kind).toBe("transient");
    expect(err.message).toContain("total_payment_amount_limit_exceeded");
    expect(err.message).toContain("invalid_parameters");
  });

  it("a 400 with no usable code is transient and keeps the raw message", async () => {
    fetchHandler = () =>
      okJson({ is_successful: false, message: "Something exploded upstream" }, 400);
    const parsed = await capture(borzoAdapter.quote(borzoContext()));
    expect(parsed.kind).toBe("transient"); // pins: pre-fix not_serviced
    expect(parsed.message).toContain("Something exploded upstream");

    // Non-JSON body: the raw text is never discarded.
    fetchHandler = () => new Response("gateway blew up", { status: 400 });
    const raw = await capture(borzoAdapter.quote(borzoContext()));
    expect(raw.kind).toBe("transient");
    expect(raw.message).toContain("gateway blew up");
  });

  it("keeps 401 / 429 / 5xx transient (unchanged)", async () => {
    for (const status of [401, 429, 503]) {
      fetchHandler = () => okJson({ message: "provider having a bad day" }, status);
      const err = await capture(borzoAdapter.quote(borzoContext()));
      expect(err.kind).toBe("transient");
      expect(err.message).toContain(`HTTP ${status}`);
    }
  });

  // The full documented code matrix, exercised through the single decision point.
  const TRANSIENT_BORZO_CODES = [
    "unexpected_error",
    "service_unavailable",
    "requests_limit_exceeded",
    "insufficient_balance",
    "insufficient_balance_for_buyout",
    "buyout_amount_limit_exceeded",
    "insufficient_funds",
    "card_payment_failed",
    "unapproved_contract",
    "invalid_auth_token",
    "required_auth_token",
    "invalid_api_version",
    "required_api_upgrade",
    "tax_retension_limit",
    "impossible_delivery_fee_calculation",
    "invalid_parameters",
    "order_is_duplicate",
    "total_payment_amount_limit_exceeded",
  ];

  const NOT_SERVICED_BORZO_CODES = [
    "route_not_found",
    "invalid_region",
    "different_regions",
    "coordinates_out_of_bounds",
    "address_not_found",
  ];

  it.each(TRANSIENT_BORZO_CODES)(
    "no documented non-coverage code ever yields not_serviced: %s",
    (code) => {
      const err = classifyBorzoError("borzo", 400, {
        is_successful: false,
        errors: [code],
        parameter_errors: {},
      });
      expect(err.kind).toBe("transient");
      expect(err.message).toContain(code);
    }
  );

  it.each(NOT_SERVICED_BORZO_CODES)(
    "a genuine coverage code still yields not_serviced: %s",
    (code) => {
      const err = classifyBorzoError("borzo", 400, {
        is_successful: false,
        errors: [code],
        parameter_errors: {},
      });
      expect(err.kind).toBe("not_serviced");
      expect(err.message).toContain(code);
    }
  );
});

describe("borzo quote warnings (D2)", () => {
  it("withholds the fare when calculate-order returns warnings", async () => {
    fetchHandler = () =>
      okJson({
        is_successful: true,
        order: { payment_amount: "60.00" },
        warnings: ["invalid_parameters"],
        parameter_warnings: {},
      });

    const err = await capture(borzoAdapter.quote(borzoContext()));

    // Pins the old behaviour: the same payload that books to a 400 was quoted
    // at ₹60 with the warnings never read.
    expect(err).toBeInstanceOf(ProviderDispatchError);
    expect(err.message).toContain("invalid_parameters");
  });

  it("withholds the fare when parameter_warnings are set", async () => {
    fetchHandler = () =>
      okJson({
        is_successful: true,
        order: { payment_amount: "60.00" },
        warnings: [],
        parameter_warnings: { address: ["address_not_found"] },
      });

    const err = await capture(borzoAdapter.quote(borzoContext()));

    expect(err.kind).toBe("not_serviced");
    expect(err.message).toContain("address_not_found");
  });

  it("still quotes a fare when there are no warnings", async () => {
    fetchHandler = () =>
      okJson({
        is_successful: true,
        order: { payment_amount: "60.00" },
        warnings: [],
        parameter_warnings: {},
      });

    const quote = await borzoAdapter.quote(borzoContext());

    expect(quote.outcome).toBe("ok");
    expect(quote.fare).toBe(60);
    expect(quote.source).toBe("borzo_api_live");
  });
});

describe("borzo contact phones (findings 4, 5)", () => {
  it("never substitutes the customer's phone for the pickup contact", async () => {
    let sent: any = null;
    fetchHandler = (_url, init) => {
      sent = JSON.parse(init.body);
      return okJson({ is_successful: true, order: { payment_amount: "60.00" } });
    };
    // No branchPhone — the old code sent ctx.customerPhone as the pickup contact.
    const ctx = borzoContext({ order: { branchName: "Burgonomics CG Road" } });

    const quote = await borzoAdapter.quote(ctx);

    // A quote must not be blocked by a missing branch phone (the /dispatch/quote
    // context carries no order), but the pickup contact must never become the
    // customer's number: the key is OMITTED, not substituted (finding 4). The
    // book path's fail-closed throw is pinned by the next test.
    expect(quote.outcome).toBe("ok");
    expect(sent.points[0].contact_person.phone).toBeUndefined();
    // The drop point legitimately falls back to the customer — they are the
    // person at the door.
    expect(sent.points[1].contact_person.phone).toBe("919999988888");
  });

  it("fails closed rather than inventing a courier phone number", async () => {
    fetchHandler = () => okJson({ is_successful: true, order: { payment_amount: "60.00" } });
    // NOTE: the customer's phone IS available here — a pickup contact must still
    // not fall back to it (the bridge was removed on review). Only a real branch
    // number will do.
    const ctx = borzoContext({
      order: { branchName: "Burgonomics CG Road" },
    });

    // Book path too: the old last-resort literal (919876543210) was invented and
    // sent to the provider.
    const err = await capture(borzoAdapter.book({ ...ctx, orderId: ctx.orderId!, quote: MOCK_QUOTE }));

    expect(err).toBeInstanceOf(ProviderDispatchError);
    expect(err.message).toContain("branch phone");
    expect(fetchCalls).toHaveLength(0); // the fabricated number never left the process
  });

  it("sends the real branch phone and the real customer phone on a live quote", async () => {
    let sent: any = null;
    fetchHandler = (_url, init) => {
      sent = JSON.parse(init.body);
      return okJson({ is_successful: true, order: { payment_amount: "60.00" } });
    };

    const quote = await borzoAdapter.quote(borzoContext());

    expect(quote.outcome).toBe("ok");
    expect(sent.points[0].contact_person.phone).toBe("919825012345"); // branch
    expect(sent.points[1].contact_person.phone).toBe("919999988888"); // customer
    expect(JSON.stringify(sent)).not.toContain("919876543210");
  });

  it("prefers the order's store snapshot phone over the legacy branchPhone alias", async () => {
    let sent: any = null;
    fetchHandler = (_url, init) => {
      sent = JSON.parse(init.body);
      return okJson({ is_successful: true, order: { payment_amount: "60.00" } });
    };
    // `store.phone` is the field real orders carry; `branchPhone` never existed
    // in the data model. The store snapshot must win.
    const ctx = borzoContext({
      order: {
        branchName: "Burgonomics CG Road",
        store: { phone: "+91 90000 11111" },
        branchPhone: "+91 90000 22222",
        customerPhone: "+91 90000 33333",
      },
    });

    await borzoAdapter.quote(ctx);

    expect(sent.points[0].contact_person.phone).toBe("919000011111");
  });
});

describe("booked rider identity (finding D4)", () => {
  it("never fabricates a rider name when the response carries no courier", async () => {
    fetchHandler = () =>
      okJson({ is_successful: true, order: { order_id: "BZ-ORD-1", status: "new" } });

    const booked = await borzoAdapter.book({
      ...borzoContext(),
      orderId: "ord_provider_contract",
      quote: MOCK_QUOTE,
    });

    expect(booked.kind).toBe("booked");
    // An empty name keeps the router at `status: "pending"`; the old literal
    // ("Borzo Courier") was promoted to a customer-visible "rider_assigned".
    expect(booked.riderName).toBe("");
  });

  it("rejects an accepted create-order with no usable id WITHOUT failing over (no second real rider)", async () => {
    fetchHandler = () => okJson({ is_successful: true, order: { status: "new" } });

    const err: any = await borzoAdapter
      .book({ ...borzoContext(), orderId: "ord_ambiguous_book", quote: MOCK_QUOTE })
      .catch((e: any) => e);

    expect(err.code).toBe("PROVIDER_BOOK_AMBIGUOUS");
    expect(err.statusCode).toBe(502);
    // Not a ProviderDispatchError => the router will NOT walk to the next provider.
    expect(err.kind).toBeUndefined();
  });
});

describe("shadowfax ambiguous booking (Borzo parity, dbd1626)", () => {
  // Live book path: unmocked, both creds present, so the response shape is the
  // only thing under test.
  const liveCtx = (order: Record<string, any>) =>
    borzoContext({
      order: {
        branchName: "Burgonomics CG Road",
        store: { phone: "+91 98250 12345" },
        deliveryAddress: { full: "Some street", lat: DROP.lat, lng: DROP.lng },
        customerPhone: "+91 90000 33333",
        ...order,
      },
    });

  beforeEach(() => {
    config.mock.shadowfaxDispatch = false;
    config.shadowfax.enabled = true;
    config.shadowfax.apiKey = "test_sfx_token";
    config.shadowfax.clientCode = "test_sfx_client";
    // GAP 2: the live path requires the explicit contract-verified flag.
    config.shadowfax.contractVerified = true;
  });

  it("a 2xx with NO order id is an AMBIGUOUS 502 that cannot fail over (no second rider)", async () => {
    // Accepted by the provider, but no id we can bind: the delivery may exist.
    fetchHandler = () => okJson({ track_url: "https://sfx/track/1" });

    const err: any = await shadowfaxAdapter
      .book({ ...liveCtx({}), orderId: "ord_sfx_ambig", quote: MOCK_QUOTE as any })
      .catch((e: any) => e);

    expect(err.code).toBe("PROVIDER_BOOK_AMBIGUOUS");
    expect(err.statusCode).toBe(502);
    // Not a ProviderDispatchError => dispatch.router.ts releases the claim and
    // throws instead of walking to the next provider, so no SECOND real rider.
    expect(err.kind).toBeUndefined();
    expect(err.name).not.toBe("ProviderDispatchError");
    expect(err.message).toMatch(/no order id/i);
  });

  it("a 2xx WITH an order id still books (positive control)", async () => {
    fetchHandler = () => okJson({ sfx_order_id: "SFX-AMBIG-POS-1" });

    const booked = await shadowfaxAdapter.book({
      ...liveCtx({}),
      orderId: "ord_sfx_pos",
      quote: MOCK_QUOTE as any,
    });

    expect(booked.kind).toBe("booked");
    expect(booked.providerOrderId).toBe("SFX-AMBIG-POS-1");
    // Identity arrives with the ALLOTTED callback — never fabricated here.
    expect(booked.riderName).toBe("");
  });

  it("a missing contact phone is a LOCAL input error, not a transient provider fault", async () => {
    // No store phone (pickup contact) and no customer phone (drop contact).
    const ctx = borzoContext({
      order: { deliveryAddress: { full: "Some street", lat: DROP.lat, lng: DROP.lng } },
    });

    const err: any = await shadowfaxAdapter
      .book({ ...ctx, orderId: "ord_sfx_nophone", quote: MOCK_QUOTE as any })
      .catch((e: any) => e);

    expect(err.code).toBe("DISPATCH_CONTACT_MISSING");
    expect(err.statusCode).toBe(422);
    // Non-transient: a phone cannot be fixed by trying another provider.
    expect(err.kind).toBeUndefined();
    // And the message no longer blames Shadowfax for our own missing field.
    expect(err.message).not.toMatch(/shadowfax returned/i);
    expect(err.message).not.toMatch(/unparseable/i);
    expect(err.message).toMatch(/add the .* phone/i);
  });

  it("flags a LOCAL ETA when the provider omits pickup_eta, passes a real one through", async () => {
    fetchHandler = () => okJson({ serviceable: true, delivery_cost: 42 });
    const estimated = await shadowfaxAdapter.quote(borzoContext());
    expect(estimated.etaEstimated).toBe(true);
    // Pre-fix this was the fabricated constant 9 with no flag.
    expect(Number.isFinite(estimated.pickupEtaMinutes)).toBe(true);

    fetchHandler = () => okJson({ serviceable: true, delivery_cost: 42, pickup_eta: 6 });
    const provider = await shadowfaxAdapter.quote(borzoContext());
    expect(provider.etaEstimated).toBe(false);
    expect(provider.pickupEtaMinutes).toBe(6);
  });
});

describe("runtime zero-mock guard (finding 9 / DR11)", () => {
  it("refuses a mock borzo quote and book in a declared production process", async () => {
    process.env.BURGONOMICS_ENV = "production";
    config.mock.borzoDispatch = true;

    // Pins the old behaviour: the mock branch returned a [TEST] rider / mock
    // fare on a live order with no runtime refusal.
    await expect(borzoAdapter.quote(borzoContext())).rejects.toThrow(/MOCK_BORZO_DISPATCH/);
    await expect(
      borzoAdapter.book({ ...borzoContext(), orderId: "ord_x", quote: MOCK_QUOTE })
    ).rejects.toThrow(/MOCK_BORZO_DISPATCH/);
  });

  it("guards every MOCK_*_DISPATCH flag and stays silent outside production", () => {
    config.mock.shadowfaxDispatch = false; // isolate each flag
    config.mock.porterDispatch = true;
    expect(() => assertLiveDispatchContext("test")).not.toThrow(); // dev/staging

    process.env.BURGONOMICS_ENV = "production";
    expect(() => assertLiveDispatchContext("test")).toThrow(/MOCK_PORTER_DISPATCH/);

    config.mock.porterDispatch = false;
    config.mock.borzoDispatch = true;
    expect(() => assertLiveDispatchContext("test")).toThrow(/MOCK_BORZO_DISPATCH/);

    config.mock.borzoDispatch = false;
    config.mock.shadowfaxDispatch = true;
    expect(() => assertLiveDispatchContext("test")).toThrow(/MOCK_SHADOWFAX_DISPATCH/);

    config.mock.shadowfaxDispatch = false;
    expect(() => assertLiveDispatchContext("test")).not.toThrow();
  });
});

describe("dispatchBook end-to-end: an account failure is never an address verdict", () => {
  it("records borzo as transient_failure with the code and fails over", async () => {
    // Both keyed providers live so both quote attempts reach the wire.
    config.mock.shadowfaxDispatch = false;
    config.shadowfax.apiKey = "test_sfx_token";
    config.shadowfax.clientCode = "test_sfx_client";
    config.shadowfax.contractVerified = true;
    savedDocs["orders/ord_cls"] = {
      ...defaultOrder(),
      branchPhone: "+91 98250 12345",
    };
    fetchHandler = (url) => {
      if (url.includes("/calculate-order")) return okJson(borzoBody(["insufficient_balance"]), 400);
      if (url.includes("order-serviceability")) {
        return okJson({ message: "Order in non-serviceable area" }, 400);
      }
      return okJson({ message: "not found" }, 404);
    };

    const err: any = await dispatchBook({ orderId: "ord_cls" }).then(
      () => null,
      (e) => e
    );

    expect(err?.code).toBe("NO_SERVICEABLE_PROVIDER");
    const borzo = (err.providers || []).find((p: any) => p.provider === "borzo");
    // Pins the old behaviour: borzo's 400 was recorded as not_serviced.
    expect(borzo.outcome).toBe("transient_failure");
    expect(borzo.error).toContain("insufficient_balance");
    expect(borzo.error).not.toContain("not_serviced");
  });

  it("does not invent a drop locality when the order has none", () => {
    const block = dropAddressBlock({ deliveryAddress: { full: "Some street in Surat" } });

    // Pins finding 6: pre-fix these read "Ahmedabad" / "Gujarat" / "380015".
    expect(block.city).toBe("");
    expect(block.state).toBe("");
    expect(block.pincode).toBe("");
    expect(block.line).toBe("Some street in Surat");
  });

  it("does not transmit an invented city to Shadowfax for a city-less drop", async () => {
    config.mock.shadowfaxDispatch = false;
    config.shadowfax.apiKey = "test_sfx_token";
    config.shadowfax.clientCode = "test_sfx_client";
    config.shadowfax.contractVerified = true;
    let sent: any = null;
    fetchHandler = (_url, init) => {
      sent = JSON.parse(init.body);
      return okJson({ sfx_order_id: "SFX-CONTRACT-1" });
    };

    const ctx = borzoContext({
      order: {
        branchName: "Burgonomics CG Road",
        branchCity: "Surat",
        // Real orders carry the branch phone as `store.phone`; the pickup contact
        // no longer bridges to the customer's number (review on 39efc40).
        store: { phone: "+91 98250 12345" },
        deliveryAddress: { full: "Some street", lat: DROP.lat, lng: DROP.lng },
      },
    });
    const book = await shadowfaxAdapter.book({
      ...ctx,
      orderId: "ord_sfx",
      quote: MOCK_QUOTE as any,
    });

    expect(book.kind).toBe("booked");
    // Pins finding 6: pre-fix the drop city was the literal "Ahmedabad", i.e. a
    // drop pin in another city was geocoded to the wrong locality.
    expect(sent.drop_details.city).toBe("");
    expect(sent.drop_details.address).toBe("Some street");
    expect(sent.pickup_details.city).toBe("Surat"); // the branch's real city
  });
});
