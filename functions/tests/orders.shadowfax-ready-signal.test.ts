import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";

/**
 * Shadowfax dispatch-ready signal on the KDS ready transition (T3).
 *
 * Docs: `PUT /api/v2/orders/{coid}/dispatch-ready/` with
 * `{ "shipment_ready_timestamp": "2022-09-14T17:50:00Z" }` (UTC date-time),
 * "Notify Shadowfax when the shipment is ready for pickup so the rider can
 * collect it." `{coid}` is the CLIENT order id — the value we sent as
 * `order_details.client_order_id`, which the dispatcher mints as its durable
 * correlation token, so the order doc carries it.
 *
 * Two hard requirements from the brief:
 *   - Shadowfax orders ONLY (no call for Borzo/Porter/in-house).
 *   - A provider failure must NEVER block the kitchen: the KDS bump has already
 *     committed, so the call is post-commit, logged, and left retryable (the
 *     5-minute Shadowfax reconciler resends the SAME timestamp).
 *
 * Fixtures: no provider example body exists for a FAILURE here, so the 500
 * body is the schema-derived `DetailErrorResponse` (`{ detail }`) that
 * dispatch.shadowfax-contract-gates already pins for Shadowfax 4xx/5xx.
 */

const { mockDb, savedDocs } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  const write = (path: string, data: any, merge?: boolean) => {
    savedDocs[path] = merge ? { ...(savedDocs[path] || {}), ...data } : data;
  };
  const makeRef = (path: string, id: string) => ({
    id,
    __path: path,
    get: vi.fn(async () => ({
      id,
      exists: savedDocs[path] !== undefined,
      data: () => savedDocs[path],
      ref: makeRef(path, id),
    })),
    set: vi.fn(async (data: any, opts?: any) => write(path, data, opts?.merge)),
    update: vi.fn(async (data: any) => {
      if (savedDocs[path] === undefined) throw new Error(`No document to update: ${path}`);
      write(path, data, true);
    }),
  });
  const matches = (doc: any, field: string, op: string, value: any) => {
    const actual = field.split(".").reduce((acc: any, k: string) => acc?.[k], doc);
    if (op === "==") return actual === value;
    if (op === "in") return Array.isArray(value) && value.includes(actual);
    return true;
  };
  const mockDb: any = {
    collection: (col: string) => ({
      doc: (id: string) => makeRef(`${col}/${id}`, id),
      where: (field: string, op: string, value: any) => ({
        limit: (n: number) => ({
          get: async () => {
            const docs = Object.keys(savedDocs)
              .filter((k) => k.startsWith(`${col}/`))
              .filter((k) => matches(savedDocs[k], field, op, value))
              .slice(0, n)
              .map((k) => {
                const id = k.slice(col.length + 1);
                return {
                  id,
                  exists: true,
                  data: () => savedDocs[k],
                  ref: makeRef(k, id),
                };
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
        update: (ref: any, data: any) => ref.update(data),
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
    delete: () => "MOCK_DELETE",
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

import { bumpOrderStatus } from "../src/modules/orders/orderStatus";
import { retryPendingShadowfaxReadySignals } from "../src/modules/dispatch/shadowfax.reconcile";
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

const caller = { uid: "staff_1", role: "branch_staff", branchIds: ["b1"] };

function seedPreparing(id: string, extra: Record<string, any> = {}) {
  savedDocs[`orders/${id}`] = {
    branchId: "b1",
    fulfillmentType: "delivery",
    status: { code: "PREPARING", label: "Preparing", kind: "in_progress", terminal: false },
    deliveryStatus: "dispatched",
    dispatchStatus: "dispatched",
    dispatchProvider: "shadowfax",
    dispatchOrderId: "21030620",
    shadowfaxOrderId: "21030620",
    // What the dispatcher actually sent as order_details.client_order_id.
    dispatchClientOrderId: "cr_0123456789abcdef_3",
    ...extra,
  };
}

function docOf(id: string): any {
  return savedDocs[`orders/${id}`];
}

describe("Shadowfax dispatch-ready on the KDS ready bump", () => {
  it("signals dispatch-ready for a Shadowfax order using the COID that was sent at booking", async () => {
    seedPreparing("ord_sfx_ready");
    fetchHandler = () => okJson({ message: "done successfully" });

    const res: any = await bumpOrderStatus({ orderId: "ord_sfx_ready", status: "ready", caller });

    expect(res.status).toMatchObject({ code: "READY_FOR_PICKUP" });
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe(
      "https://hlbackend.staging.shadowfax.in/api/v2/orders/cr_0123456789abcdef_3/dispatch-ready/"
    );
    expect(fetchCalls[0].init.method).toBe("PUT");
    expect(fetchCalls[0].init.headers.Authorization).toBe("Token your_api_token");
    const body = JSON.parse(fetchCalls[0].init.body);
    expect(Object.keys(body)).toEqual(["shipment_ready_timestamp"]);
    // Documented UTC date-time; the callback contract uses the same shape.
    expect(body.shipment_ready_timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
    expect(docOf("ord_sfx_ready").shadowfaxDispatchReady).toMatchObject({
      pending: false,
      clientOrderId: "cr_0123456789abcdef_3",
      timestamp: body.shipment_ready_timestamp,
    });
  });

  it("never blocks the kitchen when the provider call fails, and leaves the signal retryable", async () => {
    seedPreparing("ord_sfx_ready_fail");
    fetchHandler = () => okJson({ detail: "internal error" }, 500);

    const res: any = await bumpOrderStatus({ orderId: "ord_sfx_ready_fail", status: "ready", caller });

    // The KDS bump is the kitchen's write of record and MUST succeed.
    expect(res.status).toMatchObject({ code: "READY_FOR_PICKUP" });
    expect(docOf("ord_sfx_ready_fail").status).toMatchObject({ code: "READY_FOR_PICKUP" });
    expect(docOf("ord_sfx_ready_fail").shadowfaxDispatchReady).toMatchObject({
      pending: true,
      clientOrderId: "cr_0123456789abcdef_3",
    });
    expect(docOf("ord_sfx_ready_fail").shadowfaxDispatchReady.timestamp).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/
    );
    expect(docOf("ord_sfx_ready_fail").shadowfaxDispatchReady.lastError).toMatch(/HTTP 500/);
  });

  it("retries a pending signal with the SAME timestamp (never a fresh one)", async () => {
    seedPreparing("ord_sfx_ready_retry", {
      shadowfaxDispatchReady: {
        pending: true,
        clientOrderId: "cr_0123456789abcdef_3",
        timestamp: "2026-11-02T05:10:00.000Z",
        attempts: 1,
        lastError: "shadowfax HTTP 500 (transient): internal error",
      },
    });
    fetchHandler = () => okJson({ message: "done successfully" });

    const res = await retryPendingShadowfaxReadySignals();

    expect(res.retriedCount).toBe(1);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe(
      "https://hlbackend.staging.shadowfax.in/api/v2/orders/cr_0123456789abcdef_3/dispatch-ready/"
    );
    expect(JSON.parse(fetchCalls[0].init.body)).toEqual({
      shipment_ready_timestamp: "2026-11-02T05:10:00.000Z",
    });
    expect(docOf("ord_sfx_ready_retry").shadowfaxDispatchReady).toMatchObject({
      pending: false,
      timestamp: "2026-11-02T05:10:00.000Z",
    });
  });

  it("keeps a failed retry pending and counts the attempt", async () => {
    seedPreparing("ord_sfx_ready_retry_fail", {
      shadowfaxDispatchReady: {
        pending: true,
        clientOrderId: "cr_0123456789abcdef_3",
        timestamp: "2026-11-02T05:10:00.000Z",
        attempts: 2,
        lastError: "shadowfax HTTP 500 (transient): internal error",
      },
    });
    fetchHandler = () => okJson({ detail: "internal error" }, 503);

    const res = await retryPendingShadowfaxReadySignals();

    expect(res.retriedCount).toBe(0);
    expect(res.failedCount).toBe(1);
    expect(docOf("ord_sfx_ready_retry_fail").shadowfaxDispatchReady).toMatchObject({
      pending: true,
      attempts: 3,
      timestamp: "2026-11-02T05:10:00.000Z",
    });
  });

  it("makes no provider call for a Borzo order", async () => {
    seedPreparing("ord_borzo_ready", {
      dispatchProvider: "borzo",
      dispatchOrderId: "BRZ-ORD-9",
      borzoOrderId: "BRZ-ORD-9",
      shadowfaxOrderId: null,
      dispatchClientOrderId: undefined,
    });

    await bumpOrderStatus({ orderId: "ord_borzo_ready", status: "ready", caller });

    expect(fetchCalls).toHaveLength(0);
    expect(docOf("ord_borzo_ready").shadowfaxDispatchReady).toBeUndefined();
  });

  it("makes no provider call when no Shadowfax booking exists yet", async () => {
    seedPreparing("ord_sfx_unbooked", {
      deliveryStatus: "ready",
      dispatchStatus: null,
      dispatchProvider: null,
      dispatchOrderId: null,
      shadowfaxOrderId: null,
      dispatchClientOrderId: null,
    });

    await bumpOrderStatus({ orderId: "ord_sfx_unbooked", status: "ready", caller });

    expect(fetchCalls).toHaveLength(0);
  });

  it("does not re-signal for the same booking once it succeeded", async () => {
    seedPreparing("ord_sfx_ready_once", {
      shadowfaxDispatchReady: {
        pending: false,
        clientOrderId: "cr_0123456789abcdef_3",
        timestamp: "2026-11-02T05:00:00.000Z",
        sentAtBookingId: "21030620",
      },
    });
    fetchHandler = () => okJson({ message: "done successfully" });

    await bumpOrderStatus({ orderId: "ord_sfx_ready_once", status: "ready", caller });

    expect(fetchCalls).toHaveLength(0);
  });

  it("never signals on a non-ready bump", async () => {
    seedPreparing("ord_sfx_preparing");
    fetchHandler = () => okJson({ message: "done successfully" });

    await bumpOrderStatus({ orderId: "ord_sfx_preparing", status: "preparing", caller });

    expect(fetchCalls).toHaveLength(0);
  });

  it("falls back to the deterministic correlation token for an order booked before dispatchClientOrderId existed", async () => {
    seedPreparing("ord_sfx_legacy", {
      dispatchClientOrderId: null,
      dispatchGeneration: 3,
    });
    fetchHandler = () => okJson({ message: "done successfully" });

    await bumpOrderStatus({ orderId: "ord_sfx_legacy", status: "ready", caller });

    expect(fetchCalls).toHaveLength(1);
    // cr_<sha256(orderId:gen) first 16 hex>_<gen> — the exact COID minted at
    // booking time, recomputed instead of guessed.
    expect(fetchCalls[0].url).toMatch(
      /^https:\/\/hlbackend\.staging\.shadowfax\.in\/api\/v2\/orders\/cr_[0-9a-f]{16}_3\/dispatch-ready\/$/
    );
  });
});
