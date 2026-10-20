import { describe, it, expect, vi, beforeEach } from "vitest";

// FIX G3 regression: resolveOrderBranchId. The customer app writes a NESTED
// store snapshot (ordersService.ts:398) and no top-level storeId, so the
// previous storeId-only lookup was dead on every delivery order and scoped
// staff actions on them denied as "no resolvable branch". These pins cover:
// explicit branchId priority, nested snapshot -> AUTHORITATIVE stores doc,
// conflicting/malformed references failing closed, and the deny matrix via
// assertOrderBranchAccess (empty claims, cross-branch, global callers).

const { mockDb, savedDocs, getTargets } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  const getTargets: string[] = [];
  const docRef = (colName: string, docId: string) => ({
    id: docId,
    path: `${colName}/${docId}`,
    get: vi.fn(async () => {
      getTargets.push(`${colName}/${docId}`);
      return {
        exists: !!savedDocs[`${colName}/${docId}`],
        data: () => savedDocs[`${colName}/${docId}`] || {},
      };
    }),
    set: vi.fn(async () => ""),
    update: vi.fn(async () => ""),
  });
  const mockDb = {
    collection: (colName: string) => ({
      doc: (docId?: string) => docRef(colName, docId || `mock_${Math.random().toString(36).slice(2, 8)}`),
      where: () => ({
        limit: () => ({ get: async () => ({ docs: [] }) }),
        get: async () => ({ docs: [] }),
      }),
    }),
    runTransaction: vi.fn(async (fn: any) =>
      fn({
        get: (ref: any) => ref.get(),
        set: (ref: any, data: any, opts?: any) => ref.set(data, opts),
      })
    ),
  };
  return { mockDb, savedDocs, getTargets };
});

vi.mock("firebase-admin", () => {
  const FieldValue = {
    serverTimestamp: () => "MOCK_SERVER_TIMESTAMP",
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
      appCheck: () => ({ verifyToken: vi.fn() }),
    },
    firestore: firestoreFn,
    auth: vi.fn(() => ({})),
    messaging: vi.fn(() => ({})),
    initializeApp: vi.fn(),
    apps: [{ name: "mock" }],
    appCheck: () => ({ verifyToken: vi.fn() }),
  };
});

import { resolveOrderBranchId, assertOrderBranchAccess, type StaffCaller } from "../src/core/middleware";

const scopedStaff: StaffCaller = { uid: "staff_1", role: "branch_staff", branchIds: ["branch_surat_01"] };
const brand: StaffCaller = { uid: "brand_1", role: "brand_owner" };

describe("resolveOrderBranchId (G3: nested delivery-store snapshot resolution)", () => {
  beforeEach(() => {
    for (const k of Object.keys(savedDocs)) delete savedDocs[k];
    getTargets.length = 0;
    savedDocs["stores/str_001"] = { partnerBranchId: "branch_surat_01" };
  });

  it("explicit branchId wins without touching stores/", async () => {
    const branch = await resolveOrderBranchId({
      branchId: "branch_explicit",
      storeId: "str_001",
      store: { id: "other" },
    });
    expect(branch).toBe("branch_explicit");
    expect(getTargets).toHaveLength(0);
  });

  it("resolves a nested store snapshot via the AUTHORITATIVE stores doc", async () => {
    const order = { store: { id: "str_001", name: "CD Road" } }; // NO top-level storeId
    const branch = await resolveOrderBranchId(order);
    expect(branch).toBe("branch_surat_01");
    expect(getTargets).toEqual(["stores/str_001"]);
  });

  it("never trusts a client-copyable partnerBranchId inside the snapshot", async () => {
    savedDocs["stores/str_002"] = { partnerBranchId: "branch_authoritative" };
    const branch = await resolveOrderBranchId({
      store: { id: "str_002", partnerBranchId: "branch_forged" },
    });
    expect(branch).toBe("branch_authoritative");
  });

  it("fails closed when the top-level storeId and nested store.id disagree", async () => {
    savedDocs["stores/str_a"] = { partnerBranchId: "branch_a" };
    savedDocs["stores/str_b"] = { partnerBranchId: "branch_b" };
    const branch = await resolveOrderBranchId({
      storeId: "str_a",
      store: { id: "str_b" },
    });
    expect(branch).toBeNull();
    expect(getTargets).toHaveLength(0);
  });

  it("fails closed on a malformed nested snapshot", async () => {
    savedDocs["stores/str_003"] = { partnerBranchId: "branch_x" };
    for (const store of [{ id: 42 }, "str_003", { nested: true }, []]) {
      const branch = await resolveOrderBranchId({ store });
      expect(branch).toBeNull();
    }
    expect(getTargets).toHaveLength(0); // nothing was ever fetched with garbage keys
  });

  it("fails closed when the stores doc is missing or has no mapping", async () => {
    expect(await resolveOrderBranchId({ store: { id: "missing_store" } })).toBeNull();
    savedDocs["stores/no_map"] = { name: "no mapping" };
    expect(await resolveOrderBranchId({ store: { id: "no_map" } })).toBeNull();
  });

  it("deny matrix: scoped empty claims denied, cross-branch denied, staff allowed, admin needs resolution too", async () => {
    const order = { store: { id: "str_001" } }; // resolvable -> branch_surat_01

    // scoped staff WITH the mapped branch -> allowed
    await expect(assertOrderBranchAccess(scopedStaff, order)).resolves.toBe("branch_surat_01");

    // scoped staff with the branchIds MISSING -> denied (fail-closed)
    await expect(
      assertOrderBranchAccess({ uid: "staff_2", role: "branch_staff" }, order)
    ).rejects.toThrow(/outside your assigned branches/);

    // scoped staff, wrong branch -> denied
    await expect(
      assertOrderBranchAccess({ ...scopedStaff, branchIds: ["branch_other"] }, order)
    ).rejects.toThrow(/outside your assigned branches/);

    // nested snapshot pointing at an unresolvable store: even the brand owner
    // is denied (missing mapping -> stop before the branch check)
    await expect(
      assertOrderBranchAccess(brand, { store: { id: "no_mapping_here" } })
    ).rejects.toThrow(/no resolvable branch/);

    // brand owner on a RESOLVABLE order passes
    await expect(assertOrderBranchAccess(brand, order)).resolves.toBe("branch_surat_01");

    // anonymous caller rejected outright
    await expect(assertOrderBranchAccess(undefined, order)).rejects.toThrow(/Unauthorized/);
  });
});
