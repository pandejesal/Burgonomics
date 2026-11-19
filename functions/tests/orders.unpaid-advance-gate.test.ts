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
import { isAbandonedUnpaidOnlineOrder } from "../src/modules/orders/paymentGate";

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

/**
 * F04 — the KITCHEN admission gate must not read "online" alone.
 *
 * Defect: `assertOnlineOrderPaid` returns early unless the payment method is
 * literally "online". An ordinary CUSTOMER order created before Razorpay opens
 * can carry `payment.method: "upi" | "card" | "wallet" | "netbanking"` (or a
 * missing/empty/garbage method) while still `pending`. None of those are
 * "online", so the kitchen admitted an order whose money never arrived.
 *
 * Required here: an ordinary customer (anything that is NOT the walk-in
 * counter stream) needs the EXISTING server-owned `paymentChannel: "razorpay"`
 * marker. Explicit cash/COD is exempt. Missing/empty/non-string/unknown method
 * is NOT proof of cash — it fails closed 409 ORDER_NOT_PAID. The client-writable
 * `payment.status` label is never accepted as proof.
 *
 * Scope note: this closes the KITCHEN admission only. `assertOnlineOrderPaid`
 * (dispatch booking / Porter) and the expiry/auto-cancel path keep their
 * existing narrow "online" semantics.
 */
describe("F04 — kitchen admission needs the server capture marker, not the method label", () => {
  beforeEach(() => {
    for (const key of Object.keys(savedDocs)) delete savedDocs[key];
  });

  const kitchenStatuses = ["accepted", "preparing", "ready", "delivered"] as const;

  it.each(["upi", "card", "wallet", "netbanking", "UPI"])(
    "refuses an ordinary customer pending %s advance and leaves the doc unchanged",
    async (method) => {
      const id = `ord_f04_${method.toLowerCase()}`;
      savedDocs[`orders/${id}`] = abandonedOnlineOrder({
        customerId: "cust_f04",
        userId: "cust_f04",
        payment: { method, status: "pending" },
        paymentMethod: method,
        paymentStatus: "pending",
      });
      const before = JSON.stringify(savedDocs[`orders/${id}`]);
      for (const status of kitchenStatuses) {
        await expect(
          bumpOrderStatus({ orderId: id, status, caller })
        ).rejects.toMatchObject({ statusCode: 409, code: "ORDER_NOT_PAID" });
      }
      expect(JSON.stringify(savedDocs[`orders/${id}`])).toBe(before);
    }
  );

  it("refuses when the payment method is entirely absent (no cash proof)", async () => {
    savedDocs["orders/ord_f04_absent"] = abandonedOnlineOrder({
      customerId: "cust_f04",
      userId: "cust_f04",
      payment: { status: "pending" },
      paymentStatus: "pending",
    });
    const before = JSON.stringify(savedDocs["orders/ord_f04_absent"]);
    await expect(
      bumpOrderStatus({ orderId: "ord_f04_absent", status: "preparing", caller })
    ).rejects.toMatchObject({ statusCode: 409, code: "ORDER_NOT_PAID" });
    expect(JSON.stringify(savedDocs["orders/ord_f04_absent"])).toBe(before);
  });

  it("refuses an empty-string method", async () => {
    savedDocs["orders/ord_f04_empty"] = abandonedOnlineOrder({
      customerId: "cust_f04",
      userId: "cust_f04",
      payment: { method: "   ", status: "pending" },
      paymentMethod: "   ",
      paymentStatus: "pending",
    });
    const before = JSON.stringify(savedDocs["orders/ord_f04_empty"]);
    await expect(
      bumpOrderStatus({ orderId: "ord_f04_empty", status: "preparing", caller })
    ).rejects.toMatchObject({ statusCode: 409, code: "ORDER_NOT_PAID" });
    expect(JSON.stringify(savedDocs["orders/ord_f04_empty"])).toBe(before);
  });

  it("refuses a non-string method (number) instead of coercing it to cash", async () => {
    savedDocs["orders/ord_f04_nonstring"] = abandonedOnlineOrder({
      customerId: "cust_f04",
      userId: "cust_f04",
      payment: { method: 42, status: "pending" },
      paymentMethod: 42,
      paymentStatus: "pending",
    });
    await expect(
      bumpOrderStatus({ orderId: "ord_f04_nonstring", status: "preparing", caller })
    ).rejects.toMatchObject({ statusCode: 409, code: "ORDER_NOT_PAID" });
  });

  it("refuses an unknown/garbage method", async () => {
    savedDocs["orders/ord_f04_unknown"] = abandonedOnlineOrder({
      customerId: "cust_f04",
      userId: "cust_f04",
      payment: { method: "cryptocoin", status: "pending" },
      paymentMethod: "cryptocoin",
      paymentStatus: "pending",
    });
    await expect(
      bumpOrderStatus({ orderId: "ord_f04_unknown", status: "preparing", caller })
    ).rejects.toMatchObject({ statusCode: 409, code: "ORDER_NOT_PAID" });
  });

  it("refuses a client 'paid' label that has NO server marker", async () => {
    savedDocs["orders/ord_f04_clientpaid"] = abandonedOnlineOrder({
      customerId: "cust_f04",
      userId: "cust_f04",
      // The client writes these; none of them is server capture proof.
      payment: { method: "upi", status: "paid", capturedAmountPaise: 25000 },
      paymentStatus: "completed",
    });
    const before = JSON.stringify(savedDocs["orders/ord_f04_clientpaid"]);
    await expect(
      bumpOrderStatus({ orderId: "ord_f04_clientpaid", status: "preparing", caller })
    ).rejects.toMatchObject({ statusCode: 409, code: "ORDER_NOT_PAID" });
    expect(JSON.stringify(savedDocs["orders/ord_f04_clientpaid"])).toBe(before);
  });

  it("advances the SAME shape once the server marker is present", async () => {
    savedDocs["orders/ord_f04_marker"] = abandonedOnlineOrder({
      customerId: "cust_f04",
      userId: "cust_f04",
      paymentChannel: "razorpay",
      payment: { method: "upi", status: "completed" },
      paymentStatus: "completed",
    });
    const res: any = await bumpOrderStatus({
      orderId: "ord_f04_marker",
      status: "preparing",
      caller,
    });
    expect(res.status).toMatchObject({ code: "PREPARING" });
  });

  it.each([
    ["cod", "CASH_PENDING"],
    ["cash", "pending"],
    ["cod", "PAY_AT_STORE"],
  ])("keeps the deliberate cash/COD method=%s status=%s exemption", async (method, status) => {
    const id = `ord_f04_cash_${method}_${String(status).toLowerCase()}`;
    savedDocs[`orders/${id}`] = abandonedOnlineOrder({
      customerId: "cust_f04",
      userId: "cust_f04",
      payment: { method, status },
      paymentMethod: method,
      paymentStatus: status,
    });
    const res: any = await bumpOrderStatus({ orderId: id, status: "preparing", caller });
    expect(res.status).toMatchObject({ code: "PREPARING" });
  });

  it("still advances a walk-in counter order tendered razorpay and marked paid", async () => {
    savedDocs["orders/ord_f04_walkin_paid"] = abandonedOnlineOrder({
      customerId: "cust_walkin",
      userId: "staff_1",
      paymentMethod: "razorpay",
      paymentStatus: "completed",
      payment: { method: "razorpay", status: "completed" },
    });
    const res: any = await bumpOrderStatus({
      orderId: "ord_f04_walkin_paid",
      status: "preparing",
      caller,
    });
    expect(res.status).toMatchObject({ code: "PREPARING" });
  });

  it("still refuses the pending walk-in UPI order (orderStatus exception kept)", async () => {
    savedDocs["orders/ord_f04_walkin_upi"] = abandonedOnlineOrder({
      customerId: "cust_walkin",
      userId: "staff_1",
      paymentMethod: "upi",
      paymentStatus: "pending",
      payment: { method: "upi", status: "pending" },
    });
    await expect(
      bumpOrderStatus({ orderId: "ord_f04_walkin_upi", status: "preparing", caller })
    ).rejects.toMatchObject({ statusCode: 409, code: "ORDER_NOT_PAID" });
  });

  it("still allows cancelling an unpaid pending-UPI customer order", async () => {
    savedDocs["orders/ord_f04_cancel"] = abandonedOnlineOrder({
      customerId: "cust_f04",
      userId: "cust_f04",
      payment: { method: "upi", status: "pending" },
      paymentMethod: "upi",
      paymentStatus: "pending",
    });
    const res: any = await bumpOrderStatus({
      orderId: "ord_f04_cancel",
      status: "cancelled",
      cancellationReason: "payment_not_completed",
      caller,
    });
    expect(res.status).toMatchObject({ code: "CANCELLED", terminal: true });
  });

  it("applies the same gate to an offline-queued bump carrying expectedStatus", async () => {
    savedDocs["orders/ord_f04_queued"] = abandonedOnlineOrder({
      customerId: "cust_f04",
      userId: "cust_f04",
      payment: { method: "card", status: "pending" },
      paymentMethod: "card",
      paymentStatus: "pending",
    });
    await expect(
      bumpOrderStatus({
        orderId: "ord_f04_queued",
        status: "preparing",
        expectedStatus: "PLACED",
        caller,
      })
    ).rejects.toMatchObject({ statusCode: 409, code: "ORDER_NOT_PAID" });
    expect(savedDocs["orders/ord_f04_queued"].status.code).toBe("PLACED");
  });

  it("leaves expiry's narrow 'online' abandonment predicate unchanged", () => {
    // A pending method that is NOT "online" is not an expiry candidate — the
    // expiry worker's semantics are deliberately untouched by this slice.
    expect(
      isAbandonedUnpaidOnlineOrder(
        abandonedOnlineOrder({
          customerId: "cust_f04",
          userId: "cust_f04",
          payment: { method: "upi", status: "pending" },
          paymentMethod: "upi",
          paymentStatus: "pending",
        })
      )
    ).toBe(false);
    expect(
      isAbandonedUnpaidOnlineOrder(
        abandonedOnlineOrder({
          customerId: "cust_f04",
          userId: "cust_f04",
          payment: { method: "online", status: "pending" },
        })
      )
    ).toBe(true);
  });
});

