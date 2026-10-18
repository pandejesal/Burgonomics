import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

// Regression for references/petpooja_save_order_api.md §16.10.
//
// The Menu API reports ITS OWN failures with HTTP 200, e.g.
//   {"success":"0","message":"unable to fetch Object from s3 bucket"}
// The live fetch only checked `response.ok`, so that body fell through to
// `menuData.items || []`, synced zero items, then logged the run as
// COMPLETED / error: null / created: 0 and stamped lastPetpoojaSync on the
// branch. A vendor outage was indistinguishable from an outlet that honestly has
// no menu (observed live for outlet 31z58ciw0h at 2026-10-17T10:30Z).
//
// These tests drive the REAL live path (mock.petpoojaPos = false) with the POS
// HTTP call stubbed, so they fail if the wiring is dropped even when
// `menuApiFailureReason` itself is still correct.
//
// Push tests cover both mock ingestion and live indexed outlet resolution,
// including the live-only ghost-SKU retirement pass.

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
          opts?.merge && savedDocs[path] ? { ...savedDocs[path], ...data } : data;
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
        .filter((path) => filters.every(([field, op, value]) => {
          if (op !== "==") throw new Error(`Unsupported query operator: ${op}`);
          return savedDocs[path][field] === value;
        }))
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
      add: vi.fn(async (data: any) => {
        savedDocs[`${col}/added_${Object.keys(savedDocs).length}`] = data;
        return { id: `added` };
      }),
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

import {
  syncPetpoojaMenu,
  handlePetpoojaMenuWebhook,
  menuApiFailureReason,
} from "../src/modules/petpooja";
// Imported directly rather than through the petpooja barrel: this helper backs
// the /petpooja/menu-sync 503-vs-400 mapping, and importing src/index.ts in a
// test would boot the whole app. (The barrel is owned by another change.)
import { menuSyncFailureStatus } from "../src/modules/petpooja/menuSyncWebhook";
// The audit trail is imported directly, not through the barrel, for the same
// reason: it is the /petpooja/webhook route's only outlet-attribution record.
import {
  auditPetpoojaWebhook,
  extractPetpoojaWebhookRestId,
} from "../src/modules/petpooja/webhookAudit";
import { config } from "../src/config/env";
// Sanitized vendor-truth fixture derived from a real captured Push Menu body
// (see the file's own header-less shape: no operator/personal fields, no
// restaurants[].details beyond a placeholder sharing code). Loaded through the
// real JSON module so the test reads exactly the bytes committed on disk.
import petpoojaMenuPushSample from "./fixtures/petpooja-menupush-sample.json";

const DEMO_REST_ID = "31z58ciw0h";

/** The real push body shape, captured live from a successful 166-item push. */
const REAL_PUSH_BODY = {
  success: "1",
  message: "Menu items are successfully listed.",
  restaurants: [{ restaurantid: "5439", details: { menusharingcode: "31z58ciw0h" } }],
  categories: [{ categoryid: "cat_burgers", categoryname: "Signature Burgers" }],
  items: [
    {
      itemid: "pp_b1",
      itemname: "Classic Smash Cheese Burger",
      price: 199,
      itemcategoryname: "Signature Burgers",
      itemcategoryid: "cat_burgers",
      in_stock: 1,
      item_attributeid: "1",
    },
    {
      itemid: "pp_s1",
      itemname: "Cajun Seasoned Fries",
      price: 99,
      itemcategoryname: "Crispy Fries & Sides",
      itemcategoryid: "cat_sides",
      in_stock: 1,
      item_attributeid: "1",
    },
  ],
};

const syncLogRows = () =>
  Object.keys(savedDocs).filter((k) => k.startsWith("petpooja_sync_logs/"));

const productRows = () => Object.keys(savedDocs).filter((k) => k.startsWith("products/"));

const snapshotRows = () =>
  Object.keys(savedDocs).filter((k) => k.startsWith("dev_error_snapshots/"));

describe("Petpooja Menu API — a 200 that reports the vendor's own failure", () => {
  let prevMock: boolean;
  const fetchMock = vi.fn();

  beforeEach(() => {
    for (const key of Object.keys(savedDocs)) delete savedDocs[key];
    prevMock = config.mock.petpoojaPos;
    config.mock.petpoojaPos = false; // live path — the Menu API call is stubbed
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    savedDocs[`branches/demo`] = { petpoojaStoreId: DEMO_REST_ID };
  });

  afterEach(() => {
    config.mock.petpoojaPos = prevMock;
    vi.unstubAllGlobals();
  });

  it("rejects instead of logging a healthy empty sync (the live 10:30Z shape)", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: "0", message: "unable to fetch Object from s3 bucket" }),
    });

    await expect(syncPetpoojaMenu("demo")).rejects.toThrow(
      /refused the catalog lookup for outlet 31z58ciw0h: unable to fetch Object from s3 bucket/
    );

    // The whole point: no green row, and the branch is not stamped as freshly
    // synced. Before the fix both of these happened.
    expect(syncLogRows()).toEqual([]);
    expect(savedDocs["branches/demo"].lastPetpoojaSync).toBeUndefined();
  });

  it("records the vendor refusal for observability, at below-high severity", async () => {
    // Suppressing the false success is only half the fix: the on-call trail has
    // to show WHY the lookup produced nothing.
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: "0", message: "unable to fetch Object from s3 bucket" }),
    });

    const caught = await syncPetpoojaMenu("demo").catch((e) => e);

    // The marker the snapshot and the route branch on, asserted directly.
    expect(caught.vendorRefusal).toBe(true);

    const rows = snapshotRows();
    expect(rows.length).toBe(1);
    expect(savedDocs[rows[0]].source).toBe("petpooja");
    expect(savedDocs[rows[0]].message).toContain("unable to fetch Object from s3 bucket");
    // The scheduler ticks HOURLY — a 'high' severity here pages on-call every
    // hour for one outlet whose menu file is not provisioned yet.
    expect(savedDocs[rows[0]].severity).not.toBe("high");
    expect(savedDocs[rows[0]].severity).toBe("medium");
  });

  it("keeps an UNEXPECTED failure at high severity (no blanket downgrade)", async () => {
    fetchMock.mockRejectedValue(new TypeError("network down"));

    const caught = await syncPetpoojaMenu("demo").catch((e) => e);

    expect(caught.vendorRefusal).toBeUndefined();
    const rows = snapshotRows();
    expect(rows.length).toBe(1);
    expect(savedDocs[rows[0]].severity).toBe("high");
  });

  it("still syncs a genuinely empty catalog (guards against over-correction)", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: "1", items: [], categories: [] }),
    });

    await expect(syncPetpoojaMenu("demo")).resolves.toBeDefined();

    const rows = syncLogRows();
    expect(rows.length).toBe(1);
    expect(savedDocs[rows[0]]).toMatchObject({ storeId: "demo", created: 0, status: "COMPLETED" });
  });

  it("still rejects a non-200 (unchanged behaviour)", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 502, json: async () => ({}) });
    await expect(syncPetpoojaMenu("demo")).rejects.toThrow(/HTTP 502/);
  });

  it("rejects a null / array body with a named failure, not a TypeError", async () => {
    // Previously `menuData.items` threw "Cannot read properties of null" —
    // unclassified, so it looked like a bug in our code rather than a bad body.
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => null });
    await expect(syncPetpoojaMenu("demo")).rejects.toThrow(/response was not a menu object/);

    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => [] });
    await expect(syncPetpoojaMenu("demo")).rejects.toThrow(/response was not a menu object/);
  });

  it("classifies a MALFORMED body as unexpected, not as a vendor refusal", async () => {
    // FINDING 3: `{}` / null / [] used to take the same `vendorRefusal` marker as
    // a falsy `success`, so the route answered 503 ("retry") where it had always
    // answered 400. The marker must now say malformed and the severity must stay
    // high (a broken body is not a transient vendor outage).
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    const caught = await syncPetpoojaMenu("demo").catch((e) => e);

    expect(caught.vendorRefusal).toBeUndefined();
    expect(caught.malformedMenuBody).toBe(true);
    expect(caught.message).toContain("response was an empty object");
    expect(menuSyncFailureStatus(caught)).toBe(400);

    const rows = snapshotRows();
    expect(rows.length).toBe(1);
    expect(savedDocs[rows[0]].severity).toBe("high");
  });

  it("FLAGS a prose-only failure body in the log's error field instead of reporting a clean sync", async () => {
    // FINDING 4c: {"message":"unable to fetch Object from s3 bucket"} carries no
    // `success` key at all, so it is accepted (refusing it risks discarding a
    // legitimate body that nests its catalogue under `restaurants`) — but it must
    // not be written as COMPLETED / error: null, which hides the vendor failure.
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ message: "unable to fetch Object from s3 bucket" }),
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(syncPetpoojaMenu("demo")).resolves.toBeDefined();

    const rows = syncLogRows();
    expect(rows.length).toBe(1);
    expect(savedDocs[rows[0]].error).toBe("unable to fetch Object from s3 bucket");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("still records error: null for a genuinely empty catalogue", async () => {
    // The other half of FINDING 4c: {"success":"1","items":[]} is an honest empty
    // menu, so the `error` field must stay null.
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: "1", items: [], categories: [] }),
    });

    await syncPetpoojaMenu("demo");

    const rows = syncLogRows();
    expect(rows.length).toBe(1);
    expect(savedDocs[rows[0]].error).toBeNull();
  });
});

describe("Petpooja menu PUSH webhook — a push the vendor already reported as failed", () => {
  let prevMock: boolean;

  beforeEach(() => {
    for (const key of Object.keys(savedDocs)) delete savedDocs[key];
    prevMock = config.mock.petpoojaPos;
    // A push resolves its branch through mock mode here; the ingestion branch
    // (incomingMenu) is the same one a live push takes.
    config.mock.petpoojaPos = true;
    savedDocs["branches/demo"] = { petpoojaStoreId: DEMO_REST_ID };
  });

  afterEach(() => {
    config.mock.petpoojaPos = prevMock;
  });

  it("ACCEPTS the real push body (success is truthy)", async () => {
    const res = await handlePetpoojaMenuWebhook(REAL_PUSH_BODY);

    expect(res.success).toBe(true);
    expect(res.itemCount).toBeGreaterThan(0);
    expect(syncLogRows().length).toBe(1);
  });

  it("REFUSES a push the vendor reported as failed, without writing a green row", async () => {
    // The bare observed failure shape: pre-fix this threw "Missing rest_id"
    // (never naming the vendor failure) rather than being classified as one.
    await expect(handlePetpoojaMenuWebhook({ success: "0", items: [] })).rejects.toThrow(
      /refused the catalog lookup for outlet/
    );

    // Same body with a resolvable outlet: pre-fix this was ACCEPTED as an empty
    // catalogue — a green COMPLETED row, petpoojaItemCount: 0, and
    // {"success":true,"itemCount":0}.
    savedDocs["branches/branch_pp_refused"] = { petpoojaStoreId: "branch_pp_refused" };
    const caught = await handlePetpoojaMenuWebhook({
      success: "0",
      items: [],
      rest_id: "branch_pp_refused",
    }).catch((e) => e);

    expect(caught.vendorRefusal).toBe(true);
    expect(caught.message).toContain("refused the catalog lookup for outlet branch_pp_refused");

    expect(syncLogRows()).toEqual([]);
    expect(savedDocs["branches/branch_pp_refused"].lastPetpoojaSync).toBeUndefined();
    expect(savedDocs["branches/branch_pp_refused"].petpoojaItemCount).toBeUndefined();
  });

  it("REFUSES a vendor-failed body handed STRAIGHT to the exported syncPetpoojaMenu, writing nothing", async () => {
    // The webhook classifies a push before it calls syncPetpoojaMenu, but
    // syncPetpoojaMenu is EXPORTED and takes `incomingMenu` as a parameter, so
    // that guarantee cannot rest on the single caller: any other caller could
    // hand it a body the vendor reported as failed. {"success":"0","items":[…]}
    // passes the branch's own `Array.isArray(items)` precondition, so pre-fix
    // this synced the item and wrote a green COMPLETED row plus a branch stamp.
    await expect(
      syncPetpoojaMenu("demo", undefined, { success: "0", items: [{ itemid: "x" }] })
    ).rejects.toThrow(/refused the catalog lookup for outlet 31z58ciw0h/);

    expect(productRows()).toEqual([]);
    expect(syncLogRows()).toEqual([]);
    expect(savedDocs["branches/demo"].lastPetpoojaSync).toBeUndefined();
    expect(savedDocs["branches/demo"].petpoojaItemCount).toBeUndefined();
  });
});

describe("Petpooja menu PUSH webhook — the LIVE (mock=false) push path (FINDING 1)", () => {
  let prevMock: boolean;

  beforeEach(() => {
    for (const key of Object.keys(savedDocs)) delete savedDocs[key];
    prevMock = config.mock.petpoojaPos;
    config.mock.petpoojaPos = false; // the real push path, not the mock short-circuit
    savedDocs["branches/demo"] = { petpoojaStoreId: DEMO_REST_ID };
  });

  afterEach(() => {
    config.mock.petpoojaPos = prevMock;
  });

  it("accepts the real push body end to end and takes the 'no linked branch' skip", async () => {
    // The classifier does NOT refuse a body whose own success flag is truthy —
    // this is the acceptance path AROUND the new refusal, composed end to end.
    expect(menuApiFailureReason(REAL_PUSH_BODY, DEMO_REST_ID)).toBeNull();

    // A genuinely unlinked outlet still takes the skip with query support.
    delete savedDocs["branches/demo"];
    const res = await handlePetpoojaMenuWebhook(REAL_PUSH_BODY);

    expect(res).toEqual({ success: false, itemCount: 0 });
    // A skipped push writes nothing at all: no products, no green sync-log row,
    // no branch stamp.
    expect(productRows()).toEqual([]);
    expect(syncLogRows()).toEqual([]);
    expect(savedDocs["branches/demo"]).toBeUndefined();
  });

  it("resolves a LIVE push by sharing code, ingests under the branch, and retires only absent orderable POS SKUs", async () => {
    const ghostPath = "products/prod_demo_ghost";
    savedDocs[ghostPath] = {
      branchId: "demo", restId: DEMO_REST_ID, petpoojaItemId: "ghost",
      name: "Removed from POS", inStock: true,
    };
    const protectedDocs = {
      "products/prod_other_ghost": { branchId: "other", petpoojaItemId: "ghost", inStock: true },
      "products/prod_demo_combo": { branchId: "demo", petpoojaItemId: "combo", isCombo: true, inStock: true },
      "products/prod_demo_local": { branchId: "demo", inStock: true },
      "products/prod_demo_already_out": { branchId: "demo", petpoojaItemId: "already_out", inStock: false },
    };
    Object.assign(savedDocs, protectedDocs);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    try {
      expect(menuApiFailureReason(REAL_PUSH_BODY, DEMO_REST_ID)).toBeNull();
      const res = await handlePetpoojaMenuWebhook(REAL_PUSH_BODY);

      expect(res).toEqual({ success: true, itemCount: 2 });
      expect(fetchMock).not.toHaveBeenCalled(); // inbound catalog, not a pull
      for (const item of REAL_PUSH_BODY.items) {
        expect(savedDocs[`products/prod_demo_${item.itemid}`]).toMatchObject({
          branchId: "demo", restId: DEMO_REST_ID, petpoojaItemId: item.itemid,
          name: item.itemname, inStock: true,
        });
        expect(savedDocs[`products/prod_${DEMO_REST_ID}_${item.itemid}`]).toBeUndefined();
      }
      expect(savedDocs["branches/demo"].petpoojaItemCount).toBe(2);
      expect(syncLogRows()).toHaveLength(1);
      expect(savedDocs[syncLogRows()[0]]).toMatchObject({
        storeId: "demo", status: "COMPLETED", created: 2, error: null, simulated: false,
      });

      // Source: "Never DELETE: flip inStock:false + ghostRetired"; preserve data.
      expect(savedDocs[ghostPath]).toEqual({
        branchId: "demo", restId: DEMO_REST_ID, petpoojaItemId: "ghost",
        name: "Removed from POS", inStock: false, ghostRetired: true,
        ghostRetiredAt: "MOCK_TIMESTAMP", updatedAt: "MOCK_TIMESTAMP",
      });
      for (const [path, data] of Object.entries(protectedDocs)) {
        expect(savedDocs[path]).toEqual(data);
      }
      expect(snapshotRows()).toHaveLength(1);
      expect(savedDocs[snapshotRows()[0]]).toMatchObject({
        branchId: "demo", severity: "medium",
        message: expect.stringContaining("retired 1 ghost SKU(s)"),
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not retire existing POS SKUs when a LIVE push carries an empty feed", async () => {
    const ghost = { branchId: "demo", petpoojaItemId: "ghost", inStock: true };
    savedDocs["products/prod_demo_ghost"] = ghost;

    await expect(handlePetpoojaMenuWebhook({ ...REAL_PUSH_BODY, items: [] }))
      .resolves.toEqual({ success: true, itemCount: 0 });

    // Source guard: live mode AND items.length > 0; an empty feed retires nothing.
    expect(savedDocs["products/prod_demo_ghost"]).toEqual(ghost);
    expect(snapshotRows()).toEqual([]);
    expect(syncLogRows()).toHaveLength(1);
    expect(savedDocs[syncLogRows()[0]]).toMatchObject({ created: 0, simulated: false });
  });
});

describe("demo re-push blast radius (isolation)", () => {
  // A menu re-push against the demo outlet is gated on proof it cannot disturb
  // anything outside the demo branch. The ingest writes branch-scoped
  // `products/prod_<branchId>_<itemid>` docs + a `branches/<branchId>` stamp +
  // a sync-log row, and runs a RETIRE pass over absent branch-scoped SKUs.
  // These tests drive the LIVE (mock=false) path — the one the demo re-push
  // would take — and assert the whole write set is demo-scoped, with every
  // foreign branch's documents byte-identical afterwards.
  //
  // Same harness as the live-push tests above: vi.hoisted mockDb/savedDocs, the
  // extended collection() query surface, and the branches/demo outlet link.
  let prevMock: boolean;
  const fetchMock = vi.fn();

  beforeEach(() => {
    for (const key of Object.keys(savedDocs)) delete savedDocs[key];
    prevMock = config.mock.petpoojaPos;
    config.mock.petpoojaPos = false; // LIVE path — branch resolved via sharing code
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    savedDocs["branches/demo"] = { petpoojaStoreId: DEMO_REST_ID };
  });

  afterEach(() => {
    config.mock.petpoojaPos = prevMock;
    vi.unstubAllGlobals();
  });

  /** Deep copy of the double's stored docs, for a before/after write diff. */
  const snapshotDocs = (): Record<string, any> => JSON.parse(JSON.stringify(savedDocs));

  /** Keys this run created or mutated, by comparing stored docs before vs after. */
  const changedKeys = (before: Record<string, any>): string[] =>
    Object.keys(savedDocs).filter(
      (path) =>
        !Object.prototype.hasOwnProperty.call(before, path) ||
        JSON.stringify(before[path]) !== JSON.stringify(savedDocs[path])
    );

  it("writes ONLY demo-scoped documents, leaving both foreign branch docs untouched", async () => {
    // Two foreign branches' documents, each a FULLY specified field set so a
    // stray merge/overwrite of ANY field is detectable — not just a rename.
    const westbankDoc = {
      id: "prod_westbank_70001",
      branchId: "westbank",
      restId: "westbank-rest-id",
      petpoojaItemId: "70001",
      name: "Westbank Malai Kofta",
      description: "Foreign outlet's dish — a demo push must never touch it",
      price: 349,
      categoryId: "cat_west_1",
      categoryName: "Westbank Mains",
      imageUrl: "https://cdn.example.com/westbank/70001.png",
      inStock: true,
      isVeg: true,
      lastPetpoojaSync: "SEEDED_WESTBANK_SYNC",
      updatedAt: "SEEDED_WESTBANK_UPDATED",
    };
    const hlRoadDoc = {
      id: "prod_hl-road_70002",
      branchId: "hl-road",
      restId: "hl-road-rest-id",
      petpoojaItemId: "70002",
      name: "HL Road Chicken Curry",
      description: "Foreign outlet's dish — a demo push must never touch it",
      price: 389,
      categoryId: "cat_hl_1",
      categoryName: "HL Road Mains",
      imageUrl: null,
      inStock: true,
      isVeg: false,
      lastPetpoojaSync: "SEEDED_HL_SYNC",
      updatedAt: "SEEDED_HL_UPDATED",
    };
    savedDocs["products/prod_westbank_70001"] = westbankDoc;
    savedDocs["products/prod_hl-road_70002"] = hlRoadDoc;

    const before = snapshotDocs();
    const res = await handlePetpoojaMenuWebhook(REAL_PUSH_BODY);

    expect(res).toEqual({ success: true, itemCount: 2 });
    expect(fetchMock).not.toHaveBeenCalled(); // inbound catalog, not a pull

    const changed = changedKeys(before);
    const writtenProductKeys = changed.filter((k) => k.startsWith("products/"));

    // (a) Every product document this run created or mutated is demo-scoped.
    const nonDemoWrites = writtenProductKeys.filter(
      (k) => !k.startsWith("products/prod_demo_")
    );
    expect(
      nonDemoWrites,
      `a demo push wrote non-demo product document(s): ${nonDemoWrites.join(", ")}`
    ).toEqual([]);
    // Positive control: the push DID write the two demo docs it should have.
    expect(writtenProductKeys.sort()).toEqual([
      "products/prod_demo_pp_b1",
      "products/prod_demo_pp_s1",
    ]);

    // (b) BOTH foreign documents are exactly what was seeded — untouched.
    expect(savedDocs["products/prod_westbank_70001"]).toEqual(westbankDoc);
    expect(savedDocs["products/prod_hl-road_70002"]).toEqual(hlRoadDoc);

    // (c) No written key names another branch (westbank / hl-road), nor the raw
    // Petpooja sharing code as a branch segment.
    for (const foreignToken of ["westbank", "hl-road", DEMO_REST_ID]) {
      const offenders = changed.filter((k) => k.includes(foreignToken));
      expect(
        offenders,
        `a demo push wrote a key naming '${foreignToken}': ${offenders.join(", ")}`
      ).toEqual([]);
    }

    // (d) The branch stamp lands on branches/demo and nowhere else.
    expect(changed.filter((k) => k.startsWith("branches/"))).toEqual(["branches/demo"]);
    expect(savedDocs["branches/demo"]).toMatchObject({ petpoojaItemCount: 2 });

    // (e) The mock-mode doc shape (prod_<restId>_<itemid>) must NOT appear on the
    // live path — that global id is the collision the branch-scoped id prevents.
    const mockShapeKeys = Object.keys(savedDocs).filter((k) =>
      k.startsWith(`products/prod_${DEMO_REST_ID}_`)
    );
    expect(
      mockShapeKeys,
      `live push wrote mock-mode product id(s): ${mockShapeKeys.join(", ")}`
    ).toEqual([]);
    for (const item of REAL_PUSH_BODY.items) {
      expect(savedDocs[`products/prod_${DEMO_REST_ID}_${item.itemid}`]).toBeUndefined();
    }

    // No ghost/retire write happened here (nothing demo-scoped was absent).
    expect(snapshotRows()).toEqual([]);
    expect(syncLogRows()).toHaveLength(1);
    expect(savedDocs[syncLogRows()[0]]).toMatchObject({
      storeId: "demo",
      status: "COMPLETED",
      created: 2,
      simulated: false,
    });
  });

  it("RETIREs only the absent DEMO-scoped SKU, leaving a stale foreign SKU untouched", async () => {
    // Source `syncPetpoojaMenu` tombstone block (live-only, items.length > 0):
    //   where("branchId","==",branchId) → per doc with a petpoojaItemId NOT in
    //   the feed and inStock !== false:
    //   d.ref.set({ inStock:false, ghostRetired:true,
    //               ghostRetiredAt: serverTimestamp(),
    //               updatedAt: serverTimestamp() }, { merge:true })
    // `branchId` is the resolved DEMO branch, so the query is branch-scoped and
    // cannot see another branch's docs — asserted below rather than assumed.
    const staleDemo = {
      id: "prod_demo_stale",
      branchId: "demo",
      restId: DEMO_REST_ID,
      petpoojaItemId: "stale-from-an-older-feed",
      name: "Stale Demo SKU",
      price: 123,
      inStock: true,
    };
    const staleForeign = {
      id: "prod_westbank_70001",
      branchId: "westbank",
      restId: "westbank-rest-id",
      petpoojaItemId: "70001",
      name: "Westbank Malai Kofta",
      price: 349,
      inStock: true,
      updatedAt: "SEEDED_WESTBANK_UPDATED",
    };
    savedDocs["products/prod_demo_stale"] = staleDemo;
    savedDocs["products/prod_westbank_70001"] = staleForeign;

    const res = await handlePetpoojaMenuWebhook(REAL_PUSH_BODY);

    expect(res).toEqual({ success: true, itemCount: 2 });

    // The stale DEMO SKU is retired EXACTLY as the source does it: merged onto
    // the existing doc (never deleted, never re-priced/re-described), flipped
    // out-of-stock and marked ghostRetired, with the two timestamps.
    expect(savedDocs["products/prod_demo_stale"]).toEqual({
      ...staleDemo,
      inStock: false,
      ghostRetired: true,
      ghostRetiredAt: "MOCK_TIMESTAMP",
      updatedAt: "MOCK_TIMESTAMP",
    });
    expect(savedDocs["products/prod_demo_stale"]).toMatchObject({
      inStock: false,
      ghostRetired: true,
      ghostRetiredAt: "MOCK_TIMESTAMP",
      updatedAt: "MOCK_TIMESTAMP",
    });

    // The stale FOREIGN SKU is untouched — the retire query is demo-scoped.
    expect(savedDocs["products/prod_westbank_70001"]).toEqual(staleForeign);

    // The retire pass reported exactly one retirement, for the demo branch.
    expect(snapshotRows()).toHaveLength(1);
    expect(savedDocs[snapshotRows()[0]]).toMatchObject({
      source: "petpooja",
      severity: "medium",
      branchId: "demo",
      message: expect.stringContaining("retired 1 ghost SKU(s)"),
    });
  });
});

describe("Petpooja PUSH — the vendor's OWN field spellings (category join, description, image)", () => {
  // Live Firestore showed every doc written from the 166-item captured push as
  // categoryId "uncategorized" / categoryName "Other" / description "" / imageUrl
  // null. The push keys the item's category as `item_categoryid` and carries the
  // NAME only in the top-level `categories` array; the mapper read
  // `itemcategoryid` / `itemcategoryname` / `item_description`, none of which the
  // vendor sends. These pin the vendor spellings AND the legacy compatibility.
  let prevMock: boolean;

  beforeEach(() => {
    for (const key of Object.keys(savedDocs)) delete savedDocs[key];
    prevMock = config.mock.petpoojaPos;
    // Mock mode resolves the push's branch from rest_id (branchId = restId), so
    // `rest_id: "demo"` yields predictable `prod_demo_<itemid>` doc ids.
    config.mock.petpoojaPos = true;
    savedDocs["branches/demo"] = { petpoojaStoreId: DEMO_REST_ID };
  });

  afterEach(() => {
    config.mock.petpoojaPos = prevMock;
  });

  it("(a) maps the REAL spellings: item_categoryid -> the joined top-level categoryname, plus itemdescription", async () => {
    const res = await handlePetpoojaMenuWebhook({
      success: "1",
      message: "Menu items are successfully listed.",
      rest_id: "demo",
      categories: [
        { categoryid: "90762", categoryname: "Accompaniments" },
        { categoryid: "90750", categoryname: "Burgers" },
      ],
      items: [
        {
          itemid: "17314",
          itemname: "Classic Veg Burger",
          itemdescription: "Crispy smashed veg patty with house sauce",
          item_categoryid: "90750",
          item_image_url: "", // empty on all 166 today
          price: "199",
          in_stock: "2",
          item_attributeid: "1",
        },
      ],
    });

    expect(res).toEqual({ success: true, itemCount: 1 });
    const doc = savedDocs["products/prod_demo_17314"];
    expect(doc.categoryId).toBe("90750");
    expect(doc.categoryName).toBe("Burgers"); // joined from categories[], NOT "Other"
    expect(doc.description).toBe("Crispy smashed veg patty with house sauce");
  });

  it("(b) still maps the LEGACY spellings exactly as before (compatibility half)", async () => {
    await handlePetpoojaMenuWebhook({
      success: "1",
      rest_id: "demo",
      // No top-level `categories` at all — the legacy path never needed one.
      items: [
        {
          itemid: "pp_b1",
          itemname: "Classic Smash Cheese Burger",
          item_description: "Legacy description",
          itemcategoryname: "Signature Burgers",
          itemcategoryid: "cat_burgers",
          price: 199,
          in_stock: 1,
          item_attributeid: "1",
        },
      ],
    });

    const doc = savedDocs["products/prod_demo_pp_b1"];
    expect(doc.categoryId).toBe("cat_burgers");
    expect(doc.categoryName).toBe("Signature Burgers");
    expect(doc.description).toBe("Legacy description");
  });

  it("(c) falls back to Other for an id the catalog does not carry, without throwing", async () => {
    const res = await handlePetpoojaMenuWebhook({
      success: "1",
      rest_id: "demo",
      categories: [{ categoryid: "90762", categoryname: "Accompaniments" }],
      items: [
        {
          itemid: "orphan",
          itemname: "Orphan Item",
          item_categoryid: "99999", // id present on the item, absent from categories
          price: "10",
          in_stock: "2",
        },
      ],
    });

    expect(res).toEqual({ success: true, itemCount: 1 });
    const doc = savedDocs["products/prod_demo_orphan"];
    expect(doc.categoryId).toBe("99999"); // the id the payload DID carry is kept
    expect(doc.categoryName).toBe("Other"); // ...and only the name falls back
  });

  it("(c) survives a missing or non-array `categories`, and unusable entries, without throwing", async () => {
    // `categories` absent entirely.
    await expect(
      handlePetpoojaMenuWebhook({
        success: "1",
        rest_id: "demo",
        items: [{ itemid: "m1", itemname: "M", item_categoryid: "1", price: "5", in_stock: "2" }],
      })
    ).resolves.toEqual({ success: true, itemCount: 1 });
    expect(savedDocs["products/prod_demo_m1"].categoryName).toBe("Other");

    // `categories` present but NOT an array.
    await expect(
      handlePetpoojaMenuWebhook({
        success: "1",
        rest_id: "demo",
        categories: "not-an-array",
        items: [
          {
            itemid: "m2",
            itemname: "M2",
            item_categoryid: "1",
            itemcategoryname: "Legacy Name",
            price: "5",
            in_stock: "2",
          },
        ],
      })
    ).resolves.toEqual({ success: true, itemCount: 1 });
    expect(savedDocs["products/prod_demo_m2"].categoryName).toBe("Legacy Name");

    // Array with junk entries and an entry missing the NAME for the item's id.
    await expect(
      handlePetpoojaMenuWebhook({
        success: "1",
        rest_id: "demo",
        categories: [null, "x", { categoryname: "No Id" }, { categoryid: "42" }],
        items: [
          {
            itemid: "m3",
            itemname: "M3",
            item_categoryid: "42",
            itemcategoryname: "Legacy For 42",
            price: "5",
            in_stock: "2",
          },
        ],
      })
    ).resolves.toEqual({ success: true, itemCount: 1 });
    expect(savedDocs["products/prod_demo_m3"].categoryName).toBe("Legacy For 42");
  });

  it("(d) picks up item_image_url when it carries a value, and stays null when it is the empty string", async () => {
    await handlePetpoojaMenuWebhook({
      success: "1",
      rest_id: "demo",
      items: [
        {
          itemid: "img",
          itemname: "Has Image",
          item_image_url: "https://cdn.example.com/items/img.png",
          price: "5",
          in_stock: "2",
        },
        {
          itemid: "noimg",
          itemname: "Empty Image",
          item_image_url: "", // the observed value on all 166 today
          price: "5",
          in_stock: "2",
        },
      ],
    });

    expect(savedDocs["products/prod_demo_img"].imageUrl).toBe(
      "https://cdn.example.com/items/img.png"
    );
    expect(savedDocs["products/prod_demo_noimg"].imageUrl).toBeNull();
  });

  it("(e) resolves a DUPLICATE categoryid to the FIRST entry's name (first-wins)", async () => {
    // The top-level catalog is a join keyed by `categoryid`. When a payload
    // repeats an id, the mapper used to `map.set(...)` unconditionally, so the
    // LAST duplicate overwrote every earlier name. The first catalogued name is
    // the one that must survive.
    await handlePetpoojaMenuWebhook({
      success: "1",
      rest_id: "demo",
      categories: [
        { categoryid: "90750", categoryname: "Burgers" },
        { categoryid: "90750", categoryname: "Burgers (later duplicate)" },
      ],
      items: [
        {
          itemid: "dupid",
          itemname: "Duplicate Category Item",
          item_categoryid: "90750",
          price: "5",
          in_stock: "2",
        },
      ],
    });

    const doc = savedDocs["products/prod_demo_dupid"];
    expect(doc.categoryId).toBe("90750");
    expect(doc.categoryName).toBe("Burgers"); // FIRST entry, not the duplicate
  });

  it("(f) normalises a NUMERIC item_categoryid to a string on the document", async () => {
    // The vendor sends the id as a string today. If a number ever appears it
    // must not be written into the doc as a number — String(...) wraps the whole
    // resolution, and the catalog lookup normalises the same way so the join
    // still resolves.
    await handlePetpoojaMenuWebhook({
      success: "1",
      rest_id: "demo",
      categories: [{ categoryid: "90750", categoryname: "Burgers" }],
      items: [
        {
          itemid: "numcat",
          itemname: "Numeric Category Item",
          item_categoryid: 90750, // a NUMBER, not the string "90750"
          price: "5",
          in_stock: "2",
        },
      ],
    });

    const doc = savedDocs["products/prod_demo_numcat"];
    expect(typeof doc.categoryId).toBe("string");
    expect(doc.categoryId).toBe("90750");
    expect(doc.categoryName).toBe("Burgers"); // the catalog join still resolves
  });
});

describe("Petpooja menu PUSH — the sanitized vendor-truth fixture", () => {
  // The alias work only matters if it runs against the REAL push shape. This
  // fixture is derived from a captured 166-item Push Menu body with every
  // operator/personal field dropped: no `restaurants[0].details` (it carries the
  // owner id, contact number, city and sharing code), no phone/email/address,
  // and only the placeholder sharing code. What is kept is the vendor's OWN key
  // shapes — `item_categoryid` on the item joined to `categories[].categoryid`,
  // `itemdescription`, `item_image_url` — so the mapping is asserted against
  // vendor truth rather than against a hand-shaped test body.
  let prevMock: boolean;

  beforeEach(() => {
    for (const key of Object.keys(savedDocs)) delete savedDocs[key];
    prevMock = config.mock.petpoojaPos;
    // Mock mode resolves the push's branch from the sharing code in the fixture.
    config.mock.petpoojaPos = true;
  });

  afterEach(() => {
    config.mock.petpoojaPos = prevMock;
  });

  it("maps categoryId/categoryName/description from the vendor's own keys, and null image", async () => {
    const res = await handlePetpoojaMenuWebhook(petpoojaMenuPushSample);

    expect(res).toEqual({ success: true, itemCount: 2 });

    const doc = savedDocs["products/prod_SANITIZED_30674"];
    // categoryId comes from the item's `item_categoryid`...
    expect(doc.categoryId).toBe("90746");
    expect(typeof doc.categoryId).toBe("string");
    // ...and categoryName is the top-level catalog join on that id.
    expect(doc.categoryName).toBe("Veg Tandoori Starters");
    // description comes from `itemdescription` (non-empty on this real item).
    expect(doc.description).toBe(
      "[Veg preparation] Paneer cubes marinated with pickling spices, yoghurt, and herbs, grilled till lightly charred, delivering tangy flavours with a smoky finish, served hot with onion salad and mint dip."
    );
    // The real `item_image_url` is the empty string, so imageUrl is null.
    expect(doc.imageUrl).toBeNull();

    // The second item joins to the other catalog entry.
    const doc2 = savedDocs["products/prod_SANITIZED_30661"];
    expect(doc2.categoryId).toBe("90745");
    expect(doc2.categoryName).toBe("Meal For 1");
    expect(doc2.description).toBe(
      "Shahi Paneer [300ml] With Boondi Raita [175ml] & Choice Of Breads"
    );
    expect(doc2.imageUrl).toBeNull();
  });
});

// The 166-item Sold-Out incident: every item carried `"in_stock": "2"`, the
// whitelist (1 / "1" / true) mapped all of them to `inStock: false`, and the run
// wrote a green COMPLETED row — a fully dark catalogue looked like a healthy
// sync. These pin the two additive guards: the RAW in_stock census is recorded
// on the sync-log row, and an ALL-DARK run warns once. The whitelist itself is
// NOT changed here — whether "2" means available is still open.
describe("Petpooja menu PUSH — the in_stock census and the ALL-DARK warning", () => {
  let prevMock: boolean;

  /** console.warn is spied per-test; never leaked into a sibling assertion. */
  const spyOnWarn = () => vi.spyOn(console, "warn").mockImplementation(() => {});

  const warnText = (warn: any) => warn.mock.calls.map((c: any[]) => String(c[0])).join("\n");

  const latestSyncLog = () => savedDocs[syncLogRows()[0]];

  beforeEach(() => {
    for (const key of Object.keys(savedDocs)) delete savedDocs[key];
    prevMock = config.mock.petpoojaPos;
    config.mock.petpoojaPos = true; // the push path resolves branchId = rest_id
    savedDocs["branches/demo"] = { petpoojaStoreId: DEMO_REST_ID };
  });

  afterEach(() => {
    config.mock.petpoojaPos = prevMock;
  });

  it("(a) records the raw census AND warns when EVERY item is unrecognised (all dark)", async () => {
    const warn = spyOnWarn();
    try {
      const res = await handlePetpoojaMenuWebhook({
        success: "1",
        rest_id: "demo",
        categories: [{ categoryid: "90750", categoryname: "Burgers" }],
        items: [
          { itemid: "17314", itemname: "Classic Veg Burger", item_categoryid: "90750", price: "199", in_stock: "2" },
          { itemid: "17315", itemname: "Paneer Burger", item_categoryid: "90750", price: "219", in_stock: "2" },
          { itemid: "17316", itemname: "Peri Peri Fries", item_categoryid: "90750", price: "99", in_stock: "2" },
        ],
      });

      expect(res).toEqual({ success: true, itemCount: 3 });

      // 1. The census lands on the sync-log row, additively.
      expect(syncLogRows().length).toBe(1);
      expect(latestSyncLog().inStockValues).toEqual({ "2": 3 });
      // Existing fields keep their meaning.
      expect(latestSyncLog().status).toBe("COMPLETED");
      expect(latestSyncLog().error).toBeNull();
      expect(latestSyncLog().created).toBe(3);

      // 2. The warning names the OUTLET and the raw value with its count.
      expect(warn).toHaveBeenCalled();
      const message = warnText(warn);
      expect(message).toContain(DEMO_REST_ID);
      expect(message).toContain("ingested 3 items");
      expect(message).toContain("2 x3");
      expect(message).toContain("Sold Out");
    } finally {
      warn.mockRestore();
    }
  });

  it("(b) records the census and stays SILENT for a PARTIALLY dark catalogue (genuine 86-ing)", async () => {
    const warn = spyOnWarn();
    try {
      await handlePetpoojaMenuWebhook({
        success: "1",
        rest_id: "demo",
        items: [
          { itemid: "in1", itemname: "Available", price: "10", in_stock: 1 },
          { itemid: "out1", itemname: "86-ed", price: "10", in_stock: "2" },
          { itemid: "out2", itemname: "Also 86-ed", price: "10", in_stock: "0" },
        ],
      });

      expect(latestSyncLog().inStockValues).toEqual({ "1": 1, "2": 1, "0": 1 });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("(c) records the census and stays SILENT when every item IS in stock", async () => {
    const warn = spyOnWarn();
    try {
      await handlePetpoojaMenuWebhook({
        success: "1",
        rest_id: "demo",
        items: [
          { itemid: "s1", itemname: "A", price: "10", in_stock: 1 },
          { itemid: "s2", itemname: "B", price: "10", in_stock: "1" },
          { itemid: "s3", itemname: "C", price: "10", in_stock: true },
        ],
      });

      // 1 / "1" / true collapse to one bucket (normalised only for grouping).
      expect(latestSyncLog().inStockValues).toEqual({ "1": 2, "true": 1 });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("(d) treats a zero-item sync as NOT all-dark, and survives odd shapes without throwing", async () => {
    const warn = spyOnWarn();
    try {
      // Zero items is an empty feed, not a dark catalogue.
      const res = await handlePetpoojaMenuWebhook({ success: "1", rest_id: "demo", items: [] });
      expect(res).toEqual({ success: true, itemCount: 0 });
      expect(latestSyncLog().inStockValues).toEqual({});
      expect(warn).not.toHaveBeenCalled();

      // A missing `in_stock`, and a NON-object entry in `items`: neither may
      // throw, and an all-dark warn must not fire spuriously (one item IS in
      // stock, so this is partially dark). `doc()`/`.doc()` reuse one key, so
      // the second row overwrites the first in this double.
      await handlePetpoojaMenuWebhook({
        success: "1",
        rest_id: "demo",
        items: [
          { itemid: "noflag", itemname: "No flag", price: "10" },
          "not-an-object",
          { itemid: "ok", itemname: "Ok", price: "10", in_stock: 1 },
        ],
      });
      expect(latestSyncLog().inStockValues).toEqual({ "(absent)": 2, "1": 1 });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

// The live fetch path can hand the census an `items`-less body (`menuData.items
// || []`); the push path can never reach it that way, because a body without an
// `items` array is routed to the mock/pull branch.
describe("Petpooja Menu API — a body with NO `items` array (census edge, live path)", () => {
  let prevMock: boolean;
  const fetchMock = vi.fn();

  beforeEach(() => {
    for (const key of Object.keys(savedDocs)) delete savedDocs[key];
    prevMock = config.mock.petpoojaPos;
    config.mock.petpoojaPos = false; // live path — the Menu API call is stubbed
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    savedDocs["branches/demo"] = { petpoojaStoreId: DEMO_REST_ID };
  });

  afterEach(() => {
    config.mock.petpoojaPos = prevMock;
    vi.unstubAllGlobals();
  });

  it("(d) does not throw and does not warn when the body carries no items array", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      // A truthy success flag with no catalogue at all: accepted, zero items.
      json: async () => ({ success: "1", message: "Menu items are successfully listed." }),
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(syncPetpoojaMenu("demo")).resolves.toEqual({
        itemCount: 0,
        categoriesCount: 0,
      });

      expect(syncLogRows().length).toBe(1);
      expect(savedDocs[syncLogRows()[0]].inStockValues).toEqual({});
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("Petpooja menu PUSH — unpriced SKU observability", () => {
  let prevMock: boolean;
  const spyOnWarn = () => vi.spyOn(console, "warn").mockImplementation(() => {});
  const latestSyncLog = () => savedDocs[syncLogRows()[0]];

  beforeEach(() => {
    for (const key of Object.keys(savedDocs)) delete savedDocs[key];
    prevMock = config.mock.petpoojaPos;
    config.mock.petpoojaPos = true;
    savedDocs["branches/demo"] = { petpoojaStoreId: DEMO_REST_ID };
  });

  afterEach(() => {
    config.mock.petpoojaPos = prevMock;
  });

  it("(a) records unpriced in-stock counts and warns once naming the outlet and missing variations", async () => {
    const warn = spyOnWarn();
    try {
      const res = await handlePetpoojaMenuWebhook({
        success: "1", rest_id: "demo", variations: [],
        items: [
          ...["1", 1, true].map((flag, index) => ({
            itemid: `missing${index}`, itemname: "Missing variation price",
            price: "0", in_stock: 1, itemallowvariation: flag, variation: [],
          })),
          { itemid: "defined", itemname: "Defined variation", price: 0, in_stock: "1", itemallowvariation: "1", variation: [{ price: "10" }] },
          { itemid: "invalid", itemname: "Invalid price", price: "unknown", in_stock: true },
          { itemid: "out", itemname: "Negative price", price: -1, in_stock: "2", itemallowvariation: "1" },
        ],
      });

      expect(res).toEqual({ success: true, itemCount: 6 });
      expect(syncLogRows()).toHaveLength(1);
      expect(latestSyncLog()).toMatchObject({
        unpricedSkuCount: 6, unpricedInStockCount: 5,
        unpricedVariationFlaggedCount: 5, unpricedInStockVariationMissingCount: 3,
        status: "COMPLETED", error: null, created: 6,
      });
      expect(savedDocs["products/prod_demo_missing0"]).toMatchObject({ price: 0, inStock: true });
      expect(snapshotRows()).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        `[Petpooja Menu Sync] outlet ${DEMO_REST_ID} ingested 6 items: 6 unpriced, 5 unpriced in stock; 3 of those are variation-flagged without definitions — live money hazard`
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("(b) records an out-of-stock unpriced SKU without a price warning", async () => {
    const warn = spyOnWarn();
    try {
      await handlePetpoojaMenuWebhook({
        success: "1", rest_id: "demo", variations: [],
        items: [
          { itemid: "out", itemname: "Unpriced", price: "0", in_stock: "2", itemallowvariation: "1", variation: [] },
          // Keep the independent all-dark warning out of this price assertion.
          { itemid: "ok", itemname: "Priced", price: "10", in_stock: 1 },
        ],
      });
      expect(latestSyncLog()).toMatchObject({
        unpricedSkuCount: 1, unpricedInStockCount: 0,
        unpricedVariationFlaggedCount: 1, unpricedInStockVariationMissingCount: 0,
      });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("(c) records zero unpriced counts and stays silent when all items are priced", async () => {
    const warn = spyOnWarn();
    try {
      await handlePetpoojaMenuWebhook({ ...REAL_PUSH_BODY, rest_id: "demo" });
      expect(latestSyncLog()).toMatchObject({
        unpricedSkuCount: 0, unpricedInStockCount: 0,
        unpricedVariationFlaggedCount: 0, unpricedInStockVariationMissingCount: 0,
      });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("(d) records zero unpriced counts without throwing or warning for zero items", async () => {
    const warn = spyOnWarn();
    try {
      await expect(handlePetpoojaMenuWebhook({ success: "1", rest_id: "demo", items: [] }))
        .resolves.toEqual({ success: true, itemCount: 0 });
      expect(latestSyncLog()).toMatchObject({
        unpricedSkuCount: 0, unpricedInStockCount: 0,
        unpricedVariationFlaggedCount: 0, unpricedInStockVariationMissingCount: 0,
      });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("menuApiFailureReason — the decision itself", () => {
  it("requires a POSITIVE failure signal: an explicit falsy success", () => {
    expect(
      menuApiFailureReason({ success: "0", message: "unable to fetch Object from s3 bucket" }, "x")
    ).toContain("unable to fetch Object from s3 bucket");
    expect(menuApiFailureReason({ success: 0 }, "x")).toContain("success=0");
    expect(menuApiFailureReason({ success: false }, "x")).not.toBeNull();
    expect(menuApiFailureReason({ success: "false" }, "x")).not.toBeNull();
    expect(menuApiFailureReason({ success: "0", items: [] }, "x")).toContain("refused");
  });

  it("rejects a non-object body and an empty object", () => {
    expect(menuApiFailureReason(null, "x")).toContain("response was not a menu object");
    expect(menuApiFailureReason([], "x")).toContain("response was not a menu object");
    expect(menuApiFailureReason({}, "x")).toContain("response was an empty object");
  });

  it("does NOT infer failure from the absence of a signal", () => {
    // A legitimate success body that omits `success` and carries a message must
    // not be thrown away — an earlier revision refused exactly this shape.
    expect(menuApiFailureReason({ message: "service unavailable" }, "x")).toBeNull();
    expect(
      menuApiFailureReason(
        {
          success: "1",
          message: "Menu items are successfully listed.",
          restaurants: [{ restaurantid: "5439", details: { menusharingcode: "31z58ciw0h" } }],
        },
        "x"
      )
    ).toBeNull();
  });

  it("does NOT flag a well-formed catalog, empty or not, nor the real push body", () => {
    expect(menuApiFailureReason({ success: "1", items: [] }, "x")).toBeNull();
    expect(menuApiFailureReason({ success: "1", items: [{ itemid: "1" }] }, "x")).toBeNull();
    expect(menuApiFailureReason({ items: [{ itemid: "1" }] }, "x")).toBeNull();
    expect(menuApiFailureReason(REAL_PUSH_BODY, "x")).toBeNull();
  });

  it("treats a JSON null / undefined success as a falsy failure signal (FINDING 4a)", () => {
    // The doc comment calls rule 3 "FALSY", but the narrow string/number set
    // omitted JSON `null` — so {"success":null} synced as a clean success.
    expect(menuApiFailureReason({ success: null }, "x")).toContain("refused");
    // A JS-object caller (not JSON) can produce `undefined`; the same rule must
    // cover it because the key is PRESENT.
    expect(menuApiFailureReason({ success: undefined }, "x")).toContain("refused");
  });

  it("treats a falsy `status` as a failure, but only when `success` is absent (FINDING 4b)", () => {
    // This module's own canned body and the repo's probe scripts use
    // status:"success" as the success key, so `status` is a real alternate
    // signal. A falsy status ("0") previously synced green.
    expect(menuApiFailureReason({ status: "0" }, "x")).toContain("refused");
    expect(menuApiFailureReason({ status: 0 }, "x")).toContain("refused");
    // `success` always wins when both keys are present: a truthy success makes a
    // falsy status irrelevant...
    expect(menuApiFailureReason({ success: "1", status: "0" }, "x")).toBeNull();
    // ...and a NON-falsy status never makes anything a failure on its own.
    expect(menuApiFailureReason({ status: 200 }, "x")).toBeNull();
    expect(menuApiFailureReason({ status: "success" }, "x")).toBeNull();
  });

  it("refuses an explicit vendor failure even when it ships a catalogue (FINDING 5, deliberate)", () => {
    // {"success":"0","items":[{...}]} discards a real catalogue. That is a
    // DELIBERATE choice: an explicit vendor failure is never acted on. Pinned so
    // the refusal is not quietly relaxed later.
    expect(menuApiFailureReason({ success: "0", items: [{ itemid: "1" }] }, "x")).toContain("refused");
  });

  it("accepts unknown success-flag string variants — the normalisation is narrow (FINDING 6)", () => {
    // Deliberately narrow: only "", "0" and "false" (after trim/lowercase) are
    // falsy. An unrecognised string is NOT treated as a failure. Pinned so the
    // acceptance is deliberate rather than accidental.
    expect(menuApiFailureReason({ success: "00" }, "x")).toBeNull();
    expect(menuApiFailureReason({ success: "no" }, "x")).toBeNull();
    expect(menuApiFailureReason({ success: "error" }, "x")).toBeNull();
  });
});

describe("menuSyncFailureStatus — the /petpooja/menu-sync 503-vs-400 mapping", () => {
  // The route maps through this pure helper (src/index.ts) instead of inlining
  // `err?.vendorRefusal === true ? 503 : 400`, so the decision is testable
  // without a supertest stack or booting the app. The marker property, never the
  // message text, decides it.
  it("answers 503 for a marked vendor refusal", () => {
    expect(menuSyncFailureStatus({ vendorRefusal: true })).toBe(503);
  });

  it("answers 400 for a plain caller error such as a missing rest_id", () => {
    expect(
      menuSyncFailureStatus(new Error("Missing rest_id in Petpooja menu webhook payload"))
    ).toBe(400);
  });

  it("answers 400, not 503, for a body that PARSES but is unusable — deliberate", () => {
    // DELIBERATE (pinned, so it is not quietly reverted): a malformed body is a
    // protocol fault, not a transient vendor outage — severity stays high and the
    // status stays 400. The /petpooja/menu-sync route is operator-triggered from
    // Petpooja's own dashboard, so there is no automatic retry for the status code
    // to steer, and 400 reads as "this is broken" from either direction. Only an
    // EXPLICIT vendor refusal (a falsy success/status) is marked retryable 503.
    const err: any = new Error("Petpooja Menu API answered for outlet x with no menu object: response was an empty object");
    err.malformedMenuBody = true;
    expect(menuSyncFailureStatus(err)).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// pos_webhook_audits — OUTLET ATTRIBUTION for inbound Petpooja callbacks
// ---------------------------------------------------------------------------
//
// LIVE DEFECT (2026-10-17T11:30:22Z, POST /petpooja/webhook): a real
// order-status callback parked as
//   unmatched_petpooja_orders/upo_bgx_variation_tax_1792168825392
// with restId "31z58ciw0h" and rawStatus "1", but the SAME invocation's audit
// row recorded `restId: null`. The handler reads the outlet id as
// `rest_id ?? restId ?? restID ?? restaurantid`; the route's audit call read
// only `rest_id` / `restId`, and this shape sends it as `restID`. An audit row
// that cannot name the outlet is useless for attributing inbound calls, which
// is exactly what the audit exists for during the E2E.
const auditRow = () => savedDocs["pos_webhook_audits/undefined"];

describe("auditPetpoojaWebhook — outlet attribution for the order-status callback", () => {
  beforeEach(() => {
    for (const key of Object.keys(savedDocs)) delete savedDocs[key];
  });

  it("records the outlet id from a status callback body (the observed 11:30Z shape)", async () => {
    // Exactly the shape that arrived: outlet id under `restID`, our order ref
    // under `clientOrderID`, and the observed rawStatus.
    await auditPetpoojaWebhook({
      endpoint: "/petpooja/webhook",
      outcome: "ok",
      payload: {
        restID: "31z58ciw0h",
        clientOrderID: "bgx_variation_tax_1792168825392",
        status: "1",
      },
      orderId: "bgx_variation_tax_1792168825392",
    });

    expect(auditRow().restId).toBe("31z58ciw0h");
    // Additive only: every other field keeps its meaning.
    expect(auditRow()).toMatchObject({
      source: "petpooja",
      endpoint: "/petpooja/webhook",
      outcome: "ok",
      orderId: "bgx_variation_tax_1792168825392",
      itemId: null,
      detail: null,
    });
    // The raw body is NEVER persisted (PII boundary).
    expect(auditRow().payload).toBeUndefined();
  });

  it("still records null when the body carries no outlet id", async () => {
    await auditPetpoojaWebhook({
      endpoint: "/petpooja/webhook",
      outcome: "ok",
      payload: { clientOrderID: "bgx_unknown", status: "1" },
      orderId: "bgx_unknown",
    });

    expect(auditRow().restId).toBeNull();
    expect(auditRow().orderId).toBe("bgx_unknown");
  });

  it("never throws on a malformed body and records null", async () => {
    await expect(
      auditPetpoojaWebhook({
        endpoint: "/petpooja/webhook",
        outcome: "error",
        payload: null,
        detail: "boom",
      })
    ).resolves.toBeUndefined();

    expect(auditRow().restId).toBeNull();
    expect(auditRow().detail).toBe("boom");
  });

  it("keeps an explicitly supplied restId (the menu-sync path) ahead of the body", async () => {
    await auditPetpoojaWebhook({
      endpoint: "/petpooja/menu-sync",
      outcome: "ok",
      restId: "menu_outlet",
      payload: { restID: "someone_else" },
      itemCount: 3,
    });

    expect(auditRow().restId).toBe("menu_outlet");
    expect(auditRow().itemCount).toBe(3);
  });
});

describe("extractPetpoojaWebhookRestId — mirrors the order-status handler's field order", () => {
  it("prefers rest_id, then restId, then restID, then restaurantid", () => {
    expect(extractPetpoojaWebhookRestId({ rest_id: "a" })).toBe("a");
    expect(extractPetpoojaWebhookRestId({ restId: "b" })).toBe("b");
    expect(extractPetpoojaWebhookRestId({ restID: "c" })).toBe("c");
    expect(extractPetpoojaWebhookRestId({ restaurantid: "d" })).toBe("d");
    // The order the handler reads them in (first present non-null wins).
    expect(extractPetpoojaWebhookRestId({ restaurantid: "d", restID: "c", restId: "b" })).toBe("b");
  });

  it("normalises a numeric outlet id and rejects empty / malformed bodies", () => {
    expect(extractPetpoojaWebhookRestId({ restaurantid: "5439" })).toBe("5439");
    expect(extractPetpoojaWebhookRestId({ restID: "" })).toBeNull();
    expect(extractPetpoojaWebhookRestId({})).toBeNull();
    expect(extractPetpoojaWebhookRestId(null)).toBeNull();
    expect(extractPetpoojaWebhookRestId("not-an-object")).toBeNull();
  });
});
