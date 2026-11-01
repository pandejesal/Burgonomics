import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * CUS-16 server gate: an online order that has no SERVER paymentChannel
 * ("razorpay") may not advance past PLACED. The partner KDS used to show an
 * abandoned, unpaid order as "Pending" and staff could accept/prepare it,
 * ringing a kitchen for food nobody paid for. Cash, COD and walk-in orders are
 * unaffected, and cancelling stays allowed.
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
      savedDocs[p] = opts?.merge && savedDocs[p] ? { ...savedDocs[p], ...data } : data;
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

const caller = { uid: "staff_1", role: "branch_staff", branchIds: ["b1"] };
const createdAt = new Date(Date.now() - 40 * 60_000).toISOString();

/** Exactly the live server shape from ord_1793523404362_PKKeDF. */
const abandonedOnlineOrder = (over: Record<string, any> = {}) => ({
  branchId: "b1",
  fulfillment: "takeaway",
  createdAt,
  placedAt: createdAt,
  customerId: "cust_qa",
  userId: "cust_qa",
  status: { code: "PLACED", label: "Order placed", kind: "upcoming", terminal: false },
  payment: { method: "online", label: "Pay Online", status: "pending" },
  ...over,
});

describe("bumpOrderStatus — unpaid online orders may not advance (CUS-16)", () => {
  beforeEach(() => {
    for (const key of Object.keys(savedDocs)) delete savedDocs[key];
  });

  it.each(["accepted", "preparing", "ready", "delivered"] as const)(
    "refuses %s with 409 ORDER_NOT_PAID and writes nothing",
    async (status) => {
      savedDocs["orders/ord_unpaid"] = abandonedOnlineOrder();
      const before = JSON.stringify(savedDocs["orders/ord_unpaid"]);

      await expect(
        bumpOrderStatus({ orderId: "ord_unpaid", status, caller })
      ).rejects.toMatchObject({ statusCode: 409, code: "ORDER_NOT_PAID" });

      expect(JSON.stringify(savedDocs["orders/ord_unpaid"])).toBe(before);
    }
  );

  it("refuses an offline-queued bump that carries expectedStatus", async () => {
    savedDocs["orders/ord_queued"] = abandonedOnlineOrder();
    await expect(
      bumpOrderStatus({
        orderId: "ord_queued",
        status: "preparing",
        expectedStatus: "PLACED",
        caller,
      })
    ).rejects.toMatchObject({ statusCode: 409, code: "ORDER_NOT_PAID" });
    expect(savedDocs["orders/ord_queued"].status.code).toBe("PLACED");
  });

  it("still allows cancelling the unpaid order", async () => {
    savedDocs["orders/ord_unpaid"] = abandonedOnlineOrder();
    const res: any = await bumpOrderStatus({
      orderId: "ord_unpaid",
      status: "cancelled",
      cancellationReason: "payment_not_completed",
      caller,
    });
    expect(res.status).toMatchObject({ code: "CANCELLED", terminal: true });
  });

  it("allows a SERVER-confirmed online order (paymentChannel razorpay)", async () => {
    savedDocs["orders/ord_paid"] = abandonedOnlineOrder({
      paymentChannel: "razorpay",
      paymentStatus: "completed",
      payment: { method: "online", status: "completed" },
    });
    const res: any = await bumpOrderStatus({ orderId: "ord_paid", status: "preparing", caller });
    expect(res.status).toMatchObject({ code: "PREPARING" });
  });

  it("leaves cash/COD orders untouched", async () => {
    savedDocs["orders/ord_cash"] = abandonedOnlineOrder({
      payment: { method: "cod", label: "Cash on Delivery", status: "CASH_PENDING" },
    });
    const res: any = await bumpOrderStatus({ orderId: "ord_cash", status: "preparing", caller });
    expect(res.status).toMatchObject({ code: "PREPARING" });
  });

  it("leaves walk-in counter orders (razorpay tender, paid at counter) untouched", async () => {
    savedDocs["orders/ord_walkin"] = abandonedOnlineOrder({
      customerId: "cust_walkin",
      paymentMethod: "razorpay",
      paymentStatus: "completed",
      payment: { method: "razorpay", status: "completed" },
    });
    const res: any = await bumpOrderStatus({ orderId: "ord_walkin", status: "preparing", caller });
    expect(res.status).toMatchObject({ code: "PREPARING" });
  });
});
