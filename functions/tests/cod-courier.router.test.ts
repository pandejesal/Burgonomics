import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  // The direct /porter/book and /porter/rebook routes are only reachable when
  // Porter is explicitly enabled; that is exactly the bypass under test.
  process.env.PORTER_ENABLED = "true";
});

const { mockDb, savedDocs } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  const mockDb: any = {
    collection: (col: string) => ({
      doc: (id: string) => ({
        id,
        get: vi.fn(async () => ({
          exists: true,
          data: () => savedDocs[`${col}/${id}`],
          ref: {
            get: vi.fn(async () => ({ exists: true, data: () => savedDocs[`${col}/${id}`] })),
            set: vi.fn(async () => undefined),
          },
        })),
        set: vi.fn(async () => undefined),
      }),
    }),
    runTransaction: vi.fn(async (fn: any) =>
      fn({ get: (ref: any) => ref.get(), set: () => undefined })
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

import { savePorterManualBooking } from "../src/modules/dispatch/dispatch.router";
import { porterAdapter } from "../src/modules/dispatch/providers/porter.adapter";
import { bookPorterRider, rebookPorterRider } from "../src/modules/porter/porter.service";

const originalFetch = globalThis.fetch;
let fetchCalls: Array<{ url: string; init?: any }> = [];

beforeEach(() => {
  fetchCalls = [];
  globalThis.fetch = vi.fn(async (url: any, init?: any) => {
    fetchCalls.push({ url: String(url), init });
    return new Response(JSON.stringify({ order_id: "POR-SHOULD-NOT-HAPPEN" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as any;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const postCalls = () => fetchCalls.filter((c) => (c.init?.method || "GET").toUpperCase() === "POST");

const codOrder = {
  orderType: "delivery",
  branchId: "branch_a",
  store: { name: "COD Branch", phone: "+91 98250 12345" },
  branchCoordinates: { lat: 21.18, lng: 72.81 },
  deliveryAddress: { full: "12 Test Street", lat: 21.19, lng: 72.82 },
  customerPhone: "9999988888",
  customerName: "Asha",
  status: "ready",
  paymentChannel: "cash",
  payment: { method: "cod", status: "pending" },
  cashDuePaise: 12345,
  cashOnDelivery: { courierCod: { enabled: true, providers: { borzo: true } } },
  deliveryStatus: "ready",
};

const bookCtx: any = {
  orderId: "ord_cod_porter",
  order: codOrder,
  pickup: { lat: 21.18, lng: 72.81 },
  drop: { lat: 21.19, lng: 72.82 },
  quote: { provider: "porter", fare: 10, quoteId: "Q", expiresAt: Date.now() + 1000 },
};

describe("Porter cannot take a COD delivery", () => {
  it("refuses a direct Porter book", async () => {
    await expect(porterAdapter.book(bookCtx)).rejects.toMatchObject({
      provider: "porter",
      kind: "not_serviced",
    });
  });

  it("refuses the manual paste lane bypass", async () => {
    savedDocs["orders/ord_cod_porter"] = codOrder;
    await expect(
      savePorterManualBooking({ orderId: "ord_cod_porter", porterOrderId: "POR-COD-1" })
    ).rejects.toMatchObject({ code: "COURIER_COD_DISABLED", statusCode: 409 });
  });

  it("makes ZERO provider calls when /porter/book is used for a COD order", async () => {
    savedDocs["orders/ord_cod_direct"] = { ...codOrder };
    await expect(bookPorterRider("ord_cod_direct", "Ops")).rejects.toMatchObject({
      code: "COURIER_COD_DISABLED",
    });
    expect(postCalls()).toHaveLength(0);
  });

  it("makes ZERO provider calls when /porter/rebook is used for a COD order", async () => {
    savedDocs["orders/ord_cod_rebook"] = {
      ...codOrder,
      needsRebook: true,
      dispatchStatus: "dispatch_failed",
    };
    await expect(rebookPorterRider("ord_cod_rebook", "Ops")).rejects.toMatchObject({
      code: "COURIER_COD_DISABLED",
    });
    expect(postCalls()).toHaveLength(0);
  });
});
