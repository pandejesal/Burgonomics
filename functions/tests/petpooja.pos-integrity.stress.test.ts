import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// POS-integrity stress sweep (2026-10-24) — regressions for:
//   F3  a POS ACK whose Firestore write fails must park reconciliation_required
//       (never pending_retry → a re-POST duplicates the kitchen ticket).
//   F5  the in-process claim must stamp petpoojaStatus="processing" so a hard
//       kill during the POST is found by the retry worker's crash lane.
//   F6  an inbound 86ing that loses the version race must NOT answer success
//       and must NOT be silently dropped (retryable → Petpooja redelivers).
//   F7  a truncated menu feed must not retire the branch's catalogue, and a SKU
//       that re-appears must lose its ghostRetired tombstone.
// (F8 lives in petpooja.status-callback-race.stress.test.ts, next to the other
// unauthenticated-callback contract tests.)
//
// Harness: in-memory Firestore with real-ish get/set/update(+precondition),
// updateTime metadata, indexed where/orderBy/limit/startAfter, batch and a
// reads-before-writes transaction. No provider is contacted: global fetch is
// stubbed in every suite.
// ---------------------------------------------------------------------------

const { mockDb, savedDocs, docMetadata, setMockDoc, hooks } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  const docMetadata: Record<string, { updateTime: any }> = {};
  let versionCounter = 100;
  const hooks: { failNextAcceptanceWrite?: boolean } = {};

  const clone = (value: any) =>
    value === undefined ? undefined : JSON.parse(JSON.stringify(value));

  const makeTimestamp = (v: number) => ({
    seconds: Math.floor(v),
    nanoseconds: 0,
    toMillis: () => v * 1000,
    isEqual: (other: any) =>
      other && typeof other.toMillis === "function" && other.toMillis() === v * 1000,
  });

  const touch = (path: string) => {
    docMetadata[path] = { updateTime: makeTimestamp(versionCounter++) };
  };

  const setMockDoc = (path: string, data: any) => {
    savedDocs[path] = clone(data);
    touch(path);
  };

  const docRef = (col: string, id: string) => {
    const path = `${col}/${id}`;
    const ref: any = {
      id,
      path,
      get: vi.fn(async () => {
        const exists = Object.prototype.hasOwnProperty.call(savedDocs, path);
        return {
          exists,
          data: () => (exists ? clone(savedDocs[path]) : undefined),
          updateTime: docMetadata[path]?.updateTime,
          ref,
        };
      }),
      set: vi.fn(async (data: any, opts?: any) => {
        // F3 injection: reject the FIRST write that records a POS acceptance —
        // exactly the write the old code let fall into the pending_retry catch.
        if (
          hooks.failNextAcceptanceWrite &&
          data &&
          (data.petpoojaOrderId !== undefined || data.petpoojaAcceptedNoId !== undefined)
        ) {
          hooks.failNextAcceptanceWrite = false;
          throw new Error("simulated Firestore rejection while recording the POS ack");
        }
        savedDocs[path] =
          opts?.merge && savedDocs[path]
            ? { ...savedDocs[path], ...clone(data) }
            : clone(data);
        touch(path);
      }),
      update: vi.fn(async (data: any, precondition?: any) => {
        if (!savedDocs[path]) throw new Error(`Document ${path} does not exist`);
        if (precondition?.lastUpdateTime && docMetadata[path]?.updateTime) {
          if (!docMetadata[path].updateTime.isEqual(precondition.lastUpdateTime)) {
            throw new Error(
              "FAILED_PRECONDITION: The precondition on the document was not met."
            );
          }
        }
        savedDocs[path] = { ...savedDocs[path], ...clone(data) };
        touch(path);
      }),
    };
    return ref;
  };

  const matchesFilters = (data: any, filters: Array<{ field: string; value: any }>) =>
    filters.every(({ field, value }) => data[field] === value);

  const query = (
    col: string,
    filters: Array<{ field: string; value: any }> = [],
    sortField?: string,
    sortDir: string = "asc",
    max: number = Infinity,
    afterId: string = ""
  ): any => ({
    where: (field: string, op: string, value: any) => {
      if (op !== "==") throw new Error(`Unsupported query operator: ${op}`);
      return query(col, [...filters, { field, value }], sortField, sortDir, max, afterId);
    },
    orderBy: (field: string, dir: string = "asc") =>
      query(col, filters, field, dir, max, afterId),
    limit: (n: number) => query(col, filters, sortField, sortDir, n, afterId),
    startAfter: (doc: { id: string }) =>
      query(col, filters, sortField, sortDir, max, doc.id),
    get: vi.fn(async () => {
      const rows = Object.keys(savedDocs)
        .filter((p) => p.startsWith(`${col}/`))
        .map((p) => ({ path: p, id: p.slice(col.length + 1), data: savedDocs[p] }))
        .filter((row) => row.id > afterId)
        .filter((row) => matchesFilters(row.data, filters))
        .sort((a, b) => {
          if (!sortField) return a.id > b.id ? 1 : -1;
          const va = sortField === "__name__" ? a.id : a.data[sortField] ?? 0;
          const vb = sortField === "__name__" ? b.id : b.data[sortField] ?? 0;
          if (va === vb) return 0;
          const order = va > vb ? 1 : -1;
          return sortDir === "desc" ? -order : order;
        })
        .slice(0, max)
        .map((row) => ({
          id: row.id,
          ref: docRef(col, row.id),
          exists: true,
          data: () => clone(row.data),
          updateTime: docMetadata[row.path]?.updateTime,
        }));
      return { docs: rows, empty: rows.length === 0 };
    }),
  });

  let autoId = 0;
  const makeBatch = () => ({
    set: (ref: any, data: any, opts?: any) => {
      savedDocs[ref.path] =
        opts?.merge && savedDocs[ref.path]
          ? { ...savedDocs[ref.path], ...clone(data) }
          : clone(data);
      touch(ref.path);
    },
    update: (ref: any, data: any) => {
      savedDocs[ref.path] = { ...(savedDocs[ref.path] || {}), ...clone(data) };
      touch(ref.path);
    },
    commit: async () => {},
  });

  const mockDb: any = {
    collection: (col: string) => ({
      ...query(col),
      doc: (id?: string) => docRef(col, id || `auto_${++autoId}`),
      add: async (data: any) => {
        const id = `auto_${++autoId}`;
        savedDocs[`${col}/${id}`] = clone(data);
        return { id };
      },
    }),
    batch: () => makeBatch(),
    runTransaction: vi.fn(async (fn: any) => {
      // Real Firestore rejects reads after writes; several code paths rely on
      // the ordering, so the double enforces it too.
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
        set: (ref: any, data: any, opts?: any) => {
          hasWritten = true;
          return ref.set(data, opts);
        },
        update: (ref: any, data: any, precondition?: any) => {
          hasWritten = true;
          return ref.update(data, precondition);
        },
      });
    }),
  };

  return { mockDb, savedDocs, docMetadata, setMockDoc, hooks };
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

import { pushOrderToPetpooja } from "../src/modules/petpooja/orderPush";
import { retryPendingPetpoojaOrdersWorker } from "../src/modules/petpooja/petpooja.scheduler";
import {
  handlePetpoojaStockWebhook,
  computeStockQuarantineDocId,
} from "../src/modules/petpooja/item86ingSync";
import { syncPetpoojaMenu } from "../src/modules/petpooja/menuSyncWebhook";
import { config } from "../src/config/env";

const fetchMock = vi.fn();
let prevMock = false;

beforeEach(() => {
  for (const key of Object.keys(savedDocs)) delete savedDocs[key];
  for (const key of Object.keys(docMetadata)) delete docMetadata[key];
  hooks.failNextAcceptanceWrite = false;
  prevMock = config.mock.petpoojaPos;
  config.mock.petpoojaPos = false; // live paths only
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  setMockDoc("branches/branch_pos_1", {
    name: "POS Integrity Branch",
    petpoojaStoreId: "res_pos_1",
    // H2 fixture — captured Petpooja tax catalogue (no builder default).
    petpoojaTaxes: [
      { id: "3928", name: "CGST", rate: 2.5 },
      { id: "3929", name: "SGST", rate: 2.5 },
    ],
  });
  setMockDoc("products/prod_branch_pos_1_7765862", {
    id: "prod_branch_pos_1_7765862",
    branchId: "branch_pos_1",
    petpoojaItemId: "7765862",
    petpoojaItemTaxIds: ["3928", "3929"],
    petpoojaTaxInclusive: false,
    petpoojaTaxUnsupported: false,
    petpoojaGstType: "goods",
  });
});

afterEach(() => {
  config.mock.petpoojaPos = prevMock;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const seedOrder = (id: string, extra: Record<string, any> = {}) => {
  setMockDoc(`orders/${id}`, {
    id,
    branchId: "branch_pos_1",
    customerName: "Integrity Customer",
    customerPhone: "+919825000123",
    items: [{ id: "itm_1", productId: "prod_branch_pos_1_7765862", petpoojaItemId: "7765862", name: "Burger", price: 199, quantity: 1 }],
    pricing: { grandTotal: 199, gst: 9.95 },
    status: "pending",
    ...extra,
  });
};

const posAck = (body: Record<string, any>) => ({
  ok: true,
  status: 200,
  json: async () => ({ success: "1", message: "Your order is saved.", ...body }),
});

const snapshotRows = () =>
  Object.keys(savedDocs).filter((p) => p.startsWith("dev_error_snapshots/"));

// ---------------------------------------------------------------------------
// F3 — duplicate KOT after a POS ack whose write fails
// ---------------------------------------------------------------------------
describe("F3 — POS ACK + failed acceptance write", () => {
  it("parks reconciliation_required (no retry burn) and never re-POSTs the ticket", async () => {
    seedOrder("ord_f3_id");
    fetchMock.mockResolvedValueOnce(posAck({ orderID: "PP-F3-1" }));
    hooks.failNextAcceptanceWrite = true;

    const first = await pushOrderToPetpooja("ord_f3_id");
    expect(first).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const doc = savedDocs["orders/ord_f3_id"];
    // The POST was acknowledged → an automatic retry would ring the kitchen
    // twice. Never pending_retry, never a retry-count increment.
    expect(doc.petpoojaStatus).toBe("reconciliation_required");
    expect(doc.petpoojaSyncStatus).toBe("reconciliation_required");
    expect(doc.petpoojaRetryCount).toBeUndefined();
    expect(doc.petpoojaAmbiguousProcessing).toBe(true);
    expect(doc.petpoojaAcceptedUnrecorded).toBe(true);
    // The ack itself is preserved so an operator can find the POS ticket.
    expect(doc.petpoojaOrderId).toBe("PP-F3-1");
    expect(doc.petpoojaPushClaimedAt).toBeNull();
    expect(doc.petpoojaClaimedAt).toBeNull();

    // The retry worker must not pick it up...
    const tick = await retryPendingPetpoojaOrdersWorker();
    expect(tick.retriedCount).toBe(0);
    expect(tick.failedCount).toBe(0);

    // ...and a direct replay dedupes on the recorded acceptance — no second POST.
    const replay = await pushOrderToPetpooja("ord_f3_id");
    expect(replay).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("an ID-less ack whose write fails also parks reconciliation_required and dedupes", async () => {
    seedOrder("ord_f3_noid");
    fetchMock.mockResolvedValueOnce(
      posAck({ restID: "31z58ciw0h", clientOrderID: "ord_f3_noid", orderID: "", code: 200 })
    );
    hooks.failNextAcceptanceWrite = true;

    const first = await pushOrderToPetpooja("ord_f3_noid");
    expect(first).toBe(false);

    const doc = savedDocs["orders/ord_f3_noid"];
    expect(doc.petpoojaStatus).toBe("reconciliation_required");
    expect(doc.petpoojaRetryCount).toBeUndefined();
    expect(doc.petpoojaOrderId).toBeUndefined();
    // The id-less acceptance marker survives the failed write, so the duplicate
    // guard still holds even though the POS never issued an id.
    expect(doc.petpoojaAcceptedNoId).toBe(true);
    expect(String(doc.petpoojaAcceptedAck)).toMatch(/Your order is saved/);

    const replay = await pushOrderToPetpooja("ord_f3_noid");
    expect(replay).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// F5 — a hard kill during the POST must be visible to the crash lane
// ---------------------------------------------------------------------------
describe("F5 — in-process claim visibility", () => {
  it("stamps petpoojaStatus=processing, so a stale claim is parked with an alert and no re-POST", async () => {
    seedOrder("ord_f5");
    // The POST never resolves: this is the process dying mid-flight (the catch
    // below never runs, which is exactly the silent-drop shape).
    fetchMock.mockImplementationOnce(() => new Promise(() => {}));

    void pushOrderToPetpooja("ord_f5");
    await new Promise((r) => setImmediate(r));

    const inFlight = savedDocs["orders/ord_f5"];
    expect(inFlight.petpoojaStatus).toBe("processing");
    expect(inFlight.petpoojaPushClaimedAt).toBeGreaterThan(0);

    // Age the lease past the worker's TTL without ever finishing the POST.
    savedDocs["orders/ord_f5"].petpoojaPushClaimedAt = Date.now() - 11 * 60 * 1000;

    const tick = await retryPendingPetpoojaOrdersWorker();
    expect(tick.failedCount).toBe(1);
    // The crash lane NEVER re-POSTs an ambiguous ticket.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const parked = savedDocs["orders/ord_f5"];
    expect(parked.petpoojaStatus).toBe("reconciliation_required");
    expect(parked.kotSyncFailed).toBe(true);
    expect(parked.petpoojaPushClaimedAt).toBeNull();
    expect(
      snapshotRows().some((path) =>
        String(savedDocs[path].message).includes("Stale processing claim detected")
      )
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// F6 — an 86ing that loses the version race must be retryable, never "success"
// ---------------------------------------------------------------------------
describe("F6 — inbound 86ing conflict is retryable, not a silent 200", () => {
  const seedProduct = () =>
    setMockDoc("products/prod_branch_pos_1_item_86", {
      id: "prod_branch_pos_1_item_86",
      branchId: "branch_pos_1",
      petpoojaItemId: "item_86",
      name: "86 Burger",
      inStock: true,
    });

  it("version conflict: returns retryable, preserves the newer local toggle, and parks the 86", async () => {
    seedProduct();

    // A concurrent writer (staff toggle) commits between the handler's initial
    // read and its transaction read.
    const origRunTx = mockDb.runTransaction;
    mockDb.runTransaction = vi.fn(async (fn: any) => {
      setMockDoc("products/prod_branch_pos_1_item_86", {
        id: "prod_branch_pos_1_item_86",
        branchId: "branch_pos_1",
        petpoojaItemId: "item_86",
        name: "86 Burger",
        inStock: true, // staff just re-enabled it
        price: 250, // ... and re-priced it
        localEdit: "staff-toggle",
      });
      return origRunTx(fn);
    });

    try {
      const result = await handlePetpoojaStockWebhook({
        rest_id: "res_pos_1",
        item_id: "item_86",
        in_stock: 0,
      });

      // NOT a success: the route answers 503 so Petpooja redelivers.
      expect(result.outcome).toBe("retry");
      expect(result.retryable).toBe(true);
      // The newer local value is not clobbered by an unconditional fallback...
      const product = savedDocs["products/prod_branch_pos_1_item_86"];
      expect(product.inStock).toBe(true);
      expect(product.price).toBe(250);
      expect(product.localEdit).toBe("staff-toggle");
      // ...and the 86 is not silently dropped: it is parked for an operator.
      const qId = computeStockQuarantineDocId("branch_pos_1", "item_86");
      expect(savedDocs[`unmatched_petpooja_stock/${qId}`]).toMatchObject({
        status: "needs_review",
        reason: "concurrent stock update",
        inStock: false,
      });
      expect(
        snapshotRows().some((path) =>
          String(savedDocs[path].message).includes("not applied")
        )
      ).toBe(true);
    } finally {
      mockDb.runTransaction = origRunTx;
    }
  });

  it("an unclassified transaction failure is reported retryable instead of falling off the end (silent drop)", async () => {
    seedProduct();
    const origRunTx = mockDb.runTransaction;
    mockDb.runTransaction = vi.fn(async () => {
      throw new Error("UNAVAILABLE: datastore hiccup");
    });

    try {
      const result = await handlePetpoojaStockWebhook({
        rest_id: "res_pos_1",
        item_id: "item_86",
        in_stock: 0,
      });
      expect(result.retryable).toBe(true);
      // Nothing was applied, but nothing pretended to be either.
      expect(savedDocs["products/prod_branch_pos_1_item_86"].inStock).toBe(true);
    } finally {
      mockDb.runTransaction = origRunTx;
    }
  });

  it("a clean apply still reports applied (the retry signal is not blanket)", async () => {
    seedProduct();
    const result = await handlePetpoojaStockWebhook({
      rest_id: "res_pos_1",
      item_id: "item_86",
      in_stock: 0,
    });
    expect(result).toEqual({ outcome: "applied", retryable: false });
    expect(savedDocs["products/prod_branch_pos_1_item_86"].inStock).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// F7 — proportional tombstone guard + SKU re-appearance
// ---------------------------------------------------------------------------
describe("F7 — menu tombstone guard", () => {
  const seedProduct = (itemId: string, extra: Record<string, any> = {}) =>
    setMockDoc(`products/prod_pos_branch_${itemId}`, {
      id: `prod_pos_branch_${itemId}`,
      branchId: "pos_branch",
      restId: "res_pos_1",
      petpoojaItemId: itemId,
      name: `Item ${itemId}`,
      price: 100,
      inStock: true,
      ...extra,
    });

  const feedItem = (itemId: string) => ({
    itemid: itemId,
    itemname: `Item ${itemId}`,
    price: 100,
    itemcategoryid: "cat_1",
    in_stock: 1,
    item_attributeid: "1",
  });

  beforeEach(() => {
    setMockDoc("branches/pos_branch", {
      name: "Truncated Feed Branch",
      petpoojaStoreId: "res_pos_1",
      petpoojaItemCount: 4,
    });
  });

  it("refuses to retire the catalogue on a truncated feed, raising a HIGH snapshot", async () => {
    for (const id of ["a", "b", "c", "d"]) seedProduct(id);

    // The feed carries ONE of four known SKUs — a truncated page, not a menu.
    const result = await syncPetpoojaMenu("pos_branch", undefined, {
      success: "1",
      items: [feedItem("a")],
    });
    expect(result.itemCount).toBe(1);

    // b/c/d stay orderable: the guard writes NOTHING.
    for (const id of ["b", "c", "d"]) {
      const doc = savedDocs[`products/prod_pos_branch_${id}`];
      expect(doc.inStock).toBe(true);
      expect(doc.ghostRetired).toBeUndefined();
    }
    expect(
      snapshotRows().some(
        (path) =>
          savedDocs[path].severity === "high" &&
          String(savedDocs[path].message).includes("REFUSED to retire ghost SKUs")
      )
    ).toBe(true);
    // The guard's own memory of the catalogue size is not lowered.
    expect(savedDocs["branches/pos_branch"].petpoojaItemCount).toBe(4);
  });

  it("still retires a genuinely absent SKU when the feed is complete", async () => {
    for (const id of ["a", "b", "c"]) seedProduct(id);

    await syncPetpoojaMenu("pos_branch", undefined, {
      success: "1",
      items: [feedItem("a"), feedItem("b")],
    });

    expect(savedDocs["products/prod_pos_branch_a"].inStock).toBe(true);
    expect(savedDocs["products/prod_pos_branch_b"].inStock).toBe(true);
    expect(savedDocs["products/prod_pos_branch_c"]).toMatchObject({
      inStock: false,
      ghostRetired: true,
    });
  });

  it("clears ghostRetired / ghostRetiredAt when a SKU returns to the feed", async () => {
    // One-SKU catalogue: the guard is not what this test is about.
    setMockDoc("branches/pos_branch", {
      name: "Zombie SKU Branch",
      petpoojaStoreId: "res_pos_1",
      petpoojaItemCount: 1,
    });
    seedProduct("ghost", {
      inStock: false,
      ghostRetired: true,
      ghostRetiredAt: "OLD_TOMBSTONE",
    });

    await syncPetpoojaMenu("pos_branch", undefined, {
      success: "1",
      items: [feedItem("ghost")],
    });

    const doc = savedDocs["products/prod_pos_branch_ghost"];
    expect(doc.inStock).toBe(true);
    expect(doc.ghostRetired).toBe(false);
    expect(doc.ghostRetiredAt).toBeNull();
  });
});
