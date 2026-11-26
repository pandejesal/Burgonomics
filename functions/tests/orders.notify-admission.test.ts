import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A2 #2 (preprod audit cycle 11): an unpaid online checkout draft must NOT ring
 * the kitchen and must NOT tell the customer "Order Confirmed!".
 *
 * The order doc is created BEFORE Razorpay opens, so at creation time an online
 * order proves nothing about money. Admission is the same predicate the rest of
 * the system uses (`requiresServerCaptureForKitchen`): a server cash marker or
 * the walk-in counter stream is admitted at creation; an online order only once
 * a capture wrote `paymentChannel: "razorpay"`.
 *
 * These tests drive the REAL trigger handler and the REAL status-change handler.
 */
const h = vi.hoisted(() => {
  const docs = new Map<string, any>();
  const copy = (value: any) => (value === undefined ? undefined : structuredClone(value));
  const apply = (path: string, data: any, merge?: boolean) => {
    if (merge && docs.get(path) && typeof docs.get(path) === "object") {
      docs.set(path, { ...docs.get(path), ...copy(data) });
    } else {
      docs.set(path, copy(data));
    }
  };
  const ref = (collection: string, id: string) => {
    const path = `${collection}/${id}`;
    const self: any = {
      id,
      path,
      get: async () => ({ exists: docs.has(path), id, ref: self, data: () => copy(docs.get(path)) }),
      set: async (data: any, options?: { merge?: boolean }) => apply(path, data, options?.merge),
      create: async (data: any) => {
        if (docs.has(path)) throw new Error(`already exists: ${path}`);
        apply(path, data, false);
      },
      delete: async () => {
        docs.delete(path);
      },
      update: async (data: any) => apply(path, data, true),
    };
    return self;
  };
  const db: any = {
    collection: (name: string) => ({
      doc: (id: string) => ref(name, id),
      where: () => ({ limit: () => ({ get: async () => ({ empty: true, docs: [] }) }) }),
    }),
    getAll: async (...refs: any[]) => refs.map((r) => ({ exists: docs.has(r.path), data: () => copy(docs.get(r.path)) })),
    runTransaction: async (callback: (tx: any) => Promise<any>) => {
      const pending: Array<() => void> = [];
      const result = await callback({
        get: async (reference: any) => reference.get(),
        set: (reference: any, data: any, options?: { merge?: boolean }) =>
          pending.push(() => apply(reference.path, data, options?.merge)),
        create: (reference: any, data: any) =>
          pending.push(() => {
            if (docs.has(reference.path)) throw new Error(`already exists: ${reference.path}`);
            apply(reference.path, data, false);
          }),
        delete: (reference: any) => pending.push(() => docs.delete(reference.path)),
        update: (reference: any, data: any) => pending.push(() => apply(reference.path, data, true)),
      });
      for (const write of pending) write();
      return result;
    },
  };
  return { docs, db, reset: () => docs.clear() };
});

vi.mock("../src/core/firebase", () => ({ db: h.db, auth: {}, messaging: {} }));
vi.mock("firebase-admin", () => {
  const firestore: any = vi.fn(() => h.db);
  firestore.FieldValue = {
    serverTimestamp: () => "SERVER_TS",
    increment: (n: number) => n,
    arrayUnion: (item: any) => [item],
    delete: () => "DELETE",
  };
  return {
    default: { firestore, auth: vi.fn(() => ({})), messaging: vi.fn(() => ({})), initializeApp: vi.fn(), apps: [{ name: "mock" }] },
    firestore, auth: vi.fn(() => ({})), messaging: vi.fn(() => ({})), initializeApp: vi.fn(), apps: [{ name: "mock" }],
  };
});

const sends = vi.hoisted(() => ({ staff: [] as any[], customer: [] as any[] }));

vi.mock("../src/modules/notifications/fcmClient", () => ({
  sendFcmMessage: vi.fn(async (message: any) => {
    sends.staff.push(message);
    return true;
  }),
  sendMulticastFcm: vi.fn(async (tokens: string[], payload: any, uid?: string) => {
    sends.customer.push({ tokens, payload, uid });
    return { successCount: tokens.length, failureCount: 0, prunedTokens: [] };
  }),
  writeCustomerInboxDoc: vi.fn(async () => true),
  getUnreadCount: vi.fn(async () => 0),
  pushToCustomer: vi.fn(async () => undefined),
}));

vi.mock("../src/modules/petpooja/orderPush", () => ({
  pushKotForServerCashOrderOnCreate: vi.fn(async () => null),
  pushKotForCashOrderOnAccept: vi.fn(async () => null),
  pushOrderToPetpooja: vi.fn(async () => true),
  isCashOrPayAtStoreOrder: vi.fn(() => false),
  isCashKotAcceptTransition: vi.fn(() => false),
  isServerAuthorisedCashOrder: vi.fn(() => false),
}));

vi.mock("../src/core/errors", async (importOriginal) => {
  const actual: any = await importOriginal();
  return { ...actual, captureErrorSnapshot: vi.fn(async () => "snap") };
});

import { onOrderCreatedNotificationTrigger, handleOrderStatusChanged } from "../src/modules/notifications/triggers";

const PLACED = { code: "PLACED", label: "Order placed", kind: "upcoming", terminal: false };
const CONFIRMED = { code: "CONFIRMED", label: "Order confirmed", kind: "upcoming", terminal: false };

const onlineDraft = (over: Record<string, any> = {}) => ({
  id: "ord_draft_1",
  orderId: "ord_draft_1",
  shortCode: "BG-DRAFT1",
  branchId: "branch_a",
  customerId: "cust_online",
  userId: "cust_online",
  fulfillment: "delivery",
  status: PLACED,
  paymentMethod: "online",
  paymentStatus: "pending",
  payment: { method: "online", label: "Pay Online", status: "pending" },
  totals: { grandTotal: 450 },
  pricing: { grandTotal: 450 },
  ...over,
});

const cashOrder = (over: Record<string, any> = {}) => ({
  id: "ord_cash_1",
  orderId: "ord_cash_1",
  shortCode: "BG-CASH01",
  branchId: "branch_a",
  customerId: "cust_cash",
  userId: "cust_cash",
  fulfillment: "takeaway",
  status: PLACED,
  paymentMethod: "cod",
  paymentStatus: "pending",
  payment: { method: "cod", label: "Pay at Store", status: "pending" },
  paymentChannel: "cash",
  cashDuePaise: 45000,
  totals: { grandTotal: 450 },
  pricing: { grandTotal: 450 },
  ...over,
});

/** Drive the REAL creation trigger with a Firestore-shaped snapshot. */
async function runCreateTrigger(order: any) {
  await (onOrderCreatedNotificationTrigger as any).run({
    data: { data: () => order },
    params: { orderId: order.orderId },
  });
}

beforeEach(() => {
  h.reset();
  sends.staff.length = 0;
  sends.customer.length = 0;
  h.docs.set("users/cust_online", { fcmTokens: ["tok_online"] });
  h.docs.set("users/cust_cash", { fcmTokens: ["tok_cash"] });
});

describe("kitchen + customer admission at order creation (A2 #2)", () => {
  it("an unpaid online draft rings no kitchen chime and sends no confirmation", async () => {
    await runCreateTrigger(onlineDraft());

    expect(sends.staff).toHaveLength(0);
    expect(sends.customer).toHaveLength(0);
  });

  it("does not chime a draft whose payment failed, because no capture ever landed", async () => {
    await runCreateTrigger(onlineDraft({ payment: { method: "online", status: "failed" }, paymentStatus: "failed" }));

    expect(sends.staff).toHaveLength(0);
    expect(sends.customer).toHaveLength(0);
  });

  it("chimes the kitchen and confirms the customer for a server cash order, exactly once", async () => {
    const order = cashOrder();
    await runCreateTrigger(order);
    await runCreateTrigger(order); // a retried delivery of the same create event

    expect(sends.staff).toHaveLength(1);
    expect(sends.staff[0].notification.title).toBe("New KOT received");
    expect(sends.customer).toHaveLength(1);
    expect(sends.customer[0].payload.notification.title).toContain("Order Confirmed");
    expect(sends.customer[0].uid).toBe("cust_cash");
  });

  it("never confirms a customer account for a walk-in counter order", async () => {
    await runCreateTrigger(
      cashOrder({
        id: "walkin_1",
        orderId: "walkin_1",
        customerId: "cust_walkin",
        userId: "cust_walkin",
        paymentStatus: "pending",
      })
    );

    expect(sends.staff).toHaveLength(1);
    expect(sends.customer).toHaveLength(0);
    expect(h.docs.has("users/cust_walkin/notifications")).toBe(false);
  });
});

describe("online order confirmation on capture (A2 #2)", () => {
  it("chimes the kitchen and confirms the customer on capture, exactly once", async () => {
    const before = onlineDraft();
    const after = {
      ...before,
      status: CONFIRMED,
      paymentStatus: "completed",
      paymentChannel: "razorpay",
      payment: { method: "online", status: "completed", razorpayPaymentId: "pay_1", capturedAmountPaise: 45000 },
    };

    await handleOrderStatusChanged("ord_draft_1", before, after);
    await handleOrderStatusChanged("ord_draft_1", before, after); // replayed event

    expect(sends.staff).toHaveLength(1);
    expect(sends.staff[0].notification.title).toBe("New KOT received");
    expect(sends.customer).toHaveLength(1);
    expect(sends.customer[0].payload.notification.title).toContain("Order Confirmed");
  });

  it("does not ring a second chime for an ordinary later status bump", async () => {
    const confirmed = {
      ...onlineDraft(),
      status: CONFIRMED,
      paymentStatus: "completed",
      paymentChannel: "razorpay",
      payment: { method: "online", status: "completed", capturedAmountPaise: 45000 },
    };
    const preparing = { ...confirmed, status: { code: "PREPARING", label: "Preparing", kind: "in_progress", terminal: false } };

    await handleOrderStatusChanged("ord_draft_1", confirmed, preparing);

    expect(sends.staff).toHaveLength(0);
    expect(sends.customer).toHaveLength(1);
    expect(sends.customer[0].payload.notification.title).toContain("Burgers on the Grill");
  });
});
