import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Reviewer follow-ups on the documented callback replies (r2).
 *
 * r1 matched the vendor's bodies but left four real-life gaps:
 *
 *   1. Get Store Status — the documented request is a bare `{"restID"}`, which
 *      the credential-less SHAPE allowance never admitted, so a real Petpooja
 *      call 401'd before reaching the handler.
 *   2. Update Store Status — it wrote `branches.acceptingOrdersStatus`, which NO
 *      ordering path reads. The live customer gate is `stores/{id}.isOpen`, so a
 *      POS "closed" left customers able to order.
 *   3. Item On/Off — a batch over the 200-id cap was silently TRUNCATED and the
 *      reply still claimed success.
 *   4. Small ones: a GET failure reported `kind: "update"`, and `turn_on_time`
 *      was stored unbounded.
 *
 * Written RED-first: each case below fails against the r1 code.
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
  normalizeStockItemIds,
  stockAuditOutcome,
  stockWebhookReply,
  summariseStockItemRef,
  MAX_STOCK_BATCH,
  MAX_TURN_ON_TIME_CHARS,
} from "../src/modules/petpooja/item86ingSync";
import { config } from "../src/config/env";

const DOCUMENTED_STOCK_FAILED = {
  code: 400,
  status: "failed",
  message: "Stock status not updated successfully",
};

const REST = "res_ahm_01";
const BRANCH = "branch_ahmedabad_1";
const STORE = "store_ahm_01";

let prevMock = false;

beforeEach(() => {
  for (const key of Object.keys(savedDocs)) delete savedDocs[key];
  for (const key of Object.keys(docMetadata)) delete docMetadata[key];
  writeLog.length = 0;
  prevMock = config.mock.petpoojaPos;
  config.mock.petpoojaPos = false;

  setMockDoc(`branches/${BRANCH}`, {
    id: BRANCH,
    name: "Ahmedabad Main",
    petpoojaStoreId: REST,
    active: true,
    acceptingOrdersStatus: "open",
  });
  // The live customer gate: the storefront doc the customer app reads.
  setMockDoc(`stores/${STORE}`, {
    id: STORE,
    name: "Ahmedabad Main",
    partnerBranchId: BRANCH,
    petpoojaRestId: REST,
    isOpen: true,
    isBusy: false,
  });
});

afterEach(() => {
  config.mock.petpoojaPos = prevMock;
});

// ---------------------------------------------------------------------------
// 1. Get Store Status is reachable WITHOUT a credential (documented bare body)
// ---------------------------------------------------------------------------
describe("1 — credential-less Get Store Status admission", () => {
  async function verify(path: string, body: any) {
    process.env.PETPOOJA_APP_KEY = "unit_pp_app_key";
    vi.resetModules();
    const mod = await import("../src/core/middleware");
    const res: any = { status: vi.fn(() => ({ json: vi.fn() })) };
    const next = vi.fn();
    mod.verifyPetpoojaAuth({ path, headers: {}, body } as any, res, next);
    return { res, next };
  }

  it("admits the documented bare { restID } on /petpooja/webhook", async () => {
    const { res, next } = await verify("/petpooja/webhook", { restID: REST });
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it("still refuses the bare GET shape on the sibling write routes", async () => {
    for (const path of ["/petpooja/stockWebhook", "/petpooja/menu-sync"]) {
      const { res, next } = await verify(path, { restID: REST });
      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    }
  });

  it("keeps refusing unknown shapes", async () => {
    for (const body of [{}, { status: "1" }, { restID: "" }, { rest_id: 42, orderID: "A-1" }]) {
      const { res, next } = await verify("/petpooja/webhook", body);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    }
  });

  it("treats an order callback as an order event, never a store read", async () => {
    const { next } = await verify("/petpooja/webhook", {
      restID: REST,
      orderID: "A-1",
      status: "1",
    });
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe("1 — the read-only GET answer itself", () => {
  it("answers the documented body for an unauthenticated caller", async () => {
    const reply = await handlePetpoojaStoreStatus({ restID: REST }, {});
    expect(reply!.kind).toBe("get");
    expect(reply!.httpStatus).toBe(200);
    expect(reply!.body).toEqual({
      http_code: 200,
      status: "success",
      store_status: "1",
      message: "Store Delivery Status fetched successfully",
    });
  });

  it("never mutates canonical store state on a GET", async () => {
    const before = JSON.stringify(savedDocs);
    await handlePetpoojaStoreStatus({ restID: REST }, {});
    // No product/branch/store doc changed: only the bounded evidence row may.
    expect(savedDocs[`branches/${BRANCH}`]).toEqual(
      JSON.parse(before)[`branches/${BRANCH}`]
    );
    expect(savedDocs[`stores/${STORE}`]).toEqual(JSON.parse(before)[`stores/${STORE}`]);
    expect(writeLog.filter((w) => !w.includes("petpooja_store_status_events"))).toEqual([]);
  });

  it("records the real trusted flag, not a hardcoded true", async () => {
    await handlePetpoojaStoreStatus({ restID: REST }, {});
    expect(savedDocs[`petpooja_store_status_events/ss_${REST}`].trusted).toBe(false);

    await handlePetpoojaStoreStatus({ restID: REST }, { authenticated: true });
    expect(savedDocs[`petpooja_store_status_events/ss_${REST}`].trusted).toBe(true);
  });

  it("reports the live storefront state, not a stale branch flag", async () => {
    // The branch still says "open" (the Partner app flag), but the storefront
    // the customer app reads is closed — that is what Petpooja must be told.
    setMockDoc(`stores/${STORE}`, {
      id: STORE,
      partnerBranchId: BRANCH,
      petpoojaRestId: REST,
      isOpen: false,
    });
    const reply = await handlePetpoojaStoreStatus({ restID: REST }, {});
    expect(reply!.body.store_status).toBe("0");
  });

  it("falls back to the branch flags when no storefront doc is linked", async () => {
    delete savedDocs[`stores/${STORE}`];
    const reply = await handlePetpoojaStoreStatus({ restID: REST }, {});
    expect(reply!.body.store_status).toBe("1");
  });

  it("answers the documented failure, with kind 'get', for an unknown outlet", async () => {
    const reply = await handlePetpoojaStoreStatus({ restID: "no_such_outlet" }, {});
    expect(reply!.kind).toBe("get");
    expect(reply!.body).toMatchObject({ http_code: 400, status: "failed", store_status: "" });
  });
});

// ---------------------------------------------------------------------------
// 2. Update Store Status must actually stop and restart customer ordering
// ---------------------------------------------------------------------------
describe("2 — Update Store Status gates the live storefront", () => {
  it("closes the storefront customers order from", async () => {
    setMockDoc(`admin_stores/${STORE}`, {
      id: STORE,
      name: "Ahmedabad Main",
      isOpen: true,
    });
    const reply = await handlePetpoojaStoreStatus(
      { restID: REST, store_status: 0, turn_on_time: "2026-11-20 09:00:00" },
      { authenticated: true }
    );

    expect(reply!.body.status).toBe("success");
    expect(savedDocs[`stores/${STORE}`].isOpen).toBe(false);
    expect(savedDocs[`stores/${STORE}`].storeStatusSource).toBe("petpooja");
    // The Partner directory copy is kept in step so a later operator save does
    // not silently reopen what the POS closed.
    expect(savedDocs[`admin_stores/${STORE}`].isOpen).toBe(false);
  });

  it("never creates an admin_stores directory entry the operator did not make", async () => {
    const reply = await handlePetpoojaStoreStatus(
      { restID: REST, store_status: 0 },
      { authenticated: true }
    );
    expect(reply!.body.status).toBe("success");
    expect(savedDocs[`admin_stores/${STORE}`]).toBeUndefined();
  });

  it("closes the storefront when the directory entry is admin_stores-only", async () => {
    // `storesService.fetchFirestoreStores` falls back to `admin_stores` when the
    // `stores` collection is empty, so on such a deployment THAT doc is the gate
    // the customer app reads. Refusing it would break every POS close.
    delete savedDocs[`stores/${STORE}`];
    setMockDoc(`admin_stores/${STORE}`, {
      id: STORE,
      partnerBranchId: BRANCH,
      petpoojaRestId: REST,
      isOpen: true,
    });
    const reply = await handlePetpoojaStoreStatus(
      { restID: REST, store_status: 0 },
      { authenticated: true }
    );
    expect(reply!.body.status).toBe("success");
    expect(savedDocs[`admin_stores/${STORE}`].isOpen).toBe(false);
    expect(savedDocs[`admin_stores/${STORE}`].storeStatusSource).toBe("petpooja");
  });

  it("reopens the storefront so customers can order again", async () => {
    setMockDoc(`stores/${STORE}`, {
      id: STORE,
      partnerBranchId: BRANCH,
      petpoojaRestId: REST,
      isOpen: false,
    });
    const reply = await handlePetpoojaStoreStatus(
      { restID: REST, store_status: 1 },
      { authenticated: true }
    );
    expect(reply!.body.status).toBe("success");
    expect(savedDocs[`stores/${STORE}`].isOpen).toBe(true);
  });

  it("closes a storefront linked only by petpoojaRestId", async () => {
    setMockDoc(`stores/${STORE}`, { id: STORE, petpoojaRestId: REST, isOpen: true });
    await handlePetpoojaStoreStatus(
      { restID: REST, store_status: 0 },
      { authenticated: true }
    );
    expect(savedDocs[`stores/${STORE}`].isOpen).toBe(false);
  });

  it("is idempotent: a repeated close does not rewrite the storefront", async () => {
    await handlePetpoojaStoreStatus(
      { restID: REST, store_status: 0 },
      { authenticated: true }
    );
    const writes = writeLog.filter((w) => w.includes(`stores/${STORE}`)).length;
    const version = docMetadata[`stores/${STORE}`].updateTime.toMillis();

    await handlePetpoojaStoreStatus(
      { restID: REST, store_status: 0 },
      { authenticated: true }
    );
    expect(writeLog.filter((w) => w.includes(`stores/${STORE}`)).length).toBe(writes);
    expect(docMetadata[`stores/${STORE}`].updateTime.toMillis()).toBe(version);
  });

  it("refuses to claim success when no storefront is linked", async () => {
    delete savedDocs[`stores/${STORE}`];
    const reply = await handlePetpoojaStoreStatus(
      { restID: REST, store_status: 0 },
      { authenticated: true }
    );
    expect(reply!.body.status).toBe("failed");
    expect(reply!.body.http_code).toBe(400);
    // Nothing half-applied: the branch flag is untouched too.
    expect(savedDocs[`branches/${BRANCH}`].acceptingOrdersStatus).toBe("open");
  });

  it("still refuses an unauthenticated update and touches no storefront", async () => {
    const reply = await handlePetpoojaStoreStatus({ restID: REST, store_status: 0 }, {});
    expect(reply!.body.status).toBe("failed");
    expect(savedDocs[`stores/${STORE}`].isOpen).toBe(true);
  });

  it("caps turn_on_time before persisting it", async () => {
    const long = "2026-11-20T09:00:00Z ".repeat(40);
    await handlePetpoojaStoreStatus(
      { restID: REST, store_status: 0, turn_on_time: long },
      { authenticated: true }
    );
    const stored = savedDocs[`branches/${BRANCH}`].turnOnAt;
    expect(stored.length).toBe(MAX_TURN_ON_TIME_CHARS);
  });
});

// ---------------------------------------------------------------------------
// 3. Item On/Off — no success after truncation, partial is named
// ---------------------------------------------------------------------------
describe("3 — Item On/Off batch accounting", () => {
  it("never truncates silently: reports the real ids and the total", () => {
    const ids = Array.from({ length: MAX_STOCK_BATCH + 25 }, (_, i) => `sku_${i}`);
    const normalized = normalizeStockItemIds(ids);
    expect(normalized.ids.length).toBe(MAX_STOCK_BATCH);
    expect(normalized.total).toBe(MAX_STOCK_BATCH + 25);
    expect(normalized.truncated).toBe(true);
  });

  it("rejects an over-cap batch instead of claiming success", async () => {
    const ids = Array.from({ length: MAX_STOCK_BATCH + 1 }, (_, i) => `sku_${i}`);
    const result = await handlePetpoojaStockWebhook(
      { restID: REST, type: "item", inStock: false, itemID: ids },
      { authenticated: true }
    );
    expect(result.outcome).not.toBe("applied");
    expect(result.reason).toContain(String(MAX_STOCK_BATCH + 1));
    expect(stockWebhookReply(result).body).toEqual(DOCUMENTED_STOCK_FAILED);
  });

  it("marks a partial batch as 'partial', never 'applied'", async () => {
    setMockDoc(`products/prod_${BRANCH}_30791`, {
      id: `prod_${BRANCH}_30791`,
      branchId: BRANCH,
      petpoojaItemId: "30791",
      inStock: true,
    });
    const result = await handlePetpoojaStockWebhook(
      { restID: REST, type: "item", inStock: false, itemID: ["30791", "999999999"] },
      { authenticated: true }
    );
    expect(result.outcome).toBe("partial");
    expect(result.retryable).toBe(false);
    expect(result.reason).toContain("1/2");
    expect(stockAuditOutcome(result)).toBe("partial");
    expect(stockWebhookReply(result).body).toEqual(DOCUMENTED_STOCK_FAILED);
  });

  it("summarises a huge itemID array instead of persisting it whole", () => {
    const ids = Array.from({ length: 5000 }, (_, i) => `very_long_sku_identifier_${i}`);
    const summary = summariseStockItemRef(ids)!;
    expect(summary.length).toBeLessThanOrEqual(96);
    expect(summary).toContain("+4999 more");
    expect(summariseStockItemRef(undefined)).toBeNull();
    expect(summariseStockItemRef("30791")).toBe("30791");
  });
});
