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

import { syncPetpoojaMenu, menuApiFailureReason } from "../src/modules/petpooja";
import { config } from "../src/config/env";

const DEMO_REST_ID = "31z58ciw0h";

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

  const syncLogRows = () =>
    Object.keys(savedDocs).filter((k) => k.startsWith("petpooja_sync_logs/"));

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
});

describe("menuApiFailureReason — the decision itself", () => {
  it("treats an explicit falsy success as a failure, carrying the vendor message", () => {
    expect(
      menuApiFailureReason({ success: "0", message: "unable to fetch Object from s3 bucket" }, "x")
    ).toContain("unable to fetch Object from s3 bucket");
    expect(menuApiFailureReason({ success: 0 }, "x")).toContain("success=0");
    expect(menuApiFailureReason({ success: false }, "x")).not.toBeNull();
  });

  it("treats prose with no items array as a failure, even without a success flag", () => {
    expect(menuApiFailureReason({ message: "service unavailable" }, "x")).toContain(
      "service unavailable"
    );
  });

  it("does NOT flag a well-formed catalog, empty or not", () => {
    expect(menuApiFailureReason({ success: "1", items: [] }, "x")).toBeNull();
    expect(menuApiFailureReason({ success: "1", items: [{ itemid: "1" }] }, "x")).toBeNull();
    expect(menuApiFailureReason({ items: [] }, "x")).toBeNull();
  });
});
