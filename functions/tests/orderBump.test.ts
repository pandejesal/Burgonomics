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

  // -------------------------------------------------------------------------
  // G1 pins: expectedStatus is Partner vocabulary; expected/actual compare via
  // the canonical tables incl. fulfillment forks; response carries the meta
  // the server WROTE; cancellationReason is a cancellation-only attribute.
  // -------------------------------------------------------------------------

  it("matches a Partner-vocabulary expectedStatus against a Delivery-code state", async () => {
    savedDocs["orders/ord_1"].status = { code: "CONFIRMED" };
    await bumpOrderStatus({
      orderId: "ord_1",
      status: "preparing",
      expectedStatus: "accepted", // partner vocab the KDS screen actually sends
      caller: ownBranchCaller,
    });
    expect(savedDocs["orders/ord_1"].status).toMatchObject({ code: "PREPARING" });
  });

  it("matches a dinein expectedStatus through the READY_TO_SERVE fork", async () => {
    // The dinein order sits at CONFIRMED-your vocab "accepted"; a later bump
    // leaves it READY_TO_SERVE. THEN the client re-refs with expectedStatus
    // "ready" and the screen's stored state must still count as the same state
    // (the fork, not the generic READY_FOR_PICKUP).
    savedDocs["orders/ord_dinein"] = { branchId: "b1", fulfillmentType: "dinein", status: { code: "CONFIRMED" } };
    await bumpOrderStatus({ orderId: "ord_dinein", status: "ready", caller: ownBranchCaller });
    expect(savedDocs["orders/ord_dinein"].status).toMatchObject({ code: "READY_TO_SERVE", terminal: false });
    // the fork-for-back match:
    await bumpOrderStatus({
      orderId: "ord_dinein",
      status: "delivered",
      expectedStatus: "ready",
      caller: ownBranchCaller,
    });
    expect(savedDocs["orders/ord_dinein"].status).toMatchObject({ code: "COMPLETED", terminal: true });
  });

  it("responds with the meta actually written (dinein READY_TO_SERVE, not generic READY_FOR_PICKUP)", async () => {
    savedDocs["orders/ord_dinein2"] = { branchId: "b1", fulfillmentType: "dinein", status: { code: "CONFIRMED" } };
    const res: any = await bumpOrderStatus({
      orderId: "ord_dinein2",
      status: "ready",
      caller: ownBranchCaller,
    });
    expect(res.status).toMatchObject({ code: "READY_TO_SERVE" });
    expect(savedDocs["orders/ord_dinein2"].status).toMatchObject({ code: "READY_TO_SERVE" });
  });

  it("responds with takeaway PICKED_UP on delivered", async () => {
    savedDocs["orders/ord_away"] = { branchId: "b1", fulfillmentType: "takeaway", status: { code: "READY_FOR_PICKUP" } };
    const res: any = await bumpOrderStatus({
      orderId: "ord_away",
      status: "delivered",
      caller: ownBranchCaller,
    });
    expect(res.status).toMatchObject({ code: "PICKED_UP", terminal: true });
  });

  it("accepts canonical Delivery codes and case-insensitive spellings in expectedStatus", async () => {
    savedDocs["orders/ord_ofd"] = { branchId: "b1", status: { code: "OUT_FOR_DELIVERY" } };
    await bumpOrderStatus({
      orderId: "ord_ofd",
      status: "delivered",
      expectedStatus: "out_for_delivery", // lowercase canonical spelling
      caller: ownBranchCaller,
    });
    expect(savedDocs["orders/ord_ofd"].status).toMatchObject({ code: "DELIVERED", terminal: true });
  });

  it("rejects unknown expected vocabulary (409 STALE_ORDER_STATUS, not a silent apply)", async () => {
    savedDocs["orders/ord_1"].status = { code: "PLACED" };
    for (const bad of ["quarantine", "banana"]) {
      await expect(
        bumpOrderStatus({
          orderId: "ord_1",
          status: "preparing",
          expectedStatus: bad,
          caller: ownBranchCaller,
        })
      ).rejects.toMatchObject({ statusCode: 409, code: "STALE_ORDER_STATUS" });
      expect(savedDocs["orders/ord_1"].status).toMatchObject({ code: "PLACED" });
    }
  });

  it("rejects a CONFLICTING valid alias (expected not the real current state)", async () => {
    savedDocs["orders/ord_1"].status = { code: "PLACED" };
    await expect(
      bumpOrderStatus({
        orderId: "ord_1",
        status: "preparing",
        expectedStatus: "ready", // valid vocab, wrong state
        caller: ownBranchCaller,
      })
    ).rejects.toMatchObject({ statusCode: 409, code: "STALE_ORDER_STATUS" });
  });

  it("cancellationReason rides cancellation only, never a live cooking bump", async () => {
    await bumpOrderStatus({
      orderId: "ord_1",
      status: "preparing",
      cancellationReason: "stray reason on a live order",
      caller: ownBranchCaller,
    });
    expect(savedDocs["orders/ord_1"].cancellationReason).toBeUndefined();
    expect(savedDocs["orders/ord_1"].status).toMatchObject({ code: "PREPARING" });
  });

  it("terminal orders stay frozen even when expectedStatus matches", async () => {
    savedDocs["orders/ord_term"] = { branchId: "b1", status: { code: "DELIVERED", terminal: true } };
    await expect(
      bumpOrderStatus({
        orderId: "ord_term",
        status: "pending",
        expectedStatus: "delivered",
        caller: ownBranchCaller,
      })
    ).rejects.toMatchObject({ statusCode: 409, code: "ORDER_STATUS_CONFLICT" });
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
