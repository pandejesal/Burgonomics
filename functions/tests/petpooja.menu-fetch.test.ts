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
// The push tests drive `handlePetpoojaMenuWebhook` with mock.petpoojaPos = true
// (an inbound push resolves its branch differently from the scheduled pull, and
// this sandbox has no indexed branch query), which exercises the same ingestion
// branch a live push takes.

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
  const mockDb: any = {
    collection: (col: string) => ({
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
import { config } from "../src/config/env";

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
});
