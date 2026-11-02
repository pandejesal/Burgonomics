import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * P1-J — the POS line identity is the CATALOG's, never the cart's.
 *
 * The order document is client-written: `items[]` may carry any
 * `petpoojaItemId`, `meta.petpoojaItemId`, `itemId` or `id` string the caller
 * likes. Before this suite, the relay priced the line from the cheap catalog
 * product but forwarded the injected POS id, so the kitchen cooked the
 * expensive dish at the cheap price. Here the cheap product's catalog document
 * is the ONLY source of the POS id:
 *
 *   - an injected `petpoojaItemId` / `meta.petpoojaItemId` is ignored;
 *   - a catalog item with NO POS identity parks the order (no guessed id);
 *   - a catalog document belonging to another branch parks the order;
 *   - add-on ids/group ids come from the catalog option, not the modifier;
 *   - a walk-in (counter) order goes through the same path and still relays.
 *
 * Real document shapes only: branches/{id}, products/{id}, orders/{id}.
 */
const { savedDocs, mockDb } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  const paths = () => Object.keys(savedDocs);

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
          opts?.merge && savedDocs[path] ? { ...savedDocs[path], ...data } : { ...data };
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
  void paths;
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

const BRANCH = "branch_p1j";
const EXPENSIVE_POS_ID = "WAGYU-900";
const CHEAP_POS_ID = "CHEAP-99";

let prevMock: boolean;
const fetchMock = vi.fn();

function seedBranchBranchOnly() {
  savedDocs[`branches/${BRANCH}`] = {
    name: "P1J Outlet",
    petpoojaStoreId: "res_p1j",
    // Captured tax catalogue (no builder default) — gst is 0 in these orders.
    petpoojaTaxes: [
      { id: "3928", name: "CGST", rate: 2.5 },
      { id: "3929", name: "SGST", rate: 2.5 },
    ],
  };
}

function seedCatalog() {
  // The cheap product the customer actually selected.
  savedDocs["products/prod_cheap"] = {
    id: "prod_cheap",
    branchId: BRANCH,
    name: "Plain Bun",
    price: 99,
    inStock: true,
    petpoojaItemId: CHEAP_POS_ID,
  };
  // The expensive product whose identity the attacker wants the kitchen to cook.
  savedDocs["products/prod_wagyu"] = {
    id: "prod_wagyu",
    branchId: BRANCH,
    name: "Wagyu Burger",
    price: 900,
    inStock: true,
    petpoojaItemId: EXPENSIVE_POS_ID,
  };
}

function seedOrder(id: string, items: any[], extra: Record<string, any> = {}) {
  savedDocs[`orders/${id}`] = {
    id,
    branchId: BRANCH,
    customerId: "cust_p1j",
    userId: "cust_p1j",
    fulfillment: "takeaway",
    paymentMethod: "cod",
    customerName: "P1J Customer",
    customerPhone: "+919825000111",
    items,
    // Server-stamped pricing for the CHEAP product (99).
    pricing: { grandTotal: 99, gst: 0, packagingFee: 0, deliveryFee: 0, discount: 0 },
    status: "pending",
    ...extra,
  };
}

function relayedPayload(): any {
  const call = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
  expect(call).toBeTruthy();
  return JSON.parse(call[1].body);
}

beforeEach(() => {
  for (const key of Object.keys(savedDocs)) delete savedDocs[key];
  prevMock = config.mock.petpoojaPos;
  config.mock.petpoojaPos = false; // live path; the POST itself is stubbed
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ success: "1", orderID: "pp_p1j_1" }),
  });
  vi.stubGlobal("fetch", fetchMock);
  seedBranchBranchOnly();
  seedCatalog();
});

afterEach(() => {
  config.mock.petpoojaPos = prevMock;
  vi.unstubAllGlobals();
});

describe("P1-J POS identity comes from the catalog document only", () => {
  it("ignores an injected expensive petpoojaItemId on a cheap catalog line", async () => {
    seedOrder("ord_inject", [
      {
        id: "l1",
        productId: "prod_cheap",
        name: "Plain Bun",
        price: 99,
        quantity: 1,
        // Attacker-controlled identity bag, shaped exactly like the app's.
        petpoojaItemId: EXPENSIVE_POS_ID,
        meta: { petpoojaItemId: EXPENSIVE_POS_ID },
        itemId: EXPENSIVE_POS_ID,
      },
    ]);

    expect(await pushOrderToPetpooja("ord_inject")).toBe(true);
    const info = relayedPayload().orderinfo.OrderInfo;
    // The kitchen must receive the CHEAP item the server priced.
    expect(info.OrderItem.details).toHaveLength(1);
    expect(info.OrderItem.details[0].id).toBe(CHEAP_POS_ID);
    expect(info.OrderItem.details[0].id).not.toBe(EXPENSIVE_POS_ID);
    expect(info.OrderItem.details[0].price).toBe("99.00");
    // The order total follows the same cheap line.
    expect(info.Order.details.total).toBe("99.00");
  });

  it("derives the identity from a branch-scoped catalog doc id when the doc has none", async () => {
    // Legacy synced docs are keyed `prod_<branchId>_<petpoojaItemId>`.
    savedDocs["products/prod_branch_p1j_7765862"] = {
      id: "prod_branch_p1j_7765862",
      branchId: BRANCH,
      price: 120,
      inStock: true,
    };
    seedOrder("ord_prefixed", [
      {
        id: "l1",
        productId: "prod_branch_p1j_7765862",
        name: "Legacy Bun",
        price: 120,
        quantity: 1,
        petpoojaItemId: EXPENSIVE_POS_ID,
      },
    ]);

    expect(await pushOrderToPetpooja("ord_prefixed")).toBe(true);
    const line = relayedPayload().orderinfo.OrderInfo.OrderItem.details[0];
    expect(line.id).toBe("7765862");
    expect(line.id).not.toBe(EXPENSIVE_POS_ID);
  });

  it("parks the order when the catalog item has no POS identity — never guesses", async () => {
    savedDocs["products/prod_local"] = {
      id: "prod_local",
      branchId: BRANCH,
      name: "House Combo",
      price: 50,
      inStock: true,
    };
    seedOrder("ord_no_mapping", [
      {
        id: "l1",
        productId: "prod_local",
        name: "House Combo",
        price: 50,
        quantity: 1,
        petpoojaItemId: EXPENSIVE_POS_ID,
      },
    ]);

    expect(await pushOrderToPetpooja("ord_no_mapping")).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    const doc = savedDocs["orders/ord_no_mapping"];
    expect(doc.petpoojaStatus).toBe("blocked_configuration");
    expect(String(doc.lastPetpoojaError)).toMatch(/no verified Petpooja item id/);
    expect(doc.petpoojaOrderId).toBeUndefined();
  });

  it("parks the order when the catalog document belongs to another branch", async () => {
    savedDocs["products/prod_foreign"] = {
      id: "prod_foreign",
      branchId: "branch_other",
      name: "Foreign Item",
      price: 99,
      inStock: true,
      petpoojaItemId: CHEAP_POS_ID,
    };
    seedOrder("ord_foreign", [
      {
        id: "l1",
        productId: "prod_foreign",
        name: "Foreign Item",
        price: 99,
        quantity: 1,
      },
    ]);

    expect(await pushOrderToPetpooja("ord_foreign")).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    const doc = savedDocs["orders/ord_foreign"];
    expect(doc.petpoojaStatus).toBe("blocked_configuration");
    expect(String(doc.lastPetpoojaError)).toMatch(/branch/);
  });

  it("takes add-on id and group id from the catalog option, not the client modifier", async () => {
    savedDocs["products/prod_with_option"] = {
      id: "prod_with_option",
      branchId: BRANCH,
      price: 99,
      inStock: true,
      petpoojaItemId: CHEAP_POS_ID,
      customizations: [
        {
          id: "g_catalog",
          name: "Add-ons",
          kind: "addon",
          posGroupId: 7,
          options: [{ id: "OPT_CATALOG", name: "Cheese", price: 10, isAvailable: true }],
        },
      ],
    };
    seedOrder("ord_addon", [
      {
        id: "l1",
        productId: "prod_with_option",
        name: "Plain Bun",
        price: 109,
        quantity: 1,
        // Client claims a DIFFERENT POS addon and group id.
        modifiers: [
          {
            id: "OPT_CATALOG",
            name: "Cheese",
            priceDelta: 10,
            petpoojaItemId: EXPENSIVE_POS_ID,
            petpoojaGroupId: 999,
          },
        ],
      },
    ]);

    expect(await pushOrderToPetpooja("ord_addon")).toBe(true);
    const line = relayedPayload().orderinfo.OrderInfo.OrderItem.details[0];
    expect(line.AddonItem.details).toEqual([
      {
        id: "OPT_CATALOG",
        name: "Cheese",
        group_name: "Add-ons",
        price: "10.00",
        group_id: 7,
        quantity: "1",
      },
    ]);
    expect(line.AddonItem.details[0].id).not.toBe(EXPENSIVE_POS_ID);
    expect(line.AddonItem.details[0].group_id).not.toBe(999);
  });

  it("keeps the walk-in / counter order path working from the same catalog identity", async () => {
    savedDocs["branches/" + BRANCH].petpoojaTaxes = [
      { id: "3928", name: "CGST", rate: 2.5 },
      { id: "3929", name: "SGST", rate: 2.5 },
    ];
    seedOrder(
      "ord_pos_walkin",
      [
        {
          id: "itm_1",
          productId: "prod_cheap",
          name: "Plain Bun",
          price: 99,
          quantity: 2,
          // The partner app stamps the item's POS id too; it must agree with
          // (and never override) the catalog.
          petpoojaItemId: CHEAP_POS_ID,
        },
      ],
      {
        customerId: "cust_walkin",
        userId: "staff_uid_1",
        customerName: "Walk-in Customer",
        orderType: "dinein",
        tableNumber: "04",
        paymentMethod: "cod",
        paymentStatus: "completed",
        pricing: { grandTotal: 198, gst: 0, packagingFee: 0, deliveryFee: 0, discount: 0 },
      }
    );

    expect(await pushOrderToPetpooja("ord_pos_walkin")).toBe(true);
    const info = relayedPayload().orderinfo.OrderInfo;
    expect(info.OrderItem.details[0].id).toBe(CHEAP_POS_ID);
    expect(info.OrderItem.details[0].quantity).toBe("2");
    expect(info.Order.details.order_type).toBe("D");
    expect(info.Order.details.table_no).toBe("04");
    expect(info.Order.details.payment_type).toBe("COD");
  });
});
