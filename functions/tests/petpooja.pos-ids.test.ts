import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Part M relay (owner decision 2026-11-01, M3).
 *
 * orderPush resolves POS ids from the CATALOG via the verified selection, never
 * from the client's modifier. Expectations are the vendor's own order sample
 * (PETPOOJA API Docs.txt lines 5385-5470):
 *   variation line: id "7765862", name "Garlic Bread (3Pieces)",
 *     variation_id "89058", variation_name "3Pieces", price "140.00";
 *   add-ons: id = addonitemid, group_name = addongroup_name,
 *     group_id = INTEGER 135699 / 135707, price = addonitem_price.
 */

const { savedDocs, mockDb } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  const docRef = (col: string, id: string) => {
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

import { pushOrderToPetpooja } from "../src/modules/petpooja/orderPush";
import { config } from "../src/config/env";

const fixture = JSON.parse(
  readFileSync(resolve(__dirname, "fixtures/petpooja-push-docsample.json"), "utf8")
).payload;

const BRANCH = "b_m";
let prevMock: boolean;
const fetchMock = vi.fn();

/** Mirrors the mapper's output for the two doc-sample items. */
function seedCatalog() {
  savedDocs["branches/b_m"] = {
    petpoojaStoreId: "xxxxxx",
    coordinates: { lat: 23.0225, lng: 72.5714 },
  };
  savedDocs["products/prod_7765809"] = {
    price: 140,
    inStock: true,
    customizations: [
      {
        id: "variation",
        name: "Quantity",
        kind: "variation",
        minSelections: 1,
        maxSelections: 1,
        options: [
          {
            id: "7765862",
            name: "3Pieces",
            price: 0,
            absolutePrice: 140,
            packingCharge: 20,
            isAvailable: true,
            posItemId: "7765862",
            posVariationId: "89058",
          },
          {
            id: "7765097",
            name: "6Pieces",
            price: 20,
            absolutePrice: 160,
            packingCharge: 20,
            isAvailable: true,
            posItemId: "7765097",
            posVariationId: "89059",
          },
        ],
      },
    ],
  };
  savedDocs["products/prod_118829149"] = {
    price: 100,
    inStock: true,
    customizations: [
      {
        id: "135699",
        name: "Add Beverage",
        kind: "addon",
        minSelections: 0,
        maxSelections: 1,
        posGroupId: 135699,
        options: [{ id: "1150783", name: "Mojito", price: 0, isAvailable: true }],
      },
      {
        id: "135707",
        name: "Extra Toppings",
        kind: "addon",
        minSelections: 0,
        maxSelections: 4,
        posGroupId: 135707,
        options: [{ id: "1150813", name: "Cheese", price: 10, isAvailable: true }],
      },
    ],
  };
}

function seedOrder(id: string, items: any[], pricing: any) {
  savedDocs[`orders/${id}`] = {
    id,
    branchId: BRANCH,
    customerId: "cust_m",
    userId: "cust_m",
    fulfillmentType: "TAKEAWAY",
    paymentMethod: "COD",
    createdAtMs: Date.now() - 60_000,
    items,
    pricing,
  };
}

function payload(): any {
  const call = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
  expect(call).toBeTruthy();
  return JSON.parse(call[1].body);
}

beforeEach(() => {
  for (const key of Object.keys(savedDocs)) delete savedDocs[key];
  prevMock = config.mock.petpoojaPos;
  config.mock.petpoojaPos = false;
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ success: "1", orderID: "pp_m_1" }),
  });
  vi.stubGlobal("fetch", fetchMock);
  seedCatalog();
});

afterEach(() => {
  config.mock.petpoojaPos = prevMock;
  vi.unstubAllGlobals();
});

describe("M3 POS ids from the catalog", () => {
  it("31: a variation line matches the vendor sample exactly", async () => {
    seedOrder(
      "ord_var",
      [
        {
          id: "l1",
          petpoojaItemId: "7765809",
          name: "Garlic Bread",
          productId: "prod_7765809",
          price: 140,
          quantity: 1,
          // The client selects by catalog option id; it carries NO POS ids.
          customizations: [{ id: "7765862", name: "3Pieces", price: 0 }],
        },
      ],
      {
        foodSubtotal: 140,
        gst: 6.67,
        packagingFee: 15,
        deliveryFee: 0,
        discount: 0,
        loyaltyDiscount: 0,
        grandTotal: 155,
      }
    );

    expect(await pushOrderToPetpooja("ord_var")).toBe(true);
    const line = payload().orderinfo.OrderInfo.OrderItem.details[0];
    expect(line).toMatchObject({
      id: "7765862",
      name: "Garlic Bread (3Pieces)",
      variation_id: "89058",
      variation_name: "3Pieces",
      price: "140.00",
    });
    expect(line.final_price).toBe("140.00");
    // No invented ids: the client's selection had none.
    expect(line.AddonItem.details).toEqual([]);
  });

  it("32: add-on rows match the vendor sample, group_id is the INTEGER 135699", async () => {
    seedOrder(
      "ord_addon",
      [
        {
          id: "l1",
          petpoojaItemId: "118829149",
          name: "Veg Loaded Pizza",
          productId: "prod_118829149",
          price: 110,
          quantity: 1,
          modifiers: [
            { id: "1150783", name: "Mojito", priceDelta: 0 },
            { id: "1150813", name: "Cheese", priceDelta: 10 },
          ],
        },
      ],
      {
        foodSubtotal: 110,
        gst: 5.24,
        packagingFee: 15,
        deliveryFee: 0,
        discount: 0,
        loyaltyDiscount: 0,
        grandTotal: 125,
      }
    );

    expect(await pushOrderToPetpooja("ord_addon")).toBe(true);
    const line = payload().orderinfo.OrderInfo.OrderItem.details[0];
    expect(line.price).toBe("110.00");
    expect(line.AddonItem.details).toEqual([
      {
        id: "1150783",
        name: "Mojito",
        group_name: "Add Beverage",
        price: "0.00",
        group_id: 135699,
        quantity: "1",
      },
      {
        id: "1150813",
        name: "Cheese",
        group_name: "Extra Toppings",
        price: "10.00",
        group_id: 135707,
        quantity: "1",
      },
    ]);
    // The vendor sample types group_id as a number, not a string.
    expect(typeof line.AddonItem.details[0].group_id).toBe("number");
  });

  it("parks a selection the catalog has no POS ids for (no client ids relayed)", async () => {
    seedOrder(
      "ord_ghost_option",
      [
        {
          id: "l1",
          petpoojaItemId: "118829149",
          name: "Veg Loaded Pizza",
          productId: "prod_118829149",
          price: 100,
          quantity: 1,
          // Not in the catalog option data.
          modifiers: [{ id: "not_real", name: "Mystery", priceDelta: 0 }],
        },
      ],
      {
        foodSubtotal: 100,
        gst: 4.76,
        packagingFee: 15,
        deliveryFee: 0,
        discount: 0,
        loyaltyDiscount: 0,
        grandTotal: 115,
      }
    );
    expect(await pushOrderToPetpooja("ord_ghost_option")).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(savedDocs["orders/ord_ghost_option"].petpoojaStatus).toBe("blocked_configuration");
    expect(String(savedDocs["orders/ord_ghost_option"].lastPetpoojaError)).toMatch(/Mystery/);
  });

  it("keeps price, tax and total balanced for a variation line", async () => {
    seedOrder(
      "ord_var_balance",
      [
        {
          id: "l1",
          petpoojaItemId: "7765809",
          name: "Garlic Bread",
          productId: "prod_7765809",
          price: 140,
          quantity: 2,
          customizations: [{ id: "7765097", name: "6Pieces", price: 20 }],
        },
      ],
      {
        foodSubtotal: 320,
        gst: 15.24,
        packagingFee: 15,
        deliveryFee: 0,
        discount: 0,
        loyaltyDiscount: 0,
        grandTotal: 335,
      }
    );

    expect(await pushOrderToPetpooja("ord_var_balance")).toBe(true);
    const info = payload().orderinfo.OrderInfo;
    const line = info.OrderItem.details[0];
    // absolute price of the selected variation
    expect(line.price).toBe("160.00");
    expect(line.quantity).toBe("2");
    // Tax rows are the exact sum of the serialized item tax.
    const itemTax = line.item_tax.reduce(
      (sum: number, t: any) => sum + Math.round(Number(t.amount) * 100),
      0
    );
    const taxRows = info.Tax.details.reduce(
      (sum: number, t: any) => sum + Math.round(Number(t.tax) * 100),
      0
    );
    expect(itemTax).toBe(1524);
    expect(taxRows).toBe(itemTax);
    expect(info.Order.details.tax_total).toBe("15.24");
    // Courier-free COD takeaway: restaurant due = 320 + 15 packaging.
    expect(info.Order.details.total).toBe("335.00");
    expect(info.Order.details.delivery_charges).toBe("0.00");
  });
});
