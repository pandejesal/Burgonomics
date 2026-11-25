import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * A5 finding 1 (fix wave 2026-11-20): the Partner brand-directory save deletes
 * the staff-close override.
 *
 * `adminStoresService.stageStoreWrite` FULL-REPLACES `admin_stores/{id}` with
 * `toPublicStoreDoc(store)`. That projection copies `isOpen` from the client's
 * cached row and DROPS `storeStatusOverride`, `storeStatusSource`,
 * `storeStatusReason` and `storeTurnOnAt` — none of them is a public key, and
 * `firestore.rules` brands the arm with `hasOnly(adminStorePublicKeys())`, so the
 * client cannot even include them to preserve them. A brand admin editing a
 * phone number therefore erased a staff close, and the stale cached `isOpen:
 * true` reopened a kitchen staff had shut.
 *
 * The fix lives on the server (the Partner app is out of this package's scope):
 * a Firestore trigger on `admin_stores/{storeId}` restores the staff close from
 * the BEFORE snapshot whenever a write drops it. Only a staff reopen (the route
 * that owns the marker) may clear it.
 *
 * Written RED-first: on the base commit there is no guard module at all.
 */

const { mockDb, savedDocs, writeLog } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  const writeLog: string[] = [];
  const clone = (value: any) =>
    value === undefined ? undefined : JSON.parse(JSON.stringify(value));

  // One ref object per path (like the real SDK), so a test can spy on the SAME
  // `set` the module calls.
  const refs = new Map<string, any>();
  const docRef = (col: string, id: string) => {
    const path = `${col}/${id}`;
    const cached = refs.get(path);
    if (cached) return cached;
    const ref: any = {
      id,
      path,
      get: vi.fn(async () => ({
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

  const mockDb: any = {
    collection: (col: string) => ({
      doc: (id: string) => docRef(col, id),
      where: () => ({
        limit: () => ({ get: async () => ({ empty: true, docs: [] }) }),
      }),
    }),
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

// Capture the raw trigger so the handler can be invoked directly, without the
// deployed firebase-functions runtime.
const { writtenTriggers } = vi.hoisted(() => {
  const writtenTriggers: Array<{ config: any; handler: any }> = [];
  return { writtenTriggers };
});

vi.mock("firebase-functions/v2/firestore", () => ({
  onDocumentWritten: (config: any, handler: any) => {
    writtenTriggers.push({ config, handler });
    return handler;
  },
  onDocumentCreated: (config: any, handler: any) => {
    writtenTriggers.push({ config, handler });
    return handler;
  },
  onDocumentUpdated: (config: any, handler: any) => {
    writtenTriggers.push({ config, handler });
    return handler;
  },
}));

import {
  guardDirectoryStatusWrite,
  STAFF_CLOSE_GUARD_MARKER,
} from "../src/modules/stores/directoryStatusGuard";

const STORE = "store_dir_1";

/** The staff close, as `setStaffStoreStatus` writes it (rule C). */
const STAFF_CLOSED = {
  id: STORE,
  name: "Rule C Outlet",
  partnerBranchId: "branch_dir_1",
  phone: "+919825100001",
  isOpen: false,
  storeStatusSource: "manual",
  storeStatusOverride: true,
  storeStatusReason: "Gas leak",
  storeTurnOnAt: 1760000000000,
  storeStatusUpdatedAt: "MOCK_TIMESTAMP",
};

/**
 * EXACTLY what `adminStoresService.toPublicStoreDoc` emits for the same store
 * when the Partner page still holds a pre-close cached row: the public keys
 * only, `isOpen` mirrored from that stale row, and no status-marker keys at all.
 * (Pinned by the projection itself in `adminStoresService.ts:379-419`.)
 */
function toPublicStoreDocProjection(source: Record<string, any>): Record<string, any> {
  return {
    title: source.title,
    branchId: source.branchId,
    name: source.name,
    address: source.address,
    phone: source.phone,
    isOpen: source.isOpen,
    partnerBranchId: source.partnerBranchId,
    petpoojaRestId: source.petpoojaRestId,
    updatedAt: "MOCK_TIMESTAMP",
  };
}

beforeEach(() => {
  for (const key of Object.keys(savedDocs)) delete savedDocs[key];
  writeLog.length = 0;
  savedDocs[`admin_stores/${STORE}`] = JSON.parse(JSON.stringify(STAFF_CLOSED));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("guardDirectoryStatusWrite — a directory write cannot undo a staff close", () => {

  it("restores the staff close when a brand save drops the override and mirrors a stale isOpen", () => {
    const before = savedDocs[`admin_stores/${STORE}`];
    const after = toPublicStoreDocProjection({ ...before, isOpen: true });

    const patch = guardDirectoryStatusWrite(before, after);

    expect(patch).not.toBeNull();
    // The gate customers are actually served from.
    expect(patch!.isOpen).toBe(false);
    expect(patch!.storeStatusOverride).toBe(true);
    // The staff decision's provenance must survive verbatim, or the next POS
    // "open" sees no override and reopens the kitchen (item86ingSync rule C).
    expect(patch!.storeStatusSource).toBe("manual");
    expect(patch!.storeStatusReason).toBe("Gas leak");
    expect(patch!.storeTurnOnAt).toBe(1760000000000);
    expect(patch!.directoryStatusGuard).toBe(STAFF_CLOSE_GUARD_MARKER);
    // The restore is stamped by the server, never copied from the client row.
    expect(patch!.storeStatusUpdatedAt).toBe("MOCK_TIMESTAMP");
  });

  it("restores the override even when the directory save leaves isOpen false", () => {
    const before = savedDocs[`admin_stores/${STORE}`];
    const after = toPublicStoreDocProjection(before); // no marker keys at all

    const patch = guardDirectoryStatusWrite(before, after);

    expect(patch).toMatchObject({
      isOpen: false,
      storeStatusOverride: true,
      storeStatusSource: "manual",
      storeStatusReason: "Gas leak",
    });
  });

  it("writes NOTHING for an ordinary directory save that keeps the staff close intact", () => {
    const before = savedDocs[`admin_stores/${STORE}`];
    // A later, honest save: the page refreshed, so the projection carries the
    // open read + the server-owned marker keys it read back.
    const after = {
      ...toPublicStoreDocProjection(before),
      isOpen: false,
      storeStatusOverride: true,
      storeStatusSource: "manual",
      storeStatusReason: "Gas leak",
      storeTurnOnAt: 1760000000000,
    };

    expect(guardDirectoryStatusWrite(before, after)).toBeNull();
  });

  it("writes NOTHING for a store that is open and was never staff-closed", () => {
    const before = { id: STORE, name: "Open outlet", isOpen: true, storeStatusOverride: false };
    const after = toPublicStoreDocProjection({ ...before, phone: "+919825100009" });

    expect(guardDirectoryStatusWrite(before, after)).toBeNull();
  });

  it("writes NOTHING when staff reopen the outlet (the only writer allowed to clear the marker)", () => {
    const before = savedDocs[`admin_stores/${STORE}`];
    const after = {
      ...toPublicStoreDocProjection(before),
      isOpen: true,
      storeStatusOverride: false,
      storeStatusSource: "manual",
    };

    expect(guardDirectoryStatusWrite(before, after)).toBeNull();
  });

  it("writes NOTHING for a brand-new directory document (no before snapshot)", () => {
    expect(
      guardDirectoryStatusWrite(null, { id: STORE, name: "New outlet", isOpen: true })
    ).toBeNull();
  });

  it("writes NOTHING for a deleted directory document (no after snapshot)", () => {
    expect(guardDirectoryStatusWrite(savedDocs[`admin_stores/${STORE}`], null)).toBeNull();
  });
});

describe("the admin_stores status guard trigger", () => {
  const latestTrigger = () => writtenTriggers[writtenTriggers.length - 1];

  it("registers on the canonical admin_stores document path", () => {
    expect(latestTrigger()).toBeDefined();
    expect(latestTrigger().config.document).toBe("admin_stores/{storeId}");
  });

  it("merges the restore onto the saved document, so no public field the save wrote is lost", async () => {
    const before = savedDocs[`admin_stores/${STORE}`];
    const after = toPublicStoreDocProjection({ ...before, isOpen: true, phone: "+919825100002" });
    // The directory save COMMITTED first (full replacement), then the trigger
    // fires. Reproduce that write before invoking the handler.
    savedDocs[`admin_stores/${STORE}`] = JSON.parse(JSON.stringify(after));
    writeLog.length = 0;

    await latestTrigger().handler({
      params: { storeId: STORE },
      data: { before: { data: () => before }, after: { data: () => after } },
    });

    // The brand admin's unrelated edit survives…
    expect(savedDocs[`admin_stores/${STORE}`].phone).toBe("+919825100002");
    // …and the staff close does too.
    expect(savedDocs[`admin_stores/${STORE}`].isOpen).toBe(false);
    expect(savedDocs[`admin_stores/${STORE}`].storeStatusOverride).toBe(true);
    expect(savedDocs[`admin_stores/${STORE}`].storeStatusReason).toBe("Gas leak");
    expect(writeLog).toEqual([`set admin_stores/${STORE}`]);
  });

  it("is idempotent: its own restore re-fires the trigger and writes nothing more", async () => {
    const before = savedDocs[`admin_stores/${STORE}`];
    const after = toPublicStoreDocProjection({ ...before, isOpen: true });
    await latestTrigger().handler({
      params: { storeId: STORE },
      data: { before: { data: () => before }, after: { data: () => after } },
    });
    const restored = savedDocs[`admin_stores/${STORE}`];
    const writesAfterRestore = writeLog.length;

    await latestTrigger().handler({
      params: { storeId: STORE },
      data: { before: { data: () => restored }, after: { data: () => restored } },
    });

    expect(writeLog.length).toBe(writesAfterRestore);
  });

  it("does no datastore write at all for a healthy directory save", async () => {
    const before = savedDocs[`admin_stores/${STORE}`];
    const after = { ...toPublicStoreDocProjection(before), isOpen: false, storeStatusOverride: true };

    await latestTrigger().handler({
      params: { storeId: STORE },
      data: { before: { data: () => before }, after: { data: () => after } },
    });

    expect(writeLog).toEqual([]);
  });

  it("never throws into the trigger runtime when the restore write fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const before = savedDocs[`admin_stores/${STORE}`];
    const after = toPublicStoreDocProjection({ ...before, isOpen: true });
    // A failing datastore write must be LOUD, never a rejected trigger retry
    // storm: the directory save itself already committed.
    const setSpy = vi
      .spyOn(mockDb.collection("admin_stores").doc(STORE), "set")
      .mockRejectedValueOnce(new Error("datastore unavailable"));
    try {
      await expect(
        latestTrigger().handler({
          params: { storeId: STORE },
          data: { before: { data: () => before }, after: { data: () => after } },
        })
      ).resolves.toBeUndefined();
      expect(error).toHaveBeenCalled();
      // The failure is also escalated as a HIGH operator snapshot.
      const alerts = Object.keys(savedDocs)
        .filter((p) => p.startsWith("dev_error_snapshots/"))
        .map((p) => savedDocs[p]);
      expect(alerts.some((row) => String(row.message).includes("staff close"))).toBe(true);
    } finally {
      setSpy.mockRestore();
      warn.mockRestore();
      error.mockRestore();
    }
  });
});

describe("route wiring", () => {
  const source = readFileSync(resolve(__dirname, "../src/index.ts"), "utf8");

  it("exports the guard trigger from src/index.ts", () => {
    expect(source).toContain("onAdminStoreDirectoryStatusGuard");
    expect(source).toMatch(
      /export\s*\{[^}]*onAdminStoreDirectoryStatusGuard[^}]*\}\s*from\s*"\.\/modules\/stores/
    );
  });
});
