import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";

/**
 * F08 — an UNCERTAIN create-order must never book a second paid courier.
 *
 * Real `dispatchBook` + real provider adapters + a controlled fake `fetch`:
 * every wire call is a stubbed response, no firebase-admin, no credentials, no
 * live provider. The Firestore double below is the same refreshable/merge
 * harness the existing dispatch router suites use (savedDocs / mergeSet /
 * readDoc / runTransaction).
 *
 * Contract under test (audit F08, High):
 *   A create-order whose outcome cannot be proven was REJECTED (post-send
 *   transport loss, HTTP 5xx, unreadable response body) parks the order on
 *   `needs_reconciliation` with the provider + correlation preserved and
 *   `needsRebook:false` — and makes ZERO further create-order POSTs.
 *   Proven pre-send failures (ENOTFOUND / ECONNREFUSED) may still fail over,
 *   and a definite provider rejection keeps its existing DR3/DR6 behaviour.
 */

const { mockDb, savedDocs, defaultOrder } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  const defaultOrder = () => ({
    branchId: "branch_ahmedabad_1",
    branchName: "Burgonomics CG Road",
    store: { name: "Burgonomics CG Road", phone: "+91 98250 12345", city: "Ahmedabad" },
    branchCoordinates: { lat: 23.0131, lng: 72.5085 },
    deliveryAddress: {
      full: "102, Shivalik Highstreet, Vastrapur",
      city: "Ahmedabad",
      lat: 23.0338,
      lng: 72.5262,
    },
    customerPhone: "+91 99999 88888",
    customerName: "Aarav Shah",
    paymentStatus: "completed",
    status: "ready",
  });
  const mergeSet = (colName: string, docId: string, data: any) => {
    savedDocs[`${colName}/${docId}`] = {
      ...(savedDocs[`${colName}/${docId}`] || {}),
      ...data,
    };
  };
  const readDoc: any = (colName: string, docId: string) => {
    const key = `${colName}/${docId}`;
    const raw = savedDocs[key];
    return {
      exists: raw !== undefined,
      id: docId,
      data: () => raw,
      ref: {
        id: docId,
        get: vi.fn(async () => readDoc(colName, docId)),
        set: vi.fn(async (data: any) => mergeSet(colName, docId, data)),
      },
    } as any;
  };
  const docRef: any = (colName: string, docId: string) => ({
    id: docId,
    get: vi.fn(async () => readDoc(colName, docId)),
    set: vi.fn(async (data: any) => mergeSet(colName, docId, data)),
  });
  const mockDb: any = {
    collection: (colName: string) => ({
      doc: (docId: string) => docRef(colName, docId),
      where: (field: string, op: string, val: any) => ({
        limit: (n: number) => ({
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

vi.mock("../src/core/errors", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/errors")>();
  return { ...actual, captureErrorSnapshot: vi.fn(async () => "err_f08_snapshot") };
});

vi.mock("../src/modules/notifications/fcm.service", () => ({
  dispatchFCM: vi.fn(async () => undefined),
}));

import { dispatchBook, dispatchQuote } from "../src/modules/dispatch/dispatch.router";
import {
  isProviderDispatchError,
  ProviderDispatchError,
} from "../src/modules/dispatch/types";
import { config } from "../src/config/env";

const BORZO_WEBHOOK_SECRET = "test_borzo_whsec_vitest_only";
const SFX_WEBHOOK_SECRET = "test_sfx_shared_secret_vitest_only";

const okJson = (data: any, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const originalFetch = globalThis.fetch;
let fetchCalls: Array<{ url: string; init: any }> = [];
let fetchHandler: ((url: string, init: any) => any) | null = null;
let saved: any = {};

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

function seedOrder(id: string, extra: Record<string, any> = {}) {
  savedDocs[`orders/${id}`] = { ...defaultOrder(), ...extra };
}

function docOf(id: string): any {
  return savedDocs[`orders/${id}`];
}

/** create-order POSTs only: Borzo + Shadowfax create endpoints. */
const createOrderCalls = () =>
  fetchCalls.filter(
    (c) =>
      c.url.includes("/create-order") ||
      (/\/api\/v2\/orders\/?$/.test(c.url) && (c.init?.method || "").toUpperCase() === "POST")
  );

const borzoCreateCalls = () => fetchCalls.filter((c) => c.url.includes("/create-order"));
const shadowfaxCreateCalls = () =>
  fetchCalls.filter(
    (c) =>
      /\/api\/v2\/orders\/?$/.test(c.url) && (c.init?.method || "").toUpperCase() === "POST"
  );

/**
 * Post-send transport loss, shaped the way Node/undici reports it: an outer
 * `TypeError: fetch failed` wrapping an inner socket error. `hops` controls the
 * depth so the cause walk is exercised, not just the top-level message.
 */
function transportLoss(code: string, hops = 1): any {
  let inner: any = Object.assign(new Error(`read ${code}`), { code });
  for (let i = 1; i < hops; i++) inner = Object.assign(new Error("socket wrapper"), { cause: inner });
  return new TypeError("fetch failed", { cause: inner });
}

/** A 5xx whose body cannot be read: the status is known, the receipt is not. */
function unreadableBody(status = 500): any {
  return {
    status,
    ok: false,
    text: async () => {
      throw new Error("body stream aborted");
    },
    json: async () => {
      throw new Error("body stream aborted");
    },
  };
}

/** Cheapest Borzo quote so Borzo leads the walk unless a test overrides it. */
function borzoQuoteWire(fare = "50.00", dropCity = true) {
  return (url: string) => {
    if (url.includes("/calculate-order")) {
      return okJson({ is_successful: true, order: { payment_amount: fare } });
    }
    return okJson({ message: "not found" }, 404);
  };
}

/** Live Shadowfax wire: serviceability + create-order returning a real id. */
function shadowfaxWire(providerOrderId = "SFX-F08-1", deliveryCost = 61) {
  return (url: string) => {
    if (url.includes("/api/v1/order-serviceability/")) {
      return okJson({ serviceable: true, delivery_cost: deliveryCost, pickup_eta: 7 });
    }
    if (/\/api\/v2\/orders\/?$/.test(url)) {
      return okJson({
        message: "order placed",
        data: { sfx_order_id: providerOrderId, track_url: `https://track.shadowfax.in/${providerOrderId}` },
      });
    }
    return okJson({ message: "not found" }, 404);
  };
}

function useLiveBorzo() {
  config.borzo.enabled = true;
  config.borzo.apiKey = "k_borzo_f08";
  config.borzo.customerId = "c_borzo_f08";
  config.borzo.webhookSecret = BORZO_WEBHOOK_SECRET;
  config.mock.borzoDispatch = false;
}

function useLiveShadowfax() {
  config.shadowfax.enabled = true;
  config.shadowfax.apiKey = "t_sfx_f08";
  config.shadowfax.clientCode = "sfx_client_f08";
  config.shadowfax.webhookSecret = SFX_WEBHOOK_SECRET;
  config.shadowfax.contractVerified = true;
  config.shadowfax.baseUrl = "https://api.shadowfax.in";
  config.mock.shadowfaxDispatch = false;
}

beforeEach(() => {
  saved = {
    borzo: { ...config.borzo },
    shadowfax: { ...config.shadowfax },
    porter: { ...config.porter },
    mock: { ...config.mock },
    dispatch: { ...config.dispatch },
  };
  // Deterministic field: Borzo live-keyed, Shadowfax off unless a test needs
  // the second carrier (a failover assertion must be able to SEE a real POST).
  useLiveBorzo();
  config.shadowfax.enabled = false;
  config.shadowfax.apiKey = "";
  config.shadowfax.clientCode = "";
  config.shadowfax.webhookSecret = "";
  config.shadowfax.contractVerified = false;
  config.mock.shadowfaxDispatch = false;
  config.porter.enabled = false;
  config.porter.apiKey = "";
  config.porter.customerId = "";
  config.porter.webhookSecret = "";
  config.mock.porterDispatch = false;
  config.dispatch.fareConfirmDeltaInr = 20;
  config.dispatch.quoteTimeoutMs = 6000;
  config.dispatch.requireLive = false;

  for (const k of Object.keys(savedDocs)) delete savedDocs[k];
  savedDocs["branches/branch_ahmedabad_1"] = {
    name: "Burgonomics CG Road",
    phone: "+91 98250 12345",
    coordinates: { lat: 23.0131, lng: 72.5085 },
  };
  fetchCalls = [];
  fetchHandler = null;
});

afterEach(() => {
  config.borzo = { ...saved.borzo };
  config.shadowfax = { ...saved.shadowfax };
  config.porter = { ...saved.porter };
  config.mock = { ...saved.mock };
  config.dispatch = { ...saved.dispatch };
});

/**
 * One parking assertion block shared by every uncertain-result case: the error
 * shape, the zero-second-booking proof, and the persisted reconciliation state.
 */
async function expectParkedAmbiguous(opts: {
  orderId: string;
  preferredProvider?: "borzo" | "shadowfax" | "porter";
}) {
  let thrown: any;
  try {
    await dispatchBook({
      orderId: opts.orderId,
      ...(opts.preferredProvider ? { preferredProvider: opts.preferredProvider } : {}),
      staffName: "Ops",
    });
  } catch (err) {
    thrown = err;
  }

  expect(thrown).toBeTruthy();
  expect(thrown?.code).toBe("PROVIDER_BOOK_AMBIGUOUS");
  expect(thrown?.statusCode).toBe(502);
  // The router only walks on ProviderDispatchError; this must stay plain.
  expect(isProviderDispatchError(thrown)).toBe(false);

  const doc = docOf(opts.orderId);
  expect(doc.dispatchStatus).toBe("needs_reconciliation");
  expect(doc.needsRebook).toBe(false);
  expect(doc.rebookTrigger).toBeNull();
  // Nothing was presented as a live booking.
  expect(doc.deliveryStatus).toBeUndefined();
  expect(doc.dispatchOrderId).toBeUndefined();
  expect(doc.borzoOrderId).toBeUndefined();
  expect(doc.shadowfaxOrderId).toBeUndefined();
  // Provider + correlation are preserved for reconciliation.
  expect(doc.dispatchPendingCorrelation).toMatchObject({
    provider: opts.preferredProvider || "borzo",
    orderId: opts.orderId,
  });
  expect(String(doc.dispatchPendingCorrelation.token || "").length).toBeGreaterThan(0);
  return { thrown, doc };
}

describe("F08 T1 — Borzo create-order HTTP 5xx never walks to a second courier", () => {
  it("parks needs_reconciliation with zero Shadowfax create-order POST", async () => {
    // Shadowfax is fully live so a walk WOULD produce a real second booking.
    useLiveShadowfax();
    const sfx = shadowfaxWire("SFX-MUST-NOT-BOOK");
    fetchHandler = (url) => {
      if (url.includes("/calculate-order")) return borzoQuoteWire("50.00")(url);
      if (url.includes("/create-order")) return new Response("upstream exploded", { status: 500 });
      return sfx(url);
    };
    seedOrder("ord_f08_t1");

    const { doc } = await expectParkedAmbiguous({ orderId: "ord_f08_t1", preferredProvider: "borzo" });

    expect(borzoCreateCalls()).toHaveLength(1);
    expect(shadowfaxCreateCalls()).toHaveLength(0);
    expect(doc.dispatchError).toMatch(/borzo/i);
    expect(doc.dispatchAttempts).toEqual([
      expect.objectContaining({ provider: "borzo", outcome: "error" }),
    ]);
  });
});

describe("F08 T2 — a nested post-send ECONNRESET is uncertainty, not a walkable fault", () => {
  it("parks needs_reconciliation with zero Shadowfax create-order POST", async () => {
    useLiveShadowfax();
    const sfx = shadowfaxWire("SFX-MUST-NOT-BOOK");
    fetchHandler = (url) => {
      if (url.includes("/calculate-order")) return borzoQuoteWire("50.00")(url);
      if (url.includes("/create-order")) throw transportLoss("ECONNRESET", 3);
      return sfx(url);
    };
    seedOrder("ord_f08_t2");

    const { thrown, doc } = await expectParkedAmbiguous({
      orderId: "ord_f08_t2",
      preferredProvider: "borzo",
    });

    // The original transport cause survives onto the parked error (bounded,
    // cycle-safe walk) without being relabelled as a rejection.
    expect(String(thrown?.message)).toMatch(/ECONNRESET/);
    expect(doc.dispatchError).toMatch(/ECONNRESET/);
    expect(borzoCreateCalls()).toHaveLength(1);
    expect(shadowfaxCreateCalls()).toHaveLength(0);
  });
});

describe("F08 T3 — a generic 'fetch failed' with no cause is still uncertain", () => {
  it("parks needs_reconciliation with zero Shadowfax create-order POST", async () => {
    useLiveShadowfax();
    const sfx = shadowfaxWire("SFX-MUST-NOT-BOOK");
    fetchHandler = (url) => {
      if (url.includes("/calculate-order")) return borzoQuoteWire("50.00")(url);
      if (url.includes("/create-order")) throw new TypeError("fetch failed");
      return sfx(url);
    };
    seedOrder("ord_f08_t3");

    await expectParkedAmbiguous({ orderId: "ord_f08_t3", preferredProvider: "borzo" });

    expect(borzoCreateCalls()).toHaveLength(1);
    expect(shadowfaxCreateCalls()).toHaveLength(0);
  });
});

describe("F08 T4 — an unreadable create-order body cannot pretend rejection", () => {
  it("parks needs_reconciliation with zero Shadowfax create-order POST", async () => {
    useLiveShadowfax();
    const sfx = shadowfaxWire("SFX-MUST-NOT-BOOK");
    fetchHandler = (url) => {
      if (url.includes("/calculate-order")) return borzoQuoteWire("50.00")(url);
      if (url.includes("/create-order")) return unreadableBody(500) as any;
      return sfx(url);
    };
    seedOrder("ord_f08_t4");

    const { doc } = await expectParkedAmbiguous({ orderId: "ord_f08_t4", preferredProvider: "borzo" });

    expect(doc.dispatchError).toMatch(/borzo/i);
    expect(borzoCreateCalls()).toHaveLength(1);
    expect(shadowfaxCreateCalls()).toHaveLength(0);
  });
});

describe("F08 T5 — proven pre-send ENOTFOUND may still fail over (positive control)", () => {
  it("books Shadowfax once after Borzo never reached the wire", async () => {
    useLiveShadowfax();
    const sfx = shadowfaxWire("SFX-F08-FAILOVER");
    fetchHandler = (url) => {
      if (url.includes("/calculate-order")) return borzoQuoteWire("50.00")(url);
      if (url.includes("/create-order")) throw transportLoss("ENOTFOUND", 2);
      return sfx(url);
    };
    seedOrder("ord_f08_t5");

    const res = await dispatchBook({ orderId: "ord_f08_t5", preferredProvider: "borzo" });

    expect(res.provider).toBe("shadowfax");
    expect(res.providerOrderId).toBe("SFX-F08-FAILOVER");
    expect(res.failover).toMatchObject({ from: "borzo", to: "shadowfax" });
    // Exactly ONE create-order went out per provider: Borzo's attempt failed
    // before the connection existed, Shadowfax's booking is the only live one.
    expect(borzoCreateCalls()).toHaveLength(1);
    expect(shadowfaxCreateCalls()).toHaveLength(1);
    const doc = docOf("ord_f08_t5");
    expect(doc.dispatchStatus).toBe("dispatched");
    expect(doc.shadowfaxOrderId).toBe("SFX-F08-FAILOVER");
    expect(doc.borzoOrderId).toBeNull();
    expect(doc.needsRebook).toBe(false);
  });
});

describe("F08 — symmetric Shadowfax create-order uncertainty (no Borzo second POST)", () => {
  it("Shadowfax 5xx parks and never books Borzo", async () => {
    // Borzo live too, so a walk to it would produce a real second POST.
    fetchHandler = (url) => {
      if (url.includes("/api/v1/order-serviceability/")) {
        return okJson({ serviceable: true, delivery_cost: 45, pickup_eta: 6 });
      }
      if (/\/api\/v2\/orders\/?$/.test(url)) return new Response("upstream exploded", { status: 502 });
      if (url.includes("/calculate-order")) return okJson({ is_successful: true, order: { payment_amount: "50.00" } });
      if (url.includes("/create-order")) {
        return okJson({ is_successful: true, order: { order_id: "BZ-MUST-NOT-BOOK", points: [] } });
      }
      return okJson({ message: "not found" }, 404);
    };
    useLiveShadowfax();
    seedOrder("ord_f08_sfx_5xx");

    const { doc } = await expectParkedAmbiguous({
      orderId: "ord_f08_sfx_5xx",
      preferredProvider: "shadowfax",
    });

    expect(shadowfaxCreateCalls()).toHaveLength(1);
    expect(borzoCreateCalls()).toHaveLength(0);
    expect(doc.dispatchPendingCorrelation.provider).toBe("shadowfax");
    expect(doc.dispatchError).toMatch(/shadowfax/i);
  });

  it("Shadowfax unreadable body parks and never books Borzo", async () => {
    fetchHandler = (url) => {
      if (url.includes("/api/v1/order-serviceability/")) {
        return okJson({ serviceable: true, delivery_cost: 45, pickup_eta: 6 });
      }
      if (/\/api\/v2\/orders\/?$/.test(url)) return unreadableBody(503) as any;
      return okJson({ is_successful: true, order: { payment_amount: "50.00" } });
    };
    useLiveShadowfax();
    seedOrder("ord_f08_sfx_body");

    await expectParkedAmbiguous({
      orderId: "ord_f08_sfx_body",
      preferredProvider: "shadowfax",
    });

    expect(shadowfaxCreateCalls()).toHaveLength(1);
    expect(borzoCreateCalls()).toHaveLength(0);
  });

  it("Shadowfax post-send ECONNRESET parks and never books Borzo", async () => {
    fetchHandler = (url) => {
      if (url.includes("/api/v1/order-serviceability/")) {
        return okJson({ serviceable: true, delivery_cost: 45, pickup_eta: 6 });
      }
      if (/\/api\/v2\/orders\/?$/.test(url)) throw transportLoss("ECONNRESET", 2);
      return okJson({ is_successful: true, order: { payment_amount: "50.00" } });
    };
    useLiveShadowfax();
    seedOrder("ord_f08_sfx_reset");

    await expectParkedAmbiguous({
      orderId: "ord_f08_sfx_reset",
      preferredProvider: "shadowfax",
    });

    expect(shadowfaxCreateCalls()).toHaveLength(1);
    expect(borzoCreateCalls()).toHaveLength(0);
  });
});

describe("F08 — quote-time classification is unchanged (pins)", () => {
  it.each([401, 429, 500, 503])("Borzo quote HTTP %i stays transient_failure", async (status: number) => {
    // Only Borzo is eligible, so a failed sole provider surfaces the
    // NO_SERVICEABLE_PROVIDER envelope — whose `providers[]` is the recorded
    // per-provider outcome. That class must stay transient_failure (quote-time
    // behaviour is deliberately NOT tightened by this booking fix).
    fetchHandler = () => okJson({ message: "provider having a bad day" }, status);
    config.shadowfax.enabled = false;
    config.porter.enabled = false;
    let envelope: any;
    try {
      await dispatchQuote({
        pickupLat: 23.0131,
        pickupLng: 72.5085,
        dropLat: 23.0338,
        dropLng: 72.5262,
        orderId: "ord_f08_quote",
      });
    } catch (err) {
      envelope = err;
    }
    expect(envelope?.code).toBe("NO_SERVICEABLE_PROVIDER");
    const out = (envelope.providers || []).find((p: any) => p.provider === "borzo");
    expect(out).toMatchObject({ provider: "borzo", outcome: "transient_failure" });
  });

  it("a DEFINITE Borzo book-time rejection still walks (DR6 preserved)", async () => {
    useLiveShadowfax();
    const sfx = shadowfaxWire("SFX-F08-REJECTED");
    fetchHandler = (url) => {
      if (url.includes("/calculate-order")) return borzoQuoteWire("50.00")(url);
      if (url.includes("/create-order")) {
        return okJson(
          { is_successful: false, errors: ["invalid_region"] },
          400
        );
      }
      return sfx(url);
    };
    seedOrder("ord_f08_reject");

    const res = await dispatchBook({ orderId: "ord_f08_reject", preferredProvider: "borzo" });
    expect(res.provider).toBe("shadowfax");
    expect(res.attempts?.[0]).toMatchObject({ provider: "borzo", outcome: "not_serviced" });
    expect(borzoCreateCalls()).toHaveLength(1);
    expect(shadowfaxCreateCalls()).toHaveLength(1);
  });
});

/** The parked error must not be mistaken for a walkable provider fault. */
describe("F08 — error-class contract", () => {
  it("a parked ambiguity is NOT a ProviderDispatchError and carries the provider", async () => {
    fetchHandler = (url) => {
      if (url.includes("/calculate-order")) return borzoQuoteWire("50.00")(url);
      if (url.includes("/create-order")) return new Response("upstream exploded", { status: 500 });
      return okJson({ message: "not found" }, 404);
    };
    seedOrder("ord_f08_class");

    let thrown: any;
    try {
      await dispatchBook({ orderId: "ord_f08_class", preferredProvider: "borzo" });
    } catch (err) {
      thrown = err;
    }
    expect(thrown?.code).toBe("PROVIDER_BOOK_AMBIGUOUS");
    expect(thrown?.provider).toBe("borzo");
    expect(isProviderDispatchError(thrown)).toBe(false);
  });
});

/**
 * F08 punchlist R2 — regressions reported by the peer review.
 *
 * Each case drives the REAL `dispatchBook` + real adapters + controlled fake
 * `fetch`, so a wrongly walkable outcome issues a real second create-order POST
 * that the assertions count.
 */

/** Parsed order-id evidence must survive in the parked error AND dispatchError. */
const namedIdEvidence = (text: string) => /BZ-5XX-KNOWN-1/.test(text);

describe("F08-R2 #1 — a 5xx that still NAMES an order keeps that evidence", () => {
  it("Borzo 503 with a nested order_id parks and names the known order", async () => {
    useLiveShadowfax();
    const sfx = shadowfaxWire("SFX-MUST-NOT-BOOK");
    fetchHandler = (url) => {
      if (url.includes("/calculate-order")) return borzoQuoteWire("50.00")(url);
      if (url.includes("/create-order")) {
        return okJson(
          { is_successful: false, order: { order_id: "BZ-5XX-KNOWN-1" }, errors: ["internal_error"] },
          503
        );
      }
      return sfx(url);
    };
    seedOrder("ord_f08_r2_bz_named");

    const { thrown, doc } = await expectParkedAmbiguous({
      orderId: "ord_f08_r2_bz_named",
      preferredProvider: "borzo",
    });

    // Evidence is DIAGNOSTIC only: never bound as a booking.
    expect(doc.deliveryStatus).toBeUndefined();
    expect(doc.dispatchOrderId).toBeUndefined();
    expect(doc.borzoOrderId).toBeUndefined();
    expect(namedIdEvidence(String(thrown?.message))).toBe(true);
    expect(namedIdEvidence(String(doc.dispatchError))).toBe(true);
    expect((thrown as any).providerOrderId).toBe("BZ-5XX-KNOWN-1");
    expect(borzoCreateCalls()).toHaveLength(1);
    expect(shadowfaxCreateCalls()).toHaveLength(0);
  });

  it("Shadowfax 503 with a nested sfx_order_id parks and names the known order", async () => {
    fetchHandler = (url) => {
      if (url.includes("/api/v1/order-serviceability/")) {
        return okJson({ serviceable: true, delivery_cost: 45, pickup_eta: 6 });
      }
      if (/\/api\/v2\/orders\/?$/.test(url)) {
        return okJson(
          { message: "boom", data: { sfx_order_id: "SFX-5XX-KNOWN-1" } },
          503
        );
      }
      if (url.includes("/calculate-order")) {
        return okJson({ is_successful: true, order: { payment_amount: "50.00" } });
      }
      if (url.includes("/create-order")) {
        return okJson({ is_successful: true, order: { order_id: "BZ-MUST-NOT-BOOK" } });
      }
      return okJson({ message: "not found" }, 404);
    };
    useLiveShadowfax();
    seedOrder("ord_f08_r2_sfx_named");

    const { thrown, doc } = await expectParkedAmbiguous({
      orderId: "ord_f08_r2_sfx_named",
      preferredProvider: "shadowfax",
    });

    expect(String(thrown?.message)).toMatch(/SFX-5XX-KNOWN-1/);
    expect(String(doc.dispatchError)).toMatch(/SFX-5XX-KNOWN-1/);
    expect((thrown as any).providerOrderId).toBe("SFX-5XX-KNOWN-1");
    expect(doc.dispatchOrderId).toBeUndefined();
    expect(shadowfaxCreateCalls()).toHaveLength(1);
    expect(borzoCreateCalls()).toHaveLength(0);
  });
});

describe("F08-R2 #2 — body-read coverage (2xx and 4xx unreadable)", () => {
  it("Borzo 2xx with an unreadable body parks", async () => {
    useLiveShadowfax();
    const sfx = shadowfaxWire("SFX-MUST-NOT-BOOK");
    fetchHandler = (url) => {
      if (url.includes("/calculate-order")) return borzoQuoteWire("50.00")(url);
      if (url.includes("/create-order")) return unreadableBody(200) as any;
      return sfx(url);
    };
    seedOrder("ord_f08_r2_bz_2xx_body");
    await expectParkedAmbiguous({ orderId: "ord_f08_r2_bz_2xx_body", preferredProvider: "borzo" });
    expect(borzoCreateCalls()).toHaveLength(1);
    expect(shadowfaxCreateCalls()).toHaveLength(0);
  });

  it("Shadowfax 2xx with an unreadable body parks", async () => {
    fetchHandler = (url) => {
      if (url.includes("/api/v1/order-serviceability/")) {
        return okJson({ serviceable: true, delivery_cost: 45, pickup_eta: 6 });
      }
      if (/\/api\/v2\/orders\/?$/.test(url)) return unreadableBody(200) as any;
      return okJson({ is_successful: true, order: { payment_amount: "50.00" } });
    };
    useLiveShadowfax();
    seedOrder("ord_f08_r2_sfx_2xx_body");
    await expectParkedAmbiguous({ orderId: "ord_f08_r2_sfx_2xx_body", preferredProvider: "shadowfax" });
    expect(shadowfaxCreateCalls()).toHaveLength(1);
    expect(borzoCreateCalls()).toHaveLength(0);
  });

  it("Borzo 4xx (400) with an unreadable body parks instead of walking", async () => {
    useLiveShadowfax();
    const sfx = shadowfaxWire("SFX-MUST-NOT-BOOK");
    fetchHandler = (url) => {
      if (url.includes("/calculate-order")) return borzoQuoteWire("50.00")(url);
      if (url.includes("/create-order")) return unreadableBody(400) as any;
      return sfx(url);
    };
    seedOrder("ord_f08_r2_bz_4xx_body");
    const { doc } = await expectParkedAmbiguous({
      orderId: "ord_f08_r2_bz_4xx_body",
      preferredProvider: "borzo",
    });
    expect(doc.dispatchStatus).toBe("needs_reconciliation");
    expect(borzoCreateCalls()).toHaveLength(1);
    expect(shadowfaxCreateCalls()).toHaveLength(0);
  });

  it("a PARSED definite 400 still walks (body-read coverage does not weaken it)", async () => {
    useLiveShadowfax();
    const sfx = shadowfaxWire("SFX-F08-REJECTED-2");
    fetchHandler = (url) => {
      if (url.includes("/calculate-order")) return borzoQuoteWire("50.00")(url);
      if (url.includes("/create-order")) {
        return okJson({ is_successful: false, errors: ["invalid_region"] }, 400);
      }
      return sfx(url);
    };
    seedOrder("ord_f08_r2_bz_4xx_parsed");
    const res = await dispatchBook({ orderId: "ord_f08_r2_bz_4xx_parsed", preferredProvider: "borzo" });
    expect(res.provider).toBe("shadowfax");
    expect(res.attempts?.[0]).toMatchObject({ provider: "borzo", outcome: "not_serviced" });
    expect(borzoCreateCalls()).toHaveLength(1);
    expect(shadowfaxCreateCalls()).toHaveLength(1);
  });
});

describe("F08-R2 #3 — conflicting transport evidence is NOT pre-send proof", () => {
  it("a reset PLUS a DNS code in one chain parks (uncertainty wins)", async () => {
    useLiveShadowfax();
    const sfx = shadowfaxWire("SFX-MUST-NOT-BOOK");
    fetchHandler = (url) => {
      if (url.includes("/calculate-order")) return borzoQuoteWire("50.00")(url);
      if (url.includes("/create-order")) {
        // Both codes are present; ANY single DNS match must not "prove" pre-send.
        const dns: any = Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
        const reset: any = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET", cause: dns });
        throw Object.assign(new Error("fetch failed"), { cause: reset });
      }
      return sfx(url);
    };
    seedOrder("ord_f08_r2_mixed");
    await expectParkedAmbiguous({ orderId: "ord_f08_r2_mixed", preferredProvider: "borzo" });
    expect(borzoCreateCalls()).toHaveLength(1);
    expect(shadowfaxCreateCalls()).toHaveLength(0);
  });

  it("a chain with ONLY ECONNREFUSED still fails over (positive control kept)", async () => {
    useLiveShadowfax();
    const sfx = shadowfaxWire("SFX-F08-FAILOVER-R2");
    fetchHandler = (url) => {
      if (url.includes("/calculate-order")) return borzoQuoteWire("50.00")(url);
      if (url.includes("/create-order")) throw transportLoss("ECONNREFUSED", 2);
      return sfx(url);
    };
    seedOrder("ord_f08_r2_refused");
    const res = await dispatchBook({ orderId: "ord_f08_r2_refused", preferredProvider: "borzo" });
    expect(res.provider).toBe("shadowfax");
    expect(borzoCreateCalls()).toHaveLength(1);
    expect(shadowfaxCreateCalls()).toHaveLength(1);
  });
});

describe("F08-R2 #4 — a wire-thrown typed error is not local pre-wire evidence", () => {
  it("Borzo fetch throwing a cause-less ProviderDispatchError parks (no failover)", async () => {
    useLiveShadowfax();
    const sfx = shadowfaxWire("SFX-MUST-NOT-BOOK");
    fetchHandler = (url) => {
      if (url.includes("/calculate-order")) return borzoQuoteWire("50.00")(url);
      if (url.includes("/create-order")) {
        throw new ProviderDispatchError("borzo", "transient", "borzo socket layer failed");
      }
      return sfx(url);
    };
    seedOrder("ord_f08_r2_typed");
    const { thrown } = await expectParkedAmbiguous({
      orderId: "ord_f08_r2_typed",
      preferredProvider: "borzo",
    });
    expect(thrown?.code).toBe("PROVIDER_BOOK_AMBIGUOUS");
    expect(borzoCreateCalls()).toHaveLength(1);
    expect(shadowfaxCreateCalls()).toHaveLength(0);
  });

  it("a missing contact is still a LOCAL gate: zero fetches, unchanged classification", async () => {
    fetchHandler = () => {
      throw new Error("must not reach the wire");
    };
    seedOrder("ord_f08_r2_localgate", { customerPhone: undefined, store: { name: "Burgonomics CG Road" } });
    const err: any = await dispatchBook({
      orderId: "ord_f08_r2_localgate",
      preferredProvider: "borzo",
    }).catch((e) => e);
    expect(fetchCalls).toHaveLength(0);
    // The router's OWN pre-wire contact gate still refuses before any fetch; the
    // provider-side gate in buildPoints remains the second line of defence.
    expect(err?.code).toBe("DISPATCH_CONTACT_MISSING");
    expect(String(err.message)).toMatch(/contact phone|branch phone|phone/i);
    expect(isProviderDispatchError(err)).toBe(false);
    expect(err?.code).not.toBe("PROVIDER_BOOK_AMBIGUOUS");
  });
});

describe("F08-R2 #6 — CREATE never auto-follows a redirect (pre-send proof holds)", () => {
  it("Borzo/Shadowfax CREATE inits set redirect:'error'; quotes keep their policy", async () => {
    fetchHandler = (url) => {
      if (url.includes("/calculate-order")) return borzoQuoteWire("50.00")(url);
      if (url.includes("/create-order")) {
        return okJson({ is_successful: true, order: { order_id: "BZ-REDIR-OK" } });
      }
      if (url.includes("/api/v1/order-serviceability/")) {
        return okJson({ serviceable: true, delivery_cost: 45, pickup_eta: 6 });
      }
      if (/\/api\/v2\/orders\/?$/.test(url)) {
        return okJson({ message: "order placed", data: { sfx_order_id: "SFX-REDIR-OK" } });
      }
      return okJson({ message: "not found" }, 404);
    };
    useLiveShadowfax();
    seedOrder("ord_f08_r2_redirect_policy");

    await dispatchBook({ orderId: "ord_f08_r2_redirect_policy", preferredProvider: "borzo" });
    // Shadowfax quote (serviceability) may run during the quote walk; the
    // CREATE call is the one asserted here.
    const borzoCreate = borzoCreateCalls()[0];
    expect(borzoCreate.init.redirect).toBe("error");
    const quoteInits = fetchCalls.filter((c) => c.url.includes("/calculate-order"));
    expect(quoteInits.every((c) => c.init.redirect === undefined)).toBe(true);

    // Shadowfax create, driven directly with a preferred Shadowfax booking.
    fetchCalls = [];
    seedOrder("ord_f08_r2_redirect_policy_sfx");
    await dispatchBook({ orderId: "ord_f08_r2_redirect_policy_sfx", preferredProvider: "shadowfax" });
    const sfxCreate = shadowfaxCreateCalls()[0];
    expect(sfxCreate.init.redirect).toBe("error");
    const sfxQuote = fetchCalls.filter((c) => c.url.includes("/api/v1/order-serviceability/"));
    expect(sfxQuote.every((c) => c.init.redirect === undefined)).toBe(true);
  });

  it("a redirect refusal after the POST is delivered parks (no second booking)", async () => {
    useLiveShadowfax();
    const sfx = shadowfaxWire("SFX-MUST-NOT-BOOK");
    fetchHandler = (url, init) => {
      if (url.includes("/calculate-order")) return borzoQuoteWire("50.00")(url);
      if (url.includes("/create-order")) {
        // With redirect:'error' native fetch refuses the follow and surfaces
        // `unexpected redirect` (UND_ERR_REDIRECT) — NOT a DNS error from the
        // target. That must be uncertainty, never a pre-send proof.
        expect(init.redirect).toBe("error");
        const inner: any = Object.assign(new Error("unexpected redirect"), {
          code: "UND_ERR_REDIRECT",
        });
        throw new TypeError("fetch failed", { cause: inner });
      }
      return sfx(url);
    };
    seedOrder("ord_f08_r2_redirect_fail");
    const { thrown } = await expectParkedAmbiguous({
      orderId: "ord_f08_r2_redirect_fail",
      preferredProvider: "borzo",
    });
    expect(thrown?.code).toBe("PROVIDER_BOOK_AMBIGUOUS");
    expect(borzoCreateCalls()).toHaveLength(1);
    expect(shadowfaxCreateCalls()).toHaveLength(0);
  });

  it("a genuine pre-send DNS failure on the FIRST hop still fails over (control)", async () => {
    useLiveShadowfax();
    const sfx = shadowfaxWire("SFX-REDIR-CONTROL");
    fetchHandler = (url) => {
      if (url.includes("/calculate-order")) return borzoQuoteWire("50.00")(url);
      if (url.includes("/create-order")) throw transportLoss("ENOTFOUND", 1);
      return sfx(url);
    };
    seedOrder("ord_f08_r2_redirect_control");
    const res = await dispatchBook({
      orderId: "ord_f08_r2_redirect_control",
      preferredProvider: "borzo",
    });
    expect(res.provider).toBe("shadowfax");
    expect(borzoCreateCalls()).toHaveLength(1);
    expect(shadowfaxCreateCalls()).toHaveLength(1);
  });
});

describe("F08-R2 #5 — public parked error never carries nested provider text", () => {
  const CREDENTIAL_SENTINEL = "SENTINEL-BEARER-abc123";
  const PII_SENTINEL = "Ravi Kumar 9876543210";

  it("a nested message with a credential/PII is absent from message and dispatchError", async () => {
    useLiveShadowfax();
    const sfx = shadowfaxWire("SFX-MUST-NOT-BOOK");
    fetchHandler = (url) => {
      if (url.includes("/calculate-order")) return borzoQuoteWire("50.00")(url);
      if (url.includes("/create-order")) {
        const inner: any = Object.assign(
          new Error(`socket reset while sending Authorization: Bearer ${CREDENTIAL_SENTINEL} for ${PII_SENTINEL}`),
          { code: "ECONNRESET" }
        );
        throw Object.assign(new Error("fetch failed"), { cause: inner });
      }
      return sfx(url);
    };
    seedOrder("ord_f08_r2_pii");

    const { thrown, doc } = await expectParkedAmbiguous({
      orderId: "ord_f08_r2_pii",
      preferredProvider: "borzo",
    });

    expect(String(thrown?.message)).not.toMatch(new RegExp(CREDENTIAL_SENTINEL));
    expect(String(thrown?.message)).not.toMatch(/9876543210/);
    expect(String(doc.dispatchError)).not.toMatch(new RegExp(CREDENTIAL_SENTINEL));
    expect(String(doc.dispatchError)).not.toMatch(/9876543210/);
    // Only the allowlisted transport code is public.
    expect(String(thrown?.message)).toMatch(/ECONNRESET/);

    // The ORIGINAL throwable is still retained structurally (non-enumerable),
    // so a reconciliation operator can inspect it without it being printed.
    const cause: any = (thrown as any).cause;
    expect(cause).toBeTruthy();
    expect(cause.message).toMatch(new RegExp(CREDENTIAL_SENTINEL));
    const enumerable = Object.keys(thrown).filter((k) => k === "cause");
    expect(enumerable).toHaveLength(0);
  });
});

