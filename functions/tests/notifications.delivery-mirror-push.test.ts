import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * A8-8 (preprod audit c11, package F7) — rider assignment and "rider at store"
 * must reach the customer.
 *
 * `onOrderStatusChangedNotificationTrigger` fires on every order update but
 * returns unless `status.code` changed. `DRIVER_ALLOCATED` / `courier_assigned`
 * / Shadowfax `ALLOTTED` write rider fields + `deliveryStatus: "dispatched"` +
 * `delivery.status: "rider_assigned"`, and `ARRIVED_AT_PICKUP` writes
 * `riderArrivedAt*` + `delivery.status: "at_pickup"`. None of them changes
 * `status.code`, so the customer heard nothing for the two updates they
 * actually watch. Only `STARTED_DELIVERY`/`DELIVERED` changed the code.
 *
 * The new handler is a DELIVERY-MIRROR transition: it fires once per real
 * transition, keeps the existing status-code gate for all other copy, and
 * dedupes so a redelivered Firestore event (or a GPS-only patch) cannot ring
 * the phone again.
 */

const { savedDocs, state, mockDb } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  const state = { multicast: [] as any[], push: [] as any[] };
  const makeRef = (path: string, id: string) => ({
    id,
    get: vi.fn(async () => ({
      exists: savedDocs[path] !== undefined,
      data: () => savedDocs[path],
    })),
    set: vi.fn(async (data: any, opts?: any) => {
      savedDocs[path] = opts?.merge ? { ...(savedDocs[path] || {}), ...data } : { ...data };
    }),
    update: vi.fn(async (data: any) => {
      savedDocs[path] = { ...(savedDocs[path] || {}), ...data };
    }),
    collection: () => ({ doc: () => ({ set: async () => undefined }) }),
  });
  const mockDb: any = {
    collection: (col: string) => ({
      doc: (id: string) => makeRef(`${col}/${id}`, id),
    }),
  };
  return { savedDocs, state, mockDb };
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

vi.mock("../src/modules/notifications/fcmClient", () => ({
  sendFcmMessage: vi.fn(async () => true),
  sendMulticastFcm: vi.fn(async (_tokens: string[], payload: any, uid: string, opts: any) => {
    state.multicast.push({ payload, uid, opts });
    return { successCount: 1, inboxPersisted: true };
  }),
  writeCustomerInboxDoc: vi.fn(async () => true),
  getUnreadCount: vi.fn(async () => 0),
  pushToCustomer: vi.fn(async (...args: any[]) => {
    state.push.push(args);
  }),
}));

vi.mock("../src/modules/petpooja/orderPush", () => ({
  pushKotForCashOrderOnAccept: vi.fn(async () => null),
  pushKotForServerCashOrderOnCreate: vi.fn(async () => true),
}));

import { handleOrderDeliveryMirrorChange, handleOrderStatusChanged } from "../src/modules/notifications/triggers";

const CUSTOMER = "cust_1";

const baseOrder = (over: Record<string, any> = {}) => ({
  id: "ord_dm_1",
  customerId: CUSTOMER,
  branchId: "branch_a",
  shortCode: "BG-77",
  status: { code: "PREPARING", label: "Preparing", kind: "in_progress", terminal: false },
  delivery: { provider: "porter", providerOrderId: "POR-1", status: "pending" },
  ...over,
});

beforeEach(() => {
  for (const k of Object.keys(savedDocs)) delete savedDocs[k];
  state.multicast.length = 0;
  state.push.length = 0;
});

describe("A8-8 rider_assigned / at_pickup customer push", () => {
  it("pushes once when the delivery mirror moves to rider_assigned (status.code unchanged)", async () => {
    const before = baseOrder();
    const after = baseOrder({
      riderName: "Ravi",
      riderPhone: "9000000001",
      deliveryStatus: "dispatched",
      delivery: {
        provider: "porter",
        providerOrderId: "POR-1",
        status: "rider_assigned",
        riderName: "Ravi",
      },
    });

    await handleOrderDeliveryMirrorChange("ord_dm_1", before, after);

    expect(state.multicast).toHaveLength(1);
    const sent = state.multicast[0];
    expect(sent.uid).toBe(CUSTOMER);
    expect(sent.opts.purpose).toBe("orderUpdates");
    expect(sent.payload.notification.title).toMatch(/rider/i);
    // PII: the rider's phone never reaches the lock screen.
    expect(sent.payload.notification.body).not.toContain("9000000001");
    expect(sent.payload.data.type).toBe("ORDER_RIDER_ASSIGNED");
    expect(sent.payload.data.orderId).toBe("ord_dm_1");
  });

  it("pushes once when the rider reaches the store (at_pickup)", async () => {
    const before = baseOrder({
      delivery: { provider: "shadowfax", providerOrderId: "21030620", status: "rider_assigned" },
    });
    const after = baseOrder({
      riderName: "Aastha Jain",
      riderArrivedAtStore: true,
      delivery: {
        provider: "shadowfax",
        providerOrderId: "21030620",
        status: "at_pickup",
        riderArrivedAt: "MOCK_TIMESTAMP",
      },
    });

    await handleOrderDeliveryMirrorChange("ord_dm_1", before, after);

    expect(state.multicast).toHaveLength(1);
    expect(state.multicast[0].payload.notification.title).toMatch(/store|pickup/i);
    expect(state.multicast[0].payload.data.type).toBe("ORDER_RIDER_AT_STORE");
  });

  it("does NOT push on a GPS-only mirror patch (same status)", async () => {
    const before = baseOrder({
      delivery: { provider: "porter", providerOrderId: "POR-1", status: "in_transit" },
    });
    const after = baseOrder({
      delivery: {
        provider: "porter",
        providerOrderId: "POR-1",
        status: "in_transit",
        riderLocation: { lat: 23.01, lng: 72.5 },
      },
    });

    await handleOrderDeliveryMirrorChange("ord_dm_1", before, after);
    expect(state.multicast).toHaveLength(0);
  });

  it("does NOT push again for the same transition (redelivered event / dedupe)", async () => {
    const before = baseOrder();
    const after = baseOrder({
      riderName: "Ravi",
      delivery: { provider: "porter", providerOrderId: "POR-1", status: "rider_assigned" },
    });

    await handleOrderDeliveryMirrorChange("ord_dm_1", before, after);
    // A Firestore redelivery re-sends before/after that differ the same way.
    await handleOrderDeliveryMirrorChange("ord_dm_1", before, after);
    expect(state.multicast).toHaveLength(1);
    expect(savedDocs["orders/ord_dm_1"].orderNotificationMirror).toBe("rider_assigned");
  });

  it("never pushes on a terminal order (delivered/cancelled)", async () => {
    const before = baseOrder({
      delivery: { provider: "porter", providerOrderId: "POR-1", status: "in_transit" },
    });
    const after = baseOrder({
      status: { code: "CANCELLED", label: "Cancelled", kind: "cancelled", terminal: true },
      delivery: { provider: "porter", providerOrderId: "POR-1", status: "rider_assigned" },
    });
    await handleOrderDeliveryMirrorChange("ord_dm_1", before, after);
    expect(state.multicast).toHaveLength(0);
  });

  it("does not swallow an unrelated status change (the existing gate still owns it)", async () => {
    // This handler is additive: a status-code change is handled by
    // handleOrderStatusChanged; the mirror handler must stay silent so the
    // customer does not get two pushes for one kitchen bump.
    const before = baseOrder();
    const after = baseOrder({
      status: { code: "OUT_FOR_DELIVERY", label: "Out", kind: "in_progress", terminal: false },
      delivery: { provider: "porter", providerOrderId: "POR-1", status: "in_transit" },
    });
    await handleOrderDeliveryMirrorChange("ord_dm_1", before, after);
    expect(state.multicast).toHaveLength(0);
  });

  it("stays silent for a single status bump handled by the status trigger (no double copy)", async () => {
    // Sanity on the pairing: the status trigger still sends exactly one push for
    // a code change, and the mirror handler sends none.
    const before = baseOrder();
    const after = baseOrder({ status: { code: "READY_FOR_PICKUP", label: "Ready", kind: "in_progress", terminal: false } });
    await handleOrderStatusChanged("ord_dm_1", before, after);
    await handleOrderDeliveryMirrorChange("ord_dm_1", before, after);
    expect(state.multicast).toHaveLength(1);
    expect(state.multicast[0].payload.data.status).toBe("READY_FOR_PICKUP");
  });
});
