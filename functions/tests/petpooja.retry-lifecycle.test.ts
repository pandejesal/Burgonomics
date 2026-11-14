import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockDb, savedDocs } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  const docRef = (col: string, id: string) => {
    const path = `${col}/${id}`;
    return {
      id,
      path,
      get: vi.fn(async () => ({
        exists: Object.prototype.hasOwnProperty.call(savedDocs, path),
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

  const mockDb: any = {
    collection: (col: string) => ({
      doc: (id: string) => docRef(col, id),
      where: (field: string, op: string, val: any) => {
        const queryBuilder = (
          filters: Array<{ field: string; val: any }>,
          sortField?: string,
          sortDir: string = "asc",
          limitCount?: number
        ): any => ({
          where: (f: string, o: string, v: any) =>
            queryBuilder([...filters, { field: f, val: v }], sortField, sortDir, limitCount),
          orderBy: (sf: string, dir: string = "asc") =>
            queryBuilder(filters, sf, dir, limitCount),
          limit: (n: number) => queryBuilder(filters, sortField, sortDir, n),
          get: async () => {
            let matched = Object.entries(savedDocs)
              .filter(([p]) => p.startsWith(`${col}/`))
              .map(([p, data]) => {
                const id = p.slice(col.length + 1);
                return {
                  id,
                  ref: docRef(col, id),
                  data: () => data,
                };
              })
              .filter((d) => {
                const data = d.data();
                return filters.every((filter) => data[filter.field] === filter.val);
              });
            if (sortField) {
              matched.sort((a, b) => {
                const va = a.data()[sortField] || 0;
                const vb = b.data()[sortField] || 0;
                return sortDir === "desc" ? (vb > va ? 1 : -1) : (va > vb ? 1 : -1);
              });
            }
            if (typeof limitCount === "number") {
              matched = matched.slice(0, limitCount);
            }
            return { docs: matched, empty: matched.length === 0 };
          },
        });
        return queryBuilder([{ field, val }]);
      },
    }),
    runTransaction: vi.fn(async (fn: any) => {
      // Finding 4 fake: strictly enforce that all reads occur before any writes
      let hasWritten = false;
      return fn({
        get: async (ref: any) => {
          if (hasWritten) {
            throw new Error("Firestore transactions require all reads to be executed before all writes.");
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
    }),
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

import { retryPendingPetpoojaOrdersWorker } from "../src/modules/petpooja/petpooja.scheduler";
import { pushOrderToPetpooja } from "../src/modules/petpooja/orderPush";
import { config } from "../src/config/env";

describe("Petpooja Retry Lifecycle & Scheduler Lease Mismatch (Part A)", () => {
  let prevMock: boolean;
  const fetchMock = vi.fn();

  beforeEach(() => {
    for (const key of Object.keys(savedDocs)) delete savedDocs[key];
    prevMock = config.mock.petpoojaPos;
    config.mock.petpoojaPos = false; // Live path
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);

    savedDocs["branches/branch_ahmedabad_1"] = {
      // H2 fixture — captured Petpooja tax catalogue (no builder default).
      petpoojaTaxes: [
        { id: "3928", name: "CGST", rate: 2.5 },
        { id: "3929", name: "SGST", rate: 2.5 },
      ],
      name: "Ahmedabad Main",
      petpoojaStoreId: "res_ahm_01",
    };
    // POS-11: POS lines are priced from the catalog (branch-scoped id).
    savedDocs["products/prod_branch_ahmedabad_1_7765862"] = {
      id: "prod_branch_ahmedabad_1_7765862",
      branchId: "branch_ahmedabad_1",
      petpoojaItemId: "7765862",
      price: 200,
      inStock: true,
      petpoojaItemTaxIds: ["3928", "3929"],
      petpoojaTaxInclusive: false,
      petpoojaTaxUnsupported: false,
      petpoojaGstType: "goods",
    };
  });

  afterEach(() => {
    config.mock.petpoojaPos = prevMock;
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("reproduces busy pusher returning false/deferred honestly instead of confirmed true", async () => {
    savedDocs["orders/ord_busy_1"] = {
      id: "ord_busy_1",
      branchId: "branch_ahmedabad_1",
      customerName: "Busy Case",
      customerPhone: "+919825000001",
      items: [{ id: "itm_1", productId: "prod_branch_ahmedabad_1_7765862", petpoojaItemId: "7765862", name: "Burger", price: 199, quantity: 1 }],
      pricing: { grandTotal: 199, gst: 9.95 },
      status: "pending",
      petpoojaPushClaimedAt: Date.now(), // Active push in flight
    };

    const result = await pushOrderToPetpooja("ord_busy_1");
    expect(result).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();

    // And accepted ID dedupe still returns true
    savedDocs["orders/ord_busy_1"].petpoojaOrderId = "pp_confirmed_123";
    const dedupeResult = await pushOrderToPetpooja("ord_busy_1");
    expect(dedupeResult).toBe(true);
  });

  it("reproduces scheduler lease mismatch suppressing sequential retries across time ticks", async () => {
    const baseTime = 1700000000000;
    vi.useFakeTimers();
    vi.setSystemTime(baseTime);

    savedDocs["orders/ord_seq_retry"] = {
      id: "ord_seq_retry",
      fulfillment: "takeaway", payment: { method: "cod" },
      branchId: "branch_ahmedabad_1",
      customerName: "Sequential Retry Test",
      customerPhone: "+919825000002",
      items: [{ id: "itm_1", productId: "prod_branch_ahmedabad_1_7765862", petpoojaItemId: "7765862", name: "Smash Burger", price: 250, quantity: 1 }],
      pricing: { grandTotal: 250, gst: 12.5 },
      status: "pending",
      petpoojaStatus: "pending_retry",
      petpoojaRetryCount: 0,
      createdAt: baseTime - 60000,
    };

    // First push attempt is refused IN-BAND by the POS (HTTP 200 +
    // {"success":"0"}). CLASS B: this case is about the scheduler's lease /
    // sequential-retry mechanics, and it used a 502 purely as a convenient
    // retryable stimulus. Since Astra Finding 1 a 5xx is AMBIGUOUS and no longer
    // retryable, so ONLY the stimulus changed — every assertion is unchanged.
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ success: "0", message: "Gateway down" }),
    });

    // Run scheduler tick 1
    const tick1 = await retryPendingPetpoojaOrdersWorker();
    expect(tick1.retriedCount).toBe(0);
    expect(tick1.failedCount).toBe(1);

    const docAfterTick1 = savedDocs["orders/ord_seq_retry"];
    expect(docAfterTick1.petpoojaStatus).toBe("pending_retry");
    expect(docAfterTick1.petpoojaRetryCount).toBe(1);

    // Stale scheduler claim check: advance time by 5 minutes
    vi.advanceTimersByTime(5 * 60 * 1000);

    // The POS refuses in-band again on the second attempt (same stimulus swap).
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ success: "0", message: "Gateway still down" }),
    });

    // Run scheduler tick 2
    const tick2 = await retryPendingPetpoojaOrdersWorker();
    expect(tick2.failedCount).toBe(1);
    const docAfterTick2 = savedDocs["orders/ord_seq_retry"];
    expect(docAfterTick2.petpoojaRetryCount).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("handles busy competitor during scheduler retry without clobbering active push or claiming success", async () => {
    const baseTime = 1700000000000;
    vi.useFakeTimers();
    vi.setSystemTime(baseTime);

    savedDocs["orders/ord_competing"] = {
      id: "ord_competing",
      branchId: "branch_ahmedabad_1",
      customerName: "Competing Push Test",
      customerPhone: "+919825000003",
      items: [{ id: "itm_1", productId: "prod_branch_ahmedabad_1_7765862", petpoojaItemId: "7765862", name: "Burger", price: 200, quantity: 1 }],
      pricing: { grandTotal: 200, gst: 10 },
      status: "pending",
      petpoojaStatus: "pending_retry",
      petpoojaRetryCount: 1,
      petpoojaPushClaimedAt: baseTime, // Competitor is actively pushing right now!
      createdAt: baseTime - 60000,
    };

    const tick = await retryPendingPetpoojaOrdersWorker();
    expect(tick.retriedCount).toBe(0);
    const doc = savedDocs["orders/ord_competing"];
    expect(doc.petpoojaRetryCount).toBe(1);
    expect(doc.petpoojaPushClaimedAt).toBe(baseTime);
  });

  it("scheduler transaction executes all reads before writes for >= 2 candidate docs without throwing", async () => {
    // Finding 4: In real Firestore, calling tx.get() after tx.set() throws immediately.
    // Ensure that when >= 2 candidates are claimed, the scheduler reads all snapshots first.
    const baseTime = 1700000000000;
    vi.useFakeTimers();
    vi.setSystemTime(baseTime);

    savedDocs["orders/ord_cand_1"] = {
      id: "ord_cand_1",
      fulfillment: "takeaway", payment: { method: "cod" },
      branchId: "branch_ahmedabad_1",
      customerName: "Candidate 1",
      customerPhone: "+919825000004",
      items: [{ id: "itm_1", productId: "prod_branch_ahmedabad_1_7765862", petpoojaItemId: "7765862", name: "Burger 1", price: 150, quantity: 1 }],
      pricing: { grandTotal: 150, gst: 7.5 },
      status: "pending",
      petpoojaStatus: "pending_retry",
      petpoojaRetryCount: 0,
      createdAt: baseTime - 120000,
    };

    savedDocs["orders/ord_cand_2"] = {
      id: "ord_cand_2",
      fulfillment: "takeaway", payment: { method: "cod" },
      branchId: "branch_ahmedabad_1",
      customerName: "Candidate 2",
      customerPhone: "+919825000005",
      items: [{ id: "itm_2", productId: "prod_branch_ahmedabad_1_7765862", petpoojaItemId: "7765862", name: "Burger 2", price: 180, quantity: 1 }],
      pricing: { grandTotal: 180, gst: 9.0 },
      status: "pending",
      petpoojaStatus: "pending_retry",
      petpoojaRetryCount: 0,
      createdAt: baseTime - 60000,
    };

    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: "1", orderID: "pp_ack_cand" }),
    });

    // If the claim transaction interleaves get() and set(), mockDb.runTransaction throws
    const result = await retryPendingPetpoojaOrdersWorker();
    expect(result.retriedCount).toBe(2);
    expect(result.failedCount).toBe(0);
    expect(savedDocs["orders/ord_cand_1"].petpoojaStatus).toBe("synced");
    expect(savedDocs["orders/ord_cand_2"].petpoojaStatus).toBe("synced");
  });

  it("crash visibility: stale processing claim is detected, fresh tx rechecks and parks for manual reconciliation with kotSyncFailed without provider POST", async () => {
    // Finding 6: Pusher crashed mid-flight leaving doc in 'processing' with stale lease (>10m)
    const baseTime = 1700000000000;
    vi.useFakeTimers();
    vi.setSystemTime(baseTime);

    savedDocs["orders/ord_crashed_processing"] = {
      id: "ord_crashed_processing",
      branchId: "branch_ahmedabad_1",
      customerName: "Crashed Pusher Order",
      customerPhone: "+919825000006",
      items: [{ id: "itm_1", productId: "prod_branch_ahmedabad_1_7765862", petpoojaItemId: "7765862", name: "Burger", price: 200, quantity: 1 }],
      pricing: { grandTotal: 200, gst: 10 },
      status: "pending",
      petpoojaStatus: "processing",
      petpoojaClaimedAt: baseTime - 15 * 60 * 1000, // 15 mins ago (stale lease)
      createdAt: baseTime - 20 * 60 * 1000,
    };

    const tick = await retryPendingPetpoojaOrdersWorker();
    // Failed count incremented due to parked reconciliation
    expect(tick.failedCount).toBe(1);
    // CRITICAL: NO provider POST is executed!
    expect(fetchMock).not.toHaveBeenCalled();

    const doc = savedDocs["orders/ord_crashed_processing"];
    expect(doc.petpoojaStatus).toBe("reconciliation_required");
    expect(doc.kotSyncFailed).toBe(true);
    expect(doc.petpoojaAmbiguousProcessing).toBe(true);
    expect(doc.petpoojaClaimedAt).toBeNull();

    // Now verify direct push is BLOCKED on this order by the reconciliation marker!
    const directRes = await pushOrderToPetpooja("ord_crashed_processing");
    expect(directRes).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("crash visibility: active competitor or live processing push is not parked or clobbered", async () => {
    const baseTime = 1700000000000;
    vi.useFakeTimers();
    vi.setSystemTime(baseTime);

    savedDocs["orders/ord_live_processing"] = {
      id: "ord_live_processing",
      branchId: "branch_ahmedabad_1",
      customerName: "Live Processing Order",
      customerPhone: "+919825000007",
      items: [{ id: "itm_1", productId: "prod_branch_ahmedabad_1_7765862", petpoojaItemId: "7765862", name: "Burger", price: 200, quantity: 1 }],
      pricing: { grandTotal: 200, gst: 10 },
      status: "pending",
      petpoojaStatus: "processing",
      petpoojaClaimedAt: baseTime - 2 * 60 * 1000, // Only 2 mins ago (fresh lease)
      createdAt: baseTime - 5 * 60 * 1000,
    };

    const tick = await retryPendingPetpoojaOrdersWorker();
    expect(tick.failedCount).toBe(0);
    expect(tick.retriedCount).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();

    // Remains untouched
    const doc = savedDocs["orders/ord_live_processing"];
    expect(doc.petpoojaStatus).toBe("processing");
    expect(doc.kotSyncFailed).toBeUndefined();
  });

  it("crash visibility: accepted racer is preserved and not overwritten to reconciliation or pending_retry", async () => {
    const baseTime = 1700000000000;
    vi.useFakeTimers();
    vi.setSystemTime(baseTime);

    // Stale lease timestamp, but an accepted racer won and stamped petpoojaOrderId!
    savedDocs["orders/ord_racer_processing"] = {
      id: "ord_racer_processing",
      branchId: "branch_ahmedabad_1",
      customerName: "Racer Won Order",
      customerPhone: "+919825000008",
      items: [{ id: "itm_1", productId: "prod_branch_ahmedabad_1_7765862", petpoojaItemId: "7765862", name: "Burger", price: 200, quantity: 1 }],
      pricing: { grandTotal: 200, gst: 10 },
      status: "pending",
      petpoojaStatus: "processing",
      petpoojaOrderId: "pp_racer_confirmed_999",
      petpoojaClaimedAt: baseTime - 15 * 60 * 1000,
      createdAt: baseTime - 20 * 60 * 1000,
    };

    const tick = await retryPendingPetpoojaOrdersWorker();
    expect(tick.failedCount).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();

    const doc = savedDocs["orders/ord_racer_processing"];
    // Accepted order id preserved
    expect(doc.petpoojaOrderId).toBe("pp_racer_confirmed_999");
    expect(doc.kotSyncFailed).toBeUndefined();
  });

  it("claim transaction blocks push and makes 0 fetch calls when order is parked for reconciliation during pre-read race", async () => {
    savedDocs["orders/ord_pre_read_reconcile"] = {
      id: "ord_pre_read_reconcile",
      branchId: "branch_ahmedabad_1",
      customerName: "Pre-read Reconcile Order",
      customerPhone: "+919825000010",
      items: [{ id: "itm_1", productId: "prod_branch_ahmedabad_1_7765862", petpoojaItemId: "7765862", name: "Burger", price: 200, quantity: 1 }],
      pricing: { grandTotal: 200, gst: 10 },
      status: "pending",
      petpoojaStatus: "processing", // initial pre-read passes reconciliation guard at line 466
      createdAt: Date.now() - 60000,
    };

    // Before tx executes get(), simulate another worker/scheduler parking the doc for reconciliation
    const origRunTx = mockDb.runTransaction;
    mockDb.runTransaction = vi.fn(async (fn: any) => {
      // Doc is parked concurrently right before/during transaction
      savedDocs["orders/ord_pre_read_reconcile"].petpoojaStatus = "reconciliation_required";
      savedDocs["orders/ord_pre_read_reconcile"].petpoojaAmbiguousProcessing = true;
      savedDocs["orders/ord_pre_read_reconcile"].kotSyncFailed = true;
      return origRunTx(fn);
    });

    try {
      const result = await pushOrderToPetpooja("ord_pre_read_reconcile");
      expect(result).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      mockDb.runTransaction = origRunTx;
    }
  });

  it("crash visibility: without runTransaction the stale processing row is left untouched (fail closed, no quarantine write)", async () => {
    // CONTRACT ORACLE CORRECTION (approved). This case previously REQUIRED the
    // unsafe behaviour: a non-transactional datastore doing a fresh read and then
    // a PLAIN `reconciliation_required` write — failedCount 1, kotSyncFailed,
    // ambiguity flags set, and both claim fields cleared.
    //
    // That contract was superseded by the approved fail-closed rule (Astra F2,
    // round 7): without `runTransaction` the fallback must NOT write a quarantine
    // at all. The read cannot be made conditional on the state still being
    // current, so a sender's late ACK — with a POS id or id-less — committing
    // between the read and the write would be written over: the merge keeps the
    // acceptance ID fields but replaces the acceptance STATE and clears the
    // claims, telling operators an already-recorded send is unresolved.
    //
    // The retained RED receipt for this change proves it is a deliberate contract
    // correction, not a weakened assertion: the expectation moved from
    // "parks with a plain write" to "writes nothing". The row is left for the
    // transactional lane or an operator.
    const baseTime = 1700000000000;
    vi.useFakeTimers();
    vi.setSystemTime(baseTime);

    savedDocs["orders/ord_nontx_stale_processing"] = {
      id: "ord_nontx_stale_processing",
      branchId: "branch_ahmedabad_1",
      customerName: "Non-Tx Stale Order",
      customerPhone: "+919825000011",
      items: [{ id: "itm_1", productId: "prod_branch_ahmedabad_1_7765862", petpoojaItemId: "7765862", name: "Burger", price: 200, quantity: 1 }],
      pricing: { grandTotal: 200, gst: 10 },
      status: "pending",
      petpoojaStatus: "processing",
      petpoojaClaimedAt: baseTime - 15 * 60 * 1000, // 15 mins ago (stale lease)
      petpoojaPushClaimedAt: baseTime - 15 * 60 * 1000, // stale prior send claim
      createdAt: baseTime - 20 * 60 * 1000,
    };
    // Whole-row snapshot including the claim timestamps.
    const before = { ...savedDocs["orders/ord_nontx_stale_processing"] };

    const origRunTx = mockDb.runTransaction;
    delete (mockDb as any).runTransaction;

    try {
      const tick = await retryPendingPetpoojaOrdersWorker();
      // Nothing was quarantined: no failure to report, no retry, no POST.
      expect(tick.failedCount).toBe(0);
      expect(tick.retriedCount).toBe(0);
      expect(fetchMock).not.toHaveBeenCalled();

      // No alert of either kind was emitted for this row.
      const snapshots = Object.keys(savedDocs).filter((p) =>
        p.startsWith("dev_error_snapshots/")
      );
      expect(snapshots).toHaveLength(0);

      // Strongest form first: the whole row is byte-identical.
      expect(savedDocs["orders/ord_nontx_stale_processing"]).toEqual(before);

      const doc = savedDocs["orders/ord_nontx_stale_processing"];
      expect(doc.petpoojaStatus).toBe("processing");
      // No fabricated ambiguity or failure state.
      expect(doc.petpoojaStatus).not.toBe("reconciliation_required");
      expect(doc.petpoojaStatus).not.toBe("failed");
      expect(doc.kotSyncFailed).not.toBe(true);
      expect(doc.petpoojaAmbiguousProcessing).not.toBe(true);
      // The original leases are preserved, NOT cleared.
      expect(doc.petpoojaClaimedAt).toBe(before.petpoojaClaimedAt);
      expect(doc.petpoojaPushClaimedAt).toBe(before.petpoojaPushClaimedAt);
      expect(doc.petpoojaClaimedAt).not.toBeNull();
      expect(doc.petpoojaPushClaimedAt).not.toBeNull();
      // No acceptance or printing was invented.
      expect(doc.petpoojaOrderId).toBeUndefined();
      expect(doc.petpoojaAcceptedNoId).toBeUndefined();
      expect(doc.kotPrinted).toBeUndefined();
    } finally {
      mockDb.runTransaction = origRunTx;
    }
  });

  it("scheduler does not increment failedCount when pushOrderToPetpooja is deferred/busy due to in-flight push", async () => {
    const baseTime = 1700000000000;
    vi.useFakeTimers();
    vi.setSystemTime(baseTime);

    savedDocs["orders/ord_scheduler_busy"] = {
      id: "ord_scheduler_busy",
      branchId: "branch_ahmedabad_1",
      customerName: "Busy Push Test",
      customerPhone: "+919825000012",
      items: [{ id: "itm_1", productId: "prod_branch_ahmedabad_1_7765862", petpoojaItemId: "7765862", name: "Burger", price: 200, quantity: 1 }],
      pricing: { grandTotal: 200, gst: 10 },
      status: "pending",
      petpoojaStatus: "pending_retry",
      petpoojaRetryCount: 0,
      createdAt: baseTime - 60000,
    };

    // Simulate competitor claiming push right after scheduler claimed the doc in Phase 1/2
    const origRunTx = mockDb.runTransaction;
    let claimPass = 0;
    mockDb.runTransaction = vi.fn(async (fn: any) => {
      claimPass++;
      // On the second transaction (inside pushOrderToPetpooja claim tx), competitor has active push claim
      if (claimPass === 2) {
        savedDocs["orders/ord_scheduler_busy"].petpoojaPushClaimedAt = baseTime;
      }
      return origRunTx(fn);
    });

    try {
      const tick = await retryPendingPetpoojaOrdersWorker();
      expect(tick.retriedCount).toBe(0);
      expect(tick.failedCount).toBe(0); // NOT incremented when deferred/busy!
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      mockDb.runTransaction = origRunTx;
    }
  });

  it("clears both petpoojaClaimedAt and petpoojaPushClaimedAt on won racer outcome in orderPush catch handler", async () => {
    const baseTime = 1700000000000;
    vi.useFakeTimers();
    vi.setSystemTime(baseTime);

    savedDocs["orders/ord_won_racer_cleanup"] = {
      id: "ord_won_racer_cleanup",
      fulfillment: "takeaway", payment: { method: "cod" },
      branchId: "branch_ahmedabad_1",
      customerName: "Won Racer Cleanup",
      customerPhone: "+919825000014",
      items: [{ id: "itm_1", productId: "prod_branch_ahmedabad_1_7765862", petpoojaItemId: "7765862", name: "Burger", price: 200, quantity: 1 }],
      pricing: { grandTotal: 200, gst: 10 },
      status: "pending",
      petpoojaStatus: "processing",
      petpoojaClaimedAt: baseTime,
      createdAt: baseTime - 60000,
    };

    // When this caller executes fetch, a concurrent racer succeeds and stamps petpoojaOrderId,
    // while our fetch throws an error (e.g. gateway socket hangup).
    fetchMock.mockImplementationOnce(async () => {
      savedDocs["orders/ord_won_racer_cleanup"].petpoojaOrderId = "pp_racer_won_123";
      savedDocs["orders/ord_won_racer_cleanup"].petpoojaStatus = "synced";
      throw new Error("socket hang up after send");
    });

    const res = await pushOrderToPetpooja("ord_won_racer_cleanup");
    expect(res).toBe(true);
    const doc = savedDocs["orders/ord_won_racer_cleanup"];
    expect(doc.petpoojaOrderId).toBe("pp_racer_won_123");
    expect(doc.petpoojaClaimedAt).toBeNull();
    expect(doc.petpoojaPushClaimedAt).toBeNull();
  });

  it("a cancellation between the scheduler SCAN and the fresh claim is retired, never claimed or POSTed", async () => {
    // Astra Finding 3: the scan snapshot showed a live pending_retry row. Staff
    // cancel it before the claim transaction's fresh read. The fresh state must
    // retire the row instead of claiming and pushing it.
    const baseTime = 1700000000000;
    vi.useFakeTimers();
    vi.setSystemTime(baseTime);

    savedDocs["orders/ord_cancel_mid_scan"] = {
      id: "ord_cancel_mid_scan",
      fulfillment: "takeaway", payment: { method: "cod" },
      branchId: "branch_ahmedabad_1",
      customerName: "Mid-scan Cancel",
      customerPhone: "+919825000015",
      items: [{ id: "itm_1", productId: "prod_branch_ahmedabad_1_7765862", petpoojaItemId: "7765862", name: "Burger", price: 200, quantity: 1 }],
      pricing: { grandTotal: 200, gst: 10 },
      status: "pending",
      petpoojaStatus: "pending_retry",
      petpoojaRetryCount: 1,
      petpoojaNextRetryAtMs: baseTime - 1,
      createdAt: baseTime - 60000,
    };
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: "1", orderID: "pp_should_not_exist" }),
    });

    // Flip to CANCELLED inside the scheduler's claim transaction: the scan has
    // already happened, so the fresh read sees the terminal row.
    const origRunTx = mockDb.runTransaction;
    mockDb.runTransaction = vi.fn(async (fn: any) => {
      savedDocs["orders/ord_cancel_mid_scan"].status = {
        code: "CANCELLED",
        label: "Cancelled",
        kind: "cancelled",
        terminal: true,
      };
      return origRunTx(fn);
    });

    try {
      const tick = await retryPendingPetpoojaOrdersWorker();
      expect(tick.retriedCount).toBe(0);
    } finally {
      mockDb.runTransaction = origRunTx;
    }

    // No provider call for a closed order.
    expect(fetchMock).not.toHaveBeenCalled();
    const doc = savedDocs["orders/ord_cancel_mid_scan"];
    expect(doc.petpoojaStatus).not.toBe("processing");
    expect(doc.petpoojaStatus).not.toBe("synced");
    expect(doc.petpoojaOrderId).toBeUndefined();
    expect(doc.petpoojaAcceptedNoId).toBeUndefined();
    expect(doc.kotPrinted).toBeUndefined();
  });

  it("an EXHAUSTED non-terminal row with a live send claim is left untouched by the dead-letter pass", async () => {
    // Scan sees a spent-budget row; by the fresh recheck a sender holds a live
    // lease (status `processing`). A `failed` flip plus a manual-entry alert
    // would contradict an acceptance that can still land.
    const baseTime = 1700000000000;
    vi.useFakeTimers();
    vi.setSystemTime(baseTime);

    savedDocs["orders/ord_exhausted_active"] = {
      id: "ord_exhausted_active",
      fulfillment: "takeaway", payment: { method: "cod" },
      branchId: "branch_ahmedabad_1",
      customerName: "Exhausted Active",
      customerPhone: "+919825000016",
      items: [{ id: "itm_1", productId: "prod_branch_ahmedabad_1_7765862", petpoojaItemId: "7765862", name: "Burger", price: 200, quantity: 1 }],
      pricing: { grandTotal: 200, gst: 10 },
      status: "pending",
      petpoojaStatus: "pending_retry",
      petpoojaRetryCount: 99,
      petpoojaNextRetryAtMs: baseTime - 1,
      createdAt: baseTime - 60000,
    };

    // The fresh recheck sees a sender actively in flight.
    const origRunTx = mockDb.runTransaction;
    mockDb.runTransaction = vi.fn(async (fn: any) => {
      const doc = savedDocs["orders/ord_exhausted_active"];
      if (doc.petpoojaStatus === "pending_retry") {
        doc.petpoojaStatus = "processing";
        doc.petpoojaPushClaimedAt = baseTime - 2 * 60 * 1000;
      }
      return origRunTx(fn);
    });

    let tick: any;
    try {
      tick = await retryPendingPetpoojaOrdersWorker();
    } finally {
      mockDb.runTransaction = origRunTx;
    }

    expect(fetchMock).not.toHaveBeenCalled();
    expect(tick.failedCount).toBe(0);
    const doc = savedDocs["orders/ord_exhausted_active"];
    expect(doc.petpoojaStatus).not.toBe("failed");
    expect(doc.kotSyncFailed).not.toBe(true);
    expect(doc.petpoojaRetryCount).toBe(99);
    // No manual-entry notification of any kind.
    const alerts = Object.keys(savedDocs).filter((p) => p.startsWith("dev_error_snapshots/"));
    expect(alerts).toHaveLength(0);
  });
});
