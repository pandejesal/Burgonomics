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
import { PETPOOJA_MAX_RETRY_ATTEMPTS } from "../src/modules/petpooja/retryBackoff";
import { config } from "../src/config/env";

/**
 * One past the retry limit = retries exhausted. Kept relative to the shared
 * constant so a future schedule change cannot silently stop exercising the
 * dead-letter pass (the old fixtures pinned the literal 4).
 */
const EXHAUSTED_RETRY_COUNT = PETPOOJA_MAX_RETRY_ATTEMPTS + 1;

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
      price: 250,
      inStock: true,
      petpoojaItemTaxIds: ["3928", "3929"],
      petpoojaTaxInclusive: false,
      petpoojaTaxUnsupported: false,
      petpoojaGstType: "goods",
    };
  savedDocs[`orders/${id}`] = {
    id,
    fulfillment: "takeaway",
    paymentChannel: "razorpay",
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
    seedPending("ord_k2", EXHAUSTED_RETRY_COUNT); // retries exhausted at the scan
    control.deadLetterRacePath = "orders/ord_k2";

    const tick = await retryPendingPetpoojaOrdersWorker();
    expect(tick.failedCount).toBe(0);

    const doc = savedDocs["orders/ord_k2"];
    expect(doc.petpoojaStatus).toBe("synced");
    expect(doc.kotSyncFailed).toBeFalsy();
    expect(doc.petpoojaOrderId).toBe("pp_kot_live");
  });

  it("K2 (Astra F3): an exhausted row fails closed without atomic capability — no plain 'failed', no manual-entry alert", async () => {
    // ORACLE CORRECTION (approved, Astra F3). This case previously REQUIRED the
    // unsafe behaviour: a plain `failed` + `kotSyncFailed` merge and one
    // "enter manually" alert whenever runTransaction was missing. That contract
    // is wrong twice over:
    //   1. The plain write cannot see concurrent state — a late acceptance (a
    //      POS ack, or a send claim whose outcome is unknown) can be overwritten
    //      by a read-then-write with no atomic recheck, destroying the evidence
    //      that the ticket may already be at the kitchen.
    //   2. A missing transaction capability cannot support a manual-entry CLAIM.
    //      Telling the branch to type the KOT in by hand asserts it never
    //      printed — an unsupported assertion when the row's history is unknown.
    // So the dead-letter pass now fail-closes with ZERO mutation and ZERO
    // alerts; the row is left for the transactional lane or an operator. The
    // retained RED receipt f3-legacy-notx-oracle-red-r3 proves this is a
    // deliberate contract change, not a weakened assertion.
    delete (mockDb as any).runTransaction;
    mockDb.runTransaction = undefined;
    seedPending("ord_kf", EXHAUSTED_RETRY_COUNT);
    // Whole-row snapshot: nothing may change at all.
    const before = { ...savedDocs["orders/ord_kf"] };

    // fcmClient short-circuits in the vitest env BEFORE any transport send;
    // exercise the real messaging seam here (the hook this test exists for).
    const prevNodeEnv = process.env.NODE_ENV;
    const prevVitest = process.env.VITEST;
    process.env.NODE_ENV = "development";
    delete process.env.VITEST;

    try {
      const tick = await retryPendingPetpoojaOrdersWorker();
      // Nothing was dead-lettered: no failure to report.
      expect(tick.failedCount).toBe(0);

      const doc = savedDocs["orders/ord_kf"];
      // Byte-identical row: no status flip, no flag, no claim, no schedule.
      expect(doc).toEqual(before);
      expect(doc.petpoojaStatus).toBe("pending_retry");
      expect(doc.petpoojaStatus).not.toBe("failed");
      expect(doc.kotSyncFailed).not.toBe(true);
      // No alert of either kind: no error snapshot, no FCM push.
      const snapshots = Object.entries(savedDocs).filter(([p]) =>
        p.startsWith("dev_error_snapshots/")
      );
      expect(snapshots).toHaveLength(0);
      expect(messagingSendSpy).not.toHaveBeenCalled();
      // No retry budget burn, and no provider call.
      expect(doc.petpoojaRetryCount).toBe(EXHAUSTED_RETRY_COUNT);
      expect(fetchMock).not.toHaveBeenCalled();
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
    seedPending("ord_ambiguous_race", EXHAUSTED_RETRY_COUNT);
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

/**
 * Astra F2 (round 7) — the SCHEDULER's no-transaction stale-`processing`
 * fallback performs a fresh read and then a PLAIN `set` that rewrites the row
 * `reconciliation_required`.
 *
 * Nothing makes that write conditional on the state it read still being current.
 * A sender's late ACK that commits between the read and the write is therefore
 * written over: because the park is a `merge`, the acceptance ID fields survive,
 * but the acceptance STATE does not — `synced`/`accepted_unconfirmed` is replaced
 * by `reconciliation_required`, and the claim fields are cleared. An operator
 * reading that row is told the send is unresolved even though the POS recorded
 * it. (This is a state-integrity defect in the unguarded fallback; it is not a
 * claim that a duplicate KOT or a manual resend actually occurred.)
 *
 * The contract: a datastore without `runTransaction` cannot justify a
 * read-then-write quarantine at all. It must fail closed — write NOTHING, send
 * nothing, alert nobody — leaving the row for the transactional lane or an
 * operator. That is also strictly safer than today's park: a stale read cannot
 * be trusted to describe the row at write time.
 */
describe("Astra F2 — scheduler no-tx fallback must not write an unguarded quarantine", () => {
  const STALE_CLAIM_MS = 15 * 60 * 1000;

  /**
   * Installs a scoped Firestore shim for one order.
   *
   * The schedule is a REAL read-then-write race, not a frozen snapshot:
   *
   *  1. Query results are captured at SCAN time (a query naturally returns the
   *     documents as they were when it ran) — that is how the worker gets its
   *     stale candidate list.
   *  2. `ref.get()` captures `savedDocs[docPath]` AT THE MOMENT IT IS CALLED.
   *     So if a late ACK has already committed, a real read sees it and the
   *     fix's skip branch works; if not, the read legitimately returns
   *     `processing` and the unguarded plain `set` proceeds on stale data.
   *  3. The ACK is applied by the TEST (`applyLateAck()`), never by the shim.
   *     The test controls exactly when it lands, so it can be observed without
   *     pretending a datastore returned stale data.
   *
   * `timeline` records what each interested party saw, so a RED can show the
   * read captured `processing` BEFORE the external ACK.
   */
  function installNoTxHarness(orderId: string) {
    const path = `orders/${orderId}`;
    const writes: Array<{ id: string; path: string; data: any }> = [];
    const reads: Array<{ at: number; sawStatus: string }> = [];
    let ackApplied = false;
    let ackAt: number | null = null;

    const makeOrderDoc = (id: string, scanData: any) => {
      const docPath = `orders/${id}`;
      const ref: any = {
        id,
        path: docPath,
        get: async () => {
          // Capture the CURRENT document when the read happens.
          const current = { ...(savedDocs[docPath] ?? scanData) };
          reads.push({ at: Date.now(), sawStatus: String(current.petpoojaStatus) });
          return {
            exists: true,
            data: () => ({ ...current }),
            ref,
          };
        },
        set: async (data: any, opts?: any) => {
          writes.push({ id, path: docPath, data });
          savedDocs[docPath] =
            opts?.merge && savedDocs[docPath] ? { ...savedDocs[docPath], ...data } : { ...data };
        },
        update: async (data: any) => {
          writes.push({ id, path: docPath, data });
          savedDocs[docPath] = { ...(savedDocs[docPath] || {}), ...data };
        },
      };
      return { id, ref, data: () => ({ ...scanData }) };
    };

    const makeQuery = (filters: Array<[string, any]>): any => {
      const builder: any = {
        where: (f: string, _o: string, v: any) => makeQuery([...filters, [f, v]]),
        orderBy: () => builder,
        limit: () => builder,
        startAfter: () => builder,
        get: async () => {
          // A query returns documents as of NOW; snapshot each one so the
          // caller sees the scan-time values.
          const docs = Object.entries(savedDocs)
            .filter(([p]) => p.startsWith("orders/"))
            .map(([p, d]) => ({ id: p.slice("orders/".length), data: { ...(d as any) } }))
            .filter((entry) => filters.every(([f, v]) => entry.data[f] === v))
            .map((entry) => makeOrderDoc(entry.id, entry.data));
          return { docs, empty: docs.length === 0 };
        },
      };
      return builder;
    };

    const originalCollection = mockDb.collection;
    (mockDb as any).collection = (col: string) => {
      if (col !== "orders") return originalCollection(col);
      return {
        where: (f: string, o: string, v: any) => makeQuery([[f, v]]),
        doc: (id: string) =>
          id === orderId
            ? makeOrderDoc(id, { ...savedDocs[path] }).ref
            : (originalCollection(col) as any).doc(id),
      };
    };

    return {
      writes,
      reads,
      /** Commits the racing ACK. Called by the test, never by the shim. */
      applyLateAck: (ack: Record<string, any>) => {
        savedDocs[path] = { ...savedDocs[path], ...ack };
        ackApplied = true;
        ackAt = Date.now();
      },
      get ackApplied() {
        return ackApplied;
      },
      get ackAt() {
        return ackAt;
      },
      restore: () => {
        (mockDb as any).collection = originalCollection;
      },
    };
  }

  let prevMock: boolean;
  const fetchMock = vi.fn();

  beforeEach(() => {
    for (const key of Object.keys(savedDocs)) delete savedDocs[key];
    prevMock = config.mock.petpoojaPos;
    config.mock.petpoojaPos = false;
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    messagingSendSpy.mockClear();
    // No cross-suite leakage of the other describe's race anchors.
    control.deadLetterRacePath = null;
    control.deadLetterAmbiguousRacePath = null;
    control.postCommitRacerPath = null;
    control.raceApplied = false;
  });

  afterEach(() => {
    config.mock.petpoojaPos = prevMock;
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const seedExpiredProcessing = (id: string) => {
    seedPending(id);
    const doc = savedDocs[`orders/${id}`];
    doc.petpoojaStatus = "processing";
    doc.petpoojaSyncStatus = "processing";
    doc.petpoojaClaimedAt = Date.now() - STALE_CLAIM_MS;
    doc.petpoojaPushClaimedAt = Date.now() - STALE_CLAIM_MS;
    return doc;
  };

  const noAlerts = () => {
    const snapshots = Object.keys(savedDocs).filter((p) => p.startsWith("dev_error_snapshots/"));
    expect(snapshots).toHaveLength(0);
    expect(messagingSendSpy).not.toHaveBeenCalled();
  };

  it("no-tx stale processing row is left untouched — zero writes, zero POST, whole row preserved", async () => {
    // Decisive on its own, independent of any race: without an atomic recheck the
    // fallback must not mutate at all.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now());
    seedExpiredProcessing("ord_notx_stale");
    const before = { ...savedDocs["orders/ord_notx_stale"] };
    const harness = installNoTxHarness("ord_notx_stale");
    delete (mockDb as any).runTransaction;

    try {
      await retryPendingPetpoojaOrdersWorker();
    } finally {
      (mockDb as any).runTransaction = originalRunTransaction;
      harness.restore();
    }

    // The scheduler wrote nothing to the order.
    expect(harness.writes).toHaveLength(0);
    // Fail closed: no provider call, no alert of either kind.
    expect(fetchMock).not.toHaveBeenCalled();
    noAlerts();
    // The whole row is byte-identical.
    expect(savedDocs["orders/ord_notx_stale"]).toEqual(before);
    const doc = savedDocs["orders/ord_notx_stale"];
    expect(doc.petpoojaStatus).toBe("processing");
    expect(doc.petpoojaStatus).not.toBe("reconciliation_required");
    expect(doc.kotSyncFailed).not.toBe(true);
    expect(doc.petpoojaAmbiguousProcessing).not.toBe(true);
    // The claim fields are NOT cleared: nothing was decided about the send.
    expect(doc.petpoojaClaimedAt).toBe(before.petpoojaClaimedAt);
    expect(doc.petpoojaPushClaimedAt).toBe(before.petpoojaPushClaimedAt);
    expect(doc.petpoojaOrderId).toBeUndefined();
    expect(doc.petpoojaAcceptedNoId).toBeUndefined();
  });

  it("a late ID-bearing ACK after the no-tx stale read is never clobbered by a quarantine write", async () => {
    // Deterministic external schedule (see petpooja.scheduler.ts:144–148): the
    // worker's FIRST await is the already-resolved `processing` query. Starting
    // it and yielding one microtask lets that continuation reach the fallback
    // `ref.get()`; the ACK is then committed by the TEST, and the worker's
    // pending read promise resumes after it. Real order: read processing → ACK
    // lands → plain set (the defect) or no write (the fix).
    vi.useFakeTimers();
    vi.setSystemTime(Date.now());
    seedExpiredProcessing("ord_notx_race_id");
    const ACK = {
      petpoojaOrderId: "pp_notx_late_id",
      petpoojaStatus: "synced",
      petpoojaSyncStatus: "synced",
      petpoojaPushClaimedAt: null,
      petpoojaClaimedAt: null,
      lastPetpoojaError: null,
    };
    const harness = installNoTxHarness("ord_notx_race_id");
    delete (mockDb as any).runTransaction;

    try {
      const tick = retryPendingPetpoojaOrdersWorker();
      await Promise.resolve();
      // The ACK is committed by the TEST — never by the datastore shim.
      harness.applyLateAck(ACK);
      await tick;
    } finally {
      (mockDb as any).runTransaction = originalRunTransaction;
      harness.restore();
    }

    // The external ACK really landed after the scan.
    expect(harness.ackApplied).toBe(true);
    // Nothing was written over the acceptance.
    expect(harness.writes).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
    noAlerts();

    // In the RED, the fallback's read is proven to have captured `processing`
    // BEFORE the ACK: real read-then-write, not a fabricated stale snapshot.
    // (A fixed build may skip the read entirely; this is then simply vacuous
    // and the zero-write assertion above carries the oracle.)
    if (harness.reads.length > 0) {
      expect(harness.reads[0].sawStatus).toBe("processing");
    }

    // The recorded acceptance survives intact.
    const doc = savedDocs["orders/ord_notx_race_id"];
    expect(doc.petpoojaOrderId).toBe("pp_notx_late_id");
    expect(doc.petpoojaStatus).toBe("synced");
    expect(doc.petpoojaSyncStatus).toBe("synced");
    expect(doc.petpoojaStatus).not.toBe("reconciliation_required");
    expect(doc.kotSyncFailed).not.toBe(true);
    expect(doc.petpoojaAmbiguousProcessing).not.toBe(true);
    // The newer claims are not cleared by this caller.
    expect(doc.petpoojaPushClaimedAt).toBeNull();
    expect(doc.petpoojaClaimedAt).toBeNull();
    expect(doc.lastPetpoojaError).toBeNull();
    // No fabricated printing claim, and no second acceptance shape.
    expect(doc.kotPrinted).toBeUndefined();
    expect(doc.petpoojaAcceptedNoId).toBeUndefined();
  });

  it("a late ACCEPTED-NO-ID ACK after the no-tx stale read is never clobbered by a quarantine write", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now());
    seedExpiredProcessing("ord_notx_race_noid");
    const ACK = {
      petpoojaAcceptedNoId: true,
      petpoojaStatus: "accepted_unconfirmed",
      petpoojaSyncStatus: "accepted_unconfirmed",
      petpoojaPushClaimedAt: null,
      petpoojaClaimedAt: null,
      lastPetpoojaError: null,
    };
    const harness = installNoTxHarness("ord_notx_race_noid");
    delete (mockDb as any).runTransaction;

    try {
      const tick = retryPendingPetpoojaOrdersWorker();
      await Promise.resolve();
      harness.applyLateAck(ACK);
      await tick;
    } finally {
      (mockDb as any).runTransaction = originalRunTransaction;
      harness.restore();
    }

    expect(harness.ackApplied).toBe(true);
    expect(harness.writes).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
    noAlerts();
    if (harness.reads.length > 0) {
      expect(harness.reads[0].sawStatus).toBe("processing");
    }

    const doc = savedDocs["orders/ord_notx_race_noid"];
    expect(doc.petpoojaAcceptedNoId).toBe(true);
    expect(doc.petpoojaStatus).toBe("accepted_unconfirmed");
    expect(doc.petpoojaSyncStatus).toBe("accepted_unconfirmed");
    expect(doc.petpoojaStatus).not.toBe("reconciliation_required");
    expect(doc.kotSyncFailed).not.toBe(true);
    expect(doc.petpoojaAmbiguousProcessing).not.toBe(true);
    // An id-less acceptance never grows an invented POS id or print claim.
    expect(doc.petpoojaOrderId).toBeUndefined();
    expect(doc.kotPrinted).toBeUndefined();
  });
});
