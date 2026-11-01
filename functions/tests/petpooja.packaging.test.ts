import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Part P (owner decision 2026-11-01) — packaging comes from Petpooja.
 *
 * P1 capture: `syncPetpoojaMenu` stores the outlet's raw packaging contract on
 * branches/{id}.packaging (with an `understood` flag), and each item's
 * `item_packingcharges` on products.packingCharge (number, or null for "").
 * A push with no packaging keys, or a failed fetch, leaves what is stored.
 *
 * P4: the sync-log row carries the packaging/add-on/variation census.
 *
 * Hermetic: in-memory Firestore shim, no network.
 */

const { savedDocs, mockDb } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  const docRef = (col: string, id: string) => {
    const path = `${col}/${id}`;
    return {
      id,
      path,
      get: async () => ({
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
  const query = (col: string): any => {
    const q: any = {
      where: () => q,
      orderBy: () => q,
      limit: () => q,
      startAfter: () => q,
      get: async () => ({
        empty: true,
        docs: [],
      }),
    };
    return q;
  };
  const mockDb: any = {
    collection: (col: string) => ({
      ...query(col),
      doc: (id?: string) => docRef(col, id as string),
      add: async (data: any) => {
        savedDocs[`${col}/added_${Object.keys(savedDocs).length}`] = data;
      },
    }),
    batch: () => batch,
  };
  return { savedDocs, mockDb };
});

vi.mock("firebase-admin", () => {
  const FieldValue = {
    serverTimestamp: () => "MOCK_TIMESTAMP",
    increment: (n: number) => n,
    arrayUnion: (item: any) => [item],
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

const fixture = JSON.parse(
  readFileSync(resolve(__dirname, "fixtures/petpooja-push-docsample.json"), "utf8")
).payload;

const BRANCH = "branch_demo";
const logs = () =>
  Object.keys(savedDocs)
    .filter((k) => k.startsWith("petpooja_sync_logs/"))
    .map((k) => savedDocs[k]);
const lastLog = () => logs()[logs().length - 1];

beforeEach(() => {
  for (const key of Object.keys(savedDocs)) delete savedDocs[key];
  savedDocs[`branches/${BRANCH}`] = { petpoojaStoreId: "xxxxxx", name: "Demo" };
});

describe("P1 packaging capture", () => {
  it("captures real NONE/blank/blank as understood zero without a warning", async () => {
    const body = structuredClone(fixture);
    Object.assign(body.restaurants[0].details, { packaging_applicable_on: "NONE", packaging_charge: "", packaging_charge_type: "" });
    await syncPetpoojaMenu(BRANCH, undefined, body);
    expect(savedDocs[`branches/${BRANCH}`].packaging).toMatchObject({ applicableOn: "NONE", charge: 0, understood: true });
    expect(lastLog().packagingWarning).toBeFalsy();
  });
  it("captures the outlet packaging contract from a push", async () => {
    await syncPetpoojaMenu(BRANCH, undefined, fixture);
    const branch = savedDocs[`branches/${BRANCH}`];
    expect(branch.packaging).toMatchObject({
      source: "petpooja",
      applicableOn: "ORDER",
      charge: 20,
      chargeType: "",
      taxOnPacking: 1,
      pcTaxIds: "11213,20375",
      understood: true,
    });
    expect(branch.packaging.syncedAt).toBe("MOCK_TIMESTAMP");
  });

  it("captures item_packingcharges as a number, and \"\" as null", async () => {
    await syncPetpoojaMenu(BRANCH, undefined, fixture);
    expect(savedDocs[`products/prod_${BRANCH}_118829149`].packingCharge).toBeNull();
    // The variation item's own item_packingcharges is "" too; the variation
    // rows carry 20 and are mapped with the variation options (Part M).
    expect(savedDocs[`products/prod_${BRANCH}_7765809`].packingCharge).toBeNull();
  });

  it("captures a numeric item packing charge", async () => {
    const withCharge = JSON.parse(JSON.stringify(fixture));
    withCharge.items[0].item_packingcharges = "20";
    await syncPetpoojaMenu(BRANCH, undefined, withCharge);
    expect(savedDocs[`products/prod_${BRANCH}_118829149`].packingCharge).toBe(20);
  });

  it("23(packaging keys present but charge \"0\") is captured as zero, understood", async () => {
    const zero = JSON.parse(JSON.stringify(fixture));
    zero.restaurants[0].details.packaging_charge = "0";
    await syncPetpoojaMenu(BRANCH, undefined, zero);
    expect(savedDocs[`branches/${BRANCH}`].packaging).toMatchObject({
      charge: 0,
      understood: true,
    });
  });

  it("stores understood:false for a shape the vendor doc does not define", async () => {
    const odd = JSON.parse(JSON.stringify(fixture));
    odd.restaurants[0].details.packaging_applicable_on = "CART";
    odd.restaurants[0].details.packaging_charge_type = "P";
    await syncPetpoojaMenu(BRANCH, undefined, odd);
    const packing = savedDocs[`branches/${BRANCH}`].packaging;
    expect(packing.understood).toBe(false);
    expect(packing.applicableOn).toBe("CART");
    expect(packing.chargeType).toBe("P");
    // Raw charge still captured — the fallback decision is not made here.
    expect(packing.charge).toBe(20);
  });

  it("treats ITEM / F / FIXED / percent as NOT understood (undocumented in the vendor doc)", async () => {
    const cases: Array<Record<string, string>> = [
      { applicableOn: "ITEM", chargeType: "" },
      { applicableOn: "ORDER", chargeType: "F" },
      { applicableOn: "ORDER", chargeType: "FIXED" },
      { applicableOn: "ITEM", chargeType: "P" },
    ];
    for (const variant of cases) {
      const body = JSON.parse(JSON.stringify(fixture));
      body.restaurants[0].details.packaging_applicable_on = variant.applicableOn;
      body.restaurants[0].details.packaging_charge_type = variant.chargeType;
      await syncPetpoojaMenu(BRANCH, undefined, body);
      const packing = savedDocs[`branches/${BRANCH}`].packaging;
      expect(packing.understood).toBe(false);
      expect(packing.applicableOn).toBe(variant.applicableOn);
      expect(packing.chargeType).toBe(variant.chargeType);
      // The raw values are preserved for the operator/log;
      expect(packing.charge).toBe(20);
    }
  });

  it("27: a later push with no packaging keys leaves the stored value", async () => {
    await syncPetpoojaMenu(BRANCH, undefined, fixture);
    const before = savedDocs[`branches/${BRANCH}`].packaging;

    const noKeys = JSON.parse(JSON.stringify(fixture));
    delete noKeys.restaurants[0].details.packaging_applicable_on;
    delete noKeys.restaurants[0].details.packaging_charge;
    delete noKeys.restaurants[0].details.packaging_charge_type;
    delete noKeys.restaurants[0].details.calculatetaxonpacking;
    delete noKeys.restaurants[0].details.pc_taxes_id;
    await syncPetpoojaMenu(BRANCH, undefined, noKeys);

    expect(savedDocs[`branches/${BRANCH}`].packaging).toEqual(before);
    // D8: the warning for a keyless push is recorded on the sync log.
    expect(lastLog().packagingWarning).toBe("NO_PACKAGING_KEYS");
    expect(lastLog().packagingUnderstood).toBeNull();
  });

  it("28: a failed menu fetch leaves the stored value untouched", async () => {
    await syncPetpoojaMenu(BRANCH, undefined, fixture);
    const before = savedDocs[`branches/${BRANCH}`].packaging;

    const refused = { success: "0", items: [], message: "unable to fetch Object from s3 bucket" };
    await expect(syncPetpoojaMenu(BRANCH, undefined, refused)).rejects.toBeTruthy();

    expect(savedDocs[`branches/${BRANCH}`].packaging).toEqual(before);
  });
});

describe("P4 sync log census", () => {
  it("records the packaging and menu-shape census, with no customer data", async () => {
    await syncPetpoojaMenu(BRANCH, undefined, fixture);
    const log = lastLog();
    expect(log.packagingUnderstood).toBe(true);
    expect(log.packagingRaw).toMatchObject({
      packaging_applicable_on: "ORDER",
      packaging_charge: "20",
      packaging_charge_type: "",
    });
    expect(log.addonGroupCount).toBe(2);
    expect(log.itemsAllowingAddons).toBe(1);
    expect(log.itemsAllowingVariations).toBe(0);
    expect(log.itemsWithVariationsDefined).toBe(1);
    expect(log.itemsWithVariationScopedAddons).toBe(0);
    expect(JSON.stringify(log)).not.toMatch(/customerName|customerPhone/);
  });

  it("counts variation-scoped add-ons so the unsupported shape stays visible", async () => {
    const scoped = JSON.parse(JSON.stringify(fixture));
    scoped.items[1].variation[0].addon = [{ addon_group_id: "135699" }];
    await syncPetpoojaMenu(BRANCH, undefined, scoped);
    expect(lastLog().itemsWithVariationScopedAddons).toBe(1);
  });
});
