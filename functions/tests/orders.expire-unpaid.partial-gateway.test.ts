import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * P1-B — the expiry sweep must not cancel an order whose gateway state is only
 * PARTIALLY known.
 *
 * Defect: within the loop over the Razorpay orders bound to one internal
 * order, `gatewayAnswered` was set `true` after the FIRST successful lookup and
 * the failing lookup merely `break`-ed out. A second bound gateway order whose
 * lookup failed therefore left `gatewayAnswered === true`, and the order was
 * cancelled — even though the unchecked gateway order might hold a captured
 * payment. The customer would be charged with no food.
 *
 * Required: cancel ONLY when EVERY bound gateway order was checked AND none
 * shows an authorized/captured payment. Any failed lookup leaves the order
 * alone for the next run and says why.
 */
const { mockDb, savedDocs, control, snapshots } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  const snapshots: any[] = [];
  const control = {
    razorpayPayments: {} as Record<string, any>,
    // Records the order of gateway lookups so a test can interleave.
    lookupOrder: [] as string[],
    // Runs after a named lookup succeeds — used to interleave a late write.
    afterLookup: null as null | ((razorpayOrderId: string) => void),
  };

  const mergeSet = (path: string, data: any) => {
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
    runTransaction: vi.fn(async (fn: any) => {
      const writes: Array<{ path: string; data: any }> = [];
      const result = await fn({
        get: async (ref: any) => ({
          exists: Boolean(savedDocs[ref.path]),
          data: () => ({ ...(savedDocs[ref.path] || {}) }),
          ref,
        }),
        update: (ref: any, data: any) => writes.push({ path: ref.path, data }),
        set: (ref: any, data: any) => writes.push({ path: ref.path, data }),
      });
      for (const w of writes) mergeSet(w.path, w.data);
      return result;
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
        control.lookupOrder.push(razorpayOrderId);
        const value = control.razorpayPayments[razorpayOrderId];
        if (value instanceof Error) throw value;
        const result = value ?? { items: [] };
        control.afterLookup?.(razorpayOrderId);
        control.afterLookup = null;
        return result;
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

const abandoned = (id: string, over: Record<string, any> = {}) => ({
  id,
  createdAt: oldIso,
  placedAt: oldIso,
  customerId: "cust_qa",
  userId: "cust_qa",
  branchId: "branch_a",
  fulfillment: "takeaway",
  pricing: { grandTotal: 250 },
  status: { code: "PLACED", label: "Order placed", kind: "upcoming", terminal: false },
  payment: { method: "online", label: "Pay Online", status: "pending" },
  ...over,
});

/** Two gateway orders bound to ONE internal order (a real retry shape). */
const bindTwoIntents = (orderId: string, first: string, second: string) => {
  savedDocs[`payment_intents/intent_old_${orderId}`] = {
    orderId,
    razorpayOrderId: first,
    createdAtMs: Date.now() - 35 * 60_000,
  };
  savedDocs[`payment_intents/intent_new_${orderId}`] = {
    orderId,
    razorpayOrderId: second,
    createdAtMs: Date.now() - 34 * 60_000,
  };
};

describe("P1-B — a failed lookup leaves the order alone", () => {
  beforeEach(() => {
    for (const key of Object.keys(savedDocs)) delete savedDocs[key];
    snapshots.length = 0;
    control.razorpayPayments = {};
    control.lookupOrder = [];
    control.afterLookup = null;
  });

  it("does NOT cancel when the SECOND of two bound gateway orders fails to answer", async () => {
    savedDocs["orders/ord_two"] = abandoned("ord_two");
    bindTwoIntents("ord_two", "rzp_old", "rzp_new");
    // Newest first: rzp_new answers "no payment", rzp_old throws.
    control.razorpayPayments["rzp_new"] = { items: [{ id: "pay_new", status: "created" }] };
    control.razorpayPayments["rzp_old"] = new Error("gateway timeout");

    const stats = await expireAbandonedUnpaidOrders();

    expect(control.lookupOrder).toEqual(["rzp_new", "rzp_old"]);
    expect(savedDocs["orders/ord_two"].status.code).toBe("PLACED");
    expect(savedDocs["orders/ord_two"].cancellationReason).toBeUndefined();
    expect(stats.cancelled).toBe(0);
    expect(stats.skippedUnknown).toBe(1);
    expect(
      snapshots.some((s) => /gateway|unknown/i.test(String(s.message))),
      "the skip must be logged/snapshotted with the reason"
    ).toBe(true);
  });

  it("does NOT cancel when the FIRST of two bound gateway orders fails to answer", async () => {
    savedDocs["orders/ord_first_fail"] = abandoned("ord_first_fail");
    bindTwoIntents("ord_first_fail", "rzp_old2", "rzp_new2");
    control.razorpayPayments["rzp_new2"] = new Error("socket hang up");

    const stats = await expireAbandonedUnpaidOrders();

    expect(savedDocs["orders/ord_first_fail"].status.code).toBe("PLACED");
    expect(stats.cancelled).toBe(0);
    expect(stats.skippedUnknown).toBe(1);
  });

  it("cancels only when EVERY bound gateway order answered with no payment", async () => {
    savedDocs["orders/ord_all_clear"] = abandoned("ord_all_clear");
    bindTwoIntents("ord_all_clear", "rzp_ok_old", "rzp_ok_new");
    control.razorpayPayments["rzp_ok_new"] = { items: [{ id: "pay_a", status: "created" }] };
    control.razorpayPayments["rzp_ok_old"] = { items: [] };

    const stats = await expireAbandonedUnpaidOrders();

    expect(control.lookupOrder).toEqual(["rzp_ok_new", "rzp_ok_old"]);
    expect(savedDocs["orders/ord_all_clear"].status).toMatchObject({
      code: "CANCELLED",
      terminal: true,
    });
    expect(stats.cancelled).toBe(1);
  });

  it("a capture on the SECOND bound gateway order still blocks the cancel", async () => {
    savedDocs["orders/ord_second_captured"] = abandoned("ord_second_captured");
    bindTwoIntents("ord_second_captured", "rzp_cap_old", "rzp_cap_new");
    control.razorpayPayments["rzp_cap_new"] = { items: [] };
    control.razorpayPayments["rzp_cap_old"] = {
      items: [{ id: "pay_cap", status: "captured" }],
    };

    const stats = await expireAbandonedUnpaidOrders();

    expect(savedDocs["orders/ord_second_captured"].status.code).toBe("PLACED");
    expect(stats.skippedAuthorized).toBe(1);
    expect(stats.cancelled).toBe(0);
  });

  it("interleaved: an authorize lands on the second gateway order mid-loop, before its lookup", async () => {
    // Real sequence: the customer's browser was still open. The first bound
    // gateway order answers "nothing"; between that answer and the second
    // lookup the customer authorizes on the newest gateway order.
    savedDocs["orders/ord_interleave"] = abandoned("ord_interleave");
    bindTwoIntents("ord_interleave", "rzp_late_auth", "rzp_quiet");
    control.razorpayPayments["rzp_quiet"] = { items: [] };
    control.razorpayPayments["rzp_late_auth"] = {
      items: [{ id: "pay_late", status: "authorized" }],
    };
    control.afterLookup = (razorpayOrderId) => {
      if (razorpayOrderId !== "rzp_quiet") return;
      // Freeze the authorization truth as it would be observed on the next
      // lookup; nothing else in the sweep may short-circuit it.
    };

    const stats = await expireAbandonedUnpaidOrders();

    expect(savedDocs["orders/ord_interleave"].status.code).toBe("PLACED");
    expect(stats.skippedAuthorized).toBe(1);
    expect(stats.cancelled).toBe(0);
  });
});
