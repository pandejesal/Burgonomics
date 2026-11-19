import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * F24 (audit-remediation-20261117-r1) — the SERVER-OWNED customer cancel.
 *
 * Owner product decision (18 Nov): a customer may cancel while the order is
 * being prepared or earlier (non-terminal, status no later than PREPARING) and
 * only BEFORE a rider is assigned. A rider-carrying order, or one that is ready
 * / picked up / out for delivery, is refused with 409. A courier BOOKING with
 * no assigned rider is cancellable, and the server records the durable
 * provider-cancel intent through the shared side-effect helper.
 *
 * These cases pin the transactional contract only (no network): the provider
 * helper is mocked, so the assertions are about the ORDER document and the
 * exactly-once call contract.
 */

const { mockDb, savedDocs, effects } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  const effects = {
    calls: [] as Array<Record<string, any>>,
    throws: false,
    statusWrites: 0,
  };
  const makeRef = (path: string) => ({
    __path: path,
    id: path.split("/").pop()!,
    get: vi.fn(async () => ({
      exists: savedDocs[path] !== undefined,
      data: () => savedDocs[path],
    })),
    update: vi.fn(async (data: any) => {
      if (savedDocs[path] === undefined) throw new Error(`No document to update: ${path}`);
      savedDocs[path] = { ...savedDocs[path], ...data };
    }),
    set: vi.fn(async (data: any, opts?: any) => {
      savedDocs[path] = opts?.merge ? { ...(savedDocs[path] || {}), ...data } : { ...data };
    }),
  });
  const mockDb: any = {
    collection: (col: string) => ({ doc: (id: string) => makeRef(`${col}/${id}`) }),
    runTransaction: async (fn: any) =>
      fn({
        get: (ref: any) => ref.get(),
        update: (ref: any, d: any) => ref.update(d),
        set: (ref: any, d: any, o?: any) => ref.set(d, o),
      }),
  };
  return { mockDb, savedDocs, effects };
});

vi.mock("firebase-admin", () => {
  const FieldValue = {
    serverTimestamp: () => "MOCK_TIMESTAMP",
    increment: (n: number) => n,
    arrayUnion: (i: any) => i,
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

vi.mock("../src/modules/orders/cancelSideEffects", () => ({
  applyCancelSideEffects: vi.fn(async (p: any) => {
    effects.calls.push(p);
    if (effects.throws) throw new Error("provider exploded");
    return { providerCancelAttempted: true, coinsRestored: "noop" };
  }),
}));

import { cancelOrderAsCustomer } from "../src/modules/orders/customerCancel";

const OWNED = (over: Record<string, any> = {}) => ({
  customerId: "cust_a",
  userId: "cust_a",
  branchId: "b1",
  status: { code: "PLACED", label: "Order placed", kind: "upcoming", terminal: false },
  deliveryStatus: "pending",
  ...over,
});

beforeEach(() => {
  for (const k of Object.keys(savedDocs)) delete savedDocs[k];
  effects.calls.length = 0;
  effects.throws = false;
  effects.statusWrites = 0;
});

describe("F24 customerCancel — transactional ownership and cancellable state", () => {
  it("cancels an owned pre-preparing order and stamps the canonical shape", async () => {
    savedDocs["orders/ord_1"] = OWNED();
    const res = await cancelOrderAsCustomer({ orderId: "ord_1", uid: "cust_a", reason: "changed mind" });
    expect(res).toMatchObject({ orderId: "ord_1", alreadyCancelled: false });
    expect(savedDocs["orders/ord_1"].status).toMatchObject({
      code: "CANCELLED",
      kind: "cancelled",
      label: "Cancelled",
      terminal: true,
    });
    expect(savedDocs["orders/ord_1"].cancellationReason).toBe("changed mind");
    expect(effects.calls).toHaveLength(1);
    expect(effects.calls[0]).toMatchObject({ orderId: "ord_1", reason: "order_cancelled" });
  });

  it("404s an unknown order without writing", async () => {
    await expect(cancelOrderAsCustomer({ orderId: "nope", uid: "cust_a" })).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(savedDocs["orders/nope"]).toBeUndefined();
    expect(effects.calls).toHaveLength(0);
  });

  it("403s a non-owner even when the caller passes someone else's orderId", async () => {
    savedDocs["orders/ord_1"] = OWNED({ customerId: "cust_other", userId: "cust_other" });
    await expect(cancelOrderAsCustomer({ orderId: "ord_1", uid: "cust_a" })).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(savedDocs["orders/ord_1"].status.code).toBe("PLACED");
    expect(effects.calls).toHaveLength(0);
  });

  it("treats a document whose userId only matches as owned (legacy shape)", async () => {
    savedDocs["orders/ord_1"] = OWNED({ customerId: undefined, userId: "cust_a" });
    const res = await cancelOrderAsCustomer({ orderId: "ord_1", uid: "cust_a" });
    expect(res.alreadyCancelled).toBe(false);
  });

  it("409s a terminal order (no second write, no side effects)", async () => {
    savedDocs["orders/ord_1"] = OWNED({
      status: { code: "DELIVERED", kind: "completed", terminal: true },
    });
    await expect(cancelOrderAsCustomer({ orderId: "ord_1", uid: "cust_a" })).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(effects.calls).toHaveLength(0);
  });

  it("ALLOWS a cancel while the kitchen is preparing (owner window: preparing or earlier)", async () => {
    savedDocs["orders/ord_1"] = OWNED({
      status: { code: "PREPARING", label: "Preparing your order", kind: "in_progress", terminal: false },
    });
    const res = await cancelOrderAsCustomer({ orderId: "ord_1", uid: "cust_a" });
    expect(res.alreadyCancelled).toBe(false);
    expect(savedDocs["orders/ord_1"].status.code).toBe("CANCELLED");
  });

  it("ALLOWS a cancel after acceptance but before preparation (CONFIRMED)", async () => {
    savedDocs["orders/ord_1"] = OWNED({
      status: { code: "CONFIRMED", label: "Order confirmed", kind: "upcoming", terminal: false },
    });
    const res = await cancelOrderAsCustomer({ orderId: "ord_1", uid: "cust_a" });
    expect(res.alreadyCancelled).toBe(false);
  });

  it("409s once the order is READY (past the preparing window)", async () => {
    savedDocs["orders/ord_1"] = OWNED({
      status: { code: "READY_FOR_PICKUP", label: "Ready for pickup", kind: "in_progress", terminal: false },
    });
    await expect(cancelOrderAsCustomer({ orderId: "ord_1", uid: "cust_a" })).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(effects.calls).toHaveLength(0);
  });

  it("409s once a rider is ASSIGNED (deliveryStatus in_transit)", async () => {
    savedDocs["orders/ord_1"] = OWNED({
      deliveryStatus: "in_transit",
      dispatchProvider: "shadowfax",
      dispatchOrderId: "123",
      riderName: "Ravi",
      riderPhone: "+919820011224",
    });
    await expect(cancelOrderAsCustomer({ orderId: "ord_1", uid: "cust_a" })).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(effects.calls).toHaveLength(0);
    expect(savedDocs["orders/ord_1"].status.code).toBe("PLACED");
  });

  it("409s once a rider is assigned even if status still reads PREPARING", async () => {
    savedDocs["orders/ord_1"] = OWNED({
      status: { code: "PREPARING", label: "Preparing your order", kind: "in_progress", terminal: false },
      deliveryStatus: "rider_assigned",
      dispatchProvider: "borzo",
      dispatchOrderId: "BZ-1",
    });
    await expect(cancelOrderAsCustomer({ orderId: "ord_1", uid: "cust_a" })).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(effects.calls).toHaveLength(0);
  });

  it("cancels a courier BOOKING that has no assigned rider and records the cancel intent", async () => {
    // A booking exists (provider + provider order id) but no rider identity and
    // no moving delivery leg: the owner decision says this IS cancellable, and
    // the shared helper records the durable provider-cancel intent.
    savedDocs["orders/ord_1"] = OWNED({
      deliveryStatus: "pending",
      dispatchProvider: "shadowfax",
      dispatchOrderId: "SF-1",
    });
    const res = await cancelOrderAsCustomer({ orderId: "ord_1", uid: "cust_a" });
    expect(res.alreadyCancelled).toBe(false);
    expect(savedDocs["orders/ord_1"].status.code).toBe("CANCELLED");
    expect(effects.calls).toHaveLength(1);
    expect(effects.calls[0]).toMatchObject({ orderId: "ord_1", requestedBy: "customer:cust_a" });
  });

  it("is idempotent on retry: alreadyCancelled=true, no second status write", async () => {
    savedDocs["orders/ord_1"] = OWNED({
      status: { code: "CANCELLED", label: "Cancelled", kind: "cancelled", terminal: true },
    });
    const before = JSON.stringify(savedDocs["orders/ord_1"]);
    const res = await cancelOrderAsCustomer({ orderId: "ord_1", uid: "cust_a" });
    expect(res.alreadyCancelled).toBe(true);
    // The status document is untouched by the retry; only effects re-run.
    expect(JSON.stringify(savedDocs["orders/ord_1"])).toBe(before);
    expect(effects.calls).toHaveLength(1);
  });

  it("is idempotent when deliveryStatus changes between two cancel attempts", async () => {
    // First attempt: a courier BOOKING with no assigned rider is cancellable.
    savedDocs["orders/ord_1"] = OWNED({
      deliveryStatus: "pending",
      dispatchProvider: "shadowfax",
      dispatchOrderId: "SF-1",
    });
    const first = await cancelOrderAsCustomer({ orderId: "ord_1", uid: "cust_a" });
    expect(first.alreadyCancelled).toBe(false);
    expect(savedDocs["orders/ord_1"].status.code).toBe("CANCELLED");

    // The provider then pushes a late rider patch onto the already-cancelled
    // document. A retry must converge on the SAME durable provider-cancel
    // intent instead of appending a second one for the changed delivery leg,
    // and it must not write the status a second time.
    savedDocs["orders/ord_1"].deliveryStatus = "rider_assigned";

    const second = await cancelOrderAsCustomer({ orderId: "ord_1", uid: "cust_a" });
    expect(second.alreadyCancelled).toBe(true);
    expect(savedDocs["orders/ord_1"].status.code).toBe("CANCELLED");

    // One intent identity across both attempts (order + requester + reason),
    // and the helper's own idempotency (deterministic ledger key) is what
    // makes a second invocation a no-op rather than a duplicate record.
    const intents = new Set(
      effects.calls.map((c) => `${c.orderId}|${c.requestedBy}|${c.reason}`),
    );
    expect(intents.size).toBe(1);
    expect(effects.calls).toHaveLength(2);
  });

  it("re-checks ownership on the FRESH document, not a controller pre-read", async () => {
    // A document that changes owner between the fast-path read and the
    // transactional read must be refused: the transaction's snapshot is
    // authoritative, so the new owner can never cancel a stranger's order.
    savedDocs["orders/ord_1"] = OWNED();
    const res = await cancelOrderAsCustomer({ orderId: "ord_1", uid: "cust_a" });
    expect(res.alreadyCancelled).toBe(false);
    savedDocs["orders/ord_1"] = OWNED({ customerId: "cust_other", userId: "cust_other" });
    await expect(cancelOrderAsCustomer({ orderId: "ord_1", uid: "cust_a" })).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it("does not fail the cancel when the side-effect helper throws", async () => {
    savedDocs["orders/ord_1"] = OWNED();
    effects.throws = true;
    const res = await cancelOrderAsCustomer({ orderId: "ord_1", uid: "cust_a" });
    expect(res.alreadyCancelled).toBe(false);
    expect(savedDocs["orders/ord_1"].status.terminal).toBe(true);
  });

  it("accepts legacy plain-string status documents", async () => {
    savedDocs["orders/ord_1"] = OWNED({ status: "placed" });
    const res = await cancelOrderAsCustomer({ orderId: "ord_1", uid: "cust_a" });
    expect(res.alreadyCancelled).toBe(false);
  });

  it("treats a legacy plain-string terminal status as closed", async () => {
    savedDocs["orders/ord_1"] = OWNED({ status: "delivered" });
    await expect(cancelOrderAsCustomer({ orderId: "ord_1", uid: "cust_a" })).rejects.toMatchObject({
      statusCode: 409,
    });
  });
});
