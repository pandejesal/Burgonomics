import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Owner rule C (fix wave 2026-11-20): while an outlet is linked to Petpooja the
 * POS owns open/closed — EXCEPT that a staff "close" in the Partner app wins
 * until staff reopen it.
 *
 * Two halves, both here because they are one rule:
 *
 *   Partner side  — `setStaffStoreStatus` writes the customer gate
 *                   (`stores|admin_stores .isOpen`) plus an override marker a
 *                   POS "open" cannot clear. Reopening clears the marker.
 *
 *   POS side      — a Petpooja "open" (`store_status: "1"`) is REFUSED while the
 *                   staff override is in force, and nothing is rewritten. Once
 *                   staff reopen, the POS owns open/closed again (rule A).
 *
 * Written RED-first against the post-r2 code, where a POS "open" simply
 * overwrites `isOpen` and no override exists at all.
 *
 * Role scope: only a caller allowed to manage that branch may flip it
 * (`assertBranchAccess`, brand admins pass by design).
 */

const { mockDb, savedDocs, writeLog, setMockDoc } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  const writeLog: string[] = [];
  let versionCounter = 100;

  const makeTimestamp = (v: number) => ({
    toMillis: () => v,
    isEqual: (other: any) => other?.toMillis?.() === v,
  });

  const docRef = (col: string, id: string) => {
    const path = `${col}/${id}`;
    return {
      id,
      path,
      get: vi.fn(async () => ({
        exists: Object.prototype.hasOwnProperty.call(savedDocs, path),
        data: () => (savedDocs[path] ? JSON.parse(JSON.stringify(savedDocs[path])) : undefined),
        updateTime: makeTimestamp(versionCounter),
        ref: docRef(col, id),
      })),
      set: vi.fn(async (data: any, opts?: any) => {
        writeLog.push(`set ${path}`);
        savedDocs[path] =
          opts?.merge && savedDocs[path] ? { ...savedDocs[path], ...data } : { ...data };
        versionCounter += 1;
      }),
      update: vi.fn(async (data: any) => {
        writeLog.push(`update ${path}`);
        savedDocs[path] = { ...(savedDocs[path] ?? {}), ...data };
        versionCounter += 1;
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
              .map(([p, data]) => ({
                id: p.slice(col.length + 1),
                ref: docRef(col, p.slice(col.length + 1)),
                exists: true,
                data: () => JSON.parse(JSON.stringify(data)),
              }))
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
        update: async (ref: any, data: any) => ref.update(data),
      })
    ),
  };

  const setMockDoc = (path: string, data: Record<string, any>) => {
    savedDocs[path] = JSON.parse(JSON.stringify(data));
    versionCounter += 1;
  };

  return { mockDb, savedDocs, writeLog, setMockDoc };
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

import { handlePetpoojaStoreStatus } from "../src/modules/petpooja/item86ingSync";
import { setStaffStoreStatus } from "../src/modules/stores/storeStatus";
import { config } from "../src/config/env";

const REST = "res_rule_c";
const BRANCH = "branch_rule_c";
const STORE = "store_rule_c";

const brandCaller = () => ({
  uid: "uid_brand",
  role: "brand_owner",
  isBrandAdmin: true,
  branchIds: [] as string[],
});

const TRUSTED = { authenticated: true };

beforeEach(() => {
  for (const key of Object.keys(savedDocs)) delete savedDocs[key];
  writeLog.length = 0;
  config.mock.petpoojaPos = false;

  setMockDoc(`branches/${BRANCH}`, {
    id: BRANCH,
    name: "Rule C Outlet",
    petpoojaStoreId: REST,
    active: true,
    acceptingOrdersStatus: "open",
  });
  setMockDoc(`stores/${STORE}`, {
    id: STORE,
    name: "Rule C Outlet",
    partnerBranchId: BRANCH,
    petpoojaRestId: REST,
    isOpen: true,
    isBusy: false,
  });
});

describe("rule C — a staff close is the authority until staff reopen", () => {
  it("closes the customer gate AND stamps an override, keeping the branch flag in step", async () => {
    const result = await setStaffStoreStatus({
      branchId: BRANCH,
      status: "closed",
      reason: "Gas leak",
      caller: brandCaller(),
    });

    expect(result).toMatchObject({
      branchId: BRANCH,
      status: "closed",
      storeId: STORE,
      storeStatusOverride: true,
    });

    // The gate customers are actually served from.
    expect(savedDocs[`stores/${STORE}`].isOpen).toBe(false);
    expect(savedDocs[`stores/${STORE}`].storeStatusOverride).toBe(true);
    expect(savedDocs[`stores/${STORE}`].storeStatusSource).toBe("manual");
    expect(savedDocs[`stores/${STORE}`].storeStatusReason).toBe("Gas leak");

    // The flag operators read on the outlet screens.
    expect(savedDocs[`branches/${BRANCH}`].acceptingOrdersStatus).toBe("closed");
    expect(savedDocs[`branches/${BRANCH}`].storeStatusOverride).toBe(true);
    expect(savedDocs[`branches/${BRANCH}`].storeStatusSource).toBe("manual");
  });

  it("reopens the gate and CLEARS the override, so the POS owns open/closed again", async () => {
    await setStaffStoreStatus({ branchId: BRANCH, status: "closed", caller: brandCaller() });

    const reopened = await setStaffStoreStatus({
      branchId: BRANCH,
      status: "open",
      caller: brandCaller(),
    });

    expect(reopened.storeStatusOverride).toBe(false);
    expect(savedDocs[`stores/${STORE}`].isOpen).toBe(true);
    expect(savedDocs[`stores/${STORE}`].storeStatusOverride).toBe(false);
    expect(savedDocs[`branches/${BRANCH}`].acceptingOrdersStatus).toBe("open");
    expect(savedDocs[`branches/${BRANCH}`].storeStatusOverride).toBe(false);
  });

  it("refuses a caller who does not hold that branch", async () => {
    await expect(
      setStaffStoreStatus({
        branchId: BRANCH,
        status: "closed",
        caller: { uid: "uid_other", role: "branch_staff", branchIds: ["branch_elsewhere"] },
      })
    ).rejects.toThrow(/Forbidden: branch is outside your assigned branches/);
    expect(savedDocs[`stores/${STORE}`].isOpen).toBe(true);
  });

  it("lets a branch-scoped operator manage its OWN branch", async () => {
    const result = await setStaffStoreStatus({
      branchId: BRANCH,
      status: "closed",
      caller: { uid: "uid_staff", role: "branch_staff", branchIds: [BRANCH] },
    });
    expect(result.storeStatusOverride).toBe(true);
    expect(savedDocs[`stores/${STORE}`].isOpen).toBe(false);
  });

  it("refuses an unlinked outlet and writes nothing", async () => {
    delete savedDocs[`stores/${STORE}`];
    await expect(
      setStaffStoreStatus({ branchId: BRANCH, status: "closed", caller: brandCaller() })
    ).rejects.toThrow(/not linked to a storefront/);
    expect(savedDocs[`branches/${BRANCH}`].acceptingOrdersStatus).toBe("open");
  });

  it("refuses an ambiguous outlet (two storefronts claim it) and writes nothing", async () => {
    setMockDoc(`stores/store_rule_c_second`, {
      id: "store_rule_c_second",
      name: "Duplicate",
      partnerBranchId: BRANCH,
      isOpen: true,
    });
    await expect(
      setStaffStoreStatus({ branchId: BRANCH, status: "closed", caller: brandCaller() })
    ).rejects.toThrow(/more than one storefront/);
    expect(savedDocs[`stores/${STORE}`].isOpen).toBe(true);
    expect(savedDocs[`stores/store_rule_c_second`].isOpen).toBe(true);
  });
});

describe("rule C — a POS open cannot undo a staff close", () => {
  async function closeByStaff() {
    await setStaffStoreStatus({ branchId: BRANCH, status: "closed", caller: brandCaller() });
  }

  it("refuses store_status '1' while the override is in force, and rewrites nothing", async () => {
    await closeByStaff();
    const before = JSON.parse(JSON.stringify(savedDocs[`stores/${STORE}`]));
    writeLog.length = 0;

    const reply = await handlePetpoojaStoreStatus({ restID: REST, store_status: "1" }, TRUSTED);

    expect(reply).not.toBeNull();
    expect(reply!.kind).toBe("update");
    expect(reply!.body.http_code).toBe(400);
    expect(reply!.body.status).toBe("failed");
    expect(reply!.body.message).toMatch(/Partner app/i);
    // No store/branch rewrite at all — the close still stands.
    expect(
      writeLog.filter((w) => w.includes("stores/") || w.includes(`branches/${BRANCH}`))
    ).toEqual([]);
    expect(savedDocs[`stores/${STORE}`].isOpen).toBe(false);
    expect(savedDocs[`stores/${STORE}`]).toEqual(before);
    expect(savedDocs[`branches/${BRANCH}`].acceptingOrdersStatus).toBe("closed");
  });

  it("a POS 'close' while already staff-closed keeps the override (no flag loss)", async () => {
    await closeByStaff();
    const reply = await handlePetpoojaStoreStatus({ restID: REST, store_status: "0" }, TRUSTED);
    expect(reply!.body.http_code).toBe(200);
    expect(savedDocs[`stores/${STORE}`].isOpen).toBe(false);
    expect(savedDocs[`stores/${STORE}`].storeStatusOverride).toBe(true);
    expect(savedDocs[`branches/${BRANCH}`].storeStatusOverride).toBe(true);
  });

  it("control: with no override, a POS open still reopens the outlet (rule A)", async () => {
    await handlePetpoojaStoreStatus({ restID: REST, store_status: "0" }, TRUSTED);
    expect(savedDocs[`stores/${STORE}`].isOpen).toBe(false);

    const reply = await handlePetpoojaStoreStatus({ restID: REST, store_status: "1" }, TRUSTED);
    expect(reply!.body.http_code).toBe(200);
    expect(savedDocs[`stores/${STORE}`].isOpen).toBe(true);
  });

  it("after staff reopen, the POS owns open/closed again", async () => {
    await closeByStaff();
    await setStaffStoreStatus({ branchId: BRANCH, status: "open", caller: brandCaller() });

    await handlePetpoojaStoreStatus({ restID: REST, store_status: "0" }, TRUSTED);
    expect(savedDocs[`stores/${STORE}`].isOpen).toBe(false);
    const reply = await handlePetpoojaStoreStatus({ restID: REST, store_status: "1" }, TRUSTED);
    expect(reply!.body.http_code).toBe(200);
    expect(savedDocs[`stores/${STORE}`].isOpen).toBe(true);
    expect(savedDocs[`stores/${STORE}`].storeStatusOverride ?? false).toBe(false);
  });

  it("Get Store Status reports closed while the override is in force", async () => {
    await closeByStaff();
    const reply = await handlePetpoojaStoreStatus({ restID: REST }, {});
    expect(reply!.kind).toBe("get");
    expect(reply!.body.store_status).toBe("0");
  });
});

describe("route wiring", () => {
  const source = readFileSync(resolve(__dirname, "../src/index.ts"), "utf8");

  it("mounts POST /stores/setOperatingStatus behind auth, role and body validation", () => {
    const idx = source.indexOf('"/stores/setOperatingStatus"');
    expect(idx).toBeGreaterThan(-1);
    // The route declaration follows the allowlist entry; take the LAST one.
    const routeIdx = source.lastIndexOf('"/stores/setOperatingStatus"');
    const block = source.slice(routeIdx, routeIdx + 400);
    expect(block).toContain("requireAuth");
    expect(block).toMatch(
      /requireRole\(\["brand_owner",\s*"developer",\s*"branch_owner",\s*"branch_staff"\]\)/
    );
    expect(block).toContain("validateBody(storeOperatingStatusSchema)");
  });

  it("enrols the route in the App Check allowlist (the app sends the header)", () => {
    const allowStart = source.indexOf('"/payments/createPaymentOrder"');
    // `requireAppCheck` is also imported at the top of the file, so search from
    // the allowlist entry onwards, not from byte 0.
    const allowEnd = source.indexOf("requireAppCheck", allowStart);
    expect(allowStart).toBeGreaterThan(-1);
    expect(allowEnd).toBeGreaterThan(allowStart);
    const allow = source.slice(allowStart, allowEnd);
    expect(allow).toContain('"/stores/setOperatingStatus"');
  });
});
