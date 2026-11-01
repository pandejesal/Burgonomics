import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

/**
 * CUS-16: the same paid-order gate must cover the other server paths that
 * commit fulfilment, not only the KDS bump. Booking a courier or assigning an
 * in-house rider for an unpaid online order would advance/deliver food nobody
 * paid for (and a courier webhook then writes OUT_FOR_DELIVERY/DELIVERED).
 */
const { mockDb, savedDocs, control } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  const control = { writes: [] as string[] };
  const mergeSet = (path: string, data: any) => {
    savedDocs[path] = { ...(savedDocs[path] || {}), ...data };
    control.writes.push(path);
  };
  const makeRef = (colName: string, docId: string) => {
    const path = `${colName}/${docId}`;
    const ref: any = {
      id: docId,
      path,
      get: async () => ({
        exists: Boolean(savedDocs[path]),
        data: () => (savedDocs[path] ? { ...savedDocs[path] } : undefined),
        ref,
      }),
      set: async (data: any) => mergeSet(path, data),
    };
    return ref;
  };
  const mockDb: any = {
    collection: (colName: string) => ({
      doc: (docId: string) => makeRef(colName, docId),
      where: () => ({
        limit: () => ({ get: async () => ({ empty: true, docs: [] }) }),
      }),
    }),
    runTransaction: vi.fn(async (fn: any) =>
      fn({
        get: async (ref: any) => ref.get(),
        set: (ref: any, data: any) => mergeSet(ref.path, data),
      })
    ),
  };
  return { mockDb, savedDocs, control };
});

vi.mock("firebase-admin", () => {
  const FieldValue = {
    serverTimestamp: () => "MOCK_TS",
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

import { manualBranchDispatch } from "../src/modules/porter/porter.service";
import { dispatchBook } from "../src/modules/dispatch/dispatch.router";

const fetchSpy = vi.fn(async () => {
  throw new Error("no provider network in this suite");
});
const originalFetch = globalThis.fetch;
globalThis.fetch = fetchSpy as any;

afterAll(() => {
  globalThis.fetch = originalFetch;
});

const staffCaller = {
  uid: "staff_1",
  role: "branch_staff",
  branchIds: ["branch_demo"],
};

const order = (over: Record<string, any> = {}) => ({
  branchId: "branch_demo",
  fulfillment: "delivery",
  customerPhone: "+919876543210",
  store: { name: "DEMO", phone: "+919876543210" },
  branchCoordinates: { lat: 23.0131, lng: 72.5085 },
  deliveryAddress: {
    full: "1 Test Road",
    lat: 23.0338,
    lng: 72.5317,
  },
  address: { lat: 23.0338, lng: 72.5317 },
  customerId: "cust_qa",
  userId: "cust_qa",
  createdAt: new Date(Date.now() - 40 * 60_000).toISOString(),
  status: { code: "PLACED", label: "Order placed", kind: "upcoming", terminal: false },
  payment: { method: "online", label: "Pay Online", status: "pending" },
  ...over,
});

describe("dispatch paths refuse an unpaid online order (CUS-16)", () => {
  beforeEach(() => {
    for (const key of Object.keys(savedDocs)) delete savedDocs[key];
    control.writes.length = 0;
    fetchSpy.mockClear();
  });

  it("refuses an in-house rider assignment and writes nothing", async () => {
    savedDocs["orders/ord_unpaid"] = order();
    await expect(
      manualBranchDispatch({
        orderId: "ord_unpaid",
        staffName: "Staff",
        riderName: "Ravi",
        riderPhone: "+919800000000",
        caller: staffCaller,
      } as any)
    ).rejects.toMatchObject({ statusCode: 409, code: "ORDER_NOT_PAID" });

    expect(control.writes).toEqual([]);
    expect(savedDocs["orders/ord_unpaid"].riderName).toBeUndefined();
  });

  it("refuses a courier booking before any provider call", async () => {
    savedDocs["orders/ord_unpaid"] = order();
    await expect(
      dispatchBook({ orderId: "ord_unpaid", staffName: "Staff", caller: staffCaller } as any)
    ).rejects.toMatchObject({ code: "ORDER_NOT_PAID" });

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("still allows a SERVER-confirmed online order to dispatch", async () => {
    savedDocs["orders/ord_paid"] = order({
      paymentChannel: "razorpay",
      paymentStatus: "completed",
      payment: { method: "online", status: "completed" },
      status: { code: "PREPARING", label: "Preparing", kind: "in_progress", terminal: false },
    });
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ order_id: "bz_1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }) as any
    );
    // Anything but ORDER_NOT_PAID proves the gate let it through; provider
    // configuration may still refuse the booking in this hermetic suite.
    const err: any = await dispatchBook({ orderId: "ord_paid", staffName: "Staff" } as any).catch(
      (e) => e
    );
    expect(err?.code).not.toBe("ORDER_NOT_PAID");
  });
});
