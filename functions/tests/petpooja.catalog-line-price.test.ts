import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * POS-11: the POS line price must come from the SERVER CATALOG, not from the
 * price written on the order document (client-written), which now feeds POS
 * `total` through the restaurant-due calculation.
 *
 * Pinned here: a doc line claiming ₹1 for a ₹500 catalog item is relayed at
 * ₹500 (and the POS total follows), and an item that cannot be priced from the
 * catalog parks the order instead of falling back to the document's price.
 */

const { savedDocs, mockDb } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};

  const docRef = (col: string, id: string): any => {
    const path = `${col}/${id}`;
    const ref: any = {
      id,
      path,
      get: async () => ({
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

  const mockDb: any = {
    collection: (col: string) => ({
      doc: (id: string) => docRef(col, id),
      where: (field: string, _op: string, value: any) => {
        const query: any = {
          limit: () => query,
          get: async () => {
            const docs = Object.keys(savedDocs)
              .filter((k) => k.startsWith(`${col}/`))
              .filter((k) => savedDocs[k]?.[field] === value)
              .map((k) => {
                const id = k.slice(col.length + 1);
                return { id, data: () => savedDocs[k], ref: docRef(col, id) };
              });
            return { empty: docs.length === 0, docs };
          },
        };
        return query;
      },
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

const BRANCH = "b_price";
const UID = "uid_price";

let prevMock: boolean;
const fetchMock = vi.fn();

function seedOrder(id: string, items: any[]) {
  savedDocs[`orders/${id}`] = {
    id,
    branchId: BRANCH,
    customerId: UID,
    userId: UID,
    fulfillmentType: "TAKEAWAY",
    paymentMethod: "COD",
    createdAtMs: Date.now() - 60_000,
    items,
    // Server-stamped cart total for the CORRECT price (500 + 15 packing).
    pricing: {
      foodSubtotal: 500,
      gst: 23.81,
      packagingFee: 15,
      deliveryFee: 0,
      discount: 0,
      loyaltyDiscount: 0,
      grandTotal: 515,
    },
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
    json: async () => ({ success: "1", orderID: "pp_price_1" }),
  });
  vi.stubGlobal("fetch", fetchMock);
  savedDocs[`branches/${BRANCH}`] = {
    petpoojaStoreId: "PP_B",
    petpoojaTaxes: [
      { id: "11", name: "CGST", rate: 2.5 },
      { id: "12", name: "SGST", rate: 2.5 },
    ],
  };
  savedDocs["products/prod_500"] = { price: 500, inStock: true };
});

afterEach(() => {
  config.mock.petpoojaPos = prevMock;
  vi.unstubAllGlobals();
});

describe("POS-11 POS line prices come from the catalog", () => {
  it("relays the catalog price even when the order line claims ₹1", async () => {
    seedOrder("ord_price", [
      { id: "l1", petpoojaItemId: "101", name: "Big", productId: "prod_500", price: 1, quantity: 1 },
    ]);
    expect(await pushOrderToPetpooja("ord_price")).toBe(true);

    const info = payload().orderinfo.OrderInfo;
    expect(info.OrderItem.details[0].price).toBe("500.00");
    expect(info.OrderItem.details[0].final_price).toBe("500.00");
    // Restaurant due follows the catalog price: 500 + 15 packing.
    expect(info.Order.details.total).toBe("515.00");
    expect(info.Order.details.tax_total).toBe("23.81");
  });

  it("prices a line by line index when the doc mixes a real and a cheap line", async () => {
    savedDocs["products/prod_199"] = { price: 199, inStock: true };
    seedOrder("ord_price_mix", [
      { id: "l1", petpoojaItemId: "101", name: "Cheap", productId: "prod_199", price: 1, quantity: 1 },
      { id: "l2", petpoojaItemId: "102", name: "Big", productId: "prod_500", price: 1, quantity: 2 },
    ]);
    expect(await pushOrderToPetpooja("ord_price_mix")).toBe(true);
    const lines = payload().orderinfo.OrderInfo.OrderItem.details;
    expect(lines.map((l: any) => l.price)).toEqual(["199.00", "500.00"]);
    expect(lines.map((l: any) => l.final_price)).toEqual(["199.00", "500.00"]);
  });

  it("parks the order instead of falling back to the document price", async () => {
    seedOrder("ord_price_missing", [
      {
        id: "l1",
        petpoojaItemId: "101",
        name: "Ghost",
        productId: "prod_missing",
        price: 1,
        quantity: 1,
      },
    ]);
    const pushed = await pushOrderToPetpooja("ord_price_missing");
    expect(pushed).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(savedDocs["orders/ord_price_missing"].petpoojaStatus).toBe("blocked_configuration");
    expect(String(savedDocs["orders/ord_price_missing"].lastPetpoojaError)).toMatch(/Ghost/);
  });
});

describe("PAY-16 KOT option prices come from the catalog", () => {
  it("relays the catalog add-on price when the order line claims delta 0", async () => {
    savedDocs["products/prod_optioned"] = {
      price: 200,
      inStock: true,
      customizations: [
        {
          id: "g1",
          name: "Add-ons",
          kind: "addon",
          posGroupId: 7,
          options: [{ id: "opt_cheese", name: "Cheese", price: 30, isAvailable: true }],
        },
      ],
    };
    seedOrder("ord_option_price", [
      {
        id: "l1",
        petpoojaItemId: "101",
        name: "Burger",
        productId: "prod_optioned",
        price: 200,
        quantity: 1,
        // M3: the client only names the selection; ids/price come from the
        // catalog option (no client POS ids are trusted any more).
        modifiers: [{ id: "opt_cheese", name: "Cheese", priceDelta: 0 }],
      },
    ]);
    expect(await pushOrderToPetpooja("ord_option_price")).toBe(true);
    const info = payload().orderinfo.OrderInfo;
    expect(info.OrderItem.details[0].price).toBe("230.00");
    expect(info.OrderItem.details[0].final_price).toBe("230.00");
    expect(info.OrderItem.details[0].AddonItem.details[0]).toMatchObject({
      id: "opt_cheese",
      group_id: 7,
      price: "30.00",
    });
  });

  it("parks the order when a selected option is not on the menu", async () => {
    seedOrder("ord_option_ghost", [
      {
        id: "l1",
        petpoojaItemId: "101",
        name: "Burger",
        productId: "prod_500",
        price: 500,
        quantity: 1,
        modifiers: [{ id: "opt_not_real", name: "Mystery", priceDelta: 0 }],
      },
    ]);
    expect(await pushOrderToPetpooja("ord_option_ghost")).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(savedDocs["orders/ord_option_ghost"].petpoojaStatus).toBe("blocked_configuration");
    expect(String(savedDocs["orders/ord_option_ghost"].lastPetpoojaError)).toMatch(/Mystery/);
  });
});
