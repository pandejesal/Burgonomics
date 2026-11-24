import { describe, it, expect, vi, beforeEach } from "vitest";

/** counter-cash-c9: handover of a CASH order is the payment event. */
const { mockDb, savedDocs } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  const ref = (col: string, id: string) => ({
    id, __path: `${col}/${id}`,
    get: vi.fn(async () => ({ exists: !!savedDocs[`${col}/${id}`], data: () => savedDocs[`${col}/${id}`] })),
    set: vi.fn(async (d: any, o?: any) => { savedDocs[`${col}/${id}`] = o?.merge ? { ...(savedDocs[`${col}/${id}`] || {}), ...d } : d; }),
    update: vi.fn(async (d: any) => { savedDocs[`${col}/${id}`] = { ...(savedDocs[`${col}/${id}`] || {}), ...d }; }),
    create: vi.fn(async (d: any) => { if (savedDocs[`${col}/${id}`]) throw new Error("exists"); savedDocs[`${col}/${id}`] = d; }),
  });
  const mockDb: any = {
    collection: (col: string) => ({ doc: (id: string) => ref(col, id) }),
    runTransaction: async (fn: any) => fn({
      get: async (r: any) => ({ exists: !!savedDocs[r.__path], data: () => savedDocs[r.__path] }),
      set: async (r: any, d: any, o?: any) => { savedDocs[r.__path] = o?.merge ? { ...(savedDocs[r.__path] || {}), ...d } : d; },
      update: async (r: any, d: any) => { savedDocs[r.__path] = { ...(savedDocs[r.__path] || {}), ...d }; },
      create: async (r: any, d: any) => { savedDocs[r.__path] = d; },
    }),
  };
  return { mockDb, savedDocs };
});
vi.mock("firebase-admin", () => {
  const FieldValue = { serverTimestamp: () => "TS", increment: (n: number) => n, arrayUnion: (i: any) => [i], delete: () => "DEL" };
  const f: any = vi.fn(() => mockDb); f.FieldValue = FieldValue;
  return { default: { firestore: f, auth: vi.fn(() => ({})), messaging: vi.fn(() => ({})), initializeApp: vi.fn(), apps: [{ name: "mock" }] }, firestore: f, auth: vi.fn(() => ({})), messaging: vi.fn(() => ({})), initializeApp: vi.fn(), apps: [{ name: "mock" }] };
});
import { bumpOrderStatus } from "../src/modules/orders/orderStatus";
import { cashDuePaiseOf, statementCashFromOrders } from "../src/modules/settlements/cashEvidence";

const staff = { uid: "staff_c9", role: "branch_staff", branchIds: ["b1"], email: "staff@c9.test" };
function seed(kind: "takeaway" | "dinein" | "walkin" | "online" | "delivery", extra: any = {}) {
  const id = `ord_${kind}`;
  savedDocs[`orders/${id}`] = {
    branchId: "b1", status: { code: "READY_FOR_PICKUP" },
    ...(kind === "walkin" ? { orderType: "takeaway", customerId: "cust_walkin", paymentMethod: "cod", paymentStatus: "pending", payment: { method: "cod", status: "pending" }, pricing: { grandTotal: 109 } } : {}),
    ...(kind === "takeaway" || kind === "dinein" ? { orderType: kind, customerId: "cust_1", paymentChannel: "cash", paymentMethod: "cod", paymentStatus: "pending", payment: { method: "cod", status: "pending" }, cashDuePaise: 10900, pricing: { grandTotal: 109 } } : {}),
    ...(kind === "online" ? { orderType: "takeaway", customerId: "cust_1", paymentChannel: "razorpay", paymentMethod: "upi", paymentStatus: "completed", pricing: { grandTotal: 109 } } : {}),
    ...(kind === "delivery" ? { customerId: "cust_1", paymentChannel: "cash", paymentMethod: "cod", cashDuePaise: 10900, pricing: { grandTotal: 109 } } : {}),
    ...extra,
  };
  return id;
}
beforeEach(() => { for (const k of Object.keys(savedDocs)) delete savedDocs[k]; });

describe("counter cash handover through bumpOrderStatus", () => {
  it("takeaway PICKED_UP records cash once with counter_handover evidence", async () => {
    const id = seed("takeaway");
    await bumpOrderStatus({ orderId: id, status: "delivered", caller: staff });
    const o = savedDocs[`orders/${id}`];
    expect(o.status.code).toBe("PICKED_UP");
    expect(o.cashCollectedPaise).toBe(10900);
    expect(o.paymentStatus).toBe("paid");
    expect(o.payment.status).toBe("completed");
    expect(o.receiptEvidence).toMatchObject({ kind: "cash", paise: 10900, source: "counter_handover", staffUid: "staff_c9" });
  });

  it("dine-in COMPLETED records the same stamp", async () => {
    const id = seed("dinein");
    await bumpOrderStatus({ orderId: id, status: "delivered", caller: staff });
    expect(savedDocs[`orders/${id}`].status.code).toBe("COMPLETED");
    expect(savedDocs[`orders/${id}`].cashCollectedPaise).toBe(10900);
    expect(savedDocs[`orders/${id}`].receiptEvidence.source).toBe("counter_handover");
  });

  it("a walk-in handover records cash once", async () => {
    const id = seed("walkin");
    await bumpOrderStatus({ orderId: id, status: "delivered", caller: staff });
    expect(savedDocs[`orders/${id}`].cashCollectedPaise).toBe(10900);
    expect(savedDocs[`orders/${id}`].receiptEvidence.source).toBe("counter_handover");
  });

  it("a replayed bump records nothing again", async () => {
    const id = seed("takeaway");
    await bumpOrderStatus({ orderId: id, status: "delivered", caller: staff });
    const after = JSON.stringify(savedDocs[`orders/${id}`]);
    await expect(bumpOrderStatus({ orderId: id, status: "delivered", caller: staff })).rejects.toBeTruthy();
    expect(JSON.stringify(savedDocs[`orders/${id}`])).toBe(after);
  });

  it("a cancelled order and an online order never record cash", async () => {
    const cancelled = seed("takeaway", { status: { code: "CANCELLED", terminal: true } });
    await expect(bumpOrderStatus({ orderId: cancelled, status: "delivered", caller: staff })).rejects.toBeTruthy();
    expect(savedDocs[`orders/${cancelled}`].cashCollectedPaise).toBeUndefined();
    const online = seed("online");
    await bumpOrderStatus({ orderId: online, status: "delivered", caller: staff });
    expect(savedDocs[`orders/${online}`].cashCollectedPaise).toBeUndefined();
  });

  it("delivery COD is unchanged by the counter handover", async () => {
    const id = seed("delivery");
    await expect(bumpOrderStatus({ orderId: id, status: "delivered", caller: staff })).rejects.toMatchObject({ code: "DELIVERY_OTP_REQUIRED" });
    expect(savedDocs[`orders/${id}`].cashCollectedPaise).toBeUndefined();
  });

  it("a statement counts cashCollectedPaise exactly once", () => {
    const o: any = { paymentChannel: "cash", status: { code: "PICKED_UP" }, cashCollectedPaise: 10900, pricing: { grandTotal: 109 } };
    expect(cashDuePaiseOf(o)).toBe(10900);
    expect(statementCashFromOrders([o]).cashCollectedPaise).toBe(10900);
  });
});
