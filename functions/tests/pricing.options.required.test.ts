import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * M2a / test 34c (owner decision 2026-11-01): the SERVER enforces the product's
 * own selection rules.
 *
 * - a required group with no selection → 422 ITEM_OPTION_REQUIRED (a tampered
 *   client cannot skip a variation and pay the base price);
 * - more selections than a group allows → 422 ITEM_OPTION_LIMIT;
 * - a selected unavailable option → 422 ITEM_OPTION_UNAVAILABLE.
 *
 * For cash KOT each of these parks the order (blocked_configuration, no relay).
 * The customer app enforces the same rules (required groups block Add-to-cart,
 * multi-select is capped at maxSelect, unavailable options are disabled), so an
 * honest order is never refused.
 */

const { mockDb, savedDocs } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};

  const VARIATION_GROUPS = [
    {
      id: "variation",
      name: "Quantity",
      kind: "variation",
      minSelections: 1,
      maxSelections: 1,
      options: [
        { id: "v1", name: "3Pieces", price: 0, absolutePrice: 140, isAvailable: true, posItemId: "v1", posVariationId: "11" },
        { id: "v2", name: "6Pieces", price: 20, absolutePrice: 160, isAvailable: true, posItemId: "v2", posVariationId: "22" },
      ],
    },
    {
      id: "g_addon",
      name: "Add-ons",
      kind: "addon",
      minSelections: 0,
      maxSelections: 2,
      posGroupId: 135707,
      options: [
        { id: "a1", name: "Cheese", price: 10, isAvailable: true },
        { id: "a2", name: "Egg", price: 20, isAvailable: true },
        { id: "a3", name: "Sold out", price: 20, isAvailable: false },
      ],
    },
  ];

  const docRef = (col: string, id: string): any => {
    const path = `${col}/${id}`;
    const ref: any = {
      id,
      path,
      get: async () => ({
        id,
        exists: Object.prototype.hasOwnProperty.call(savedDocs, path),
        data: () => savedDocs[path],
        ref,
      }),
      set: async (data: any, opts?: any) => {
        savedDocs[path] =
          opts?.merge && savedDocs[path] ? { ...savedDocs[path], ...data } : data;
      },
    };
    return ref;
  };

  const q = (): any => ({
    where: () => q(),
    orderBy: () => q(),
    limit: () => q(),
    startAfter: () => q(),
    get: async () => ({ empty: true, docs: [] }),
  });

  const mockDb: any = {
    collection: (col: string) => ({
      ...q(),
      doc: (id?: string) => docRef(col, id as string),
    }),
    getAll: async (...refs: any[]) => Promise.all(refs.map((r: any) => r.get())),
    runTransaction: async (fn: any) =>
      fn({
        get: (ref: any) => ref.get(),
        set: (ref: any, data: any, opts?: any) => ref.set(data, opts),
      }),
    __variationGroups: VARIATION_GROUPS,
  };
  return { mockDb, savedDocs };
});

vi.mock("firebase-admin", () => {
  const FieldValue = {
    serverTimestamp: () => "MOCK_TIMESTAMP",
    increment: (n: number) => ({ __inc: n }),
    delete: () => "MOCK_DELETED",
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

import { calculateOrderPricing } from "../src/modules/payments/pricing.engine";
import { pushOrderToPetpooja } from "../src/modules/petpooja/orderPush";
import { config } from "../src/config/env";

const BRANCH = "branch_opts";
const PRODUCT = "prod_opts";
let prevMock: any;
const fetchMock = vi.fn();

function basket(selections: { customizations?: any[]; modifiers?: any[] }) {
  return {
    items: [
      {
        id: "l1",
        productId: PRODUCT,
        name: "Garlic Bread",
        price: 140,
        quantity: 1,
        ...selections,
      },
    ],
    branchId: BRANCH,
    orderType: "takeaway" as const,
  };
}

async function pricingError(selections: { customizations?: any[]; modifiers?: any[] }) {
  return calculateOrderPricing(basket(selections)).then(
    () => null,
    (e) => e
  );
}

function seedOrder(id: string, selections: { customizations?: any[]; modifiers?: any[] }) {
  savedDocs[`orders/${id}`] = {
    id,
    branchId: BRANCH,
    customerId: "cust_opts",
    userId: "cust_opts",
    fulfillmentType: "TAKEAWAY",
    paymentMethod: "COD",
    createdAtMs: Date.now() - 60_000,
    items: [
      {
        id: "l1",
        petpoojaItemId: "7765809",
        name: "Garlic Bread",
        productId: PRODUCT,
        price: 140,
        quantity: 1,
        ...selections,
      },
    ],
    pricing: {
      foodSubtotal: 160,
      gst: 7.62,
      packagingFee: 15,
      deliveryFee: 0,
      discount: 0,
      loyaltyDiscount: 0,
      grandTotal: 175,
    },
  };
}

beforeEach(() => {
  for (const key of Object.keys(savedDocs)) delete savedDocs[key];
  prevMock = { mock: { ...config.mock } };
  config.mock.petpoojaPos = false;
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ success: "1", orderID: "pp_opts_1" }),
  });
  vi.stubGlobal("fetch", fetchMock);

  savedDocs[`branches/${BRANCH}`] = {
    petpoojaStoreId: "xxxxxx",
    petpoojaTaxes: [
      { id: "3928", name: "CGST", rate: 2.5 },
      { id: "3929", name: "SGST", rate: 2.5 },
    ],
    coordinates: { lat: 23.0225, lng: 71.0 },
    packagingFee: 15,
  };
  savedDocs[`products/${PRODUCT}`] = {
    price: 140,
    inStock: true,
    customizations: mockDb.__variationGroups,
  };
});

afterEach(() => {
  config.mock = { ...prevMock.mock };
  vi.unstubAllGlobals();
});

describe("M2a server-enforced selections (34c)", () => {
  it("refuses a skipped REQUIRED group with 422 ITEM_OPTION_REQUIRED", async () => {
    const err = await pricingError({});
    expect(err).toMatchObject({ statusCode: 422, code: "ITEM_OPTION_REQUIRED" });
  });

  it("refuses more selections than a group allows with 422 ITEM_OPTION_LIMIT", async () => {
    const err = await pricingError({
      customizations: [{ id: "v1", name: "3Pieces", price: 0 }],
      modifiers: [
        { id: "a1", name: "Cheese", priceDelta: 10 },
        { id: "a2", name: "Egg", priceDelta: 20 },
        { id: "a3", name: "Sold out", priceDelta: 20 },
      ],
    });
    expect(err).toMatchObject({ statusCode: 422, code: "ITEM_OPTION_LIMIT" });
  });

  it("refuses a selected UNAVAILABLE option with 422 ITEM_OPTION_UNAVAILABLE", async () => {
    const err = await pricingError({
      customizations: [{ id: "v1", name: "3Pieces", price: 0 }],
      modifiers: [{ id: "a3", name: "Sold out", priceDelta: 20 }],
    });
    expect(err).toMatchObject({ statusCode: 422, code: "ITEM_OPTION_UNAVAILABLE" });
  });

  it("prices an honest basket with options (parity)", async () => {
    const priced = await calculateOrderPricing(
      basket({
        customizations: [{ id: "v2", name: "6Pieces", price: 20 }],
        modifiers: [
          { id: "a1", name: "Cheese", priceDelta: 10 },
          { id: "a2", name: "Egg", priceDelta: 20 },
        ],
      })
    );
    // base 140 + variation delta 20 + add-ons 30
    expect(priced.foodSubtotal).toBe(190);
  });

  it("parks a cash order that skips the required option (no relay)", async () => {
    seedOrder("ord_skip_required", {});
    expect(await pushOrderToPetpooja("ord_skip_required")).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(savedDocs["orders/ord_skip_required"].petpoojaStatus).toBe("blocked_configuration");
    expect(String(savedDocs["orders/ord_skip_required"].lastPetpoojaError)).toMatch(
      /required option group/i
    );
  });

  it("parks a cash order over the group limit and with an unavailable option", async () => {
    seedOrder("ord_over_limit", {
      customizations: [{ id: "v1", name: "3Pieces", price: 0 }],
      modifiers: [
        { id: "a1", name: "Cheese", priceDelta: 10 },
        { id: "a2", name: "Egg", priceDelta: 20 },
        { id: "a3", name: "Sold out", priceDelta: 20 },
      ],
    });
    expect(await pushOrderToPetpooja("ord_over_limit")).toBe(false);
    expect(savedDocs["orders/ord_over_limit"].petpoojaStatus).toBe("blocked_configuration");

    seedOrder("ord_unavailable", {
      customizations: [{ id: "v1", name: "3Pieces", price: 0 }],
      modifiers: [{ id: "a3", name: "Sold out", priceDelta: 20 }],
    });
    expect(await pushOrderToPetpooja("ord_unavailable")).toBe(false);
    expect(String(savedDocs["orders/ord_unavailable"].lastPetpoojaError)).toMatch(
      /not available/i
    );
  });

  it("relays an honest cash order with options", async () => {
    seedOrder("ord_honest", {
      customizations: [{ id: "v2", name: "6Pieces", price: 20 }],
    });
    expect(await pushOrderToPetpooja("ord_honest")).toBe(true);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const line = body.orderinfo.OrderInfo.OrderItem.details[0];
    expect(line.name).toBe("Garlic Bread (6Pieces)");
    expect(line.variation_id).toBe("22");
    expect(line.price).toBe("160.00");
  });
});
