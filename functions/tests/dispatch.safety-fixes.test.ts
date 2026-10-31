import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";

/**
 * Regressions for the 2026-10-24 dispatch safety sweep:
 *
 *   F1  Porter ambiguity/timeout must NOT fail over to a second carrier
 *       (Porter 200-with-no-order-id included).
 *   F4  A customer-cancel containment (dispatchStatus "dispatched" +
 *       deliveryStatus "needs_review" + an old binding) must not make
 *       dispatchRebook replay the dead rider: it must perform a REAL book.
 *   F10 A crash after the provider booked but before the success write leaves
 *       only an expired `dispatch_pending` lease; retrying it, or sweeping it
 *       as "retryable", would book a second rider. It must park
 *       needs_reconciliation and make zero provider POSTs.
 *   F12 Borzo's generic `canceled` status carries the vendor's reason_text:
 *       customer/client cancellations, returned parcels and unclassifiable
 *       reasons are manual review (needsRebook=false); only an explicit
 *       carrier-side cause keeps the auto-rebook flow.
 *   F15 A booking whose provider id is not a safe Firestore doc id must alert
 *       instead of silently skipping `dispatch_order_map`.
 *
 * No live provider calls: every wire call is a stubbed fetch.
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
  // Refreshable, STRICT snapshot: a doc that was never written does NOT exist
  // (the F10 evidence read must be able to prove "no provider stamp").
  const readDoc: any = (colName: string, docId: string) => {
    const key = `${colName}/${docId}`;
    const raw = savedDocs[key];
    return {
      exists: raw !== undefined,
      id: docId,
      data: () => raw,
      ref: {
        id: docId,
        get: vi.fn(async () => readDoc(colName, docId)),
        set: vi.fn(async (data: any) => mergeSet(colName, docId, data)),
      },
    } as any;
  };
  const docRef: any = (colName: string, docId: string) => ({
    id: docId,
    get: vi.fn(async () => readDoc(colName, docId)),
    set: vi.fn(async (data: any) => mergeSet(colName, docId, data)),
  });
  const mockDb: any = {
    collection: (colName: string) => ({
      doc: (docId: string) => docRef(colName, docId),
      where: (field: string, op: string, val: any) => ({
        limit: (n: number) => ({
          get: async () => {
            // Minimal equality-only query over the seeded orders (the module
            // only ever issues single-field equality scans).
            const docs = Object.keys(savedDocs)
              .filter((k) => k.startsWith(`${colName}/`))
              .map((k) => {
                const id = k.slice(colName.length + 1);
                return {
                  id,
                  data: () => savedDocs[k],
                  ref: docRef(colName, id),
                };
              })
              .filter((d) => (op === "==" ? d.data()?.[field] === val : true))
              .slice(0, n);
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
  return {
    ...actual,
    captureErrorSnapshot: vi.fn(async () => "err_test_snapshot"),
  };
});

vi.mock("../src/modules/notifications/fcm.service", () => ({
  dispatchFCM: vi.fn(async () => undefined),
}));

// The unavailable/ambiguous Porter shapes are produced by porter.service; the
// adapter must translate them into a NON-walkable error. Mocking the service
// lets us simulate "Porter accepted but gave no id" without a live call.
vi.mock("../src/modules/porter/porter.service", () => ({
  getDeliveryQuote: vi.fn(),
  bookPorterRider: vi.fn(),
}));

import {
  dispatchBook,
  dispatchRebook,
  sweepStaleDispatchClaims,
  STALE_CLAIM_SWEEP_LIMIT,
} from "../src/modules/dispatch/dispatch.router";
import { porterAdapter } from "../src/modules/dispatch/providers/porter.adapter";
import { isProviderDispatchError } from "../src/modules/dispatch/types";
import { handleDispatchWebhook } from "../src/modules/dispatch/dispatch.webhooks";
import { dispatchFCM } from "../src/modules/notifications/fcm.service";
import { captureErrorSnapshot } from "../src/core/errors";
import { computeHmacSha256 } from "../src/core/security";
import { getDeliveryQuote, bookPorterRider } from "../src/modules/porter/porter.service";
import { config } from "../src/config/env";

const BORZO_WEBHOOK_SECRET = "test_borzo_whsec_vitest_only";
const PICKUP = { lat: 23.0131, lng: 72.5085 };
const DROP = { lat: 23.0338, lng: 72.5262 };

const okJson = (data: any, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const originalFetch = globalThis.fetch;
let fetchCalls: Array<{ url: string; init: any }> = [];
let fetchHandler: ((url: string, init: any) => Response) | null = null;
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
    dispatch: { ...config.dispatch },
  };
  // Deterministic field: Borzo is the only live carrier unless a test says
  // otherwise. Shadowfax is off (its live path needs the contract flag).
  config.borzo.enabled = true;
  config.borzo.apiKey = "k_borzo_test";
  config.borzo.customerId = "c_borzo_test";
  config.borzo.webhookSecret = BORZO_WEBHOOK_SECRET;
  config.mock.borzoDispatch = false;
  config.shadowfax.enabled = false;
  config.shadowfax.apiKey = "";
  config.shadowfax.clientCode = "";
  config.shadowfax.webhookSecret = "";
  config.shadowfax.contractVerified = false;
  config.mock.shadowfaxDispatch = false;
  config.porter.enabled = false;
  config.porter.apiKey = "";
  config.porter.customerId = "";
  config.porter.webhookSecret = "";
  config.mock.porterDispatch = false;
  config.dispatch.fareConfirmDeltaInr = 20;
  config.dispatch.quoteTimeoutMs = 6000;
  config.dispatch.requireLive = false;

  for (const k of Object.keys(savedDocs)) delete savedDocs[k];
  fetchCalls = [];
  fetchHandler = null;
  vi.clearAllMocks();
});

afterEach(() => {
  config.borzo = { ...saved.borzo };
  config.shadowfax = { ...saved.shadowfax };
  config.porter = { ...saved.porter };
  config.mock = { ...saved.mock };
  config.dispatch = { ...saved.dispatch };
});

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
          points: [{ tracking_url: `https://track.borzodelivery.com/t/${providerOrderId}` }],
        },
      });
    }
    return okJson({ message: "not found" }, 404);
  };
}

function useKeyedPorter() {
  config.porter.enabled = true;
  config.porter.apiKey = "porter_key_test";
  config.porter.customerId = "porter_customer_test";
  config.porter.webhookSecret = "porter_whsec_test";
  config.mock.porterDispatch = false;
  vi.mocked(getDeliveryQuote).mockImplementation(async () => ({
    estimatedFare: 55,
    estimatedDistanceKm: 2.1,
    estimatedPickupMinutes: 4,
    quoteId: "QTE-PRTR-TEST-1",
    expiresAt: Date.now() + 600_000,
    source: "porter_api_live",
    etaEstimated: false,
  }));
}

const createOrderCalls = () =>
  fetchCalls.filter((c) => c.url.includes("/create-order")).length;

describe("F1 — Porter uncertain acceptance never books a second carrier", () => {
  it("Porter 200-with-no-order-id parks needs_reconciliation and makes zero further POSTs", async () => {
    useKeyedPorter();
    borzoWire("BZ-SHOULD-NOT-BOOK");
    vi.mocked(bookPorterRider).mockResolvedValue({} as any); // 2xx, no order id
    seedOrder("ord_f1_noid");

    await expect(
      dispatchBook({ orderId: "ord_f1_noid", preferredProvider: "porter", staffName: "Ops" })
    ).rejects.toMatchObject({
      statusCode: 502,
      code: "PROVIDER_BOOK_AMBIGUOUS",
    });

    // The ranked walk stopped at Porter: no Borzo create-order was ever sent.
    expect(createOrderCalls()).toBe(0);
    const doc = docOf("ord_f1_noid");
    expect(doc.dispatchStatus).toBe("needs_reconciliation");
    expect(doc.deliveryStatus).toBeUndefined(); // nothing was presented as booked
    expect(doc.dispatchOrderId).toBeUndefined();
    expect(doc.needsRebook).toBe(false);
    expect(doc.rebookTrigger).toBeNull();
    expect(doc.dispatchError).toMatch(/no order id|ambiguous/i);
    expect(doc.dispatchAttempts).toEqual([
      expect.objectContaining({ provider: "porter", outcome: "error" }),
    ]);
  });

  it("Porter create-order timeout/abort is ambiguous, not a walkable transient failure", async () => {
    useKeyedPorter();
    borzoWire("BZ-SHOULD-NOT-BOOK");
    vi.mocked(bookPorterRider).mockRejectedValue(
      new Error("The operation was aborted due to timeout")
    );
    seedOrder("ord_f1_timeout");

    let thrown: any;
    try {
      await dispatchBook({ orderId: "ord_f1_timeout", preferredProvider: "porter" });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toMatchObject({ code: "PROVIDER_BOOK_AMBIGUOUS" });
    // The adapter contract the router relies on: NOT a ProviderDispatchError.
    expect(isProviderDispatchError(thrown)).toBe(false);
    expect(createOrderCalls()).toBe(0);

    const doc = docOf("ord_f1_timeout");
    expect(doc.dispatchStatus).toBe("needs_reconciliation");
    expect(doc.needsRebook).toBe(false);
    expect(doc.dispatchAttempts).toEqual([
      expect.objectContaining({ provider: "porter", outcome: "error" }),
    ]);
  });

  it("adapter-level: PROVIDER_BOOK_AMBIGUOUS from the Porter service is re-thrown as a plain error", async () => {
    useKeyedPorter();
    const ambiguous: any = new Error("Porter create-order returned no order id");
    ambiguous.statusCode = 502;
    ambiguous.code = "PROVIDER_BOOK_AMBIGUOUS";
    vi.mocked(bookPorterRider).mockRejectedValue(ambiguous);

    const quote = {
      provider: "porter" as const,
      outcome: "ok" as const,
      fare: 55,
      distanceKm: 2.1,
      pickupEtaMinutes: 4,
      quoteId: "QTE-PRTR-TEST-1",
      expiresAt: Date.now() + 600_000,
      source: "porter_api_live",
    };

    let adapterErr: any;
    try {
      await porterAdapter.book({
        orderId: "ord_adapter_ambig",
        order: defaultOrder(),
        pickup: PICKUP,
        drop: DROP,
        quote,
      });
    } catch (err) {
      adapterErr = err;
    }
    expect(adapterErr).toBeTruthy();
    expect(isProviderDispatchError(adapterErr)).toBe(false);
  });

  it("CONTROL: a genuine Porter 5xx still walks to the next provider", async () => {
    useKeyedPorter();
    borzoWire("BZ-REAL-BOOK");
    vi.mocked(bookPorterRider).mockRejectedValue(new Error("Porter order dispatch rejected (HTTP 503)"));
    seedOrder("ord_f1_control");

    const res = await dispatchBook({ orderId: "ord_f1_control", preferredProvider: "porter" });
    expect(res.provider).toBe("borzo");
    expect(res.providerOrderId).toBe("BZ-REAL-BOOK");
    expect(res.failover).toMatchObject({ from: "porter", to: "borzo" });
    expect(docOf("ord_f1_control").dispatchStatus).toBe("dispatched");
  });
});

describe("F4 — a customer-cancel containment can be rebooked for real", () => {
  it("dispatchRebook on dispatchStatus 'dispatched' + deliveryStatus 'needs_review' books a FRESH carrier", async () => {
    borzoWire("BZ-FRESH-9001");
    // Exactly what dispatch.webhooks.ts leaves behind after a customer cancel:
    // the dead binding stays for reconciliation, deliveryStatus needs_review.
    seedOrder("ord_f4_rebook", {
      deliveryStatus: "needs_review",
      dispatchStatus: "dispatched",
      dispatchProvider: "borzo",
      dispatchOrderId: "BZ-DEAD-1111",
      borzoOrderId: "BZ-DEAD-1111",
      needsRebook: false,
      rebookTrigger: "customer_cancelled",
    });

    const res = await dispatchRebook({ orderId: "ord_f4_rebook", staffName: "Rebook Staff" });

    // A real create-order went out and the new booking owns the order.
    expect(createOrderCalls()).toBe(1);
    expect(res).toMatchObject({
      provider: "borzo",
      providerOrderId: "BZ-FRESH-9001",
      status: "dispatched",
      reused: false,
    });

    const doc = docOf("ord_f4_rebook");
    expect(doc.dispatchStatus).toBe("dispatched");
    expect(doc.deliveryStatus).toBe("dispatched");
    expect(doc.dispatchOrderId).toBe("BZ-FRESH-9001");
    expect(doc.borzoOrderId).toBe("BZ-FRESH-9001");
    expect(doc.needsRebook).toBe(false);
    expect(doc.rebookTrigger).toBeNull();
    expect(doc.dispatchedBy).toBe("Rebook Staff");
    expect(savedDocs["dispatch_order_map/BZ-FRESH-9001"]).toMatchObject({
      orderId: "ord_f4_rebook",
      provider: "borzo",
    });
  });

  it("CONTROL: a genuinely live booking (dispatched, no review flag) is still reused, zero POSTs", async () => {
    borzoWire("BZ-NEVER-USED");
    seedOrder("ord_f4_live", {
      deliveryStatus: "dispatched",
      dispatchStatus: "dispatched",
      dispatchProvider: "borzo",
      dispatchOrderId: "BZ-LIVE-2222",
    });

    const res = await dispatchBook({ orderId: "ord_f4_live" });
    expect(res).toMatchObject({ reused: true, providerOrderId: "BZ-LIVE-2222" });
    expect(createOrderCalls()).toBe(0);
  });
});

describe("F10 — a stale dispatch_pending lease with provider evidence parks, never rebooks", () => {
  it("claimed 11 minutes ago + a correlation row naming the provider => 409 reconciliation, zero POSTs", async () => {
    borzoWire("BZ-SHOULD-NOT-BOOK");
    const token = "cr_f10_stale_1";
    seedOrder("ord_f10_stale", {
      dispatchStatus: "dispatch_pending",
      dispatchClaimedAt: Date.now() - 11 * 60 * 1000,
      dispatchGeneration: 2,
      dispatchPendingCorrelation: {
        token,
        generation: 2,
        orderId: "ord_f10_stale",
        branchId: "branch_ahmedabad_1",
        provider: null,
      },
    });
    savedDocs[`dispatch_correlation_map/${token}`] = {
      orderId: "ord_f10_stale",
      generation: 2,
      provider: "borzo", // stamped immediately before the create-order POST
      status: "pending",
    };

    await expect(dispatchBook({ orderId: "ord_f10_stale" })).rejects.toMatchObject({
      statusCode: 409,
      code: "DISPATCH_RECONCILIATION_REQUIRED",
    });

    expect(createOrderCalls()).toBe(0);
    const doc = docOf("ord_f10_stale");
    expect(doc.dispatchStatus).toBe("needs_reconciliation");
    expect(doc.dispatchClaimedAt).toBeNull();
    expect(doc.needsRebook).toBe(false);
    expect(doc.rebookTrigger).toBeNull();
    expect(doc.dispatchError).toMatch(/never completed|reconcile/i);
  });

  it("CONTROL: an expired lease with NO provider stamp (crash before POST) is still retryable", async () => {
    borzoWire("BZ-RETRY-OK");
    const token = "cr_f10_noevidence_1";
    seedOrder("ord_f10_clean", {
      dispatchStatus: "dispatch_pending",
      dispatchClaimedAt: Date.now() - 11 * 60 * 1000,
      dispatchGeneration: 1,
      dispatchPendingCorrelation: {
        token,
        generation: 1,
        orderId: "ord_f10_clean",
        branchId: "branch_ahmedabad_1",
        provider: null,
      },
    });
    savedDocs[`dispatch_correlation_map/${token}`] = {
      orderId: "ord_f10_clean",
      generation: 1,
      status: "pending",
      // no `provider` — no provider POST was started
    };

    const res = await dispatchBook({ orderId: "ord_f10_clean" });
    expect(res).toMatchObject({ provider: "borzo", providerOrderId: "BZ-RETRY-OK" });
    expect(docOf("ord_f10_clean").dispatchStatus).toBe("dispatched");
  });

  it("sweep parks only evidence-backed expired leases (fresh + no-evidence untouched)", async () => {
    borzoWire("BZ-SWEEP-NEVER");
    const staleToken = "cr_f10_sweep_stale";
    seedOrder("ord_sweep_stale", {
      dispatchStatus: "dispatch_pending",
      dispatchClaimedAt: Date.now() - 11 * 60 * 1000,
      dispatchGeneration: 1,
      dispatchPendingCorrelation: { token: staleToken, generation: 1, orderId: "ord_sweep_stale" },
    });
    savedDocs[`dispatch_correlation_map/${staleToken}`] = {
      orderId: "ord_sweep_stale",
      provider: "shadowfax",
      status: "pending",
    };

    const cleanToken = "cr_f10_sweep_clean";
    seedOrder("ord_sweep_clean", {
      dispatchStatus: "dispatch_pending",
      dispatchClaimedAt: Date.now() - 11 * 60 * 1000,
      dispatchGeneration: 1,
      dispatchPendingCorrelation: { token: cleanToken, generation: 1, orderId: "ord_sweep_clean" },
    });
    savedDocs[`dispatch_correlation_map/${cleanToken}`] = {
      orderId: "ord_sweep_clean",
      status: "pending",
    };

    seedOrder("ord_sweep_fresh", {
      dispatchStatus: "dispatch_pending",
      dispatchClaimedAt: Date.now() - 5_000,
      dispatchGeneration: 1,
    });

    const result = await sweepStaleDispatchClaims();

    expect(result.scanned).toBe(3);
    expect(result.parked).toBe(1);
    expect(STALE_CLAIM_SWEEP_LIMIT).toBeGreaterThan(0);

    const stale = docOf("ord_sweep_stale");
    expect(stale.dispatchStatus).toBe("needs_reconciliation");
    expect(stale.needsRebook).toBe(false);
    expect(stale.dispatchClaimedAt).toBeNull();

    expect(docOf("ord_sweep_clean").dispatchStatus).toBe("dispatch_pending");
    expect(docOf("ord_sweep_fresh").dispatchStatus).toBe("dispatch_pending");
    expect(createOrderCalls()).toBe(0);

    expect(
      vi
        .mocked(captureErrorSnapshot)
        .mock.calls.some((c: any[]) => /Stale dispatch claim/.test(String(c[0]?.message)))
    ).toBe(true);
  });
});

describe("F12 — Borzo cancellation cause comes from reason_text, not the umbrella status", () => {
  function seedBorzoBound(orderId: string, providerOrderId: string) {
    seedOrder(orderId, {
      deliveryStatus: "dispatched",
      dispatchStatus: "dispatched",
      dispatchProvider: "borzo",
      dispatchOrderId: providerOrderId,
      borzoOrderId: providerOrderId,
    });
    savedDocs[`dispatch_order_map/${providerOrderId}`] = {
      orderId,
      provider: "borzo",
      branchId: "branch_ahmedabad_1",
    };
  }

  async function borzoCancel(orderId: string, providerOrderId: string, payload: any) {
    const body = { delivery: { ...payload, order_id: providerOrderId } };
    const raw = JSON.stringify(body);
    await handleDispatchWebhook(
      "borzo",
      raw,
      computeHmacSha256(raw, BORZO_WEBHOOK_SECRET),
      body
    );
  }

  it("'Client cancelled the delivery' => needs_review, needsRebook false, customer cause, no rebook alert", async () => {
    seedBorzoBound("ord_f12_client", "BZ-F12-CLIENT");
    await borzoCancel("ord_f12_client", "BZ-F12-CLIENT", {
      status: "canceled",
      reason_text: "Client cancelled the delivery",
    });

    const doc = docOf("ord_f12_client");
    expect(doc.deliveryStatus).toBe("needs_review");
    expect(doc.needsRebook).toBe(false);
    expect(doc.rebookTrigger).toBe("customer_cancelled");
    expect(doc.riderCancellationReason).toBe("Client cancelled the delivery");

    const fcm = vi.mocked(dispatchFCM);
    const manual = fcm.mock.calls.filter((c: any[]) => c[0]?.data?.type === "dispatch_manual_review");
    expect(manual).toHaveLength(1);
    expect(
      fcm.mock.calls.filter((c: any[]) => c[0]?.data?.type === "rider_cancelled")
    ).toHaveLength(0);
  });

  it("'Returned to seller' => needs_review with the returned cause, never auto-rebook", async () => {
    seedBorzoBound("ord_f12_returned", "BZ-F12-RETURNED");
    await borzoCancel("ord_f12_returned", "BZ-F12-RETURNED", {
      status: "canceled",
      reason_text: "Parcel returned to seller",
    });

    const doc = docOf("ord_f12_returned");
    expect(doc.deliveryStatus).toBe("needs_review");
    expect(doc.needsRebook).toBe(false);
    expect(doc.rebookTrigger).toBe("returned_to_seller");
  });

  it("an unclassifiable reason ALSO avoids auto-rebook (cancellation_unverified)", async () => {
    seedBorzoBound("ord_f12_unknown", "BZ-F12-UNKNOWN");
    await borzoCancel("ord_f12_unknown", "BZ-F12-UNKNOWN", {
      status: "canceled",
      reason_text: "status updated by provider ops",
    });

    const doc = docOf("ord_f12_unknown");
    expect(doc.deliveryStatus).toBe("needs_review");
    expect(doc.needsRebook).toBe(false);
    expect(doc.rebookTrigger).toBe("cancellation_unverified");

    const fcm = vi.mocked(dispatchFCM);
    expect(
      fcm.mock.calls.filter((c: any[]) => c[0]?.data?.type === "rider_cancelled")
    ).toHaveLength(0);
    expect(
      fcm.mock.calls.filter((c: any[]) => c[0]?.data?.type === "dispatch_manual_review")
    ).toHaveLength(1);
  });

  it("POSITIVE CONTROL: an explicit carrier reason ('No riders available') keeps auto-rebook", async () => {
    seedBorzoBound("ord_f12_carrier", "BZ-F12-CARRIER");
    await borzoCancel("ord_f12_carrier", "BZ-F12-CARRIER", {
      status: "canceled",
      reason_text: "No riders available",
    });

    const doc = docOf("ord_f12_carrier");
    expect(doc.deliveryStatus).toBe("rider_cancelled");
    expect(doc.needsRebook).toBe(true);
    expect(doc.rebookTrigger).toBe("carrier_cancelled");
    expect(
      vi.mocked(dispatchFCM).mock.calls.filter((c: any[]) => c[0]?.data?.type === "rider_cancelled")
    ).toHaveLength(1);
  });
});

describe("F15 — an unsafe provider id is alerted, never silently skipped", () => {
  it("booking still succeeds but dispatch_order_map is skipped WITH an error snapshot", async () => {
    borzoWire("../unsafe/id");
    seedOrder("ord_f15_unsafe");

    const res = await dispatchBook({ orderId: "ord_f15_unsafe", staffName: "Ops" });

    expect(res.provider).toBe("borzo");
    expect(res.providerOrderId).toBe("../unsafe/id");
    expect(docOf("ord_f15_unsafe").dispatchStatus).toBe("dispatched");

    // No Firestore doc can be written at that path.
    expect(keysWithPrefix("dispatch_order_map/")).toHaveLength(0);

    // ...and the operator hears about it at book time instead of days later.
    const alerts = vi.mocked(captureErrorSnapshot).mock.calls;
    const hit = alerts.find((c: any[]) => /UNSAFE provider order id/.test(String(c[0]?.message)));
    expect(hit).toBeTruthy();
    expect(hit![0]).toMatchObject({
      source: "dispatch",
      severity: "high",
      orderId: "ord_f15_unsafe",
    });
  });

  it("CONTROL: a safe provider id writes the map and raises no unsafe-id alert", async () => {
    borzoWire("BZ-SAFE-1234");
    seedOrder("ord_f15_safe");

    await dispatchBook({ orderId: "ord_f15_safe" });
    expect(savedDocs["dispatch_order_map/BZ-SAFE-1234"]).toMatchObject({
      orderId: "ord_f15_safe",
      provider: "borzo",
    });
    expect(
      vi
        .mocked(captureErrorSnapshot)
        .mock.calls.some((c: any[]) => /UNSAFE provider order id/.test(String(c[0]?.message)))
    ).toBe(false);
  });
});
