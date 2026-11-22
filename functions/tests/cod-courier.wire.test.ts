import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockDb, savedDocs } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  const readDoc = (col: string, id: string): any => ({
    exists: true,
    data: () => savedDocs[`${col}/${id}`],
    ref: {
      get: vi.fn(async () => readDoc(col, id)),
      set: vi.fn(async (data: any) => {
        savedDocs[`${col}/${id}`] = { ...(savedDocs[`${col}/${id}`] || {}), ...data };
      }),
    },
  });
  const mockDb: any = {
    collection: (col: string) => ({
      doc: (id: string) => ({
        id,
        get: vi.fn(async () => readDoc(col, id)),
        set: vi.fn(async (data: any) => {
          savedDocs[`${col}/${id}`] = { ...(savedDocs[`${col}/${id}`] || {}), ...data };
        }),
      }),
      where: () => ({ limit: () => ({ get: async () => ({ empty: true, docs: [] }) }) }),
    }),
    runTransaction: vi.fn(async (fn: any) =>
      fn({ get: (ref: any) => ref.get(), set: (ref: any, data: any) => ref.set(data) })
    ),
  };
  return { mockDb, savedDocs };
});

vi.mock("firebase-admin", () => {
  const FieldValue = {
    serverTimestamp: () => "MOCK_TIMESTAMP",
    increment: (n: number) => n,
    arrayUnion: (...items: any[]) => items,
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

import { borzoAdapter } from "../src/modules/dispatch/providers/borzo.adapter";
import { dispatchBook } from "../src/modules/dispatch/dispatch.router";
import { config } from "../src/config/env";

const originalFetch = globalThis.fetch;
let posts: Array<{ url: string; body: any }> = [];

const snapshotReady = { enabled: true, providers: { borzo: true, shadowfax: false } };

const codOrder: any = {
  orderType: "delivery",
  branchId: "branch_wire",
  store: { name: "Wire Branch", phone: "+91 98250 12345" },
  branchCoordinates: { lat: 21.18, lng: 72.81 },
  deliveryAddress: { full: "12 Test Street", lat: 21.19, lng: 72.82 },
  customerPhone: "9999988888",
  customerName: "Asha",
  paymentChannel: "cash",
  payment: { method: "cod", status: "pending" },
  cashDuePaise: 12345,
  cashOnDelivery: { courierCod: snapshotReady },
  status: "ready",
};

const ctx = (): any => ({
  orderId: "ord_wire_cod",
  order: codOrder,
  customerPhone: "9999988888",
  pickup: { lat: 21.18, lng: 72.81 },
  drop: { lat: 21.19, lng: 72.82 },
});

const borzoSuccess = () =>
  new Response(
    JSON.stringify({ is_successful: true, order: { order_id: "BZ-WIRE-1", points: [] } }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );

beforeEach(() => {
  posts = [];
  globalThis.fetch = vi.fn(async (url: any, init?: any) => {
    if ((init?.method || "GET").toUpperCase() === "POST") {
      posts.push({ url: String(url), body: JSON.parse(String(init?.body || "{}")) });
      return borzoSuccess();
    }
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  }) as any;
  config.borzo.enabled = true;
  config.borzo.apiKey = "test_wire_key";
  config.borzo.baseUrl = "https://robotapitest-in.borzodelivery.com";
  config.mock.borzoDispatch = false;
  savedDocs["branches/branch_wire"] = {
    phone: "+91 98250 12345",
    cashOnDelivery: { courierCod: snapshotReady },
  };
  savedDocs["orders/ord_wire_cod"] = { ...codOrder };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Borzo COD fields in the ACTUAL outgoing POST", () => {
  it("sends taking_amount and the COD switch on the customer drop point", async () => {
    const res = await borzoAdapter.book(ctx());
    expect(res.kind).toBe("booked");
    expect(posts).toHaveLength(1);
    const body = posts[0].body;
    expect(body.points).toHaveLength(2);
    expect(body.points[0]).not.toHaveProperty("taking_amount");
    expect(body.points[0]).not.toHaveProperty("is_cod_cash_voucher_required");
    expect(body.points[1]).toMatchObject({
      taking_amount: "123.45",
      is_cod_cash_voucher_required: true,
    });
    expect(body).not.toHaveProperty("taking_amount");
    expect(body).not.toHaveProperty("is_order_payment_here");
  });

  it("sends ZERO POSTs when readiness was revoked after checkout", async () => {
    savedDocs["branches/branch_wire"].cashOnDelivery.courierCod = {
      enabled: false,
      providers: { borzo: false, shadowfax: false },
    };
    await expect(borzoAdapter.book(ctx())).rejects.toMatchObject({
      provider: "borzo",
      kind: "not_serviced",
    });
    expect(posts).toHaveLength(0);
  });

  it("replays an existing live booking with ZERO provider POSTs even if readiness is now OFF", async () => {
    savedDocs["branches/branch_wire"].cashOnDelivery.courierCod = {
      enabled: false,
      providers: { borzo: false, shadowfax: false },
    };
    savedDocs["orders/ord_wire_replay"] = {
      ...codOrder,
      deliveryStatus: "dispatched",
      dispatchProvider: "borzo",
      dispatchOrderId: "BZ-REPLAY-1",
      riderName: "[TEST] Existing Rider",
      dispatchSource: "mock",
      dispatchGeoSource: "live_gps",
    };
    const res = await dispatchBook({ orderId: "ord_wire_replay" });
    expect(res).toMatchObject({ reused: true, provider: "borzo", providerOrderId: "BZ-REPLAY-1" });
    expect(posts).toHaveLength(0);
  });
});
