import { describe, it, expect, vi, beforeEach, afterAll, beforeAll } from "vitest";

/**
 * Torn-down dispatch bindings must stop "owning" the order (lane 04, run
 * 2026-10-23-free; residual follow-up disclosed with d3f3728).
 *
 * The webhook ownership proof (d3f3728) trusts the order's CURRENT
 * `dispatchProvider` / `dispatchOrderId`. Two teardown paths used to leave
 * those fields pointing at a booking the system had already released:
 *   - `releaseClaimFailed()` (rebook attempt failed after a carrier/staff
 *     teardown), and
 *   - `dispatchCancel()` (staff cancel = LOCAL release; Borzo/Shadowfax have
 *     no documented cancel API, so staff cancel in the provider dashboard and
 *     the remote booking may still be live).
 * A late `DELIVERED`/`RIDER_CANCELLED` from that dead booking then satisfied
 * the proof and mutated the order — terminal flip or `carrier_cancelled`
 * re-arm — even though the restaurant had released it.
 *
 * Fix under test: a teardown retires the ACTIVE binding atomically with the
 * teardown write and appends it to `dispatchReleasedBindings` (audit +
 * reconciliation history is kept — a staff cancel does NOT prove remote
 * cancellation, so a later provider callback is parked HIGH for human
 * reconciliation instead of being applied or silently discarded). A fresh
 * book/paste (re)writes a live binding; released history is never resurrected.
 *
 * RED (pre-fix): groups 1, 2, 3, 4 fail — the binding survives teardown and
 * the late callbacks mutate the order. GREEN (post-fix): all assert retired
 * binding + parked HIGH `order_binding_released` with zero order mutation,
 * while the live-booking control still flips normally.
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
    const snap: any = {
      exists: !!rec,
      data: () => (rec ? rec : undefined),
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

vi.mock("../src/core/errors", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/errors")>();
  return { ...actual, captureErrorSnapshot: vi.fn(async () => "err_test_snapshot") };
});

vi.mock("../src/modules/notifications/fcm.service", () => ({
  dispatchFCM: vi.fn(async () => undefined),
}));

import { dispatchBook, dispatchCancel, dispatchRebook } from "../src/modules/dispatch/dispatch.router";
import { handleDispatchWebhook } from "../src/modules/dispatch/dispatch.webhooks";
import { dispatchFCM } from "../src/modules/notifications/fcm.service";
import { captureErrorSnapshot } from "../src/core/errors";
import { computeHmacSha256 } from "../src/core/security";
import { config } from "../src/config/env";

const TEST_BORZO_WEBHOOK_SECRET = "test_borzo_whsec_vitest_only";

const fcmSpy = vi.mocked(dispatchFCM);
const snapshotSpy = vi.mocked(captureErrorSnapshot);

const originalFetch = globalThis.fetch;
let fetchCalls: string[] = [];

beforeAll(() => {
  globalThis.fetch = vi.fn(async (url: any) => {
    fetchCalls.push(String(url));
    return new Response(JSON.stringify({ message: "no provider network in this suite" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }) as any;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

function seedOrder(id: string, extra: Record<string, any> = {}) {
  savedDocs[`orders/${id}`] = { ...defaultOrder(), ...extra };
}

/** Book-time binding row; it survives teardown in production (never deleted). */
function seedMap(providerOrderId: string, orderId: string, provider: string) {
  savedDocs[`dispatch_order_map/${providerOrderId}`] = {
    orderId,
    provider,
    branchId: "branch_ahmedabad_1",
  };
}

function docOf(id: string): any {
  return savedDocs[`orders/${id}`];
}

function parkedUnmatched(): any[] {
  return Object.entries(savedDocs)
    .filter(([k]) => k.startsWith("unmatched_dispatch_events/"))
    .map(([, v]) => v);
}

function webhookEventRows(): any[] {
  return Object.entries(savedDocs)
    .filter(([k]) => k.startsWith("dispatch_webhook_events/"))
    .map(([, v]) => v);
}

const borzoSig = (raw: string) => computeHmacSha256(raw, TEST_BORZO_WEBHOOK_SECRET);

const borzoWebhook = (payload: any) =>
  handleDispatchWebhook("borzo", JSON.stringify(payload), borzoSig(JSON.stringify(payload)), payload);

let saved: any = {};

beforeEach(() => {
  saved = { borzo: { ...config.borzo }, shadowfax: { ...config.shadowfax }, porter: { ...config.porter }, mock: { ...config.mock } };
  // Deterministic, offline providers: mock booking only, Porter retired from
  // the walk (opt-in per 086b60d), no real keys/secrets.
  config.borzo.enabled = true;
  config.borzo.apiKey = "";
  config.borzo.customerId = "";
  config.borzo.webhookSecret = TEST_BORZO_WEBHOOK_SECRET;
  config.shadowfax.enabled = true;
  config.shadowfax.apiKey = "";
  config.shadowfax.clientCode = "";
  config.shadowfax.webhookSecret = "";
  config.shadowfax.contractVerified = false;
  config.porter.enabled = false;
  config.porter.apiKey = "";
  config.mock.borzoDispatch = true;
  config.mock.shadowfaxDispatch = true;
  config.mock.porterDispatch = false;

  for (const k of Object.keys(savedDocs)) delete savedDocs[k];
  fcmSpy.mockClear();
  snapshotSpy.mockClear();
  fetchCalls = [];
});

describe("teardown retires the active binding (router side)", () => {
  it("dispatchCancel clears dispatchProvider/dispatchOrderId and keeps the dead booking as released history", async () => {
    seedOrder("ord_teardown_cancel", {
      deliveryStatus: "dispatched",
      dispatchStatus: "dispatched",
      dispatchProvider: "borzo",
      dispatchOrderId: "BRZ-DEAD-1",
      riderName: "[TEST] Borzo Rider Kiran",
      riderPhone: "918880000001",
    });

    const res = await dispatchCancel({ orderId: "ord_teardown_cancel", staffName: "Ops" });
    expect(res).toMatchObject({ success: true, provider: "borzo", providerCancel: "manual-required" });

    const doc = docOf("ord_teardown_cancel");
    // Teardown semantics preserved.
    expect(doc.deliveryStatus).toBe("rider_cancelled");
    expect(doc.dispatchStatus).toBe("cancelled_by_store");
    expect(doc.needsRebook).toBe(true);
    expect(doc.rebookTrigger).toBe("staff_cancelled");
    // The dead booking no longer owns the order…
    expect(doc.dispatchProvider).toBeNull();
    expect(doc.dispatchOrderId).toBeNull();
    expect(doc.porterOrderId).toBeNull();
    expect(doc.borzoOrderId).toBeNull();
    expect(doc.shadowfaxOrderId).toBeNull();
    // …but the binding is NOT lost: staff cancels are local-only, the remote
    // booking may still be live, so reconciliation needs this record.
    expect(doc.dispatchReleasedBindings).toHaveLength(1);
    expect(doc.dispatchReleasedBindings[0]).toMatchObject({
      provider: "borzo",
      providerOrderId: "BRZ-DEAD-1",
      reason: "staff_cancelled",
      releasedBy: "Ops",
    });
    expect(doc.dispatchReleasedBindings[0].releasedAt).toBeTruthy();
    // Rider identity stays on the order as history (no destructive scrub).
    expect(doc.riderName).toBe("[TEST] Borzo Rider Kiran");
    // No provider network call was made by the local release.
    expect(fetchCalls).toHaveLength(0);
  });

  it("a failed rebook retires the previous dead binding instead of leaving it as the order's owner", async () => {
    // Carrier cancelled the booking (needsRebook + carrier trigger), then the
    // automatic/staff rebook attempt found no provider: releaseClaimFailed
    // must retire the old binding, not keep presenting it as current.
    seedOrder("ord_teardown_failed", {
      deliveryStatus: "rider_cancelled",
      dispatchStatus: "dispatched",
      dispatchProvider: "borzo",
      dispatchOrderId: "BRZ-DEAD-2",
      needsRebook: true,
      rebookTrigger: "carrier_cancelled",
    });

    await expect(
      dispatchBook({ orderId: "ord_teardown_failed", excludeProviders: ["borzo", "shadowfax"] as any })
    ).rejects.toMatchObject({ code: "DISPATCH_FAILED" });

    const doc = docOf("ord_teardown_failed");
    expect(doc.dispatchStatus).toBe("dispatch_failed");
    expect(doc.needsRebook).toBe(true);
    // The carrier-cancel trigger survives (auto-rebook retry semantics).
    expect(doc.rebookTrigger).toBe("carrier_cancelled");
    // Binding retired + recorded with the teardown cause.
    expect(doc.dispatchProvider).toBeNull();
    expect(doc.dispatchOrderId).toBeNull();
    expect(doc.dispatchReleasedBindings).toHaveLength(1);
    expect(doc.dispatchReleasedBindings[0]).toMatchObject({
      provider: "borzo",
      providerOrderId: "BRZ-DEAD-2",
      reason: "carrier_cancelled",
    });
    expect(fetchCalls).toHaveLength(0); // all providers excluded: no provider I/O
  });

  it("does not invent released history when there was no binding to tear down", async () => {
    seedOrder("ord_teardown_none", { deliveryStatus: "ready" });

    await expect(
      dispatchBook({ orderId: "ord_teardown_none", excludeProviders: ["borzo", "shadowfax"] as any })
    ).rejects.toMatchObject({ code: "DISPATCH_FAILED" });

    const doc = docOf("ord_teardown_none");
    expect(doc.dispatchProvider ?? null).toBeNull();
    expect(doc.dispatchReleasedBindings ?? []).toHaveLength(0);
  });
});

describe("late callbacks from a released booking park HIGH with zero mutation (webhook side)", () => {
  it("a late DELIVERED from the cancelled booking does not deliver the released order", async () => {
    seedOrder("ord_rel_delivered", {
      deliveryStatus: "dispatched",
      dispatchStatus: "dispatched",
      dispatchProvider: "borzo",
      dispatchOrderId: "BRZ-REL-1",
      needsRebook: false,
      rebookTrigger: null,
    });
    seedMap("BRZ-REL-1", "ord_rel_delivered", "borzo");
    await dispatchCancel({ orderId: "ord_rel_delivered", staffName: "Ops" });

    const before = { ...docOf("ord_rel_delivered") };
    await borzoWebhook({ event: "DELIVERED", order_id: "BRZ-REL-1", timestamp: Date.now() });

    const doc = docOf("ord_rel_delivered");
    expect(doc.deliveryStatus).toBe("rider_cancelled"); // not delivered
    expect(doc.deliveredAt).toBeFalsy();
    expect(doc.dispatchWebhookProvider).toBeUndefined();
    expect(doc.status).toBe(before.status);
    expect(fcmSpy.mock.calls).toHaveLength(0);

    const rows = parkedUnmatched();
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toBe("order_binding_released");
    expect(rows[0].releasedReason).toBe("staff_cancelled");
    // Parked, not processed: a retry is pointless, but the row is the review
    // trail (this may be a genuinely fulfilled booking the branch must
    // reconcile by hand — staff cancel is NOT proof of remote cancellation).
    expect(webhookEventRows()[0].status).toBe("parked");
    const high = snapshotSpy.mock.calls.filter((c: any[]) => c[0]?.severity === "high");
    expect(high.length).toBeGreaterThanOrEqual(1);
  });

  it("a late carrier cancel from the released booking cannot re-arm the staff-cancelled auto-rebook path", async () => {
    seedOrder("ord_rel_cancel", {
      deliveryStatus: "dispatched",
      dispatchStatus: "dispatched",
      dispatchProvider: "borzo",
      dispatchOrderId: "BRZ-REL-2",
    });
    seedMap("BRZ-REL-2", "ord_rel_cancel", "borzo");
    await dispatchCancel({ orderId: "ord_rel_cancel", staffName: "Ops" });
    const triggerBefore = docOf("ord_rel_cancel").rebookTrigger;
    expect(triggerBefore).toBe("staff_cancelled");

    await borzoWebhook({
      delivery: { status: "canceled", order_id: "BRZ-REL-2", reason_text: "late carrier cancel" },
    });

    const doc = docOf("ord_rel_cancel");
    // Worker-safety: a carrier trigger would make autoRebookDispatchWorker
    // re-dispatch a booking staff already released.
    expect(doc.rebookTrigger).toBe("staff_cancelled");
    expect(doc.needsRebook).toBe(true);
    expect(doc.deliveryStatus).toBe("rider_cancelled");
    expect(doc.dispatchWebhookProvider).toBeUndefined();
    expect(fcmSpy.mock.calls).toHaveLength(0);
    const rows = parkedUnmatched();
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toBe("order_binding_released");
  });

  it("POSITIVE: the current LIVE booking still resolves; a rebook writes a fresh binding and keeps released history", async () => {
    seedOrder("ord_rel_live", {
      deliveryStatus: "dispatched",
      dispatchStatus: "dispatched",
      dispatchProvider: "borzo",
      dispatchOrderId: "BRZ-OLD-1",
    });
    // Book-time map row: it survives teardown, so a late callback still
    // RESOLVES to the order and reaches the ownership proof (the point here).
    seedMap("BRZ-OLD-1", "ord_rel_live", "borzo");
    await dispatchCancel({ orderId: "ord_rel_live", staffName: "Ops" });
    expect(docOf("ord_rel_live").dispatchProvider).toBeNull();

    // Staff rebook through the guarded endpoint: mock providers book offline.
    const rebook = await dispatchRebook({ orderId: "ord_rel_live", staffName: "Rebook Staff" });
    const freshId = String(rebook.providerOrderId);
    const doc = docOf("ord_rel_live");
    expect(doc.dispatchProvider).toBe(rebook.provider);
    expect(doc.dispatchOrderId).toBe(freshId);
    expect(doc.dispatchOrderId).not.toBe("BRZ-OLD-1");
    expect(doc.deliveryStatus).toBe("dispatched");
    // Released history survives the rebook (never resurrected as the active one).
    expect((doc.dispatchReleasedBindings || []).map((r: any) => r.providerOrderId)).toContain("BRZ-OLD-1");

    // The NEW booking's callback flips normally.
    await borzoWebhook({ event: "DELIVERED", order_id: freshId, timestamp: Date.now() });
    const after = docOf("ord_rel_live");
    expect(after.deliveryStatus).toBe("delivered");
    expect(after.deliveredAt).toBeTruthy();
    expect(parkedUnmatched()).toHaveLength(0);

    // …and the OLD released booking reporting later is still a park, not a
    // second write: the live binding disagrees with the callback, but the
    // released history identifies it, so the reason stays explicit.
    await borzoWebhook({ event: "DELIVERED", order_id: "BRZ-OLD-1", timestamp: Date.now() });
    const finalDoc = docOf("ord_rel_live");
    expect(finalDoc.deliveryStatus).toBe("delivered");
    expect(finalDoc.dispatchOrderId).toBe(freshId);
    const parks = parkedUnmatched();
    expect(parks).toHaveLength(1);
    expect(parks[0].reason).toBe("order_binding_released");
    expect(parks[0].releasedReason).toBe("staff_cancelled");
    expect(fcmSpy.mock.calls).toHaveLength(0);
  });

  it("the Porter manual-paste handover also retires the dead binding (no stale owner while staff paste)", async () => {
    // A carrier-cancelled booking is waiting for a rebook, but no carrier is
    // enabled: the walk lands on the manual paste lane. The dead Borzo booking
    // must stop owning the order for exactly the same reason as the two named
    // teardown paths.
    config.borzo.enabled = false;
    config.shadowfax.enabled = false;
    // Porter is the opt-in manual paste lane (086b60d): armed but unkeyed, so
    // the walk lands on `manual_action_required` with no network call.
    config.porter.enabled = true;
    config.mock.porterDispatch = false;

    seedOrder("ord_rel_manual", {
      deliveryStatus: "rider_cancelled",
      dispatchStatus: "dispatched",
      dispatchProvider: "borzo",
      dispatchOrderId: "BRZ-DEAD-3",
      needsRebook: true,
      rebookTrigger: "carrier_cancelled",
    });
    seedMap("BRZ-DEAD-3", "ord_rel_manual", "borzo");

    const res = await dispatchRebook({ orderId: "ord_rel_manual", staffName: "Ops" });
    expect(res.manual_action_required).toBe(true);

    const doc = docOf("ord_rel_manual");
    expect(doc.dispatchStatus).toBe("manual_pending");
    expect(doc.needsRebook).toBe(false);
    expect(doc.rebookTrigger).toBeNull();
    expect(doc.dispatchProvider).toBeNull();
    expect(doc.dispatchOrderId).toBeNull();
    expect(doc.dispatchReleasedBindings).toHaveLength(1);
    expect(doc.dispatchReleasedBindings[0]).toMatchObject({
      provider: "borzo",
      providerOrderId: "BRZ-DEAD-3",
      reason: "carrier_cancelled",
      releasedBy: "Ops",
    });

    // A replayed carrier cancel from the dead booking must not re-arm the
    // auto-rebook worker or resurrect the paste lane's cleared flags.
    await borzoWebhook({
      delivery: { status: "canceled", order_id: "BRZ-DEAD-3", reason_text: "replay" },
    });
    const after = docOf("ord_rel_manual");
    expect(after.dispatchStatus).toBe("manual_pending");
    expect(after.needsRebook).toBe(false);
    expect(after.rebookTrigger).toBeNull();
    expect(after.dispatchProvider).toBeNull();
    const parks = parkedUnmatched();
    expect(parks).toHaveLength(1);
    expect(parks[0].reason).toBe("order_binding_released");
    expect(fcmSpy.mock.calls).toHaveLength(0);
  });
});
