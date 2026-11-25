import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";

/**
 * A8-7 (preprod audit c11, package F7) — the pollers and the cancel-retry scan
 * must not cap the QUERY at 25 rows before filtering.
 *
 * Both pollers fetched `.limit(25)` on `deliveryStatus in [dispatched,
 * in_transit]` and only then filtered for provider + 15-minute staleness. In a
 * fleet with more than 25 active deliveries, a stale order outside that first
 * page was never polled, never advanced its poll count, and never reached its
 * dead-letter escalation. `retryPendingShadowfaxCancels` had the same shape: 25
 * `state: "pending"` rows, with staff-cancelled rows skipped AFTER the limit, so
 * order-cancelled retries queued behind them were deferred indefinitely.
 *
 * The fix pages through the whole active/pending set with a document cursor and
 * only THEN filters, so no row can hide behind 25 others. Provider calls stay
 * bounded per tick; the SCAN is what must not be truncated.
 *
 * Provider GETs are stubbed — no courier traffic.
 */

const { mockDb, savedDocs, state } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  const state = { polledPaths: [] as string[] };

  // A Firestore-shaped query: filters, a limit, and a document-id cursor.
  const makeQuery = (col: string, filters: Array<[string, string, any]>, limit?: number, after?: string) => ({
    __kind: "query" as const,
    col,
    filters,
    limit,
    after,
    where: (field: string, op: string, value: any) =>
      makeQuery(col, [...filters, [field, op, value]], limit, after),
    limit: (n: number) => makeQuery(col, filters, n, after),
    startAfter: (cursor: any) =>
      makeQuery(col, filters, limit, typeof cursor === "string" ? cursor : cursor?.id),
    get: async () => {
      const matches = (doc: any) => {
        for (const [field, op, value] of filters) {
          const actual = field.split(".").reduce((acc: any, k: string) => acc?.[k], doc);
          if (op === "==" && actual !== value) return false;
          if (op === "in" && !(Array.isArray(value) && value.includes(actual))) return false;
        }
        return true;
      };
      const ids = Object.keys(savedDocs)
        .filter((k) => k.startsWith(`${col}/`))
        .filter((k) => matches(savedDocs[k]))
        .map((k) => k.slice(col.length + 1))
        // Implicit document-id ordering, exactly like an orderBy-free Firestore
        // query (which is what startAfter(snapshot) cursors against).
        .sort();
      const start = after ? ids.findIndex((id) => id === after) + 1 : 0;
      const sliced = ids.slice(start, limit ? start + limit : undefined);
      return {
        empty: sliced.length === 0,
        docs: sliced.map((id) => makeQuerySnapshot(`${col}/${id}`, id)),
        size: sliced.length,
      };
    },
  });

  const write = (path: string, data: any, merge?: boolean) => {
    savedDocs[path] = merge ? { ...(savedDocs[path] || {}), ...data } : { ...data };
  };
  const makeRef = (path: string, id: string) => {
    const ref: any = {
      id,
      __path: path,
      get: vi.fn(async () => ({
        id,
        ref,
        exists: savedDocs[path] !== undefined,
        data: () => savedDocs[path],
      })),
      set: vi.fn(async (data: any, opts?: any) => write(path, data, opts?.merge)),
    };
    return ref;
  };

  // A QueryDocumentSnapshot is what the cursor scan receives: `.id`, `.ref`
  // and `.data()`. The pollers read through `snapshot.ref`, so the shim must
  // carry it (a bare DocumentReference would silently no-op the scan).
  const makeQuerySnapshot = (path: string, id: string) => {
    const ref = makeRef(path, id);
    return { id, ref, exists: savedDocs[path] !== undefined, data: () => savedDocs[path] };
  };

  const mockDb: any = {
    collection: (col: string) => ({
      doc: (id: string) => makeRef(`${col}/${id}`, id),
      where: (field: string, op: string, value: any) => makeQuery(col, [[field, op, value]]),
      limit: (n: number) => makeQuery(col, [], n),
    }),
    runTransaction: vi.fn(async (fn: any) =>
      fn({ get: (ref: any) => ref.get(), set: (ref: any, d: any, o?: any) => ref.set(d, o) })
    ),
  };
  return { mockDb, savedDocs, state };
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

vi.mock("../src/core/errors", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/errors")>();
  return { ...actual, captureErrorSnapshot: vi.fn(async () => "err_test_snapshot") };
});

vi.mock("../src/modules/notifications/fcm.service", () => ({
  dispatchFCM: vi.fn(async () => true),
}));

import { pollActiveShadowfaxOrdersWorker, retryPendingShadowfaxCancels } from "../src/modules/dispatch/shadowfax.reconcile";
import { pollActivePorterOrdersWorker } from "../src/modules/porter/porter.service";
import { config } from "../src/config/env";

const okJson = (data: any, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const originalFetch = globalThis.fetch;
let fetchCalls: Array<{ url: string; init: any }> = [];
let fetchHandler: ((url: string, init: any) => Response) | null = null;
let savedCfg: any;

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
  state.polledPaths.length = 0;
  fetchCalls = [];
  fetchHandler = null;
  savedCfg = {
    shadowfax: { ...config.shadowfax },
    porter: { ...config.porter },
    mock: { ...config.mock },
  };
  config.shadowfax.apiKey = "your_api_token";
  config.shadowfax.baseUrl = "https://hlbackend.staging.shadowfax.in";
  config.shadowfax.clientCode = "merchant001";
  config.mock.shadowfaxDispatch = false;
  config.porter.enabled = true;
  config.porter.apiKey = "test_porter_key";
  config.porter.baseUrl = "https://api.porter.in";
  config.mock.porterDispatch = false;
});

afterEach(() => {
  config.shadowfax = savedCfg.shadowfax;
  config.porter = savedCfg.porter;
  config.mock = savedCfg.mock;
});

const STALE = () => ({ toMillis: () => Date.now() - 40 * 60 * 1000 });
const FRESH = () => ({ toMillis: () => Date.now() });

/** 30 FRESH active rows (ids sort before `ord_…_zzz`) then one stale target. */
function seedShadowfaxFleet(staleId: string, stale: Record<string, any> = {}) {
  for (let i = 0; i < 30; i += 1) {
    const id = `a_fresh_${String(i).padStart(2, "0")}`;
    savedDocs[`orders/${id}`] = {
      branchId: "branch_ahmedabad_1",
      deliveryStatus: "dispatched",
      dispatchStatus: "dispatched",
      dispatchProvider: "shadowfax",
      dispatchOrderId: "21030620",
      shadowfaxOrderId: "21030620",
      updatedAt: FRESH(),
    };
  }
  savedDocs[`orders/${staleId}`] = {
    branchId: "branch_ahmedabad_1",
    deliveryStatus: "dispatched",
    dispatchStatus: "dispatched",
    dispatchProvider: "shadowfax",
    dispatchOrderId: "21039999",
    shadowfaxOrderId: "21039999",
    updatedAt: STALE(),
    ...stale,
  };
}

describe("A8-7 no order starves behind the first 25 active rows", () => {
  it("Shadowfax poller reaches a stale order that sits after 30 fresh rows", async () => {
    seedShadowfaxFleet("ord_sfx_deep");
    fetchHandler = () =>
      okJson({
        message: "ok",
        data: { client_code: "merchant001", status: "DISPATCHED", sfx_order_id: 21039999 },
      });

    await pollActiveShadowfaxOrdersWorker();

    expect(fetchCalls.map((c) => c.url)).toContain(
      "https://hlbackend.staging.shadowfax.in/api/v2/orders/21039999/status/"
    );
    expect(savedDocs["orders/ord_sfx_deep"].deliveryStatus).toBe("in_transit");
  });

  it("Porter poller reaches a stale order that sits after 30 fresh rows", async () => {
    for (let i = 0; i < 30; i += 1) {
      const id = `a_pf_${String(i).padStart(2, "0")}`;
      savedDocs[`orders/${id}`] = {
        branchId: "branch_ahmedabad_1",
        deliveryStatus: "dispatched",
        dispatchProvider: "porter",
        dispatchStatus: "dispatched",
        porterOrderId: `POR-F-${i}`,
        updatedAt: FRESH(),
      };
    }
    savedDocs["orders/ord_porter_deep"] = {
      branchId: "branch_ahmedabad_1",
      deliveryStatus: "dispatched",
      dispatchProvider: "porter",
      dispatchStatus: "dispatched",
      porterOrderId: "POR-DEEP",
      updatedAt: STALE(),
    };
    fetchHandler = (url) =>
      url.includes("POR-DEEP")
        ? okJson({ status: "STARTED_DELIVERY", driver_details: { name: "Ravi", phone: "9000000001" } })
        : okJson({ status: "ASSIGNED" });

    await pollActivePorterOrdersWorker();

    expect(fetchCalls.some((c) => c.url.includes("POR-DEEP"))).toBe(true);
    expect(savedDocs["orders/ord_porter_deep"].deliveryStatus).toBe("in_transit");
  });

  it("Shadowfax cancel-retry reaches an order_cancelled row hidden behind 30 staff rows", async () => {
    for (let i = 0; i < 30; i += 1) {
      const id = `a_staff_${String(i).padStart(2, "0")}`;
      savedDocs[`orders/${id}`] = {
        branchId: "branch_ahmedabad_1",
        deliveryStatus: "dispatched",
        dispatchProvider: "shadowfax",
        dispatchOrderId: "21030620",
        dispatchPendingCancel: {
          provider: "shadowfax",
          providerOrderId: "21030620",
          reason: "staff_cancelled",
          state: "pending",
          providerCanCancel: true,
          requestedAt: "MOCK_TIMESTAMP",
          requestedBy: "Branch Staff",
          attempts: 0,
          lastAttemptAt: null,
          lastError: null,
          confirmedAt: null,
          confirmedBy: null,
          confirmedByName: null,
          confirmedNote: null,
          staffActionRequired: null,
        },
      };
    }
    savedDocs["orders/ord_sfx_retry_deep"] = {
      branchId: "branch_ahmedabad_1",
      deliveryStatus: "dispatched",
      dispatchProvider: "shadowfax",
      dispatchOrderId: "21038888",
      dispatchPendingCancel: {
        provider: "shadowfax",
        providerOrderId: "21038888",
        reason: "order_cancelled",
        state: "pending",
        providerCanCancel: true,
        requestedAt: "MOCK_TIMESTAMP",
        requestedBy: "customer:cust_a",
        attempts: 1,
        lastAttemptAt: null,
        lastError: "shadowfax HTTP 500",
        confirmedAt: null,
        confirmedBy: null,
        confirmedByName: null,
        confirmedNote: null,
        staffActionRequired: null,
      },
    };
    fetchHandler = () => okJson({ message: "done successfully" });

    const result = await retryPendingShadowfaxCancels();

    expect(result.retriedCount).toBe(1);
    expect(fetchCalls.map((c) => c.url)).toContain(
      "https://hlbackend.staging.shadowfax.in/api/v2/orders/21038888/cancel/"
    );
    expect(
      savedDocs["orders/ord_sfx_retry_deep"].dispatchPendingCancel.state
    ).toBe("confirmed");
    // The staff rows are still skipped: only a human can confirm those.
    expect(fetchCalls).toHaveLength(1);
  });

  it("keeps the per-tick provider-call budget (no unbounded fan-out)", async () => {
    // 40 stale Porter orders: the scan must see all of them, and the tick must
    // still bound how many provider GETs it makes.
    for (let i = 0; i < 40; i += 1) {
      const id = `a_ps_${String(i).padStart(2, "0")}`;
      savedDocs[`orders/${id}`] = {
        branchId: "branch_ahmedabad_1",
        deliveryStatus: "dispatched",
        dispatchProvider: "porter",
        dispatchStatus: "dispatched",
        porterOrderId: `POR-S-${i}`,
        updatedAt: STALE(),
      };
    }
    fetchHandler = () => okJson({ status: "ASSIGNED" });

    await pollActivePorterOrdersWorker();

    expect(fetchCalls.length).toBeLessThanOrEqual(25);
    expect(fetchCalls.length).toBeGreaterThan(0);
  });
});
