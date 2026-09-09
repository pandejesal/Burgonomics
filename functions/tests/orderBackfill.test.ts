import { describe, it, expect, vi } from "vitest";
import { planOrderBackfill, runOrderBackfill } from "../../scripts/backfill/orderBackfill";

describe("orderBackfill planner", () => {
  it("fills all missing mirrors from userId/placedAt/store link", () => {
    const plan = planOrderBackfill({
      userId: "u_1",
      placedAt: "2026-08-01T10:00:00.000Z",
      store: { id: "str_012", partnerBranchId: "branch_surat_01" },
    });
    expect(plan).toMatchObject({
      updates: {
        customerId: "u_1",
        createdAt: "2026-08-01T10:00:00.000Z",
        updatedAt: "2026-08-01T10:00:00.000Z",
        branchId: "branch_surat_01",
      },
    });
    expect(plan?.filled).toEqual(
      expect.arrayContaining(["customerId", "createdAt", "updatedAt", "branchId"])
    );
  });

  it("never overwrites existing values (even odd-looking ones)", () => {
    const plan = planOrderBackfill({
      customerId: "keep_me",
      userId: "u_2",
      createdAt: "2026-01-01T00:00:00.000Z",
      placedAt: "2026-08-01T10:00:00.000Z",
      branchId: "branch_x",
      store: { partnerBranchId: "branch_y" },
    });
    // updatedAt missing → filled from existing createdAt; nothing else touched
    expect(plan).toMatchObject({ updates: { updatedAt: "2026-01-01T00:00:00.000Z" } });
    expect(plan?.filled).toEqual(["updatedAt"]);
  });

  it("treats empty strings as missing", () => {
    const plan = planOrderBackfill({ customerId: "", userId: "u_3" });
    expect(plan?.updates).toMatchObject({ customerId: "u_3" });
  });

  it("leaves unlinked stores without branchId (no fabrication)", () => {
    const plan = planOrderBackfill({
      userId: "u_4",
      placedAt: "2026-08-01T10:00:00.000Z",
      store: { id: "str_001" },
    });
    expect(plan?.filled).not.toContain("branchId");
    expect(plan?.updates).not.toHaveProperty("branchId");
  });

  it("returns null when nothing is missing", () => {
    expect(
      planOrderBackfill({
        customerId: "u",
        createdAt: "t",
        updatedAt: "t",
        branchId: "b",
      })
    ).toBeNull();
  });
});

function fakeDb(docs: Array<{ id: string; data: Record<string, any> }>) {
  const writes: Array<{ id: string; data: any }> = [];
  const ordered = [...docs].sort((a, b) => (a.id < b.id ? -1 : 1));
  return {
    writes,
    collection: (_name: string) => ({
      orderBy: () => ({
        limit: (n: number) => ({
          startAfter: (snap: any) => buildQuery(snap),
          get: () => buildQuery(undefined).get(),
        }),
        get: () => buildQuery(undefined).get(),
      }),
    }),
    batch: () => ({
      set: (ref: any, data: any) => {
        writes.push({ id: ref.__id, data });
      },
      commit: async () => {},
    }),
  };

  function buildQuery(after: any) {
    let list = ordered;
    if (after) list = list.filter((d) => d.id > after.__id);
    return {
      startAfter: (snap: any) => buildQuery(snap),
      get: async () => {
        const docs = list.slice(0, 400).map((d) => ({
          id: d.id,
          data: () => d.data,
          ref: { __id: d.id },
        }));
        return {
          empty: docs.length === 0,
          docs,
          forEach: (fn: (d: any) => void) => docs.forEach(fn),
        };
      },
    };
  }
}

describe("orderBackfill runner", () => {
  it("dry-run plans without writing", async () => {
    const db = fakeDb([{ id: "o1", data: { userId: "u" } }]);
    const summary = await runOrderBackfill(db as any, { dryRun: true });
    expect(summary.scanned).toBe(1);
    expect(summary.updated).toBe(1);
    expect(db.writes).toHaveLength(0);
    expect(summary.dryRun).toBe(true);
  });

  it("apply writes only missing fields", async () => {
    const db = fakeDb([
      { id: "o1", data: { userId: "u", placedAt: "t" } },
      { id: "o2", data: { customerId: "c", createdAt: "t", updatedAt: "t", branchId: "b" } },
    ]);
    const summary = await runOrderBackfill(db as any, { dryRun: false });
    expect(summary.scanned).toBe(2);
    expect(summary.updated).toBe(1);
    expect(summary.skipped).toBe(1);
    expect(db.writes).toHaveLength(1);
    expect(db.writes[0]).toMatchObject({ id: "o1" });
  });
});
