import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * STRESS-TEST: Terminal Order Guard on Route Transfer Retries (F5)
 *
 * Verifies that orders in terminal states (CANCELLED, REFUNDED, or with refunded payment markers)
 * are refused at the claim boundary and pre-POST in processDoc, parked in unmatched_payments
 * with deterministic ids, safe audit trails, no retry budget burn, and no double-transfers.
 * Also verifies transactional abort/retry does not emit uncommitted refusal parks,
 * foreign live leases and concurrent transferred winners are preserved,
 * fulfilled terminal statuses (PICKED_UP) are not misclassified as cancelled,
 * and failures during fresh reads or park persistence fail closed.
 */
const { mockDb, docs, writeLog, control } = vi.hoisted(() => {
  process.env.OTP_HMAC_SECRET = "test_otp_terminal_guard";
  type Rec = { data: any; version: number };
  const docs = new Map<string, Rec>();
  const writeLog: Array<{ path: string; data: any; merge?: boolean }> = [];
  let contentionHook: (() => void) | null = null;
  let getHook: ((path: string) => void) | null = null;
  let writeHook: ((path: string) => void) | null = null;

  const versionOf = (path: string): number => docs.get(path)?.version ?? -1;
  const dataOf = (path: string): any => docs.get(path)?.data;

  const applyWrite = (path: string, data: any, merge?: boolean, log = true) => {
    if (writeHook) writeHook(path);
    const existing = docs.get(path);
    const next = merge && existing ? { ...existing.data, ...data } : { ...data };
    docs.set(path, { data: next, version: (existing?.version ?? 0) + 1 });
    if (log) writeLog.push({ path, data: next, merge: !!merge });
  };

  const runTransaction = (fn: (tx: any) => any): Promise<any> => {
    const attempt = async (): Promise<any> => {
      for (let tries = 0; tries <= 8; tries++) {
        const readVersions = new Map<string, number>();
        const writes: Array<{ path: string; data: any; merge?: boolean }> = [];
        const tx = {
          get: async (ref: any) => {
            if (getHook) getHook(ref.path);
            readVersions.set(ref.path, versionOf(ref.path));
            const data = dataOf(ref.path);
            return { exists: data !== undefined, data: () => data, ref };
          },
          set: (ref: any, data: any, opts?: any) => {
            if (writeHook) writeHook(ref.path);
            writes.push({ path: ref.path, data, merge: !!opts?.merge });
          },
          update: (ref: any, data: any) => {
            if (writeHook) writeHook(ref.path);
            writes.push({ path: ref.path, data, merge: true });
          },
        };
        const result = await fn(tx);

        if (contentionHook && tries === 0) {
          const hook = contentionHook;
          contentionHook = null;
          hook();
        }

        const conflicted = () =>
          [...readVersions.entries()].some(([path, v]) => versionOf(path) !== v);
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
        if (getHook) getHook(path);
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
      delete: async () => {
        docs.delete(path);
      },
    };
    return ref;
  };

  const getByPath = (obj: any, path: string) =>
    path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
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
      doc: (docId?: string) =>
        docRef(colName, docId || `auto_${Math.random().toString(36).slice(2, 8)}`),
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
      deleteDoc: (path: string) => docs.delete(path),
      reset: () => {
        docs.clear();
        writeLog.length = 0;
        contentionHook = null;
        getHook = null;
        writeHook = null;
      },
      setContentionHook: (hook: () => void) => {
        contentionHook = hook;
      },
      setGetHook: (hook: (path: string) => void) => {
        getHook = hook;
      },
      setWriteHook: (hook: (path: string) => void) => {
        writeHook = hook;
      },
    },
  };
});

vi.mock("firebase-admin", () => {
  const FieldValue = {
    serverTimestamp: () => "MOCK_SERVER_TIMESTAMP",
    increment: (n: number) => n,
    arrayUnion: (item: any) => [item],
    delete: () => undefined,
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

const seedOrder = (id: string, overrides: Record<string, any> = {}) => {
  control.seed(`orders/${id}`, {
    id,
    branchId: "branch_surat_01",
    pricing: { grandTotal: 250, split: { branchTransferPaise: 9000, brandRoyaltyPaise: 1600 } },
    payment: { razorpayPaymentId: `pay_${id}`, capturedAmountPaise: 25000 },
    routeTransferStatus: "pending_retry",
    routeTransferRetryCount: 0,
    ...overrides,
  });
  control.seed("branches/branch_surat_01", { razorpayAccountId: "acc_surat_01" });
};

const getDocData = (path: string) => docs.get(path)?.data;

describe("Route transfer retry worker terminal order guard (F5 stress)", () => {
  let prevPg: boolean;
  let prevKey: string;
  let prevSecret: string;

  beforeEach(() => {
    control.reset();
    prevPg = config.mock.paymentGateway;
    prevKey = config.razorpay.keyId;
    prevSecret = config.razorpay.keySecret;
    config.razorpay.keyId = "rzp_test_terminal_key";
    config.razorpay.keySecret = "secret_terminal_test1";
  });

  afterEach(() => {
    __resetRazorpayClientForTests();
    config.mock.paymentGateway = prevPg;
    config.razorpay.keyId = prevKey;
    config.razorpay.keySecret = prevSecret;
  });

  it("refuses claim and parks in unmatched_payments when order is CANCELLED during tx.get", async () => {
    seedOrder("order_term_cancelled", {
      status: { code: "CANCELLED" },
    });

    const transfer = vi.fn(async () => ({ id: "trf_should_not_run", status: "processed" }));
    const fetchTransfer = vi.fn(async () => ({ items: [] }));
    __setRazorpayClientForTests({ payments: { transfer, fetchTransfer } });
    config.mock.paymentGateway = false;

    const result = await retryPendingRouteTransfersWorker();

    expect(transfer).not.toHaveBeenCalled();
    expect(result.retriedCount).toBe(0);

    const parkDoc = getDocData("unmatched_payments/ump_term_pay_order_term_cancelled");
    expect(parkDoc).toBeDefined();
    expect(parkDoc?.reason).toBe("capture_on_cancelled_order");
    expect(parkDoc?.status).toBe("needs_review");
    expect(parkDoc?.orderId).toBe("order_term_cancelled");

    const order = getDocData("orders/order_term_cancelled");
    expect(order.routeTransferStatus).toBe("failed");
    expect(order.routeTransferTerminalRefusal).toBe(true);
    expect(order.routeTransferRetryCount).toBe(0);
  });

  it("refuses claim when payment marker is refunded (legacy or payment.status)", async () => {
    seedOrder("order_term_refunded", {
      status: "delivered",
      payment: {
        razorpayPaymentId: "pay_order_term_refunded",
        status: "refunded",
        capturedAmountPaise: 25000,
      },
    });

    const transfer = vi.fn(async () => ({ id: "trf_should_not_run", status: "processed" }));
    const fetchTransfer = vi.fn(async () => ({ items: [] }));
    __setRazorpayClientForTests({ payments: { transfer, fetchTransfer } });
    config.mock.paymentGateway = false;

    const result = await retryPendingRouteTransfersWorker();

    expect(transfer).not.toHaveBeenCalled();
    expect(result.retriedCount).toBe(0);

    const parkDoc = getDocData("unmatched_payments/ump_term_pay_order_term_refunded");
    expect(parkDoc).toBeDefined();
    expect(parkDoc?.reason).toBe("capture_on_refunded_order");

    const order = getDocData("orders/order_term_refunded");
    expect(order.routeTransferStatus).toBe("failed");
    expect(order.routeTransferTerminalRefusal).toBe(true);
  });

  it("transactional abort/retry does not emit uncommitted refusal parks from aborted attempt", async () => {
    seedOrder("order_tx_contention", {
      status: "cancelled",
    });

    control.setContentionHook(() => {
      control.seed("branches/branch_surat_01", { razorpayAccountId: "acc_surat_01", versionBump: 1 }, true);
    });

    const transfer = vi.fn(async () => ({ id: "trf_should_not_run", status: "processed" }));
    const fetchTransfer = vi.fn(async () => ({ items: [] }));
    __setRazorpayClientForTests({ payments: { transfer, fetchTransfer } });
    config.mock.paymentGateway = false;

    await retryPendingRouteTransfersWorker();

    expect(transfer).not.toHaveBeenCalled();
    const parks = writeLog.filter((w) => w.path.startsWith("unmatched_payments/ump_term_"));
    expect(parks.length).toBe(1);
  });

  it("existing transferred winner remains untouched", async () => {
    seedOrder("order_winner", {
      routeTransferStatus: "transferred",
      "payment.routeTransfer": { id: "trf_existing_winner", amount: 9000 },
      status: "cancelled",
    });

    const transfer = vi.fn(async () => ({ id: "trf_should_not_run", status: "processed" }));
    const fetchTransfer = vi.fn(async () => ({ items: [] }));
    __setRazorpayClientForTests({ payments: { transfer, fetchTransfer } });
    config.mock.paymentGateway = false;

    await retryPendingRouteTransfersWorker();

    expect(transfer).not.toHaveBeenCalled();
    const order = getDocData("orders/order_winner");
    expect(order.routeTransferStatus).toBe("transferred");
    expect(order["payment.routeTransfer"]?.id).toBe("trf_existing_winner");
  });

  it("fresh processDoc reread catches cancellation after claim before transfer POST", async () => {
    seedOrder("order_cancel_after_claim", {
      status: "accepted",
    });

    const transfer = vi.fn(async () => ({ id: "trf_live", status: "processed" }));
    const fetchTransfer = vi.fn(async () => ({ items: [] }));
    __setRazorpayClientForTests({ payments: { transfer, fetchTransfer } });
    config.mock.paymentGateway = false;

    // Mutate to cancelled after initial query
    control.seed("orders/order_cancel_after_claim", { status: "cancelled" }, true);

    const result = await retryPendingRouteTransfersWorker();
    expect(transfer).not.toHaveBeenCalled();
    expect(result.retriedCount).toBe(0);

    const parkDoc = getDocData("unmatched_payments/ump_term_pay_order_cancel_after_claim");
    expect(parkDoc).toBeDefined();
    expect(parkDoc?.reason).toBe("capture_on_cancelled_order");
  });

  // NEW REVIEW REGRESSIONS:

  it("RED: processDoc fresh read failure (injected doc.ref.get error) fails closed: 0 POST, no budget burn, no progress", async () => {
    seedOrder("order_get_error", {
      status: "placed",
    });

    const transfer = vi.fn(async () => ({ id: "trf_live", status: "processed" }));
    const fetchTransfer = vi.fn(async () => ({ items: [] }));
    __setRazorpayClientForTests({ payments: { transfer, fetchTransfer } });
    config.mock.paymentGateway = false;

    // Inject read error during processDoc's fresh read
    let claimDone = false;
    control.setGetHook((path: string) => {
      if (path === "orders/order_get_error" && claimDone) {
        throw new Error("INJECTED_FIRESTORE_GET_NETWORK_ERROR");
      }
    });

    // Mark claimDone after claim transaction completes by intercepting write to order_get_error
    control.setWriteHook((path: string) => {
      if (path === "orders/order_get_error") {
        claimDone = true;
      }
    });

    const result = await retryPendingRouteTransfersWorker();

    // Must FAIL CLOSED: zero POST, retriedCount 0, retry count not burned
    expect(transfer).not.toHaveBeenCalled();
    expect(result.retriedCount).toBe(0);
    const order = getDocData("orders/order_get_error");
    expect(order.routeTransferStatus).not.toBe("transferred");
    expect(order.routeTransferRetryCount).toBe(0);
  });

  it("RED: processDoc deleted order after claim fails closed: 0 POST, no phantom success", async () => {
    seedOrder("order_deleted_after_claim", {
      status: "placed",
    });

    const transfer = vi.fn(async () => ({ id: "trf_live", status: "processed" }));
    const fetchTransfer = vi.fn(async () => ({ items: [] }));
    __setRazorpayClientForTests({ payments: { transfer, fetchTransfer } });
    config.mock.paymentGateway = false;

    // Delete order doc right after claim write
    control.setWriteHook((path: string) => {
      if (path === "orders/order_deleted_after_claim") {
        control.deleteDoc("orders/order_deleted_after_claim");
      }
    });

    const result = await retryPendingRouteTransfersWorker();
    expect(transfer).not.toHaveBeenCalled();
    expect(result.retriedCount).toBe(0);
  });

  it("RED: claim tx does not touch or clear live foreign lease even on cancelled order", async () => {
    const liveClaimTime = Date.now() - 30_000; // 30s ago (< 10min TTL)
    seedOrder("order_foreign_lease", {
      routeTransferStatus: "transferring",
      routeTransferClaimedAt: liveClaimTime,
      status: "cancelled",
    });

    const transfer = vi.fn(async () => ({ id: "trf_should_not_run", status: "processed" }));
    const fetchTransfer = vi.fn(async () => ({ items: [] }));
    __setRazorpayClientForTests({ payments: { transfer, fetchTransfer } });
    config.mock.paymentGateway = false;

    await retryPendingRouteTransfersWorker();

    expect(transfer).not.toHaveBeenCalled();
    const order = getDocData("orders/order_foreign_lease");
    // Live foreign lease MUST NOT be cleared or set to failed by another worker
    expect(order.routeTransferStatus).toBe("transferring");
    expect(order.routeTransferClaimedAt).toBe(liveClaimTime);
  });

  it("RED: PICKED_UP terminal:true is allowed legitimate retry (not treated as cancelled)", async () => {
    seedOrder("order_picked_up", {
      status: { code: "picked_up", terminal: true },
      routeTransferStatus: "pending_retry",
    });

    const transfer = vi.fn(async () => ({ id: "trf_picked_up_success", status: "processed" }));
    const fetchTransfer = vi.fn(async () => ({ items: [] }));
    __setRazorpayClientForTests({ payments: { transfer, fetchTransfer } });
    config.mock.paymentGateway = false;

    const result = await retryPendingRouteTransfersWorker();

    // PICKED_UP is legitimate fulfilled order — MUST NOT be refused as cancelled
    expect(transfer).toHaveBeenCalledTimes(1);
    expect(result.retriedCount).toBe(1);
    const order = getDocData("orders/order_picked_up");
    expect(order.routeTransferStatus).toBe("transferred");
  });

  it("RED: park write failure in refusal tx aborts without committing terminal-failed transition", async () => {
    seedOrder("order_park_fail", {
      status: "cancelled",
    });

    const transfer = vi.fn(async () => ({ id: "trf_should_not_run", status: "processed" }));
    const fetchTransfer = vi.fn(async () => ({ items: [] }));
    __setRazorpayClientForTests({ payments: { transfer, fetchTransfer } });
    config.mock.paymentGateway = false;

    // Inject failure when writing to unmatched_payments
    control.setWriteHook((path: string) => {
      if (path.startsWith("unmatched_payments/")) {
        throw new Error("UNMATCHED_PAYMENTS_WRITE_FAILED_STORAGE_ERROR");
      }
    });

    try {
      await retryPendingRouteTransfersWorker();
    } catch {
      // Expected rejection or logged failure
    }

    expect(transfer).not.toHaveBeenCalled();
    const order = getDocData("orders/order_park_fail");
    // Must NOT have committed routeTransferStatus: 'failed' if unmatched_payments was not durable!
    expect(order.routeTransferStatus).not.toBe("failed");
  });

  it("RED: processDoc CAS refusal does not clobber concurrent transferred winner", async () => {
    seedOrder("order_cas_winner", {
      status: "accepted",
    });

    const transfer = vi.fn(async () => ({ id: "trf_should_not_run", status: "processed" }));
    const fetchTransfer = vi.fn(async () => ({ items: [] }));
    __setRazorpayClientForTests({ payments: { transfer, fetchTransfer } });
    config.mock.paymentGateway = false;

    // Simulate concurrent writer completing transfer between claim and refusal CAS
    let claimed = false;
    control.setWriteHook((path: string) => {
      if (path === "orders/order_cas_winner" && !claimed) {
        claimed = true;
        // Concurrent winner marks transferred
        control.seed("orders/order_cas_winner", {
          routeTransferStatus: "transferred",
          "payment.routeTransfer": { id: "trf_concurrent_winner_1" },
          status: "cancelled", // Cancellation also landed
        }, true);
      }
    });

    await retryPendingRouteTransfersWorker();

    expect(transfer).not.toHaveBeenCalled();
    const order = getDocData("orders/order_cas_winner");
    // Transferred winner preserved!
    expect(order.routeTransferStatus).toBe("transferred");
    expect(order["payment.routeTransfer"]?.id).toBe("trf_concurrent_winner_1");
  });
});
