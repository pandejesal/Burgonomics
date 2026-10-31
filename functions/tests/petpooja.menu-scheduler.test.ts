import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, branchDocs } = vi.hoisted(() => {
  const branchDocs = [
    { id: "branch_linked" },
    { id: "branch_unlinked_1" },
    { id: "branch_unlinked_2" },
    { id: "branch_vendor_down" },
  ];
  const mockDb: any = {
    collection: (col: string) => {
      if (col !== "branches") throw new Error(`unexpected collection ${col}`);
      const query: any = {
        where: () => query,
        limit: () => query,
        orderBy: () => query,
        startAfter: () => query,
        get: async () => ({ docs: branchDocs }),
      };
      return query;
    },
  };
  return { mockDb, branchDocs };
});

vi.mock("../src/core/firebase", () => ({ db: mockDb }));
vi.mock("firebase-functions/logger", () => ({
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  log: vi.fn(),
}));
vi.mock("../src/modules/petpooja/menuSyncWebhook", () => ({
  syncPetpoojaMenu: vi.fn(async (branchId: string) => {
    if (branchId === "branch_linked") return { itemCount: 10, categoriesCount: 2 };
    if (branchId.startsWith("branch_unlinked")) {
      const err: any = new Error(`Branch ${branchId} has no linked Petpooja outlet`);
      err.unlinkedOutlet = true;
      throw err;
    }
    const err: any = new Error("Petpooja Menu API refused the catalog lookup");
    err.vendorRefusal = true;
    throw err;
  }),
}));
vi.mock("../src/modules/petpooja/orderPush", () => ({
  pushOrderToPetpooja: vi.fn(),
  wasPushDeferredBusy: vi.fn(),
}));
vi.mock("../src/modules/notifications/fcm.service", () => ({ dispatchFCM: vi.fn() }));

import * as logger from "firebase-functions/logger";
import { syncAllBranchesPetpoojaMenu } from "../src/modules/petpooja/petpooja.scheduler";

describe("hourly menu sync reporting (OPS-D)", () => {
  beforeEach(() => {
    branchDocs.splice(
      0,
      branchDocs.length,
      { id: "branch_linked" },
      { id: "branch_unlinked_1" },
      { id: "branch_unlinked_2" },
      { id: "branch_vendor_down" }
    );
    vi.mocked(logger.warn).mockClear();
    vi.mocked(logger.error).mockClear();
  });

  it("reports unlinked outlets as ONE warning and keeps genuine failures at error", async () => {
    const res = await syncAllBranchesPetpoojaMenu();
    expect(res.syncedBranches).toBe(1);

    expect(logger.warn).toHaveBeenCalledTimes(1);
    const summary = String(vi.mocked(logger.warn).mock.calls[0][0]);
    expect(summary).toContain("2 active branch(es)");
    expect(summary).toContain("branch_unlinked_1");
    expect(summary).toContain("branch_unlinked_2");
    expect(summary).not.toContain("branch_vendor_down");

    // The vendor refusal stays an error (and no per-branch error for unlinked).
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(logger.error).mock.calls[0][0])).toContain("branch_vendor_down");
  });

  it("does not warn when every active branch is linked", async () => {
    branchDocs.splice(0, branchDocs.length, { id: "branch_linked" }, { id: "branch_linked" });
    await syncAllBranchesPetpoojaMenu();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });
});
