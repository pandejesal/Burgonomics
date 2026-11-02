import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";

/**
 * Regression: `dispatchBook` claims the order FIRST (claimDispatch writes
 * `dispatchStatus: "dispatch_pending"` + a 10-minute lease), then runs the quote
 * fan-out. `runQuoteFanOut` guards the adapter CALLS with allSettled, but the
 * cheap `ADAPTERS.filter((a) => a.isEligible())` sits OUTSIDE that guard. An
 * adapter whose isEligible throws (bad config shape, a half-loaded credential
 * object, a future adapter bug) therefore rejected the whole fan-out AFTER the
 * claim was taken and BEFORE any release path - the order was left
 * `dispatch_pending` for the full TTL, so every staff retry got a 202/409
 * "dispatch already in progress" and the only exit was the stale-claim sweep
 * parking it for manual reconciliation.
 *
 * Fix: an eligibility check that throws is treated as an INELIGIBLE provider
 * (skipped, logged), exactly like a quote that throws is a failed outcome. The
 * claim is then released/consumed by the normal paths.
 *
 * The double below records every order-doc write so the lease state is asserted
 * directly, and no provider is contacted (global fetch is stubbed).
 */

const { mockDb, savedDocs } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  const mergeSet = (col: string, id: string, data: any) => {
    savedDocs[col + "/" + id] = { ...(savedDocs[col + "/" + id] || {}), ...data };
  };
  const baseOrder = () => ({
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
    // CUS-16: a live capture marker, otherwise booking refuses up front.
    paymentChannel: "razorpay",
    paymentStatus: "completed",
    payment: { status: "completed", razorpayPaymentId: "pay_t1" },
  });
  const readDoc = (col: string, id: string) => ({
    exists: true,
    id,
    data: () => savedDocs[col + "/" + id] || baseOrder(),
    ref: { id, get: vi.fn(async () => readDoc(col, id)), set: vi.fn(async (d: any) => mergeSet(col, id, d)) },
  });
  const mockDb: any = {
    collection: (col: string) => ({
      doc: (id: string) => ({
        id,
        set: vi.fn(async (data: any) => mergeSet(col, id, data)),
        get: vi.fn(async () => readDoc(col, id)),
      }),
      where: () => ({ limit: () => ({ get: async () => ({ empty: true, docs: [] }) }) }),
    }),
    runTransaction: vi.fn(async (fn: any) =>
      fn({
        get: (ref: any) => ref.get(),
        set: (ref: any, data: any, opts?: any) => ref.set(opts?.merge ? data : data),
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

const providerState = vi.hoisted(() => ({ throwOnEligible: false }));

// Replace the real adapters with one healthy mock-rate-card provider and one
// whose eligibility check throws - the exact class under test.
vi.mock("../src/modules/dispatch/providers/borzo.adapter", () => ({
  borzoAdapter: {
    provider: "borzo",
    isEligible: () => {
      if (providerState.throwOnEligible) throw new Error("config exploded");
      return false;
    },
    quote: async () => {
      throw new Error("not used");
    },
    book: async () => {
      throw new Error("not used");
    },
  },
}));
vi.mock("../src/modules/dispatch/providers/shadowfax.adapter", () => ({
  shadowfaxAdapter: {
    provider: "shadowfax",
    isEligible: () => false,
    quote: async () => {
      throw new Error("not used");
    },
    book: async () => {
      throw new Error("not used");
    },
  },
}));
vi.mock("../src/modules/dispatch/providers/porter.adapter", () => ({
  porterAdapter: {
    provider: "porter",
    isEligible: () => true,
    quote: async () => ({
      provider: "porter",
      outcome: "ok",
      fare: 42,
      distanceKm: 3.1,
      pickupEtaMinutes: 7,
      quoteId: "QTE-TEST-1",
      expiresAt: Date.now() + 300_000,
      source: "rate_card",
    }),
    book: async () => ({
      kind: "booked",
      provider: "porter",
      providerOrderId: "PTEST-1",
      riderName: "Rider",
      riderPhone: "+919000000000",
      riderVehicleNumber: "GJ01AB1234",
      trackingUrl: "",
      source: "api",
      geoSource: "live_gps",
    }),
  },
}));

import { dispatchBook } from "../src/modules/dispatch/dispatch.router";

const originalFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = vi.fn(async () => new Response("{}", { status: 404 })) as any;
});
afterAll(() => {
  globalThis.fetch = originalFetch;
});

describe("dispatchBook - a throwing eligibility check must not strand the claim", () => {
  beforeEach(() => {
    for (const key of Object.keys(savedDocs)) delete savedDocs[key];
    providerState.throwOnEligible = false;
    savedDocs["orders/ord_elig"] = {
      branchId: "branch_ahmedabad_1",
      branchName: "Burgonomics CG Road",
      // Real orders carry the branch's own number as `store.phone` (a required
      // field of the client's OrderStoreSnapshot); dispatch resolves the pickup
      // contact before any claim, so a fixture without it is not a real order.
      store: { name: "Burgonomics CG Road", phone: "+91 98250 12345" },
      branchCoordinates: { lat: 23.0131, lng: 72.5085 },
      deliveryAddress: { full: "Vastrapur", lat: 23.0338, lng: 72.5262 },
      customerPhone: "+91 99999 88888",
      customerName: "Aarav Shah",
      status: "ready",
      paymentChannel: "razorpay",
      paymentStatus: "completed",
      payment: { status: "completed", razorpayPaymentId: "pay_t1" },
    };
  });

  it("still books via the healthy provider when another adapter's isEligible throws", async () => {
    providerState.throwOnEligible = true;
    const result = await dispatchBook({ orderId: "ord_elig", staffName: "Tester" });
    expect(result.status).toBe("dispatched");
    expect(result.provider).toBe("porter");
  });

  it("leaves no dispatch_pending lease behind after that booking", async () => {
    providerState.throwOnEligible = true;
    await dispatchBook({ orderId: "ord_elig", staffName: "Tester" });
    const order = savedDocs["orders/ord_elig"];
    // The successful book settles the claim; it must never remain "pending".
    expect(order.dispatchStatus).toBe("dispatched");
    expect(order.dispatchClaimedAt).toBeNull();
  });
});
