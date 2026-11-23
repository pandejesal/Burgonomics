import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";

/**
 * r3 P2 through the REAL outbound handler: a re-86 landing during the claim
 * must abort the send, and the ACK must be fenced by claim token + version
 * (not by updateTime, which the claim write itself changes).
 */
const h = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  const meta: Record<string, { v: number }> = {};
  const state = { re86DuringClaim: false, failFetch: false, faultConfig: false, posts: 0, bodies: [] as any[], txCalls: 0 };
  const ts = (v: number) => ({ v, isEqual: (o: any) => o?.v === v });
  const docRef = (col: string, id: string): any => {
    const path = `${col}/${id}`;
    return {
      id,
      get: vi.fn(async () => ({
        id, exists: savedDocs[path] !== undefined, data: () => (savedDocs[path] ? { ...savedDocs[path] } : undefined),
        updateTime: meta[path] ? ts(meta[path].v) : undefined, ref: docRef(col, id),
      })),
      set: vi.fn(async (data: any, opts?: any) => {
        savedDocs[path] = opts?.merge && savedDocs[path] ? { ...savedDocs[path], ...data } : { ...data };
        meta[path] = { v: (meta[path]?.v || 0) + 1 };
      }),
      update: vi.fn(async (data: any) => {
        savedDocs[path] = { ...savedDocs[path], ...data };
        meta[path] = { v: (meta[path]?.v || 0) + 1 };
      }),
    };
  };
  const mockDb: any = {
    collection: (col: string) => ({ doc: (id: string) => docRef(col, id), where: () => ({ limit: () => ({ get: async () => ({ docs: [], empty: true }) }) }) }),
    runTransaction: async (fn: any) => {
      state.txCalls++;
      const tx = {
        get: (r: any) => r.get(),
        set: (r: any, d: any, o?: any) => r.set(d, o),
        update: (r: any, d: any) => r.update(d),
      };
      if (state.re86DuringClaim && state.txCalls === 1) {
        // A staff re-86 lands during the claim transaction, BEFORE its read.
        savedDocs["products/prod_b1_30791"] = { ...savedDocs["products/prod_b1_30791"], inStock: false, isAvailable: false, available: false, stockVersion: 99 };
        meta["products/prod_b1_30791"] = { v: 99 };
      }
      return fn(tx);
    },
  };
  return { savedDocs, meta, state, mockDb };
});
const { savedDocs, meta, state, mockDb } = h;

vi.mock("firebase-admin", () => {
  const FieldValue = { serverTimestamp: () => "TS", increment: (n: number) => n + 1, arrayUnion: (i: any) => [i], delete: () => "DEL" };
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
  return { ...actual, isPetpoojaEnabled: () => true, getPetpoojaConfig: () => {
    if (h.state.faultConfig) throw new Error("config unavailable");
    return { stockUrl: "https://pos.invalid/stock", appKey: "k", appSecret: "s", accessToken: "t" };
  } };
});
vi.mock("../src/core/errors", async (importOriginal) => {
  const actual: any = await importOriginal();
  return { ...actual, captureErrorSnapshot: vi.fn(async () => "err") };
});

import { pushItemStockToPetpooja } from "../src/modules/petpooja/item86ingSync";

const originalFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = vi.fn(async (_u: any, init: any) => {
    if (state.failFetch) { state.failFetch = false; throw new Error("vendor timeout after claim"); }
    state.posts++;
    state.bodies.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ success: "1" }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as any;
});
afterAll(() => { globalThis.fetch = originalFetch; });

beforeEach(() => {
  for (const k of Object.keys(savedDocs)) delete savedDocs[k];
  for (const k of Object.keys(meta)) delete meta[k];
  state.posts = 0; state.bodies = []; state.re86DuringClaim = false; state.txCalls = 0;
  state.failFetch = false; state.faultConfig = false;
  savedDocs["branches/b1"] = { id: "b1", petpoojaStoreId: "r1" };
  savedDocs["products/prod_b1_30791"] = {
    id: "prod_b1_30791", branchId: "b1", petpoojaItemId: "30791",
    inStock: true, isAvailable: true, available: true, stockVersion: 1,
  };
  meta["products/prod_b1_30791"] = { v: 1 };
});

describe("r3 P2 — real stock handler", () => {
  it("sends once with an uncontested claim even though the claim moves updateTime", async () => {
    const ok = await pushItemStockToPetpooja("b1", "30791", true, undefined, 1, "send_1");
    expect(ok).toBe(true);
    expect(state.posts).toBe(1);
    expect(savedDocs["products/prod_b1_30791"].inStock).toBe(true);
    expect(savedDocs["products/prod_b1_30791"].stockPushClaim).toBeNull();
  });

  it("a vendor timeout after the claim releases the lease; a later push succeeds", async () => {
    state.failFetch = true;
    expect(await pushItemStockToPetpooja("b1", "30791", true, undefined, 1, "send_fail")).toBe(false);
    expect(savedDocs["products/prod_b1_30791"].stockPushClaim).toBeNull();

    expect(await pushItemStockToPetpooja("b1", "30791", true, undefined, 1, "send_retry")).toBe(true);
    expect(state.posts).toBe(1);
    expect(savedDocs["products/prod_b1_30791"].stockPushClaim).toBeNull();
  });

  it("a config fault after the claim releases the lease", async () => {
    state.faultConfig = true;
    expect(await pushItemStockToPetpooja("b1", "30791", true, undefined, 1, "send_cfg")).toBe(false);
    expect(savedDocs["products/prod_b1_30791"].stockPushClaim).toBeNull();
  });

  it("a re-86 during the claim aborts the stale send", async () => {
    state.re86DuringClaim = true;
    const ok = await pushItemStockToPetpooja("b1", "30791", true, undefined, 1, "send_2");
    expect(ok).toBe(false);
    expect(state.posts).toBe(0);
    expect(savedDocs["products/prod_b1_30791"].inStock).toBe(false);
  });
});
