import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";

/**
 * EVERY cancellation source reaches the POS.
 *
 * `applyCancelSideEffects` is the single funnel every cancellation commits
 * through (see modules/orders/cancelSideEffects.ts). This file proves the three
 * sources named in the fix-wave contract actually arrive there and produce ONE
 * Petpooja cancel each â€” and that an order the POS never received produces none:
 *
 *   1. the customer's own cancel (`cancelOrderAsCustomer`, F24);
 *   2. a staff cancel from the KDS (`bumpOrderStatus({status:"cancelled"})`) â€”
 *      this is also the "payment failed after the push" path in real service: a
 *      cash-on-delivery order is pushed to the POS when staff accept it, and if
 *      the customer refuses to pay at the door, staff cancel it here;
 *   3. a `payment_not_completed` cancellation (the unpaid-expiry lane calls the
 *      same `bumpOrderStatus` with `onlyIfUnpaid`, orderStatus.ts:360);
 *   4. an order with no POS history â†’ no vendor call at all.
 */

const h = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  const fcm: Array<Record<string, any>> = [];
  const snapshots: Array<Record<string, any>> = [];

  // Built INSIDE vi.hoisted: the firebase-admin factory below is hoisted to the
  // top of the file, so it cannot close over a later top-level const.
  const makeRef = (path: string, id: string): any => ({
    id,
    __path: path,
    get: vi.fn(async () => ({
      id,
      exists: savedDocs[path] !== undefined,
      data: () => savedDocs[path],
      ref: makeRef(path, id),
    })),
    set: vi.fn(async (data: any, opts?: any) => {
      savedDocs[path] = opts?.merge ? { ...(savedDocs[path] || {}), ...data } : { ...data };
    }),
    update: vi.fn(async (data: any) => {
      if (savedDocs[path] === undefined) throw new Error(`No document to update: ${path}`);
      savedDocs[path] = { ...savedDocs[path], ...data };
    }),
  });

  const mockDb: any = {
    collection: (col: string) => ({
      doc: (id: string) => makeRef(`${col}/${id}`, id),
      where: (field: string, op: string, value: any) => ({
        limit: (n: number) => ({
          get: async () => {
            const docs = Object.keys(savedDocs)
              .filter((k) => k.startsWith(`${col}/`))
              .filter((k) => {
                const actual = savedDocs[k]?.[field];
                if (op === "==") return actual === value;
                if (op === "<=") return Number(actual) <= Number(value);
                return false;
              })
              .slice(0, n)
              .map((k) => {
                const id = k.slice(col.length + 1);
                return { id, exists: true, data: () => savedDocs[k], ref: makeRef(k, id) };
              });
            return { empty: docs.length === 0, docs };
          },
        }),
      }),
    }),
    runTransaction: async (fn: any) =>
      fn({
        get: (ref: any) => ref.get(),
        set: (ref: any, data: any, opts?: any) => ref.set(data, opts),
        update: (ref: any, data: any) => ref.update(data),
      }),
  };

  return { savedDocs, fcm, snapshots, mockDb };
});

const { savedDocs, fcm, snapshots, mockDb } = h;

vi.mock("firebase-admin", () => {
  const FieldValue = {
    serverTimestamp: () => "MOCK_TIMESTAMP",
    increment: (n: number) => n,
    arrayUnion: (i: any) => [i],
    delete: () => "MOCK_DELETE",
  };
  const firestoreFn: any = vi.fn(() => h.mockDb);
  firestoreFn.FieldValue = FieldValue;
  firestoreFn.Timestamp = { fromMillis: (ms: number) => ms };
  return {
    default: { firestore: firestoreFn, auth: vi.fn(() => ({})), messaging: vi.fn(() => ({})), initializeApp: vi.fn(), apps: [{ name: "mock" }] },
    firestore: firestoreFn,
    auth: vi.fn(() => ({})),
    messaging: vi.fn(() => ({})),
    initializeApp: vi.fn(),
    apps: [{ name: "mock" }],
  };
});

vi.mock("../src/modules/customers/customerCoins", () => ({
  restoreRedeemedCoins: vi.fn(async () => ({ restored: 0 })),
  adjustCustomerCoins: vi.fn(async () => ({})),
}));

vi.mock("../src/core/errors", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    captureErrorSnapshot: vi.fn(async (s: any) => {
      snapshots.push(s);
      return "err_test";
    }),
  };
});

vi.mock("../src/modules/notifications/fcm.service", () => ({
  dispatchFCM: vi.fn(async (p: any) => {
    fcm.push(p);
    return true;
  }),
}));

vi.mock("../src/modules/petpooja/client", async (importOriginal) => {
  const actual: any = await importOriginal();
  return { ...actual, isPetpoojaEnabled: () => true };
});

import { cancelOrderAsCustomer } from "../src/modules/orders/customerCancel";
import { bumpOrderStatus } from "../src/modules/orders/orderStatus";

const originalFetch = globalThis.fetch;
let fetchCalls: Array<{ url: string; body: any }> = [];

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const SANDBOX_ACK = {
  success: "1",
  message: "Order status updated successfully.",
  restID: "31z58ciw0h",
  status: "-1",
};

beforeAll(() => {
  globalThis.fetch = vi.fn(async (url: any, init: any) => {
    fetchCalls.push({
      url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return json(SANDBOX_ACK);
  }) as any;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

beforeEach(() => {
  for (const k of Object.keys(savedDocs)) delete savedDocs[k];
  fetchCalls = [];
  fcm.length = 0;
  snapshots.length = 0;
  savedDocs["branches/b1"] = { id: "b1", petpoojaStoreId: "31z58ciw0h" };
});

const cancelCalls = () => fetchCalls.filter((c) => c.url.endsWith("/V1/update_order_status"));
const orderOf = (id: string) => savedDocs[`orders/${id}`];

const caller = { uid: "staff_1", role: "branch_staff", branchIds: ["b1"] };

function seedPushedOrder(id: string, extra: Record<string, any> = {}) {
  savedDocs[`orders/${id}`] = {
    id,
    branchId: "b1",
    customerId: "cust_1",
    fulfillmentType: "delivery",
    paymentMethod: "cod",
    paymentStatus: "pending",
    status: { code: "PREPARING", label: "Preparing", kind: "in_progress", terminal: false },
    petpoojaStatus: "accepted_unconfirmed",
    petpoojaAcceptedNoId: true,
    ...extra,
  };
}

describe("POS cancel fan-out â€” every cancellation source", () => {
  it("customer cancel (F24) cancels the order at the POS exactly once", async () => {
    seedPushedOrder("ord_cust", { customerId: "cust_1", userId: "cust_1" });

    const res = await cancelOrderAsCustomer({ orderId: "ord_cust", uid: "cust_1" });
    expect(res.status.code).toBe("CANCELLED");

    expect(cancelCalls()).toHaveLength(1);
    expect(cancelCalls()[0].body).toMatchObject({
      restID: "31z58ciw0h",
      clientorderID: "ord_cust",
      status: "-1",
    });
    expect(orderOf("ord_cust").petpoojaCancelStatus).toBe("cancelled");
  });

  it("staff cancel from the KDS cancels the order at the POS exactly once", async () => {
    seedPushedOrder("ord_staff");

    const res: any = await bumpOrderStatus({
      orderId: "ord_staff",
      status: "cancelled",
      cancellationReason: "Customer refused to pay at the door",
      caller,
    });
    expect(res.status).toMatchObject({ code: "CANCELLED", terminal: true });

    expect(cancelCalls()).toHaveLength(1);
    expect(cancelCalls()[0].body.cancelReason).toMatch(/cancellation/);
    expect(orderOf("ord_staff").petpoojaCancelStatus).toBe("cancelled");
  });

  it("a payment_not_completed cancellation reaches the POS through the same funnel", async () => {
    seedPushedOrder("ord_unpaid", { paymentStatus: "pending" });

    await bumpOrderStatus({
      orderId: "ord_unpaid",
      status: "cancelled",
      cancellationReason: "payment_not_completed",
      timelineEvent: { title: "Cancelled â€” payment not completed", actor: "system" },
      caller,
    });

    expect(cancelCalls()).toHaveLength(1);
    expect(orderOf("ord_unpaid").petpoojaCancelStatus).toBe("cancelled");
  });

  it("an order the POS never received is cancelled without any vendor call", async () => {
    seedPushedOrder("ord_local", {
      petpoojaStatus: "not_applicable",
      petpoojaAcceptedNoId: false,
    });

    await bumpOrderStatus({ orderId: "ord_local", status: "cancelled", caller });

    expect(cancelCalls()).toHaveLength(0);
    expect(orderOf("ord_local").petpoojaCancelStatus).toBe("not_pushed");
  });
});
