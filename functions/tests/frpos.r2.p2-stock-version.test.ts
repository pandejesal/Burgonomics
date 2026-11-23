import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";

/**
 * r2 P2 — a stock change that lands between an auto-restore and the vendor POST
 * must stop the stale send; overlapping sends must be reconciled by version so
 * only one POST goes out for a given version.
 */
const h = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  const state = { afterRestore: null as null | (() => void), duringPost: null as null | (() => Promise<void>), posts: 0, bodies: [] as any[], remote: false };
  const makeRef = (path: string, id: string): any => ({
    id,
    get: vi.fn(async () => ({ id, exists: savedDocs[path] !== undefined, data: () => savedDocs[path], ref: makeRef(path, id) })),
    set: vi.fn(async (data: any, opts?: any) => {
      savedDocs[path] = opts?.merge ? { ...(savedDocs[path] || {}), ...data } : { ...data };
    }),
    update: vi.fn(async (data: any) => { savedDocs[path] = { ...savedDocs[path], ...data }; }),
  });
  const mockDb: any = {
    collection: (col: string) => ({
      doc: (id: string) => makeRef(`${col}/${id}`, id),
      where: (field: string, op: string, val: any) => ({
        limit: (n: number) => ({
          get: async () => {
            const docs = Object.keys(savedDocs)
              .filter((k) => k.startsWith(`${col}/`))
              .filter((k) => {
                const raw = savedDocs[k]?.[field];
                const ms = typeof raw === 'number' ? raw : raw?.toMillis?.() ?? 0;
                return op === '==' ? raw === val : op === '<=' ? ms > 0 && ms <= (val?.toMillis?.() ?? val) : false;
              })
              .slice(0, n)
              .map((k) => {
                const id = k.slice(col.length + 1);
                return { id, exists: true, data: () => savedDocs[k], ref: makeRef(k, id) };
              });
            return { docs, empty: docs.length === 0 };
          },
        }),
      }),
    }),
    runTransaction: async (fn: any) => {
      const result = await fn({ get: (r: any) => r.get(), set: (r: any, d: any, o?: any) => r.set(d, o), update: (r: any, d: any) => r.update(d) });
      if (state.afterRestore) { const hook = state.afterRestore; state.afterRestore = null; hook(); }
      return result;
    },
  };
  return { savedDocs, state, mockDb };
});
const { savedDocs, state, mockDb } = h;

vi.mock("firebase-admin", () => {
  const FieldValue = { serverTimestamp: () => "MOCK_TS", increment: (n: number) => n + 1, arrayUnion: (i: any) => [i], delete: () => "MOCK_DELETE" };
  const firestoreFn: any = vi.fn(() => h.mockDb);
  firestoreFn.FieldValue = FieldValue;
  firestoreFn.Timestamp = { fromMillis: (ms: number) => ({ toMillis: () => ms }) };
  return {
    default: { firestore: firestoreFn, auth: vi.fn(), messaging: vi.fn(), initializeApp: vi.fn(), apps: [{ name: "mock" }] },
    firestore: firestoreFn, auth: vi.fn(), messaging: vi.fn(), initializeApp: vi.fn(), apps: [{ name: "mock" }],
  };
});
vi.mock("../src/modules/petpooja/client", async (importOriginal) => {
  const actual: any = await importOriginal();
  return { ...actual, isPetpoojaEnabled: () => true, getPetpoojaConfig: () => ({ stockUrl: "https://pos.invalid/stock", appKey: "k", appSecret: "s", accessToken: "t" }) };
});
vi.mock("../src/core/errors", async (importOriginal) => {
  const actual: any = await importOriginal();
  return { ...actual, captureErrorSnapshot: vi.fn(async () => "err") };
});

import { restoreDueSoldOutItems } from "../src/modules/menu/soldOutTimer.scheduler";
import { pushItemStockToPetpooja } from "../src/modules/petpooja/item86ingSync";

const originalFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = vi.fn(async (_url: any, init: any) => {
    state.posts++;
    const body = JSON.parse(String(init.body));
    state.bodies.push(body);
    if (state.duringPost) { const callback = state.duringPost; state.duringPost = null; await callback(); }
    state.remote = body.inStock;
    return new Response(JSON.stringify({ success: "1" }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as any;
});
afterAll(() => { globalThis.fetch = originalFetch; });

beforeEach(() => {
  for (const k of Object.keys(savedDocs)) delete savedDocs[k];
  state.posts = 0; state.bodies = []; state.afterRestore = null; state.duringPost = null; state.remote = false;
  savedDocs["branches/b1"] = { id: "b1", petpoojaStoreId: "31z58ciw0h" };
  savedDocs["products/prod_b1_30791"] = {
    id: "prod_b1_30791", branchId: "b1", petpoojaItemId: "30791",
    inStock: false, isAvailable: false, available: false,
    disabledUntil: { toMillis: () => Date.now() - 1000 },
  };
});

describe("r2 P2 — versioned stock sends", () => {
  it("a manual sell-out between the restore and the POST stops the stale send", async () => {
    state.afterRestore = () => {
      Object.assign(savedDocs["products/prod_b1_30791"], {inStock:false,isAvailable:false,available:false});
    };

    const res = await restoreDueSoldOutItems();

    expect(res.restoredCount).toBe(1);
    expect(state.posts).toBe(0);
  });

  it("the restore bumps a stock version and overlapping sends for that version are deduped", async () => {
    state.duringPost = async () => {
      const version = Number(savedDocs["products/prod_b1_30791"].stockVersion);
      expect(version).toBeGreaterThan(0);
      expect(await pushItemStockToPetpooja("b1", "30791", true, undefined, version, 'send_B')).toBe(false);
    };
    expect((await restoreDueSoldOutItems()).posSynced).toBe(1);
    expect(state.posts).toBe(1);
  });

  it('repairs the POS if the stale restore POST lands after a newer manual sell-out POST', async () => {
    const row = savedDocs['products/prod_b1_30791'];
    state.duringPost = async () => {
      Object.assign(savedDocs['products/prod_b1_30791'], { inStock:false, isAvailable:false, available:false });
      expect(await pushItemStockToPetpooja('b1','30791',false)).toBe(true);
    };
    await restoreDueSoldOutItems();
    expect(state.bodies.map(b => b.inStock)).toEqual([true,false,false]);
    expect(state.remote).toBe(false);
    expect(savedDocs['products/prod_b1_30791'].inStock).toBe(false);
  });
});
