import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * STRESS-TEST REPAIR RED/GREEN — route-transfer retry-worker concurrency
 * repairs (stress sweep 2026-10-24, routeTransfers findings R1/R3/R5).
 *
 * R1 (P1): a retryable gateway rejection (definite 4xx) never releases the
 * claim lease — the failure write leaves `transferring` + a live
 * `routeTransferClaimedAt`, so the `pending_retry` lane cannot see the doc
 * and every retry idles out the full 10-min TTL. The shared settlement
 * routine (razorpay.service.ts) releases the lease on the same failure; the
 * two paths must agree.
 *
 * R3 (P1): `findExistingTransferForPayment` returned `null` ("no existing
 * transfer") when the SDK client lacks `payments.fetchTransfer` — a missing
 * lookup is indistinguishable from a clean one, so reconcile-before-POST
 * fails OPEN and the worker blind-POSTs the non-idempotent transfer.
 *
 * R5 (P2): `getRazorpayClient()` throwing (missing/credentials) lands in the
 * bare outer catch → classified retryable → the worker burns its 4-attempt
 * retry budget on a fault no retry can fix (and terminally fails the order
 * without the manual-settlement flag).
 *
 * HONESTY LIMIT: in-process document store with optimistic-concurrency
 * transactions; live-gateway mode through a stubbed Razorpay client; no
 * network, no secret. Mirrors the harness of routeTransfers.lease-race.test.
 */
const { mockDb, docs, writeLog, control } = vi.hoisted(() => {
  process.env.OTP_HMAC_SECRET = "test_otp_route_transfer_pair";
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
        if (conflicted()) continue;
        for (const w of writes) applyWrite(w.path, w.data, w.merge);
        return result;
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
      reset: () => {
        docs.clear();
        writeLog.length = 0;
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
import {
  __resetRazorpayClientForTests,
  __setRazorpayClientForTests,
} from "../src/modules/payments/razorpayClient";
import { config } from "../src/config/env";

const seedPendingOrder = (id: string, paymentId = "pay_pair_1") => {
  control.seed(`orders/${id}`, {
    id,
    branchId: "branch_surat_01",
    pricing: { grandTotal: 250, split: { branchTransferPaise: 9000, brandRoyaltyPaise: 1600 } },
    payment: { razorpayPaymentId: paymentId },
    routeTransferStatus: "pending_retry",
    routeTransferRetryCount: 0,
  });
  control.seed("branches/branch_surat_01", { razorpayAccountId: "acc_surat_1" });
};

const orderData = (id: string) => docs.get(`orders/${id}`)?.data;

describe("route-transfer retry worker concurrency repairs (stress sweep)", () => {
  let prevPg: boolean;
  let prevKey: string;
  let prevSecret: string;
  beforeEach(() => {
    control.reset();
    prevPg = config.mock.paymentGateway;
    // Live-key seam: getRazorpayClient() fail-closes on mock-looking keys
    // BEFORE consulting the injected client, so these tests hand it
    // non-mock labels (never a secret; the SDK instance is stubbed).
    prevKey = config.razorpay.keyId;
    prevSecret = config.razorpay.keySecret;
    config.razorpay.keyId = "rzp_test_pairkey";
    config.razorpay.keySecret = "pairtest_secret_probe1";
  });
  afterEach(() => {
    __resetRazorpayClientForTests();
    config.mock.paymentGateway = prevPg;
    config.razorpay.keyId = prevKey;
    config.razorpay.keySecret = prevSecret;
  });

  it("R1 RED: a definite 4xx releases the lease for the SAME lane (no 10-min idle)", async () => {
    seedPendingOrder("order_pair_lease");
    const transfer = vi.fn(async () => {
      const e: any = new Error("Bad request — invalid destination account");
      e.statusCode = 400;
      throw e;
    });
    const fetchTransfer = vi.fn(async () => ({ items: [] }));
    __setRazorpayClientForTests({ payments: { transfer, fetchTransfer } });

    config.mock.paymentGateway = false;
    await retryPendingRouteTransfersWorker();

    const afterTick1 = orderData("order_pair_lease")!;
    // The worker must release `transferring` back into the pending_retry lane
    // so the next scheduler tick can reclaim it immediately.
    expect(afterTick1.routeTransferStatus).toBe("pending_retry");

    // Gateway recovers → the immediate next tick MUST settle the order.
    config.mock.paymentGateway = true;
    const result = await retryPendingRouteTransfersWorker();
    expect(result.retriedCount).toBe(1);
    expect(orderData("order_pair_lease")!.routeTransferStatus).toBe("transferred");
  });

  it("R3 RED: refuses to POST when it cannot reconcile (client lacks fetchTransfer)", async () => {
    seedPendingOrder("order_pair_noreconcile");
    const transfer = vi.fn(async () => ({ id: "trf_live_norec", status: "processed" }));
    // Deliberately NO fetchTransfer on the client: reconcile lookup unavailable.
    __setRazorpayClientForTests({ payments: { transfer } });

    config.mock.paymentGateway = false;
    await retryPendingRouteTransfersWorker();


    expect(transfer).not.toHaveBeenCalled();
    const order = orderData("order_pair_noreconcile")!;
    expect(order.routeTransferStatus).toBe("needs_reconciliation");
    expect(order["payment.routeTransfer"]).toBeUndefined();
  });

  it("R5 RED: a client-factory fault parks for manual settlement (no retry-budget burn)", async () => {
    seedPendingOrder("order_pair_nocreds");
    // No injected client + live-labeled keys RESET to mock look → the
    // client factory itself must fail closed ("live Razorpay keys missing…").
    config.mock.paymentGateway = false;
    config.razorpay.keyId = prevKey;
    config.razorpay.keySecret = prevSecret;
    await retryPendingRouteTransfersWorker();

    const order = orderData("order_pair_nocreds")!;
    expect(order.routeTransferNeedsManualSettlement).toBe(true);
    expect(order.routeTransferStatus).toBe("failed");
    expect(order.routeTransferRetryCount).toBeFalsy();
  });
});
