import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Route-transfer retry-worker LEASE RACE regression (granted by the payments
 * owner ses_eb65a55d8ffem6HSQtGO4RMN2B on integration-expanded-team-20261020-
 * ownership, 2026-10-20T00:19:42Z, path 2 of 2 only; session id as ratified:
 * ses_eb65a55d8ffem6HSQtGO4RMN2B).
 *
 * This file exists to pin the worker's claim-then-work lease
 * (routeTransfers.ts:405-452): overlapping scheduler ticks must never both
 * POST the non-idempotent transfer API for one order. It proves:
 *  - positive control: ONE worker drains the order normally;
 *  - two workers racing the SAME order: exactly one claims and settles, the
 *    loser observes a live lease and makes zero gateway/attempt calls;
 *  - a retry AFTER completion does not re-transfer (status is no longer in the
 *    worker's query lanes).
 *
 * HONESTY LIMIT: in-process document store with optimistic-concurrency
 * transactions. It models the Firestore retry contract, not real cross-process
 * executors. Mock gateway mode: no network, no provider SDK call, no secret.
 * The gateway call is counted through the worker's own settlement write, which
 * is emitted exactly once per real POST (routeTransfers.ts:572-582).
 */
const { mockDb, docs, writeLog, control } = vi.hoisted(() => {
  type Rec = { data: any; version: number };
  const docs = new Map<string, Rec>();
  const writeLog: Array<{ path: string; data: any; merge?: boolean }> = [];

  const versionOf = (path: string): number => docs.get(path)?.version ?? -1;
  const dataOf = (path: string): any => docs.get(path)?.data;

  const applyWrite = (path: string, data: any, merge?: boolean, log = true) => {
    const existing = docs.get(path);
    const next = merge && existing ? { ...existing.data, ...data } : { ...data };
    docs.set(path, { data: next, version: (existing?.version ?? 0) + 1 });
    if (log) writeLog.push({ path, data, merge: !!merge });
  };

  let commitTail: Promise<unknown> = Promise.resolve();
  const enqueueCommit = <T,>(task: () => T): Promise<T> => {
    const run = commitTail.then(task, task);
    commitTail = run.then(() => undefined, () => undefined);
    return run;
  };

  // Query gate: hold BOTH workers' pending_retry reads until both are inside
  // the gate, so the two claim transactions really contend over one snapshot.
  const gate: { armed: boolean; expected: number; arrivals: number; release: null | (() => void) } = {
    armed: false,
    expected: 2,
    arrivals: 0,
    release: null,
  };
  const passGate = async (isWorkerLane: boolean) => {
    if (!gate.armed || !isWorkerLane) return;
    gate.arrivals += 1;
    if (gate.arrivals >= gate.expected) {
      gate.release?.();
      return;
    }
    await new Promise<void>((resolve) => {
      gate.release = resolve;
    });
  };

  const runTransaction = (fn: (tx: any) => any): Promise<any> => {
    const attempt = async (): Promise<any> => {
      for (let tries = 0; tries <= 8; tries++) {
        const readVersions = new Map<string, number>();
        const writes: Array<{ path: string; data: any; merge?: boolean }> = [];
        const tx = {
          get: async (ref: any) => {
            readVersions.set(ref.path, versionOf(ref.path));
            const data = dataOf(ref.path);
            return { exists: data !== undefined, data: () => data, ref };
          },
          set: (ref: any, data: any, opts?: any) => void writes.push({ path: ref.path, data, merge: !!opts?.merge }),
          update: (ref: any, data: any) => void writes.push({ path: ref.path, data, merge: true }),
        };
        const result = await fn(tx);
        const conflicted = () => [...readVersions.entries()].some(([path, v]) => versionOf(path) !== v);
        if (writes.length === 0) {
          if (conflicted()) continue;
          return result;
        }
        const outcome = await enqueueCommit(() => {
          if (conflicted()) return { conflicted: true as const };
          for (const w of writes) applyWrite(w.path, w.data, w.merge);
          return { conflicted: false as const, result };
        });
        if (!outcome.conflicted) return outcome.result;
      }
      const err: any = new Error("SIMULATED_TRANSACTION_CONTENTION: retries exhausted");
      err.code = "ABORTED";
      throw err;
    };
    return attempt();
  };

  const docRef = (colName: string, docId: string) => {
    const path = `${colName}/${docId}`;
    const ref: any = {
      id: docId,
      path,
      get: async () => {
        const data = dataOf(path);
        return { exists: data !== undefined, data: () => data, ref };
      },
      set: async (data: any, opts?: any) => applyWrite(path, data, !!opts?.merge),
      create: async (data: any) => {
        if (docs.has(path)) {
          const err: any = new Error("ALREADY_EXISTS: Document already exists");
          err.code = 6;
          throw err;
        }
        applyWrite(path, data, false);
      },
      update: async (data: any) => applyWrite(path, data, true),
    };
    return ref;
  };

  const getByPath = (obj: any, path: string) => path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);

  type Filter = { field: string; op: string; value: any };
  const matches = (data: any, f: Filter): boolean => {
    const actual = getByPath(data, f.field);
    switch (f.op) {
      case "==":
        return actual === f.value;
      case "<=":
        return typeof actual === "number" && actual <= f.value;
      case "<":
        return typeof actual === "number" && actual < f.value;
      case ">=":
        return typeof actual === "number" && actual >= f.value;
      case ">":
        return typeof actual === "number" && actual > f.value;
      default:
        return false;
    }
  };

  const collectionMock = (colName: string) => {
    const filters: Filter[] = [];
    const q: any = {
      where: (field: string, op: string, value: any) => {
        filters.push({ field, op, value });
        return q;
      },
      limit: () => q,
      get: async () => {
        const isWorkerLane =
          colName === "orders" &&
          filters.some((f) => f.field === "routeTransferStatus" && f.op === "==" && f.value === "pending_retry");
        await passGate(isWorkerLane);
        const found = [...docs.entries()]
          .filter(([path]) => path.startsWith(`${colName}/`))
          .filter(([, rec]) => filters.every((f) => matches(rec.data, f)))
          .map(([path, rec]) => {
            const [col, id] = path.split("/");
            return { id, ref: docRef(col, id), data: () => rec.data };
          });
        return { empty: found.length === 0, size: found.length, docs: found };
      },
      doc: (docId?: string) => docRef(colName, docId || `auto_${Math.random().toString(36).slice(2, 8)}`),
    };
    return q;
  };

  const mockDb: any = { collection: collectionMock, runTransaction };

  return {
    mockDb,
    docs,
    writeLog,
    control: {
      seed: (path: string, data: any, merge = false) => applyWrite(path, data, merge, false),
      armGate: (expected = 2) => {
        gate.armed = true;
        gate.expected = expected;
        gate.arrivals = 0;
        gate.release = null;
      },
      disarmGate: () => {
        gate.armed = false;
        gate.release = null;
      },
      reset: () => {
        docs.clear();
        writeLog.length = 0;
        gate.armed = false;
        gate.release = null;
      },
    },
  };
});

vi.mock("firebase-admin", () => {
  const FieldValue = {
    serverTimestamp: () => "MOCK_SERVER_TIMESTAMP",
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

import { retryPendingRouteTransfersWorker } from "../src/modules/payments/routeTransfers";
import { config } from "../src/config/env";

/** The worker's own success write is emitted exactly once per real transfer
 *  attempt (routeTransfers.ts:572-582), so it is the offline proxy for
 *  "called the gateway". */
const settlementWrites = () =>
  writeLog.filter(
    (e) =>
      e.path.startsWith("orders/") &&
      e.data?.routeTransferStatus === "transferred" &&
      typeof e.data?.["payment.routeTransfer"]?.id === "string" &&
      e.data["payment.routeTransfer"].id.startsWith("trf_mock_")
  );

const seedPendingOrder = (id: string, paymentId = "pay_lease_1") => {
  control.seed(`orders/${id}`, {
    id,
    branchId: "branch_surat_01",
    pricing: { grandTotal: 250, split: { branchTransferPaise: 9000, brandRoyaltyPaise: 1600 } },
    payment: { razorpayPaymentId: paymentId },
    routeTransferStatus: "pending_retry",
    routeTransferRetryCount: 0,
    routeTransferError: "Transient gateway failure",
  });
  control.seed("branches/branch_surat_01", { razorpayAccountId: "acc_surat_1" });
};

describe("route transfer retry worker lease race (granted regression)", () => {
  let prevPg: boolean;
  beforeEach(() => {
    control.reset();
    prevPg = config.mock.paymentGateway;
    config.mock.paymentGateway = true;
  });
  afterEach(() => {
    control.disarmGate();
    config.mock.paymentGateway = prevPg;
  });

  it("positive control: a single worker settles the parked order exactly once", async () => {
    seedPendingOrder("order_lease_single");

    const result = await retryPendingRouteTransfersWorker();

    expect(result.retriedCount).toBe(1);
    const order = docs.get("orders/order_lease_single")!.data;
    expect(order.routeTransferStatus).toBe("transferred");
    expect(order["payment.routeTransfer"].id).toMatch(/^trf_mock_/);
    expect(settlementWrites()).toHaveLength(1);
  });

  it("two concurrent workers: exactly one wins the lease; the loser does zero transfer work", async () => {
    seedPendingOrder("order_lease_race");
    // Both workers must see the same `pending_retry` snapshot before either
    // claim transaction commits, otherwise the race is vacuous.
    control.armGate(2);

    const [a, b] = await Promise.all([retryPendingRouteTransfersWorker(), retryPendingRouteTransfersWorker()]);
    control.disarmGate();

    // One settlement in total, not one per worker.
    expect(settlementWrites()).toHaveLength(1);
    expect((a?.retriedCount ?? 0) + (b?.retriedCount ?? 0)).toBe(1);
    const order = docs.get("orders/order_lease_race")!.data;
    expect(order.routeTransferStatus).toBe("transferred");
    expect(order["payment.routeTransfer"].id).toMatch(/^trf_mock_/);
    // Exactly one order was claimed into `transferring` and then settled; a
    // duplicated claim would show a second settlement or a second claim stamp.
    const claimStamps = writeLog.filter(
      (e) => e.path === "orders/order_lease_race" && e.data?.routeTransferStatus === "transferring"
    );
    expect(claimStamps).toHaveLength(1);
  });

  it("a retry AFTER a completed lease does not transfer again", async () => {
    seedPendingOrder("order_lease_done");
    await retryPendingRouteTransfersWorker();
    const afterFirst = settlementWrites();
    expect(afterFirst).toHaveLength(1);

    const second = await retryPendingRouteTransfersWorker();

    expect(second.retriedCount).toBe(0);
    expect(settlementWrites()).toHaveLength(1);
    const order = docs.get("orders/order_lease_done")!.data;
    expect(order.routeTransferStatus).toBe("transferred");
    expect(order["payment.routeTransfer"].id).toBe(afterFirst[0].data["payment.routeTransfer"].id);
  });
});
