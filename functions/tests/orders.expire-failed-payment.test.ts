import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * F3 (staging 2026-11-21, Test 3): a DECLINED online payment left the order
 * PLACED with `payment.status: "failed"` for ever. The expiry sweep only
 * treated `pending` as abandoned, so nothing ever closed it: report noise and
 * stuck rows.
 *
 * Rule pinned here: a failed online payment is an abandoned order. The sweep
 * cancels it on the same 30-minute clock and the same path as an abandoned
 * pending one — gateway-verified first (never on an unknown), then cancel with
 * `payment_not_completed`, which means no charge, the coupon slot released and
 * no KOT (the order never became kitchen-eligible).
 */

const { mockDb, savedDocs, control, snapshots } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  const snapshots: any[] = [];
  const control = {
    razorpayPayments: {} as Record<string, any>,
    failUpdateFor: null as string | null,
  };

  const mergeSet = (path: string, data: any) => {
    if (control.failUpdateFor && path === `orders/${control.failUpdateFor}`) {
      throw new Error("write unavailable");
    }
    savedDocs[path] = { ...(savedDocs[path] || {}), ...data };
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
      update: async (data: any) => {
        if (!savedDocs[path]) throw new Error(`No document to update: ${path}`);
        mergeSet(path, data);
      },
    };
    return ref;
  };

  const queryFor = (colName: string, field: string, value: any) => ({
    limit: () => ({
      get: async () => {
        const docs = Object.entries(savedDocs)
          .filter(([path]) => path.startsWith(`${colName}/`))
          .filter(([, data]) => {
            const nested = field.split(".").reduce((acc: any, key) => acc?.[key], data);
            return nested === value;
          })
          .map(([path, data]) => ({
            id: path.split("/")[1],
            data: () => ({ ...(data as any) }),
          }));
        return { empty: docs.length === 0, docs };
      },
    }),
  });

  const mockDb: any = {
    collection: (colName: string) => ({
      doc: (docId: string) => makeRef(colName, docId),
      where: (field: string, _op: string, value: any) => queryFor(colName, field, value),
    }),
    runTransaction: vi.fn(async (fn: any) =>
      fn({
        get: async (ref: any) => ({
          exists: Boolean(savedDocs[ref.path]),
          data: () => ({ ...(savedDocs[ref.path] || {}) }),
          ref,
        }),
        update: (ref: any, data: any) => mergeSet(ref.path, data),
        set: (ref: any, data: any) => mergeSet(ref.path, data),
      })
    ),
  };

  return { mockDb, savedDocs, control, snapshots };
});

vi.mock("../src/core/firebase", () => ({ db: mockDb }));

vi.mock("firebase-admin", () => {
  const FieldValue = {
    serverTimestamp: () => "MOCK_TS",
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

vi.mock("../src/modules/payments/razorpayClient", () => ({
  getRazorpayClient: () => ({
    orders: {
      fetchPayments: vi.fn(async (razorpayOrderId: string) => {
        const value = control.razorpayPayments[razorpayOrderId];
        if (value instanceof Error) throw value;
        return value ?? { items: [] };
      }),
    },
  }),
}));

vi.mock("../src/core/errors", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    captureErrorSnapshot: vi.fn(async (snapshot: any) => {
      snapshots.push(snapshot);
      return "snap_1";
    }),
  };
});

import { expireAbandonedUnpaidOrders } from "../src/modules/orders/expireUnpaidOrders";
import { isAbandonedUnpaidOnlineOrder } from "../src/modules/orders/paymentGate";

const oldIso = new Date(Date.now() - 35 * 60_000).toISOString();
const recentIso = new Date(Date.now() - 5 * 60_000).toISOString();

const declined = (id: string, over: Record<string, any> = {}) => ({
  id,
  createdAt: oldIso,
  placedAt: oldIso,
  customerId: "cust_qa",
  userId: "cust_qa",
  fulfillment: "takeaway",
  status: { code: "PLACED", label: "Order placed", kind: "upcoming", terminal: false },
  payment: { method: "online", label: "Pay Online", status: "failed" },
  ...over,
});

describe("F3 — a declined online payment is an abandoned order", () => {
  beforeEach(() => {
    for (const key of Object.keys(savedDocs)) delete savedDocs[key];
    snapshots.length = 0;
    control.razorpayPayments = {};
    control.failUpdateFor = null;
  });

  it("treats a failed online payment as abandoned (the staging shape)", () => {
    expect(isAbandonedUnpaidOnlineOrder(declined("ord_declined"))).toBe(true);
    // The pre-existing pending contract is unchanged.
    expect(
      isAbandonedUnpaidOnlineOrder(
        declined("ord_pending", { payment: { method: "online", status: "pending" } })
      )
    ).toBe(true);
    // Money that may have moved is still never abandoned.
    expect(
      isAbandonedUnpaidOnlineOrder(
        declined("ord_captured", { paymentChannel: "razorpay" })
      )
    ).toBe(false);
    expect(
      isAbandonedUnpaidOnlineOrder(
        declined("ord_authorized", { payment: { method: "online", status: "authorized" } })
      )
    ).toBe(false);
    // Cash is a different stream and is never expired here.
    expect(
      isAbandonedUnpaidOnlineOrder(
        declined("ord_cash", { payment: { method: "cod", status: "pending" } })
      )
    ).toBe(false);
  });

  it("cancels a declined order on the same 30-minute clock, with no charge", async () => {
    savedDocs["orders/ord_declined"] = declined("ord_declined");
    savedDocs["payment_intents/intent_declined"] = {
      orderId: "ord_declined",
      razorpayOrderId: "rzp_declined",
      createdAtMs: Date.now() - 35 * 60_000,
    };
    // The gateway's own record of the declined attempt: a payment that FAILED.
    control.razorpayPayments["rzp_declined"] = { items: [{ id: "pay_declined", status: "failed" }] };

    const stats = await expireAbandonedUnpaidOrders();

    expect(savedDocs["orders/ord_declined"].status).toMatchObject({
      code: "CANCELLED",
      terminal: true,
    });
    expect(savedDocs["orders/ord_declined"].cancellationReason).toBe("payment_not_completed");
    expect(stats.cancelled).toBe(1);
    // No charge was forged onto the document by the cancel.
    expect(savedDocs["orders/ord_declined"].payment.status).toBe("failed");
    expect(savedDocs["orders/ord_declined"].paymentChannel).toBeUndefined();
    expect(savedDocs["orders/ord_declined"].payment.capturedAmountPaise).toBeUndefined();
  });

  it("releases the coupon slot the declined checkout had reserved", async () => {
    savedDocs["orders/ord_declined_coupon"] = declined("ord_declined_coupon", {
      couponCode: "SAVE10",
    });
    savedDocs["payment_intents/intent_dc"] = {
      orderId: "ord_declined_coupon",
      razorpayOrderId: "rzp_dc",
    };
    control.razorpayPayments["rzp_dc"] = { items: [{ id: "pay_dc", status: "failed" }] };
    // A slot held by this order (staging Test 8's reservation shape).
    savedDocs["coupon_redemptions/ord_declined_coupon"] = {
      code: "SAVE10",
      orderId: "ord_declined_coupon",
      customerId: "cust_qa",
      discount: 22,
      status: "reserved",
      reservedAtMs: Date.now() - 40 * 60_000,
      expiresAtMs: Date.now() + 60 * 60_000,
    };
    savedDocs["coupon_stats/SAVE10"] = {
      code: "SAVE10",
      committed: 0,
      reservations: { ord_declined_coupon: { expiresAtMs: Date.now() + 60 * 60_000 } },
    };
    savedDocs["coupon_customer_usage/SAVE10__cust_qa"] = {
      code: "SAVE10",
      customerId: "cust_qa",
      committed: 0,
      reservations: { ord_declined_coupon: { expiresAtMs: Date.now() + 60 * 60_000 } },
    };

    await expireAbandonedUnpaidOrders();

    expect(savedDocs["orders/ord_declined_coupon"].status.code).toBe("CANCELLED");
    expect(savedDocs["coupon_redemptions/ord_declined_coupon"].status).toBe("released");
    expect(savedDocs["coupon_redemptions/ord_declined_coupon"].releaseReason).toBe("order_cancelled");
    // The reservation entry is removed with Firestore's delete sentinel (the
    // harness's FieldValue.delete() stands in for it), not decremented — so the
    // slot is genuinely free for the next customer.
    expect(savedDocs["coupon_stats/SAVE10"].reservations).toEqual({
      ord_declined_coupon: "MOCK_DELETE",
    });
    expect(savedDocs["coupon_customer_usage/SAVE10__cust_qa"].reservations).toEqual({
      ord_declined_coupon: "MOCK_DELETE",
    });
    expect(savedDocs["coupon_stats/SAVE10"].committed).toBe(0);
  });

  it("never rings a KOT: the declined order is not kitchen-eligible before or after", async () => {
    savedDocs["orders/ord_declined_kot"] = declined("ord_declined_kot");
    savedDocs["payment_intents/intent_dk"] = {
      orderId: "ord_declined_kot",
      razorpayOrderId: "rzp_dk",
    };
    control.razorpayPayments["rzp_dk"] = { items: [{ id: "pay_dk", status: "failed" }] };

    await expireAbandonedUnpaidOrders();

    const doc = savedDocs["orders/ord_declined_kot"];
    expect(doc.status.code).toBe("CANCELLED");
    // The only thing that admits an order to the kitchen is the server capture
    // marker; a cancel must never write it.
    expect(doc.paymentChannel).toBeUndefined();
    expect(doc.kitchenAcceptedAt).toBeUndefined();
    expect(doc.kotSentAt).toBeUndefined();
    expect(doc.petpoojaKotId).toBeUndefined();
  });

  it("still refuses to cancel when the gateway cannot be checked", async () => {
    savedDocs["orders/ord_declined_unknown"] = declined("ord_declined_unknown");
    savedDocs["payment_intents/intent_du"] = {
      orderId: "ord_declined_unknown",
      razorpayOrderId: "rzp_du",
    };
    control.razorpayPayments["rzp_du"] = new Error("gateway timeout");

    const stats = await expireAbandonedUnpaidOrders();

    expect(savedDocs["orders/ord_declined_unknown"].status.code).toBe("PLACED");
    expect(stats.skippedUnknown).toBe(1);
    expect(stats.cancelled).toBe(0);
  });

  it("still refuses to cancel a DECLINED order the gateway shows authorized", async () => {
    savedDocs["orders/ord_declined_auth"] = declined("ord_declined_auth");
    savedDocs["payment_intents/intent_da"] = {
      orderId: "ord_declined_auth",
      razorpayOrderId: "rzp_da",
    };
    // A retry on the SAME gateway order left an authorized hold.
    control.razorpayPayments["rzp_da"] = { items: [{ id: "pay_da", status: "authorized" }] };

    const stats = await expireAbandonedUnpaidOrders();

    expect(savedDocs["orders/ord_declined_auth"].status.code).toBe("PLACED");
    expect(stats.skippedAuthorized).toBe(1);
  });

  it("leaves a RECENT declined order alone until the clock is past 30 minutes", async () => {
    savedDocs["orders/ord_declined_recent"] = declined("ord_declined_recent", {
      createdAt: recentIso,
      placedAt: recentIso,
    });
    savedDocs["payment_intents/intent_dr"] = {
      orderId: "ord_declined_recent",
      razorpayOrderId: "rzp_dr",
    };
    control.razorpayPayments["rzp_dr"] = { items: [{ id: "pay_dr", status: "failed" }] };

    const stats = await expireAbandonedUnpaidOrders();

    expect(savedDocs["orders/ord_declined_recent"].status.code).toBe("PLACED");
    expect(stats.cancelled).toBe(0);
  });
});
