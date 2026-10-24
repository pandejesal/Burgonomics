import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";

const { mockDb, savedDocs, defaultOrder } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  const defaultOrder = () => ({
    branchId: "branch_ahmedabad_1",
    branchName: "Burgonomics CG Road",
    store: { name: "Burgonomics CG Road", phone: "+91 98250 12345" },
    branchCoordinates: { lat: 23.0131, lng: 72.5085 },
    deliveryAddress: {
      full: "102, Shivalik Highstreet, Vastrapur",
      lat: 23.0338,
      lng: 72.5262,
    },
    customerPhone: "+91 99999 88888",
    customerName: "Aarav Shah",
    status: "ready",
  });
  const mergeSet = (colName: string, docId: string, data: any) => {
    savedDocs[`${colName}/${docId}`] = {
      ...(savedDocs[`${colName}/${docId}`] || {}),
      ...data,
    };
  };
  const readDoc: any = (colName: string, docId: string) => {
    const raw = savedDocs[`${colName}/${docId}`];
    const snap: any = {
      exists: raw !== undefined,
      id: docId,
      data: () => raw || defaultOrder(),
      ref: {
        id: docId,
        get: vi.fn(async () => readDoc(colName, docId)),
        set: vi.fn(async (data: any) => mergeSet(colName, docId, data)),
      },
    };
    return snap;
  };
  const mockDb: any = {
    collection: (colName: string) => ({
      doc: (docId: string) => ({
        id: docId,
        set: vi.fn(async (data: any) => mergeSet(colName, docId, data)),
        get: vi.fn(async () => readDoc(colName, docId)),
      }),
      where: (field: string, op: string, val: any) => ({
        limit: (n: number) => ({
          get: async () => ({ empty: true, docs: [] }),
        }),
      }),
    }),
    runTransaction: vi.fn(async (fn: any) =>
      fn({
        get: (ref: any) => ref.get(),
        set: (ref: any, data: any, opts?: any) => ref.set(data, opts),
      })
    ),
  };
  return { mockDb, savedDocs, defaultOrder };
});

vi.mock("firebase-admin", () => {
  const FieldValue = {
    serverTimestamp: () => "MOCK_TIMESTAMP",
    increment: (n: number) => n,
    arrayUnion: (item: any) => [item],
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

import { dispatchCancel } from "../src/modules/dispatch/dispatch.router";

function seedOrder(id: string, extra: Record<string, any> = {}) {
  savedDocs[`orders/${id}`] = { ...defaultOrder(), ...extra };
}

function docOf(id: string): any {
  return savedDocs[`orders/${id}`];
}

beforeEach(() => {
  for (const k of Object.keys(savedDocs)) delete savedDocs[k];
  vi.clearAllMocks();
});

describe("F3: dispatchCancel terminal race protection", () => {
  it("cancel racing concurrent DELIVERED callback preserves delivered state (no regression)", async () => {
    seedOrder("ord_cancel_race", {
      deliveryStatus: "in_transit",
      dispatchProvider: "borzo",
      dispatchOrderId: "BZ-ACTIVE-99",
      borzoOrderId: "BZ-ACTIVE-99",
      needsRebook: false,
    });

    // Simulate concurrent DELIVERED callback landing between pre-read and transaction commit
    const originalRunTx = mockDb.runTransaction;
    mockDb.runTransaction = vi.fn(async (fn: any) => {
      return fn({
        get: async (ref: any) => {
          // Concurrent webhook flips the order to delivered before tx reads fresh snapshot
          savedDocs["orders/ord_cancel_race"] = {
            ...savedDocs["orders/ord_cancel_race"],
            deliveryStatus: "delivered",
            status: { code: "DELIVERED", terminal: true },
            deliveredAt: "MOCK_TIMESTAMP",
          };
          return ref.get();
        },
        set: (ref: any, data: any, opts?: any) => ref.set(data, opts),
      });
    });

    try {
      await expect(
        dispatchCancel({
          orderId: "ord_cancel_race",
          staffName: "Branch Ops",
        })
      ).rejects.toMatchObject({
        statusCode: 409,
        code: "DISPATCH_LOCKED",
      });

      const finalDoc = docOf("ord_cancel_race");
      // DELIVERED status MUST be preserved — not regressed to rider_cancelled
      expect(finalDoc.deliveryStatus).toBe("delivered");
      expect(finalDoc.status).toMatchObject({ code: "DELIVERED", terminal: true });
      expect(finalDoc.needsRebook).toBe(false);
      expect(finalDoc.rebookTrigger).toBeUndefined();
      expect(finalDoc.cancelledBy).toBeUndefined();
    } finally {
      mockDb.runTransaction = originalRunTx;
    }
  });

  it("cancel on an already delivered order refuses upfront with 409 DISPATCH_LOCKED", async () => {
    seedOrder("ord_already_delivered", {
      deliveryStatus: "delivered",
      status: { code: "DELIVERED", terminal: true },
      dispatchProvider: "borzo",
      dispatchOrderId: "BZ-DEL-1",
    });

    await expect(
      dispatchCancel({
        orderId: "ord_already_delivered",
        staffName: "Branch Ops",
      })
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "DISPATCH_LOCKED",
    });

    const doc = docOf("ord_already_delivered");
    expect(doc.deliveryStatus).toBe("delivered");
  });

  it("cancel on a non-active order refuses with 409 NOTHING_TO_CANCEL", async () => {
    seedOrder("ord_not_active", {
      deliveryStatus: "ready",
      status: "ready",
    });

    await expect(
      dispatchCancel({
        orderId: "ord_not_active",
        staffName: "Branch Ops",
      })
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "NOTHING_TO_CANCEL",
    });
  });

  it("honest cancel transitions active dispatch to rider_cancelled with released binding", async () => {
    seedOrder("ord_honest_cancel", {
      deliveryStatus: "in_transit",
      dispatchProvider: "borzo",
      dispatchOrderId: "BZ-HONEST-1",
      borzoOrderId: "BZ-HONEST-1",
      needsRebook: false,
    });

    const result = await dispatchCancel({
      orderId: "ord_honest_cancel",
      staffName: "Branch Ops",
    });

    expect(result).toMatchObject({
      success: true,
      orderId: "ord_honest_cancel",
      provider: "borzo",
      providerCancel: "manual-required",
    });

    const doc = docOf("ord_honest_cancel");
    expect(doc.deliveryStatus).toBe("rider_cancelled");
    expect(doc.dispatchStatus).toBe("cancelled_by_store");
    expect(doc.needsRebook).toBe(true);
    expect(doc.rebookTrigger).toBe("staff_cancelled");
    expect(doc.cancelledBy).toBe("Branch Ops");
    expect(doc.dispatchReleasedBindings).toHaveLength(1);
    expect(doc.dispatchReleasedBindings[0]).toMatchObject({
      provider: "borzo",
      providerOrderId: "BZ-HONEST-1",
      reason: "staff_cancelled",
    });
  });
});
