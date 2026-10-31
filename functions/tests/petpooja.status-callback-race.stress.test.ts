import { describe, it, expect, vi, beforeEach } from "vitest";

// Finding 6 (F6): Petpooja status webhook stale terminal/replay guard race.
// Handler resolves order earlier (~919/948), evaluates event replay (~1090)
// and terminal (~1100) on stale orderData then unconditional set (~1265);
// credentialed CANCEL can overwrite DELIVERED and mint pending refund for delivered order.
// Evaluate terminal/replay/money decision and order mutation on fresh tx snapshot atomically.
// Must return unconditionally after tx path, never double-apply or fall through to plain write.

const { mockDb, savedDocs, txHooks, writeMetrics } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  let autoId = 0;
  const txHooks: {
    beforeTxGet?: (path: string) => Promise<void> | void;
    queryError?: Error | null;
  } = {};
  const writeMetrics = {
    plainSetCalls: 0,
    txSetCalls: 0,
    txUpdateCalls: 0,
  };

  const docRef = (col: string, id: string) => {
    const path = `${col}/${id}`;
    return {
      id,
      path,
      get: vi.fn(async () => ({
        exists: Object.prototype.hasOwnProperty.call(savedDocs, path),
        data: () => (savedDocs[path] ? JSON.parse(JSON.stringify(savedDocs[path])) : undefined),
        ref: docRef(col, id),
      })),
      set: vi.fn(async (data: any, opts?: any) => {
        writeMetrics.plainSetCalls++;
        savedDocs[path] =
          opts?.merge && savedDocs[path]
            ? { ...savedDocs[path], ...JSON.parse(JSON.stringify(data)) }
            : JSON.parse(JSON.stringify(data));
      }),
      update: vi.fn(async (data: any) => {
        writeMetrics.plainSetCalls++;
        if (!savedDocs[path]) throw new Error(`Doc ${path} does not exist`);
        savedDocs[path] = { ...savedDocs[path], ...JSON.parse(JSON.stringify(data)) };
      }),
    };
  };

  const query = (col: string) => {
    const filters: Array<[string, string, any]> = [];
    const q: any = {
      where: (f: string, op: string, v: any) => {
        filters.push([f, op, v]);
        return q;
      },
      limit: () => q,
      get: vi.fn(async () => {
        const docs = Object.keys(savedDocs)
          .filter(
            (p) =>
              p.startsWith(`${col}/`) &&
              filters.every(([f, op, v]) =>
                op === "==" ? savedDocs[p]?.[f] === v : false
              )
          )
          .map((p) => {
            const id = p.slice(col.length + 1);
            return {
              id,
              ref: docRef(col, id),
              exists: true,
              data: () => JSON.parse(JSON.stringify(savedDocs[p])),
            };
          });
        return { docs, empty: docs.length === 0 };
      }),
    };
    return q;
  };

  const mockDb: any = {
    collection: (col: string) => ({
      doc: (id?: string) => docRef(col, id || `auto_${++autoId}`),
      where: query(col).where,
    }),
    runTransaction: vi.fn(async (fn: any) => {
      const tx = {
        get: async (ref: any) => {
          if (txHooks.queryError && (!ref.path || typeof ref.where === "function")) {
            throw txHooks.queryError;
          }
          if (ref.path && txHooks.beforeTxGet) {
            await txHooks.beforeTxGet(ref.path);
          }
          return ref.get();
        },
        set: async (ref: any, data: any, opts?: any) => {
          writeMetrics.txSetCalls++;
          const path = ref.path;
          savedDocs[path] =
            opts?.merge && savedDocs[path]
              ? { ...savedDocs[path], ...JSON.parse(JSON.stringify(data)) }
              : JSON.parse(JSON.stringify(data));
        },
        update: async (ref: any, data: any) => {
          writeMetrics.txUpdateCalls++;
          const path = ref.path;
          if (!savedDocs[path]) throw new Error(`Doc ${path} does not exist`);
          savedDocs[path] = { ...savedDocs[path], ...JSON.parse(JSON.stringify(data)) };
        },
      };
      return fn(tx);
    }),
  };

  return { mockDb, savedDocs, txHooks, writeMetrics };
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

import { handlePetpoojaWebhook } from "../src/modules/petpooja/item86ingSync";

const seedInProgress = (id: string, extra: Record<string, any> = {}) => {
  savedDocs[`orders/${id}`] = {
    id,
    branchId: "branch_race_1",
    status: { code: "CONFIRMED", label: "Order confirmed", kind: "upcoming", terminal: false },
    payment: { razorpayPaymentId: `pay_${id}`, amount: 49900 },
    ...extra,
  };
};

const refundDocs = () =>
  Object.keys(savedDocs).filter((p) => p.startsWith("refunds/"));

describe("Petpooja status webhook — atomic terminal/replay transaction race defense (F6)", () => {
  beforeEach(() => {
    for (const key of Object.keys(savedDocs)) delete savedDocs[key];
    txHooks.beforeTxGet = undefined;
    writeMetrics.plainSetCalls = 0;
    writeMetrics.txSetCalls = 0;
    writeMetrics.txUpdateCalls = 0;
    savedDocs["branches/branch_race_1"] = { petpoojaStoreId: "store_race_1", name: "Race Branch" };
  });

  it("RED race injection: pre-read nonterminal, DELIVERED commits before guarded transaction get -> CANCEL does not overwrite DELIVERED and does NOT mint refund", async () => {
    seedInProgress("ord_race_cancel");

    // Race injection: after pre-read resolution, DELIVERED is committed before/during transaction get
    let injected = false;
    txHooks.beforeTxGet = async (path: string) => {
      if (path === "orders/ord_race_cancel" && !injected) {
        injected = true;
        // Concurrent rider delivery commits to DB
        savedDocs["orders/ord_race_cancel"].status = {
          code: "DELIVERED",
          label: "Delivered",
          kind: "completed",
          terminal: true,
        };
        savedDocs["orders/ord_race_cancel"].deliveryStatus = "delivered";
      }
    };

    // Incoming credentialed Petpooja CANCEL
    await handlePetpoojaWebhook(
      {
        order_id: "ord_race_cancel",
        restID: "store_race_1",
        status: -1,
        cancel_reason: "Customer cancelled at counter late",
      },
      { authenticated: true }
    );

    // Guarded transaction must detect fresh DELIVERED state atomically:
    // 1. Order status must REMAIN DELIVERED (no rewind/overwrite)
    expect(savedDocs["orders/ord_race_cancel"].status).toMatchObject({
      code: "DELIVERED",
      terminal: true,
    });

    // 2. No refund parked for already delivered order
    expect(refundDocs()).toEqual([]);
    expect(savedDocs["orders/ord_race_cancel"]["payment.refundStatus"]).toBeUndefined();

    // 3. Must NOT have executed post-tx plain overwrite
    expect(writeMetrics.plainSetCalls).toBe(0);
  });

  it("Happy path applied callback executes inside transaction exactly once and NEVER falls through to legacy plain-write path", async () => {
    seedInProgress("ord_happy_1");

    await handlePetpoojaWebhook(
      {
        order_id: "ord_happy_1",
        restID: "store_race_1",
        status: 5, // ready for pickup
        id: "evt_happy_1",
      },
      { authenticated: true }
    );

    // Status updated
    expect(savedDocs["orders/ord_happy_1"].status).toMatchObject({
      code: "READY_FOR_PICKUP",
      kind: "in_progress",
    });
    expect(savedDocs["orders/ord_happy_1"].petpoojaKitchenStatus).toBe(5);

    // CRITICAL: Check for prior fallthrough bug where tx applied then plain set executed with stale data.
    // The write must occur through transaction (txSetCalls === 1) and plainSetCalls must be 0!
    expect(writeMetrics.txSetCalls).toBe(1);
    expect(writeMetrics.plainSetCalls).toBe(0);
  });

  it("Concurrent duplicate events result in only one effective state change and one refund request", async () => {
    seedInProgress("ord_concurrent_1");

    // Two identical concurrent cancel events arrive simultaneously
    await Promise.all([
      handlePetpoojaWebhook(
        {
          order_id: "ord_concurrent_1",
          restID: "store_race_1",
          status: -1,
          cancel_reason: "Duplicate event storm",
          id: "evt_dup_1",
        },
        { authenticated: true }
      ),
      handlePetpoojaWebhook(
        {
          order_id: "ord_concurrent_1",
          restID: "store_race_1",
          status: -1,
          cancel_reason: "Duplicate event storm",
          id: "evt_dup_1",
        },
        { authenticated: true }
      ),
    ]);

    expect(savedDocs["orders/ord_concurrent_1"].status).toMatchObject({
      code: "CANCELLED",
      terminal: true,
    });
    // Exactly one refund doc parked
    expect(refundDocs()).toEqual(["refunds/refund_pos_cancel_ord_concurrent_1"]);
    // Exactly one refund status stamp
    expect(savedDocs["orders/ord_concurrent_1"]["payment.refundStatus"]).toBe("PENDING_APPROVAL");
  });

  it("Untrusted callbacks admitted by shape can update a NON-terminal kitchen status but CANNOT terminal-flip (cancel), park refunds, or write sync state", async () => {
    seedInProgress("ord_untrusted_1");

    await handlePetpoojaWebhook(
      {
        order_id: "ord_untrusted_1",
        restID: "store_race_1",
        status: -1,
        cancel_reason: "Untrusted cancellation injection attempt",
      },
      { authenticated: false }
    );

    // F8: a shape-only (no credential header) callback must never complete or
    // cancel a live order — a terminal flip is irreversible here and a cancel
    // parks money movement. The status stays exactly as it was.
    expect(savedDocs["orders/ord_untrusted_1"].status).toMatchObject({
      code: "CONFIRMED",
      terminal: false,
    });
    expect(savedDocs["orders/ord_untrusted_1"].status).not.toMatchObject({
      code: "CANCELLED",
    });
    // SECURITY: Untrusted callback must NEVER inject refund request into staff queue
    expect(refundDocs()).toEqual([]);
    expect(savedDocs["orders/ord_untrusted_1"]["payment.refundStatus"]).toBeUndefined();
    // ... and the refusal is parked for review rather than silently dropped.
    expect(savedDocs["unmatched_petpooja_orders/upo_ord_untrusted_1"].reason).toMatch(
      /unauthenticated terminal status/i
    );
  });

  it("the SAME cancellation through an authenticated caller still applies (credential is the gate, not the payload)", async () => {
    seedInProgress("ord_auth_1");

    await handlePetpoojaWebhook(
      {
        order_id: "ord_auth_1",
        restID: "store_race_1",
        status: -1,
        cancel_reason: "Kitchen cancelled in POS",
      },
      { authenticated: true }
    );

    expect(savedDocs["orders/ord_auth_1"].status).toMatchObject({ code: "CANCELLED" });
    expect(refundDocs()).toEqual(["refunds/refund_pos_cancel_ord_auth_1"]);
  });

  it("Injected pending-query failure propagates and fails closed (no order cancel, no refund parked, no partial writes)", async () => {
    seedInProgress("ord_query_fail");

    // Inject query failure (e.g. datastore missing index or temporary outage)
    txHooks.queryError = new Error("FAILED_PRECONDITION: Missing composite index on refunds");

    // Should reject because query error must propagate out of transaction (fail closed)
    await expect(
      handlePetpoojaWebhook(
        {
          order_id: "ord_query_fail",
          restID: "store_race_1",
          status: -1,
          cancel_reason: "Kitchen cancel during query failure",
        },
        { authenticated: true }
      )
    ).rejects.toThrow(/FAILED_PRECONDITION/);

    // Fail-closed invariants:
    // 1. Order status must remain intact (still CONFIRMED)
    expect(savedDocs["orders/ord_query_fail"].status).toMatchObject({
      code: "CONFIRMED",
      terminal: false,
    });
    // 2. No refund request parked
    expect(refundDocs()).toEqual([]);
    // 3. No partial writes (neither order doc nor refund doc written)
    expect(writeMetrics.txSetCalls).toBe(0);
    expect(writeMetrics.plainSetCalls).toBe(0);
  });

  it("Race: order linked to branch A at pre-read, moved to branch B before tx read -> untrusted callback for A cannot cancel/status-write/refund order B", async () => {
    seedInProgress("ord_branch_race", { branchId: "branch_race_1" });
    savedDocs["branches/branch_race_2"] = { petpoojaStoreId: "store_race_2", name: "Second Branch" };

    // Inject branch change after resolution pre-read, but before/at tx get
    txHooks.beforeTxGet = async (path: string) => {
      if (path === "orders/ord_branch_race") {
        // Concurrently re-linked to branch 2
        savedDocs["orders/ord_branch_race"].branchId = "branch_race_2";
      }
    };

    // Untrusted callback arrives naming store_race_1 (which maps to branch_race_1)
    await handlePetpoojaWebhook(
      {
        order_id: "ord_branch_race",
        restID: "store_race_1",
        status: -1,
        cancel_reason: "Untrusted cancellation on moved order",
      },
      { authenticated: false }
    );

    // Order belongs to branch 2 at transaction time; untrusted callback for branch 1 must be refused
    expect(savedDocs["orders/ord_branch_race"].status).toMatchObject({
      code: "CONFIRMED",
      terminal: false,
    });
    expect(savedDocs["orders/ord_branch_race"].petpoojaKitchenStatus).toBeUndefined();
    expect(refundDocs()).toEqual([]);
    expect(writeMetrics.txSetCalls).toBe(0);

    // Event must be parked for review
    expect(savedDocs["unmatched_petpooja_orders/upo_ord_branch_race"]).toBeDefined();
    expect(savedDocs["unmatched_petpooja_orders/upo_ord_branch_race"].status).toBe("needs_review");
  });

  it("Race: POS id lookup matched order at pre-read, but POS id unbound/changed before tx read -> refuses to stamp accepted/synced on stale mapping", async () => {
    savedDocs["orders/ord_pos_race"] = {
      id: "ord_pos_race",
      branchId: "branch_race_1",
      petpoojaOrderId: "PP-RACE-1",
      petpoojaStatus: "pending_retry",
      status: { code: "PENDING", label: "Pending", kind: "upcoming", terminal: false },
    };

    // Before tx get on ord_pos_race, simulate concurrent POS re-mapping
    txHooks.beforeTxGet = async (path: string) => {
      if (path === "orders/ord_pos_race") {
        savedDocs["orders/ord_pos_race"].petpoojaOrderId = "PP-DIFFERENT";
      }
    };

    // Callback with proven POS id PP-RACE-1
    await handlePetpoojaWebhook({
      restID: "store_race_1",
      orderID: "PP-RACE-1",
      status: "Accept",
    });

    // Should not turn stale proven mapping into new proof:
    // Order must NOT be stamped synced or have kitchen status updated on stale binding
    expect(savedDocs["orders/ord_pos_race"].petpoojaStatus).toBe("pending_retry");
    expect(savedDocs["orders/ord_pos_race"].petpoojaKitchenStatus).toBeUndefined();
    expect(writeMetrics.txSetCalls).toBe(0);

    // Event parked for review
    expect(savedDocs["unmatched_petpooja_orders/upo_PP-RACE-1"]).toBeDefined();
    expect(savedDocs["unmatched_petpooja_orders/upo_PP-RACE-1"].status).toBe("needs_review");
  });
});
