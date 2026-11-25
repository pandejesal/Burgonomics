import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * SEC-11 (A3 finding 1, owner condition 5): the backend KOT/cancel/menu paths
 * must read the Petpooja outlet binding from the brand-only
 * `branch_secrets/{branchId}`, not from the branch document every operator role
 * can read — with the legacy `branches` copy still honoured as a fallback.
 *
 * This is the behavioural half of the finding. `tests/branches.secrets.test.ts`
 * proves the loader; this file proves the REAL handlers consume it:
 *   - `pushOrderToPetpooja` POSTs the `restID` taken from `branch_secrets`, and
 *     still refuses (fail-closed, no POST) when neither document links an outlet;
 *   - the reverse restID lookup resolves a `branch_secrets`-only outlet;
 *   - the QA relay mapping resolves a `branch_secrets`-only outlet;
 *   - a legacy `branches` copy keeps an unmigrated outlet working.
 *
 * On base `d7ecb84` a `branch_secrets`-only fixture resolves to NOTHING (the
 * collection did not exist and every reader looked only at `branches`), so the
 * push refuses and the lookups return null — the RED this file was written for.
 */
const h = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};

  const makeRef = (path: string, id: string): any => ({
    id,
    path,
    get: vi.fn(async () => ({
      id,
      exists: savedDocs[path] !== undefined,
      data: () => savedDocs[path],
      ref: makeRef(path, id),
    })),
    set: vi.fn(async (data: any, opts?: any) => {
      savedDocs[path] = opts?.merge ? { ...(savedDocs[path] || {}), ...data } : { ...data };
    }),
    update: vi.fn(async (data: any) => {
      if (savedDocs[path] === undefined) throw new Error(`No document to update: ${path}`);
      savedDocs[path] = { ...savedDocs[path], ...data };
    }),
    delete: vi.fn(async () => {
      delete savedDocs[path];
    }),
  });

  const query = (col: string, filters: Array<[string, string, any]>) => {
    const api: any = {
      limit: () => api,
      orderBy: () => api,
      startAfter: () => api,
      where: (field: string, op: string, value: any) =>
        query(col, [...filters, [field, op, value]]),
      get: async () => {
        const docs = Object.keys(savedDocs)
          .filter((k) => k.startsWith(`${col}/`) && !k.slice(col.length + 1).includes("/"))
          .filter((k) => filters.every(([f, , v]) => savedDocs[k]?.[f] === v))
          .map((k) => {
            const id = k.slice(col.length + 1);
            return { id, exists: true, data: () => savedDocs[k], ref: makeRef(k, id) };
          });
        return { empty: docs.length === 0, docs };
      },
    };
    return api;
  };

  const mockDb: any = {
    collection: (col: string) => {
      const api: any = query(col, []);
      return { ...api, doc: (id: string) => makeRef(`${col}/${id}`, id) };
    },
    runTransaction: async (fn: any) =>
      fn({
        get: (ref: any) => ref.get(),
        set: (ref: any, data: any, opts?: any) => ref.set(data, opts),
        update: (ref: any, data: any) => ref.update(data),
      }),
  };

  return { savedDocs, mockDb };
});

const { savedDocs, mockDb } = h;

vi.mock("firebase-admin", () => {
  const FieldValue = {
    serverTimestamp: () => "MOCK_TIMESTAMP",
    increment: (n: number) => n,
    arrayUnion: (item: any) => [item],
    arrayRemove: (...items: any[]) => items,
    delete: () => "MOCK_DELETE",
  };
  const FieldPath = { documentId: () => "__name__" };
  const firestoreFn: any = vi.fn(() => h.mockDb);
  firestoreFn.FieldValue = FieldValue;
  firestoreFn.FieldPath = FieldPath;
  return {
    default: {
      firestore: firestoreFn,
      auth: vi.fn(() => ({})),
      messaging: vi.fn(() => ({})),
      initializeApp: vi.fn(),
      apps: [{ name: "mock" }],
    },
    firestore: firestoreFn,
    FieldValue,
    FieldPath,
    auth: vi.fn(() => ({})),
    messaging: vi.fn(() => ({})),
    initializeApp: vi.fn(),
    apps: [{ name: "mock" }],
  };
});

import { pushOrderToPetpooja } from "../src/modules/petpooja/orderPush";
import { resolveBranchIdForRestId } from "../src/modules/petpooja/item86ingSync";
import { resolveRelayOutletMapping } from "../src/modules/petpooja/testRunner";
import { config } from "../src/config/env";

const BRANCH = "branch_sec11";
const OUTLET = "PP_SEC11_01";

/** The KOT fixture: a takeaway order whose POS lines come from the catalog. */
function seedOrder(): void {
  savedDocs[`products/prod_${BRANCH}_7765862`] = {
    id: `prod_${BRANCH}_7765862`,
    branchId: BRANCH,
    petpoojaItemId: "7765862",
    price: 199,
    inStock: true,
    petpoojaItemTaxIds: ["3928", "3929"],
    petpoojaTaxInclusive: false,
    petpoojaTaxUnsupported: false,
    petpoojaGstType: "goods",
  };
  savedDocs["orders/kot_sec11"] = {
    id: "kot_sec11",
    fulfillment: "takeaway",
    payment: { method: "cod" },
    branchId: BRANCH,
    customerName: "Sec Eleven",
    customerPhone: "+919825000011",
    items: [
      {
        id: "itm_1",
        productId: `prod_${BRANCH}_7765862`,
        petpoojaItemId: "7765862",
        name: "Burger",
        price: 199,
        quantity: 1,
      },
    ],
    pricing: { grandTotal: 199, gst: 9.95 },
    status: "pending",
  };
  // The BRANCH document carries only display data (what every operator role
  // may read). No POS identifiers.
  savedDocs[`branches/${BRANCH}`] = {
    name: "Surat Adajan",
    address: "Prime Arcade",
    phone: "+912612345678",
    petpoojaTaxes: [
      { id: "3928", name: "CGST", rate: 2.5 },
      { id: "3929", name: "SGST", rate: 2.5 },
    ],
  };
}

describe("the KOT push reads restID from branch_secrets", () => {
  let prevMock: boolean;
  const fetchMock = vi.fn();

  beforeEach(() => {
    for (const key of Object.keys(savedDocs)) delete savedDocs[key];
    prevMock = config.mock.petpoojaPos;
    config.mock.petpoojaPos = false; // live path — the POS POST is stubbed
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    seedOrder();
  });

  afterEach(() => {
    config.mock.petpoojaPos = prevMock;
    vi.unstubAllGlobals();
  });

  const posAck = () => ({
    ok: true,
    status: 200,
    json: async () => ({ success: "1", petpooja_order_id: "pp_sec11_1" }),
  });

  /** The vendor contract nests the outlet code at orderinfo.OrderInfo.Restaurant. */
  function sentRestId(): string | undefined {
    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as any).body));
    return body?.orderinfo?.OrderInfo?.Restaurant?.details?.restID;
  }

  it("POSTs the outlet code stored ONLY in branch_secrets", async () => {
    savedDocs[`branch_secrets/${BRANCH}`] = {
      branchId: BRANCH,
      petpoojaStoreId: OUTLET,
      petpooja: { appKey: "k", appSecret: "s", accessToken: "t" },
    };
    fetchMock.mockResolvedValueOnce(posAck());

    const pushed = await pushOrderToPetpooja("kot_sec11");
    expect(pushed).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sentRestId()).toBe(OUTLET);
  });

  it("still refuses to POST when no document links an outlet", async () => {
    savedDocs[`branch_secrets/${BRANCH}`] = { branchId: BRANCH };
    const pushed = await pushOrderToPetpooja("kot_sec11");
    // Fail-closed: nothing reaches the vendor and no acceptance is invented.
    expect(pushed).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(savedDocs["orders/kot_sec11"].petpoojaOrderId).toBeUndefined();
  });

  it("honours the legacy branches copy until the migration is applied", async () => {
    savedDocs[`branches/${BRANCH}`].petpoojaStoreId = "PP_LEGACY_01";
    fetchMock.mockResolvedValueOnce(posAck());

    const pushed = await pushOrderToPetpooja("kot_sec11");
    expect(pushed).toBe(true);
    expect(sentRestId()).toBe("PP_LEGACY_01");
  });
});

describe("reverse lookups resolve a branch_secrets outlet", () => {
  beforeEach(() => {
    for (const key of Object.keys(savedDocs)) delete savedDocs[key];
    savedDocs[`branch_secrets/${BRANCH}`] = { branchId: BRANCH, petpoojaStoreId: OUTLET };
    savedDocs[`branches/${BRANCH}`] = { name: "Surat Adajan" };
  });

  it("maps an incoming restID to the branch through branch_secrets", async () => {
    expect(await resolveBranchIdForRestId(OUTLET)).toBe(BRANCH);
  });

  it("maps the QA relay outlet through branch_secrets", async () => {
    const mapping = await resolveRelayOutletMapping(OUTLET);
    expect(mapping).toMatchObject({ partnerBranchId: BRANCH, petpoojaStoreId: OUTLET });
  });

  it("still resolves a legacy branches-only outlet", async () => {
    delete savedDocs[`branch_secrets/${BRANCH}`];
    savedDocs[`branches/${BRANCH}`].petpoojaStoreId = "PP_LEGACY_02";
    expect(await resolveBranchIdForRestId("PP_LEGACY_02")).toBe(BRANCH);
  });
});
