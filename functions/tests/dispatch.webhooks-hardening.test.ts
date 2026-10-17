import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Hardening regression tests for the Borzo/Shadowfax webhook intake
 * (audit-results/integrations-2026-10-17/audit-dispatch.md findings 3, 8, 10, 16).
 *
 * Harness is deliberately identical to `dispatch.router.test.ts` (firebase-admin
 * mocked, `handleDispatchWebhook` called directly with a real HMAC body) so the
 * two suites exercise the same fake Firestore and the same signature helper.
 */

const { mockDb, savedDocs, defaultOrder } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  const defaultOrder = () => ({
    branchId: "branch_ahmedabad_1",
    branchName: "Burgonomics CG Road",
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
  // Refreshable snapshot: ref.get() re-reads savedDocs so re-attempts observe
  // writes, exactly like Firestore.
  const readDoc: any = (colName: string, docId: string) => {
    const snap: any = {
      exists: true,
      data: () => savedDocs[`${colName}/${docId}`] || defaultOrder(),
      ref: {
        get: vi.fn(async () => readDoc(colName, docId)),
        set: vi.fn(async (data: any) => mergeSet(colName, docId, data)),
      },
    };
    return snap;
  };
  const mockDb: any = {
    collection: (colName: string) => ({
      doc: (docId: string) => ({
        id: docId,
        set: vi.fn(async (data: any) => mergeSet(colName, docId, data)),
        get: vi.fn(async () => readDoc(colName, docId)),
      }),
      where: (field: string, op: string, val: any) => ({
        limit: (n: number) => ({
          get: async () => ({ empty: true, docs: [] }),
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

// `captureErrorSnapshot` is the operator-alert boundary: a return/reattempt
// must never reach it (finding 16), while a genuinely unknown status must.
vi.mock("../src/core/errors", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/errors")>();
  return {
    ...actual,
    captureErrorSnapshot: vi.fn(async () => "err_test_snapshot"),
  };
});

import { handleDispatchWebhook } from "../src/modules/dispatch/dispatch.webhooks";
import { computeHmacSha256 } from "../src/core/security";
import { captureErrorSnapshot } from "../src/core/errors";
import { config } from "../src/config/env";

const TEST_BORZO_WEBHOOK_SECRET = "test_borzo_whsec_vitest_only";

const snapshotSpy = vi.mocked(captureErrorSnapshot);

function seedOrder(id: string, extra: Record<string, any> = {}) {
  savedDocs[`orders/${id}`] = { ...defaultOrder(), ...extra };
}

function docOf(id: string): any {
  return savedDocs[`orders/${id}`];
}

function keysWithPrefix(prefix: string): string[] {
  return Object.keys(savedDocs).filter((k) => k.startsWith(prefix));
}

const borzoSig = (rawBody: string) => computeHmacSha256(rawBody, TEST_BORZO_WEBHOOK_SECRET);

const savedConfig = {
  borzo: { ...config.borzo },
  shadowfax: { ...config.shadowfax },
};

beforeEach(() => {
  config.borzo = { ...savedConfig.borzo };
  config.borzo.webhookSecret = TEST_BORZO_WEBHOOK_SECRET;
  config.shadowfax = { ...savedConfig.shadowfax };

  for (const k of Object.keys(savedDocs)) delete savedDocs[k];
  snapshotSpy.mockClear();
});

describe("dispatch webhook hardening (findings 3, 8, 10, 16)", () => {
  it("parks re-attemptably: a parked event writes status 'parked' and self-heals on redelivery without duplicating the review row (finding 3)", async () => {
    // Order exists and is bound to BZ-HEAL-1, but the dispatch_order_map write
    // has NOT landed yet — the exact race the audit describes.
    seedOrder("ord_heal", {
      deliveryStatus: "dispatched",
      dispatchProvider: "borzo",
      dispatchOrderId: "BZ-HEAL-1",
    });

    const payload = { event: "DELIVERED", order_id: "BZ-HEAL-1", timestamp: Date.now() };
    const raw = JSON.stringify(payload);

    await handleDispatchWebhook("borzo", raw, borzoSig(raw), payload);

    // No resolution possible yet → parked, order untouched.
    expect(docOf("ord_heal").deliveryStatus).toBe("dispatched");
    expect(docOf("ord_heal").dispatchWebhookEvent).toBeUndefined();

    const parkKeys = keysWithPrefix("unmatched_dispatch_events/");
    expect(parkKeys).toHaveLength(1);
    expect(savedDocs[parkKeys[0]]).toMatchObject({
      reason: "no_matching_order",
      status: "needs_review",
    });

    // The dedup doc must record the PARK, not `processed` — otherwise the
    // identical redelivery below is dropped forever and the event never heals.
    const dedupKey = `dispatch_webhook_events/dwe_borzo_DELIVERED_BZ-HEAL-1_`;
    const dedupKeys = keysWithPrefix(dedupKey);
    expect(dedupKeys).toHaveLength(1);
    expect(savedDocs[dedupKeys[0]]).toMatchObject({
      status: "parked",
      parkReason: "no_matching_order",
    });

    // The map write lands; Borzo redelivers the byte-identical body.
    savedDocs["dispatch_order_map/BZ-HEAL-1"] = { orderId: "ord_heal", provider: "borzo" };
    await handleDispatchWebhook("borzo", raw, borzoSig(raw), payload);

    // Re-attempted (not dedup-skipped) and now resolved.
    expect(docOf("ord_heal").deliveryStatus).toBe("delivered");
    expect(savedDocs[dedupKeys[0]].status).toBe("processed");
    // The review row is idempotent — one row, never one per redelivery.
    expect(keysWithPrefix("unmatched_dispatch_events/")).toHaveLength(1);
  });

  it("parks a hint for an order with no dispatch binding (unbound_order) and never flips its state (finding 8)", async () => {
    seedOrder("ord_unbound", { deliveryStatus: "ready" });

    // No dispatch_order_map entry for the attacker-chosen providerOrderId, so
    // resolution falls to the hint (client_order_id/COID-shaped) path.
    const payload = {
      event: "DELIVERED",
      order_id: "BZ-UNBOUND-1",
      merchant_order_id: "ord_unbound",
      timestamp: Date.now(),
    };
    const raw = JSON.stringify(payload);

    await handleDispatchWebhook("borzo", raw, borzoSig(raw), payload);

    const doc = docOf("ord_unbound");
    expect(doc.deliveryStatus).toBe("ready"); // never resolved, never flipped
    expect(doc.dispatchWebhookEvent).toBeUndefined();
    expect(doc.status).toBe("ready");

    const parkKeys = keysWithPrefix("unmatched_dispatch_events/");
    expect(parkKeys).toHaveLength(1);
    expect(savedDocs[parkKeys[0]]).toMatchObject({ reason: "unbound_order" });

    const dedupKeys = keysWithPrefix("dispatch_webhook_events/dwe_borzo_DELIVERED_BZ-UNBOUND-1_");
    expect(dedupKeys).toHaveLength(1);
    expect(savedDocs[dedupKeys[0]]).toMatchObject({ status: "parked", parkReason: "unbound_order" });
  });

  it("ignores a late non-DELIVERED callback on a cancelled order (no resurrection to dispatched) (finding 10)", async () => {
    seedOrder("ord_cancel", {
      deliveryStatus: "cancelled",
      dispatchProvider: "borzo",
      dispatchOrderId: "BZ-CAN-1",
      status: { code: "CANCELLED", label: "Cancelled", kind: "cancelled", terminal: true },
    });
    savedDocs["dispatch_order_map/BZ-CAN-1"] = { orderId: "ord_cancel", provider: "borzo" };

    const payload = {
      event_datetime: new Date().toISOString(),
      event_type: "delivery_changed",
      delivery: {
        order_id: "BZ-CAN-1",
        status: "courier_assigned",
        client_order_id: "ord_cancel",
        courier: { name: "Amit", phone: "918880000001" },
      },
    };
    const raw = JSON.stringify(payload);
    await handleDispatchWebhook("borzo", raw, borzoSig(raw), payload);

    const doc = docOf("ord_cancel");
    expect(doc.deliveryStatus).toBe("cancelled"); // never rewound
    expect(doc.status).toMatchObject({ code: "CANCELLED", terminal: true });
    expect(doc.riderName).toBeUndefined(); // no rider identity written onto a cancelled order
    expect(keysWithPrefix("unmatched_dispatch_events/")).toHaveLength(0);
  });

  it("records a return_*/reattempt_* lifecycle status without raising an error snapshot (finding 16)", async () => {
    seedOrder("ord_ret", {
      deliveryStatus: "in_transit",
      dispatchProvider: "borzo",
      dispatchOrderId: "BZ-RET-1",
    });
    savedDocs["dispatch_order_map/BZ-RET-1"] = { orderId: "ord_ret", provider: "borzo" };

    for (const status of ["return_in_transit", "reattempt_scheduled"]) {
      const payload = { event: status, order_id: "BZ-RET-1", timestamp: Date.now() };
      const raw = JSON.stringify(payload);
      await handleDispatchWebhook("borzo", raw, borzoSig(raw), payload);
    }

    // Still traceable — one review row per distinct raw body.
    const parkKeys = keysWithPrefix("unmatched_dispatch_events/");
    expect(parkKeys).toHaveLength(2);
    for (const key of parkKeys) {
      expect(savedDocs[key]).toMatchObject({ reason: "unmapped_lifecycle_status" });
    }
    // ...but a documented normal-flow status is NOT an operator alert.
    expect(snapshotSpy).not.toHaveBeenCalled();
    expect(docOf("ord_ret").deliveryStatus).toBe("in_transit"); // untouched
  });

  it("still raises an error snapshot for a genuinely unknown event (control for the finding-16 assertion)", async () => {
    seedOrder("ord_ctl", { deliveryStatus: "in_transit" });
    savedDocs["dispatch_order_map/BZ-CTL-1"] = { orderId: "ord_ctl", provider: "borzo" };

    const payload = { event: "TELEPORTED", order_id: "BZ-CTL-1", timestamp: Date.now() };
    const raw = JSON.stringify(payload);
    await handleDispatchWebhook("borzo", raw, borzoSig(raw), payload);

    expect(keysWithPrefix("unmatched_dispatch_events/")).toHaveLength(1);
    expect(snapshotSpy).toHaveBeenCalledTimes(1);
  });

  it("ignores a late DELIVERED callback on a cancelled order (no cancelled -> delivered) (review on 39efc40)", async () => {
    seedOrder("ord_cancel_del", {
      deliveryStatus: "cancelled",
      dispatchProvider: "borzo",
      dispatchOrderId: "BZ-CAN-DEL-1",
      status: { code: "CANCELLED", label: "Cancelled", kind: "cancelled", terminal: true },
    });
    savedDocs["dispatch_order_map/BZ-CAN-DEL-1"] = { orderId: "ord_cancel_del", provider: "borzo" };

    const payload = { event: "DELIVERED", order_id: "BZ-CAN-DEL-1", timestamp: Date.now() };
    const raw = JSON.stringify(payload);
    await handleDispatchWebhook("borzo", raw, borzoSig(raw), payload);

    // DELIVERED is exempt from the guard only as a re-confirm of an
    // ALREADY-delivered order. A cancelled delivery must never become a paid
    // delivery through a late callback.
    const doc = docOf("ord_cancel_del");
    expect(doc.deliveryStatus).toBe("cancelled");
    expect(doc.dispatchWebhookEvent).toBeUndefined();
    expect(doc.riderName).toBeUndefined();
    expect(keysWithPrefix("unmatched_dispatch_events/")).toHaveLength(0);
  });

  it("does not re-alert on a redelivery of an already-parked event (review on 39efc40)", async () => {
    seedOrder("ord_realert", { deliveryStatus: "dispatched", dispatchProvider: "borzo" });

    // No map row and no binding hint -> parks as `no_matching_order`.
    const payload = { event: "DELIVERED", order_id: "BZ-NOALERT-1", timestamp: Date.now() };
    const raw = JSON.stringify(payload);

    await handleDispatchWebhook("borzo", raw, borzoSig(raw), payload);
    expect(snapshotSpy).toHaveBeenCalledTimes(1); // a first park is a real alert
    const parkKeys = keysWithPrefix("unmatched_dispatch_events/");
    expect(parkKeys).toHaveLength(1);

    // The provider retries the byte-identical body: re-attempted (finding 3) but
    // the operator is not alerted twice, and the review row stays single.
    await handleDispatchWebhook("borzo", raw, borzoSig(raw), payload);
    expect(snapshotSpy).toHaveBeenCalledTimes(1);
    expect(keysWithPrefix("unmatched_dispatch_events/")).toHaveLength(1);
  });

  it("dedups a reserialized redelivery of the same event, but not different content (finding 15)", async () => {
    seedOrder("ord_reser", { deliveryStatus: "dispatched", dispatchProvider: "borzo" });

    // No map row and no binding hint -> parks as `no_matching_order`.
    const ts = Date.now();
    const payload = { event: "DELIVERED", order_id: "BZ-RESER-1", timestamp: ts };
    const rawA = JSON.stringify(payload);
    // The same event with the same values, reserialized: different key order.
    const rawB = `{"timestamp":${ts},"order_id":"BZ-RESER-1","event":"DELIVERED"}`;
    expect(rawB).not.toBe(rawA); // the bytes really do differ

    await handleDispatchWebhook("borzo", rawA, borzoSig(rawA), payload);
    expect(keysWithPrefix("unmatched_dispatch_events/")).toHaveLength(1);
    expect(snapshotSpy).toHaveBeenCalledTimes(1);

    await handleDispatchWebhook("borzo", rawB, borzoSig(rawB), payload);
    // One canonical dedup id -> one review row and one alert, not a second of each.
    // (Pre-fix the raw-byte hash made this a brand-new event.)
    expect(keysWithPrefix("unmatched_dispatch_events/")).toHaveLength(1);
    expect(snapshotSpy).toHaveBeenCalledTimes(1);

    // Content that genuinely differs is still a distinct event: canonicalising
    // must not merge real changes away. `courier` is inert here (it affects
    // neither the event name nor the provider order id).
    const payloadC = { ...payload, courier: { name: "Amit", phone: "918880000001" } };
    const rawC = JSON.stringify(payloadC);
    await handleDispatchWebhook("borzo", rawC, borzoSig(rawC), payloadC);
    expect(keysWithPrefix("unmatched_dispatch_events/")).toHaveLength(2);
  });
});
