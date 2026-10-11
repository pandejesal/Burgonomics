import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, savedDocs } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  const makeRef = (colName: string, docId: string) => ({
    id: docId,
    // Transaction refs must resolve back to the same doc.
    __path: `${colName}/${docId}`,
    get: vi.fn(async () => ({
      exists: !!savedDocs[`${colName}/${docId}`],
      data: () => savedDocs[`${colName}/${docId}`] || {},
    })),
    set: vi.fn(async (data: any, opts?: any) => {
      const p = `${colName}/${docId}`;
      savedDocs[p] =
        opts?.merge && savedDocs[p] ? { ...savedDocs[p], ...data } : data;
    }),
    update: vi.fn(async (data: any) => {
      const p = `${colName}/${docId}`;
      if (!savedDocs[p]) throw new Error(`No document to update: ${p}`);
      savedDocs[p] = { ...savedDocs[p], ...data };
    }),
  });
  const mockDb: any = {
    collection: (colName: string) => ({
      doc: (docId: string) => makeRef(colName, docId),
    }),
    // Minimal transaction shim: reads see the same store, updates commit
    // straight through (the tests assert post-state, not isolation).
    runTransaction: async (fn: (tx: any) => Promise<any>) =>
      fn({
        get: async (ref: any) => ({
          exists: !!savedDocs[ref.__path],
          data: () => savedDocs[ref.__path] || {},
        }),
        update: async (ref: any, data: any) => {
          if (!savedDocs[ref.__path]) throw new Error(`No document to update: ${ref.__path}`);
          savedDocs[ref.__path] = { ...savedDocs[ref.__path], ...data };
        },
        set: async (ref: any, data: any) => {
          savedDocs[ref.__path] = data;
        },
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

  // Regression: a stale KDS screen / delayed second tap must not reverse a
  // newer status written by another staff member (was blind last-write-wins).
  it("applies the bump when expectedStatus still matches the stored state", async () => {
    await bumpOrderStatus({
      orderId: "ord_1",
      status: "preparing",
      expectedStatus: "PLACED",
      caller: ownBranchCaller,
    });
    expect(savedDocs["orders/ord_1"].status).toMatchObject({ code: "PREPARING" });
  });

  it("rejects a bump whose expectedStatus is stale (409 STALE_ORDER_STATUS)", async () => {
    savedDocs["orders/ord_1"].status = { code: "PREPARING", terminal: false };
    await expect(
      bumpOrderStatus({
        orderId: "ord_1",
        status: "cancelled",
        expectedStatus: "PLACED", // screen still shows the old state
        caller: ownBranchCaller,
      })
    ).rejects.toMatchObject({ statusCode: 409, code: "STALE_ORDER_STATUS" });
    // Nothing was written: the newer state survives.
    expect(savedDocs["orders/ord_1"].status).toMatchObject({ code: "PREPARING" });
  });

  // Regression: terminal orders are frozen — a late/reordered bump used to be
  // able to walk DELIVERED back to PREPARING (or cancel a delivered order).
  it("refuses any bump on a terminal order (409 ORDER_STATUS_CONFLICT)", async () => {
    savedDocs["orders/ord_1"].status = { code: "DELIVERED", terminal: true };
    for (const status of ["preparing", "cancelled", "ready"] as const) {
      await expect(
        bumpOrderStatus({ orderId: "ord_1", status, caller: ownBranchCaller })
      ).rejects.toMatchObject({ statusCode: 409, code: "ORDER_STATUS_CONFLICT" });
    }
    expect(savedDocs["orders/ord_1"].status).toMatchObject({ code: "DELIVERED" });
  });

  it("still allows a backward recall between non-terminal states", async () => {
    savedDocs["orders/ord_1"].status = { code: "PREPARING", terminal: false };
    await bumpOrderStatus({
      orderId: "ord_1",
      status: "accepted",
      expectedStatus: "PREPARING",
      caller: ownBranchCaller,
    });
    expect(savedDocs["orders/ord_1"].status).toMatchObject({ code: "CONFIRMED" });
  });
});
