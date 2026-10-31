import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockDb, savedDocs, docMetadata, setMockDoc } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  const docMetadata: Record<string, { updateTime: any }> = {};
  let versionCounter = 100;

  const makeTimestamp = (v: number) => ({
    seconds: Math.floor(v),
    nanoseconds: 0,
    toMillis: () => v * 1000,
    isEqual: (other: any) =>
      other && typeof other.toMillis === "function" && other.toMillis() === v * 1000,
  });

  const setMockDoc = (path: string, data: any) => {
    savedDocs[path] = { ...data };
    docMetadata[path] = { updateTime: makeTimestamp(versionCounter++) };
  };

  const docRef = (col: string, id: string) => {
    const path = `${col}/${id}`;
    return {
      id,
      path,
      get: vi.fn(async () => {
        const exists = Object.prototype.hasOwnProperty.call(savedDocs, path);
        const dataSnapshot = exists && savedDocs[path] ? JSON.parse(JSON.stringify(savedDocs[path])) : undefined;
        return {
          exists,
          data: () => (dataSnapshot ? JSON.parse(JSON.stringify(dataSnapshot)) : undefined),
          updateTime: docMetadata[path]?.updateTime,
          ref: docRef(col, id),
        };
      }),
      set: vi.fn(async (data: any, opts?: any) => {
        savedDocs[path] =
          opts?.merge && savedDocs[path] ? { ...savedDocs[path], ...data } : { ...data };
        docMetadata[path] = { updateTime: makeTimestamp(versionCounter++) };
      }),
      update: vi.fn(async (data: any, precondition?: any) => {
        if (!savedDocs[path]) throw new Error(`Document ${path} does not exist`);
        if (precondition?.lastUpdateTime && docMetadata[path]?.updateTime) {
          if (!docMetadata[path].updateTime.isEqual(precondition.lastUpdateTime)) {
            throw new Error("FAILED_PRECONDITION: The precondition on the document was not met.");
          }
        }
        savedDocs[path] = { ...savedDocs[path], ...data };
        docMetadata[path] = { updateTime: makeTimestamp(versionCounter++) };
      }),
    };
  };

  const mockDb: any = {
    collection: (col: string) => ({
      doc: (id: string) => docRef(col, id),
      where: (field: string, op: string, val: any) => ({
        limit: (n: number) => ({
          get: async () => {
            const matched = Object.entries(savedDocs)
              .filter(([p]) => p.startsWith(`${col}/`))
              .map(([p, data]) => {
                const id = p.slice(col.length + 1);
                return {
                  id,
                  ref: docRef(col, id),
                  data: () => JSON.parse(JSON.stringify(data)),
                  updateTime: docMetadata[p]?.updateTime,
                };
              })
              .filter((d) => d.data()[field] === val)
              .slice(0, n);
            return { docs: matched, empty: matched.length === 0 };
          },
        }),
      }),
    }),
    runTransaction: vi.fn(async (fn: any) => {
      return fn({
        get: async (ref: any) => ref.get(),
        set: async (ref: any, data: any, opts?: any) => ref.set(data, opts),
        update: async (ref: any, data: any, precondition?: any) => ref.update(data, precondition),
      });
    }),
  };
  return { mockDb, savedDocs, docMetadata, setMockDoc };
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

import {
  pushItemStockToPetpooja,
  handlePetpoojaStockWebhook,
  computeStockQuarantineDocId,
} from "../src/modules/petpooja/item86ingSync";
import { config } from "../src/config/env";

describe("Petpooja Stock Consistency & Canonical Product Updates (Part B)", () => {
  let prevMock: boolean;
  const fetchMock = vi.fn();

  beforeEach(() => {
    for (const key of Object.keys(savedDocs)) delete savedDocs[key];
    for (const key of Object.keys(docMetadata)) delete docMetadata[key];
    prevMock = config.mock.petpoojaPos;
    config.mock.petpoojaPos = false; // Live path
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);

    setMockDoc("branches/branch_ahmedabad_1", {
      name: "Ahmedabad Main",
      petpoojaStoreId: "res_ahm_01",
    });
  });

  afterEach(() => {
    config.mock.petpoojaPos = prevMock;
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("reproduces live POS stock push success updating canonical existing product in Firestore", async () => {
    setMockDoc("products/prod_branch_ahmedabad_1_item_burger_1", {
      id: "prod_branch_ahmedabad_1_item_burger_1",
      branchId: "branch_ahmedabad_1",
      petpoojaItemId: "item_burger_1",
      name: "Classic Smash Cheese Burger",
      inStock: true,
      updatedAt: 1000,
    });

    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        success: "1",
        message: "Item status updated successfully",
      }),
    });

    const res = await pushItemStockToPetpooja("branch_ahmedabad_1", "item_burger_1", false);
    expect(res).toBe(true);
    expect(savedDocs["products/prod_branch_ahmedabad_1_item_burger_1"].inStock).toBe(false);
  });

  it("guards against stale POS acknowledgement overwriting fresher UI toggle", async () => {
    const baseTime = 1700000000000;
    vi.useFakeTimers();
    vi.setSystemTime(baseTime);

    setMockDoc("products/prod_branch_ahmedabad_1_item_burger_2", {
      id: "prod_branch_ahmedabad_1_item_burger_2",
      branchId: "branch_ahmedabad_1",
      petpoojaItemId: "item_burger_2",
      name: "Bacon Burger",
      inStock: false,
      updatedAt: baseTime - 1000,
    });

    // Simulate in-flight delay where UI toggles item to true while old push for false is pending
    fetchMock.mockImplementationOnce(async () => {
      // Simulate race: Staff turns item back to true in UI with newer timestamp/updateTime
      setMockDoc("products/prod_branch_ahmedabad_1_item_burger_2", {
        id: "prod_branch_ahmedabad_1_item_burger_2",
        branchId: "branch_ahmedabad_1",
        petpoojaItemId: "item_burger_2",
        name: "Bacon Burger",
        inStock: true,
        updatedAt: baseTime + 2000,
      });

      return {
        ok: true,
        status: 200,
        json: async () => ({ success: "1", message: "Item status updated successfully" }),
      };
    });

    // Request was to set inStock: false initiated at baseTime
    const result = await pushItemStockToPetpooja("branch_ahmedabad_1", "item_burger_2", false);

    // Finding 2: Stale/local conflict after ACK returns false, never true!
    expect(result).toBe(false);
    // The newer UI toggle (inStock: true) must NOT have been overwritten by stale response!
    expect(savedDocs["products/prod_branch_ahmedabad_1_item_burger_2"].inStock).toBe(true);
  });

  it("detects race AFTER post-ACK read and equal milliseconds/clock skew without overwriting newer local stock", async () => {
    const baseTime = 1700000000000;
    vi.useFakeTimers();
    vi.setSystemTime(baseTime);

    setMockDoc("products/prod_branch_ahmedabad_1_item_burger_toctou", {
      id: "prod_branch_ahmedabad_1_item_burger_toctou",
      branchId: "branch_ahmedabad_1",
      petpoojaItemId: "item_burger_toctou",
      name: "TOCTOU Burger",
      inStock: true,
      updatedAt: baseTime,
    });

    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ success: "1", message: "Item status updated successfully" }),
    });

    // Emulate another writer committing a local toggle in the same millisecond (clock skew/equal ms)
    // right before our atomic commit phase
    const origRunTx = mockDb.runTransaction;
    mockDb.runTransaction = vi.fn(async (fn: any) => {
      // Simulate another client write landing concurrently
      setMockDoc("products/prod_branch_ahmedabad_1_item_burger_toctou", {
        id: "prod_branch_ahmedabad_1_item_burger_toctou",
        branchId: "branch_ahmedabad_1",
        petpoojaItemId: "item_burger_toctou",
        name: "TOCTOU Burger",
        inStock: true, // Local staff re-enabled stock in same ms
        updatedAt: baseTime, // Exact same millisecond wall clock
      });
      return origRunTx(fn);
    });

    try {
      const res = await pushItemStockToPetpooja("branch_ahmedabad_1", "item_burger_toctou", false);
      expect(res).toBe(false);
      // Canonical local stock is preserved and NOT overwritten
      expect(savedDocs["products/prod_branch_ahmedabad_1_item_burger_toctou"].inStock).toBe(true);
    } finally {
      mockDb.runTransaction = origRunTx;
    }
  });

  it("refuses stock push BEFORE wire when product doc has contradictory vendor item ownership or missing branch ownership", async () => {
    // Case 1: Product doc has contradictory petpoojaItemId metadata
    setMockDoc("products/prod_branch_ahmedabad_1_item_mismatch_1", {
      id: "prod_branch_ahmedabad_1_item_mismatch_1",
      branchId: "branch_ahmedabad_1",
      petpoojaItemId: "different_vendor_id_99",
      name: "Mismatched Item",
      inStock: true,
    });

    const res1 = await pushItemStockToPetpooja("branch_ahmedabad_1", "item_mismatch_1", false);
    expect(res1).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();

    // Case 2: Product doc has missing branch ownership (partial product)
    setMockDoc("products/prod_branch_ahmedabad_1_item_nobranch_1", {
      id: "prod_branch_ahmedabad_1_item_nobranch_1",
      name: "No Branch Item",
      inStock: true,
    });

    const res2 = await pushItemStockToPetpooja("branch_ahmedabad_1", "item_nobranch_1", false);
    expect(res2).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses to create orphan or partial product when product does not exist", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        success: "1",
        message: "Item status updated successfully",
      }),
    });

    const res = await pushItemStockToPetpooja("branch_ahmedabad_1", "nonexistent_item_999", false);
    expect(res).toBe(false);
    expect(savedDocs["products/prod_branch_ahmedabad_1_nonexistent_item_999"]).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not update canonical product on vendor rejection or network failure", async () => {
    setMockDoc("products/prod_branch_ahmedabad_1_item_burger_3", {
      id: "prod_branch_ahmedabad_1_item_burger_3",
      branchId: "branch_ahmedabad_1",
      petpoojaItemId: "item_burger_3",
      name: "Truffle Burger",
      inStock: true,
      updatedAt: 1000,
    });

    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      json: async () => ({ success: "0", message: "POS crash" }),
    });

    const res = await pushItemStockToPetpooja("branch_ahmedabad_1", "item_burger_3", false);
    expect(res).toBe(false);
    expect(savedDocs["products/prod_branch_ahmedabad_1_item_burger_3"].inStock).toBe(true);
  });

  it("incoming unlinked-outlet webhook does not mutate canonical products and writes bounded safe quarantine doc", async () => {
    // Unlinked rest_id (not in branches)
    await handlePetpoojaStockWebhook({
      rest_id: "unlinked_outlet_99",
      item_id: "pp_item_99",
      in_stock: 0,
    });

    expect(savedDocs["products/prod_unlinked_pp_item_99"]).toBeUndefined();
    const productKeys = Object.keys(savedDocs).filter((k) => k.startsWith("products/"));
    expect(productKeys).toHaveLength(0);

    const qId = computeStockQuarantineDocId("unlinked_outlet_99", "pp_item_99");
    const evidence = savedDocs[`unmatched_petpooja_stock/${qId}`];
    expect(evidence).toBeDefined();
    expect(evidence.restId).toBe("unlinked_outlet_99");
    expect(evidence.itemId).toBe("pp_item_99");
    expect(evidence.inStock).toBe(false);
    expect(evidence.rawInStock).toBe(0);
    expect(evidence.status).toBe("needs_review");
  });

  it("quarantine doc ID uses bounded safe hash and avoids path escape on slashes or oversized outlet IDs", async () => {
    // Malicious slash input and oversized string
    const unsafeOutlet = "outlet/with/path/escape/../../../etc/" + "X".repeat(500);
    const itemId = "item_safe_1";

    await handlePetpoojaStockWebhook({
      rest_id: unsafeOutlet,
      item_id: itemId,
      in_stock: 0,
    });

    const qId = computeStockQuarantineDocId(unsafeOutlet, itemId);
    // Bounded and safe format
    expect(qId).toMatch(/^ups_[a-f0-9]{32}$/);
    expect(qId.includes("/")).toBe(false);

    const evidence = savedDocs[`unmatched_petpooja_stock/${qId}`];
    expect(evidence).toBeDefined();
    expect(evidence.restId.length).toBeLessThanOrEqual(128);
    expect(evidence.itemId).toBe(itemId);
  });

  it("omitted in_stock maps to fail-closed false and writes defined/null marker without writing undefined", async () => {
    await handlePetpoojaStockWebhook({
      rest_id: "unlinked_outlet_omit",
      item_id: "pp_item_omit",
      // in_stock omitted entirely
    });

    const qId = computeStockQuarantineDocId("unlinked_outlet_omit", "pp_item_omit");
    const evidence = savedDocs[`unmatched_petpooja_stock/${qId}`];
    expect(evidence).toBeDefined();
    // Fail-closed to false
    expect(evidence.inStock).toBe(false);
    // rawInStock is null, never undefined
    expect(evidence.rawInStock).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(evidence, "rawInStock")).toBe(true);
    expect(evidence.rawInStock).not.toBeUndefined();
  });

  it("incoming stock webhook for existing product with branch or item ownership mismatch is parked for review instead of overwriting ownership", async () => {
    // Product exists at branch_ahmedabad_1, but has vendor item id pp_original_item
    setMockDoc("products/prod_branch_ahmedabad_1_pp_item_clobber", {
      id: "prod_branch_ahmedabad_1_pp_item_clobber",
      branchId: "branch_other_outlet", // Belongs to different branch!
      petpoojaItemId: "pp_original_item",
      inStock: true,
    });

    // Incoming webhook claims outlet res_ahm_01 (branch_ahmedabad_1)
    await handlePetpoojaStockWebhook({
      rest_id: "res_ahm_01",
      item_id: "pp_item_clobber",
      in_stock: 0,
    });

    // Existing product ownership must NOT be overwritten!
    const canonical = savedDocs["products/prod_branch_ahmedabad_1_pp_item_clobber"];
    expect(canonical.branchId).toBe("branch_other_outlet");
    expect(canonical.petpoojaItemId).toBe("pp_original_item");
    expect(canonical.inStock).toBe(true); // NOT clobbered!

    // Instead, evidence is safely quarantined
    const qId = computeStockQuarantineDocId("branch_ahmedabad_1", "pp_item_clobber");
    const evidence = savedDocs[`unmatched_petpooja_stock/${qId}`];
    expect(evidence).toBeDefined();
    expect(evidence.status).toBe("needs_review");
    expect(evidence.reason).toContain("ownership mismatch");
  });

  it("incoming stock webhook cannot overwrite newer concurrent staff toggle and is quarantined with reason 'concurrent stock update'", async () => {
    setMockDoc("products/prod_branch_ahmedabad_1_item_concurrent_86", {
      id: "prod_branch_ahmedabad_1_item_concurrent_86",
      branchId: "branch_ahmedabad_1",
      petpoojaItemId: "item_concurrent_86",
      name: "Concurrent Stock Burger",
      inStock: false,
    });

    // Staff toggles product concurrently right before webhook's commit transaction runs
    const origRunTx = mockDb.runTransaction;
    mockDb.runTransaction = vi.fn(async (fn: any) => {
      // Staff turns item back in stock in UI with newer updateTime
      setMockDoc("products/prod_branch_ahmedabad_1_item_concurrent_86", {
        id: "prod_branch_ahmedabad_1_item_concurrent_86",
        branchId: "branch_ahmedabad_1",
        petpoojaItemId: "item_concurrent_86",
        name: "Concurrent Stock Burger",
        inStock: true,
      });
      return origRunTx(fn);
    });

    try {
      await handlePetpoojaStockWebhook({
        rest_id: "res_ahm_01",
        item_id: "item_concurrent_86",
        in_stock: 0,
      });

      // Canonical state is preserved with staff's newer toggle (inStock: true)
      const canonical = savedDocs["products/prod_branch_ahmedabad_1_item_concurrent_86"];
      expect(canonical.inStock).toBe(true);

      // Conflicted webhook payload is quarantined with reason "concurrent stock update"
      const qId = computeStockQuarantineDocId("branch_ahmedabad_1", "item_concurrent_86");
      const evidence = savedDocs[`unmatched_petpooja_stock/${qId}`];
      expect(evidence).toBeDefined();
      expect(evidence.status).toBe("needs_review");
      expect(evidence.reason).toBe("concurrent stock update");
      expect(evidence.inStock).toBe(false);
    } finally {
      mockDb.runTransaction = origRunTx;
    }
  });
});
