import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";

/**
 * A8-2 (preprod audit c11, package F7) — a Shadowfax cancellation observed by
 * POLLING must contain the order exactly like a webhook cancellation does.
 *
 * The webhook path (`dispatch.webhooks.ts` RIDER_CANCELLED) parks the order
 * `deliveryStatus: "needs_review"` with `needsRebook: false` and a
 * `rebookTrigger`, plus a branch FCM alert. The poller only wrote one
 * `unmatched_dispatch_events` row and refreshed `updatedAt`, so the customer
 * tracker kept showing a live delivery that no longer existed, and the
 * refreshed timestamp reset the dead-letter clock so nothing escalated.
 *
 * Fixtures are schema-derived from the published OrderData body (no captured
 * vendor reply); the provider call is stubbed — no courier traffic.
 */

const { mockDb, savedDocs, state } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  const state = { fcmCalls: [] as any[], snapshots: [] as any[] };
  const write = (path: string, data: any, merge?: boolean) => {
    savedDocs[path] = merge ? { ...(savedDocs[path] || {}), ...data } : { ...data };
  };
  const makeSnap = (path: string, id: string) => ({
    id,
    exists: savedDocs[path] !== undefined,
    data: () => savedDocs[path],
    set: vi.fn(async (data: any, opts?: any) => write(path, data, opts?.merge)),
    ref: {
      id,
      get: vi.fn(async () => makeSnap(path, id)),
      set: vi.fn(async (data: any, opts?: any) => write(path, data, opts?.merge)),
    },
  });
  // A Firestore-shaped query honours the `in` filter and the document cursor;
  // a mock that returns every document regardless of the filter would "see" an
  // order the real query has already excluded (needs_review is not a polled leg).
  const matchesFilters = (doc: any, filters: Array<[string, string, any]>) => {
    for (const [field, op, value] of filters) {
      const actual = field.split(".").reduce((acc: any, k: string) => acc?.[k], doc);
      if (op === "==" && actual !== value) return false;
      if (op === "in" && !(Array.isArray(value) && value.includes(actual))) return false;
    }
    return true;
  };
  const makeQuery = (
    col: string,
    filters: Array<[string, string, any]>,
    limit?: number,
    after?: string
  ) => ({
    where: (field: string, op: string, value: any) =>
      makeQuery(col, [...filters, [field, op, value]], limit, after),
    limit: (n: number) => makeQuery(col, filters, n, after),
    startAfter: (cursor: any) =>
      makeQuery(col, filters, limit, typeof cursor === "string" ? cursor : cursor?.id),
    get: async () => {
      const ids = Object.keys(savedDocs)
        .filter((k) => k.startsWith(`${col}/`))
        .filter((k) => matchesFilters(savedDocs[k], filters))
        .map((k) => k.slice(col.length + 1))
        .sort();
      const start = after ? ids.findIndex((id) => id === after) + 1 : 0;
      const sliced = ids.slice(start, limit ? start + limit : undefined);
      return { empty: sliced.length === 0, docs: sliced.map((id) => makeSnap(`${col}/${id}`, id)) };
    },
  });
  const mockDb: any = {
    collection: (col: string) => ({
      doc: (id: string) => makeSnap(`${col}/${id}`, id),
      where: (field: string, op: string, value: any) => makeQuery(col, [[field, op, value]]),
    }),
    runTransaction: vi.fn(async (fn: any) =>
      fn({
        get: (ref: any) => ref.get(),
        set: (ref: any, data: any, opts?: any) => ref.set(data, opts),
      })
    ),
  };
  return { mockDb, savedDocs, state };
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
  return {
    ...actual,
    captureErrorSnapshot: vi.fn(async (snap: any) => {
      state.snapshots.push(snap);
      return "err_test_snapshot";
    }),
  };
});

vi.mock("../src/modules/notifications/fcm.service", () => ({
  dispatchFCM: vi.fn(async (params: any) => {
    state.fcmCalls.push(params);
    return true;
  }),
}));

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
  state.fcmCalls.length = 0;
  state.snapshots.length = 0;
  fetchCalls = [];
  fetchHandler = null;
  savedCfg = { shadowfax: { ...config.shadowfax }, mock: { ...config.mock } };
  config.shadowfax.apiKey = "your_api_token";
  config.shadowfax.baseUrl = "https://hlbackend.staging.shadowfax.in";
  config.shadowfax.clientCode = "merchant001";
  config.mock.shadowfaxDispatch = false;
});

afterEach(() => {
  config.shadowfax = savedCfg.shadowfax;
  config.mock = savedCfg.mock;
});

function cancelledBody(status = "CANCELLED") {
  return {
    message: "Order details fetched successfully",
    data: {
      client_code: "merchant001",
      status,
      sfx_order_id: 21030620,
      cancel_reason: 5,
      cancel_reason_text: "Operational Issue with order",
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
    riderName: "Aastha Jain",
    updatedAt: { toMillis: () => Date.now() - 40 * 60 * 1000 },
    ...extra,
  };
}

function docOf(id: string): any {
  return savedDocs[`orders/${id}`];
}

describe("A8-2 Shadowfax poll-observed cancellation is contained", () => {
  it("parks the order for review, stops the tracker, and alerts the branch", async () => {
    seedOrder("ord_sfx_poll_cancel");
    fetchHandler = () => okJson(cancelledBody("CANCELLED"));

    const res = await pollActiveShadowfaxOrdersWorker();

    const doc = docOf("ord_sfx_poll_cancel");
    // The delivery leg must stop claiming a live rider.
    expect(doc.deliveryStatus).toBe("needs_review");
    expect(doc.needsRebook).toBe(false);
    expect(doc.rebookTrigger).toBe("cancellation_unverified");
    expect(doc.delivery?.status).toBe("needs_review");
    // A human decides the rebook: the poller never buys a second rider.
    expect(doc.dispatchPendingCancel).toBeUndefined();
    // Staff are told, not left to notice.
    expect(state.fcmCalls).toHaveLength(1);
    expect(state.fcmCalls[0]).toMatchObject({
      topic: "branch_branch_ahmedabad_1_orders",
      purpose: "operational",
    });
    expect(state.fcmCalls[0].data?.type).toBe("dispatch_manual_review");
    expect(state.fcmCalls[0].data?.needsRebook).toBe("false");
    const high = state.snapshots.filter((s: any) => s?.severity === "high");
    expect(high.length).toBeGreaterThanOrEqual(1);
    // The evidence row is still parked for reconciliation.
    const parks = Object.keys(savedDocs).filter((k) => k.startsWith("unmatched_dispatch_events/"));
    expect(parks).toHaveLength(1);
    expect(res.polledCount).toBe(1);
  });

  it("does not refresh the staleness clock as if the poll were healthy", async () => {
    seedOrder("ord_sfx_poll_cancel_dark", {
      // 90 minutes of silence: close to the 2h dead-letter line.
      updatedAt: { toMillis: () => Date.now() - 90 * 60 * 1000 },
    });
    fetchHandler = () => okJson(cancelledBody("CANCELLED_BY_CUSTOMER"));

    await pollActiveShadowfaxOrdersWorker();

    const doc = docOf("ord_sfx_poll_cancel_dark");
    // A pull-observed cancellation is a WIND-DOWN, not a healthy heartbeat: the
    // only timestamp written is the poll marker, never `updatedAt` as a refresh
    // that would reset the dead-letter clock.
    expect(doc.updatedAt).toEqual({ toMillis: expect.any(Function) });
    expect(doc.shadowfaxPolledAt).toBe("MOCK_TIMESTAMP");
    expect(doc.deliveryStatus).toBe("needs_review");
  });

  it("is idempotent: a second poll sees the already-contained order and does not re-alert", async () => {
    seedOrder("ord_sfx_poll_cancel_twice");
    fetchHandler = () => okJson(cancelledBody("CANCELLED"));

    await pollActiveShadowfaxOrdersWorker();
    // The contained order is no longer in the polled legs, so the second tick
    // must not fetch or alert again.
    fetchCalls.length = 0;
    await pollActiveShadowfaxOrdersWorker();

    expect(fetchCalls).toHaveLength(0);
    expect(state.fcmCalls).toHaveLength(1);
    expect(docOf("ord_sfx_poll_cancel_twice").deliveryStatus).toBe("needs_review");
  });

  it("leaves a normal DISPATCHED pull alone (no false containment)", async () => {
    seedOrder("ord_sfx_poll_normal");
    fetchHandler = () =>
      okJson({
        message: "ok",
        data: { client_code: "merchant001", status: "DISPATCHED", sfx_order_id: 21030620 },
      });

    await pollActiveShadowfaxOrdersWorker();

    expect(docOf("ord_sfx_poll_normal").deliveryStatus).toBe("in_transit");
    expect(state.fcmCalls).toHaveLength(0);
    expect(state.snapshots).toHaveLength(0);
  });
});
