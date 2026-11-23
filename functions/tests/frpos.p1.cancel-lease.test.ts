import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";

/**
 * P1 — a POS cancel that was claimed and then interrupted must not be stranded
 * in `processing` forever. The worker has to reclaim EXPIRED processing leases,
 * and a provider acknowledgement may only be persisted by the instance that
 * still owns the lease (a late success must not clobber a newer claim).
 */
const h = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  const state = { enabled: true, beforeFence: null as null | (() => void) };

  const makeRef = (path: string, id: string): any => ({
    id,
    get: vi.fn(async () => ({
      id,
      exists: savedDocs[path] !== undefined,
      data: () => savedDocs[path],
      ref: makeRef(path, id),
    })),
    set: vi.fn(async (data: any, opts?: any) => {
      savedDocs[path] = opts?.merge ? { ...(savedDocs[path] || {}), ...data } : { ...data };
    }),
    update: vi.fn(async (data: any) => {
      if (savedDocs[path] === undefined) throw new Error(`No document to update: ${path}`);
      savedDocs[path] = { ...savedDocs[path], ...data };
    }),
  });

  const mockDb: any = {
    collection: (col: string) => ({
      doc: (id: string) => makeRef(`${col}/${id}`, id),
      where: (field: string, op: string, value: any) => ({
        limit: (n: number) => ({
          get: async () =>
            ({
              docs: Object.keys(savedDocs)
                .filter((k) => k.startsWith(`${col}/`))
                .filter((k) => {
                  const actual = savedDocs[k]?.[field];
                  if (op === "==") return actual === value;
                  if (op === "<=") return Number(actual) <= Number(value);
                  return false;
                })
                .slice(0, n)
                .map((k) => {
                  const id = k.slice(col.length + 1);
                  return { id, exists: true, data: () => savedDocs[k], ref: makeRef(k, id) };
                }),
              empty: false,
            } as any),
        }),
      }),
    }),
    runTransaction: async (fn: any) => {
      // Test hook: simulate a competing instance taking over the lease just
      // before a result write's transactional re-check runs.
      if (h.state.beforeFence) {
        const hook = h.state.beforeFence;
        h.state.beforeFence = null;
        hook();
      }
      return fn({
        get: (ref: any) => ref.get(),
        set: (ref: any, data: any, opts?: any) => ref.set(data, opts),
        update: (ref: any, data: any) => ref.update(data),
      });
    },
  };
  return { savedDocs, state, mockDb };
});
const { savedDocs, state, mockDb } = h;

vi.mock("firebase-admin", () => {
  const FieldValue = {
    serverTimestamp: () => "MOCK_TS",
    increment: (n: number) => n,
    arrayUnion: (i: any) => [i],
    delete: () => "MOCK_DELETE",
  };
  const firestoreFn: any = vi.fn(() => h.mockDb);
  firestoreFn.FieldValue = FieldValue;
  firestoreFn.Timestamp = { fromMillis: (ms: number) => ms };
  return {
    default: { firestore: firestoreFn, auth: vi.fn(), messaging: vi.fn(), initializeApp: vi.fn(), apps: [{ name: "mock" }] },
    firestore: firestoreFn,
    auth: vi.fn(),
    messaging: vi.fn(),
    initializeApp: vi.fn(),
    apps: [{ name: "mock" }],
  };
});
vi.mock("../src/modules/petpooja/client", async (importOriginal) => {
  const actual: any = await importOriginal();
  return { ...actual, isPetpoojaEnabled: () => state.enabled };
});
vi.mock("../src/modules/notifications/fcm.service", () => ({
  dispatchFCM: vi.fn(async () => true),
}));
vi.mock("../src/core/errors", async (importOriginal) => {
  const actual: any = await importOriginal();
  return { ...actual, captureErrorSnapshot: vi.fn(async () => "err") };
});

import {
  PETPOOJA_CANCEL_OPEN_STATUSES,
  PETPOOJA_CANCEL_CLAIM_TTL_MS,
  recordPosCancelSuccessIfOwned,
  retryPendingPetpoojaOrderCancelsWorker,
} from "../src/modules/petpooja/orderCancel";

const ACK = {
  ok: true,
  message: "Order status updated successfully.",
  posOrderId: "",
};

const originalFetch = globalThis.fetch;
let fetchCalls = 0;
beforeAll(() => {
  globalThis.fetch = vi.fn(async () => {
    fetchCalls++;
    return new Response(
      JSON.stringify({
        success: "1",
        message: "Order status updated successfully.",
        restID: "31z58ciw0h",
        clientOrderID: "ord_pushed",
        orderID: "",
        status: "-1",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }) as any;
});
afterAll(() => {
  globalThis.fetch = originalFetch;
});

beforeEach(() => {
  for (const k of Object.keys(savedDocs)) delete savedDocs[k];
  fetchCalls = 0;
  state.enabled = true;
  state.beforeFence = null;
  savedDocs["branches/b1"] = { id: "b1", petpoojaStoreId: "31z58ciw0h" };
});

function seedLeasedOrder(id: string, claimedAtMs: number, extra: Record<string, any> = {}) {
  savedDocs[`orders/${id}`] = {
    id,
    branchId: "b1",
    petpoojaOrderId: "pos_123",
    petpoojaStatus: "synced",
    // r2 P1: the cancel claim only accepts an already-cancelled order.
    status: { code: "CANCELLED", label: "Cancelled", kind: "cancelled", terminal: true },
    petpoojaCancelStatus: "processing",
    petpoojaCancelClaimedAt: claimedAtMs,
    petpoojaCancelReasonClass: "order_cancelled",
    petpoojaCancelAttemptCount: 1,
    petpoojaCancelNextRetryAtMs: null,
    ...extra,
  };
}

describe("P1 — reclaim leases and fence result writes", () => {
  it("the worker scans processing rows so an interrupted lease can be reclaimed", () => {
    expect(Array.from(PETPOOJA_CANCEL_OPEN_STATUSES)).toContain("processing");
  });

  it("reclaims an expired processing lease and converges to cancelled", async () => {
    seedLeasedOrder("ord_leased", Date.now() - PETPOOJA_CANCEL_CLAIM_TTL_MS - 1000);

    const result = await retryPendingPetpoojaOrderCancelsWorker();

    expect(fetchCalls).toBe(1);
    expect(savedDocs["orders/ord_leased"].petpoojaCancelStatus).toBe("cancelled");
    expect(result.cancelledCount).toBeGreaterThanOrEqual(1);
  });

  it("does not steal a processing row whose lease is still live", async () => {
    seedLeasedOrder("ord_live", Date.now());

    await retryPendingPetpoojaOrderCancelsWorker();

    expect(fetchCalls).toBe(0);
    expect(savedDocs["orders/ord_live"].petpoojaCancelStatus).toBe("processing");
  });

  it("fences the acknowledgement to the claimed lease — a lost lease cannot write cancelled", async () => {
    const claimedAt = Date.now() - 10000;
    seedLeasedOrder("ord_fenced", claimedAt);
    // A newer instance took over the lease just before the old ack landed.
    state.beforeFence = () => {
      savedDocs["orders/ord_fenced"].petpoojaCancelClaimedAt = claimedAt + 5000;
    };

    const recorded = await recordPosCancelSuccessIfOwned("ord_fenced", ACK, claimedAt);

    expect(recorded).toBe("skipped");
    expect(savedDocs["orders/ord_fenced"].petpoojaCancelStatus).toBe("processing");
    expect(savedDocs["orders/ord_fenced"].petpoojaCancelClaimedAt).toBe(claimedAt + 5000);
  });

  it("records the acknowledgement when the lease is still ours", async () => {
    const claimedAt = Date.now() - 1000;
    seedLeasedOrder("ord_owned", claimedAt);

    const recorded = await recordPosCancelSuccessIfOwned("ord_owned", ACK, claimedAt);

    expect(recorded).toBe("recorded");
    expect(savedDocs["orders/ord_owned"].petpoojaCancelStatus).toBe("cancelled");
  });
});
