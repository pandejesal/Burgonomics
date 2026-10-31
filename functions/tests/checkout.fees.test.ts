import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * POST /checkout/fees (owner decision 2026-10-31, R5).
 *
 * Contract pinned here:
 *  - auth is required (the route's requireAuth; the service fails closed too),
 *  - the branch resolves exactly like createPaymentOrder (unlinked store 409),
 *  - PACKAGING comes from the shared server branch source (dine-in = 0),
 *  - non-delivery returns instantly and calls NO provider,
 *  - delivery uses SERVER-ONLY pickup coordinates (client pickup is ignored),
 *  - an out-of-zone address is a 200 serviceable:false, never an error,
 *  - zero eligible providers is a 503 and never a static fare,
 *  - the winner's fare is persisted as a single-use quote and returned.
 *
 * Mock-only, in-memory store: no network, no Firestore, no provider calls.
 */

const { savedDocs, mockDb } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};

  const docRef = (col: string, id: string): any => {
    const path = `${col}/${id}`;
    return {
      id,
      path,
      get: async () => {
        const data = savedDocs[path];
        if (data !== undefined) return { exists: true, data: () => data };
        return { exists: false, data: () => undefined };
      },
      set: async (data: any, opts?: any) => {
        savedDocs[path] =
          opts?.merge && savedDocs[path] ? { ...savedDocs[path], ...data } : data;
      },
      create: async (data: any) => {
        if (savedDocs[path] !== undefined) {
          const err: any = new Error("Document already exists");
          err.code = 6;
          throw err;
        }
        savedDocs[path] = data;
      },
    };
  };

  const mockDb: any = {
    collection: (col: string) => ({
      doc: (id: string) => docRef(col, id),
      where: () => ({
        limit: () => ({
          get: async () => ({ empty: true, docs: [] }),
        }),
      }),
    }),
    runTransaction: async (fn: any) =>
      fn({
        get: (ref: any) => ref.get(),
        set: (ref: any, data: any, opts?: any) => ref.set(data, opts),
      }),
  };

  return { savedDocs, mockDb };
});

vi.mock("firebase-admin", () => {
  const FieldValue = {
    serverTimestamp: () => "MOCK_TIMESTAMP",
    increment: (n: number) => n,
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

import { resolveCheckoutFees } from "../src/modules/payments/checkoutFees";
import { clearBranchPricingCache } from "../src/modules/payments/branchPricing";
import { config } from "../src/config/env";

const PICKUP = { lat: 23.0225, lng: 72.5714 }; // stores/demo + branches/demo
const DROP = { lat: 23.0338, lng: 72.5262 }; // ~4.8 km away, inside 8 km
const FAR_DROP = { lat: 23.9, lng: 73.9 }; // far outside the radius

let saved: any = {};

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
  config.shadowfax.contractVerified = false;
  config.porter.enabled = false; // deterministic two-provider field
  config.mock.borzoDispatch = true;
  config.mock.shadowfaxDispatch = true;
  config.mock.porterDispatch = false;

  for (const k of Object.keys(savedDocs)) delete savedDocs[k];
  savedDocs["branches/branch_demo"] = {
    name: "Burgonomics Demo",
    coordinates: PICKUP,
    packagingFee: 15,
  };
  savedDocs["stores/demo"] = {
    id: "demo",
    partnerBranchId: "branch_demo",
    lat: PICKUP.lat,
    lng: PICKUP.lng,
    radius: 7,
  };
  savedDocs["stores/unlinked"] = { id: "unlinked" };
  clearBranchPricingCache();
});

afterEach(() => {
  config.borzo = { ...saved.borzo };
  config.shadowfax = { ...saved.shadowfax };
  config.porter = { ...saved.porter };
  config.mock = { ...saved.mock };
});

function quoteDocs(): string[] {
  return Object.keys(savedDocs).filter((k) => k.startsWith("delivery_fee_quotes/"));
}

describe("POST /checkout/fees (R5)", () => {
  it("requires an authenticated caller", async () => {
    await expect(
      resolveCheckoutFees({
        storeId: "demo",
        orderType: "takeaway",
        customerId: undefined,
      })
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  it("returns packaging only for takeaway and never calls a provider", async () => {
    // Every provider is ineligible: a provider call could only fail here.
    config.mock.borzoDispatch = false;
    config.mock.shadowfaxDispatch = false;
    const res = await resolveCheckoutFees({
      storeId: "demo",
      orderType: "takeaway",
      customerId: "uid_1",
    });
    expect(res).toEqual({
      serviceable: true,
      packagingFee: 15,
      deliveryFee: 0,
    });
    expect(quoteDocs()).toHaveLength(0);
  });

  it("charges no packaging for dine-in", async () => {
    const res = await resolveCheckoutFees({
      storeId: "demo",
      orderType: "dinein",
      customerId: "uid_1",
    });
    expect(res.packagingFee).toBe(0);
    expect(res.deliveryFee).toBe(0);
  });

  it("uses the branch packaging value from the shared server source", async () => {
    savedDocs["branches/branch_demo"].packagingFee = 22;
    clearBranchPricingCache();
    const res = await resolveCheckoutFees({
      storeId: "demo",
      orderType: "takeaway",
      customerId: "uid_1",
    });
    expect(res.packagingFee).toBe(22);
  });

  it("refuses an unlinked store with 409 STORE_NOT_LINKED", async () => {
    await expect(
      resolveCheckoutFees({
        storeId: "unlinked",
        orderType: "takeaway",
        customerId: "uid_1",
      })
    ).rejects.toMatchObject({ statusCode: 409, code: "STORE_NOT_LINKED" });
  });

  it("requires a drop pin for delivery (422, no provider call)", async () => {
    await expect(
      resolveCheckoutFees({
        storeId: "demo",
        orderType: "delivery",
        customerId: "uid_1",
      })
    ).rejects.toMatchObject({ statusCode: 422, code: "DISPATCH_GPS_MISSING" });
    expect(quoteDocs()).toHaveLength(0);
  });

  it("returns 200 serviceable:false outside the zone, with no fee", async () => {
    const res = await resolveCheckoutFees({
      storeId: "demo",
      orderType: "delivery",
      dropLat: FAR_DROP.lat,
      dropLng: FAR_DROP.lng,
      customerId: "uid_1",
    });
    expect(res.serviceable).toBe(false);
    expect(res.reason).toBe("not_serviced");
    expect(res.message).toBeTruthy();
    expect(res.packagingFee).toBe(15);
    expect(res).not.toHaveProperty("deliveryFee");
    expect(res).not.toHaveProperty("deliveryQuoteId");
    expect(quoteDocs()).toHaveLength(0);
  });

  it("fails closed 503 NO_SERVICEABLE_PROVIDER and never invents a fare", async () => {
    config.mock.borzoDispatch = false;
    config.mock.shadowfaxDispatch = false;
    await expect(
      resolveCheckoutFees({
        storeId: "demo",
        orderType: "delivery",
        dropLat: DROP.lat,
        dropLng: DROP.lng,
        customerId: "uid_1",
      })
    ).rejects.toMatchObject({ statusCode: 503, code: "NO_SERVICEABLE_PROVIDER" });
    expect(quoteDocs()).toHaveLength(0);
  });

  it("prices delivery from the winner and persists a single-use quote", async () => {
    const res = await resolveCheckoutFees({
      storeId: "demo",
      orderType: "delivery",
      dropLat: DROP.lat,
      dropLng: DROP.lng,
      customerId: "uid_1",
    });
    expect(res.serviceable).toBe(true);
    expect(res.packagingFee).toBe(15);
    expect(res.deliveryFee).toBeGreaterThan(0);
    expect(res.provider).toBe("borzo");
    expect(res.deliveryQuoteId).toMatch(/^dfq_/);
    expect(res.expiresAt).toBeGreaterThan(Date.now());

    const docs = quoteDocs();
    expect(docs).toHaveLength(1);
    const quote = savedDocs[docs[0]];
    expect(quote).toMatchObject({
      uid: "uid_1",
      branchId: "branch_demo",
      storeId: "demo",
      dropLat: DROP.lat,
      dropLng: DROP.lng,
      fee: res.deliveryFee,
      provider: "borzo",
      usedByOrderId: null,
      createdAt: "MOCK_TIMESTAMP",
    });
    expect(typeof quote.providerQuoteId).toBe("string");
    expect(quote.expiresAt).toBe(res.expiresAt);
    expect(quote.fee).toBe(Math.round(quote.fee * 100) / 100);
  });

  it("takes the pickup pin only from server data — a client pickup is ignored", async () => {
    // (0,0) from the client would be a null-island refusal if it were used.
    const res = await resolveCheckoutFees({
      storeId: "demo",
      orderType: "delivery",
      dropLat: DROP.lat,
      dropLng: DROP.lng,
      customerId: "uid_1",
      // @ts-expect-error — the service/route accept no pickup fields at all.
      pickupLat: 0,
      pickupLng: 0,
    });
    expect(res.serviceable).toBe(true);
    expect(res.deliveryFee).toBeGreaterThan(0);
  });

  it("is wired to requireAuth, the App Check list, the schema and the normal limiter", () => {
    const source = readFileSync(resolve(__dirname, "../src/index.ts"), "utf8");
    // App Check protected list
    expect(source).toContain('"/checkout/fees"');
    // Route with auth + zod validation
    const route = source.slice(source.indexOf('app.post("/checkout/fees"'));
    expect(route).toContain("requireAuth");
    expect(route).toContain("validateBody(checkoutFeesSchema)");
    // Normal rate limit: the fee route must NOT be a webhook exemption.
    const exempt = source.slice(
      source.indexOf("const WEBHOOK_RATE_LIMIT_EXEMPT_PREFIXES"),
      source.indexOf("const limiter = rateLimit")
    );
    expect(exempt).not.toContain("/checkout/fees");
  });
});
