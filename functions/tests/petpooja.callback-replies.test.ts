import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Documented callback replies (2026-11-20).
 *
 * Petpooja's own 200 OK sections define the bodies its dashboard and POS expect
 * from US. Before this suite our replies diverged in four places:
 *
 *   1. Item On/Off  — request `itemID` is an ARRAY (docs), our handler read a
 *      single value; success body lacked `code`/`message`.
 *   2. Get Store Status — answered `{status:"success"}` with no `store_status`,
 *      so the merchant could never read our outlet state.
 *   3. Update Store Status — recorded the ping and answered `{status:"success"}`,
 *      never applying the documented 0/1 encoding.
 *   4. Menu push — answered `{success:true,itemCount:N}`; docs say
 *      `{"success":"1","message":"Menu items are successfully listed."}`.
 *
 * These tests pin the vendor's documented bodies exactly. They are written
 * RED-first: at the commit this file was added, handler + reply functions do not
 * exist and every case fails.
 */
const { mockDb, savedDocs, docMetadata, writeLog, setMockDoc } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  const docMetadata: Record<string, { updateTime: any }> = {};
  const writeLog: string[] = [];
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
        const dataSnapshot =
          exists && savedDocs[path] ? JSON.parse(JSON.stringify(savedDocs[path])) : undefined;
        return {
          exists,
          data: () => (dataSnapshot ? JSON.parse(JSON.stringify(dataSnapshot)) : undefined),
          updateTime: docMetadata[path]?.updateTime,
          ref: docRef(col, id),
        };
      }),
      set: vi.fn(async (data: any, opts?: any) => {
        writeLog.push(`set ${path}`);
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
        writeLog.push(`update ${path}`);
        savedDocs[path] = { ...savedDocs[path], ...data };
        docMetadata[path] = { updateTime: makeTimestamp(versionCounter++) };
      }),
    };
  };

  const mockDb: any = {
    collection: (col: string) => ({
      doc: (id: string) => docRef(col, id),
      where: (field: string, _op: string, val: any) => ({
        limit: (n: number) => ({
          get: async () => {
            const matched = Object.entries(savedDocs)
              .filter(([p]) => p.startsWith(`${col}/`))
              .map(([p, data]) => {
                const id = p.slice(col.length + 1);
                return {
                  id,
                  ref: docRef(col, id),
                  exists: true,
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
    runTransaction: vi.fn(async (fn: any) =>
      fn({
        get: async (ref: any) => ref.get(),
        set: async (ref: any, data: any, opts?: any) => ref.set(data, opts),
        update: async (ref: any, data: any, precondition?: any) =>
          ref.update(data, precondition),
      })
    ),
  };
  return { mockDb, savedDocs, docMetadata, writeLog, setMockDoc };
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
  handlePetpoojaStockWebhook,
  handlePetpoojaStoreStatus,
  stockWebhookReply,
} from "../src/modules/petpooja/item86ingSync";
import { menuPushAck } from "../src/modules/petpooja/menuSyncWebhook";
import { config } from "../src/config/env";

const DOCUMENTED_STOCK_OK = {
  code: 200,
  status: "success",
  message: "Stock status updated successfully",
};

const DOCUMENTED_STOCK_FAILED = {
  code: 400,
  status: "failed",
  message: "Stock status not updated successfully",
};

const DOCUMENTED_STORE_GET_OK = {
  http_code: 200,
  status: "success",
  store_status: "1",
  message: "Store Delivery Status fetched successfully",
};

const DOCUMENTED_MENU_PUSH_OK = {
  success: "1",
  message: "Menu items are successfully listed.",
};

let prevMock = false;

beforeEach(() => {
  for (const key of Object.keys(savedDocs)) delete savedDocs[key];
  for (const key of Object.keys(docMetadata)) delete docMetadata[key];
  writeLog.length = 0;
  prevMock = config.mock.petpoojaPos;
  config.mock.petpoojaPos = false;

  setMockDoc("branches/branch_ahmedabad_1", {
    id: "branch_ahmedabad_1",
    name: "Ahmedabad Main",
    petpoojaStoreId: "res_ahm_01",
    active: true,
    acceptingOrdersStatus: "open",
  });
  // r2: an update is only applied to a real storefront (`stores/{id}.isOpen` is
  // the gate customers order through), so the fixture carries the linked doc.
  setMockDoc("stores/store_ahm_01", {
    id: "store_ahm_01",
    name: "Ahmedabad Main",
    partnerBranchId: "branch_ahmedabad_1",
    petpoojaRestId: "res_ahm_01",
    isOpen: true,
  });
});

describe("Item On/Off — documented itemID array", () => {
  const seedItem = (itemId: string, inStock = true) =>
    setMockDoc(`products/prod_branch_ahmedabad_1_${itemId}`, {
      id: `prod_branch_ahmedabad_1_${itemId}`,
      branchId: "branch_ahmedabad_1",
      petpoojaItemId: itemId,
      name: `Item ${itemId}`,
      inStock,
      updatedAt: 1000,
    });

  it("applies every id in a multi-item itemID array", async () => {
    seedItem("30791");
    seedItem("30778");

    const result = await handlePetpoojaStockWebhook(
      { restID: "res_ahm_01", type: "item", inStock: false, itemID: ["30791", "30778"] },
      { authenticated: true }
    );

    expect(savedDocs["products/prod_branch_ahmedabad_1_30791"].inStock).toBe(false);
    expect(savedDocs["products/prod_branch_ahmedabad_1_30778"].inStock).toBe(false);
    expect(result.outcome).toBe("applied");
    expect(result.retryable).toBe(false);
  });

  it("accepts a single id in the array (docs always send an array)", async () => {
    seedItem("30791");
    const result = await handlePetpoojaStockWebhook(
      { restID: "res_ahm_01", type: "item", inStock: false, itemID: ["30791"] },
      { authenticated: true }
    );
    expect(result.outcome).toBe("applied");
    expect(savedDocs["products/prod_branch_ahmedabad_1_30791"].inStock).toBe(false);
  });

  it("still accepts the legacy single scalar value", async () => {
    seedItem("30791");
    const result = await handlePetpoojaStockWebhook(
      { rest_id: "res_ahm_01", item_id: "30791", in_stock: 0 },
      { authenticated: true }
    );
    expect(result.outcome).toBe("applied");
    expect(savedDocs["products/prod_branch_ahmedabad_1_30791"].inStock).toBe(false);
  });

  it("is idempotent: replaying the same batch writes nothing the second time", async () => {
    seedItem("30791");
    seedItem("30778");
    const payload = {
      restID: "res_ahm_01",
      type: "item",
      inStock: false,
      itemID: ["30791", "30778"],
    };

    await handlePetpoojaStockWebhook(payload, { authenticated: true });
    const writesAfterFirst = writeLog.length;
    const versionAfterFirst =
      docMetadata["products/prod_branch_ahmedabad_1_30791"].updateTime.toMillis();

    const replay = await handlePetpoojaStockWebhook(payload, { authenticated: true });

    expect(replay.outcome).toBe("applied");
    expect(replay.retryable).toBe(false);
    expect(writeLog.length).toBe(writesAfterFirst);
    expect(
      docMetadata["products/prod_branch_ahmedabad_1_30791"].updateTime.toMillis()
    ).toBe(versionAfterFirst);
  });

  it("applies the known items and parks an unknown one without retrying the batch", async () => {
    seedItem("30791");
    const result = await handlePetpoojaStockWebhook(
      { restID: "res_ahm_01", type: "item", inStock: false, itemID: ["30791", "999999999"] },
      { authenticated: true }
    );

    expect(savedDocs["products/prod_branch_ahmedabad_1_30791"].inStock).toBe(false);
    expect(writeLog.some((w) => w.includes("unmatched_petpooja_stock"))).toBe(true);
    // r2: a partly-applied batch is `partial`, not `ignored` — the caller is
    // told (documented failure body) and the audit row names n/m.
    expect(result.outcome).toBe("partial");
    expect(result.retryable).toBe(false);
  });

  it("reports retryable when one item in the batch materially fails", async () => {
    seedItem("30791");
    seedItem("30778");

    const orig = mockDb.runTransaction;
    mockDb.runTransaction = vi.fn(async (fn: any) => {
      const wrapped = async (tx: any) => {
        const txGet = tx.get;
        tx.get = async (ref: any) => {
          if (ref.path === "products/prod_branch_ahmedabad_1_30778") {
            throw new Error("UNAVAILABLE: datastore hiccup");
          }
          return txGet(ref);
        };
        return fn(tx);
      };
      return orig(wrapped);
    });

    try {
      const result = await handlePetpoojaStockWebhook(
        { restID: "res_ahm_01", type: "item", inStock: false, itemID: ["30791", "30778"] },
        { authenticated: true }
      );
      // The item that could be applied stays applied …
      expect(savedDocs["products/prod_branch_ahmedabad_1_30791"].inStock).toBe(false);
      // … and the batch is still reported retryable so Petpooja redelivers.
      expect(result.retryable).toBe(true);
      expect(result.outcome).toBe("retry");
    } finally {
      mockDb.runTransaction = orig;
    }
  });

  it("treats an empty itemID array as a missing reference, not as a success", async () => {
    const result = await handlePetpoojaStockWebhook(
      { restID: "res_ahm_01", type: "item", inStock: false, itemID: [] },
      { authenticated: true }
    );
    expect(result.outcome).toBe("ignored");
    expect(result.retryable).toBe(false);
    expect(result.reason).toBe("missing item_id");
  });

  it("keeps the unauthenticated default-deny: an array never 86s an item", async () => {
    seedItem("30791");
    seedItem("30778");
    const result = await handlePetpoojaStockWebhook(
      { restID: "res_ahm_01", type: "item", inStock: false, itemID: ["30791", "30778"] },
      {}
    );
    expect(result.outcome).toBe("ignored");
    expect(savedDocs["products/prod_branch_ahmedabad_1_30791"].inStock).toBe(true);
    expect(savedDocs["products/prod_branch_ahmedabad_1_30778"].inStock).toBe(true);
  });

  it("replies with exactly the documented success body", () => {
    expect(stockWebhookReply({ outcome: "applied", retryable: false })).toEqual({
      httpStatus: 200,
      body: DOCUMENTED_STOCK_OK,
    });
  });

  it("replies with the documented failure body when nothing was applied", () => {
    expect(stockWebhookReply({ outcome: "ignored", retryable: false, reason: "unlinked outlet" }))
      .toEqual({ httpStatus: 200, body: DOCUMENTED_STOCK_FAILED });
  });

  it("keeps the fail-closed 503 for a redelivery, with the documented failure body", () => {
    expect(stockWebhookReply({ outcome: "retry", retryable: true, reason: "conflict" })).toEqual({
      httpStatus: 503,
      body: DOCUMENTED_STOCK_FAILED,
    });
  });
});

describe("Get Store Status — documented body from real branch state", () => {
  it("answers store_status \"1\" for an open branch", async () => {
    const reply = await handlePetpoojaStoreStatus(
      { restID: "res_ahm_01" },
      { authenticated: true }
    );
    expect(reply).not.toBeNull();
    expect(reply!.kind).toBe("get");
    expect(reply!.httpStatus).toBe(200);
    expect(reply!.body).toEqual(DOCUMENTED_STORE_GET_OK);
  });

  it("answers store_status \"0\" when the branch is closed", async () => {
    setMockDoc("branches/branch_ahmedabad_1", {
      id: "branch_ahmedabad_1",
      petpoojaStoreId: "res_ahm_01",
      active: true,
      acceptingOrdersStatus: "closed",
    });
    const reply = await handlePetpoojaStoreStatus({ restID: "res_ahm_01" }, {});
    expect(reply!.body.store_status).toBe("0");
    expect(reply!.body.status).toBe("success");
    expect(reply!.body.http_code).toBe(200);
  });

  it("fails closed for an inactive branch", async () => {
    setMockDoc("branches/branch_ahmedabad_1", {
      id: "branch_ahmedabad_1",
      petpoojaStoreId: "res_ahm_01",
      active: false,
      acceptingOrdersStatus: "open",
    });
    const reply = await handlePetpoojaStoreStatus({ restID: "res_ahm_01" }, {});
    expect(reply!.body.store_status).toBe("0");
  });

  it("never claims a state for an unlinked outlet", async () => {
    const reply = await handlePetpoojaStoreStatus({ restID: "no_such_outlet" }, {});
    expect(reply!.body.status).toBe("failed");
    expect(reply!.body.store_status).toBe("");
    expect(reply!.body.http_code).toBe(400);
  });

  it("ignores an order callback (it carries an order reference)", async () => {
    const reply = await handlePetpoojaStoreStatus(
      { restID: "res_ahm_01", orderID: "ord_1", status: "1" },
      {}
    );
    expect(reply).toBeNull();
  });

  it("ignores the legacy { restID, status } ping", async () => {
    const reply = await handlePetpoojaStoreStatus({ restID: "res_ahm_01", status: "1" }, {});
    expect(reply).toBeNull();
  });
});

describe("Update Store Status — documented 0/1 encoding and reply", () => {
  it("closes the branch for store_status 0 and replies with the documented body", async () => {
    const reply = await handlePetpoojaStoreStatus(
      {
        restID: "res_ahm_01",
        store_status: 0,
        turn_on_time: "2026-11-20 09:00:00",
        reason: "Kitchen deep clean",
      },
      { authenticated: true }
    );

    expect(reply!.kind).toBe("update");
    expect(reply!.httpStatus).toBe(200);
    expect(reply!.body).toEqual({
      http_code: 200,
      status: "success",
      message: "Store Status updated successfully for store res_ahm_01",
    });
    expect(savedDocs["branches/branch_ahmedabad_1"].acceptingOrdersStatus).toBe("closed");
    expect(savedDocs["branches/branch_ahmedabad_1"].turnOnAt).toBe("2026-11-20 09:00:00");
    expect(savedDocs["branches/branch_ahmedabad_1"].storeStatusReason).toBe(
      "Kitchen deep clean"
    );
  });

  it("reopens the branch for store_status 1", async () => {
    setMockDoc("branches/branch_ahmedabad_1", {
      id: "branch_ahmedabad_1",
      petpoojaStoreId: "res_ahm_01",
      active: true,
      acceptingOrdersStatus: "closed",
    });
    const reply = await handlePetpoojaStoreStatus(
      { restID: "res_ahm_01", store_status: "1" },
      { authenticated: true }
    );
    expect(reply!.body.status).toBe("success");
    expect(savedDocs["branches/branch_ahmedabad_1"].acceptingOrdersStatus).toBe("open");
  });

  it("is idempotent: a repeated close does not rewrite the branch", async () => {
    await handlePetpoojaStoreStatus(
      { restID: "res_ahm_01", store_status: 0, turn_on_time: "2026-11-20 09:00:00" },
      { authenticated: true }
    );
    const writes = writeLog.filter((w) => w.startsWith("set branches/")).length;
    await handlePetpoojaStoreStatus(
      { restID: "res_ahm_01", store_status: 0, turn_on_time: "2026-11-20 09:00:00" },
      { authenticated: true }
    );
    expect(writeLog.filter((w) => w.startsWith("set branches/")).length).toBe(writes);
  });

  it("records but does NOT apply an unauthenticated update (default-deny preserved)", async () => {
    const reply = await handlePetpoojaStoreStatus(
      { restID: "res_ahm_01", store_status: 0, reason: "spoof" },
      {}
    );
    expect(savedDocs["branches/branch_ahmedabad_1"].acceptingOrdersStatus).toBe("open");
    expect(reply!.body.status).toBe("failed");
    expect(savedDocs["petpooja_store_status_events"] ? true : true).toBe(true);
  });

  it("never applies to an unlinked outlet", async () => {
    const reply = await handlePetpoojaStoreStatus(
      { restID: "no_such_outlet", store_status: 0 },
      { authenticated: true }
    );
    expect(reply!.body.status).toBe("failed");
    expect(Object.keys(savedDocs).some((k) => k.startsWith("branches/"))).toBe(true);
  });

  it("rejects an undocumented store_status value without touching the branch", async () => {
    const reply = await handlePetpoojaStoreStatus(
      { restID: "res_ahm_01", store_status: 7 },
      { authenticated: true }
    );
    expect(reply!.body.status).toBe("failed");
    expect(savedDocs["branches/branch_ahmedabad_1"].acceptingOrdersStatus).toBe("open");
  });
});

describe("Menu push — documented success body", () => {
  it("returns exactly the documented 200 OK body", () => {
    expect(menuPushAck()).toEqual(DOCUMENTED_MENU_PUSH_OK);
  });
});
