import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * STRESS-TEST REPAIR RED/GREEN — KOT push transport-ambiguity + dead-letter
 * race (stress sweep 2026-10-24, Petpooja findings K1/K2).
 *
 * K1: `pushOrderToPetpooja` whose fetch TIMED OUT after the request was
 * written (AbortSignal.timeout → TimeoutError/AbortError) has an UNKNOWN
 * KOT state — the POS cloud may already have registered the ticket. The
 * catch block parked it as `pending_retry` (+1), and the 5-min worker
 * re-POSTed the same paid order — a duplicate kitchen ticket. The crash
 * lane (petpooja.scheduler.ts) already classifies this exact ambiguity as
 * `reconciliation_required` with NO new POST; the in-process path now
 * agrees. (Deliberately NOT reclassified: HTTP 5xx responses — the
 * retry-lifecycle suite pins those as retryable, the request provably did
 * not reach the origin cleanly.)
 *
 * K2: the retry worker's dead-letter pass (>3 attempts) writes `failed`
 * from a STALE scan snapshot with no re-read: a push that SUCCEEDED between
 * the scan and the dead-letter write is overwritten `synced → failed`, and
 * the branch gets "enter manually" for an order already at the POS.
 *
 * Reviewer pass (re-review, 2026-10-24): plus TWO pointed supplements —
 *   - the no-transaction environment: the dead-letter fallback must still
 *     flip the exhausted order (failed + kotSyncFailed + exactly one alert)
 *     instead of the old lying "wrote" default that wrote NOTHING;
 *   - a racer that commits AFTER the parked_ambiguous tx: the caller's
 *     post-tx fallback write must not clobber the concurrent winner.
 *
 * Harness mirrors petpooja.retry-lifecycle.test.ts.
 */
const { mockDb, savedDocs, control, messagingSendSpy, originalRunTransaction } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  // fcm.service resolves admin.messaging() → this stub; a real vi.fn() lets
  // the dead-letter alert be COUNTED (the old `{}` stub silently no-oped).
  const messagingSendSpy = vi.fn(async () => "mock_msg_id");
  const control: {
    deadLetterRacePath: string | null;
    raceApplied: boolean;
    postCommitRacerPath: string | null;
    deadLetterAmbiguousRacePath: string | null;
  } = { deadLetterRacePath: null, raceApplied: false, postCommitRacerPath: null, deadLetterAmbiguousRacePath: null };

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

  // K2 race injection: when the FIXED dead-letter pass re-reads the racing
  // doc inside its transaction, a successful push lands first (the winning
  // racer writes synced + an order id). Fires only inside runTransaction —
  // today's plain write never triggers it, so the defect stays RED.
  const runTransaction = vi.fn(async (fn: any) => {
    let hasWritten = false;
    // K1 race injection anchor: the racer must follow ONLY the tx that
    // actually committed the parked state (reconciliation_required) — the
    // push-claim tx also runs first and must stay untouched.
    let parkedWriteCommitted = false;
    const result = await fn({
      get: async (ref: any) => {
        if (hasWritten) {
          throw new Error("Firestore transactions require all reads to be executed before all writes.");
        }
        if (
          !control.raceApplied &&
          control.deadLetterRacePath &&
          ref.path === control.deadLetterRacePath
        ) {
          control.raceApplied = true;
          const racer = {
            petpoojaOrderId: "pp_kot_live",
            petpoojaStatus: "synced",
            petpoojaSyncStatus: "synced",
          };
          savedDocs[ref.path] = { ...(savedDocs[ref.path] || {}), ...racer };
        }
        if (
          !control.raceApplied &&
          control.deadLetterAmbiguousRacePath &&
          ref.path === control.deadLetterAmbiguousRacePath
        ) {
          control.raceApplied = true;
          const racer = {
            petpoojaStatus: "reconciliation_required",
            petpoojaSyncStatus: "reconciliation_required",
            petpoojaAmbiguousProcessing: true,
          };
          savedDocs[ref.path] = { ...(savedDocs[ref.path] || {}), ...racer };
        }
        return ref.get();
      },
      set: async (ref: any, data: any, opts?: any) => {
        if (
          control.postCommitRacerPath &&
          ref.path === control.postCommitRacerPath &&
          data?.petpoojaStatus === "reconciliation_required"
        ) {
          parkedWriteCommitted = true;
        }
        hasWritten = true;
        return ref.set(data, opts);
      },
      update: async (ref: any, data: any) => {
        hasWritten = true;
        return ref.update(data);
      },
    });
    // K1 race injection: the transaction COMMITTED a parked state — a
    // successful concurrent push then completes BEFORE the caller's
    // post-transaction fallback write. Mirrors the REAL racer success write
    // (synced fields + claim release; it does NOT touch kotSyncFailed).
    if (control.postCommitRacerPath && parkedWriteCommitted) {
      savedDocs[control.postCommitRacerPath] = {
        ...savedDocs[control.postCommitRacerPath],
        petpoojaOrderId: "pp_kot_live",
        petpoojaStatus: "synced",
        petpoojaSyncStatus: "synced",
        kotPushedAt: "MOCK_TIMESTAMP",
        petpoojaPushClaimedAt: null,
        petpoojaClaimedAt: null,
        updatedAt: "MOCK_TIMESTAMP",
      };
      control.postCommitRacerPath = null; // consume: only the parked tx carries a racer
    }
    return result;
  });

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
              .filter(([, data]) => filters.every((filter) => data[filter.field] === filter.val))
              .map(([p, data]) => {
                const id = p.slice(col.length + 1);
                return { id, ref: docRef(col, id), data: () => data };
              });
            if (sortField) {
              matched.sort((a, b) => {
                const va = a.data()[sortField] || 0;
                const vb = b.data()[sortField] || 0;
                return sortDir === "desc" ? (vb > va ? 1 : -1) : (va > vb ? 1 : -1);
              });
            }
            if (typeof limitCount === "number") matched = matched.slice(0, limitCount);
            return { docs: matched, empty: matched.length === 0 };
          },
        });
        return queryBuilder([{ field, val }]);
      },
    }),
    runTransaction,
  };
  return { mockDb, savedDocs, control, messagingSendSpy, originalRunTransaction: runTransaction };
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
  // Real send() so dispatchFCM's KOT-failed branch alert is observable.
  const messagingStub = { send: messagingSendSpy };
  return {
    default: {
      firestore: firestoreFn,
      auth: vi.fn(() => ({})),
      messaging: vi.fn(() => messagingStub),
      initializeApp: vi.fn(),
      apps: [{ name: "mock" }],
    },
    firestore: firestoreFn,
    auth: vi.fn(() => ({})),
    messaging: vi.fn(() => messagingStub),
    initializeApp: vi.fn(),
    apps: [{ name: "mock" }],
  };
});

import { retryPendingPetpoojaOrdersWorker } from "../src/modules/petpooja/petpooja.scheduler";
import { pushOrderToPetpooja } from "../src/modules/petpooja/orderPush";
import { config } from "../src/config/env";

const seedPending = (id: string, retryCount = 0, createdAt = 1700000000000 - 60000) => {
  savedDocs["branches/branch_ahmedabad_1"] = {
      // H2 fixture — captured Petpooja tax catalogue (no builder default).
      petpoojaTaxes: [
        { id: "3928", name: "CGST", rate: 2.5 },
        { id: "3929", name: "SGST", rate: 2.5 },
      ],
    name: "Ahmedabad Main",
    petpoojaStoreId: "res_ahm_01",
  };
    savedDocs["products/prod_branch_ahmedabad_1_7765862"] = {
      id: "prod_branch_ahmedabad_1_7765862",
      branchId: "branch_ahmedabad_1",
      petpoojaItemId: "7765862",
      petpoojaItemTaxIds: ["3928", "3929"],
      petpoojaTaxInclusive: false,
      petpoojaTaxUnsupported: false,
      petpoojaGstType: "goods",
    };
  savedDocs[`orders/${id}`] = {
    id,
    branchId: "branch_ahmedabad_1",
    customerName: "Ambiguous Case",
    customerPhone: "+919825000001",
    items: [{ id: "itm_1", productId: "prod_branch_ahmedabad_1_7765862", petpoojaItemId: "7765862", name: "Smash Burger", price: 250, quantity: 1 }],
    pricing: { grandTotal: 250, gst: 12.5 },
    status: "pending",
    paymentStatus: "completed",
    petpoojaStatus: "pending_retry",
    petpoojaRetryCount: retryCount,
    createdAt,
  };
};

describe("KOT push transport-ambiguity + dead-letter race (stress sweep)", () => {
  let prevMock: boolean;
  const fetchMock = vi.fn();

 beforeEach(() => {
    for (const key of Object.keys(savedDocs)) delete savedDocs[key];
    prevMock = config.mock.petpoojaPos;
    config.mock.petpoojaPos = false; // live path
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    control.deadLetterRacePath = null;
    control.deadLetterAmbiguousRacePath = null;
    control.raceApplied = false;
    control.postCommitRacerPath = null;
    messagingSendSpy.mockClear();
  });
  afterEach(() => {
    config.mock.petpoojaPos = prevMock;
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("K1 RED: a TIMED-OUT KOT POST is parked for reconciliation, never re-pushed", async () => {
    seedPending("ord_k1");
    fetchMock.mockRejectedValueOnce(
      Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" })
    );

    const pushed = await pushOrderToPetpooja("ord_k1");
    expect(pushed).toBe(false);

    const doc = savedDocs["orders/ord_k1"];
    // Ambiguity: request may have reached the POS. No blind retry lane.
    expect(doc.petpoojaStatus).toBe("reconciliation_required");
    expect(doc.petpoojaAmbiguousProcessing).toBe(true);
    expect(doc.petpoojaRetryCount).toBeFalsy(); // no retry-budget burn

    // The 5-min worker must NOT re-POST it.
    const tick = await retryPendingPetpoojaOrdersWorker();
    expect(tick.retriedCount).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("K2 RED: dead-letter never overwrites an order that was pushed after the scan", async () => {
    seedPending("ord_k2", 4); // retries exhausted at the scan
    control.deadLetterRacePath = "orders/ord_k2";

    const tick = await retryPendingPetpoojaOrdersWorker();
    expect(tick.failedCount).toBe(0);

    const doc = savedDocs["orders/ord_k2"];
    expect(doc.petpoojaStatus).toBe("synced");
    expect(doc.kotSyncFailed).toBeFalsy();
    expect(doc.petpoojaOrderId).toBe("pp_kot_live");
  });

  it("K2 (reviewer finding): exhausted order is still dead-lettered when runTransaction is unavailable — failed + kotSyncFailed + ONE alert", async () => {
    // No transaction-capable db in this environment (the exact hole the
    // first K2 fix left: the old no-tx default "wrote" never wrote, so the
    // order stayed pending_retry forever while ops was wrongly told the
    // flip had happened).
    delete (mockDb as any).runTransaction;
    mockDb.runTransaction = undefined;
    seedPending("ord_kf", 4); // exhausted at the scan, no tx protection

    // fcmClient short-circuits in the vitest env BEFORE any transport send;
    // exercise the real messaging seam here (the hook this test exists for).
    const prevNodeEnv = process.env.NODE_ENV;
    const prevVitest = process.env.VITEST;
    process.env.NODE_ENV = "development";
    delete process.env.VITEST;

    try {
      const tick = await retryPendingPetpoojaOrdersWorker();
      // The dead-letter pass must REPORT the fail-over (finance/ops truth):
      expect(tick.failedCount).toBe(1);

      const doc = savedDocs["orders/ord_kf"];
      expect(doc.petpoojaStatus).toBe("failed");
      expect(doc.kotSyncFailed).toBe(true);

      // Exactly one branch-visible alert: the error snapshot row + the
      // "enter manually" FCM push. No retry burn happened either.
      const snapshots = Object.entries(savedDocs).filter(([p]) =>
        p.startsWith("dev_error_snapshots/")
      );
      expect(snapshots).toHaveLength(1);
      expect(messagingSendSpy).toHaveBeenCalledTimes(1);
      expect(doc.petpoojaRetryCount).toBe(4); // no budget burn on dead-letter
    } finally {
      // Restore the default harness for sibling tests.
      if (prevVitest !== undefined) process.env.VITEST = prevVitest;
      process.env.NODE_ENV = prevNodeEnv;
      (mockDb as any).runTransaction = originalRunTransaction;
    }
  });

  it("K1 (reviewer finding): a racer that finishes AFTER the parked tx is not clobbered by the fallback write", async () => {
    // Transport-ambiguous POST parked inside the transaction; a successful
    // concurrent push then completes BEFORE the caller's post-tx fallback
    // write. The fallback (no re-read by construction) must be SKIPPED —
    // the committed tx outcome already parked the document.
    seedPending("ord_k1r");
    fetchMock.mockRejectedValueOnce(
      Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" })
    );
    control.postCommitRacerPath = "orders/ord_k1r";

    const pushed = await pushOrderToPetpooja("ord_k1r");
    expect(pushed).toBe(false); // still `false` for THIS caller — no lying success

    const doc = savedDocs["orders/ord_k1r"];
    // The racer's server truth survives: no fallback rewrite of the status.
    expect(doc.petpoojaStatus).toBe("synced");
    expect(doc.petpoojaSyncStatus).toBe("synced");
    expect(doc.petpoojaOrderId).toBe("pp_kot_live");
    // The racer cleared the push-claim lease (as it does in production).
    expect(doc.petpoojaClaimedAt).toBeNull();
    expect(doc.petpoojaPushClaimedAt).toBeNull();
  });

  it("F11 race: dead-letter transaction never overwrites a fresh ambiguous park and never alerts", async () => {
    seedPending("ord_ambiguous_race", 4);
    control.deadLetterAmbiguousRacePath = "orders/ord_ambiguous_race";

    const tick = await retryPendingPetpoojaOrdersWorker();
    expect(tick.failedCount).toBe(0);

    const doc = savedDocs["orders/ord_ambiguous_race"];
    expect(doc.petpoojaStatus).toBe("reconciliation_required");
    expect(doc.petpoojaSyncStatus).toBe("reconciliation_required");
    expect(doc.petpoojaAmbiguousProcessing).toBe(true);
    expect(doc.kotSyncFailed).toBeFalsy();

    const snapshots = Object.entries(savedDocs).filter(([p]) =>
      p.startsWith("dev_error_snapshots/")
    );
    expect(snapshots).toHaveLength(0);
    expect(messagingSendSpy).not.toHaveBeenCalled();
  });
});
