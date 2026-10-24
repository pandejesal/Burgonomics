import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";

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
    const raw = savedDocs[`${colName}/${docId}`];
    const snap: any = {
      exists: raw !== undefined,
      id: docId,
      data: () => raw || defaultOrder(),
      ref: {
        id: docId,
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
  return {
    ...actual,
    captureErrorSnapshot: vi.fn(async () => "err_test_snapshot"),
  };
});

import { dispatchBook } from "../src/modules/dispatch/dispatch.router";
import { handleDispatchWebhook } from "../src/modules/dispatch/dispatch.webhooks";
import { computeHmacSha256 } from "../src/core/security";
import { config } from "../src/config/env";

const TEST_BORZO_WEBHOOK_SECRET = "test_borzo_whsec_vitest_only";
const TEST_SFX_WEBHOOK_SECRET = "test_sfx_shared_secret_vitest_only";

function borzoSig(body: string): string {
  return computeHmacSha256(body, TEST_BORZO_WEBHOOK_SECRET);
}

function sfxSig(body: string): string {
  return TEST_SFX_WEBHOOK_SECRET;
}

const originalFetch = globalThis.fetch;
let fetchCalls: Array<{ url: string; init: any }> = [];
let saved: any = {};

beforeAll(() => {
  globalThis.fetch = vi.fn(async (url: any, init: any) => {
    fetchCalls.push({ url: String(url), init });
    return new Response(JSON.stringify({ message: "no fetch handler" }), {
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
  config.borzo.apiKey = "k_borzo";
  config.borzo.customerId = "c_borzo";
  config.borzo.webhookSecret = TEST_BORZO_WEBHOOK_SECRET;
  config.shadowfax.enabled = true;
  config.shadowfax.apiKey = "k_sfx";
  config.shadowfax.clientCode = "c_sfx";
  config.shadowfax.webhookSecret = TEST_SFX_WEBHOOK_SECRET;
  config.mock.borzoDispatch = false;
  config.mock.shadowfaxDispatch = false;
  config.mock.porterDispatch = false;

  for (const k of Object.keys(savedDocs)) delete savedDocs[k];
  fetchCalls = [];
  vi.clearAllMocks();
});

afterEach(() => {
  config.borzo = { ...saved.borzo };
  config.shadowfax = { ...saved.shadowfax };
  config.porter = { ...saved.porter };
  config.mock = { ...saved.mock };
});

describe("F1 & F2: dispatch reconciliation & recovery stress tests", () => {
  it("F1: retap ambiguous refuses and makes no provider call", async () => {
    seedOrder("ord_ambig_retap", {
      dispatchStatus: "needs_reconciliation",
      dispatchPendingCorrelation: {
        token: "cr_ambig_retap_1",
        provider: "borzo",
        generation: 1,
        branchId: "branch_ahmedabad_1",
        orderId: "ord_ambig_retap",
      },
    });

    await expect(
      dispatchBook({ orderId: "ord_ambig_retap" })
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "DISPATCH_RECONCILIATION_REQUIRED",
    });

    // Zero external provider calls: claimDispatch refused inside snapshot
    expect(fetchCalls).toHaveLength(0);
    const doc = docOf("ord_ambig_retap");
    expect(doc.dispatchStatus).toBe("needs_reconciliation");
  });

  it("F2: matching authenticated correlated callback resolves once via correlation token", async () => {
    const token = "cr_match_tok_1";
    seedOrder("ord_ambig_match", {
      dispatchStatus: "needs_reconciliation",
      branchId: "branch_ahmedabad_1",
      dispatchGeneration: 1,
      dispatchCorrelationToken: token,
      dispatchPendingCorrelation: {
        token,
        provider: "borzo",
        generation: 1,
        branchId: "branch_ahmedabad_1",
        orderId: "ord_ambig_match",
      },
    });

    // Correlation map persisted before remote POST
    savedDocs[`dispatch_correlation_map/${token}`] = {
      orderId: "ord_ambig_match",
      generation: 1,
      provider: "borzo",
      branchId: "branch_ahmedabad_1",
    };

    const payload = {
      event: "COURIER_ASSIGNED",
      order_id: "BZ-CORR-100",
      client_order_id: token,
      timestamp: Date.now(),
      courier: {
        name: "Rider Suresh",
        phone: "+91 98989 12345",
      },
    };
    const raw = JSON.stringify(payload);

    // Authenticated callback echoing correlation token resolves atomically in transaction
    await handleDispatchWebhook("borzo", raw, borzoSig(raw), payload);

    // Map bound once
    const map = savedDocs["dispatch_order_map/BZ-CORR-100"];
    expect(map).toBeDefined();
    expect(map.orderId).toBe("ord_ambig_match");
    expect(map.provider).toBe("borzo");

    // Order state flipped from needs_reconciliation to dispatched
    const doc = docOf("ord_ambig_match");
    expect(doc.dispatchProvider).toBe("borzo");
    expect(doc.dispatchOrderId).toBe("BZ-CORR-100");
    expect(doc.deliveryStatus).toBe("dispatched");
    expect(doc.dispatchStatus).toBe("dispatched");
    expect(doc.riderName).toBe("Rider Suresh");
    expect(doc.dispatchPendingCorrelation).toBeNull();

    // Subsequent callback for BZ-CORR-100 resolves idempotently without error
    const deliverPayload = {
      event: "DELIVERED",
      order_id: "BZ-CORR-100",
      timestamp: Date.now(),
    };
    const deliverRaw = JSON.stringify(deliverPayload);
    await handleDispatchWebhook("borzo", deliverRaw, borzoSig(deliverRaw), deliverPayload);

    expect(docOf("ord_ambig_match").deliveryStatus).toBe("delivered");
  });

  it("F2: long internal orderId correlation token is bounded <= 24 chars and resolves safely", async () => {
    const longOrderId = "ord_long_internal_store_order_identifier_exceeding_standard_limits_123";
    expect(longOrderId.length).toBeGreaterThan(32);

    const token = "cr_long_test_tok_99";
    expect(token.length).toBeLessThanOrEqual(32);

    seedOrder(longOrderId, {
      dispatchStatus: "needs_reconciliation",
      branchId: "branch_ahmedabad_1",
      dispatchGeneration: 1,
      dispatchCorrelationToken: token,
      dispatchPendingCorrelation: {
        token,
        provider: "borzo",
        generation: 1,
        branchId: "branch_ahmedabad_1",
        orderId: longOrderId,
      },
    });

    savedDocs[`dispatch_correlation_map/${token}`] = {
      orderId: longOrderId,
      generation: 1,
      provider: "borzo",
      branchId: "branch_ahmedabad_1",
    };

    const payload = {
      event: "COURIER_ASSIGNED",
      order_id: "BZ-LONG-1",
      client_order_id: token,
      timestamp: Date.now(),
      courier: { name: "Rider Long", phone: "+91 99999 22222" },
    };
    const raw = JSON.stringify(payload);

    await handleDispatchWebhook("borzo", raw, borzoSig(raw), payload);

    expect(savedDocs["dispatch_order_map/BZ-LONG-1"]).toMatchObject({
      orderId: longOrderId,
      provider: "borzo",
    });
    expect(docOf(longOrderId).deliveryStatus).toBe("dispatched");
  });

  it("F2: stale callback cannot claim (older generation rejected)", async () => {
    const token = "cr_stale_tok_2";
    seedOrder("ord_ambig_stale", {
      dispatchStatus: "needs_reconciliation",
      branchId: "branch_ahmedabad_1",
      dispatchGeneration: 2,
      dispatchCorrelationToken: token,
      dispatchPendingCorrelation: {
        token,
        provider: "borzo",
        generation: 2,
        branchId: "branch_ahmedabad_1",
        orderId: "ord_ambig_stale",
      },
    });

    // Stale token from earlier generation 1
    const staleToken = "cr_stale_tok_1";
    savedDocs[`dispatch_correlation_map/${staleToken}`] = {
      orderId: "ord_ambig_stale",
      generation: 1, // older generation
      provider: "borzo",
      branchId: "branch_ahmedabad_1",
    };

    const payload = {
      event: "COURIER_ASSIGNED",
      order_id: "BZ-STALE-OLD",
      client_order_id: staleToken,
      timestamp: Date.now(),
      courier: { name: "Rider Stale", phone: "+91 99999 00000" },
    };
    const raw = JSON.stringify(payload);

    await handleDispatchWebhook("borzo", raw, borzoSig(raw), payload);

    // Stale callback must NOT claim the order
    const doc = docOf("ord_ambig_stale");
    expect(doc.dispatchStatus).toBe("needs_reconciliation");
    expect(doc.dispatchOrderId).toBeUndefined();
    expect(savedDocs["dispatch_order_map/BZ-STALE-OLD"]).toBeUndefined();

    // Parked as conflict
    const parkKeys = keysWithPrefix("unmatched_dispatch_events/");
    expect(parkKeys.length).toBeGreaterThanOrEqual(1);
  });

  it("F2: foreign callback cannot claim (mismatched provider or branch)", async () => {
    const token = "cr_foreign_tok_1";
    seedOrder("ord_ambig_foreign", {
      dispatchStatus: "needs_reconciliation",
      branchId: "branch_ahmedabad_1",
      dispatchGeneration: 1,
      dispatchCorrelationToken: token,
      dispatchPendingCorrelation: {
        token,
        provider: "borzo", // pending with Borzo
        generation: 1,
        branchId: "branch_ahmedabad_1",
        orderId: "ord_ambig_foreign",
      },
    });

    savedDocs[`dispatch_correlation_map/${token}`] = {
      orderId: "ord_ambig_foreign",
      generation: 1,
      provider: "borzo",
      branchId: "branch_ahmedabad_1",
    };

    // Shadowfax callback tries to claim Borzo pending correlation
    const payload = {
      order_status: "ALLOTTED",
      sfx_order_id: "SFX-FOREIGN-99",
      client_order_id: token,
      timestamp: Date.now(),
      rider_name: "Shadowfax Rider",
    };
    const raw = JSON.stringify(payload);

    await handleDispatchWebhook("shadowfax", raw, sfxSig(raw), payload);

    const doc = docOf("ord_ambig_foreign");
    expect(doc.dispatchStatus).toBe("needs_reconciliation");
    expect(doc.dispatchOrderId).toBeUndefined();
    expect(doc.dispatchProvider).toBeUndefined();
    expect(savedDocs["dispatch_order_map/SFX-FOREIGN-99"]).toBeUndefined();
  });

  it("F2: promotion aborts atomically if concurrent DELIVERED lands before tx read", async () => {
    const token = "cr_del_race_tok_1";
    seedOrder("ord_del_race", {
      dispatchStatus: "needs_reconciliation",
      branchId: "branch_ahmedabad_1",
      dispatchGeneration: 1,
      dispatchCorrelationToken: token,
      dispatchPendingCorrelation: {
        token,
        provider: "borzo",
        generation: 1,
        branchId: "branch_ahmedabad_1",
        orderId: "ord_del_race",
      },
    });

    savedDocs[`dispatch_correlation_map/${token}`] = {
      orderId: "ord_del_race",
      generation: 1,
      provider: "borzo",
      branchId: "branch_ahmedabad_1",
    };

    // Interleave: concurrent DELIVERED flips the order right before tx read
    const origRunTx = mockDb.runTransaction;
    mockDb.runTransaction = vi.fn(async (fn: any) => {
      return fn({
        get: async (ref: any) => {
          if (ref.id === "ord_del_race") {
            savedDocs["orders/ord_del_race"] = {
              ...savedDocs["orders/ord_del_race"],
              deliveryStatus: "delivered",
              status: { code: "DELIVERED", terminal: true },
            };
          }
          return ref.get();
        },
        set: (ref: any, data: any, opts?: any) => ref.set(data, opts),
      });
    });

    try {
      const payload = {
        event: "COURIER_ASSIGNED",
        order_id: "BZ-DEL-RACE-1",
        client_order_id: token,
        timestamp: Date.now(),
      };
      const raw = JSON.stringify(payload);

      await handleDispatchWebhook("borzo", raw, borzoSig(raw), payload);

      const doc = docOf("ord_del_race");
      // DELIVERED status MUST be preserved — not regressed to dispatched!
      expect(doc.deliveryStatus).toBe("delivered");
      expect(doc.status).toMatchObject({ code: "DELIVERED", terminal: true });
      expect(savedDocs["dispatch_order_map/BZ-DEL-RACE-1"]).toBeUndefined();
    } finally {
      mockDb.runTransaction = origRunTx;
    }
  });

  it("F2: promotion aborts atomically if providerOrderId is already mapped to another order (map collision)", async () => {
    const token = "cr_collision_tok_1";
    seedOrder("ord_collision_me", {
      dispatchStatus: "needs_reconciliation",
      branchId: "branch_ahmedabad_1",
      dispatchGeneration: 1,
      dispatchCorrelationToken: token,
      dispatchPendingCorrelation: {
        token,
        provider: "borzo",
        generation: 1,
        branchId: "branch_ahmedabad_1",
        orderId: "ord_collision_me",
      },
    });

    savedDocs[`dispatch_correlation_map/${token}`] = {
      orderId: "ord_collision_me",
      generation: 1,
      provider: "borzo",
      branchId: "branch_ahmedabad_1",
    };

    // Another order is already bound to this providerOrderId
    savedDocs["dispatch_order_map/BZ-COLLIDE-1"] = {
      orderId: "ord_other_store",
      provider: "borzo",
    };

    const payload = {
      event: "COURIER_ASSIGNED",
      order_id: "BZ-COLLIDE-1",
      client_order_id: token,
      timestamp: Date.now(),
    };
    const raw = JSON.stringify(payload);

    await handleDispatchWebhook("borzo", raw, borzoSig(raw), payload);

    // Map must NOT be stolen
    expect(savedDocs["dispatch_order_map/BZ-COLLIDE-1"].orderId).toBe("ord_other_store");
    // Order must NOT be flipped
    expect(docOf("ord_collision_me").dispatchStatus).toBe("needs_reconciliation");
    expect(docOf("ord_collision_me").dispatchOrderId).toBeUndefined();
  });

  it("F2: duplicate concurrent promotion callbacks converge idempotently", async () => {
    const token = "cr_converge_tok_1";
    seedOrder("ord_converge", {
      dispatchStatus: "needs_reconciliation",
      branchId: "branch_ahmedabad_1",
      dispatchGeneration: 1,
      dispatchCorrelationToken: token,
      dispatchPendingCorrelation: {
        token,
        provider: "borzo",
        generation: 1,
        branchId: "branch_ahmedabad_1",
        orderId: "ord_converge",
      },
    });

    savedDocs[`dispatch_correlation_map/${token}`] = {
      orderId: "ord_converge",
      generation: 1,
      provider: "borzo",
      branchId: "branch_ahmedabad_1",
    };

    const payload = {
      event: "COURIER_ASSIGNED",
      order_id: "BZ-CONVERGE-1",
      client_order_id: token,
      timestamp: Date.now(),
      courier: { name: "Rider Fast", phone: "+91 91234 56789" },
    };
    const raw = JSON.stringify(payload);

    // Concurrent deliveries
    await Promise.all([
      handleDispatchWebhook("borzo", raw, borzoSig(raw), payload),
      handleDispatchWebhook("borzo", raw, borzoSig(raw), payload),
    ]);

    expect(savedDocs["dispatch_order_map/BZ-CONVERGE-1"]).toMatchObject({
      orderId: "ord_converge",
      provider: "borzo",
    });
    expect(docOf("ord_converge").deliveryStatus).toBe("dispatched");
  });

  it("F2: unresolved uncertain outcome remains parked (plain hint without correlation proof)", async () => {
    seedOrder("ord_ambig_unproven", {
      dispatchStatus: "needs_reconciliation",
      branchId: "branch_ahmedabad_1",
      dispatchGeneration: 1,
      dispatchPendingCorrelation: {
        token: "cr_unproven_1",
        provider: "borzo",
        generation: 1,
        branchId: "branch_ahmedabad_1",
        orderId: "ord_ambig_unproven",
      },
    });

    // Webhook without echoed correlation token (plain orderId without token)
    const payload = {
      event: "COURIER_ASSIGNED",
      order_id: "BZ-UNPROVEN-1",
      client_order_id: "ord_ambig_unproven", // NO token echoed
      timestamp: Date.now(),
    };
    const raw = JSON.stringify(payload);

    // Must not blindly bind plain hint; stays parked
    await expect(
      handleDispatchWebhook("borzo", raw, borzoSig(raw), payload)
    ).rejects.toMatchObject({ code: "DISPATCH_WEBHOOK_RETRY" });

    const doc = docOf("ord_ambig_unproven");
    expect(doc.dispatchStatus).toBe("needs_reconciliation");
    expect(doc.dispatchOrderId).toBeUndefined();
    expect(savedDocs["dispatch_order_map/BZ-UNPROVEN-1"]).toBeUndefined();
  });

  it("F1: correlated promotion clears the parked dispatchError and stamps the dispatch byline", async () => {
    const token = "cr_clear_err_tok_1";
    seedOrder("ord_ambig_err", {
      dispatchStatus: "needs_reconciliation",
      dispatchError: "Borzo create-order timed out after 20000ms",
      branchId: "branch_ahmedabad_1",
      dispatchGeneration: 1,
      dispatchPendingCorrelation: {
        token,
        provider: "borzo",
        generation: 1,
        branchId: "branch_ahmedabad_1",
        orderId: "ord_ambig_err",
      },
    });

    savedDocs[`dispatch_correlation_map/${token}`] = {
      orderId: "ord_ambig_err",
      generation: 1,
      provider: "borzo",
      branchId: "branch_ahmedabad_1",
    };

    const payload = {
      event: "COURIER_ASSIGNED",
      order_id: "BZ-ERR-CLEAR-1",
      client_order_id: token,
      timestamp: Date.now(),
      courier: { name: "Rider Cleared", phone: "+91 90000 11111" },
    };
    const raw = JSON.stringify(payload);

    await handleDispatchWebhook("borzo", raw, borzoSig(raw), payload);

    const doc = docOf("ord_ambig_err");
    expect(doc.dispatchStatus).toBe("dispatched");
    expect(doc.deliveryStatus).toBe("dispatched");
    expect(doc.dispatchError).toBeNull();
    expect(doc.dispatchedBy).toBe("provider_callback");
    expect(doc.dispatchedAt).toBe("MOCK_TIMESTAMP");
  });

  it("F2: correlated callback without a provider order id parks instead of binding a null booking", async () => {
    const token = "cr_no_provider_id_1";
    seedOrder("ord_no_provider_id", {
      dispatchStatus: "needs_reconciliation",
      dispatchError: "Borzo create-order timed out",
      branchId: "branch_ahmedabad_1",
      dispatchGeneration: 1,
      dispatchPendingCorrelation: {
        token,
        provider: "borzo",
        generation: 1,
        branchId: "branch_ahmedabad_1",
        orderId: "ord_no_provider_id",
      },
    });

    savedDocs[`dispatch_correlation_map/${token}`] = {
      orderId: "ord_no_provider_id",
      generation: 1,
      provider: "borzo",
      branchId: "branch_ahmedabad_1",
    };

    const payload = {
      event: "COURIER_ASSIGNED",
      client_order_id: token,
      timestamp: Date.now(),
      courier: { name: "Rider Idless", phone: "+91 90000 22222" },
    };
    const raw = JSON.stringify(payload);

    await handleDispatchWebhook("borzo", raw, borzoSig(raw), payload);

    const doc = docOf("ord_no_provider_id");
    expect(doc.dispatchStatus).toBe("needs_reconciliation");
    expect(doc.dispatchOrderId).toBeUndefined();
    expect(doc.dispatchProvider).toBeUndefined();
    expect(doc.riderName).toBeUndefined();
    expect(doc.dispatchPendingCorrelation).toMatchObject({ token });

    const parks = keysWithPrefix("unmatched_dispatch_events/");
    expect(parks.length).toBeGreaterThanOrEqual(1);
    expect(keysWithPrefix("dispatch_order_map/")).toHaveLength(0);
  });

  it("F3: correlated promotion applies the bound path's no-rewind guards", async () => {
    const token = "cr_no_rewind_tok_1";
    seedOrder("ord_corr_in_transit", {
      dispatchStatus: "needs_reconciliation",
      deliveryStatus: "in_transit",
      branchId: "branch_ahmedabad_1",
      dispatchGeneration: 1,
      riderName: "Live Rider",
      dispatchPendingCorrelation: {
        token,
        provider: "borzo",
        generation: 1,
        branchId: "branch_ahmedabad_1",
        orderId: "ord_corr_in_transit",
      },
    });

    savedDocs[`dispatch_correlation_map/${token}`] = {
      orderId: "ord_corr_in_transit",
      generation: 1,
      provider: "borzo",
      branchId: "branch_ahmedabad_1",
    };

    const payload = {
      event: "COURIER_ASSIGNED",
      order_id: "BZ-NO-REWIND-1",
      client_order_id: token,
      timestamp: Date.now(),
      courier: { name: "Late Rider", phone: "+91 90000 33333" },
    };
    const raw = JSON.stringify(payload);

    await handleDispatchWebhook("borzo", raw, borzoSig(raw), payload);

    const doc = docOf("ord_corr_in_transit");
    expect(doc.deliveryStatus).toBe("in_transit");
    expect(doc.riderName).toBe("Live Rider");
    expect(doc.dispatchStatus).toBe("needs_reconciliation");
    expect(savedDocs["dispatch_order_map/BZ-NO-REWIND-1"]).toBeUndefined();
  });

  it("F3: correlated ARRIVED_AT_PICKUP does not rewind a non-pickup stage", async () => {
    const token = "cr_arrived_tok_1";
    seedOrder("ord_corr_arrived", {
      dispatchStatus: "needs_reconciliation",
      deliveryStatus: "needs_review",
      branchId: "branch_ahmedabad_1",
      dispatchGeneration: 1,
      dispatchPendingCorrelation: {
        token,
        provider: "borzo",
        generation: 1,
        branchId: "branch_ahmedabad_1",
        orderId: "ord_corr_arrived",
      },
    });

    savedDocs[`dispatch_correlation_map/${token}`] = {
      orderId: "ord_corr_arrived",
      generation: 1,
      provider: "borzo",
      branchId: "branch_ahmedabad_1",
    };

    const payload = {
      event: "ARRIVED_AT_PICKUP",
      order_id: "BZ-ARRIVED-LATE-1",
      client_order_id: token,
      timestamp: Date.now(),
    };
    const raw = JSON.stringify(payload);

    await handleDispatchWebhook("borzo", raw, borzoSig(raw), payload);

    const doc = docOf("ord_corr_arrived");
    expect(doc.deliveryStatus).toBe("needs_review");
    expect(doc.riderArrivedAtStore).toBeUndefined();
    expect(doc.dispatchStatus).toBe("needs_reconciliation");
    expect(savedDocs["dispatch_order_map/BZ-ARRIVED-LATE-1"]).toBeUndefined();
  });
});
