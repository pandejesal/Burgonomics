import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";

/**
 * P1-D — a locally-released booking keeps OWNERSHIP until the remote
 * cancellation is confirmed.
 *
 * The defect: `dispatchCancel` on a Borzo booking sets `needsRebook` and
 * retires the binding before any remote cancellation (Borzo has no cancel API
 * in our adapter — cancellation is a dashboard step or a webhook). Pressing
 * "1-Click Rebook" straight after that booked a Shadowfax/Borzo rider while the
 * Borzo rider was still live: two riders, one order.
 *
 * The fix under test: the staff stop records a DURABLE `dispatchPendingCancel`
 * on the order (provider + provider order id + who asked + when). While that
 * record is unconfirmed (`pending` / `manual_required` / `dead_lettered`) EVERY
 * replacement dispatch is refused with 409 DISPATCH_CANCEL_UNCONFIRMED and zero
 * provider POSTs: /dispatch/book, /dispatch/rebook, and the Porter paste lane.
 * The block lifts only on a provider cancellation callback, a successful
 * provider cancel, or an explicit staff confirmation recorded with who + when.
 *
 * The sequence here is deliberately interleaved — cancel, press rebook at once
 * — because that ordering is the bug.
 */

const { mockDb, savedDocs, defaultOrder } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  const defaultOrder = () => ({
    branchId: "branch_ahmedabad_1",
    branchName: "Burgonomics CG Road",
    store: { name: "Burgonomics CG Road", phone: "+91 98250 12345" },
    branchCoordinates: { lat: 23.0131, lng: 72.5085 },
    deliveryAddress: {
      full: "102, Shivalik Highstreet, Vastrapur",
      lat: 23.0338,
      lng: 72.5262,
    },
    customerPhone: "+91 99999 88888",
    customerName: "Aarav Shah",
    status: "ready",
  });
  const mergeSet = (colName: string, docId: string, data: any) => {
    savedDocs[`${colName}/${docId}`] = {
      ...(savedDocs[`${colName}/${docId}`] || {}),
      ...data,
    };
  };
  const readDoc: any = (colName: string, docId: string) => {
    const rec = savedDocs[`${colName}/${docId}`];
    return {
      exists: !!rec,
      id: docId,
      data: () => (rec ? rec : undefined),
      ref: {
        get: vi.fn(async () => readDoc(colName, docId)),
        set: vi.fn(async (data: any) => mergeSet(colName, docId, data)),
      },
    };
  };
  const mockDb: any = {
    collection: (colName: string) => ({
      doc: (docId: string) => ({
        id: docId,
        set: vi.fn(async (data: any) => mergeSet(colName, docId, data)),
        get: vi.fn(async () => readDoc(colName, docId)),
      }),
      where: (field: string, _op: string, val: any) => ({
        limit: (n: number) => ({
          get: async () => {
            const docs = Object.keys(savedDocs)
              .filter((k) => k.startsWith(`${colName}/`))
              .map((k) => ({ id: k.slice(colName.length + 1) }))
              .filter((d) => {
                const doc = savedDocs[`${colName}/${d.id}`];
                const actual = field.split(".").reduce((acc: any, key: string) => acc?.[key], doc);
                return actual === val;
              })
              .slice(0, n)
              .map((d) => ({
                id: d.id,
                data: () => savedDocs[`${colName}/${d.id}`],
                ref: readDoc(colName, d.id).ref,
              }));
            return { empty: docs.length === 0, docs };
          },
        }),
      }),
    }),
    runTransaction: vi.fn(async (fn: any) =>
      fn({
        get: (ref: any) => ref.get(),
        set: (ref: any, data: any, opts?: any) => ref.set(data, opts),
      })
    ),
  };
  return { mockDb, savedDocs, defaultOrder };
});

vi.mock("firebase-admin", () => {
  const FieldValue = {
    serverTimestamp: () => "MOCK_TIMESTAMP",
    increment: (n: number) => n,
    arrayUnion: (item: any) => [item],
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
  return { ...actual, captureErrorSnapshot: vi.fn(async () => "err_test_snapshot") };
});

vi.mock("../src/modules/notifications/fcm.service", () => ({
  dispatchFCM: vi.fn(async () => undefined),
}));

import {
  dispatchBook,
  dispatchCancel,
  dispatchRebook,
  savePorterManualBooking,
  confirmManualDispatchCancel,
} from "../src/modules/dispatch/dispatch.router";
import { handleDispatchWebhook } from "../src/modules/dispatch/dispatch.webhooks";
import { captureErrorSnapshot } from "../src/core/errors";
import { computeHmacSha256 } from "../src/core/security";
import { config } from "../src/config/env";

const TEST_BORZO_WEBHOOK_SECRET = "test_borzo_whsec_vitest_only";

const snapshotSpy = vi.mocked(captureErrorSnapshot);

const okJson = (data: any, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const originalFetch = globalThis.fetch;
let fetchCalls: Array<{ url: string; init: any }> = [];
let fetchHandler: ((url: string) => Response) | null = null;
let saved: any = {};

beforeAll(() => {
  globalThis.fetch = vi.fn(async (url: any, init: any) => {
    fetchCalls.push({ url: String(url), init });
    if (fetchHandler) return fetchHandler(String(url));
    return okJson({ message: "no fetch handler registered" }, 404);
  }) as any;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

beforeEach(() => {
  saved = {
    borzo: { ...config.borzo },
    shadowfax: { ...config.shadowfax },
    porter: { ...config.porter },
    mock: { ...config.mock },
    dispatch: { ...config.dispatch },
  };
  // Live Borzo only: it is the carrier whose cancellation is dashboard/manual,
  // which is the exact shape of the bug. No Shadowfax key, Porter retired.
  config.borzo.enabled = true;
  config.borzo.apiKey = "k_borzo_test";
  config.borzo.customerId = "c_borzo_test";
  config.borzo.webhookSecret = TEST_BORZO_WEBHOOK_SECRET;
  config.mock.borzoDispatch = false;
  config.shadowfax.enabled = false;
  config.shadowfax.apiKey = "";
  config.shadowfax.clientCode = "";
  config.shadowfax.webhookSecret = "";
  config.shadowfax.contractVerified = false;
  config.mock.shadowfaxDispatch = false;
  config.porter.enabled = false;
  config.porter.apiKey = "";
  config.mock.porterDispatch = false;
  config.dispatch.fareConfirmDeltaInr = 1000;
  config.dispatch.requireLive = false;

  for (const k of Object.keys(savedDocs)) delete savedDocs[k];
  fetchCalls = [];
  fetchHandler = null;
  snapshotSpy.mockClear();
});

afterEach(() => {
  config.borzo = { ...saved.borzo };
  config.shadowfax = { ...saved.shadowfax };
  config.porter = { ...saved.porter };
  config.mock = { ...saved.mock };
  config.dispatch = { ...saved.dispatch };
});

function seedOrder(id: string, extra: Record<string, any> = {}) {
  savedDocs[`orders/${id}`] = { ...defaultOrder(), ...extra };
}

function docOf(id: string): any {
  return savedDocs[`orders/${id}`];
}

/** Book-time map row (survives teardown in production, so callbacks resolve). */
function seedMap(providerOrderId: string, orderId: string, provider: string) {
  savedDocs[`dispatch_order_map/${providerOrderId}`] = {
    orderId,
    provider,
    branchId: "branch_ahmedabad_1",
  };
}

/** Live Borzo wire: calculate-order then create-order with a chosen id. */
function borzoWire(providerOrderId: string) {
  fetchHandler = (url) => {
    if (url.includes("/calculate-order")) {
      return okJson({ is_successful: true, order: { payment_amount: "50.00" } });
    }
    if (url.includes("/create-order")) {
      return okJson({
        is_successful: true,
        order: {
          order_id: providerOrderId,
          points: [
            { tracking_url: `https://track.borzodelivery.com/t/${providerOrderId}` },
          ],
        },
      });
    }
    return okJson({ message: "not found" }, 404);
  };
}

const createOrderCalls = () =>
  fetchCalls.filter((c) => c.url.includes("/create-order")).length;

const borzoSig = (raw: string) => computeHmacSha256(raw, TEST_BORZO_WEBHOOK_SECRET);

const borzoWebhook = (payload: any) =>
  handleDispatchWebhook(
    "borzo",
    JSON.stringify(payload),
    borzoSig(JSON.stringify(payload)),
    payload
  );

function seedLiveBorzo(id: string, providerOrderId: string, extra: Record<string, any> = {}) {
  seedOrder(id, {
    deliveryStatus: "dispatched",
    dispatchStatus: "dispatched",
    dispatchProvider: "borzo",
    dispatchOrderId: providerOrderId,
    borzoOrderId: providerOrderId,
    riderName: "[TEST] Borzo Rider Kiran",
    riderPhone: "918880000001",
    ...extra,
  });
  seedMap(providerOrderId, id, "borzo");
}

describe("P1-D: an unconfirmed remote cancellation keeps the booking's ownership", () => {
  it("cancel Borzo, then press rebook at once: no second booking call, the block names who and why", async () => {
    borzoWire("BZ-P1D-DEAD");
    seedLiveBorzo("ord_p1d_seq", "BZ-P1D-DEAD");

    // 1. Staff stop the live Borzo booking. No provider cancel API exists, so
    //    the local release alone must NOT free the order for a new rider.
    const cancel = await dispatchCancel({ orderId: "ord_p1d_seq", staffName: "Ops Asha" });
    expect(cancel).toMatchObject({
      success: true,
      provider: "borzo",
      providerCancel: "manual-required",
    });
    expect(cancel.pendingCancel).toMatchObject({
      provider: "borzo",
      providerOrderId: "BZ-P1D-DEAD",
      state: "manual_required",
      requestedBy: "Ops Asha",
    });

    // 2. Immediately press "1-Click Rebook" (the interleaving that produced two
    //    riders). It must be refused: the Borzo rider may still be live.
    const blocked = await dispatchRebook({
      orderId: "ord_p1d_seq",
      staffName: "Ops Asha",
    }).catch((err) => err);

    expect(blocked).toMatchObject({
      statusCode: 409,
      code: "DISPATCH_CANCEL_UNCONFIRMED",
    });
    expect(blocked.pendingCancel).toMatchObject({
      provider: "borzo",
      providerOrderId: "BZ-P1D-DEAD",
      state: "manual_required",
      requestedBy: "Ops Asha",
      reason: "staff_cancelled",
    });
    expect(blocked.message).toMatch(/Borzo dashboard/i);
    expect(createOrderCalls()).toBe(0);

    // 3. The order still says "needs a rebook" (staff intent is preserved) but
    //    carries the durable record of why nothing may be booked yet.
    const doc = docOf("ord_p1d_seq");
    expect(doc.needsRebook).toBe(true);
    expect(doc.rebookTrigger).toBe("staff_cancelled");
    expect(doc.dispatchPendingCancel).toMatchObject({
      provider: "borzo",
      providerOrderId: "BZ-P1D-DEAD",
      reason: "staff_cancelled",
      state: "manual_required",
      requestedBy: "Ops Asha",
      attempts: 0,
      confirmedBy: null,
    });
    expect(doc.dispatchPendingCancel.requestedAt).toBe("MOCK_TIMESTAMP");
    expect(doc.dispatchPendingCancel.staffActionRequired).toMatch(/Borzo dashboard/i);

    // The plain /dispatch/book lane (not just /rebook) is blocked too.
    const directBook = await dispatchBook({ orderId: "ord_p1d_seq" }).catch((err) => err);
    expect(directBook).toMatchObject({ code: "DISPATCH_CANCEL_UNCONFIRMED" });
    expect(createOrderCalls()).toBe(0);
  });

  it("the provider's own cancellation callback confirms the stop, and only THEN does a rebook book exactly once", async () => {
    borzoWire("BZ-P1D-NEW");
    seedLiveBorzo("ord_p1d_hook", "BZ-P1D-DEAD");

    await dispatchCancel({ orderId: "ord_p1d_hook", staffName: "Ops Asha" });
    const blocked = await dispatchRebook({ orderId: "ord_p1d_hook" }).catch((err) => err);
    expect(blocked).toMatchObject({ code: "DISPATCH_CANCEL_UNCONFIRMED" });
    expect(createOrderCalls()).toBe(0);

    // Borzo's cancellation webhook is the documented proof the rider is gone.
    await borzoWebhook({
      delivery: {
        status: "canceled",
        order_id: "BZ-P1D-DEAD",
        reason_text: "rider unavailable, order cancelled",
      },
    });

    const afterHook = docOf("ord_p1d_hook");
    expect(afterHook.dispatchPendingCancel).toMatchObject({
      state: "confirmed",
      confirmedBy: "provider_webhook",
      providerOrderId: "BZ-P1D-DEAD",
    });
    expect(afterHook.dispatchPendingCancel.confirmedAt).toBe("MOCK_TIMESTAMP");
    // The park is still the audit trail: a released booking's callback never
    // mutates order state, it only resolves the cancellation question.
    expect(afterHook.deliveryStatus).toBe("rider_cancelled");
    expect(afterHook.dispatchProvider).toBeNull();

    const rebook = await dispatchRebook({
      orderId: "ord_p1d_hook",
      staffName: "Ops Asha",
    });
    expect(rebook).toMatchObject({
      provider: "borzo",
      providerOrderId: "BZ-P1D-NEW",
      reused: false,
    });
    expect(createOrderCalls()).toBe(1);
    expect(docOf("ord_p1d_hook").dispatchOrderId).toBe("BZ-P1D-NEW");
    expect(docOf("ord_p1d_hook").needsRebook).toBe(false);
  });

  it("an explicit staff confirmation of the dashboard cancel lifts the block and records who and when", async () => {
    borzoWire("BZ-P1D-STAFTNEW");
    seedLiveBorzo("ord_p1d_staff", "BZ-P1D-DEAD");
    await dispatchCancel({ orderId: "ord_p1d_staff", staffName: "Ops Asha" });

    // Nothing is bookable while the dashboard step is outstanding.
    expect(
      await dispatchRebook({ orderId: "ord_p1d_staff" }).catch((err) => err)
    ).toMatchObject({ code: "DISPATCH_CANCEL_UNCONFIRMED" });
    expect(createOrderCalls()).toBe(0);

    // Second press of confirm is idempotent (same staff, no second write of
    // state), so a double tap cannot break the trail.
    const confirm = await confirmManualDispatchCancel({
      orderId: "ord_p1d_staff",
      staffName: "Ops Ravi",
      note: "Cancelled BRZ-P1D-DEAD in the Borzo dashboard",
    });
    expect(confirm).toMatchObject({
      success: true,
      provider: "borzo",
      providerOrderId: "BZ-P1D-DEAD",
    });

    const doc = docOf("ord_p1d_staff");
    expect(doc.dispatchPendingCancel).toMatchObject({
      state: "confirmed",
      confirmedBy: "staff_confirmation",
      confirmedByName: "Ops Ravi",
    });
    expect(doc.dispatchPendingCancel.confirmedAt).toBe("MOCK_TIMESTAMP");
    expect(doc.dispatchPendingCancel.staffActionRequired).toBeNull();

    const again = await confirmManualDispatchCancel({
      orderId: "ord_p1d_staff",
      staffName: "Ops Ravi",
    });
    expect(again).toMatchObject({ success: true, reused: true });

    const rebook = await dispatchRebook({ orderId: "ord_p1d_staff", staffName: "Ops Ravi" });
    expect(rebook).toMatchObject({ providerOrderId: "BZ-P1D-STAFTNEW", reused: false });
    expect(createOrderCalls()).toBe(1);
  });

  it("the Porter paste lane (the manual fallback) is blocked by the same record", async () => {
    config.porter.enabled = true;
    config.porter.apiKey = "porter_key_test";
    config.porter.customerId = "porter_customer_test";
    config.mock.porterDispatch = false;

    seedLiveBorzo("ord_p1d_paste", "BZ-P1D-DEAD");
    await dispatchCancel({ orderId: "ord_p1d_paste", staffName: "Ops" });

    await expect(
      savePorterManualBooking({
        orderId: "ord_p1d_paste",
        porterOrderId: "POR-P1D-1",
        staffName: "Ops",
      })
    ).rejects.toMatchObject({ statusCode: 409, code: "DISPATCH_CANCEL_UNCONFIRMED" });

    const doc = docOf("ord_p1d_paste");
    expect(doc.porterOrderId).toBeNull();
    expect(doc.dispatchProvider).toBeNull();
    expect(savedDocs["dispatch_order_map/POR-P1D-1"]).toBeUndefined();
  });

  it("confirm refuses with a typed 409 when there is no pending cancellation on the order", async () => {
    seedOrder("ord_p1d_none", { deliveryStatus: "ready" });
    await expect(
      confirmManualDispatchCancel({ orderId: "ord_p1d_none", staffName: "Ops" })
    ).rejects.toMatchObject({ statusCode: 409, code: "DISPATCH_CANCEL_NOT_PENDING" });
  });
});
