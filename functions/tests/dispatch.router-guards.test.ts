import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";

/**
 * Dispatch router guards pinned by
 * audit-results/integrations-2026-10-17/audit-dispatch.md (findings 1 and 2).
 *
 * Harness mirrors tests/dispatch.router.test.ts: refreshable Firestore shim,
 * explicit config snapshot per test, stubbed global.fetch (no provider call can
 * reach the network). Fares are read from a real `dispatchQuote` fan-out rather
 * than hardcoded, so a DR11 mock rate-card change surfaces as a failed
 * precondition instead of a silently passing test.
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
  savePorterManualBooking,
} from "../src/modules/dispatch/dispatch.router";
import { config } from "../src/config/env";

const PICKUP = { lat: 23.0131, lng: 72.5085 };
const DROP = { lat: 23.0338, lng: 72.5262 };

const originalFetch = globalThis.fetch;
let fetchCalls: Array<{ url: string; init: any }> = [];
let saved: any = {};

beforeAll(() => {
  globalThis.fetch = vi.fn(async (url: any, init: any) => {
    fetchCalls.push({ url: String(url), init });
    return new Response(JSON.stringify({ message: "no fetch handler registered" }), {
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
  config.borzo.enabled = true;
  config.borzo.apiKey = "";
  config.borzo.customerId = "";
  config.shadowfax.enabled = true;
  config.shadowfax.apiKey = "";
  config.shadowfax.clientCode = "";
  config.porter.enabled = true;
  config.porter.apiKey = "";
  config.porter.customerId = "";
  config.mock.borzoDispatch = true;
  config.mock.shadowfaxDispatch = true;
  config.mock.porterDispatch = false;
  config.dispatch.fareConfirmDeltaInr = 20;
  config.dispatch.quoteTimeoutMs = 6000;

  for (const k of Object.keys(savedDocs)) delete savedDocs[k];
  fetchCalls = [];
});

afterEach(() => {
  config.borzo = { ...saved.borzo };
  config.shadowfax = { ...saved.shadowfax };
  config.porter = { ...saved.porter };
  config.mock = { ...saved.mock };
});

interface FareTier {
  provider: "borzo" | "shadowfax" | "porter";
  fare: number;
}

/** The ok quotes of a real fan-out, cheapest first. */
async function rankedFares(): Promise<FareTier[]> {
  const quote = await dispatchQuote({
    pickupLat: PICKUP.lat,
    pickupLng: PICKUP.lng,
    dropLat: DROP.lat,
    dropLng: DROP.lng,
  });
  expect(quote.serviceable).toBe(true);
  const tiers: FareTier[] = quote.providers
    .filter((o: any) => o.outcome === "ok")
    .map((o: any) => ({ provider: o.provider, fare: o.fare }));
  return tiers.sort((a, b) => a.fare - b.fare);
}

/** DR7 threshold (providers/shared.fareConfirmCheck). */
function confirmThreshold(quotedFare: number): number {
  return Math.max(config.dispatch.fareConfirmDeltaInr, quotedFare * 0.1);
}

describe("savePorterManualBooking terminal guard (audit finding 1)", () => {
  // Pre-fix dispatch.router.ts:1050-1067 had no terminal guard and `delivered`
  // / `cancelled` are absent from ACTIVE_DELIVERY_STATUSES, so both
  // active-dispatch guards were skipped and the write at :1072-1076 rewinded
  // the order. Every assertion below fails on that code.
  it("409 DISPATCH_LOCKED for a paste onto a delivered order (no state rewind)", async () => {
    seedOrder("ord_paste_delivered", {
      deliveryStatus: "delivered",
      status: { code: "DELIVERED", terminal: true },
      dispatchProvider: "borzo",
      dispatchOrderId: "BRZ-ORD-424242",
      borzoOrderId: "BRZ-ORD-424242",
      riderName: "[TEST] Borzo Rider Kiran",
      needsRebook: false,
    });

    await expect(
      savePorterManualBooking({
        orderId: "ord_paste_delivered",
        porterOrderId: "POR-LATE-1",
        trackingUrl: "https://porter.in/track/POR-LATE-1",
        staffName: "Ops",
      })
    ).rejects.toMatchObject({ statusCode: 409, code: "DISPATCH_LOCKED" });

    const doc = docOf("ord_paste_delivered");
    expect(doc.deliveryStatus).toBe("delivered");
    expect(doc.dispatchProvider).toBe("borzo");
    expect(doc.dispatchOrderId).toBe("BRZ-ORD-424242");
    expect(doc.porterOrderId).toBeUndefined();
    expect(doc.dispatchStatus).toBeUndefined();
    // The rented delivery mirror was rewritten to { provider: porter,
    // status: "pending" } by the old write.
    expect(doc.delivery).toBeUndefined();
    expect(keysWithPrefix("dispatch_order_map/")).toHaveLength(0);
    expect(keysWithPrefix("porter_order_map/")).toHaveLength(0);
  });

  it("409 DISPATCH_LOCKED for a paste onto a cancelled order (no state rewind)", async () => {
    seedOrder("ord_paste_cancelled", {
      deliveryStatus: "cancelled",
      status: { code: "CANCELLED", terminal: true },
      cancelledBy: "Ops",
      needsRebook: true,
      rebookTrigger: "carrier_cancelled",
    });

    await expect(
      savePorterManualBooking({
        orderId: "ord_paste_cancelled",
        porterOrderId: "POR-LATE-2",
      })
    ).rejects.toMatchObject({ statusCode: 409, code: "DISPATCH_LOCKED" });

    const doc = docOf("ord_paste_cancelled");
    expect(doc.deliveryStatus).toBe("cancelled");
    // The old write also cleared the rebook trail and the cancelled timestamp.
    expect(doc.needsRebook).toBe(true);
    expect(doc.rebookTrigger).toBe("carrier_cancelled");
    expect(doc.porterOrderId).toBeUndefined();
    expect(doc.dispatchStatus).toBeUndefined();
    expect(keysWithPrefix("dispatch_order_map/")).toHaveLength(0);
    expect(keysWithPrefix("porter_order_map/")).toHaveLength(0);
  });
});

describe("DR7 fare-confirm gate measures the committed provider's fare (audit finding 2)", () => {
  // Pre-fix the gate compared params.quotedFare against ranked[0].fare (:540-545)
  // while preferredProvider reordered the walk at :563-568 and the loop booked
  // walk[0] at :582-585 — so the confirmation was computed against a provider
  // that is never called.
  it("requires confirmation when the preferred provider is not the cheapest", async () => {
    const tiers = await rankedFares();
    expect(tiers.length).toBeGreaterThanOrEqual(2);
    const cheapest = tiers[0];
    const dearest = tiers[tiers.length - 1];
    expect(dearest.provider).not.toBe(cheapest.provider);
    // The mock harness books borzo/shadowfax via API; an unkeyed Porter only
    // reaches the DR8 manual lane, which is not the path under test.
    expect(["borzo", "shadowfax"]).toContain(dearest.provider);
    const threshold = confirmThreshold(cheapest.fare);
    // Scenario precondition: quoting the cheapest fare while preferring the
    // dearest provider must be a confirm-worthy delta.
    expect(dearest.fare - cheapest.fare).toBeGreaterThanOrEqual(threshold);

    seedOrder("ord_pref_confirm");
    const pending = await dispatchBook({
      orderId: "ord_pref_confirm",
      quotedFare: cheapest.fare,
      preferredProvider: dearest.provider,
    });

    // The old code let this through: delta 0 against ranked[0] (the cheapest),
    // so it booked the dearer provider with no staff sign-off.
    expect(pending).toMatchObject({
      needsFareConfirm: true,
      provider: dearest.provider,
      quotedFare: cheapest.fare,
      newFare: dearest.fare,
      confirmEndpoint: "/dispatch/book",
    });
    expect(pending.delta).toBeCloseTo(dearest.fare - cheapest.fare, 5);
    expect(pending.threshold).toBeCloseTo(threshold, 5);

    const pendingDoc = docOf("ord_pref_confirm");
    expect(pendingDoc.deliveryStatus).toBeUndefined(); // nothing committed
    expect(pendingDoc.dispatchStatus).toBeNull(); // claim released for the retry
    expect(pendingDoc.dispatchQuote).toBeTruthy();

    // The confirmed retry commits the fare that was confirmed — the provider
    // the confirm card named, not the fan-out cheapest.
    const booked = await dispatchBook({
      orderId: "ord_pref_confirm",
      quotedFare: pending.newFare,
      preferredProvider: dearest.provider,
      confirmFare: true,
    });
    expect(booked).toMatchObject({ provider: dearest.provider, status: "dispatched" });
    expect(booked.attempts).toHaveLength(1);
    expect(booked.attempts[0]).toMatchObject({ provider: dearest.provider, outcome: "booked" });

    const bookedDoc = docOf("ord_pref_confirm");
    expect(bookedDoc.dispatchProvider).toBe(dearest.provider);
    expect(bookedDoc.deliveryStatus).toBe("dispatched");
    // The persisted quote snapshot still records the fan-out winner (the
    // cheapest) — proof the booking went to the dearer preferred provider.
    expect(bookedDoc.dispatchQuote.winner).toBe(cheapest.provider);
  });

  it("cannot confirm against a provider its own exclusions drop (auto-rebook walk)", async () => {
    const tiers = await rankedFares();
    expect(tiers.length).toBeGreaterThanOrEqual(3);
    const cheapest = tiers[0];
    const dearest = tiers[tiers.length - 1];
    // What the auto-rebook worker passes: every provider that already owned —
    // and dropped — this dispatch (excludedProvidersFor).
    const excluded = tiers.slice(0, -1).map((t) => t.provider);
    const threshold = confirmThreshold(cheapest.fare);
    expect(excluded).toContain(cheapest.provider);
    expect(["borzo", "shadowfax"]).toContain(dearest.provider);
    expect(dearest.fare - cheapest.fare).toBeGreaterThanOrEqual(threshold);

    seedOrder("ord_excluded_confirm");
    const pending = await dispatchBook({
      orderId: "ord_excluded_confirm",
      quotedFare: cheapest.fare,
      excludeProviders: excluded,
    });

    // Pre-fix: the excluded cheapest provider's own fare satisfied the gate
    // (delta 0), the exclusions were applied afterwards, and the surviving
    // provider was booked unconfirmed — the order below read "dispatched".
    expect(pending).toMatchObject({
      needsFareConfirm: true,
      provider: dearest.provider,
      newFare: dearest.fare,
    });
    const pendingDoc = docOf("ord_excluded_confirm");
    expect(pendingDoc.deliveryStatus).toBeUndefined();
    expect(pendingDoc.dispatchStatus).toBeNull();

    const booked = await dispatchBook({
      orderId: "ord_excluded_confirm",
      quotedFare: pending.newFare,
      excludeProviders: excluded,
      confirmFare: true,
    });
    expect(booked).toMatchObject({ provider: dearest.provider, status: "dispatched" });
    expect(booked.attempts).toHaveLength(1);
    expect(booked.attempts[0].provider).toBe(dearest.provider); // never an excluded one
    expect(fetchCalls).toHaveLength(0); // mocked fan-out + mocked books only

    const bookedDoc = docOf("ord_excluded_confirm");
    expect(bookedDoc.dispatchProvider).toBe(dearest.provider);
    expect(bookedDoc.deliveryStatus).toBe("dispatched");
  });
});
