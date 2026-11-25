import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";

/**
 * A8-4 (preprod audit c11, package F7) — the Porter poller must not overwrite a
 * NEWER terminal / rebooked state with a stale GET result.
 *
 * The worker held a doc snapshot, performed a GET with a 15s abort, then wrote
 * `status` / `deliveryStatus` with a plain merge set. A DELIVERED webhook (or a
 * carrier cancel + auto-rebook to another provider) landing during the GET was
 * silently overwritten with `in_transit`. Shadowfax's poller already re-reads in
 * a transaction and checks provider + booking id + terminal state; Porter had
 * none of those checks.
 *
 * The provider GET is stubbed — no courier traffic.
 */

const { mockDb, savedDocs, state } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  const state = {
    /** Applied right before the poller's fresh transactional read. */
    onFreshRead: null as null | (() => void),
    writes: [] as Array<{ path: string; data: any }>,
  };
  const write = (path: string, data: any, merge?: boolean) => {
    state.writes.push({ path, data });
    savedDocs[path] = merge ? { ...(savedDocs[path] || {}), ...data } : { ...data };
  };
  // A real QueryDocumentSnapshot carries `.ref`; the poller's fresh-read fence
  // reads through it, so the shim must model that shape.
  const makeRef: any = (path: string, id: string) => {
    const ref: any = {
      id,
      __path: path,
      get: vi.fn(async () => {
        if (state.onFreshRead) state.onFreshRead();
        return {
          id,
          ref,
          exists: savedDocs[path] !== undefined,
          data: () => savedDocs[path],
        };
      }),
      set: vi.fn(async (data: any, opts?: any) => write(path, data, opts?.merge)),
      update: vi.fn(async (data: any) => write(path, data, true)),
    };
    return ref;
  };
  const mockDb: any = {
    collection: (col: string) => ({
      doc: (id: string) => makeRef(`${col}/${id}`, id),
      where: () => ({
        limit: (n: number) => ({
          get: async () => {
            const docs = Object.keys(savedDocs)
              .filter((k) => k.startsWith(`${col}/`))
              .map((k) => {
                const ref = makeRef(k, k.slice(col.length + 1));
                return {
                  id: ref.id,
                  ref,
                  exists: true,
                  data: () => savedDocs[k],
                };
              })
              .slice(0, n);
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
  state.onFreshRead = null;
  state.writes.length = 0;
  fetchCalls = [];
  fetchHandler = null;
  savedCfg = { porter: { ...config.porter }, mock: { ...config.mock } };
  config.porter.enabled = true;
  config.porter.apiKey = "test_porter_key";
  config.porter.baseUrl = "https://api.porter.in";
  config.mock.porterDispatch = false;
});

afterEach(() => {
  config.porter = savedCfg.porter;
  config.mock = savedCfg.mock;
});

function seedOrder(id: string, extra: Record<string, any> = {}) {
  savedDocs[`orders/${id}`] = {
    branchId: "branch_ahmedabad_1",
    deliveryStatus: "dispatched",
    dispatchProvider: "porter",
    dispatchStatus: "dispatched",
    porterOrderId: "POR-555",
    updatedAt: { toMillis: () => Date.now() - 20 * 60 * 1000 },
    ...extra,
  };
}

const startedDelivery = () => ({
  status: "STARTED_DELIVERY",
  driver_details: { name: "Ravi", phone: "9000000001" },
});

describe("A8-4 Porter poller fences a stale GET", () => {
  it("does not regress a DELIVERED order that a webhook closed during the GET", async () => {
    seedOrder("ord_porter_stale_terminal");
    state.onFreshRead = () => {
      savedDocs["orders/ord_porter_stale_terminal"] = {
        ...savedDocs["orders/ord_porter_stale_terminal"],
        deliveryStatus: "delivered",
        status: { code: "DELIVERED", label: "Delivered", kind: "completed", terminal: true },
        deliveredAt: "MOCK_TIMESTAMP",
      };
    };
    fetchHandler = () => okJson(startedDelivery());

    const res = await pollActivePorterOrdersWorker();

    const doc = savedDocs["orders/ord_porter_stale_terminal"];
    expect(doc.deliveryStatus).toBe("delivered");
    expect(doc.status).toMatchObject({ code: "DELIVERED", terminal: true });
    // No write may carry the poller's in_transit patch for this order.
    const statusWrites = state.writes.filter(
      (w) => w.path === "orders/ord_porter_stale_terminal" && w.data.deliveryStatus
    );
    expect(statusWrites).toHaveLength(0);
    // Polled, not "updated": the answer is honest.
    expect(res.updatedCount).toBe(0);
  });

  it("does not write onto an order rebooked to another provider during the GET", async () => {
    seedOrder("ord_porter_stale_rebook");
    state.onFreshRead = () => {
      savedDocs["orders/ord_porter_stale_rebook"] = {
        ...savedDocs["orders/ord_porter_stale_rebook"],
        deliveryStatus: "dispatched",
        dispatchProvider: "shadowfax",
        dispatchOrderId: "21030620",
        shadowfaxOrderId: "21030620",
        porterOrderId: null,
      };
    };
    fetchHandler = () => okJson(startedDelivery());

    const res = await pollActivePorterOrdersWorker();

    const doc = savedDocs["orders/ord_porter_stale_rebook"];
    expect(doc.dispatchProvider).toBe("shadowfax");
    expect(doc.deliveryStatus).toBe("dispatched");
    expect(doc.riderName).toBeUndefined();
    const statusWrites = state.writes.filter(
      (w) => w.path === "orders/ord_porter_stale_rebook" && w.data.deliveryStatus
    );
    expect(statusWrites).toHaveLength(0);
    expect(res.updatedCount).toBe(0);
  });

  it("does not write when the Porter booking id no longer matches", async () => {
    seedOrder("ord_porter_stale_id");
    state.onFreshRead = () => {
      savedDocs["orders/ord_porter_stale_id"] = {
        ...savedDocs["orders/ord_porter_stale_id"],
        porterOrderId: "POR-999",
      };
    };
    fetchHandler = () => okJson(startedDelivery());

    await pollActivePorterOrdersWorker();

    const doc = savedDocs["orders/ord_porter_stale_id"];
    expect(doc.deliveryStatus).toBe("dispatched");
    expect(doc.riderName).toBeUndefined();
  });

  it("still applies a genuinely fresh status (no blanket refusal)", async () => {
    seedOrder("ord_porter_fresh_ok");
    fetchHandler = () => okJson(startedDelivery());

    const res = await pollActivePorterOrdersWorker();

    const doc = savedDocs["orders/ord_porter_fresh_ok"];
    expect(doc.deliveryStatus).toBe("in_transit");
    expect(doc.riderName).toBe("Ravi");
    expect(doc.porterPollCount).toBe(0);
    expect(res.updatedCount).toBe(1);
  });

  it("still closes the order on a polled DELIVERED", async () => {
    seedOrder("ord_porter_plain_delivered", { deliveryStatus: "in_transit" });
    fetchHandler = () =>
      okJson({ status: "DELIVERED", driver_details: { name: "Ravi", phone: "9000000001" } });

    await pollActivePorterOrdersWorker();

    const doc = savedDocs["orders/ord_porter_plain_delivered"];
    expect(doc.deliveryStatus).toBe("delivered");
    expect(doc.status).toMatchObject({ code: "DELIVERED", terminal: true });
  });
});
