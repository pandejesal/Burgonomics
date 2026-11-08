import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * PETPOOJA_ENABLED=false means "the POS bridge is switched off".
 *
 * Before this suite, the flag only decided whether staging readiness DEMANDED
 * the PETPOOJA_* secrets (config/env.ts integrationEnabledForSecret). Nothing on
 * the outbound side read it, so a deliberately disabled integration still
 * POSTed KOTs, pulled the Menu API, leased retry rows and burned a paid order's
 * retry budget — and the QA relay happily minted a `pp_test_*` id.
 *
 * The contract asserted here:
 *   - disabled → NO outbound POST / menu GET, NO claim transaction, NO retry
 *     count burn, NO delivery-quote consumption, and no "synced" report;
 *   - disabled → authenticated INBOUND work is untouched (a menu PUSH still
 *     ingests; stock policy lives in another module and is not gated here);
 *   - queued orders are NOT relabelled into a terminal state — re-enabling
 *     resumes them from exactly where they were;
 *   - an enabled integration still sends (the fix must not become a no-op);
 *   - RBAC and the production refusal keep precedence over the disabled error.
 *
 * Mock-only, in-memory store: no network, no Firestore, no real provider.
 */

const { savedDocs, mockDb, counters } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  const counters = { collection: 0, transaction: 0, auto: 0 };

  const docRef = (col: string, id: string): any => {
    const path = `${col}/${id}`;
    const ref: any = {
      id,
      path,
      get: async () => ({
        exists: Object.prototype.hasOwnProperty.call(savedDocs, path),
        id,
        data: () => savedDocs[path],
        ref,
      }),
      set: async (data: any, opts?: any) => {
        savedDocs[path] =
          opts?.merge && savedDocs[path] ? { ...savedDocs[path], ...data } : { ...data };
      },
      update: async (data: any) => {
        savedDocs[path] = { ...(savedDocs[path] || {}), ...data };
      },
    };
    return ref;
  };

  const query = (
    col: string,
    filters: Array<[string, string, any]> = [],
    max = Infinity,
    afterId = ""
  ): any => ({
    where: (field: string, op: string, value: any) =>
      query(col, [...filters, [field, op, value]], max, afterId),
    orderBy: () => query(col, filters, max, afterId),
    limit: (n: number) => query(col, filters, max, afterId),
    startAfter: (doc: { id: string }) => query(col, filters, max, doc.id),
    get: async () => {
      const docs = Object.keys(savedDocs)
        .filter((p) => p.startsWith(`${col}/`))
        .sort()
        .filter((p) => p.slice(col.length + 1) > afterId)
        .filter((p) =>
          filters.every(([field, op, value]) => {
            if (op !== "==") throw new Error(`Unsupported query operator ${op}`);
            return savedDocs[p]?.[field] === value;
          })
        )
        .slice(0, max)
        .map((p) => {
          const id = p.slice(col.length + 1);
          return { id, data: () => savedDocs[p], ref: docRef(col, id) };
        });
      return { docs, empty: docs.length === 0 };
    },
  });

  const batch = () => {
    const pending: Array<{ ref: any; data: any; opts?: any }> = [];
    return {
      set: (ref: any, data: any, opts?: any) => {
        pending.push({ ref, data, opts });
      },
      commit: async () => {
        for (const entry of pending) {
          await entry.ref.set(entry.data, entry.opts);
        }
        pending.length = 0;
      },
    };
  };

  const mockDb: any = {
    collection: (col: string) => {
      counters.collection++;
      return {
        ...query(col),
        doc: (id?: string) => docRef(col, id || `auto_${counters.auto++}`),
        add: async (data: any) => {
          const id = `auto_${counters.auto++}`;
          savedDocs[`${col}/${id}`] = data;
          return { id };
        },
      };
    },
    batch,
    runTransaction: async (fn: any) => {
      counters.transaction++;
      return fn({
        get: (ref: any) => ref.get(),
        set: (ref: any, data: any, opts?: any) => ref.set(data, opts),
        update: (ref: any, data: any) => ref.update(data),
      });
    },
  };

  return { savedDocs, mockDb, counters };
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

vi.mock("firebase-functions/logger", () => ({
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  log: vi.fn(),
}));

import { pushOrderToPetpooja, resolvePetpoojaKotAmbiguity } from "../src/modules/petpooja/orderPush";
import { pushItemStockToPetpooja } from "../src/modules/petpooja/item86ingSync";
import { syncPetpoojaMenu, handlePetpoojaMenuWebhook } from "../src/modules/petpooja/menuSyncWebhook";
import {
  syncAllBranchesPetpoojaMenu,
  retryPendingPetpoojaOrdersWorker,
} from "../src/modules/petpooja/petpooja.scheduler";
import { runPetpoojaTestScenario } from "../src/modules/petpooja/testRunner";
import { config } from "../src/config/env";

const BRANCH = "b1";
const UID = "uid_disabled_1";
const DROP = { lat: 23.0338, lng: 72.5262 };
const FEE = 60;
const CREATED_AT = Date.now() - 60 * 60_000;

const fetchMock = vi.fn();
let prevMock: boolean;
let prevEnabled: boolean;
let prevCreds: { appKey: string; appSecret: string; accessToken: string };

function seedOrder(id: string, extra: Record<string, any> = {}) {
  savedDocs[`orders/${id}`] = {
    id,
    branchId: BRANCH,
    customerId: UID,
    userId: UID,
    customerPhone: "+919825000010",
    fulfillmentType: "DELIVERY",
    paymentMethod: "COD",
    createdAtMs: CREATED_AT,
    deliveryAddress: { lat: DROP.lat, lng: DROP.lng },
    items: [{ id: "l1", petpoojaItemId: "101", name: "Burger", price: 235, quantity: 1 }],
    pricing: {
      foodSubtotal: 235,
      gst: 11.19,
      packagingFee: 15,
      deliveryFee: 0,
      discount: 0,
      loyaltyDiscount: 0,
      grandTotal: 250,
    },
    ...extra,
  };
}

function seedQuote(id: string) {
  savedDocs[`delivery_fee_quotes/${id}`] = {
    uid: UID,
    branchId: BRANCH,
    storeId: "demo",
    dropLat: DROP.lat,
    dropLng: DROP.lng,
    fee: FEE,
    provider: "borzo",
    providerQuoteId: "QTE-BORZO-DISABLED",
    createdAt: "MOCK_TIMESTAMP",
    createdAtMs: CREATED_AT,
    expiresAt: CREATED_AT + 15 * 60_000,
    usedByOrderId: null,
  };
}

beforeEach(() => {
  for (const key of Object.keys(savedDocs)) delete savedDocs[key];
  counters.collection = 0;
  counters.transaction = 0;
  prevMock = config.mock.petpoojaPos;
  prevEnabled = config.petpooja.enabled;
  prevCreds = {
    appKey: config.petpooja.appKey,
    appSecret: config.petpooja.appSecret,
    accessToken: config.petpooja.accessToken,
  };
  config.mock.petpoojaPos = false; // live branch — every vendor call would be a POST
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ success: "1", orderID: "pp_disabled_1" }),
    json: async () => ({ success: "1", orderID: "pp_disabled_1" }),
  });
  vi.stubGlobal("fetch", fetchMock);
  savedDocs[`branches/${BRANCH}`] = {
    petpoojaStoreId: "PP_B1",
    petpoojaTaxes: [
      { id: "11", name: "CGST", rate: 2.5 },
      { id: "12", name: "SGST", rate: 2.5 },
    ],
  };
  savedDocs["branches/demo"] = { petpoojaStoreId: "demo", petpoojaTaxes: [] };
  savedDocs["products/l1"] = {
    id: "l1",
    branchId: BRANCH,
    price: 235,
    inStock: true,
    petpoojaItemId: "101",
    petpoojaItemTaxIds: ["11", "12"],
    petpoojaTaxInclusive: false,
    petpoojaTaxUnsupported: false,
    petpoojaGstType: "goods",
  };
});

afterEach(() => {
  config.mock.petpoojaPos = prevMock;
  config.petpooja.enabled = prevEnabled;
  config.petpooja.appKey = prevCreds.appKey;
  config.petpooja.appSecret = prevCreds.appSecret;
  config.petpooja.accessToken = prevCreds.accessToken;
  vi.unstubAllGlobals();
});

describe("PETPOOJA_ENABLED=false — KOT push", () => {
  it("refuses the outbound KOT without claiming, writing, or consuming the quote", async () => {
    config.petpooja.enabled = false;
    seedOrder("ord_disabled", { deliveryQuoteId: "dfq_disabled" });
    seedQuote("dfq_disabled");

    const caught = await pushOrderToPetpooja("ord_disabled").catch((e) => e);

    expect(caught?.code).toBe("PETPOOJA_DISABLED");
    expect(caught?.statusCode).toBe(503);
    expect(String(caught?.message)).toMatch(/disabled/i);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(counters.transaction).toBe(0);

    const order = savedDocs["orders/ord_disabled"];
    // No claim lease, no processing/synced status, no retry burn.
    expect(order.petpoojaPushClaimedAt).toBeUndefined();
    expect(order.petpoojaClaimedAt).toBeUndefined();
    expect(order.petpoojaStatus).toBeUndefined();
    expect(order.petpoojaRetryCount).toBeUndefined();
    expect(order.petpoojaNextRetryAtMs).toBeUndefined();
    // The courier quote is untouched (money is not spent by a disabled push).
    expect(savedDocs["delivery_fee_quotes/dfq_disabled"].usedByOrderId).toBeNull();
  });

  it("resumes the SAME order once the integration is re-enabled (queued work is not stranded)", async () => {
    config.petpooja.enabled = false;
    seedOrder("ord_resume", { deliveryQuoteId: "dfq_resume" });
    seedQuote("dfq_resume");
    await expect(pushOrderToPetpooja("ord_resume")).rejects.toMatchObject({
      code: "PETPOOJA_DISABLED",
    });

    config.petpooja.enabled = true;
    expect(await pushOrderToPetpooja("ord_resume")).toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(savedDocs["orders/ord_resume"].petpoojaStatus).toBe("synced");
    expect(savedDocs["delivery_fee_quotes/dfq_resume"].usedByOrderId).toBe("ord_resume");
  });

  it("still sends when the integration is enabled", async () => {
    config.petpooja.enabled = true;
    seedOrder("ord_enabled");

    expect(await pushOrderToPetpooja("ord_enabled")).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(savedDocs["orders/ord_enabled"].petpoojaStatus).toBe("synced");
  });
});

describe("PETPOOJA_ENABLED=false — scheduler lanes", () => {
  it("skips the menu sweep before any query", async () => {
    config.petpooja.enabled = false;
    counters.collection = 0;

    await expect(syncAllBranchesPetpoojaMenu()).resolves.toEqual({ syncedBranches: 0 });
    expect(counters.collection).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skips the retry worker without scanning, leasing, or burning attempts", async () => {
    config.petpooja.enabled = false;
    seedOrder("ord_queued", {
      petpoojaStatus: "pending_retry",
      petpoojaSyncStatus: "pending_retry",
      petpoojaRetryCount: 2,
      petpoojaNextRetryAtMs: Date.now() - 60_000,
    });
    counters.collection = 0;
    counters.transaction = 0;

    await expect(retryPendingPetpoojaOrdersWorker()).resolves.toEqual({
      retriedCount: 0,
      failedCount: 0,
    });
    expect(counters.collection).toBe(0);
    expect(counters.transaction).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();

    // The queued row keeps its exact state: no burn, no relabel, no dead-letter.
    const queued = savedDocs["orders/ord_queued"];
    expect(queued.petpoojaStatus).toBe("pending_retry");
    expect(queued.petpoojaRetryCount).toBe(2);
    expect(queued.petpoojaClaimedAt).toBeUndefined();
    expect(queued.kotSyncFailed).toBeUndefined();
  });
});

describe("PETPOOJA_ENABLED=false — menu sync keeps inbound work alive", () => {
  it("blocks the outbound Menu API pull", async () => {
    config.petpooja.enabled = false;

    const caught = await syncPetpoojaMenu("demo").catch((e) => e);

    expect(caught?.code).toBe("PETPOOJA_DISABLED");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(Object.keys(savedDocs).filter((k) => k.startsWith("petpooja_sync_logs/"))).toEqual([]);
    expect(savedDocs["branches/demo"].lastPetpoojaSync).toBeUndefined();
  });

  it("still ingests an authenticated inbound menu PUSH", async () => {
    config.petpooja.enabled = false;

    const result = await handlePetpoojaMenuWebhook({
      success: "1",
      rest_id: "demo",
      categories: [{ categoryid: "cat_1", categoryname: "Burgers" }],
      items: [
        {
          itemid: "pp_in_1",
          itemname: "Inbound Burger",
          price: 199,
          item_categoryid: "cat_1",
          itemcategoryid: "cat_1",
          in_stock: 1,
          item_attributeid: "1",
        },
      ],
    });

    expect(result.success).toBe(true);
    expect(result.itemCount).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(savedDocs["products/prod_demo_pp_in_1"]).toMatchObject({
      petpoojaItemId: "pp_in_1",
      name: "Inbound Burger",
      inStock: true,
    });
  });
});

describe("PETPOOJA_ENABLED=false — staff KOT reconciliation", () => {
  const staff = { uid: "staff_disabled", role: "branch_owner", branchIds: [BRANCH] };

  it("refuses the staff 'retry' decision without touching the parked order", async () => {
    config.petpooja.enabled = false;
    seedOrder("ord_parked", {
      petpoojaStatus: "reconciliation_required",
      petpoojaSyncStatus: "reconciliation_required",
      petpoojaAmbiguousProcessing: true,
      kotSyncFailed: true,
    });

    const caught = await resolvePetpoojaKotAmbiguity("ord_parked", "retry", staff).catch((e) => e);

    expect(caught?.code).toBe("PETPOOJA_DISABLED");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(counters.transaction).toBe(0);

    const order = savedDocs["orders/ord_parked"];
    // The parked flags survive verbatim — a disabled bridge must not erase the
    // operator's worklist entry.
    expect(order.petpoojaStatus).toBe("reconciliation_required");
    expect(order.petpoojaAmbiguousProcessing).toBe(true);
    expect(order.kotSyncFailed).toBe(true);
    expect(order.petpoojaResolution).toBeUndefined();
    expect(order.petpoojaResolveRetryAt).toBeUndefined();
  });

  it("keeps a human 'printed' observation available (it sends nothing)", async () => {
    // Not an outbound action: the staff member is telling us what they can SEE
    // at the outlet. Refusing it would strand a parked order behind a disabled
    // bridge with no other way to close it.
    config.petpooja.enabled = false;
    seedOrder("ord_parked_printed", {
      petpoojaStatus: "accepted_unconfirmed",
      petpoojaSyncStatus: "accepted_unconfirmed",
      petpoojaAcceptedNoId: true,
    });

    const result = await resolvePetpoojaKotAmbiguity("ord_parked_printed", "printed", staff);

    expect(result.resolved).toBe("printed");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(savedDocs["orders/ord_parked_printed"].kotPrintedSource).toBe("staff_confirmed");
  });
});

describe("PETPOOJA_ENABLED=false — outbound stock (86ing) push", () => {
  function seedStockProduct() {
    savedDocs[`products/prod_${BRANCH}_101`] = {
      id: `prod_${BRANCH}_101`,
      branchId: BRANCH,
      petpoojaItemId: "101",
      name: "Burger",
      inStock: true,
    };
  }

  it("refuses the live-shaped stock POST without fetching or stamping the product", async () => {
    config.petpooja.enabled = false;
    seedStockProduct();

    const caught = await pushItemStockToPetpooja(BRANCH, "101", false).catch((e) => e);

    expect(caught?.code).toBe("PETPOOJA_DISABLED");
    expect(caught?.statusCode).toBe(503);
    expect(String(caught?.message)).toMatch(/disabled/i);
    expect(fetchMock).not.toHaveBeenCalled();

    // No vendor traffic means nothing was 86'd locally either: the product doc
    // must not claim a POS sync that never happened.
    expect(savedDocs[`products/prod_${BRANCH}_101`].inStock).toBe(true);
    expect(savedDocs[`products/prod_${BRANCH}_101`].lastPetpoojaStockPush).toBeUndefined();
    expect(savedDocs[`products/prod_${BRANCH}_101`].lastPetpoojaSync).toBeUndefined();
  });

  it("sends the same valid push once the integration is re-enabled", async () => {
    config.petpooja.enabled = false;
    seedStockProduct();
    await expect(pushItemStockToPetpooja(BRANCH, "101", false)).rejects.toMatchObject({
      code: "PETPOOJA_DISABLED",
    });

    config.petpooja.enabled = true;
    const sent = await pushItemStockToPetpooja(BRANCH, "101", false);

    expect(sent).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(savedDocs[`products/prod_${BRANCH}_101`].inStock).toBe(false);
  });

  it("keeps identifier validation and branch RBAC ahead of the disabled refusal", async () => {
    config.petpooja.enabled = false;
    seedStockProduct();

    // Invalid/unsafe id: the pre-existing validation answers false, it does not
    // become a capability error.
    await expect(pushItemStockToPetpooja(BRANCH, "", false)).resolves.toBe(false);

    // Cross-branch staff: 403 before any capability disclosure.
    const otherBranchStaff = {
      uid: "staff_other",
      role: "branch_staff",
      branchIds: ["branch_somewhere_else"],
    };
    const caught = await pushItemStockToPetpooja(
      BRANCH,
      "101",
      false,
      otherBranchStaff as any
    ).catch((e) => e);
    expect(String(caught?.message)).toMatch(/outside your assigned branches/i);
    expect(caught?.code).not.toBe("PETPOOJA_DISABLED");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("PETPOOJA_ENABLED=false — QA relay", () => {
  it("refuses before building a scenario or minting a fake order id", async () => {
    config.petpooja.enabled = false;
    config.petpooja.appKey = "test_app_key";
    config.petpooja.appSecret = "test_app_secret";
    config.petpooja.accessToken = "test_access_token";

    const caught = await runPetpoojaTestScenario({
      scenarioId: "dinein-basic-kot",
      branchId: "branch_test_1",
    }).catch((e) => e);

    expect(caught?.code).toBe("PETPOOJA_DISABLED");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps branch RBAC ahead of the disabled refusal", async () => {
    config.petpooja.enabled = false;
    config.petpooja.appKey = "test_app_key";
    config.petpooja.appSecret = "test_app_secret";
    config.petpooja.accessToken = "test_access_token";
    savedDocs["branches/branch_test_1"] = { petpoojaStoreId: "branch_test_1" };
    const otherBranchOwner = {
      uid: "u_other",
      role: "branch_owner",
      branchIds: ["branch_somewhere_else"],
    };

    const caught = await runPetpoojaTestScenario(
      { scenarioId: "dinein-basic-kot", branchId: "branch_test_1" },
      otherBranchOwner
    ).catch((e) => e);

    expect(caught?.statusCode).toBe(403);
    expect(caught?.code).not.toBe("PETPOOJA_DISABLED");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the production refusal ahead of the disabled refusal", async () => {
    config.petpooja.enabled = false;
    const previous = process.env.BURGONOMICS_ENV;
    process.env.BURGONOMICS_ENV = "production";
    try {
      const caught = await runPetpoojaTestScenario({
        scenarioId: "dinein-basic-kot",
        branchId: "branch_test_1",
      }).catch((e) => e);

      expect(caught?.statusCode).toBe(403);
      expect(caught?.code).not.toBe("PETPOOJA_DISABLED");
      expect(String(caught?.message)).toMatch(/disabled in production/i);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.BURGONOMICS_ENV;
      else process.env.BURGONOMICS_ENV = previous;
    }
  });
});
