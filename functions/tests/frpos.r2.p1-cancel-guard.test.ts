import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";

/**
 * r2 P1 — (a) an order that is NOT cancelled can never reach the provider, and
 * (b) the POS-cancel intent is persisted INSIDE the cancellation transaction, so
 * a crash before the first post-commit claim still leaves a durable obligation.
 */
const h = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  const calls = { sideEffects: [] as any[] };
  const makeRef = (path: string, id: string): any => ({
    id,
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
      if (savedDocs[path] === undefined) throw new Error(`No doc ${path}`);
      savedDocs[path] = { ...savedDocs[path], ...data };
    }),
  });
  const mockDb: any = {
    collection: (col: string) => ({
      doc: (id: string) => makeRef(`${col}/${id}`, id),
      where: () => ({ limit: () => ({ get: async () => ({ docs: [], empty: true }) }) }),
    }),
    runTransaction: async (fn: any) =>
      fn({ get: (r: any) => r.get(), set: (r: any, d: any, o?: any) => r.set(d, o), update: (r: any, d: any) => r.update(d) }),
  };
  return { savedDocs, calls, mockDb };
});
const { savedDocs, calls, mockDb } = h;

vi.mock("firebase-admin", () => {
  const FieldValue = { serverTimestamp: () => "MOCK_TS", increment: (n: number) => n, arrayUnion: (i: any) => [i], delete: () => "MOCK_DELETE" };
  const firestoreFn: any = vi.fn(() => h.mockDb);
  firestoreFn.FieldValue = FieldValue;
  firestoreFn.Timestamp = { fromMillis: (ms: number) => ms };
  return {
    default: { firestore: firestoreFn, auth: vi.fn(), messaging: vi.fn(), initializeApp: vi.fn(), apps: [{ name: "mock" }] },
    firestore: firestoreFn, auth: vi.fn(), messaging: vi.fn(), initializeApp: vi.fn(), apps: [{ name: "mock" }],
  };
});
vi.mock("../src/modules/petpooja/client", async (importOriginal) => {
  const actual: any = await importOriginal();
  return { ...actual, isPetpoojaEnabled: () => true };
});
vi.mock("../src/modules/orders/cancelSideEffects", () => ({
  // A crash before the first claim: the post-commit helper never runs.
  applyCancelSideEffects: vi.fn(async (input: any) => {
    h.calls.sideEffects.push(input);
    throw new Error("SIMULATED CRASH before first claim");
  }),
}));
vi.mock("../src/core/errors", async (importOriginal) => {
  const actual: any = await importOriginal();
  return { ...actual, captureErrorSnapshot: vi.fn(async () => "err") };
});
vi.mock("../src/modules/notifications/fcm.service", () => ({ dispatchFCM: vi.fn(async () => true) }));

import { requestPetpoojaOrderCancel } from "../src/modules/petpooja/orderCancel";
import { bumpOrderStatus } from "../src/modules/orders/orderStatus";
import { cancelOrderAsCustomer } from "../src/modules/orders/customerCancel";

const originalFetch = globalThis.fetch;
let fetchCalls = 0;
beforeAll(() => {
  globalThis.fetch = vi.fn(async () => {
    fetchCalls++;
    return new Response(
      JSON.stringify({ success: "1", message: "ok", restID: "31z58ciw0h", clientOrderID: "x", orderID: "", status: "-1" }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as any;
});
afterAll(() => { globalThis.fetch = originalFetch; });

beforeEach(() => {
  for (const k of Object.keys(savedDocs)) delete savedDocs[k];
  fetchCalls = 0;
  calls.sideEffects.length = 0;
  savedDocs["branches/b1"] = { id: "b1", petpoojaStoreId: "31z58ciw0h" };
});

function seedOrder(id: string, code: string, extra: Record<string, any> = {}) {
  savedDocs[`orders/${id}`] = {
    id, branchId: "b1", customerId: "cust_1", userId: "cust_1",
    fulfillmentType: "delivery", paymentMethod: "online", paymentStatus: "paid",
    status: { code, label: code, kind: "in_progress", terminal: false },
    petpoojaStatus: "synced", petpoojaOrderId: "pos_1", petpoojaAcceptedNoId: true,
    ...extra,
  };
}

describe("r2 P1 — cancellation gating and durable intent", () => {
  it("an ACTIVE order never reaches the provider and records no queue state", async () => {
    seedOrder("ord_active", "PREPARING");

    const outcome = await requestPetpoojaOrderCancel({
      orderId: "ord_active", reason: "order_cancelled", requestedBy: "staff:1",
    });

    expect(fetchCalls).toBe(0);
    expect(outcome).toBe("not_cancelled");
    expect(savedDocs["orders/ord_active"].petpoojaCancelStatus).toBeUndefined();
  });

  it("staff cancel persists the intent IN the status transaction before any claim", async () => {
    seedOrder("ord_staff", "PREPARING");

    await expect(
      bumpOrderStatus({ orderId: "ord_staff", status: "cancelled", caller: { uid: "s1", role: "branch_staff", branchIds: ["b1"] } } as any),
    ).rejects.toThrow(/SIMULATED CRASH/);

    const order = savedDocs["orders/ord_staff"];
    expect(order.status.code).toBe("CANCELLED");
    expect(order.petpoojaCancelStatus).toBe("pending");
    expect(order.petpoojaCancelReasonClass).toBe("order_cancelled");
  });

  it("customer cancel persists the intent IN the status transaction before any claim", async () => {
    seedOrder("ord_cust", "PREPARING");

    await expect(cancelOrderAsCustomer({ orderId: "ord_cust", uid: "cust_1" })).resolves.toBeDefined();

    const order = savedDocs["orders/ord_cust"];
    expect(order.status.code).toBe("CANCELLED");
    expect(order.petpoojaCancelStatus).toBe("pending");
  });
});
