import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockDb, savedDocs } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};

  const assertValidFirestoreDocId = (id: unknown) => {
    if (typeof id !== "string" || id.length === 0) {
      throw new Error(`Invalid Firestore doc ID: must be non-empty string, got ${JSON.stringify(id)}`);
    }
    if (id.includes("/")) {
      throw new Error(`Invalid Firestore doc ID: contains forward slash '/': ${id}`);
    }
    if (id === "." || id === "..") {
      throw new Error(`Invalid Firestore doc ID: cannot be '.' or '..': ${id}`);
    }
    if (/^__.*__$/.test(id)) {
      throw new Error(`Invalid Firestore doc ID: matches reserved regex __.*__: ${id}`);
    }
    if (Buffer.byteLength(id, "utf8") > 1500) {
      throw new Error(`Invalid Firestore doc ID: exceeds 1500 UTF-8 bytes (${Buffer.byteLength(id, "utf8")} bytes)`);
    }
  };

  const docRef = (col: string, id: string) => {
    assertValidFirestoreDocId(id);
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
    };
  };

  const batch = {
    set: vi.fn((ref: any, data: any) => {
      savedDocs[ref.path] = data;
    }),
    commit: vi.fn(async () => {}),
  };

  const query = (
    col: string,
    filters: Array<[string, string, any]> = [],
    max = Infinity,
    afterId = ""
  ): any => ({
    where: (field: string, op: string, value: any) =>
      query(col, [...filters, [field, op, value]], max, afterId),
    orderBy: (field: string) => {
      if (field !== "__name__") throw new Error(`Unsupported query order: ${field}`);
      return query(col, filters, max, afterId);
    },
    limit: (n: number) => query(col, filters, n, afterId),
    startAfter: (doc: { id: string }) => query(col, filters, max, doc.id),
    get: vi.fn(async () => {
      const docs = Object.keys(savedDocs)
        .filter((path) => path.startsWith(`${col}/`))
        .sort()
        .filter((path) => path.slice(col.length + 1) > afterId)
        .filter((path) =>
          filters.every(([field, op, value]) => {
            if (op !== "==") throw new Error(`Unsupported query operator: ${op}`);
            return savedDocs[path][field] === value;
          })
        )
        .slice(0, max)
        .map((path) => {
          const id = path.slice(col.length + 1);
          return { id, data: () => savedDocs[path], ref: docRef(col, id) };
        });
      return { empty: docs.length === 0, docs };
    }),
  });

  let autoIdCounter = 0;
  const mockDb: any = {
    collection: (col: string) => ({
      ...query(col),
      doc: (id?: string) => {
        const docId = id !== undefined ? id : `auto_${++autoIdCounter}`;
        return docRef(col, docId);
      },
    }),
    batch: () => batch,
    runTransaction: vi.fn(),
  };

  return { mockDb, savedDocs, batch };
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

import { syncPetpoojaMenu } from "../src/modules/petpooja/menuSyncWebhook";
import { config } from "../src/config/env";

describe("Petpooja menuSyncWebhook Firestore doc ID validation (F2 stress)", () => {
  let prevMock: boolean;

  beforeEach(() => {
    for (const key of Object.keys(savedDocs)) delete savedDocs[key];
    prevMock = config.mock.petpoojaPos;
    config.mock.petpoojaPos = true; // Use mock mode for isolated ingestion test
  });

  afterEach(() => {
    config.mock.petpoojaPos = prevMock;
  });

  it("skips malformed item IDs without aborting sync and logs anomaly census", async () => {
    savedDocs["branches/branch_test_1"] = {
      name: "Test Branch 1",
      petpoojaStoreId: "branch_test_1",
    };

    const incomingMenu = {
      success: "1",
      categories: [
        { categoryid: "cat_1", categoryname: "Burgers" },
      ],
      items: [
        // 1. Valid string vendor item
        {
          itemid: "valid_sku_101",
          itemname: "Valid Smash Burger",
          price: 199,
          itemcategoryid: "cat_1",
          in_stock: 1,
        },
        // 2. Real numeric vendor ID (should NOT be rejected by schema normalization)
        {
          itemid: 884422,
          itemname: "Numeric ID Burger",
          price: 249,
          itemcategoryid: "cat_1",
          in_stock: 1,
        },
        // 3. Malformed: contains slash
        {
          itemid: "vendor/slash/item",
          itemname: "Slash Burger",
          price: 150,
          itemcategoryid: "cat_1",
          in_stock: 1,
        },
        // 4. Malformed: empty string id
        {
          itemid: "",
          itemname: "Empty ID Item",
          price: 100,
          itemcategoryid: "cat_1",
          in_stock: 1,
        },
        // 5. Malformed: reserved doc name '.'
        {
          itemid: ".",
          itemname: "Dot Item",
          price: 110,
          itemcategoryid: "cat_1",
          in_stock: 1,
        },
        // 6. Malformed: reserved pattern '__reserved__'
        {
          itemid: "__reserved_special__",
          itemname: "Reserved Item",
          price: 120,
          itemcategoryid: "cat_1",
          in_stock: 1,
        },
        // 7. Malformed: exceeds 1500 UTF-8 bytes
        {
          itemid: "a".repeat(1600),
          itemname: "Overlong Item",
          price: 130,
          itemcategoryid: "cat_1",
          in_stock: 1,
        },
      ],
    };

    // Must NOT throw despite 5 malformed items
    const result = await syncPetpoojaMenu("branch_test_1", undefined, incomingMenu);

    // Valid items must be persisted
    expect(savedDocs["products/prod_branch_test_1_valid_sku_101"]).toBeDefined();
    expect(savedDocs["products/prod_branch_test_1_valid_sku_101"].name).toBe("Valid Smash Burger");

    expect(savedDocs["products/prod_branch_test_1_884422"]).toBeDefined();
    expect(savedDocs["products/prod_branch_test_1_884422"].name).toBe("Numeric ID Burger");
    expect(savedDocs["products/prod_branch_test_1_884422"].petpoojaItemId).toBe("884422");

    // Malformed items must NOT be saved
    expect(savedDocs["products/prod_branch_test_1_vendor/slash/item"]).toBeUndefined();

    // Sync log must record completed status and anomaly census
    const syncLogs = Object.keys(savedDocs)
      .filter((k) => k.startsWith("petpooja_sync_logs/"))
      .map((k) => savedDocs[k]);

    expect(syncLogs.length).toBeGreaterThan(0);
    const syncLog = syncLogs[0];
    expect(syncLog.status).toBe("COMPLETED");

    // Anomaly census must be present and reflect skipped malformed items
    expect(syncLog.malformedItemCount).toBe(5);
    expect(syncLog.anomalyCensus).toBeDefined();
    expect(syncLog.anomalyCensus["contains_slash"]).toBe(1);
    expect(syncLog.anomalyCensus["empty_or_missing_id"]).toBe(1);
    expect(syncLog.anomalyCensus["reserved_name"]).toBe(2);
    expect(syncLog.anomalyCensus["exceeds_1500_bytes"]).toBe(1);
  });

  it("preserves verbatim nonblank vendor string identity without aliasing, respects composed UTF8 limits, and tests live tombstone path", async () => {
    config.mock.petpoojaPos = false; // Live mode testing: enables ghost-SKU tombstone pass without network fetch

    savedDocs["branches/branch_live"] = {
      name: "Live Test Branch",
      petpoojaStoreId: "res_live_99",
    };

    // Pre-seed an existing item with padded vendor ID and an existing ghost SKU
    savedDocs["products/prod_branch_live_ sku_distinct "] = {
      id: "prod_branch_live_ sku_distinct ",
      petpoojaItemId: " sku_distinct ",
      name: "Existing Padded Item",
      branchId: "branch_live",
      inStock: true,
    };
    savedDocs["products/prod_branch_live_ghost_sku"] = {
      id: "prod_branch_live_ghost_sku",
      petpoojaItemId: "ghost_sku",
      name: "Ghost Item",
      branchId: "branch_live",
      inStock: true,
    };

    const incomingMenu = {
      success: "1",
      categories: [{ categoryid: "cat_live", categoryname: "Live Category" }],
      items: [
        // Exact non-padded
        {
          itemid: "sku_distinct",
          itemname: "Non-padded Item",
          price: 199,
          itemcategoryid: "cat_live",
          in_stock: 1,
        },
        // Whitespace-padded vendor ID (must NOT alias with "sku_distinct")
        {
          itemid: " sku_distinct ",
          itemname: "Padded Item",
          price: 219,
          itemcategoryid: "cat_live",
          in_stock: 1,
        },
        // Raw ASCII < 1500 (1490 bytes), but composed prod_branch_live_<id> exceeds 1500 bytes (1507 bytes)
        {
          itemid: "k".repeat(1490),
          itemname: "Composed Overlong Item",
          price: 150,
          itemcategoryid: "cat_live",
          in_stock: 1,
        },
        // Multibyte UTF-8 boundary: 400 4-byte glyphs = 1600 bytes
        {
          itemid: "🍔".repeat(400),
          itemname: "Multibyte Overlong Item",
          price: 160,
          itemcategoryid: "cat_live",
          in_stock: 1,
        },
      ],
    };

    // Ingest directly via push payload (no network fetch triggered)
    const result = await syncPetpoojaMenu("branch_live", undefined, incomingMenu);

    // 1. Both padded and non-padded documents must exist distinctly without aliasing
    expect(savedDocs["products/prod_branch_live_sku_distinct"]).toBeDefined();
    expect(savedDocs["products/prod_branch_live_sku_distinct"].petpoojaItemId).toBe("sku_distinct");
    expect(savedDocs["products/prod_branch_live_sku_distinct"].inStock).toBe(true);

    expect(savedDocs["products/prod_branch_live_ sku_distinct "]).toBeDefined();
    expect(savedDocs["products/prod_branch_live_ sku_distinct "].petpoojaItemId).toBe(" sku_distinct ");
    expect(savedDocs["products/prod_branch_live_ sku_distinct "].inStock).toBe(true);
    // Crucial: existing record must NOT have been ghost-retired due to whitespace normalization
    expect(savedDocs["products/prod_branch_live_ sku_distinct "].ghostRetired).toBeUndefined();

    // 2. Ghost SKU absent from feed MUST be retired
    expect(savedDocs["products/prod_branch_live_ghost_sku"].inStock).toBe(false);
    expect(savedDocs["products/prod_branch_live_ghost_sku"].ghostRetired).toBe(true);

    // 3. Composed overlong items must be skipped without batch throw
    expect(savedDocs[`products/prod_branch_live_${"k".repeat(1490)}`]).toBeUndefined();
    expect(savedDocs[`products/prod_branch_live_${"🍔".repeat(400)}`]).toBeUndefined();

    // 4. Anomaly census check
    const syncLogs = Object.keys(savedDocs)
      .filter((k) => k.startsWith("petpooja_sync_logs/"))
      .map((k) => savedDocs[k]);
    const latestLog = syncLogs[syncLogs.length - 1];
    expect(latestLog.status).toBe("COMPLETED");
    expect(latestLog.created).toBe(2);
    expect(latestLog.malformedItemCount).toBe(2);
    expect(latestLog.anomalyCensus["exceeds_1500_bytes"]).toBe(2);
  });
});
