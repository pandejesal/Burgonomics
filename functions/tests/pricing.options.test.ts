import { describe, it, expect, vi } from "vitest";

/**
 * PAY-16: option prices come from the CATALOG, never from the order document.
 *
 * applyCatalogBasePrice re-priced the base but trusted
 * customizations[].price / modifiers[].priceDelta from the cart, so a tampered
 * client could make a paid add-on free (or negative). The product document's
 * own option data — the same `customizations` groups the customer app reads in
 * menuService.mapToCustomizationGroups — is the source of truth.
 *
 * A selection that is not in that data makes the order unpriceable:
 * 422 ITEM_OPTION_UNVERIFIED. A product with no option data plus a selection
 * is unpriceable too. Plain items and zero-priced options are unaffected.
 */

const CATALOG: Record<string, any> = {
  plain: { price: 199, inStock: true },
  with_options: {
    price: 199,
    inStock: true,
    customizations: [
      {
        id: "g_bun",
        name: "Bun",
        options: [
          { id: "opt_brioche", name: "Brioche", price: 30 },
          { id: "opt_plain", name: "Regular", price: 0 },
        ],
      },
      {
        id: "g_sauce",
        name: "Sauce",
        options: [{ id: "opt_extra_sauce", name: "Extra sauce", price: "15" }],
      },
    ],
  },
  no_option_data: { price: 199, inStock: true },
  negative_option: {
    price: 199,
    inStock: true,
    customizations: [
      { id: "g_bad", name: "Bad", options: [{ id: "opt_negative", name: "Bad", price: -30 }] },
    ],
  },
};

const { mockDb } = vi.hoisted(() => {
  const db: any = {
    collection: (col: string) => ({
      doc: (id: string) => ({
        id,
        get: async () => {
          if (col === "products") {
            const entry = (CATALOG as any)[id];
            return entry
              ? { exists: true, data: () => ({ ...entry }), id }
              : { exists: false, data: () => ({}), id };
          }
          if (col === "branches") {
            return { exists: true, data: () => ({ packagingFee: 15, royaltyPercentage: 5 }), id };
          }
          return { exists: false, data: () => ({}), id };
        },
        set: async () => {},
      }),
    }),
    getAll: async (...refs: any[]) => Promise.all(refs.map((r: any) => r.get())),
  };
  return { mockDb: db };
});

vi.mock("firebase-admin", () => {
  const FieldValue = { serverTimestamp: () => "MOCK_TIMESTAMP" };
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

function basket(productId: string, line: Record<string, any> = {}) {
  return {
    items: [
      { id: "l1", productId, name: "Burger", price: 199, quantity: 1, ...line },
    ],
    branchId: "b1",
    orderType: "takeaway" as const,
  };
}

async function errorOf(promise: Promise<any>): Promise<any> {
  return promise.then(
    () => null,
    (e) => e
  );
}

describe("PAY-16 options are priced from the catalog", () => {
  it("charges the catalog price for a paid add-on even when the cart says delta 0", async () => {
    const r = await calculateOrderPricing(
      basket("with_options", {
        customizations: [{ id: "opt_brioche", name: "Brioche", price: 0 }],
      })
    );
    // 199 base + catalog 30 brioche + 15 packaging
    expect(r.foodSubtotal).toBe(229);
    expect(r.grandTotal).toBe(244);
  });

  it("ignores a NEGATIVE client delta and uses the catalog price", async () => {
    const r = await calculateOrderPricing(
      basket("with_options", {
        customizations: [{ id: "opt_brioche", name: "Brioche", price: -500 }],
      })
    );
    expect(r.foodSubtotal).toBe(229);
  });

  it("prices modifiers from the catalog too (string prices included)", async () => {
    const r = await calculateOrderPricing(
      basket("with_options", {
        modifiers: [{ id: "opt_extra_sauce", name: "Extra sauce", priceDelta: 0 }],
      })
    );
    expect(r.foodSubtotal).toBe(214);
  });

  it("refuses a catalog option with a negative price (corrupt catalog)", async () => {
    const err = await errorOf(
      calculateOrderPricing(
        basket("negative_option", {
          customizations: [{ id: "opt_negative", name: "Bad", price: 0 }],
        })
      )
    );
    expect(err).toMatchObject({ statusCode: 422, code: "ITEM_OPTION_UNVERIFIED" });
  });

  it("refuses an option id the catalog does not have", async () => {
    const err = await errorOf(
      calculateOrderPricing(
        basket("with_options", {
          customizations: [{ id: "opt_not_real", name: "Mystery", price: 0 }],
        })
      )
    );
    expect(err).toMatchObject({ statusCode: 422, code: "ITEM_OPTION_UNVERIFIED" });
  });

  it("refuses a selection on a product with no option data", async () => {
    const err = await errorOf(
      calculateOrderPricing(
        basket("no_option_data", {
          modifiers: [{ id: "opt_extra_sauce", name: "Extra sauce", priceDelta: 0 }],
        })
      )
    );
    expect(err).toMatchObject({ statusCode: 422, code: "ITEM_OPTION_UNVERIFIED" });
  });

  it("leaves zero-priced options and plain items unaffected", async () => {
    const withZero = await calculateOrderPricing(
      basket("with_options", {
        customizations: [{ id: "opt_plain", name: "Regular", price: 0 }],
      })
    );
    expect(withZero.foodSubtotal).toBe(199);

    const plain = await calculateOrderPricing(basket("plain"));
    expect(plain.foodSubtotal).toBe(199);
  });

  it("matches what an honest customer app displays, options included (parity)", async () => {
    // The client prices `unitPrice` (base + option priceDelta) from the SAME
    // product document: menuService reads customizations[].options[].price.
    const clientBase = 199;
    const clientBrioche = 30; // from CATALOG.with_options
    const clientExtraSauce = 15;
    const clientUnit = clientBase + clientBrioche + clientExtraSauce;
    const server = await calculateOrderPricing(
      basket("with_options", {
        customizations: [{ id: "opt_brioche", name: "Brioche", price: 30 }],
        modifiers: [{ id: "opt_extra_sauce", name: "Extra sauce", priceDelta: 15 }],
      })
    );
    expect(server.foodSubtotal).toBe(clientUnit);
    // R2: the displayed total is base + packaging, GST included.
    expect(server.grandTotal).toBe(clientUnit + 15);
  });
});
