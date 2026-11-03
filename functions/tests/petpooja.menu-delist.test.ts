import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * POS DELISTING — an item deleted/retired on the POS must stop being orderable.
 *
 * The sync only MERGES over items present in the push, so a SKU removed on the
 * POS stayed live and the kitchen had to reject it. A tombstone pass already
 * existed, but it had NO ownership guard: any branch-scoped product carrying a
 * `petpoojaItemId` that the push omitted was fair game. On the staging DEMO
 * branch that means the 56 docs written by tools/menu-load-demo.cjs (tagged
 * `demoMenuLoad: "qa_20261102_demo_menu"`, borrowing unused sandbox item ids)
 * would all be delisted — an empty menu at lunch.
 *
 * The contract pinned here, driven through the REAL sync with only Firestore
 * faked:
 *   - only products THIS sync owns for THIS branch are candidates: a
 *     `prod_<branchId>_<itemid>` doc with a `petpoojaItemId`, not a combo, and
 *     not tagged `qa_20261102_demo_menu`;
 *   - a confirmed-delisted item is `inStock:false` + `delistedFromPos:true` +
 *     `delistedAt`, and is NEVER deleted;
 *   - a partial/empty feed prunes nothing, keeps the merge, warns in the sync
 *     log and raises a HIGH snapshot;
 *   - a reappearing item clears the marker and takes its stock from the push;
 *   - prune writes respect the 500-write Firestore batch limit;
 *   - a prune failure is recorded and never loses the sync result.
 *
 * Real document shapes only: branches/{id}, products/{id}, petpooja_sync_logs/*.
 */

const DEMO_REST_ID = "31z58ciw0h";
const DEMO_TAG = "qa_20261102_demo_menu";

const { mockDb, savedDocs, batchLog, hooks } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  /** Every committed batch, so a test can assert the 500-write limit. */
  const batchLog: Array<{ ops: number }> = [];
  const hooks = {
    /** Throw on the first batch commit that carries a delisting write. */
    failDelistCommit: false,
    /** Throw on the first batch commit that carries a restore write. */
    failRestoreCommit: false,
  };

  const docRef = (col: string, id: string) => {
    const path = `${col}/${id}`;
    return {
      id,
      path,
      get: vi.fn(async () => ({
        exists: Object.prototype.hasOwnProperty.call(savedDocs, path),
        id,
        data: () => savedDocs[path],
        ref: docRef(col, id),
      })),
      set: vi.fn(async (data: any, opts?: any) => {
        savedDocs[path] =
          opts?.merge && savedDocs[path] ? { ...savedDocs[path], ...data } : { ...data };
      }),
    };
  };

  const makeBatch = () => {
    const pending: Array<{ path: string; data: any; merge: boolean }> = [];
    return {
      set: (ref: any, data: any, opts?: any) => {
        pending.push({ path: ref.path, data, merge: opts?.merge === true });
      },
      commit: vi.fn(async () => {
        const delists = pending.some((w) => w.data?.delistedFromPos === true);
        const restores = pending.some((w) => w.data?.delistedFromPos === false);
        if ((hooks.failDelistCommit && delists) || (hooks.failRestoreCommit && restores)) {
          throw new Error("simulated batch commit failure");
        }
        for (const w of pending) {
          savedDocs[w.path] =
            w.merge && savedDocs[w.path] ? { ...savedDocs[w.path], ...w.data } : { ...w.data };
        }
        batchLog.push({ ops: pending.length });
        pending.length = 0;
      }),
    };
  };

  const query = (
    col: string,
    filters: Array<{ field: string; value: any }> = [],
    max = Infinity,
    afterId = ""
  ): any => ({
    where: (field: string, _op: string, value: any) =>
      query(col, [...filters, { field, value }], max, afterId),
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
        .filter((path) => filters.every((f) => savedDocs[path][f.field] === f.value))
        .slice(0, max)
        .map((path) => {
          const id = path.slice(col.length + 1);
          return { id, data: () => savedDocs[path], ref: docRef(col, id) };
        });
      return { empty: docs.length === 0, docs };
    }),
  });

  const mockDb: any = {
    collection: (col: string) => ({
      ...query(col),
      doc: (id?: string) => docRef(col, id as string),
    }),
    batch: () => makeBatch(),
  };

  return { mockDb, savedDocs, batchLog, hooks };
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

let prevMock: boolean;

const syncLogRows = () =>
  Object.keys(savedDocs).filter((k) => k.startsWith("petpooja_sync_logs/"));
const snapshotRows = () =>
  Object.keys(savedDocs).filter((k) => k.startsWith("dev_error_snapshots/"));
const lastSyncLog = () => {
  const rows = syncLogRows();
  return rows.length ? savedDocs[rows[rows.length - 1]] : undefined;
};
/** The HIGH snapshot raised for a refused/empty prune, if any. */
const highSnapshots = () =>
  snapshotRows()
    .map((p) => savedDocs[p])
    .filter((s) => s?.severity === "high");

function seedBranch(branchId: string, knownItemCount = 0) {
  savedDocs[`branches/${branchId}`] = {
    name: `${branchId} outlet`,
    petpoojaStoreId: DEMO_REST_ID,
    ...(knownItemCount ? { petpoojaItemCount: knownItemCount } : {}),
  };
}

/** Exactly the shape the sync itself writes (see the productPayload builder). */
function seedOwnedProduct(itemId: string, extra: Record<string, any> = {}, branchId = "demo") {
  const id = `prod_${branchId}_${itemId}`;
  savedDocs[`products/${id}`] = {
    id,
    branchId,
    restId: DEMO_REST_ID,
    petpoojaItemId: itemId,
    name: `Item ${itemId}`,
    price: 100,
    inStock: true,
    lastPetpoojaSync: "MOCK_TIMESTAMP",
    ...extra,
  };
  return `products/${id}`;
}

function feedItem(itemId: string) {
  return {
    itemid: itemId,
    itemname: `Item ${itemId}`,
    price: 100,
    itemcategoryid: "cat_1",
    in_stock: 1,
    item_attributeid: "1",
  };
}

function push(items: any[]) {
  return syncPetpoojaMenu("demo", undefined, {
    success: "1",
    restaurants: [{ restaurantid: "5439", details: { menusharingcode: DEMO_REST_ID } }],
    categories: [{ categoryid: "cat_1", categoryname: "Burgers" }],
    items,
  });
}

beforeEach(() => {
  for (const key of Object.keys(savedDocs)) delete savedDocs[key];
  batchLog.length = 0;
  hooks.failDelistCommit = false;
  hooks.failRestoreCommit = false;
  prevMock = config.mock.petpoojaPos;
  config.mock.petpoojaPos = false; // LIVE path — the prune pass is live-only
});

afterEach(() => {
  config.mock.petpoojaPos = prevMock;
});

describe("POS delisting — an item removed on the POS stops being orderable", () => {
  it("marks the absent owned SKU out of stock with the delist marker, and never deletes it", async () => {
    seedBranch("demo", 3);
    const gone = seedOwnedProduct("gone", { name: "Retired Burger", price: 249, categoryId: "cat_1" });
    seedOwnedProduct("a");
    seedOwnedProduct("b");

    await push([feedItem("a"), feedItem("b")]);

    const doc = savedDocs[gone];
    expect(doc).toBeDefined(); // NEVER deleted: history/favourites/orders point here
    expect(doc).toMatchObject({
      inStock: false,
      delistedFromPos: true,
      delistedAt: "MOCK_TIMESTAMP",
      // The document keeps its own identity and history.
      name: "Retired Burger",
      price: 249,
      petpoojaItemId: "gone",
      branchId: "demo",
    });
    // The feed's own items stay orderable and untouched by the prune.
    expect(savedDocs["products/prod_demo_a"].inStock).toBe(true);
    expect(savedDocs["products/prod_demo_b"].inStock).toBe(true);

    expect(lastSyncLog()).toMatchObject({ prunedCount: 1, skippedPruneReason: null });
  });

  it("restores a reappearing SKU: clears the marker and takes its stock from the push", async () => {
    seedBranch("demo", 2);
    const path = seedOwnedProduct("back", {
      inStock: false,
      delistedFromPos: true,
      delistedAt: "OLD_DELIST",
    });

    await push([feedItem("back"), feedItem("other")]);

    const doc = savedDocs[path];
    expect(doc.delistedFromPos).toBe(false);
    expect(doc.delistedAt).toBeNull();
    // Stock comes from the push (in_stock: 1), not from the stale delist.
    expect(doc.inStock).toBe(true);
  });

  it("keeps a manual 86 on a PRESENT item exactly as today (the push owns in_stock)", async () => {
    seedBranch("demo", 1);
    const path = seedOwnedProduct("present", { inStock: false });

    await push([{ ...feedItem("present"), in_stock: 1 }]);

    // The push carries in_stock 1, so the merge sets it back — unchanged
    // behaviour. The prune must not add a delist marker to a present SKU.
    expect(savedDocs[path].inStock).toBe(true);
    expect(savedDocs[path].delistedFromPos).toBeUndefined();
  });

  it("prunes NOTHING on a partial push and raises a HIGH snapshot", async () => {
    // 10 known SKUs, a 3-item feed: well under the 50% completeness bar.
    seedBranch("demo", 10);
    for (let i = 0; i < 10; i++) seedOwnedProduct(`sku${i}`);

    await push([feedItem("sku0"), feedItem("sku1"), feedItem("sku2")]);

    for (let i = 3; i < 10; i++) {
      const doc = savedDocs[`products/prod_demo_sku${i}`];
      expect(doc.inStock, `sku${i} must stay orderable`).toBe(true);
      expect(doc.delistedFromPos).toBeUndefined();
    }
    // The normal merge still ran for the items that DID arrive.
    expect(savedDocs["products/prod_demo_sku0"].inStock).toBe(true);
    expect(savedDocs["products/prod_demo_sku2"].inStock).toBe(true);

    expect(lastSyncLog()).toMatchObject({
      prunedCount: 0,
      skippedPruneReason: "feed_below_threshold",
      status: "COMPLETED",
    });
    expect(highSnapshots().some((s) => /prune|retire|delist/i.test(String(s.message)))).toBe(true);
  });

  it("prunes NOTHING on an empty push and still records the warning", async () => {
    seedBranch("demo", 2);
    seedOwnedProduct("x");
    seedOwnedProduct("y");

    await push([]);

    for (const id of ["x", "y"]) {
      const doc = savedDocs[`products/prod_demo_${id}`];
      expect(doc.inStock).toBe(true);
      expect(doc.delistedFromPos).toBeUndefined();
    }
    expect(lastSyncLog()).toMatchObject({
      prunedCount: 0,
      skippedPruneReason: "empty_feed",
    });
    expect(highSnapshots().length).toBeGreaterThan(0);
  });

  it("never touches another branch, even with an identical petpoojaItemId", async () => {
    seedBranch("demo", 2);
    seedBranch("westbank", 0);
    const foreign = "products/prod_westbank_70001";
    savedDocs[foreign] = {
      id: "prod_westbank_70001",
      branchId: "westbank",
      restId: "westbank-rest-id",
      petpoojaItemId: "gone",
      name: "Westbank Malai Kofta",
      price: 349,
      inStock: true,
      updatedAt: "SEEDED_WESTBANK",
    };
    const before = JSON.parse(JSON.stringify(savedDocs[foreign]));
    seedOwnedProduct("a");
    seedOwnedProduct("b");

    await push([feedItem("a"), feedItem("b")]);

    expect(savedDocs[foreign]).toEqual(before);
  });

  it("never touches a product tagged qa_20261102_demo_menu, even on the same branch and doc-id shape", async () => {
    seedBranch("demo", 2);
    // Deliberately the EXACT doc-id shape and branch this sync writes, so the
    // tag — not the id shape — is what has to protect it.
    const tagged = seedOwnedProduct("stand1", {
      demoMenuLoad: DEMO_TAG,
      demoStandInFor: "Borrowed Sandbox Item",
      name: "Demo Stand-In Burger",
    });
    seedOwnedProduct("a");
    seedOwnedProduct("b");

    await push([feedItem("a"), feedItem("b")]);

    const doc = savedDocs[tagged];
    expect(doc.inStock).toBe(true);
    expect(doc.delistedFromPos).toBeUndefined();
    expect(doc.demoMenuLoad).toBe(DEMO_TAG);
    expect(doc.petpoojaItemId).toBe("stand1");
  });

  it("never touches a product that is not sourced from Petpooja", async () => {
    seedBranch("demo", 2);
    const local = "products/prod_demo_local_combo";
    savedDocs[local] = {
      id: "prod_demo_local_combo",
      branchId: "demo",
      name: "Locally authored combo",
      price: 399,
      inStock: true,
      isCombo: true,
    };
    const localNoPosId = "products/prd_demo_house_special";
    savedDocs[localNoPosId] = {
      id: "prd_demo_house_special",
      branchId: "demo",
      name: "House special (no POS mapping)",
      price: 199,
      inStock: true,
    };
    seedOwnedProduct("a");
    seedOwnedProduct("b");

    await push([feedItem("a"), feedItem("b")]);

    expect(savedDocs[local]).toMatchObject({ inStock: true, isCombo: true });
    expect(savedDocs[local].delistedFromPos).toBeUndefined();
    expect(savedDocs[localNoPosId]).toMatchObject({ inStock: true });
    expect(savedDocs[localNoPosId].delistedFromPos).toBeUndefined();
  });

  it("is a no-op on a first-ever sync with no existing products", async () => {
    seedBranch("demo", 0); // no petpoojaItemCount, no products

    const result = await push([feedItem("new1"), feedItem("new2")]);

    expect(result.itemCount).toBe(2);
    expect(savedDocs["products/prod_demo_new1"]).toMatchObject({ inStock: true });
    expect(savedDocs["products/prod_demo_new2"]).toMatchObject({ inStock: true });
    // Nothing existed to delist, so nothing is refused and nobody is paged.
    expect(lastSyncLog()).toMatchObject({ prunedCount: 0, skippedPruneReason: null });
    expect(highSnapshots()).toEqual([]);
  });

  it("delists a large backlog within the 500-write batch limit", async () => {
    // A big menu where the feed is COMPLETE (well over the 50% bar) but 620
    // SKUs were removed at once — under the 50% single-run cap, so the pass is
    // allowed and must chunk its writes at Firestore's 500.
    const present = 800;
    const total = 620;
    seedBranch("demo", present + total);
    for (let i = 0; i < total; i++) seedOwnedProduct(`old${String(i).padStart(3, "0")}`);
    const feed = [];
    for (let i = 0; i < present; i++) {
      seedOwnedProduct(`keep${String(i).padStart(3, "0")}`);
      feed.push(feedItem(`keep${String(i).padStart(3, "0")}`));
    }

    await push(feed);

    // Every absent SKU is delisted, none is skipped by a half-written batch.
    const delisted = Object.keys(savedDocs).filter(
      (p) => p.startsWith("products/") && savedDocs[p].delistedFromPos === true
    );
    expect(delisted).toHaveLength(total);
    expect(savedDocs["products/prod_demo_keep000"].delistedFromPos).toBeUndefined();
    expect(savedDocs["products/prod_demo_keep000"].inStock).toBe(true);

    expect(lastSyncLog()).toMatchObject({ prunedCount: total, skippedPruneReason: null });
    // Firestore caps a batch at 500 writes; nothing may exceed it.
    expect(batchLog.length).toBeGreaterThan(1);
    for (const entry of batchLog) expect(entry.ops).toBeLessThanOrEqual(500);
  });

  it("never lowers the guard's catalogue memory when it prunes nothing", async () => {
    // A refused/empty run must not overwrite petpoojaItemCount with its own
    // (small) item count, or the NEXT tick's 50% bar drops to a size that a
    // partial feed can clear — the guard would disarm itself.
    seedBranch("demo", 10);
    for (let i = 0; i < 10; i++) seedOwnedProduct(`sku${i}`);

    await push([feedItem("sku0")]);

    expect(savedDocs["branches/demo"].petpoojaItemCount).toBe(10);
    expect(lastSyncLog()).toMatchObject({ skippedPruneReason: "feed_below_threshold" });
  });

  it("reports a prune failure honestly without losing the sync result", async () => {
    seedBranch("demo", 3);
    seedOwnedProduct("gone");
    seedOwnedProduct("a");
    seedOwnedProduct("b");
    hooks.failDelistCommit = true;

    const result = await push([feedItem("a"), feedItem("b")]);

    // The main sync still succeeded and still merged its items.
    expect(result).toEqual({ itemCount: 2, categoriesCount: 1 });
    expect(savedDocs["products/prod_demo_a"].inStock).toBe(true);
    expect(savedDocs["products/prod_demo_b"].inStock).toBe(true);
    // The failed prune is NOT reported as a clean run.
    expect(lastSyncLog()).toMatchObject({
      status: "COMPLETED",
      prunedCount: 0,
      skippedPruneReason: "prune_failed",
    });
    expect(savedDocs["products/prod_demo_gone"].inStock).toBe(true);
  });
});
