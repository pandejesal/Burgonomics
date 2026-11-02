import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Server } from "http";
import type { AddressInfo } from "net";

/**
 * P1-D follow-up — the IN-HOUSE assignment lane must obey the same
 * `dispatchPendingCancel` ownership rule as /dispatch/book, /dispatch/rebook
 * and the Porter paste lane.
 *
 * The defect (review of 1ebb596): a Borzo local cancel nulls the active ids and
 * sets needsRebook, so `manualBranchDispatch` saw a free order and assigned an
 * in-house rider while the Borzo rider was still live — two riders, one order.
 * The router guard never covered POST /orders/manualDispatch.
 *
 * This suite drives the REAL Express app and the REAL routes:
 *   POST /dispatch/cancel          (Borzo local release, unproven remotely)
 *   POST /orders/manualDispatch    (the in-house lane)
 *   POST /dispatch/cancel/confirm  (staff confirms the dashboard cancel)
 *
 * Sequence: cancel Borzo -> manual dispatch REFUSED with
 * DISPATCH_CANCEL_UNCONFIRMED and no rider write -> confirm -> manual dispatch
 * succeeds. Interleaved on purpose: the immediate assignment is the bug.
 */

vi.hoisted(() => {
  process.env.BURGONOMICS_ENV = "dev";
  process.env.APP_CHECK_ENFORCEMENT = "";
});

const h = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  const writeCalls: Array<{ path: string; data: any }> = [];
  const verifyIdToken = vi.fn(async (token: string) => {
    if (token !== "staff-token") throw new Error("invalid token");
    return {
      uid: "staff_guard_1",
      role: "branch_staff",
      branchIds: ["branch_guard_1"],
      email: "ops.guard@burgonomics.test",
    };
  });

  const mergeSet = (path: string, data: any, merge: boolean | undefined) => {
    savedDocs[path] = merge && savedDocs[path] ? { ...savedDocs[path], ...data } : { ...data };
  };

  const docRef = (colName: string, docId: string): any => {
    const path = `${colName}/${docId}`;
    const ref: any = {
      id: docId,
      path,
      get: async () => ({
        exists: Object.prototype.hasOwnProperty.call(savedDocs, path),
        id: docId,
        data: () => savedDocs[path],
        ref,
      }),
      set: async (data: any, opts?: any) => {
        writeCalls.push({ path, data });
        mergeSet(path, data, opts?.merge);
      },
      update: async (data: any) => {
        writeCalls.push({ path, data });
        mergeSet(path, data, true);
      },
    };
    return ref;
  };

  const emptyQuery: any = {
    where: () => emptyQuery,
    orderBy: () => emptyQuery,
    limit: () => emptyQuery,
    startAfter: () => emptyQuery,
    get: async () => ({ empty: true, docs: [] }),
  };

  const mockDb: any = {
    collection: (colName: string) => ({
      ...emptyQuery,
      doc: (docId?: string) => docRef(colName, docId as string),
    }),
    getAll: async (...refs: any[]) => Promise.all(refs.map((r: any) => r.get())),
    runTransaction: async (fn: any) =>
      fn({
        get: (ref: any) => ref.get(),
        set: (ref: any, data: any, opts?: any) => ref.set(data, opts),
        update: (ref: any, data: any) => ref.update(data),
      }),
  };

  return { savedDocs, writeCalls, verifyIdToken, mockDb };
});

vi.mock("../src/core/firebase", () => ({
  db: h.mockDb,
  auth: { verifyIdToken: h.verifyIdToken },
  messaging: { send: vi.fn(async () => "msg"), sendEachForMulticast: vi.fn(async () => ({})) },
}));

vi.mock("firebase-admin", () => {
  const FieldValue = {
    serverTimestamp: () => "MOCK_TIMESTAMP",
    increment: (n: number) => n,
    arrayUnion: (value: unknown) => ({ union: value }),
    arrayRemove: (...values: unknown[]) => ({ remove: values }),
    delete: () => "MOCK_DELETE",
  };
  const firestoreFn: any = vi.fn(() => h.mockDb);
  firestoreFn.FieldValue = FieldValue;
  return {
    default: {
      firestore: firestoreFn,
      auth: vi.fn(() => ({ verifyIdToken: h.verifyIdToken })),
      messaging: vi.fn(() => ({ send: vi.fn(async () => "msg") })),
      appCheck: vi.fn(() => ({ verifyToken: vi.fn(async () => ({})) })),
      initializeApp: vi.fn(),
      apps: [{ name: "mock" }],
    },
    firestore: firestoreFn,
    auth: vi.fn(() => ({ verifyIdToken: h.verifyIdToken })),
    messaging: vi.fn(() => ({ send: vi.fn(async () => "msg") })),
    appCheck: vi.fn(() => ({ verifyToken: vi.fn(async () => ({})) })),
    initializeApp: vi.fn(),
    apps: [{ name: "mock" }],
  };
});

vi.mock("../src/modules/notifications/fcm.service", () => ({
  dispatchFCM: vi.fn(async () => true),
}));

import { app } from "../src/index";
import { config } from "../src/config/env";

const ORDER_ID = "ord_guard_inhouse";
const BORZO_BOOKING = "BZ-GUARD-77";

let server: Server;
let baseUrl: string;
let fetchSpy: any;

function seedLiveBorzoOrder(over: Record<string, any> = {}) {
  h.savedDocs[`orders/${ORDER_ID}`] = {
    id: ORDER_ID,
    branchId: "branch_guard_1",
    branchName: "Burgonomics Guard Road",
    store: { name: "Burgonomics Guard Road", phone: "+91 98250 12345" },
    branchCoordinates: { lat: 23.0131, lng: 72.5085 },
    deliveryAddress: { full: "12, Guard Residency", lat: 23.0338, lng: 72.5262 },
    customerName: "Guard Customer",
    customerPhone: "+91 99999 77777",
    fulfillment: "delivery",
    paymentMethod: "cod",
    status: { code: "CONFIRMED", label: "Confirmed", kind: "upcoming", terminal: false },
    deliveryStatus: "dispatched",
    dispatchStatus: "dispatched",
    dispatchProvider: "borzo",
    dispatchOrderId: BORZO_BOOKING,
    borzoOrderId: BORZO_BOOKING,
    riderName: "Borzo Rider Kiran",
    riderPhone: "918880000001",
    ...over,
  };
}

function post(path: string, body: Record<string, any>) {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer staff-token" },
    body: JSON.stringify(body),
  });
}

const BODY_MANUAL = {
  orderId: ORDER_ID,
  riderName: "Vikram In-House",
  riderPhone: "+91 98980 12345",
  staffName: "Ops Guard",
};

/** Calls that left the process toward a courier provider (never the test app). */
const providerCalls = () =>
  fetchSpy.mock.calls.filter(
    (call: any[]) => !String(call[0]).startsWith("http://127.0.0.1:")
  ).length;

beforeAll(async () => {
  const prev = {
    borzo: { ...config.borzo },
    shadowfax: { ...config.shadowfax },
    porter: { ...config.porter },
    mock: { ...config.mock },
    dispatch: { ...config.dispatch },
  };
  // Live Borzo only: it is the carrier with no cancel API in our adapter, the
  // exact shape that produced two riders.
  config.borzo.enabled = true;
  config.borzo.apiKey = "k_borzo_guard";
  config.borzo.customerId = "c_borzo_guard";
  config.mock.borzoDispatch = false;
  config.shadowfax.enabled = false;
  config.shadowfax.apiKey = "";
  config.shadowfax.clientCode = "";
  config.shadowfax.contractVerified = false;
  config.mock.shadowfaxDispatch = false;
  config.porter.enabled = false;
  config.porter.apiKey = "";
  config.mock.porterDispatch = false;
  config.dispatch.requireLive = false;

  // Provider calls are forbidden; the suite's own HTTP calls to the real app on
  // 127.0.0.1 must still work, so they are forwarded to the real implementation
  // and counted separately.
  const realFetch = globalThis.fetch;
  fetchSpy = vi.fn(async (url: any, init?: any) => {
    const target = String(url);
    if (target.startsWith("http://127.0.0.1:")) return realFetch(url, init);
    throw new Error(`no provider network in this suite (${target})`);
  });
  vi.stubGlobal("fetch", fetchSpy);

  server = app.listen(0);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // restore config after the suite (server close happens in afterAll below)
  (globalThis as any).__restoreGuardConfig = () => {
    config.borzo = prev.borzo;
    config.shadowfax = prev.shadowfax;
    config.porter = prev.porter;
    config.mock = prev.mock;
    config.dispatch = prev.dispatch;
  };
});

afterAll(async () => {
  vi.unstubAllGlobals();
  (globalThis as any).__restoreGuardConfig?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  for (const key of Object.keys(h.savedDocs)) delete h.savedDocs[key];
  h.writeCalls.length = 0;
  h.verifyIdToken.mockClear();
  seedLiveBorzoOrder();
});

describe("POST /orders/manualDispatch obeys an unconfirmed remote cancellation", () => {
  it("cancel Borzo, then assign in-house at once: refused, no rider written; after staff confirmation it succeeds", async () => {
    // 1. Staff stop the live Borzo booking (local release only — no Borzo
    //    cancel API exists in our adapter).
    const cancelRes = await post("/dispatch/cancel", {
      orderId: ORDER_ID,
      staffName: "Ops Guard",
    });
    expect(cancelRes.status).toBe(200);
    const cancelBody: any = await cancelRes.json();
    expect(cancelBody).toMatchObject({
      success: true,
      provider: "borzo",
      providerCancel: "manual-required",
    });
    expect(cancelBody.pendingCancel).toMatchObject({
      provider: "borzo",
      providerOrderId: BORZO_BOOKING,
      state: "manual_required",
    });
    expect(h.savedDocs[`orders/${ORDER_ID}`].dispatchPendingCancel.state).toBe("manual_required");

    // 2. Immediately assign an in-house rider — the interleaving that produced
    //    two riders. It must be refused with the machine-readable code.
    const blockedRes = await post("/orders/manualDispatch", BODY_MANUAL);
    expect(blockedRes.status).toBe(409);
    const blocked: any = await blockedRes.json();
    expect(blocked.code).toBe("DISPATCH_CANCEL_UNCONFIRMED");
    expect(String(blocked.error)).toMatch(/Borzo/i);

    // 3. Nothing was assigned: no in-house ownership marker, no rider overwrite.
    const afterBlocked = h.savedDocs[`orders/${ORDER_ID}`];
    expect(afterBlocked.dispatchType).toBeUndefined();
    expect(afterBlocked.riderName).toBe("Borzo Rider Kiran");
    expect(afterBlocked.riderPhone).toBe("918880000001");
    expect(afterBlocked.deliveryStatus).toBe("rider_cancelled");
    expect(blocked.pendingCancel).toMatchObject({
      provider: "borzo",
      providerOrderId: BORZO_BOOKING,
      state: "manual_required",
    });

    // 4. Staff confirm the cancellation in the Borzo dashboard. Only then may a
    //    replacement rider be assigned.
    const confirmRes = await post("/dispatch/cancel/confirm", {
      orderId: ORDER_ID,
      staffName: "Ops Guard",
      note: "Cancelled in Borzo dashboard",
    });
    expect(confirmRes.status).toBe(200);
    expect(h.savedDocs[`orders/${ORDER_ID}`].dispatchPendingCancel).toMatchObject({
      state: "confirmed",
      confirmedBy: "staff_confirmation",
      confirmedByName: "Ops Guard",
    });

    const assignRes = await post("/orders/manualDispatch", BODY_MANUAL);
    expect(assignRes.status).toBe(200);
    const assigned: any = await assignRes.json();
    expect(assigned).toMatchObject({
      success: true,
      orderId: ORDER_ID,
      dispatchType: "manual_branch_terminal",
      deliveryStatus: "dispatched",
      riderName: "Vikram In-House",
    });

    const finalDoc = h.savedDocs[`orders/${ORDER_ID}`];
    expect(finalDoc.dispatchType).toBe("manual_branch_terminal");
    expect(finalDoc.riderName).toBe("Vikram In-House");
    expect(finalDoc.deliveryStatus).toBe("dispatched");
    expect(finalDoc.needsRebook).toBe(false);
    // No provider was contacted by the in-house lane, ever.
    expect(providerCalls()).toBe(0);
  });
});
