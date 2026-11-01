import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Part M capture (owner decision 2026-11-01, M1 + M2).
 *
 * The mapper writes `products.customizations` in the shape the customer app
 * (menuService.mapToCustomizationGroups) and the pricing engine read, with the
 * VENDOR's own ids, so the POS relay can stop trusting the client's modifier
 * ids. A variation row decides "has variations" — never `itemallowvariation`
 * (the vendor's own sample has variations with the flag at "0"). The effective
 * base price is computed first and passed through the UNCHANGED
 * resolvePushStock, so a priced variation item is sellable.
 *
 * Fixture: the vendor's published Push Menu sample (not real data).
 */

const { savedDocs, mockDb } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  const docRef = (col: string, id: string) => {
    const path = `${col}/${id}`;
    return {
      id,
      path,
      get: async () => ({
        id,
        exists: Object.prototype.hasOwnProperty.call(savedDocs, path),
        data: () => savedDocs[path],
      }),
      set: async (data: any, opts?: any) => {
        savedDocs[path] =
          opts?.merge && savedDocs[path] ? { ...savedDocs[path], ...data } : data;
      },
    };
  };
  const batch = {
    set: (ref: any, data: any, opts?: any) => {
      savedDocs[ref.path] =
        opts?.merge && savedDocs[ref.path] ? { ...savedDocs[ref.path], ...data } : data;
    },
    commit: async () => {},
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
      add: async (data: any) => {
        savedDocs[`${col}/added_${Object.keys(savedDocs).length}`] = data;
      },
    }),
    batch: () => batch,
    getAll: async (...refs: any[]) => Promise.all(refs.map((r: any) => r.get())),
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

import { syncPetpoojaMenu } from "../src/modules/petpooja/menuSyncWebhook";
import { calculateOrderPricing } from "../src/modules/payments/pricing.engine";
import { config } from "../src/config/env";

const fixture = JSON.parse(
  readFileSync(resolve(__dirname, "fixtures/petpooja-push-docsample.json"), "utf8")
).payload;

const BRANCH = "branch_m";
const realFixture = JSON.parse(readFileSync(resolve(__dirname, "fixtures/petpooja-push-real-20261101.json"), "utf8"));
const realEvidence = "C:/Users/DELL/Desktop/staging-review-20261030/06-provider-evidence/petpooja-console/menu-push-payload.json";
const product = (itemid: string) => savedDocs[`products/prod_${BRANCH}_${itemid}`];
const logs = () =>
  Object.keys(savedDocs)
    .filter((k) => k.startsWith("petpooja_sync_logs/"))
    .map((k) => savedDocs[k]);
const lastLog = () => logs()[logs().length - 1];

beforeEach(() => {
  for (const key of Object.keys(savedDocs)) delete savedDocs[key];
  savedDocs[`branches/${BRANCH}`] = { petpoojaStoreId: "xxxxxx", packagingFee: 15 };
});

describe("M2 mapper", () => {
  it("pins the trimmed real push, including uniform variation-scoped add-ons and replay", async () => {
    await syncPetpoojaMenu(BRANCH, undefined, realFixture);
    expect(product("30674").customizations[0]).toMatchObject({ id: "17259", kind: "addon", minSelections: 1, maxSelections: 1, posGroupId: 17259 });
    expect(Number.isInteger(product("30674").customizations[0].posGroupId)).toBe(true);
    expect(product("30674").customizations[0].options.map((o: any) => [o.id, o.price])).toEqual([["93021",10],["93023",20],["93019",30],["93027",40],["93025",50]]);
    for (const [id, row, price] of [["30673","10657618",290],["30672","10657617",270]] as const) {
      expect(product(id).price).toBe(price);
      expect(product(id).customizations[0].options).toEqual([{ id: row, name: "Full [8 Pieces]", price: 0, absolutePrice: price, packingCharge: 0, isAvailable: true, posItemId: row, posVariationId: "14178" }]);
    }
    expect(product("30672").customizations[1]).toEqual(product("30674").customizations[0]);
    expect(savedDocs[`branches/${BRANCH}`].petpoojaTaxes).toEqual([{ id: "3928", name: "CGST", rate: 2.5 }, { id: "3929", name: "SGST", rate: 2.5 }]);
    expect(product("30791")).toMatchObject({ price: 350, priceAvailable: true, packingCharge: 0, petpoojaItemTaxIds: ["3928","3929"], petpoojaTaxInclusive: false, petpoojaTaxUnsupported: false });
    expect(product("30791").customizations).toBeUndefined();
    expect(product("30768")).toMatchObject({ price: 0, priceAvailable: false, inStock: false });
    expect(lastLog()).toMatchObject({ addonGroupCount: 1, itemsAllowingAddons: 2, itemsAllowingVariations: 3, itemsWithVariationsDefined: 2, itemsWithVariationScopedAddons: 1, itemsWithUnsupportedVariationScopedAddons: 0 });
    const before = structuredClone(Object.fromEntries(Object.entries(savedDocs).filter(([k]) => k.startsWith("products/"))));
    await syncPetpoojaMenu(BRANCH, undefined, realFixture);
    expect(Object.fromEntries(Object.entries(savedDocs).filter(([k]) => k.startsWith("products/")))).toEqual(before);
  });

  it.each(["groups", "limits"])("fails closed when active variations disagree on %s", async (difference) => {
    const body = structuredClone(realFixture);
    const item = body.items.find((i: any) => i.itemid === "30672");
    const second = { ...structuredClone(item.variation[0]), id: "test-second-row" };
    if (difference === "groups") second.addon = [];
    else second.addon[0].addon_item_selection_min = "0";
    item.variation.push(second);
    const previous = config.petpooja.unknownStockPolicy;
    config.petpooja.unknownStockPolicy = "available";
    try {
      await syncPetpoojaMenu(BRANCH, undefined, body);
      expect(product("30672").inStock).toBe(false);
      expect(product("30672").customizations).toHaveLength(1);
      expect(lastLog().itemsWithUnsupportedVariationScopedAddons).toBe(1);
    } finally { config.petpooja.unknownStockPolicy = previous; }
  });

  it("lifts identical limits across multiple active variations, ignoring inactive differences", async () => {
    const body = structuredClone(realFixture);
    const item = body.items.find((i: any) => i.itemid === "30672");
    item.variation.push({ ...structuredClone(item.variation[0]), id: "test-second-row" });
    item.variation.push({ ...structuredClone(item.variation[0]), id: "test-inactive-row", active: "0", addon: [] });
    await syncPetpoojaMenu(BRANCH, undefined, body);
    expect(product("30672").customizations[1]).toMatchObject({ id: "17259", minSelections: 1, maxSelections: 1 });
    expect(lastLog().itemsWithUnsupportedVariationScopedAddons).toBe(0);
  });

  it.skipIf(!existsSync(realEvidence))("maps the whole 166-item evidence payload and prints its census", async () => {
    const body = JSON.parse(readFileSync(realEvidence, "utf8").replace(/^\uFEFF/, ""));
    await syncPetpoojaMenu(BRANCH, undefined, body);
    const log = lastLog();
    const census = Object.fromEntries(Object.entries(log).filter(([k]) => /Count$|^items|rawInStockValues|packagingUnderstood/.test(k)));
    console.log("REAL_PUSH_CENSUS", JSON.stringify(census));
    expect(body.items).toHaveLength(166);
    expect(Object.keys(savedDocs).filter(k => k.startsWith("products/"))).toHaveLength(166);
    expect(log).toMatchObject({ addonGroupCount: 1, itemsAllowingAddons: 2, itemsAllowingVariations: 83, itemsWithVariationsDefined: 2, itemsWithVariationScopedAddons: 1, itemsWithUnsupportedVariationScopedAddons: 0, packagingUnderstood: true });
    expect(product("30672").customizations[1].posGroupId).toBe(17259);
  });
  it("29: item 118829149 maps to its two add-on groups with the doc's ids", async () => {
    await syncPetpoojaMenu(BRANCH, undefined, fixture);
    const groups = product("118829149").customizations;
    expect(groups).toHaveLength(2);
    expect(groups.map((g: any) => g.id)).toEqual(["135699", "135707"]);
    expect(groups.map((g: any) => g.posGroupId)).toEqual([135699, 135707]);
    expect(groups[0]).toMatchObject({
      name: "Add Beverage",
      kind: "addon",
      minSelections: 0,
      maxSelections: 1,
    });
    expect(groups[0].options).toEqual([
      { id: "1150783", name: "Mojito", price: 0, isAvailable: true },
      { id: "1150784", name: "Hazelnut Mocha", price: 10, isAvailable: true },
    ]);
    expect(groups[1].options.map((o: any) => o.id)).toEqual([
      "1150810",
      "1150811",
      "1150812",
      "1150813",
    ]);
    expect(groups[1].maxSelections).toBe(4);
  });

  it("30: the doc-sample variation gives options 7765862/7765097, base 140, deltas 0/20", async () => {
    await syncPetpoojaMenu(BRANCH, undefined, fixture);
    const item = product("7765809");
    expect(item.price).toBe(140);
    expect(item.priceAvailable).toBe(true);

    const groups = item.customizations;
    expect(groups).toHaveLength(1);
    const variation = groups[0];
    expect(variation).toMatchObject({
      id: "variation",
      kind: "variation",
      minSelections: 1,
      maxSelections: 1,
    });
    expect(variation.options).toEqual([
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
    ]);
  });

  it("writes no customizations for a plain item (never wipes a partner value)", async () => {
    await syncPetpoojaMenu(BRANCH, undefined, fixture);
    // 118829149 has add-ons, 7765809 variations; add a plain item.
    const plain = JSON.parse(JSON.stringify(fixture));
    plain.items = [
      {
        itemid: "999",
        itemname: "Plain",
        item_categoryid: "500773",
        price: "50",
        in_stock: "1",
        itemallowaddon: "0",
        itemallowvariation: "0",
        addon: [],
        variation: [],
      },
    ];
    await syncPetpoojaMenu(BRANCH, undefined, plain);
    expect(product("999").customizations).toBeUndefined();
  });

  it("keeps inactive options listed with isAvailable:false", async () => {
    const off = JSON.parse(JSON.stringify(fixture));
    off.addongroups[0].addongroupitems[1].active = "0";
    await syncPetpoojaMenu(BRANCH, undefined, off);
    const options = product("118829149").customizations[0].options;
    expect(options[1]).toMatchObject({ id: "1150784", isAvailable: false, price: 10 });
  });

  it("33: customer-shape round trip — mapToCustomizationGroups output prices through the engine", async () => {
    await syncPetpoojaMenu(BRANCH, undefined, fixture);
    const stored = product("118829149");
    savedDocs[`products/prod_${BRANCH}_118829149`] = {
      ...stored,
      inStock: true,
    };

    // Faithful copy of customer menuService.mapToCustomizationGroups
    // (src/features/menu/services/menuService.ts:86-108). The customer repo's
    // own suite cannot run here; noted for the owner.
    const mapToCustomizationGroups = (raw: any[]) =>
      raw.map((group) => ({
        id: group.id?.toString() || group.addon_group_id || "",
        name: group.name || group.addon_group_name || "Options",
        options: (group.options || []).map((opt: any) => ({
          id: opt.id?.toString() || opt.optionId || "",
          name: opt.name || "",
          priceDelta: typeof opt.price === "number" ? opt.price : parseFloat(opt.price) || 0,
        })),
      }));
    const groups = mapToCustomizationGroups(stored.customizations);
    const cheese = groups[1].options.find((o: any) => o.name === "Cheese");
    expect(cheese).toMatchObject({ id: "1150813", priceDelta: 10 });

    // The customer displays 100 + 10; the engine (catalog option pricing,
    // PAY-16) must agree.
    const priced = await calculateOrderPricing({
      items: [
        {
          id: "l1",
          productId: `prod_${BRANCH}_118829149`,
          name: "Veg Loaded Pizza",
          price: 110,
          quantity: 1,
          customizations: [{ id: cheese.id, name: "Cheese", price: cheese.priceDelta }],
        },
      ],
      branchId: BRANCH,
      orderType: "takeaway",
    });
    expect(priced.foodSubtotal).toBe(110);
  });

  it("34: the real 17 Oct shape is unchanged — no add-ons, flagged variations with none defined", async () => {
    const real = {
      success: "1",
      restaurants: [{ details: { menusharingcode: "xxxxxx" } }],
      addongroups: [],
      items: [
        {
          itemid: "30792",
          itemname: "Unpriced variation item",
          item_categoryid: "500773",
          price: "0",
          in_stock: "2",
          itemallowaddon: "0",
          itemallowvariation: "1",
          variation: [],
          addon: [],
        },
      ],
    };
    await syncPetpoojaMenu(BRANCH, undefined, real);
    const item = product("30792");
    expect(item.customizations).toBeUndefined();
    expect(item.price).toBe(0);
    expect(item.priceAvailable).toBe(false);
    // resolvePushStock unchanged: unpriced stays unsellable.
    expect(item.inStock).toBe(false);

    const log = lastLog();
    expect(log.addonGroupCount).toBe(0);
    expect(log.itemsAllowingAddons).toBe(0);
    expect(log.itemsAllowingVariations).toBe(1);
    expect(log.itemsWithVariationsDefined).toBe(0);
  });

  it("34b: a variation item priced ONLY by its variations becomes sellable through resolvePushStock", async () => {
    const varied = {
      success: "1",
      restaurants: [{ details: { menusharingcode: "xxxxxx" } }],
      addongroups: [],
      items: [
        {
          itemid: "7765809",
          itemname: "Garlic Bread",
          item_categoryid: "500773",
          price: "0", // raw item price is 0; the variations carry the money
          in_stock: "1",
          itemallowaddon: "0",
          itemallowvariation: "1",
          variation: [
            { id: "1", variationid: "11", name: "3Pieces", price: "140", active: "1" },
            { id: "2", variationid: "22", name: "6Pieces", price: "160", active: "1" },
          ],
          addon: [],
        },
      ],
    };
    await syncPetpoojaMenu(BRANCH, undefined, varied);
    const item = product("7765809");
    expect(item.price).toBe(140);
    expect(item.priceAvailable).toBe(true);
    expect(item.inStock).toBe(true);
  });
});
