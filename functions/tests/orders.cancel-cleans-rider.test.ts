import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";

/**
 * P1-E — cancelling an ORDER must cancel the live rider behind it.
 *
 * The defect: `bumpOrderStatus({ status: "cancelled" })` only flipped the order
 * status (and restored Grill Coins). The dispatch cancel then refused because
 * the order was terminal, so a Shadowfax rider kept driving to a cancelled
 * order. Borzo could never be cancelled from here at all.
 *
 * The fix under test:
 *   - the order cancel records a durable `dispatchPendingCancel` (reason
 *     `order_cancelled`) and attempts the provider cancel;
 *   - a provider failure NEVER fails the kitchen/refund flow — the record stays
 *     `pending` and the 5-minute Shadowfax tick retries it;
 *   - retries dead-letter after a bounded count with a staff-visible alert,
 *     never with a silent give-up;
 *   - Borzo (no cancel API) raises a staff-visible dashboard alert instead of
 *     pretending, and makes zero provider calls;
 *   - a terminal `cancelled` order accepts the cleanup (the same code path),
 *     while `delivered` keeps refusing like before.
 */

const { mockDb, savedDocs } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  const write = (path: string, data: any, merge?: boolean) => {
    savedDocs[path] = merge ? { ...(savedDocs[path] || {}), ...data } : data;
  };
  const makeRef = (path: string, id: string) => ({
    id,
    __path: path,
    get: vi.fn(async () => ({
      id,
      exists: savedDocs[path] !== undefined,
      data: () => savedDocs[path],
      ref: makeRef(path, id),
    })),
    set: vi.fn(async (data: any, opts?: any) => write(path, data, opts?.merge)),
    update: vi.fn(async (data: any) => {
      if (savedDocs[path] === undefined) throw new Error(`No document to update: ${path}`);
      write(path, data, true);
    }),
  });
  const matches = (doc: any, field: string, op: string, value: any) => {
    const actual = field.split(".").reduce((acc: any, k: string) => acc?.[k], doc);
    if (op === "==") return actual === value;
    if (op === "in") return Array.isArray(value) && value.includes(actual);
    return true;
  };
  const mockDb: any = {
    collection: (col: string) => ({
      doc: (id: string) => makeRef(`${col}/${id}`, id),
      where: (field: string, op: string, value: any) => ({
        limit: (n: number) => ({
          get: async () => {
            const docs = Object.keys(savedDocs)
              .filter((k) => k.startsWith(`${col}/`))
              .filter((k) => matches(savedDocs[k], field, op, value))
              .slice(0, n)
              .map((k) => {
                const id = k.slice(col.length + 1);
                return {
                  id,
                  exists: true,
                  data: () => savedDocs[k],
                  ref: makeRef(k, id),
                };
              });
            return { empty: docs.length === 0, docs };
          },
        }),
      }),
    }),
    runTransaction: vi.fn(async (fn: any) =>
      fn({
        get: (ref: any) => ref.get(),
        set: (ref: any, data: any, opts?: any) => ref.set(data, opts),
        update: (ref: any, data: any) => ref.update(data),
      })
    ),
  };
  return { mockDb, savedDocs };
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

vi.mock("../src/modules/customers/customerCoins", () => ({
  restoreRedeemedCoins: vi.fn(async () => ({ restored: 0 })),
  adjustCustomerCoins: vi.fn(async () => ({})),
}));

vi.mock("../src/core/errors", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/errors")>();
  return { ...actual, captureErrorSnapshot: vi.fn(async () => "err_test_snapshot") };
});

vi.mock("../src/modules/notifications/fcm.service", () => ({
  dispatchFCM: vi.fn(async () => undefined),
}));

import { bumpOrderStatus } from "../src/modules/orders/orderStatus";
import { dispatchCancel, dispatchBook } from "../src/modules/dispatch/dispatch.router";
import {
  retryPendingShadowfaxCancels,
  SHADOWFAX_MAX_CANCEL_ATTEMPTS,
} from "../src/modules/dispatch/shadowfax.reconcile";
import { restoreRedeemedCoins } from "../src/modules/customers/customerCoins";
import { captureErrorSnapshot } from "../src/core/errors";
import { config } from "../src/config/env";

const coinsSpy = vi.mocked(restoreRedeemedCoins);
const snapshotSpy = vi.mocked(captureErrorSnapshot);

const okJson = (data: any, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const originalFetch = globalThis.fetch;
let fetchCalls: Array<{ url: string; init: any }> = [];
let fetchHandler: ((url: string, init: any) => Response) | null = null;
let saved: any;

beforeAll(() => {
  globalThis.fetch = vi.fn(async (url: any, init: any) => {
    fetchCalls.push({ url: String(url), init });
    if (fetchHandler) return fetchHandler(String(url), init);
    return okJson({ message: "no fetch handler registered" }, 404);
  }) as any;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

beforeEach(() => {
  for (const k of Object.keys(savedDocs)) delete savedDocs[k];
  fetchCalls = [];
  fetchHandler = null;
  saved = {
    borzo: { ...config.borzo },
    shadowfax: { ...config.shadowfax },
    porter: { ...config.porter },
    mock: { ...config.mock },
    dispatch: { ...config.dispatch },
  };
  config.shadowfax.apiKey = "your_api_token";
  config.shadowfax.baseUrl = "https://hlbackend.staging.shadowfax.in";
  config.shadowfax.clientCode = "merchant001";
  config.shadowfax.webhookSecret = "";
  // The contract flag stays a GO-LIVE gate for BOOKING. Cancelling a rider
  // already on the road is cleanup, and must not be blocked by it.
  config.shadowfax.enabled = true;
  config.shadowfax.contractVerified = false;
  config.mock.shadowfaxDispatch = false;
  config.borzo.webhookSecret = "";
  config.mock.borzoDispatch = false;
  config.porter.enabled = false;
  config.mock.porterDispatch = false;
  coinsSpy.mockClear();
  snapshotSpy.mockClear();
});

afterEach(() => {
  config.borzo = { ...saved.borzo };
  config.shadowfax = { ...saved.shadowfax };
  config.porter = { ...saved.porter };
  config.mock = { ...saved.mock };
  config.dispatch = { ...saved.dispatch };
});

const caller = { uid: "staff_1", role: "branch_staff", branchIds: ["b1"] };

function seedOrder(id: string, extra: Record<string, any> = {}) {
  savedDocs[`orders/${id}`] = {
    branchId: "b1",
    fulfillmentType: "delivery",
    status: { code: "PREPARING", label: "Preparing", kind: "in_progress", terminal: false },
    deliveryStatus: "dispatched",
    ...extra,
  };
}

function seedLiveShadowfax(id: string, providerOrderId = "21030620", extra: Record<string, any> = {}) {
  seedOrder(id, {
    dispatchStatus: "dispatched",
    dispatchProvider: "shadowfax",
    dispatchOrderId: providerOrderId,
    shadowfaxOrderId: providerOrderId,
    dispatchClientOrderId: "cr_0123456789abcdef_3",
    riderName: "Amit Kumar",
    riderPhone: "919876543210",
    ...extra,
  });
}

function docOf(id: string): any {
  return savedDocs[`orders/${id}`];
}

const cancelCalls = () => fetchCalls.filter((c) => c.url.includes("/cancel/"));
const createOrderCalls = () => fetchCalls.filter((c) => c.url.includes("/create-order"));

describe("P1-E: an order cancel reaches the live rider", () => {
  it("cancels a live Shadowfax booking, and keeps the kitchen cancel green when the provider fails", async () => {
    seedLiveShadowfax("ord_p1e_sfx");
    fetchHandler = () => okJson({ detail: "internal error" }, 500);

    const res: any = await bumpOrderStatus({
      orderId: "ord_p1e_sfx",
      status: "cancelled",
      cancellationReason: "Customer called it off",
      caller,
    });

    // The order cancel itself must never fail on a provider fault.
    expect(res.status).toMatchObject({ code: "CANCELLED", terminal: true });
    expect(docOf("ord_p1e_sfx").status).toMatchObject({ code: "CANCELLED", terminal: true });
    // PAY-03 still runs: the cancel must not strand the customer's coins.
    expect(coinsSpy).toHaveBeenCalledTimes(1);

    // The remote cancel WAS attempted, against the documented endpoint.
    expect(cancelCalls()).toHaveLength(1);
    expect(cancelCalls()[0].url).toBe(
      "https://hlbackend.staging.shadowfax.in/api/v2/orders/21030620/cancel/"
    );
    expect(cancelCalls()[0].init.method).toBe("PUT");

    // Failure is durably recorded, not swallowed: retryable + staff-visible.
    const pending = docOf("ord_p1e_sfx").dispatchPendingCancel;
    expect(pending).toMatchObject({
      provider: "shadowfax",
      providerOrderId: "21030620",
      reason: "order_cancelled",
      state: "pending",
      attempts: 1,
    });
    expect(pending.lastError).toMatch(/HTTP 500/);
    expect(pending.requestedBy).toBeTruthy();
    expect(docOf("ord_p1e_sfx").dispatchCancelAlert).toMatchObject({
      code: "DISPATCH_CANCEL_PENDING",
      provider: "shadowfax",
      providerOrderId: "21030620",
    });
    // The binding stays so the webhook can still resolve this booking.
    expect(docOf("ord_p1e_sfx").dispatchOrderId).toBe("21030620");
    expect(createOrderCalls()).toHaveLength(0);
  });

  it("the 5-minute tick retries the pending cancel and records the confirmation", async () => {
    seedLiveShadowfax("ord_p1e_retry");
    fetchHandler = () => okJson({ detail: "internal error" }, 500);
    await bumpOrderStatus({ orderId: "ord_p1e_retry", status: "cancelled", caller });
    expect(docOf("ord_p1e_retry").dispatchPendingCancel.state).toBe("pending");

    fetchHandler = () => okJson({ message: "done successfully" });
    const result = await retryPendingShadowfaxCancels();

    expect(result.retriedCount).toBe(1);
    expect(cancelCalls()).toHaveLength(2);
    expect(cancelCalls()[1].url).toBe(
      "https://hlbackend.staging.shadowfax.in/api/v2/orders/21030620/cancel/"
    );
    const pending = docOf("ord_p1e_retry").dispatchPendingCancel;
    expect(pending).toMatchObject({
      state: "confirmed",
      confirmedBy: "provider_cancel",
      providerOrderId: "21030620",
    });
    expect(pending.confirmedAt).toBe("MOCK_TIMESTAMP");
    expect(docOf("ord_p1e_retry").dispatchCancelAlert).toBeNull();
    // No second rider was ever booked while cleaning up.
    expect(createOrderCalls()).toHaveLength(0);

    // A confirmed record is not re-sent by the next tick.
    const again = await retryPendingShadowfaxCancels();
    expect(again.scanned).toBe(0);
    expect(cancelCalls()).toHaveLength(2);
  });

  it("dead-letters after the bounded attempts with a staff-visible alert, never silently", async () => {
    seedLiveShadowfax("ord_p1e_dead", "21030620", {
      dispatchPendingCancel: {
        provider: "shadowfax",
        providerOrderId: "21030620",
        reason: "order_cancelled",
        state: "pending",
        providerCanCancel: true,
        requestedAt: "MOCK_TIMESTAMP",
        requestedBy: "Branch Staff",
        attempts: SHADOWFAX_MAX_CANCEL_ATTEMPTS - 1,
        lastAttemptAt: null,
        lastError: "shadowfax HTTP 503 (transient): upstream",
        confirmedAt: null,
        confirmedBy: null,
        confirmedByName: null,
        confirmedNote: null,
        staffActionRequired: null,
      },
    });
    fetchHandler = () => okJson({ detail: "upstream" }, 503);

    const result = await retryPendingShadowfaxCancels();

    expect(result.deadLetteredCount).toBe(1);
    const pending = docOf("ord_p1e_dead").dispatchPendingCancel;
    expect(pending).toMatchObject({
      state: "dead_lettered",
      attempts: SHADOWFAX_MAX_CANCEL_ATTEMPTS,
    });
    expect(pending.staffActionRequired).toMatch(/Shadowfax dashboard/i);
    expect(docOf("ord_p1e_dead").dispatchCancelAlert).toMatchObject({
      code: "DISPATCH_CANCEL_DEAD_LETTERED",
      provider: "shadowfax",
      providerOrderId: "21030620",
    });
    const high = snapshotSpy.mock.calls.filter((c: any[]) => c[0]?.severity === "high");
    expect(high.length).toBeGreaterThanOrEqual(1);

    // Dead-lettered records stop consuming the retry window but keep blocking a
    // replacement dispatch (an un-cancelled rider still owns the order).
    const next = await retryPendingShadowfaxCancels();
    expect(next.scanned).toBe(0);
  });

  it("raises a staff-visible dashboard alert for Borzo and makes zero provider calls", async () => {
    seedOrder("ord_p1e_borzo", {
      dispatchStatus: "dispatched",
      dispatchProvider: "borzo",
      dispatchOrderId: "BRZ-P1E-1",
      borzoOrderId: "BRZ-P1E-1",
      riderName: "[TEST] Borzo Rider Kiran",
    });

    const res: any = await bumpOrderStatus({
      orderId: "ord_p1e_borzo",
      status: "cancelled",
      cancellationReason: "Kitchen closed early",
      caller,
    });
    expect(res.status).toMatchObject({ code: "CANCELLED", terminal: true });

    // Borzo exposes no cancel call in our adapter: no fake traffic.
    expect(cancelCalls()).toHaveLength(0);
    expect(fetchCalls).toHaveLength(0);

    const pending = docOf("ord_p1e_borzo").dispatchPendingCancel;
    expect(pending).toMatchObject({
      provider: "borzo",
      providerOrderId: "BRZ-P1E-1",
      reason: "order_cancelled",
      state: "manual_required",
      providerCanCancel: false,
      attempts: 0,
    });
    expect(pending.staffActionRequired).toMatch(/Borzo dashboard/i);
    expect(docOf("ord_p1e_borzo").dispatchCancelAlert).toMatchObject({
      code: "DISPATCH_CANCEL_MANUAL_REQUIRED",
      provider: "borzo",
      providerOrderId: "BRZ-P1E-1",
    });
    // The rider identity stays on the order: staff need it to reconcile.
    expect(docOf("ord_p1e_borzo").riderName).toBe("[TEST] Borzo Rider Kiran");
  });

  it("makes no provider call and no cancel record when the order had no rider", async () => {
    seedOrder("ord_p1e_norider", { deliveryStatus: "ready", status: "ready" });
    await bumpOrderStatus({ orderId: "ord_p1e_norider", status: "cancelled", caller });
    expect(fetchCalls).toHaveLength(0);
    expect(docOf("ord_p1e_norider").dispatchPendingCancel).toBeUndefined();
    expect(docOf("ord_p1e_norider").dispatchCancelAlert).toBeUndefined();
  });

  it("accepts the cleanup on a terminal cancelled order, and still refuses a delivered one", async () => {
    // The order cancel already ran (and the provider call failed): staff retry
    // from the delivery queue on a TERMINAL order. That used to 409 forever.
    seedLiveShadowfax("ord_p1e_terminal", "21030620", {
      status: { code: "CANCELLED", label: "Cancelled", kind: "cancelled", terminal: true },
      dispatchPendingCancel: {
        provider: "shadowfax",
        providerOrderId: "21030620",
        reason: "order_cancelled",
        state: "pending",
        providerCanCancel: true,
        requestedAt: "MOCK_TIMESTAMP",
        requestedBy: "Branch Staff",
        attempts: 1,
        lastAttemptAt: null,
        lastError: "shadowfax HTTP 500 (transient): internal error",
        confirmedAt: null,
        confirmedBy: null,
        confirmedByName: null,
        confirmedNote: null,
        staffActionRequired: null,
      },
    });
    fetchHandler = () => okJson({ message: "done successfully" });

    const res = await dispatchCancel({ orderId: "ord_p1e_terminal", staffName: "Ops" });
    expect(res).toMatchObject({ success: true, providerCancel: "confirmed" });
    expect(cancelCalls()).toHaveLength(1);
    expect(docOf("ord_p1e_terminal").dispatchPendingCancel).toMatchObject({
      state: "confirmed",
      confirmedBy: "provider_cancel",
    });
    expect(docOf("ord_p1e_terminal").dispatchCancelAlert).toBeNull();

    // A DELIVERED order stays locked: it is a real fulfilment, not a cleanup.
    seedOrder("ord_p1e_delivered", {
      deliveryStatus: "delivered",
      status: { code: "DELIVERED", label: "Delivered", kind: "completed", terminal: true },
      dispatchStatus: "dispatched",
      dispatchProvider: "shadowfax",
      dispatchOrderId: "21030699",
      shadowfaxOrderId: "21030699",
    });
    await expect(
      dispatchCancel({ orderId: "ord_p1e_delivered", staffName: "Ops" })
    ).rejects.toMatchObject({ statusCode: 409, code: "DISPATCH_LOCKED" });
  });

  it("keeps SHADOWFAX_CONTRACT_VERIFIED a booking gate only: a live rider is still cancelled for cleanup", async () => {
    // Semantics unchanged: with the contract unverified, BOOKING fails closed.
    seedOrder("ord_p1e_gate", { deliveryStatus: "ready", customerPhone: "+91 99999 88888" });
    const book = await dispatchBook({ orderId: "ord_p1e_gate" }).catch((err) => err);
    expect(book).toBeInstanceOf(Error);
    expect(createOrderCalls()).toHaveLength(0);

    // …while the cleanup of an already-booked rider is not gated on it.
    seedLiveShadowfax("ord_p1e_gate_cleanup");
    fetchHandler = () => okJson({ message: "done successfully" });
    await bumpOrderStatus({ orderId: "ord_p1e_gate_cleanup", status: "cancelled", caller });
    expect(cancelCalls()).toHaveLength(1);
    expect(docOf("ord_p1e_gate_cleanup").dispatchPendingCancel.state).toBe("confirmed");
  });
});
