import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * A8-1 / A8-6 (preprod audit c11, package F7) — the customer cancel must be
 * FENCED against an in-flight provider booking, and must NOT mistake a booking
 * with no rider for an assigned rider.
 *
 * A8-1: `claimDispatch` writes `dispatchStatus: "dispatch_pending"` and then
 * POSTs the provider. During that POST there is no rider identity and
 * `deliveryStatus` is still the pre-booking value, so the old guard let the
 * cancel commit — the booking then wrote `deliveryStatus: "dispatched"` onto a
 * CANCELLED order with no provider-cancel intent. This suite pins the first
 * half of the fix: a FRESH claim refuses the cancel with a "booking in
 * progress" 409, while an EXPIRED lease (a crashed attempt) does not wedge the
 * customer forever — the booking-side fence voids that late booking instead.
 *
 * A8-6: `bookDispatch` writes `deliveryStatus: "dispatched"` on a successful
 * booking even when the provider allocated no rider. The old guard treated the
 * leg alone as "rider assigned" and refused the cancel. Rider identity (name
 * or phone) is the definitive signal for that leg; the moving legs
 * (`driver_allocated`, `rider_assigned`, `in_transit`) stay identity-free.
 */

const { mockDb, savedDocs, effects } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  const effects = { calls: [] as Array<Record<string, any>> };
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
    return { providerCancelAttempted: false, coinsRestored: "noop" };
  }),
}));

import { cancelOrderAsCustomer } from "../src/modules/orders/customerCancel";

const PREPARING = {
  code: "PREPARING",
  label: "Preparing your order",
  kind: "in_progress",
  terminal: false,
};

const OWNED = (over: Record<string, any> = {}) => ({
  customerId: "cust_a",
  userId: "cust_a",
  branchId: "b1",
  status: PREPARING,
  deliveryStatus: "pending",
  ...over,
});

beforeEach(() => {
  for (const k of Object.keys(savedDocs)) delete savedDocs[k];
  effects.calls.length = 0;
});

describe("A8-1 customerCancel — a FRESH booking claim fences the cancel", () => {
  it("409s while a provider booking POST is in flight (dispatchStatus dispatch_pending)", async () => {
    savedDocs["orders/ord_inflight"] = OWNED({
      dispatchStatus: "dispatch_pending",
      dispatchClaimedAt: Date.now() - 5_000,
      dispatchGeneration: 3,
      dispatchPendingCorrelation: { token: "cr_deadbeef_3", generation: 3, provider: null },
    });

    await expect(
      cancelOrderAsCustomer({ orderId: "ord_inflight", uid: "cust_a" })
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "DISPATCH_BOOKING_IN_PROGRESS",
    });

    // Nothing was cancelled: the order is untouched and no side effect ran, so
    // the booking fence (or the booking itself) still owns the outcome.
    expect(savedDocs["orders/ord_inflight"].status).toEqual(PREPARING);
    expect(savedDocs["orders/ord_inflight"].status.code).not.toBe("CANCELLED");
    expect(effects.calls).toHaveLength(0);
  });

  it("also fences Porter's own claim lane (porterDispatchStatus dispatch_pending)", async () => {
    savedDocs["orders/ord_inflight_porter"] = OWNED({
      porterDispatchStatus: "dispatch_pending",
      porterDispatchClaimedAt: Date.now() - 2_000,
    });

    await expect(
      cancelOrderAsCustomer({ orderId: "ord_inflight_porter", uid: "cust_a" })
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "DISPATCH_BOOKING_IN_PROGRESS",
    });
    expect(effects.calls).toHaveLength(0);
  });

  it("does NOT wedge the customer on an EXPIRED claim (crashed attempt): the booking fence owns it", async () => {
    savedDocs["orders/ord_expired_claim"] = OWNED({
      dispatchStatus: "dispatch_pending",
      // Older than the 10-minute lease: the attempt crashed, it is not in flight.
      dispatchClaimedAt: Date.now() - 11 * 60 * 1000,
      dispatchGeneration: 1,
    });

    const res = await cancelOrderAsCustomer({ orderId: "ord_expired_claim", uid: "cust_a" });
    expect(res.alreadyCancelled).toBe(false);
    expect(savedDocs["orders/ord_expired_claim"].status.code).toBe("CANCELLED");
    expect(effects.calls).toHaveLength(1);
  });

  it("still allows an ordinary cancel when no claim exists", async () => {
    savedDocs["orders/ord_plain"] = OWNED();
    const res = await cancelOrderAsCustomer({ orderId: "ord_plain", uid: "cust_a" });
    expect(res.alreadyCancelled).toBe(false);
  });
});

describe("A8-6 customerCancel — a booking with NO rider stays cancellable", () => {
  it("cancels a dispatched leg that carries a booking but no rider identity", async () => {
    // Exactly the shape bookDispatch writes on a successful provider booking
    // when the provider allocated nobody yet: leg "dispatched", rider fields
    // absent. The customer must not be told a partner is assigned.
    savedDocs["orders/ord_no_rider"] = OWNED({
      deliveryStatus: "dispatched",
      dispatchStatus: "dispatched",
      dispatchProvider: "shadowfax",
      dispatchOrderId: "21030620",
      riderName: "",
      riderPhone: "",
      delivery: { provider: "shadowfax", providerOrderId: "21030620", status: "pending" },
    });

    const res = await cancelOrderAsCustomer({ orderId: "ord_no_rider", uid: "cust_a" });
    expect(res.alreadyCancelled).toBe(false);
    expect(savedDocs["orders/ord_no_rider"].status.code).toBe("CANCELLED");
    // The shared side-effect helper records the durable provider-cancel intent.
    expect(effects.calls).toHaveLength(1);
    expect(effects.calls[0]).toMatchObject({ orderId: "ord_no_rider", reason: "order_cancelled" });
  });

  it("still refuses once the provider actually allocated a rider (identity present)", async () => {
    savedDocs["orders/ord_rider"] = OWNED({
      deliveryStatus: "dispatched",
      dispatchStatus: "dispatched",
      dispatchProvider: "shadowfax",
      dispatchOrderId: "21030621",
      riderName: "Aastha Jain",
      riderPhone: "+919999988888",
    });

    await expect(
      cancelOrderAsCustomer({ orderId: "ord_rider", uid: "cust_a", reason: "no longer needed" })
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(effects.calls).toHaveLength(0);
  });

  it("refuses a driver_allocated leg without identity (the rider is committed)", async () => {
    savedDocs["orders/ord_alloc"] = OWNED({
      deliveryStatus: "driver_allocated",
      dispatchProvider: "porter",
      porterOrderId: "POR-1",
    });

    await expect(
      cancelOrderAsCustomer({ orderId: "ord_alloc", uid: "cust_a" })
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(effects.calls).toHaveLength(0);
  });
});
