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
// Imported directly rather than through the petpooja barrel: this helper backs
// the /petpooja/menu-sync 503-vs-400 mapping, and importing src/index.ts in a
// test would boot the whole app. (The barrel is owned by another change.)
import { menuSyncFailureStatus } from "../src/modules/petpooja/menuSyncWebhook";
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

    // In live mode the handler resolves the outlet through
    // resolveBranchIdForRestId, which runs an INDEXED query
    // (branches.where("petpoojaStoreId", "==", restId)); this test's Firestore
    // double exposes no `.where`, so the resolver returns null (item86ingSync.ts)
    // and the handler takes the section 16.7 "no linked branch" skip. Calling it
    // would have thrown had the classifier refused the body.
    const res = await handlePetpoojaMenuWebhook(REAL_PUSH_BODY);

    expect(res).toEqual({ success: false, itemCount: 0 });
    // A skipped push writes nothing at all: no products, no green sync-log row,
    // no branch stamp.
    expect(productRows()).toEqual([]);
    expect(syncLogRows()).toEqual([]);
    expect(savedDocs["branches/demo"].lastPetpoojaSync).toBeUndefined();
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

  it("answers 400 for a malformed-body error (the FINDING 3 split)", () => {
    const err: any = new Error("Petpooja Menu API answered for outlet x with no menu object: response was an empty object");
    err.malformedMenuBody = true;
    expect(menuSyncFailureStatus(err)).toBe(400);
  });
});
