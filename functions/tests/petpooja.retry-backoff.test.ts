import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Petpooja KOT retry BACKOFF (defect: `petpooja.scheduler.ts` claimed
 * "exponential backoff" but ran a flat 5-minute retry loop).
 *
 * Pinned here, against the REAL worker and the REAL push path (only Firestore
 * and the network are faked):
 *
 *   - a failed push persists `petpoojaNextRetryAtMs` and the delay DOUBLES
 *     across attempts: 5m → 10m → 20m → 40m;
 *   - a `pending_retry` row that is not yet due is not claimed and not pushed;
 *   - a due row is pushed;
 *   - a 30-minute Petpooja outage does not dead-letter a paid order (the old
 *     flat schedule burned the whole budget, then dropped the order);
 *   - the attempt limit still dead-letters with its branch alert;
 *   - a legacy row (no timestamp) is due immediately;
 *   - not-yet-due rows cannot starve due rows out of the scan window;
 *   - overlapping ticks still send exactly ONE KOT.
 *
 * Real document shapes only: branches/{id}, products/{id}, orders/{id}.
 */

const { mockDb, savedDocs, hooks } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  const hooks = { fetchDelayMs: 0 };

  const docRef = (col: string, id: string) => {
    const path = `${col}/${id}`;
    return {
      id,
      path,
      get: vi.fn(async () => ({
        exists: Object.prototype.hasOwnProperty.call(savedDocs, path),
        id,
        data: () => savedDocs[path],
        ref: docRef(col, id),
      })),
      set: vi.fn(async (data: any, opts?: any) => {
        savedDocs[path] =
          opts?.merge && savedDocs[path] ? { ...savedDocs[path], ...data } : { ...data };
      }),
      update: vi.fn(async (data: any) => {
        if (!savedDocs[path]) throw new Error(`Document ${path} does not exist`);
        savedDocs[path] = { ...savedDocs[path], ...data };
      }),
    };
  };

  /**
   * Query fake with REAL cursor semantics: where / orderBy / limit /
   * startAfter. `createdAt` is a numeric fixture so ordering is deterministic.
   */
  const query = (
    col: string,
    filters: Array<{ field: string; value: any }>,
    sortField?: string,
    sortDir: "asc" | "desc" = "asc",
    limitCount?: number,
    afterId?: string
  ): any => ({
    where: (field: string, _op: string, value: any) =>
      query(col, [...filters, { field, value }], sortField, sortDir, limitCount, afterId),
    orderBy: (field: string, dir: "asc" | "desc" = "asc") =>
      query(col, filters, field, dir, limitCount, afterId),
    limit: (n: number) => query(col, filters, sortField, sortDir, n, afterId),
    startAfter: (doc: any) =>
      query(col, filters, sortField, sortDir, limitCount, typeof doc === "string" ? doc : doc?.id),
    get: async () => {
      let rows = Object.entries(savedDocs)
        .filter(([p]) => p.startsWith(`${col}/`))
        .map(([p, data]) => ({
          id: p.slice(col.length + 1),
          data,
          ref: docRef(col, p.slice(col.length + 1)),
        }))
        .filter((row) => filters.every((f) => row.data[f.field] === f.value));

      if (sortField) {
        rows = rows.sort((a, b) => {
          const va = a.data[sortField]?.toMillis?.() ?? a.data[sortField] ?? 0;
          const vb = b.data[sortField]?.toMillis?.() ?? b.data[sortField] ?? 0;
          if (va === vb) return a.id < b.id ? -1 : 1;
          return sortDir === "desc" ? vb - va : va - vb;
        });
      }
      if (afterId) {
        const at = rows.findIndex((r) => r.id === afterId);
        if (at >= 0) rows = rows.slice(at + 1);
      }
      if (typeof limitCount === "number") rows = rows.slice(0, limitCount);
      return {
        docs: rows.map((r) => ({ ...r, data: () => r.data })),
        empty: rows.length === 0,
      };
    },
  });

  // Firestore serializes conflicting transactions (one aborts/retries). The
  // fake does the equivalent: transactions run one at a time, in call order.
  let txChain: Promise<any> = Promise.resolve();

  const mockDb: any = {
    collection: (col: string) => ({
      doc: (id?: string) => docRef(col, id as string),
      where: (field: string, _op: string, value: any) => query(col, [{ field, value }]),
    }),
    getAll: async (...refs: any[]) => Promise.all(refs.map((r: any) => r.get())),
    runTransaction: (fn: any) => {
      const run = txChain.then(async () => {
        let hasWritten = false;
        return fn({
          get: async (ref: any) => {
            if (hasWritten) {
              throw new Error(
                "Firestore transactions require all reads to be executed before all writes."
              );
            }
            return ref.get();
          },
          set: async (ref: any, data: any, opts?: any) => {
            hasWritten = true;
            return ref.set(data, opts);
          },
          update: async (ref: any, data: any) => {
            hasWritten = true;
            return ref.update(data);
          },
        });
      });
      txChain = run.then(
        () => undefined,
        () => undefined
      );
      return run;
    },
  };

  return { mockDb, savedDocs, hooks };
});

vi.mock("../src/core/firebase", () => ({
  db: mockDb,
  auth: { verifyIdToken: vi.fn(async () => ({ uid: "staff_backoff" })) },
  messaging: { send: vi.fn(async () => "msg") },
}));

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

vi.mock("../src/modules/notifications/fcm.service", () => ({
  dispatchFCM: vi.fn(async () => true),
}));

import { pushOrderToPetpooja, resolvePetpoojaKotAmbiguity } from "../src/modules/petpooja/orderPush";
import { retryPendingPetpoojaOrdersWorker } from "../src/modules/petpooja/petpooja.scheduler";
import {
  PETPOOJA_MAX_RETRY_ATTEMPTS,
  PETPOOJA_RETRY_BACKOFF_MS,
} from "../src/modules/petpooja/retryBackoff";
import { dispatchFCM } from "../src/modules/notifications/fcm.service";
import { config } from "../src/config/env";

const BRANCH = "branch_backoff_1";
const PRODUCT = "prod_branch_backoff_1_7765862";
const MINUTE = 60_000;
const T0 = 1_700_000_000_000;

const fetchMock = vi.fn();
let prevMock: boolean;

function seedCatalog() {
  savedDocs[`branches/${BRANCH}`] = {
    name: "Backoff Outlet",
    petpoojaStoreId: "res_backoff_1",
    petpoojaTaxes: [
      { id: "3928", name: "CGST", rate: 2.5 },
      { id: "3929", name: "SGST", rate: 2.5 },
    ],
  };
  savedDocs[`products/${PRODUCT}`] = {
    id: PRODUCT,
    branchId: BRANCH,
    name: "Backoff Burger",
    price: 250,
    inStock: true,
    petpoojaItemId: "7765862",
  };
}

function seedOrder(id: string, extra: Record<string, any> = {}) {
  seedCatalog();
  savedDocs[`orders/${id}`] = {
    id,
    branchId: BRANCH,
    customerId: "cust_backoff",
    userId: "cust_backoff",
    fulfillment: "takeaway",
    paymentMethod: "cod",
    paymentStatus: "completed",
    customerName: "Backoff Customer",
    customerPhone: "+919825000333",
    items: [
      { id: "l1", productId: PRODUCT, name: "Backoff Burger", price: 250, quantity: 1 },
    ],
    pricing: { grandTotal: 250, gst: 11.9 },
    status: "pending",
    petpoojaStatus: "pending_retry",
    petpoojaSyncStatus: "pending_retry",
    petpoojaRetryCount: 0,
    createdAt: T0 - 60 * MINUTE,
    ...extra,
  };
}

/** A POS that ANSWERS and refuses: the only auto-retryable failure shape. */
function posRejection(status = 502) {
  return {
    ok: false,
    status,
    statusText: "Bad Gateway",
    json: async () => ({ success: "0", message: "Gateway down" }),
  };
}

function posAccepted(orderId: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ success: "1", message: "Your order is saved.", orderID: `pp_${orderId}` }),
  };
}

beforeEach(() => {
  for (const key of Object.keys(savedDocs)) delete savedDocs[key];
  hooks.fetchDelayMs = 0;
  prevMock = config.mock.petpoojaPos;
  config.mock.petpoojaPos = false; // live path; only fetch is stubbed
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => {
    if (hooks.fetchDelayMs > 0) await new Promise((r) => setTimeout(r, hooks.fetchDelayMs));
    return posAccepted("default");
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  vi.mocked(dispatchFCM).mockClear();
  vi.mocked(dispatchFCM).mockResolvedValue(true);
});

afterEach(() => {
  config.mock.petpoojaPos = prevMock;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Petpooja KOT retry backoff", () => {
  it("persists a next-retry time whose delay doubles across attempts", async () => {
    seedOrder("ord_backoff_doubling");
    const expectedMinutes = [5, 10, 20, 40];
    expect(PETPOOJA_RETRY_BACKOFF_MS).toEqual(expectedMinutes.map((m) => m * MINUTE));

    for (let attempt = 0; attempt < expectedMinutes.length; attempt++) {
      fetchMock.mockResolvedValueOnce(posRejection());
      const pushed = await pushOrderToPetpooja("ord_backoff_doubling");
      expect(pushed).toBe(false);

      const doc = savedDocs["orders/ord_backoff_doubling"];
      expect(doc.petpoojaStatus).toBe("pending_retry");
      expect(doc.petpoojaRetryCount).toBe(attempt + 1);
      expect(doc.petpoojaNextRetryAtMs).toBe(Date.now() + expectedMinutes[attempt] * MINUTE);

      // Move to exactly the scheduled moment (the scheduler's own cadence).
      vi.setSystemTime(doc.petpoojaNextRetryAtMs);
    }
  });

  it("does not claim or push a row that is not due yet", async () => {
    seedOrder("ord_not_due", {
      petpoojaRetryCount: 1,
      petpoojaNextRetryAtMs: T0 + 9 * MINUTE,
    });

    const tick = await retryPendingPetpoojaOrdersWorker();

    expect(tick).toEqual({ retriedCount: 0, failedCount: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
    const doc = savedDocs["orders/ord_not_due"];
    expect(doc.petpoojaStatus).toBe("pending_retry");
    expect(doc.petpoojaClaimedAt).toBeUndefined(); // never claimed
    expect(doc.petpoojaPushClaimedAt).toBeUndefined();
    expect(doc.petpoojaRetryCount).toBe(1);
  });

  it("pushes a row whose scheduled time has arrived", async () => {
    seedOrder("ord_due", {
      petpoojaRetryCount: 1,
      petpoojaNextRetryAtMs: T0 - 1,
    });
    fetchMock.mockResolvedValueOnce(posAccepted("pp_due"));

    const tick = await retryPendingPetpoojaOrdersWorker();

    expect(tick.retriedCount).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const doc = savedDocs["orders/ord_due"];
    expect(doc.petpoojaStatus).toBe("synced");
    expect(doc.petpoojaOrderId).toBe("pp_pp_due");
  });

  it("survives a 30-minute POS outage without dead-lettering a paid order", async () => {
    seedOrder("ord_outage");

    // The POS refuses for the whole outage. Every tick from T0 to T0+30m.
    fetchMock.mockImplementation(async () => posRejection(503));

    const snapshots: Array<{ at: number; retries: number; status: string }> = [];
    for (let minute = 0; minute <= 30; minute += 5) {
      vi.setSystemTime(T0 + minute * MINUTE);
      await retryPendingPetpoojaOrdersWorker();
      const doc = savedDocs["orders/ord_outage"];
      snapshots.push({
        at: minute,
        retries: doc.petpoojaRetryCount,
        status: doc.petpoojaStatus,
      });
    }

    // Never dead-lettered, still in the retry lane with a real budget left.
    for (const row of snapshots) {
      expect(row.status, `t+${row.at}m`).toBe("pending_retry");
    }
    const doc = savedDocs["orders/ord_outage"];
    expect(doc.kotSyncFailed).toBeUndefined();
    expect(doc.petpoojaRetryCount).toBeLessThanOrEqual(PETPOOJA_MAX_RETRY_ATTEMPTS);

    // Exactly the attempts the backoff allows in 30 minutes: T0, +5, +15.
    expect(fetchMock).toHaveBeenCalledTimes(3);

    // And it is still retryable afterwards — the food is not lost.
    vi.setSystemTime(T0 + 35 * MINUTE);
    fetchMock.mockResolvedValueOnce(posAccepted("pp_outage"));
    const tick = await retryPendingPetpoojaOrdersWorker();
    expect(tick.retriedCount).toBe(1);
    expect(savedDocs["orders/ord_outage"].petpoojaStatus).toBe("synced");
  });

  it("still dead-letters, with its branch alert, once the attempts are spent", async () => {
    seedOrder("ord_exhausted", {
      petpoojaRetryCount: PETPOOJA_MAX_RETRY_ATTEMPTS + 1,
      petpoojaNextRetryAtMs: T0 - 1,
    });

    const tick = await retryPendingPetpoojaOrdersWorker();

    expect(tick.failedCount).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled(); // no further KOT attempt
    const doc = savedDocs["orders/ord_exhausted"];
    expect(doc.petpoojaStatus).toBe("failed");
    expect(doc.kotSyncFailed).toBe(true);

    const alert = vi.mocked(dispatchFCM).mock.calls.find(
      (call) => call[0]?.data?.type === "kot_sync_failed"
    );
    expect(alert).toBeTruthy();
    expect(alert![0].topic).toBe(`branch_${BRANCH}_orders`);
    expect(alert![0].data?.orderId).toBe("ord_exhausted");
  });

  it("treats a legacy row with no next-retry timestamp as due immediately", async () => {
    seedOrder("ord_legacy", { petpoojaRetryCount: 1 });
    delete savedDocs["orders/ord_legacy"].petpoojaNextRetryAtMs;
    fetchMock.mockResolvedValueOnce(posAccepted("pp_legacy"));

    const tick = await retryPendingPetpoojaOrdersWorker();

    expect(tick.retriedCount).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(savedDocs["orders/ord_legacy"].petpoojaStatus).toBe("synced");
  });

  it("does not let not-yet-due rows hide due rows behind them", async () => {
    // 130 OLDER rows, all parked on a future retry time: the old
    // orderBy(createdAt).limit(100) window would have been entirely consumed
    // by them, so the due order below was never even looked at.
    for (let i = 0; i < 130; i++) {
      seedOrder(`ord_waiting_${String(i).padStart(3, "0")}`, {
        petpoojaRetryCount: 2,
        petpoojaNextRetryAtMs: T0 + 30 * MINUTE,
        createdAt: T0 - 600 * MINUTE + i,
      });
    }
    seedOrder("ord_due_behind", {
      petpoojaRetryCount: 1,
      petpoojaNextRetryAtMs: T0 - 1,
      createdAt: T0 - 60 * MINUTE,
    });
    fetchMock.mockResolvedValueOnce(posAccepted("pp_behind"));

    const tick = await retryPendingPetpoojaOrdersWorker();

    expect(tick.retriedCount).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(savedDocs["orders/ord_due_behind"].petpoojaStatus).toBe("synced");
    // Nothing that is not due was claimed or written.
    expect(savedDocs["orders/ord_waiting_000"].petpoojaStatus).toBe("pending_retry");
    expect(savedDocs["orders/ord_waiting_000"].petpoojaClaimedAt).toBeUndefined();
  });

  it("does not gate a staff-initiated retry behind the backoff", async () => {
    // Parked, ambiguous POST — the state `resolvePetpoojaKotAmbiguity` exists for.
    seedOrder("ord_staff_retry", {
      petpoojaStatus: "reconciliation_required",
      petpoojaSyncStatus: "reconciliation_required",
      petpoojaAmbiguousProcessing: true,
      kotSyncFailed: true,
      petpoojaRetryCount: 2,
      // A previous automatic failure left a future schedule on the row: the
      // staff decision must clear it, not inherit it.
      petpoojaNextRetryAtMs: T0 + 30 * MINUTE,
    });
    const staff = { uid: "staff_backoff", role: "branch_staff", branchIds: [BRANCH] };
    fetchMock.mockResolvedValueOnce(posAccepted("pp_staff"));

    const result = await resolvePetpoojaKotAmbiguity("ord_staff_retry", "retry", staff);
    expect(result).toMatchObject({ resolved: "retry" });

    // The decision parked one deliberate attempt and CLEARED the schedule, so
    // the very next worker tick (seconds later, not 30 minutes later) sends it.
    const parked = savedDocs["orders/ord_staff_retry"];
    expect(parked.petpoojaStatus).toBe("pending_retry");
    expect(parked.petpoojaNextRetryAtMs).toBeNull();

    const tick = await retryPendingPetpoojaOrdersWorker();
    expect(tick.retriedCount).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(savedDocs["orders/ord_staff_retry"].petpoojaStatus).toBe("synced");
    expect(savedDocs["orders/ord_staff_retry"].petpoojaOrderId).toBe("pp_pp_staff");
  });

  it("drains a staff retry that landed on the ambiguous-worker lane", async () => {
    // The same decision, but the push is handed to the worker (ambiguous lane
    // without an acceptance marker). The worker must claim it on THIS tick
    // instead of waiting out the leftover schedule.
    seedOrder("ord_staff_worker", {
      petpoojaStatus: "pending_retry",
      petpoojaRetryCount: 2,
      petpoojaNextRetryAtMs: T0 + 30 * MINUTE,
      petpoojaResolvedBy: "staff_backoff",
      petpoojaResolution: "retry",
    });
    // Simulate the staff write clearing the schedule (what the code does).
    savedDocs["orders/ord_staff_worker"].petpoojaNextRetryAtMs = null;
    fetchMock.mockResolvedValueOnce(posAccepted("pp_staff_worker"));

    const tick = await retryPendingPetpoojaOrdersWorker();

    expect(tick.retriedCount).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(savedDocs["orders/ord_staff_worker"].petpoojaStatus).toBe("synced");
  });

  it("never sends the same KOT twice when two ticks overlap", async () => {    // Real timers: this test needs a genuinely in-flight POST, so the second
    // tick starts while the first one is parked inside fetch().
    vi.useRealTimers();
    seedOrder("ord_overlap");

    let release: (() => void) | null = null;
    fetchMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve(posAccepted("pp_overlap"));
        })
    );

    const first = retryPendingPetpoojaOrdersWorker();
    const second = retryPendingPetpoojaOrdersWorker();

    // Let both ticks reach the claim/fetch boundary.
    for (let i = 0; i < 50 && !release; i++) {
      await new Promise((r) => setTimeout(r, 2));
    }
    expect(release).toBeTypeOf("function");
    (release as unknown as () => void)();

    const [a, b] = await Promise.all([first, second]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((a.retriedCount ?? 0) + (b.retriedCount ?? 0)).toBe(1);
    const doc = savedDocs["orders/ord_overlap"];
    expect(doc.petpoojaStatus).toBe("synced");
    expect(doc.petpoojaOrderId).toBe("pp_pp_overlap");
  });
});
