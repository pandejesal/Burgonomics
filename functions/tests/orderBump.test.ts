import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, savedDocs } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  const mockDb: any = {
    collection: (colName: string) => ({
      doc: (docId: string) => ({
        id: docId,
        get: vi.fn(async () => ({
          exists: !!savedDocs[`${colName}/${docId}`],
          data: () => savedDocs[`${colName}/${docId}`] || {},
        })),
        set: vi.fn(async (data: any, opts?: any) => {
          const p = `${colName}/${docId}`;
          savedDocs[p] =
            opts?.merge && savedDocs[p] ? { ...savedDocs[p], ...data } : data;
        }),
      }),
    }),
  };
  return { mockDb, savedDocs };
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

import { bumpOrderStatus } from "../src/modules/orders/orderStatus";

describe("bumpOrderStatus (server-side KDS bump)", () => {
  const ownBranchCaller = { uid: "staff_1", role: "branch_staff", branchIds: ["b1"] };

  beforeEach(() => {
    for (const key of Object.keys(savedDocs)) delete savedDocs[key];
    savedDocs["orders/ord_1"] = { branchId: "b1", status: { code: "PLACED" } };
  });

  it("writes the Delivery-compatible object form for a forward bump", async () => {
    const res: any = await bumpOrderStatus({ orderId: "ord_1", status: "preparing", caller: ownBranchCaller });
    expect(res.status).toMatchObject({ code: "PREPARING", terminal: false });
    expect(savedDocs["orders/ord_1"].status).toMatchObject({ code: "PREPARING" });
  });

  it("normalizes legacy aliases (ready_for_pickup -> ready)", async () => {
    const res: any = await bumpOrderStatus({ orderId: "ord_1", status: "ready_for_pickup", caller: ownBranchCaller });
    expect(res.status).toMatchObject({ code: "READY_FOR_PICKUP" });
  });

  it("404s a missing order", async () => {
    await expect(
      bumpOrderStatus({ orderId: "ord_missing", status: "ready", caller: ownBranchCaller })
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("denies a cross-branch staffer (Forbidden)", async () => {
    const other = { uid: "staff_2", role: "branch_staff", branchIds: ["b2"] };
    await expect(
      bumpOrderStatus({ orderId: "ord_1", status: "ready", caller: other })
    ).rejects.toThrow(/^Forbidden/);
    expect(savedDocs["orders/ord_1"].status).toMatchObject({ code: "PLACED" });
  });

  it("records cancellationReason when supplied", async () => {
    await bumpOrderStatus({
      orderId: "ord_1",
      status: "cancelled",
      cancellationReason: "Customer asked to cancel",
      caller: ownBranchCaller,
    });
    expect(savedDocs["orders/ord_1"].cancellationReason).toBe("Customer asked to cancel");
    expect(savedDocs["orders/ord_1"].status.terminal).toBe(true);
  });
});
