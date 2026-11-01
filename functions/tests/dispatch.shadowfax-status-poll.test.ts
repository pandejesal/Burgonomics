import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";

/**
 * Shadowfax status-poll recovery (T2).
 *
 * The Marketplace docs list `GET /api/v2/orders/{sfx_order_id}/status/` and say
 * plainly: "Use Get Order Details as a reconciliation fallback" — a callback
 * can be missed for good after 7 retries at 5-minute intervals (35 minutes).
 * Until this worker existed, a missed ALLOTTED/DISPATCHED/DELIVERED left the
 * order parked on Shadowfax callbacks forever, and nothing in the schedule
 * looked at it.
 *
 * Fixtures: the docs publish NO example response body for this endpoint, so
 * every pull body below is SCHEMA-DERIVED from the published `OrderData` /
 * `RiderDetails` schemas (client_code, status, sfx_order_id, rider_details
 * {rider_name, rider_phone, rider_location}), NOT a captured provider reply.
 * The order-status values and the rider details are real doc examples reused
 * as field values (ALLOTTED / DISPATCHED / DELIVERED, "Aastha Jain").
 *
 * Harness: stubbed global.fetch + an in-memory Firestore shim, same technique
 * as tests/dispatch.router.test.ts. No provider call, no credentials.
 */

const { mockDb, savedDocs } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  const mergeSet = (path: string, data: any) => {
    savedDocs[path] = { ...(savedDocs[path] || {}), ...data };
  };
  const makeSnap = (path: string, id: string) => ({
    id,
    exists: savedDocs[path] !== undefined,
    data: () => savedDocs[path],
    set: vi.fn(async (data: any, opts?: any) => {
      savedDocs[path] = opts?.merge ? { ...(savedDocs[path] || {}), ...data } : data;
    }),
    ref: {
      id,
      get: vi.fn(async () => makeSnap(path, id)),
      set: vi.fn(async (data: any, opts?: any) => {
        savedDocs[path] = opts?.merge ? { ...(savedDocs[path] || {}), ...data } : data;
      }),
    },
  });
  const mockDb: any = {
    collection: (col: string) => ({
      doc: (id: string) => makeSnap(`${col}/${id}`, id),
      where: () => ({
        limit: () => ({
          get: async () => {
            const docs = Object.keys(savedDocs)
              .filter((k) => k.startsWith(`${col}/`))
              .map((k) => {
                const id = k.slice(col.length + 1);
                return makeSnap(k, id);
              });
            return { empty: docs.length === 0, docs };
          },
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
  return { mockDb, savedDocs };
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

import { pollActiveShadowfaxOrdersWorker } from "../src/modules/dispatch/shadowfax.reconcile";
import { config } from "../src/config/env";

const okJson = (data: any, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const originalFetch = globalThis.fetch;
let fetchCalls: Array<{ url: string; init: any }> = [];
let fetchHandler: ((url: string, init: any) => Response) | null = null;
let saved: any;

beforeAll(() => {
  globalThis.fetch = vi.fn(async (url: any, init: any) => {
    fetchCalls.push({ url: String(url), init });
    if (fetchHandler) return fetchHandler(String(url), init);
    return okJson({ message: "no fetch handler registered" }, 404);
  }) as any;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

beforeEach(() => {
  for (const k of Object.keys(savedDocs)) delete savedDocs[k];
  fetchCalls = [];
  fetchHandler = null;
  saved = { shadowfax: { ...config.shadowfax }, mock: { ...config.mock } };
  config.shadowfax.apiKey = "your_api_token";
  config.shadowfax.baseUrl = "https://hlbackend.staging.shadowfax.in";
  config.shadowfax.clientCode = "merchant001";
  config.mock.shadowfaxDispatch = false;
});

afterEach(() => {
  config.shadowfax = { ...saved.shadowfax };
  config.mock = { ...saved.mock };
});

/** Schema-derived OrderData pull body; `status` is the documented enum value. */
function pullBody(status: string, extra: Record<string, any> = {}) {
  return {
    message: "Order details fetched successfully",
    data: {
      client_code: "merchant001",
      status,
      sfx_order_id: 21030620,
      track_url:
        "https://order-tracking-hl.staging.shadowfax.in/track/73B614A0215C770722F06B0095F9C503",
      rider_details: {
        rider_name: "Aastha Jain",
        rider_phone: "8750879029",
        rider_location: { lat: 28.588837, lng: 77.063762 },
      },
      ...extra,
    },
  };
}

function seedOrder(id: string, extra: Record<string, any> = {}) {
  savedDocs[`orders/${id}`] = {
    branchId: "branch_ahmedabad_1",
    deliveryStatus: "dispatched",
    dispatchStatus: "dispatched",
    dispatchProvider: "shadowfax",
    dispatchOrderId: "21030620",
    shadowfaxOrderId: "21030620",
    // Older than the 15-minute freshness window: the webhook has gone quiet.
    updatedAt: { toMillis: () => Date.now() - 40 * 60 * 1000 },
    ...extra,
  };
}

function docOf(id: string): any {
  return savedDocs[`orders/${id}`];
}

describe("Shadowfax status poll (missed-webhook recovery)", () => {
  it("recovers a missed ALLOTTED callback: rider identity lands from the pull API", async () => {
    seedOrder("ord_sfx_poll_allotted");
    fetchHandler = () => okJson(pullBody("ALLOTTED"));

    const res = await pollActiveShadowfaxOrdersWorker();

    expect(res.polledCount).toBe(1);
    expect(res.updatedCount).toBe(1);
    expect(fetchCalls[0].url).toBe(
      "https://hlbackend.staging.shadowfax.in/api/v2/orders/21030620/status/"
    );
    expect(fetchCalls[0].init.method).toBe("GET");
    expect(fetchCalls[0].init.headers.Authorization).toBe("Token your_api_token");
    expect(docOf("ord_sfx_poll_allotted")).toMatchObject({
      riderName: "Aastha Jain",
      riderPhone: "8750879029",
      deliveryStatus: "dispatched",
      dispatchStatus: "dispatched",
    });
    expect(docOf("ord_sfx_poll_allotted").delivery).toMatchObject({
      status: "rider_assigned",
      riderLocation: { lat: 28.588837, lng: 77.063762 },
    });
  });

  it("recovers a missed DISPATCHED callback: the order moves to in_transit", async () => {
    seedOrder("ord_sfx_poll_dispatched");
    fetchHandler = () => okJson(pullBody("DISPATCHED"));

    await pollActiveShadowfaxOrdersWorker();

    expect(docOf("ord_sfx_poll_dispatched").deliveryStatus).toBe("in_transit");
    expect(docOf("ord_sfx_poll_dispatched").status).toMatchObject({
      code: "OUT_FOR_DELIVERY",
      terminal: false,
    });
  });

  it("recovers a missed DELIVERED callback: the order closes", async () => {
    seedOrder("ord_sfx_poll_delivered", { deliveryStatus: "in_transit" });
    fetchHandler = () => okJson(pullBody("DELIVERED"));

    await pollActiveShadowfaxOrdersWorker();

    expect(docOf("ord_sfx_poll_delivered").deliveryStatus).toBe("delivered");
    expect(docOf("ord_sfx_poll_delivered").status).toMatchObject({
      code: "DELIVERED",
      terminal: true,
    });
    expect(docOf("ord_sfx_poll_delivered").deliveredAt).toBe("MOCK_TIMESTAMP");
  });

  it("never rewinds: an ALLOTTED pull on an in_transit order changes nothing", async () => {
    seedOrder("ord_sfx_poll_nowind", { deliveryStatus: "in_transit" });
    fetchHandler = () => okJson(pullBody("ALLOTTED"));

    const res = await pollActiveShadowfaxOrdersWorker();

    expect(res.updatedCount).toBe(0);
    expect(docOf("ord_sfx_poll_nowind").deliveryStatus).toBe("in_transit");
    expect(docOf("ord_sfx_poll_nowind").riderName).toBeUndefined();
  });

  it("parks a provider-side CANCELLED for review and buys no rider", async () => {
    // A pull-observed cancellation is evidence, but the poll may not run the
    // cancel containment + auto-rebook machinery: a misread body must never
    // flip a live order AND release a booking the rider is still serving.
    seedOrder("ord_sfx_poll_cancel");
    fetchHandler = () =>
      okJson({
        message: "Order details fetched successfully",
        data: {
          client_code: "merchant001",
          status: "CANCELLED",
          sfx_order_id: 21030620,
          // Doc example: the CANCELLED callback's cause table entry 5.
          cancel_reason: 5,
          cancel_reason_text: "Operational Issue with order",
        },
      });

    const res = await pollActiveShadowfaxOrdersWorker();

    expect(res.updatedCount).toBe(0);
    expect(docOf("ord_sfx_poll_cancel").deliveryStatus).toBe("dispatched");
    expect(docOf("ord_sfx_poll_cancel").needsRebook).toBeUndefined();
    const parks = Object.keys(savedDocs).filter((k) =>
      k.startsWith("unmatched_dispatch_events/")
    );
    expect(parks).toHaveLength(1);
    expect(savedDocs[parks[0]]).toMatchObject({
      provider: "shadowfax",
      reason: "poll_provider_cancelled",
      providerOrderId: "21030620",
    });
  });

  it("ignores an order whose binding moved to another booking while the poll was in flight", async () => {
    seedOrder("ord_sfx_poll_stale");
    fetchHandler = () => {
      // A staff rebook lands before the pull response is applied.
      savedDocs["orders/ord_sfx_poll_stale"] = {
        ...savedDocs["orders/ord_sfx_poll_stale"],
        dispatchProvider: "borzo",
        dispatchOrderId: "BRZ-ORD-9",
        borzoOrderId: "BRZ-ORD-9",
      };
      return okJson(pullBody("DELIVERED"));
    };

    const res = await pollActiveShadowfaxOrdersWorker();

    expect(res.updatedCount).toBe(0);
    expect(docOf("ord_sfx_poll_stale").deliveryStatus).toBe("dispatched");
    expect(docOf("ord_sfx_poll_stale").dispatchProvider).toBe("borzo");
  });

  it("never polls a non-Shadowfax order in the same query window", async () => {
    seedOrder("ord_borzo_poll", {
      dispatchProvider: "borzo",
      dispatchOrderId: "BRZ-ORD-9",
      borzoOrderId: "BRZ-ORD-9",
      shadowfaxOrderId: null,
    });
    fetchHandler = () => okJson(pullBody("DISPATCHED"));

    const res = await pollActiveShadowfaxOrdersWorker();

    expect(res.polledCount).toBe(0);
    expect(fetchCalls).toHaveLength(0);
    expect(docOf("ord_borzo_poll").deliveryStatus).toBe("dispatched");
  });

  it("skips a fresh order: a webhook that just landed keeps the tick free of fetch calls", async () => {
    seedOrder("ord_sfx_poll_fresh", { updatedAt: { toMillis: () => Date.now() } });
    fetchHandler = () => okJson(pullBody("DISPATCHED"));

    const res = await pollActiveShadowfaxOrdersWorker();

    expect(res.polledCount).toBe(0);
    expect(fetchCalls).toHaveLength(0);
  });

  it("records a provider failure without flipping state, then parks the order after 12 dead polls", async () => {
    seedOrder("ord_sfx_poll_error");
    fetchHandler = () => okJson({ detail: "internal error" }, 500);

    await pollActiveShadowfaxOrdersWorker();

    expect(docOf("ord_sfx_poll_error").deliveryStatus).toBe("dispatched");
    expect(docOf("ord_sfx_poll_error").shadowfaxPollCount).toBe(1);
    expect(docOf("ord_sfx_poll_error").shadowfaxLastPollError).toMatch(/HTTP 500/);

    seedOrder("ord_sfx_poll_dead", { shadowfaxPollCount: 11 });
    await pollActiveShadowfaxOrdersWorker();

    expect(docOf("ord_sfx_poll_dead").deliveryStatus).toBe("needs_review");
    // No automatic rebook: an unproven dead booking must not buy a second rider.
    expect(docOf("ord_sfx_poll_dead").needsRebook).toBe(false);
  });

  it("does nothing at all when the provider is not configured (fail closed, no fake success)", async () => {
    seedOrder("ord_sfx_poll_unkeyed");
    config.shadowfax.apiKey = "";

    const res = await pollActiveShadowfaxOrdersWorker();

    expect(res.polledCount).toBe(0);
    expect(fetchCalls).toHaveLength(0);
    expect(docOf("ord_sfx_poll_unkeyed").deliveryStatus).toBe("dispatched");
  });
});
