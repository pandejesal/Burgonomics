import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Abandoned unpaid orders (CUS-16): an online customer order that was created
 * before Razorpay opened and left alone must not stay PLACED forever. The
 * sweep cancels it after 30 minutes, but ONLY after asking the gateway — an
 * authorized/captured payment skips it, and an unreachable gateway skips it
 * too. Cancel is transactional and re-checks the fresh order, so a capture
 * landing in the same moment wins.
 */
const { mockDb, savedDocs, control, snapshots } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  const snapshots: any[] = [];
  const control = {
    razorpayPayments: {} as Record<string, any>,
    failUpdateFor: null as string | null,
    beforeTxRead: null as null | ((id: string) => void),
    queriedCollections: [] as string[],
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

  const queryFor = (colName: string, field: string, value: any) => {
    control.queriedCollections.push(`${colName}:${field}`);
    return {
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
    };
  };

  const mockDb: any = {
    collection: (colName: string) => ({
      doc: (docId: string) => makeRef(colName, docId),
      where: (field: string, _op: string, value: any) => queryFor(colName, field, value),
    }),
    runTransaction: vi.fn(async (fn: any) => {
      const id = snapshots.length; // not used; kept for deterministic ordering
      void id;
      return fn({
        get: async (ref: any) => {
          const docId = String(ref.path).split("/")[1];
          control.beforeTxRead?.(docId);
          control.beforeTxRead = null;
          return {
            exists: Boolean(savedDocs[ref.path]),
            data: () => ({ ...(savedDocs[ref.path] || {}) }),
            ref,
          };
        },
        // Firestore transaction writes throw synchronously at call time.
        update: (ref: any, data: any) => mergeSet(ref.path, data),
        set: (ref: any, data: any) => mergeSet(ref.path, data),
      });
    }),
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

const oldIso = new Date(Date.now() - 35 * 60_000).toISOString();
const recentIso = new Date(Date.now() - 5 * 60_000).toISOString();

const abandoned = (id: string, over: Record<string, any> = {}) => ({
  id,
  createdAt: oldIso,
  placedAt: oldIso,
  customerId: "cust_qa",
  userId: "cust_qa",
  fulfillment: "takeaway",
  status: { code: "PLACED", label: "Order placed", kind: "upcoming", terminal: false },
  payment: { method: "online", label: "Pay Online", status: "pending" },
  ...over,
});

describe("expireAbandonedUnpaidOrders", () => {
  beforeEach(() => {
    for (const key of Object.keys(savedDocs)) delete savedDocs[key];
    snapshots.length = 0;
    control.razorpayPayments = {};
    control.failUpdateFor = null;
    control.beforeTxRead = null;
    control.queriedCollections = [];
  });

  it("cancels a stale unpaid order with no gateway payment", async () => {
    savedDocs["orders/ord_stale"] = abandoned("ord_stale");
    savedDocs["payment_intents/intent_1"] = {
      orderId: "ord_stale",
      razorpayOrderId: "rzp_1",
      createdAtMs: Date.now() - 35 * 60_000,
    };
    control.razorpayPayments["rzp_1"] = { items: [{ id: "pay_1", status: "created" }] };

    const stats = await expireAbandonedUnpaidOrders();

    expect(savedDocs["orders/ord_stale"].status).toMatchObject({
      code: "CANCELLED",
      terminal: true,
    });
    expect(savedDocs["orders/ord_stale"].cancellationReason).toBe("payment_not_completed");
    expect(stats.cancelled).toBe(1);
  });

  it("skips an order with an authorized or captured payment and raises a snapshot", async () => {
    savedDocs["orders/ord_auth"] = abandoned("ord_auth");
    savedDocs["payment_intents/intent_a"] = {
      orderId: "ord_auth",
      razorpayOrderId: "rzp_auth",
    };
    control.razorpayPayments["rzp_auth"] = {
      items: [{ id: "pay_auth", status: "authorized" }],
    };

    const stats = await expireAbandonedUnpaidOrders();

    expect(savedDocs["orders/ord_auth"].status.code).toBe("PLACED");
    expect(stats.skippedAuthorized).toBe(1);
    expect(snapshots.some((s) => s.severity === "high")).toBe(true);
  });

  it("never cancels when the gateway is unreachable", async () => {
    savedDocs["orders/ord_unknown"] = abandoned("ord_unknown");
    savedDocs["payment_intents/intent_u"] = {
      orderId: "ord_unknown",
      razorpayOrderId: "rzp_unknown",
    };
    control.razorpayPayments["rzp_unknown"] = new Error("gateway timeout");

    const stats = await expireAbandonedUnpaidOrders();

    expect(savedDocs["orders/ord_unknown"].status.code).toBe("PLACED");
    expect(stats.skippedUnknown).toBe(1);
    expect(stats.cancelled).toBe(0);
  });

  it("does not cancel when the gateway order has no intent yet (unknown)", async () => {
    savedDocs["orders/ord_no_intent"] = abandoned("ord_no_intent");
    const stats = await expireAbandonedUnpaidOrders();
    expect(savedDocs["orders/ord_no_intent"].status.code).toBe("PLACED");
    expect(stats.skippedUnknown).toBe(1);
  });

  it("leaves recent, paid, cash and already-cancelled orders alone", async () => {
    savedDocs["orders/ord_recent"] = abandoned("ord_recent", { createdAt: recentIso });
    savedDocs["orders/ord_paid"] = abandoned("ord_paid", {
      paymentChannel: "razorpay",
      paymentStatus: "completed",
      payment: { method: "online", status: "completed" },
    });
    savedDocs["orders/ord_cash"] = abandoned("ord_cash", {
      payment: { method: "cod", status: "CASH_PENDING" },
    });
    savedDocs["orders/ord_done"] = abandoned("ord_done", {
      status: { code: "CANCELLED", label: "Cancelled", kind: "cancelled", terminal: true },
    });

    const stats = await expireAbandonedUnpaidOrders();

    expect(stats.cancelled).toBe(0);
    for (const id of ["ord_recent", "ord_paid", "ord_cash", "ord_done"]) {
      expect(savedDocs[`orders/${id}`].status.code).not.toBe(undefined);
    }
    expect(savedDocs["orders/ord_recent"].status.code).toBe("PLACED");
    expect(savedDocs["orders/ord_paid"].status.code).toBe("PLACED");
  });

  it("accepts a Timestamp-shaped createdAt", async () => {
    savedDocs["orders/ord_ts"] = abandoned("ord_ts", {
      createdAt: { toDate: () => new Date(Date.now() - 31 * 60_000) },
    });
    savedDocs["payment_intents/intent_ts"] = {
      orderId: "ord_ts",
      razorpayOrderId: "rzp_ts",
    };
    control.razorpayPayments["rzp_ts"] = { items: [] };

    await expireAbandonedUnpaidOrders();
    expect(savedDocs["orders/ord_ts"].status.code).toBe("CANCELLED");
  });

  it("lets a capture landing during the cancel win", async () => {
    savedDocs["orders/ord_race"] = abandoned("ord_race");
    savedDocs["payment_intents/intent_r"] = {
      orderId: "ord_race",
      razorpayOrderId: "rzp_race",
    };
    control.razorpayPayments["rzp_race"] = { items: [] };
    // The gateway said "no payment", then the capture webhook commits before
    // the cancel transaction reads.
    control.beforeTxRead = (id) => {
      if (id === "ord_race") {
        savedDocs["orders/ord_race"] = {
          ...savedDocs["orders/ord_race"],
          paymentChannel: "razorpay",
          paymentStatus: "completed",
          status: { code: "CONFIRMED", label: "Order confirmed", kind: "upcoming", terminal: false },
          payment: { method: "online", status: "completed" },
        };
      }
    };

    const stats = await expireAbandonedUnpaidOrders();

    expect(savedDocs["orders/ord_race"].status.code).toBe("CONFIRMED");
    expect(stats.cancelled).toBe(0);
  });

  it("does not let one failed cancel poison the batch", async () => {
    savedDocs["orders/ord_bad"] = abandoned("ord_bad");
    savedDocs["payment_intents/intent_b"] = { orderId: "ord_bad", razorpayOrderId: "rzp_b" };
    control.razorpayPayments["rzp_b"] = { items: [] };

    savedDocs["orders/ord_good"] = abandoned("ord_good");
    savedDocs["payment_intents/intent_g"] = { orderId: "ord_good", razorpayOrderId: "rzp_g" };
    control.razorpayPayments["rzp_g"] = { items: [] };

    control.failUpdateFor = "ord_bad";

    const stats = await expireAbandonedUnpaidOrders();

    expect(savedDocs["orders/ord_good"].status.code).toBe("CANCELLED");
    expect(stats.failed).toBe(1);
    expect(stats.cancelled).toBe(1);
  });
});
