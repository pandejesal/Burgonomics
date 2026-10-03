import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";

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
  // Refreshable snapshot: ref.get() re-reads savedDocs so transaction
  // re-reads (claim-then-work) observe writes, exactly like Firestore.
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

import {
  dispatchQuote,
  dispatchBook,
  dispatchRebook,
  savePorterManualBooking,
  dispatchCancel,
  dispatchDistanceKm,
} from "../src/modules/dispatch/dispatch.router";
import {
  handleDispatchWebhook,
  verifyDispatchWebhookSignature,
  normalizeDispatchEvent,
} from "../src/modules/dispatch/dispatch.webhooks";
import { computeHmacSha256 } from "../src/core/security";
import { config } from "../src/config/env";

const TEST_BORZO_WEBHOOK_SECRET = "test_borzo_whsec_vitest_only";
const TEST_SFX_WEBHOOK_SECRET = "test_sfx_shared_secret_vitest_only";

const PICKUP = { lat: 23.0131, lng: 72.5085 };
const DROP = { lat: 23.0338, lng: 72.5262 };
// ~21km from the branch — outside the 8km service radius.
const FAR_DROP = { lat: 23.15, lng: 72.65 };

const okJson = (data: any, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const originalFetch = globalThis.fetch;
let fetchCalls: Array<{ url: string; init: any }> = [];
let fetchHandler: ((url: string, init: any) => Response) | null = null;

// Full config snapshot so every test starts from (and restores to) a clean,
// explicit state — no cross-test mock/secret bleed.
let saved: any = {};

beforeAll(() => {
  globalThis.fetch = vi.fn(async (url: any, init: any) => {
    const u = String(url);
    fetchCalls.push({ url: u, init });
    if (fetchHandler) return fetchHandler(u, init);
    return okJson({ message: "no fetch handler registered" }, 404);
  }) as any;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

function seedOrder(id: string, extra: Record<string, any> = {}) {
  savedDocs[`orders/${id}`] = { ...defaultOrder(), ...extra };
}

function docOf(id: string): any {
  return savedDocs[`orders/${id}`];
}

function keysWithPrefix(prefix: string): string[] {
  return Object.keys(savedDocs).filter((k) => k.startsWith(prefix));
}

beforeEach(() => {
  saved = {
    borzo: { ...config.borzo },
    shadowfax: { ...config.shadowfax },
    porter: { ...config.porter },
    mock: { ...config.mock },
  };
  // Baseline: borzo + shadowfax mocked live; porter enabled but unkeyed and
  // unmocked (quote-as-coverage → manual lane).
  config.borzo.enabled = true;
  config.borzo.apiKey = "";
  config.borzo.customerId = "";
  config.borzo.webhookSecret = "";
  config.shadowfax.enabled = true;
  config.shadowfax.apiKey = "";
  config.shadowfax.clientCode = "";
  config.shadowfax.webhookSecret = "";
  config.porter.enabled = true;
  config.porter.apiKey = "";
  config.porter.customerId = "";
  config.porter.webhookSecret = "";
  config.mock.borzoDispatch = true;
  config.mock.shadowfaxDispatch = true;
  config.mock.porterDispatch = false;
  config.dispatch.fareConfirmDeltaInr = 20;
  config.dispatch.quoteTimeoutMs = 6000;

  for (const k of Object.keys(savedDocs)) delete savedDocs[k];
  fetchCalls = [];
  fetchHandler = null;
});

afterEach(() => {
  config.borzo = { ...saved.borzo };
  config.shadowfax = { ...saved.shadowfax };
  config.porter = { ...saved.porter };
  config.mock = { ...saved.mock };
});

describe("dispatchQuote (DR1/DR4/DR5)", () => {
  it("returns cheapest serviceable winner (borzo < shadowfax mock fares)", async () => {
    config.porter.enabled = false; // deterministic two-provider field
    const res = await dispatchQuote({
      pickupLat: PICKUP.lat,
      pickupLng: PICKUP.lng,
      dropLat: DROP.lat,
      dropLng: DROP.lng,
    });

    const km = dispatchDistanceKm(PICKUP, DROP);
    expect(res.serviceable).toBe(true);
    expect(res.winner).toBe("borzo");
    expect(res.estimatedFare).toBe(Math.round(38 + 9 * km));
    expect(res.providers).toHaveLength(2);
    expect(res.providers[0]).toMatchObject({ provider: "borzo", outcome: "ok" });
    expect(res.providers[1]).toMatchObject({ provider: "shadowfax", outcome: "ok" });
    expect(res.quoteId).toMatch(/^QTE-BORZO-/);
    expect(res.validForSeconds).toBe(600);
  });

  it("returns serviceable:false (200, not an error) outside the 8km radius", async () => {
    const res = await dispatchQuote({
      pickupLat: PICKUP.lat,
      pickupLng: PICKUP.lng,
      dropLat: FAR_DROP.lat,
      dropLng: FAR_DROP.lng,
    });
    expect(res.serviceable).toBe(false);
    expect(res.reason).toBe("not_serviced");
    expect(res.distanceKm).toBeGreaterThan(8);
    expect(fetchCalls).toHaveLength(0); // gate runs before any fan-out
  });

  it("fails closed 503 NO_SERVICEABLE_PROVIDER when no provider is eligible", async () => {
    config.porter.enabled = false;
    config.mock.borzoDispatch = false;
    config.mock.shadowfaxDispatch = false;

    await expect(
      dispatchQuote({
        pickupLat: PICKUP.lat,
        pickupLng: PICKUP.lng,
        dropLat: DROP.lat,
        dropLng: DROP.lng,
      })
    ).rejects.toMatchObject({ statusCode: 503, code: "NO_SERVICEABLE_PROVIDER" });
  });
});

describe("dispatchBook (§3 lifecycle)", () => {
  it("books the cheapest provider and persists the normalized lifecycle", async () => {
    config.porter.enabled = false;
    seedOrder("ord_book_1");

    const res = await dispatchBook({ orderId: "ord_book_1", staffName: "Test Staff" });

    expect(res.provider).toBe("borzo");
    expect(res.status).toBe("dispatched");
    expect(res.failover).toBeUndefined();
    expect(res.reused).toBe(false);
    expect(res.riderName).toContain("[TEST]"); // DR11 mock marking
    expect(res.providerOrderId).toMatch(/^BRZ-ORD-/);

    const doc = docOf("ord_book_1");
    expect(doc.deliveryStatus).toBe("dispatched");
    expect(doc.dispatchStatus).toBe("dispatched");
    expect(doc.dispatchProvider).toBe("borzo");
    expect(doc.dispatchOrderId).toMatch(/^BRZ-ORD-/);
    expect(doc.dispatchedBy).toBe("Test Staff");
    expect(doc.dispatchedAt).toBe("MOCK_TIMESTAMP");
    expect(doc.dispatchGeoSource).toBe("live_gps");
    expect(doc.dispatchSource).toBe("mock");
    expect(doc.needsRebook).toBe(false);

    // Server-side providerOrderId → orderId binding for webhook resolution.
    const mapKeys = keysWithPrefix("dispatch_order_map/");
    expect(mapKeys).toHaveLength(1);
    expect(savedDocs[mapKeys[0]]).toMatchObject({ orderId: "ord_book_1", provider: "borzo" });
  });

  it("refuses outside the radius with 409 NOT_SERVICED and releases the claim", async () => {
    seedOrder("ord_far", { deliveryAddress: { full: "Off-zone address", lat: FAR_DROP.lat, lng: FAR_DROP.lng } });

    await expect(dispatchBook({ orderId: "ord_far" })).rejects.toMatchObject({
      statusCode: 409,
      code: "NOT_SERVICED",
    });

    const doc = docOf("ord_far");
    expect(doc.dispatchStatus).toBeNull(); // idle release, not failed
    expect(doc.deliveryStatus).toBeUndefined();
    expect(doc.dispatchOrderId).toBeUndefined();
  });

  it("fails closed 503 when zero providers are eligible, leaving the order clean", async () => {
    config.porter.enabled = false;
    config.mock.borzoDispatch = false;
    config.mock.shadowfaxDispatch = false;
    seedOrder("ord_noel");

    await expect(dispatchBook({ orderId: "ord_noel" })).rejects.toMatchObject({
      statusCode: 503,
      code: "NO_SERVICEABLE_PROVIDER",
    });

    const doc = docOf("ord_noel");
    expect(doc.dispatchStatus).toBeNull();
    expect(doc.deliveryStatus).toBeUndefined();
  });

  it("refuses dispatch when the drop pin has no GPS coordinates (422, pre-claim)", async () => {
    seedOrder("ord_nogps", { deliveryAddress: { full: "Text-only address", street: "CG Road" } });

    await expect(dispatchBook({ orderId: "ord_nogps" })).rejects.toMatchObject({
      statusCode: 422,
      code: "DISPATCH_GPS_MISSING",
    });
    expect(docOf("ord_nogps").dispatchStatus).toBeUndefined(); // never claimed
  });

  it("returns 202 DISPATCH_IN_PROGRESS on a fresh competing claim (double-tap)", async () => {
    seedOrder("ord_busy", { dispatchStatus: "dispatch_pending", dispatchClaimedAt: Date.now() });

    await expect(dispatchBook({ orderId: "ord_busy" })).rejects.toMatchObject({
      statusCode: 202,
      code: "DISPATCH_IN_PROGRESS",
      retryAfterMs: 2000,
    });
    expect(fetchCalls).toHaveLength(0); // rejected before any provider call
  });

  it("replays an already-active dispatch as reused:true (idempotent double-tap)", async () => {
    seedOrder("ord_active", {
      deliveryStatus: "dispatched",
      dispatchProvider: "borzo",
      dispatchOrderId: "BRZ-ORD-777777",
      riderName: "[TEST] Existing Rider",
      dispatchSource: "mock",
      dispatchGeoSource: "live_gps",
    });

    const res = await dispatchBook({ orderId: "ord_active" });
    expect(res).toMatchObject({
      reused: true,
      provider: "borzo",
      providerOrderId: "BRZ-ORD-777777",
      status: "dispatched",
      riderName: "[TEST] Existing Rider",
    });
    expect(fetchCalls).toHaveLength(0);
  });

  it("asks for fare confirmation when the fresh quote drifted past threshold (DR7)", async () => {
    config.porter.enabled = false;
    seedOrder("ord_fare");

    const res = await dispatchBook({ orderId: "ord_fare", quotedFare: 10 });
    expect(res.needsFareConfirm).toBe(true);
    expect(res.provider).toBe("borzo");
    expect(res.newFare).toBeGreaterThan(10);
    expect(res.threshold).toBe(20); // max(20, 10% of 10)
    expect(res.delta).toBeGreaterThanOrEqual(20);

    const doc = docOf("ord_fare");
    expect(doc.deliveryStatus).toBeUndefined(); // nothing committed
    expect(doc.dispatchStatus).toBeNull(); // claim released for the confirm retry
    expect(doc.dispatchQuote).toBeTruthy();

    // The confirmed retry books for real.
    seedOrder("ord_fare_ok");
    const ok = await dispatchBook({ orderId: "ord_fare_ok", quotedFare: 10, confirmFare: true });
    expect(ok.provider).toBe("borzo");
    expect(ok.status).toBe("dispatched");
  });

  it("fails over to the next provider when the cheapest one 500s at book time (DR6)", async () => {
    // Borzo live-keyed (so its create-order actually hits the wire), shadowfax
    // mocked, porter off. Cheapest quote: borzo 60 < shadowfax 71.
    config.borzo.apiKey = "test_borzo_key";
    config.mock.borzoDispatch = false;
    config.porter.enabled = false;
    fetchHandler = (url) => {
      if (url.includes("/calculate-order")) {
        // Real Business API 1.8 shape: fare at order.payment_amount (string).
        return okJson({ is_successful: true, order: { payment_amount: "60.00" } });
      }
      if (url.includes("/create-order")) {
        return new Response("upstream exploded", { status: 500 });
      }
      return okJson({ message: "not found" }, 404);
    };
    seedOrder("ord_fo");

    const res = await dispatchBook({ orderId: "ord_fo" });

    expect(res.provider).toBe("shadowfax");
    expect(res.failover).toEqual({ from: "borzo", to: "shadowfax", cheapestProvider: "borzo" });
    expect(res.attempts).toEqual([
      expect.objectContaining({ provider: "borzo", outcome: "transient_failure" }),
      expect.objectContaining({ provider: "shadowfax", outcome: "booked" }),
    ]);
    expect(res.riderName).toContain("[TEST]");
    expect(fetchCalls.map((c) => c.url)).toHaveLength(2); // calculate + create, no more

    const doc = docOf("ord_fo");
    expect(doc.dispatchProvider).toBe("shadowfax");
    expect(doc.dispatchAttempts).toHaveLength(2);
  });

  it("routes an unkeyed-Porter-only field to the manual lane (DR8, no status flip)", async () => {
    config.borzo.enabled = false;
    config.shadowfax.enabled = false;
    seedOrder("ord_manual");

    const res = await dispatchBook({ orderId: "ord_manual" });

    expect(res).toMatchObject({
      manual_action_required: true,
      provider: "porter",
      pasteEndpoint: "/dispatch/porter-manual",
      orderId: "ord_manual",
    });
    expect(res.attempts).toEqual([
      expect.objectContaining({ provider: "porter", outcome: "manual_required" }),
    ]);

    const doc = docOf("ord_manual");
    expect(doc.dispatchStatus).toBe("manual_pending");
    expect(doc.deliveryStatus).toBeUndefined(); // order stays actionable
    expect(doc.dispatchQuote.winner).toBe("porter");
    expect(doc.dispatchSource).toBeUndefined();
  });
});

describe("dispatchRebook", () => {
  it("409 NOT_REBOOKABLE for an order that is not waiting on a rebook", async () => {
    seedOrder("ord_rb_no");
    await expect(dispatchRebook({ orderId: "ord_rb_no" })).rejects.toMatchObject({
      statusCode: 409,
      code: "NOT_REBOOKABLE",
    });
  });

  it("re-enters the book flow for a needsRebook order", async () => {
    config.porter.enabled = false;
    seedOrder("ord_rb", { needsRebook: true, deliveryStatus: "rider_cancelled" });

    const res = await dispatchRebook({ orderId: "ord_rb", staffName: "Rebook Staff" });
    expect(res.provider).toBe("borzo");
    expect(res.status).toBe("dispatched");

    const doc = docOf("ord_rb");
    expect(doc.deliveryStatus).toBe("dispatched");
    expect(doc.needsRebook).toBe(false);
    expect(doc.dispatchedBy).toBe("Rebook Staff");
  });
});

describe("savePorterManualBooking (DR8 paste lane)", () => {
  it("persists exactly what an API book would, with both map bindings", async () => {
    seedOrder("ord_paste");
    const res = await savePorterManualBooking({
      orderId: "ord_paste",
      porterOrderId: "POR-12345",
      trackingUrl: "https://porter.in/track/POR-12345",
      staffName: "Ops",
    });

    expect(res).toMatchObject({
      success: true,
      provider: "porter",
      orderId: "ord_paste",
      porterOrderId: "POR-12345",
      status: "dispatched",
      source: "manual_paste",
    });

    const doc = docOf("ord_paste");
    expect(doc.deliveryStatus).toBe("dispatched"); // poller eligibility
    expect(doc.dispatchStatus).toBe("dispatched");
    expect(doc.dispatchProvider).toBe("porter");
    expect(doc.dispatchOrderId).toBe("POR-12345");
    expect(doc.porterOrderId).toBe("POR-12345");
    expect(doc.dispatchSource).toBe("manual_paste");
    expect(doc.riderTrackingUrl).toBe("https://porter.in/track/POR-12345");
    expect(doc.dispatchedBy).toBe("Ops");
    expect(doc.needsRebook).toBe(false);

    expect(savedDocs["dispatch_order_map/POR-12345"]).toMatchObject({ orderId: "ord_paste", provider: "porter" });
    expect(savedDocs["porter_order_map/POR-12345"]).toMatchObject({ orderId: "ord_paste" });
  });

  it("is idempotent on replay of the same porter order id", async () => {
    seedOrder("ord_replay");
    await savePorterManualBooking({ orderId: "ord_replay", porterOrderId: "POR-777" });
    const again = await savePorterManualBooking({ orderId: "ord_replay", porterOrderId: "POR-777" });
    expect(again).toMatchObject({ reused: true, provider: "porter", providerOrderId: "POR-777" });
    expect(docOf("ord_replay").deliveryStatus).toBe("dispatched");
  });

  it("400 INVALID_PORTER_ORDER_ID for an unsafe id", async () => {
    seedOrder("ord_badid");
    await expect(
      savePorterManualBooking({ orderId: "ord_badid", porterOrderId: "bad/id" })
    ).rejects.toMatchObject({ statusCode: 400, code: "INVALID_PORTER_ORDER_ID" });
    expect(docOf("ord_badid").deliveryStatus).toBeUndefined();
  });

  it("400 TRACKING_URL_INVALID for a non-porter.in link", async () => {
    seedOrder("ord_badurl");
    await expect(
      savePorterManualBooking({
        orderId: "ord_badurl",
        porterOrderId: "POR-1",
        trackingUrl: "http://evil.example.com/track",
      })
    ).rejects.toMatchObject({ statusCode: 400, code: "TRACKING_URL_INVALID" });
    expect(docOf("ord_badurl").deliveryStatus).toBeUndefined();
  });

  it("409 DISPATCH_EXISTS when another provider owns the active dispatch", async () => {
    seedOrder("ord_conflict", {
      deliveryStatus: "dispatched",
      dispatchProvider: "borzo",
      dispatchOrderId: "BRZ-ORD-9",
    });
    await expect(
      savePorterManualBooking({ orderId: "ord_conflict", porterOrderId: "POR-9" })
    ).rejects.toMatchObject({ statusCode: 409, code: "DISPATCH_EXISTS" });
    expect(docOf("ord_conflict").dispatchOrderId).toBe("BRZ-ORD-9"); // untouched
  });

  it("202 when a live API book claim is already in flight", async () => {
    seedOrder("ord_pend", { dispatchStatus: "dispatch_pending", dispatchClaimedAt: Date.now() });
    await expect(
      savePorterManualBooking({ orderId: "ord_pend", porterOrderId: "POR-2" })
    ).rejects.toMatchObject({ statusCode: 202, code: "DISPATCH_IN_PROGRESS" });
  });
});

describe("dispatchCancel", () => {
  it("409 NOTHING_TO_CANCEL when no dispatch is active", async () => {
    seedOrder("ord_cxl_no");
    await expect(dispatchCancel({ orderId: "ord_cxl_no" })).rejects.toMatchObject({
      statusCode: 409,
      code: "NOTHING_TO_CANCEL",
    });
  });

  it("releases a borzo dispatch locally with manual-required honesty", async () => {
    seedOrder("ord_cxl", {
      deliveryStatus: "dispatched",
      dispatchProvider: "borzo",
      dispatchOrderId: "BRZ-ORD-9",
      riderName: "[TEST] Borzo Rider Kiran",
    });

    const res = await dispatchCancel({ orderId: "ord_cxl", staffName: "Ops" });
    expect(res).toMatchObject({
      success: true,
      provider: "borzo",
      providerCancel: "manual-required",
    });

    const doc = docOf("ord_cxl");
    expect(doc.deliveryStatus).toBe("rider_cancelled");
    expect(doc.dispatchStatus).toBe("cancelled_by_store");
    expect(doc.dispatchProviderCancel).toBe("manual-required");
    expect(doc.needsRebook).toBe(true);
    expect(doc.cancelledBy).toBe("Ops");
  });

  it("delegates a porter dispatch to cancelPorterBooking (porter field semantics)", async () => {
    seedOrder("ord_pcxl", {
      deliveryStatus: "dispatched",
      dispatchProvider: "porter",
      dispatchOrderId: "POR-1",
      porterOrderId: "POR-1",
    });

    const res = await dispatchCancel({ orderId: "ord_pcxl", staffName: "Ops" });
    expect(res).toMatchObject({ success: true, provider: "porter", providerCancel: "manual-required" });

    const doc = docOf("ord_pcxl");
    expect(doc.deliveryStatus).toBe("rider_cancelled");
    expect(doc.porterDispatchStatus).toBe("cancelled_by_store"); // porter's own field
    expect(doc.needsRebook).toBe(true);
  });
});

describe("dispatch webhooks (DR10)", () => {
  const borzoSig = (rawBody: string) => computeHmacSha256(rawBody, TEST_BORZO_WEBHOOK_SECRET);

  beforeEach(() => {
    config.borzo.webhookSecret = TEST_BORZO_WEBHOOK_SECRET;
  });

  it("verifyDispatchWebhookSignature accepts sha256= prefixed signatures and denies empty secrets", () => {
    const raw = JSON.stringify({ event: "DELIVERED" });
    const sig = computeHmacSha256(raw, TEST_BORZO_WEBHOOK_SECRET);
    expect(verifyDispatchWebhookSignature("borzo", raw, sig)).toBe(true);
    expect(verifyDispatchWebhookSignature("borzo", raw, `sha256=${sig}`)).toBe(true);
    expect(verifyDispatchWebhookSignature("borzo", raw, "deadbeef")).toBe(false);
    expect(verifyDispatchWebhookSignature("borzo", raw, "")).toBe(false);

    const prev = config.borzo.webhookSecret;
    config.borzo.webhookSecret = ""; // fail-closed: empty secret denies
    expect(verifyDispatchWebhookSignature("borzo", raw, sig)).toBe(false);
    config.borzo.webhookSecret = prev;
  });

  it("verifies shadowfax callbacks via static shared secret or HMAC, never empty", () => {
    const raw = JSON.stringify({ order_status: "DELIVERED", sfx_order_id: "SFX-1" });
    config.shadowfax.webhookSecret = TEST_SFX_WEBHOOK_SECRET;

    // Shadowfax has no native HMAC — the team configures our secret as a
    // custom callback header value (static match), HMAC also accepted.
    expect(verifyDispatchWebhookSignature("shadowfax", raw, TEST_SFX_WEBHOOK_SECRET)).toBe(true);
    expect(
      verifyDispatchWebhookSignature(
        "shadowfax",
        raw,
        computeHmacSha256(raw, TEST_SFX_WEBHOOK_SECRET)
      )
    ).toBe(true);
    expect(verifyDispatchWebhookSignature("shadowfax", raw, "deadbeef")).toBe(false);
    expect(verifyDispatchWebhookSignature("shadowfax", raw, "")).toBe(false);

    config.shadowfax.webhookSecret = "";
    expect(verifyDispatchWebhookSignature("shadowfax", raw, TEST_SFX_WEBHOOK_SECRET)).toBe(false);
  });

  it("normalizes provider aliases to the canonical lifecycle", () => {
    expect(normalizeDispatchEvent("RIDER_ASSIGNED")).toBe("DRIVER_ALLOCATED");
    expect(normalizeDispatchEvent("picked-up")).toBe("ARRIVED_AT_PICKUP");
    expect(normalizeDispatchEvent(" out_for_delivery ")).toBe("STARTED_DELIVERY");
    expect(normalizeDispatchEvent("COMPLETED")).toBe("DELIVERED");
    expect(normalizeDispatchEvent("NO_RIDERS_FOUND")).toBe("RIDER_CANCELLED");
    expect(normalizeDispatchEvent("TELEPORTED")).toBeNull();
    // Borzo delivery statuses (doc-confirmed) + scope-dependent `active`.
    expect(normalizeDispatchEvent("parcel_picked_up")).toBe("STARTED_DELIVERY");
    expect(normalizeDispatchEvent("finished")).toBe("DELIVERED");
    expect(normalizeDispatchEvent("courier_assigned")).toBe("DRIVER_ALLOCATED");
    expect(normalizeDispatchEvent("active", "order")).toBe("DRIVER_ALLOCATED");
    expect(normalizeDispatchEvent("active", "delivery")).toBe("STARTED_DELIVERY");
    // Shadowfax order_status callbacks (doc-confirmed).
    expect(normalizeDispatchEvent("ALLOTTED")).toBe("DRIVER_ALLOCATED");
    expect(normalizeDispatchEvent("ARRIVED")).toBe("ARRIVED_AT_PICKUP");
    expect(normalizeDispatchEvent("DISPATCHED")).toBe("STARTED_DELIVERY");
    expect(normalizeDispatchEvent("CANCELLED_BY_CUSTOMER")).toBe("RIDER_CANCELLED");
  });

  it("applies a valid DELIVERED event through dispatch_order_map and dedups redelivery", async () => {
    seedOrder("ord_hook", {
      deliveryStatus: "in_transit",
      dispatchProvider: "borzo",
      dispatchOrderId: "BZ-DEL-1",
    });
    savedDocs["dispatch_order_map/BZ-DEL-1"] = { orderId: "ord_hook", provider: "borzo" };

    const payload = { event: "DELIVERED", order_id: "BZ-DEL-1", timestamp: Date.now() };
    const raw = JSON.stringify(payload);
    await handleDispatchWebhook("borzo", raw, borzoSig(raw), payload);

    const doc = docOf("ord_hook");
    expect(doc.deliveryStatus).toBe("delivered");
    expect(doc.status).toMatchObject({ code: "DELIVERED", terminal: true });
    expect(doc.deliveredAt).toBe("MOCK_TIMESTAMP");
    expect(doc.dispatchWebhookEvent).toBe("DELIVERED");

    const dedupKeys = keysWithPrefix("dispatch_webhook_events/dwe_borzo_DELIVERED_BZ-DEL-1_");
    expect(dedupKeys).toHaveLength(1);
    expect(savedDocs[dedupKeys[0]].status).toBe("processed");

    // Redelivery with the same raw body must be skipped (status-gated dedup).
    savedDocs["orders/ord_hook"].deliveryStatus = "in_transit";
    await handleDispatchWebhook("borzo", raw, borzoSig(raw), payload);
    expect(docOf("ord_hook").deliveryStatus).toBe("in_transit"); // untouched
  });

  it("rejects forged signatures with 401 and leaves the order untouched", async () => {
    seedOrder("ord_forge", { deliveryStatus: "in_transit" });
    const payload = { event: "DELIVERED", order_id: "BZ-DEL-1", timestamp: Date.now() };
    const raw = JSON.stringify(payload);

    await expect(handleDispatchWebhook("borzo", raw, "deadbeef", payload)).rejects.toMatchObject({
      statusCode: 401,
    });
    expect(docOf("ord_forge").deliveryStatus).toBe("in_transit");
  });

  it("parks unknown events without touching the order", async () => {
    seedOrder("ord_unknown", { deliveryStatus: "in_transit" });
    savedDocs["dispatch_order_map/BZ-DEL-1"] = { orderId: "ord_unknown", provider: "borzo" };

    const payload = { event: "TELEPORTED", order_id: "BZ-DEL-1", timestamp: Date.now() };
    const raw = JSON.stringify(payload);
    await handleDispatchWebhook("borzo", raw, borzoSig(raw), payload);

    expect(docOf("ord_unknown").deliveryStatus).toBe("in_transit"); // untouched
    const parkKeys = keysWithPrefix("unmatched_dispatch_events/");
    expect(parkKeys).toHaveLength(1);
    expect(savedDocs[parkKeys[0]]).toMatchObject({
      provider: "borzo",
      reason: "unknown_event",
      status: "needs_review",
    });
  });

  it("parks stale events (>15min old) instead of rewinding newer order state", async () => {
    seedOrder("ord_stale", { deliveryStatus: "in_transit" });
    const payload = {
      event: "DELIVERED",
      order_id: "BZ-DEL-1",
      timestamp: Date.now() - 20 * 60 * 1000,
    };
    const raw = JSON.stringify(payload);
    await handleDispatchWebhook("borzo", raw, borzoSig(raw), payload);

    expect(docOf("ord_stale").deliveryStatus).toBe("in_transit"); // no rewind
    const parkKeys = keysWithPrefix("unmatched_dispatch_events/");
    expect(parkKeys).toHaveLength(1);
    expect(savedDocs[parkKeys[0]]).toMatchObject({ reason: "stale_event" });
  });

  it("applies RIDER_CANCELLED with needsRebook and marks the dedup doc processed", async () => {
    seedOrder("ord_rc", {
      deliveryStatus: "in_transit",
      dispatchProvider: "borzo",
      dispatchOrderId: "BZ-RC-1",
      branchId: "branch_ahmedabad_1",
    });
    savedDocs["dispatch_order_map/BZ-RC-1"] = { orderId: "ord_rc", provider: "borzo" };

    const payload = {
      event: "RIDER_CANCELLED",
      order_id: "BZ-RC-1",
      reason: "Rider too busy",
      timestamp: Date.now(),
    };
    const raw = JSON.stringify(payload);
    await handleDispatchWebhook("borzo", raw, borzoSig(raw), payload);

    const doc = docOf("ord_rc");
    expect(doc.deliveryStatus).toBe("rider_cancelled");
    expect(doc.needsRebook).toBe(true);
    expect(doc.riderCancellationReason).toBe("Rider too busy");
    expect(doc.status).toMatchObject({ code: "RIDER_CANCELLED", terminal: false });

    const dedupKeys = keysWithPrefix("dispatch_webhook_events/dwe_borzo_RIDER_CANCELLED_BZ-RC-1_");
    expect(dedupKeys).toHaveLength(1);
    expect(savedDocs[dedupKeys[0]].status).toBe("processed");
  });

  it("parks a hint/binding conflict (map wins, order never flipped)", async () => {
    seedOrder("ord_bound", {
      deliveryStatus: "dispatched",
      dispatchProvider: "borzo",
      dispatchOrderId: "BZ-REAL-1",
    });
    savedDocs["dispatch_order_map/BZ-REAL-1"] = { orderId: "ord_bound", provider: "borzo" };

    const payload = {
      event: "DELIVERED",
      order_id: "BZ-REAL-1",
      merchant_order_id: "ord_other", // hint disagrees with the map
      timestamp: Date.now(),
    };
    const raw = JSON.stringify(payload);
    await handleDispatchWebhook("borzo", raw, borzoSig(raw), payload);

    expect(docOf("ord_bound").deliveryStatus).toBe("dispatched"); // untouched
    expect(savedDocs["orders/ord_other"]).toBeUndefined(); // never resolved, never flipped
    const parkKeys = keysWithPrefix("unmatched_dispatch_events/");
    expect(parkKeys).toHaveLength(1);
    expect(savedDocs[parkKeys[0]]).toMatchObject({ reason: "order_id_conflict" });
  });

  it("applies real Borzo delivery callbacks (nested delivery.status + courier)", async () => {
    seedOrder("ord_bzcb", {
      deliveryStatus: "dispatched",
      dispatchProvider: "borzo",
      dispatchOrderId: "12345",
    });
    savedDocs["dispatch_order_map/12345"] = { orderId: "ord_bzcb", provider: "borzo" };

    // 1) courier_assigned → DRIVER_ALLOCATED: nested courier becomes rider fields.
    const assignPayload = {
      event_datetime: new Date().toISOString(),
      event_type: "delivery_changed",
      delivery: {
        order_id: 12345, // numeric full order id — map lookup via String()
        status: "courier_assigned",
        client_order_id: "ord_bzcb", // point-level hint (matches map)
        tracking_url: "https://track.borzodelivery.com/t/abc",
        courier: { surname: "Kumar", name: "Amit", phone: "918880000001" },
      },
    };
    await handleDispatchWebhook(
      "borzo",
      JSON.stringify(assignPayload),
      borzoSig(JSON.stringify(assignPayload)),
      assignPayload
    );
    const afterAssign = docOf("ord_bzcb");
    expect(afterAssign.deliveryStatus).toBe("dispatched");
    expect(afterAssign.riderName).toBe("Kumar Amit");
    expect(afterAssign.riderPhone).toBe("918880000001");
    expect(afterAssign.riderTrackingUrl).toBe("https://track.borzodelivery.com/t/abc");
    expect(afterAssign.dispatchWebhookEvent).toBe("courier_assigned");

    // 2) parcel_picked_up → STARTED_DELIVERY: status flips, no park.
    const pickedPayload = {
      event_datetime: new Date().toISOString(),
      event_type: "delivery_changed",
      delivery: { order_id: 12345, status: "parcel_picked_up", client_order_id: "ord_bzcb" },
    };
    await handleDispatchWebhook(
      "borzo",
      JSON.stringify(pickedPayload),
      borzoSig(JSON.stringify(pickedPayload)),
      pickedPayload
    );
    const doc = docOf("ord_bzcb");
    expect(doc.deliveryStatus).toBe("in_transit");
    expect(doc.status).toMatchObject({ code: "OUT_FOR_DELIVERY", terminal: false });
    expect(doc.dispatchWebhookEvent).toBe("parcel_picked_up");
    expect(keysWithPrefix("unmatched_dispatch_events/")).toHaveLength(0);
  });

  it("maps order-scope Borzo `active` to DRIVER_ALLOCATED and delivery-scope to STARTED_DELIVERY", async () => {
    seedOrder("ord_ordact", { dispatchProvider: "borzo", dispatchOrderId: "888" });
    savedDocs["dispatch_order_map/888"] = { orderId: "ord_ordact", provider: "borzo" };

    const orderPayload = {
      event_datetime: new Date().toISOString(),
      event_type: "order_changed",
      order: { order_id: 888, status: "active", client_order_id: "ord_ordact" },
    };
    await handleDispatchWebhook(
      "borzo",
      JSON.stringify(orderPayload),
      borzoSig(JSON.stringify(orderPayload)),
      orderPayload
    );
    expect(docOf("ord_ordact").deliveryStatus).toBe("dispatched");
    expect(docOf("ord_ordact").dispatchWebhookEvent).toBe("active");

    seedOrder("ord_delact", { deliveryStatus: "dispatched", dispatchProvider: "borzo", dispatchOrderId: "889" });
    savedDocs["dispatch_order_map/889"] = { orderId: "ord_delact", provider: "borzo" };
    const deliveryPayload = {
      event_datetime: new Date().toISOString(),
      event_type: "delivery_changed",
      delivery: { order_id: 889, status: "active", client_order_id: "ord_delact" },
    };
    await handleDispatchWebhook(
      "borzo",
      JSON.stringify(deliveryPayload),
      borzoSig(JSON.stringify(deliveryPayload)),
      deliveryPayload
    );
    expect(docOf("ord_delact").deliveryStatus).toBe("in_transit");
  });

  it("marks known-but-inert Borzo lifecycle noise processed without parking", async () => {
    seedOrder("ord_ign", { deliveryStatus: "in_transit", dispatchProvider: "borzo", dispatchOrderId: "111" });
    savedDocs["dispatch_order_map/111"] = { orderId: "ord_ign", provider: "borzo" };

    const payload = {
      event_datetime: new Date().toISOString(),
      event_type: "order_changed",
      order: { order_id: 111, status: "new", client_order_id: "ord_ign" },
    };
    const raw = JSON.stringify(payload);
    await handleDispatchWebhook("borzo", raw, borzoSig(raw), payload);

    expect(docOf("ord_ign").deliveryStatus).toBe("in_transit"); // untouched
    expect(keysWithPrefix("unmatched_dispatch_events/")).toHaveLength(0); // no park, no alert
    const dedupKeys = keysWithPrefix("dispatch_webhook_events/");
    expect(dedupKeys).toHaveLength(1);
    expect(savedDocs[dedupKeys[0]].status).toBe("processed"); // retries stop
  });

  it("ignores a late non-terminal callback after delivery (no rewind)", async () => {
    seedOrder("ord_late", {
      deliveryStatus: "delivered",
      dispatchProvider: "borzo",
      dispatchOrderId: "777",
      status: { code: "DELIVERED", terminal: true },
    });
    savedDocs["dispatch_order_map/777"] = { orderId: "ord_late", provider: "borzo" };

    const payload = {
      event_datetime: new Date().toISOString(),
      event_type: "delivery_changed",
      delivery: { order_id: 777, status: "courier_arrived", client_order_id: "ord_late" },
    };
    const raw = JSON.stringify(payload);
    await handleDispatchWebhook("borzo", raw, borzoSig(raw), payload);

    const doc = docOf("ord_late");
    expect(doc.deliveryStatus).toBe("delivered"); // never rewound
    expect(doc.status).toMatchObject({ code: "DELIVERED", terminal: true });
    expect(keysWithPrefix("unmatched_dispatch_events/")).toHaveLength(0);
  });

  it("applies a real Shadowfax ALLOTTED + DELIVERED callback chain", async () => {
    config.shadowfax.webhookSecret = TEST_SFX_WEBHOOK_SECRET;
    seedOrder("ord_sfx", {
      deliveryStatus: "dispatched",
      dispatchProvider: "shadowfax",
      dispatchOrderId: "SFX-901",
    });
    savedDocs["dispatch_order_map/SFX-901"] = { orderId: "ord_sfx", provider: "shadowfax" };

    const allotPayload = {
      order_status: "ALLOTTED",
      sfx_order_id: "SFX-901",
      client_order_id: "ord_sfx",
      rider_name: "Ravi Kumar",
      rider_contact: "9876543210",
      allot_time: new Date().toISOString(),
      track_url: "https://in.shadowfax.in/track/SFX-901",
    };
    await handleDispatchWebhook(
      "shadowfax",
      JSON.stringify(allotPayload),
      TEST_SFX_WEBHOOK_SECRET, // static shared-secret header form
      allotPayload
    );
    const afterAllot = docOf("ord_sfx");
    expect(afterAllot.deliveryStatus).toBe("dispatched");
    expect(afterAllot.riderName).toBe("Ravi Kumar");
    expect(afterAllot.riderPhone).toBe("9876543210");
    expect(afterAllot.riderTrackingUrl).toBe("https://in.shadowfax.in/track/SFX-901");

    const deliverPayload = {
      order_status: "DELIVERED",
      sfx_order_id: "SFX-901",
      client_order_id: "ord_sfx",
      delivery_time: new Date().toISOString(),
    };
    await handleDispatchWebhook(
      "shadowfax",
      JSON.stringify(deliverPayload),
      TEST_SFX_WEBHOOK_SECRET,
      deliverPayload
    );
    const afterDeliver = docOf("ord_sfx");
    expect(afterDeliver.deliveryStatus).toBe("delivered");
    expect(afterDeliver.status).toMatchObject({ code: "DELIVERED", terminal: true });
    expect(keysWithPrefix("unmatched_dispatch_events/")).toHaveLength(0);
  });
});
