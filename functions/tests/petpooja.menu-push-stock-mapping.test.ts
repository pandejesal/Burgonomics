import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * A5 finding 3 (fix wave 2026-11-20, GO-LIVE CRITICAL): default stock policy
 * turns a real menu push into a fully Sold Out catalogue.
 *
 * A real 166-item Push Menu carried `in_stock: "2"` on EVERY item
 * (`references/petpooja_save_order_api.md` §17.6 / §19.4). The old whitelist
 * (1 / "1" / true) mapped all of them to `inStock: false`, so the whole
 * storefront rendered Sold Out and did so again on the next hourly sync.
 *
 * The encoding is now DOCUMENTED by the vendor's own item editor:
 *
 *   §22 (verified demo resubmission, 2026-10-28):
 *   "The native item editor defines stock2 as **Do Not Track**, stock1 as In
 *    Stock, stock0 as Out Of Stock."
 *
 * So the mapping is:
 *   1 / "1" / true  -> In Stock      -> inStock true
 *   0 / "0" / false -> Out Of Stock  -> inStock false
 *   2 / "2"         -> Do Not Track  -> the vendor asserts NOTHING; keep the
 *                                      item's current state (a staff 86 survives,
 *                                      and a fresh catalogue is NOT sold out)
 *   anything else   -> unknown       -> keep current state, and raise EXACTLY
 *                                      ONE operator alert. An unrecognised value
 *                                      must never mass-mark items sold out.
 *
 * The fixture is the real captured push body (both items `in_stock: "2"`).
 */

const { mockDb, savedDocs, writeLog } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  const writeLog: string[] = [];
  let autoId = 0;
  const clone = (v: any) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

  const refs = new Map<string, any>();
  const docRef = (col: string, id: string) => {
    const path = `${col}/${id}`;
    const cached = refs.get(path);
    if (cached) return cached;
    const ref: any = {
      id,
      path,
      get: vi.fn(async () => ({
        id,
        exists: Object.prototype.hasOwnProperty.call(savedDocs, path),
        data: () => clone(savedDocs[path]),
      })),
      set: vi.fn(async (data: any, opts?: any) => {
        writeLog.push(`set ${path}`);
        savedDocs[path] =
          opts?.merge && savedDocs[path] ? { ...savedDocs[path], ...data } : { ...data };
      }),
    };
    refs.set(path, ref);
    return ref;
  };

  const query = (col: string): any => ({
    where: () => query(col),
    orderBy: () => query(col),
    limit: () => query(col),
    startAfter: () => query(col),
    get: vi.fn(async () => {
      const docs = Object.keys(savedDocs)
        .filter((p) => p.startsWith(`${col}/`))
        .sort()
        .map((p) => {
          const id = p.slice(col.length + 1);
          return { id, ref: docRef(col, id), data: () => clone(savedDocs[p]) };
        });
      return { empty: docs.length === 0, docs };
    }),
  });

  const mockDb: any = {
    collection: (col: string) => ({
      ...query(col),
      doc: (id?: string) => docRef(col, id || `auto_${++autoId}`),
    }),
    batch: () => {
      const pending: Array<{ path: string; data: any; ref: any; opts: any }> = [];
      return {
        set: vi.fn((ref: any, data: any, opts?: any) => {
          pending.push({ path: ref.path, data, ref, opts });
        }),
        commit: vi.fn(async () => {
          for (const p of pending) {
            await p.ref.set(p.data, p.opts);
          }
          pending.length = 0;
        }),
      };
    },
    // The sync does not batch-read, but provide it so a future change cannot
    // silently degrade to one read per SKU in this double.
    getAll: vi.fn(async (...refs: any[]) => Promise.all(refs.map((r: any) => r.get()))),
  };

  return { mockDb, savedDocs, writeLog };
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

// The real captured Push Menu body: 2 items, both `in_stock: "2"`.
const REAL_PUSH = JSON.parse(
  readFileSync(resolve(__dirname, "fixtures/petpooja-menupush-sample.json"), "utf8")
);

const BRANCH = "demo";
const REAL_ITEM_IDS = (REAL_PUSH.items as any[]).map((i) => String(i.itemid));

const syncLogs = () =>
  Object.keys(savedDocs)
    .filter((p) => p.startsWith("petpooja_sync_logs/"))
    .map((p) => savedDocs[p]);
const latestSyncLog = () => syncLogs()[syncLogs().length - 1];
const alertRows = () =>
  Object.keys(savedDocs)
    .filter((p) => p.startsWith("dev_error_snapshots/"))
    .map((p) => savedDocs[p]);
/**
 * Only the alerts this test file is about. The captured menu also carries tax
 * metadata the pull-model breaker cannot represent, which raises its own
 * (separate, pre-existing) medium snapshot — that is not this defect.
 */
const stockAlerts = () =>
  alertRows().filter((row) => String(row?.message || "").includes("in_stock"));
const product = (itemId: string) => savedDocs[`products/prod_${BRANCH}_${itemId}`];

function seedProduct(itemId: string, data: Record<string, any>) {
  const path = `products/prod_${BRANCH}_${itemId}`;
  savedDocs[path] = {
    id: `prod_${BRANCH}_${itemId}`,
    branchId: BRANCH,
    petpoojaItemId: itemId,
    name: `Item ${itemId}`,
    price: 100,
    ...data,
  };
  return path;
}

/** A push body built from the real sample, with per-item stock overrides. */
function pushWith(stockByItemId: Record<string, any>) {
  const body = JSON.parse(JSON.stringify(REAL_PUSH));
  for (const item of body.items) {
    if (Object.prototype.hasOwnProperty.call(stockByItemId, String(item.itemid))) {
      const value = stockByItemId[String(item.itemid)];
      if (value === "(absent)") delete item.in_stock;
      else item.in_stock = value;
    }
  }
  return body;
}

let prevMock: boolean;

beforeEach(() => {
  for (const key of Object.keys(savedDocs)) delete savedDocs[key];
  writeLog.length = 0;
  prevMock = config.mock.petpoojaPos;
  // Mock mode keeps the POS delisting pass out of this file: this test is
  // about the `in_stock` mapping only.
  config.mock.petpoojaPos = true;
  savedDocs[`branches/${BRANCH}`] = { petpoojaStoreId: "31z58ciw0h" };
});

afterEach(() => {
  config.mock.petpoojaPos = prevMock;
});

describe("Push Menu `in_stock` — §22 encoding, mapped exactly", () => {
  it("a real all-\"2\" push does NOT sell out a fresh catalogue (the 166-item incident)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const res = await syncPetpoojaMenu(BRANCH, undefined, REAL_PUSH);

      expect(res.itemCount).toBe(REAL_ITEM_IDS.length);
      for (const itemId of REAL_ITEM_IDS) {
        // "Do Not Track" asserts no stock state — but a vendor that does not
        // track stock is not asserting "86'd". A priced SKU stays orderable.
        expect(product(itemId).inStock).toBe(true);
        // The raw vendor value is still recorded verbatim for the next census.
        expect(product(itemId).pushInStock).toBe("2");
      }
      expect(latestSyncLog()).toMatchObject({
        status: "COMPLETED",
        catalogueReady: true,
        availabilityWarning: null,
        // The census still reports what the vendor actually sent.
        inStockValues: { "2": REAL_ITEM_IDS.length },
      });
      expect(stockAlerts()).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it("`2` (Do Not Track) keeps each item's CURRENT state, so a staff 86 survives", async () => {
    seedProduct(REAL_ITEM_IDS[0], { inStock: false, manuallySoldOut: true });
    seedProduct(REAL_ITEM_IDS[1], { inStock: true });

    await syncPetpoojaMenu(BRANCH, undefined, REAL_PUSH);

    expect(product(REAL_ITEM_IDS[0]).inStock).toBe(false);
    expect(product(REAL_ITEM_IDS[1]).inStock).toBe(true);
    expect(stockAlerts()).toEqual([]);
  });

  it("`1` and `0` are In Stock / Out Of Stock exactly as §22 defines them", async () => {
    seedProduct(REAL_ITEM_IDS[0], { inStock: false });
    seedProduct(REAL_ITEM_IDS[1], { inStock: true });

    await syncPetpoojaMenu(
      BRANCH,
      undefined,
      pushWith({ [REAL_ITEM_IDS[0]]: "1", [REAL_ITEM_IDS[1]]: "0" })
    );

    expect(product(REAL_ITEM_IDS[0]).inStock).toBe(true);
    expect(product(REAL_ITEM_IDS[1]).inStock).toBe(false);
    expect(stockAlerts()).toEqual([]);
  });

  it("an UNKNOWN value keeps current state and raises EXACTLY ONE alert for the whole sync", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    seedProduct(REAL_ITEM_IDS[0], { inStock: false });
    seedProduct(REAL_ITEM_IDS[1], { inStock: true });
    try {
      await syncPetpoojaMenu(
        BRANCH,
        undefined,
        pushWith({ [REAL_ITEM_IDS[0]]: "7", [REAL_ITEM_IDS[1]]: "9" })
      );

      // Never mass-mark sold out: the current state is authoritative.
      expect(product(REAL_ITEM_IDS[0]).inStock).toBe(false);
      expect(product(REAL_ITEM_IDS[1]).inStock).toBe(true);

      // ONE snapshot for the run, naming the outlet and the raw values — not
      // one per item.
      expect(stockAlerts()).toHaveLength(1);
      const alert = stockAlerts()[0];
      expect(alert).toMatchObject({ source: "petpooja", severity: "high", branchId: BRANCH });
      expect(alert.message).toContain("in_stock");
      expect(alert.message).toContain("7");
      expect(alert.message).toContain("9");
      expect(alert.message).toContain("§22");

      // The sync itself is unaffected by the observability alert.
      expect(latestSyncLog()).toMatchObject({
        status: "COMPLETED",
        catalogueReady: true,
        availabilityWarning: null,
      });
    } finally {
      warn.mockRestore();
    }
  });

  it("an UNKNOWN value on a FRESH catalogue stays orderable (fail-open, loudly), never Sold Out", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await syncPetpoojaMenu(
        BRANCH,
        undefined,
        pushWith({ [REAL_ITEM_IDS[0]]: "7", [REAL_ITEM_IDS[1]]: "7" })
      );

      for (const itemId of REAL_ITEM_IDS) {
        // There is no prior state to keep, and a vendor encoding we cannot read
        // must not take the catalogue dark. Priced SKUs stay sellable.
        expect(product(itemId).inStock).toBe(true);
      }
      expect(latestSyncLog()).toMatchObject({
        catalogueReady: true,
        availabilityWarning: null,
      });
      expect(stockAlerts()).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("an ABSENT `in_stock` is Do-Not-Track-like: keep current state, and never sell out a fresh feed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    seedProduct(REAL_ITEM_IDS[0], { inStock: false });
    try {
      await syncPetpoojaMenu(
        BRANCH,
        undefined,
        pushWith({ [REAL_ITEM_IDS[0]]: "(absent)", [REAL_ITEM_IDS[1]]: "(absent)" })
      );

      expect(product(REAL_ITEM_IDS[0]).inStock).toBe(false);
      expect(product(REAL_ITEM_IDS[1]).inStock).toBe(true);
      expect(latestSyncLog()).toMatchObject({
        catalogueReady: true,
        availabilityWarning: null,
        inStockValues: { "(absent)": REAL_ITEM_IDS.length },
      });
      // An absent field is the vendor saying nothing at all — not an unknown
      // encoding, so no alert.
      expect(stockAlerts()).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it("an UNPRICED item stays unsellable under every encoding, including `2`", async () => {
    const body = pushWith({ [REAL_ITEM_IDS[0]]: "2", [REAL_ITEM_IDS[1]]: "1" });
    body.items[0].price = "0";
    body.items[0].variation = [];

    await syncPetpoojaMenu(BRANCH, undefined, body);

    // The price guard outranks Do-Not-Track: no ₹0 order can ever be placed.
    expect(product(REAL_ITEM_IDS[0])).toMatchObject({ price: 0, priceAvailable: false, inStock: false });
    expect(product(REAL_ITEM_IDS[1]).inStock).toBe(true);
  });
});
