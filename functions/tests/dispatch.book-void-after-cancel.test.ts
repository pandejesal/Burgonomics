import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * A8-1 (preprod audit c11, package F7) — the SECOND half of the in-flight
 * booking window: a booking that COMPLETES after the customer's cancel must not
 * bind a live rider to a cancelled order.
 *
 * The cancel side now refuses a FRESH `dispatch_pending` claim
 * (orders.customer-cancel-booking-window.test.ts). This suite pins the fence on
 * the booking side, which is what makes the window closed even when the cancel
 * and the provider POST genuinely overlap:
 *
 *   - the success write is re-checked against a FRESH snapshot, so a cancel that
 *     committed during the POST is seen and the binding is NOT written;
 *   - the now-orphaned remote booking is voided with the provider (through the
 *     same durable cancel record every other cancellation uses), so no rider
 *     drives to a cancelled order;
 *   - when the provider cannot be cancelled from here (Borzo/Porter have no
 *     cancel API) or the void call fails, staff are ALERTED through the real
 *     notification channel instead of a document field nobody reads.
 *
 * Adapters are mocked: no real courier booking, no vendor call.
 */

const { mockDb, savedDocs, state } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  const state = {
    /** Flip the order to CANCELLED just before the booking fence re-reads. */
    cancelOnFenceRead: false,
    /** Flip the order to DELIVERED just before the booking fence re-reads. */
    deliverOnFenceRead: false,
    transactionCalls: 0,
    fcmCalls: [] as any[],
    snapshots: [] as any[],
  };
  const write = (path: string, data: any, merge?: boolean) => {
    savedDocs[path] = merge ? { ...(savedDocs[path] || {}), ...data } : { ...data };
  };
  // A real DocumentSnapshot carries `.ref`; the router reads through it (claim
  // transaction, booking fence), so the shim must model that shape.
  const makeRef: any = (path: string, id: string) => {
    const ref: any = {
      id,
      __path: path,
      get: vi.fn(async () => ({
        id,
        ref,
        exists: savedDocs[path] !== undefined,
        data: () => savedDocs[path],
      })),
      set: vi.fn(async (data: any, opts?: any) => write(path, data, opts?.merge)),
      update: vi.fn(async (data: any) => {
        if (savedDocs[path] === undefined) throw new Error(`No document to update: ${path}`);
        write(path, data, true);
      }),
    };
    return ref;
  };
  const mockDb: any = {
    collection: (col: string) => ({
      doc: (id: string) => makeRef(`${col}/${id}`, id),
      where: () => ({
        limit: () => ({ get: async () => ({ empty: true, docs: [] }) }),
      }),
    }),
    runTransaction: vi.fn(async (fn: any) => {
      state.transactionCalls++;
      const tx = {
        get: async (ref: any) => {
          if (state.cancelOnFenceRead && state.transactionCalls > 1) {
            const cancelled = {
              code: "CANCELLED",
              label: "Cancelled",
              kind: "cancelled",
              terminal: true,
            };
            savedDocs["orders/ord_late_booking"] = {
              ...savedDocs["orders/ord_late_booking"],
              status: cancelled,
              completedAt: "MOCK_TIMESTAMP",
            };
          }
          if (state.deliverOnFenceRead && state.transactionCalls > 1) {
            savedDocs["orders/ord_late_delivered"] = {
              ...savedDocs["orders/ord_late_delivered"],
              status: { code: "DELIVERED", label: "Delivered", kind: "completed", terminal: true },
              deliveryStatus: "delivered",
              deliveredAt: "MOCK_TIMESTAMP",
            };
          }
          return ref.get();
        },
        set: (ref: any, data: any, opts?: any) => ref.set(data, opts),
        update: (ref: any, data: any) => ref.update(data),
      };
      return fn(tx);
    }),
  };
  return { mockDb, savedDocs, state };
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

vi.mock("../src/core/errors", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/errors")>();
  return {
    ...actual,
    captureErrorSnapshot: vi.fn(async (snap: any) => {
      state.snapshots.push(snap);
      return "err_test_snapshot";
    }),
  };
});

vi.mock("../src/modules/notifications/fcm.service", () => ({
  dispatchFCM: vi.fn(async (params: any) => {
    state.fcmCalls.push(params);
    return true;
  }),
}));

import { dispatchBook } from "../src/modules/dispatch/dispatch.router";
import { captureErrorSnapshot } from "../src/core/errors";
import { config } from "../src/config/env";

const snapshotSpy = vi.mocked(captureErrorSnapshot);

const DISPATCHED = {
  branchId: "branch_ahmedabad_1",
  store: { name: "Burgonomics CG Road", phone: "+91 98250 12345" },
  branchName: "Burgonomics CG Road",
  branchCoordinates: { lat: 23.0131, lng: 72.5085 },
  deliveryAddress: { full: "102, Shivalik Highstreet", lat: 23.0338, lng: 72.5262 },
  customerPhone: "+91 99999 88888",
  customerName: "Aarav Shah",
  status: { code: "READY_FOR_PICKUP", label: "Ready", kind: "in_progress", terminal: false },
  deliveryStatus: "pending",
};

let savedConfig: any;

beforeEach(() => {
  for (const k of Object.keys(savedDocs)) delete savedDocs[k];
  state.cancelOnFenceRead = false;
  state.deliverOnFenceRead = false;
  state.transactionCalls = 0;
  state.fcmCalls.length = 0;
  state.snapshots.length = 0;
  snapshotSpy.mockClear();

  savedConfig = { borzo: { ...config.borzo }, shadowfax: { ...config.shadowfax }, porter: { ...config.porter }, mock: { ...config.mock }, dispatch: { ...config.dispatch } };
  // Every adapter is MOCKED: this suite must never reach a provider wire.
  config.borzo.enabled = true;
  config.borzo.apiKey = "";
  config.borzo.customerId = "";
  config.borzo.webhookSecret = "";
  config.shadowfax.enabled = false;
  config.shadowfax.apiKey = "";
  config.porter.enabled = false;
  config.porter.apiKey = "";
  config.mock.borzoDispatch = true;
  config.mock.shadowfaxDispatch = false;
  config.mock.porterDispatch = false;
  config.dispatch.requireLive = false;

  savedDocs["branches/branch_ahmedabad_1"] = {
    name: "Burgonomics CG Road",
    phone: "+91 98250 12345",
    coordinates: { lat: 23.0131, lng: 72.5085 },
  };
});

afterEach(() => {
  config.borzo = savedConfig.borzo;
  config.shadowfax = savedConfig.shadowfax;
  config.porter = savedConfig.porter;
  config.mock = savedConfig.mock;
  config.dispatch = savedConfig.dispatch;
});

function seed(id: string, extra: Record<string, any> = {}) {
  savedDocs[`orders/${id}`] = { ...DISPATCHED, ...extra };
}

describe("A8-1 booking fence — a booking that completes after the cancel is voided", () => {
  it("does NOT bind the rider, records the void, and alerts staff", async () => {
    seed("ord_late_booking");
    state.cancelOnFenceRead = true;

    const outcome = await dispatchBook({ orderId: "ord_late_booking", staffName: "Ops" }).catch(
      (err) => err
    );

    // The booking succeeded remotely, but the order was cancelled while the
    // POST was in flight: the call reports that honestly instead of "dispatched".
    expect(outcome).toBeInstanceOf(Error);
    expect(outcome.code).toBe("DISPATCH_VOIDED_ORDER_CANCELLED");
    expect(outcome.statusCode).toBe(409);

    const doc = savedDocs["orders/ord_late_booking"];
    // The cancelled order was NOT resurrected by the booking.
    expect(doc.status.code).toBe("CANCELLED");
    expect(doc.deliveryStatus).toBe("pending");
    expect(doc.dispatchProvider).toBeUndefined();
    expect(doc.dispatchOrderId).toBeUndefined();
    expect(doc.needsRebook).not.toBe(true);

    // The orphaned booking is a real remote booking: staff carry the id and the
    // provider-dashboard instruction so they can call the rider off.
    expect(doc.dispatchPendingCancel).toMatchObject({
      provider: "borzo",
      reason: "order_cancelled",
      state: "manual_required",
      providerCanCancel: false,
    });
    expect(typeof doc.dispatchPendingCancel.providerOrderId).toBe("string");
    expect(doc.dispatchPendingCancel.providerOrderId.length).toBeGreaterThan(0);

    // The alert is DELIVERED through the staff notification channel, not just a
    // field: the branch topic carries the provider booking id.
    expect(state.fcmCalls).toHaveLength(1);
    expect(state.fcmCalls[0]).toMatchObject({
      topic: "branch_branch_ahmedabad_1_orders",
      purpose: "operational",
    });
    expect(String(state.fcmCalls[0].data?.providerOrderId ?? "").length).toBeGreaterThan(0);
    expect(state.fcmCalls[0].data?.type).toBe("dispatch_cancel_manual_required");

    // Durable alert trail for ops.
    const high = state.snapshots.filter((s) => s?.severity === "high");
    expect(high.length).toBeGreaterThanOrEqual(1);
    expect(String(high[0].message)).toMatch(/cancel/i);
  });

  it("leaves an ordinary successful booking untouched (no fence false positive)", async () => {
    seed("ord_ok_booking");
    const res: any = await dispatchBook({ orderId: "ord_ok_booking", staffName: "Ops" });
    expect(res.status).toBe("dispatched");
    const doc = savedDocs["orders/ord_ok_booking"];
    expect(doc.dispatchProvider).toBe("borzo");
    expect(doc.deliveryStatus).toBe("dispatched");
    expect(doc.dispatchPendingCancel).toBeUndefined();
    expect(state.fcmCalls).toHaveLength(0);
  });

  it("reports honestly when the order CLOSED (delivered) during the POST — no false toast", async () => {
    seed("ord_late_delivered");
    state.deliverOnFenceRead = true;

    const outcome = await dispatchBook({ orderId: "ord_late_delivered", staffName: "Ops" }).catch(
      (err) => err
    );

    // The booking landed on an order that closed while it was in flight: the
    // call must not answer "dispatched" for an order that is already delivered.
    expect(outcome).toBeInstanceOf(Error);
    expect(outcome.code).toBe("DISPATCH_ORDER_CLOSED_DURING_BOOKING");
    expect(outcome.statusCode).toBe(409);
    const doc = savedDocs["orders/ord_late_delivered"];
    expect(doc.deliveryStatus).toBe("delivered");
    expect(doc.dispatchProvider).toBeUndefined();
    expect(doc.dispatchOrderId).toBeUndefined();
    // A delivered order has no rider to call off and no rebook to arm.
    expect(doc.dispatchPendingCancel).toBeUndefined();
    expect(state.fcmCalls).toHaveLength(0);
  });
});
