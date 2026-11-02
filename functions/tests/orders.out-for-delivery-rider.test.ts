import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * P1-G — a delivery order must not be told "out for delivery" with nobody
 * coming.
 *
 * LIVE FINDING: `POST /orders/bumpStatus` let READY_FOR_PICKUP move straight to
 * OUT_FOR_DELIVERY on a delivery order with no courier booking and no in-house
 * rider. The customer tracker then promises food on the way while no rider
 * exists — worse than a delay, because the customer stops worrying about it.
 *
 * The fix under test: that specific transition is refused with a typed 409 when
 * the order has no live booking, UNLESS it legitimately has one:
 *   - an in-house assignment (`/orders/manualDispatch`, dispatchType
 *     manual_branch_terminal + active deliveryStatus), or
 *   - a live provider booking (dispatchProvider + dispatchOrderId in an active
 *     state, or an owned live booking), or
 *   - a `needsRebook` / `needs_review` park, which is a staff decision state and
 *     already handled by the dispatch queue, not a silent handover.
 * Courier webhooks never use this route (they are pinned separate by
 * orderBump.test.ts), so neither the Borzo webhook nor the Porter poller is
 * affected.
 */

const { mockDb, savedDocs } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  const makeRef = (colName: string, docId: string) => ({
    id: docId,
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

describe("P1-G: OUT_FOR_DELIVERY needs a real rider on a delivery order", () => {
  const ownBranchCaller = { uid: "staff_1", role: "branch_staff", branchIds: ["b1"] };

  beforeEach(() => {
    for (const key of Object.keys(savedDocs)) delete savedDocs[key];
  });

  function seedReadyDelivery(id: string, extra: Record<string, any> = {}) {
    savedDocs[`orders/${id}`] = {
      branchId: "b1",
      orderType: "delivery",
      fulfillment: "delivery",
      status: { code: "READY_FOR_PICKUP", label: "Ready for pickup", kind: "in_progress", terminal: false },
      ...extra,
    };
  }

  it("refuses ready -> out_for_delivery with no courier booking and no in-house rider", async () => {
    seedReadyDelivery("ord_p1g_norider");

    await expect(
      bumpOrderStatus({ orderId: "ord_p1g_norider", status: "out_for_delivery", caller: ownBranchCaller })
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "DISPATCH_RIDER_REQUIRED",
    });

    // Nothing was written: the customer is never told a rider is coming.
    expect(savedDocs["orders/ord_p1g_norider"].status).toMatchObject({
      code: "READY_FOR_PICKUP",
    });
  });

  it("allows it for an in-house assignment (what /orders/manualDispatch writes)", async () => {
    seedReadyDelivery("ord_p1g_inhouse", {
      dispatchType: "manual_branch_terminal",
      deliveryStatus: "dispatched",
      riderName: "Local Rider",
      riderPhone: "9825011223",
    });

    const res: any = await bumpOrderStatus({
      orderId: "ord_p1g_inhouse",
      status: "out_for_delivery",
      caller: ownBranchCaller,
    });
    expect(res.status).toMatchObject({ code: "OUT_FOR_DELIVERY" });
    expect(savedDocs["orders/ord_p1g_inhouse"].status).toMatchObject({
      code: "OUT_FOR_DELIVERY",
    });
  });

  it("allows it for a live provider booking", async () => {
    seedReadyDelivery("ord_p1g_borzo", {
      deliveryStatus: "dispatched",
      dispatchStatus: "dispatched",
      dispatchProvider: "borzo",
      dispatchOrderId: "BRZ-P1G-1",
      borzoOrderId: "BRZ-P1G-1",
      riderName: "[TEST] Borzo Rider Kiran",
    });

    const res: any = await bumpOrderStatus({
      orderId: "ord_p1g_borzo",
      status: "out_for_delivery",
      caller: ownBranchCaller,
    });
    expect(res.status).toMatchObject({ code: "OUT_FOR_DELIVERY" });
  });

  it("allows it when the order is parked for a rebook decision (no silent lie either way)", async () => {
    seedReadyDelivery("ord_p1g_rebook", {
      deliveryStatus: "needs_review",
      needsRebook: true,
      rebookTrigger: "carrier_cancelled",
    });

    const res: any = await bumpOrderStatus({
      orderId: "ord_p1g_rebook",
      status: "out_for_delivery",
      caller: ownBranchCaller,
    });
    expect(res.status).toMatchObject({ code: "OUT_FOR_DELIVERY" });
  });

  it("does not gate takeaway or dine-in, which have no courier at all", async () => {
    savedDocs["orders/ord_p1g_away"] = {
      branchId: "b1",
      orderType: "takeaway",
      status: { code: "READY_FOR_PICKUP", terminal: false },
    };
    const away: any = await bumpOrderStatus({
      orderId: "ord_p1g_away",
      status: "out_for_delivery",
      caller: ownBranchCaller,
    });
    expect(away.status).toMatchObject({ code: "OUT_FOR_DELIVERY" });

    savedDocs["orders/ord_p1g_dine"] = {
      branchId: "b1",
      orderType: "dinein",
      status: { code: "READY_TO_SERVE", terminal: false },
    };
    const dine: any = await bumpOrderStatus({
      orderId: "ord_p1g_dine",
      status: "out_for_delivery",
      caller: ownBranchCaller,
    });
    expect(dine.status).toMatchObject({ code: "OUT_FOR_DELIVERY" });
  });
});
