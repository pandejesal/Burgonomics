import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * P2 — stale sold-out timers must not starve the rows behind them.
 *
 * The old scan re-read the same first 40 due timestamps every tick. A row that
 * was already available again but still carried `disabledUntil` was SKIPPED and
 * left its timer, so it blocked every later due row forever. The fix clears
 * stale timers transactionally (without restoring delisted products) and binds
 * the outbound POS stock update to the CURRENT availability, not the stale scan.
 */
const h = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  const posPushes: Array<{ branchId: string; itemId: string; inStock: boolean }> = [];

  function msOf(value: any): number {
    if (typeof value === "number") return value;
    if (value && typeof value.toMillis === "function") return Number(value.toMillis());
    if (value && typeof value.seconds === "number") return Number(value.seconds) * 1000;
    return 0;
  }

  const makeRef = (path: string, id: string): any => ({
    id,
    get: vi.fn(async () => ({
      id,
      exists: savedDocs[path] !== undefined,
      data: () => savedDocs[path],
      ref: makeRef(path, id),
    })),
    set: vi.fn(async (data: any, opts?: any) => {
      savedDocs[path] = opts?.merge ? { ...(savedDocs[path] || {}), ...data } : { ...data };
    }),
  });

  const mockDb: any = {
    collection: (col: string) => ({
      doc: (id: string) => makeRef(`${col}/${id}`, id),
      where: (field: string, op: string, value: any) => ({
        limit: (n: number) => ({
          get: async () => {
            const docs = Object.keys(savedDocs)
              .filter((k) => k.startsWith(`${col}/`))
              .filter((k) => {
                const actual = savedDocs[k]?.[field];
                if (op === "==") return actual === value;
                if (op === "<=") {
                  const a = msOf(actual);
                  return a > 0 && a <= msOf(value);
                }
                return false;
              })
              .slice(0, n)
              .map((k) => {
                const id = k.slice(col.length + 1);
                return { id, exists: true, data: () => savedDocs[k], ref: makeRef(k, id) };
              });
            return { empty: docs.length === 0, docs };
          },
        }),
      }),
    }),
    runTransaction: async (fn: any) =>
      fn({
        get: (ref: any) => ref.get(),
        set: (ref: any, data: any, opts?: any) => ref.set(data, opts),
        update: (ref: any, data: any) => ref.update(data),
      }),
  };
  return { savedDocs, posPushes, mockDb };
});
const { savedDocs, posPushes, mockDb } = h;

vi.mock("firebase-admin", () => {
  const FieldValue = {
    serverTimestamp: () => "MOCK_TS",
    increment: (n: number) => n,
    arrayUnion: (i: any) => [i],
    delete: () => "MOCK_DELETE",
  };
  const firestoreFn: any = vi.fn(() => h.mockDb);
  firestoreFn.FieldValue = FieldValue;
  firestoreFn.Timestamp = { fromMillis: (ms: number) => ms };
  return {
    default: { firestore: firestoreFn, auth: vi.fn(), messaging: vi.fn(), initializeApp: vi.fn(), apps: [{ name: "mock" }] },
    firestore: firestoreFn,
    auth: vi.fn(),
    messaging: vi.fn(),
    initializeApp: vi.fn(),
    apps: [{ name: "mock" }],
  };
});
vi.mock("../src/modules/petpooja/client", async (importOriginal) => {
  const actual: any = await importOriginal();
  return { ...actual, isPetpoojaEnabled: () => true };
});
vi.mock("../src/modules/petpooja/item86ingSync", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    pushItemStockToPetpooja: vi.fn(async (branchId: string, itemId: string, inStock: boolean) => {
      posPushes.push({ branchId, itemId, inStock });
      return true;
    }),
  };
});
vi.mock("../src/core/errors", async (importOriginal) => {
  const actual: any = await importOriginal();
  return { ...actual, captureErrorSnapshot: vi.fn(async () => "err") };
});

import {
  restoreDueSoldOutItems,
  availabilityForPosPush,
} from "../src/modules/menu/soldOutTimer.scheduler";

const due = () => Date.now() - 60_000;

function seedProduct(id: string, extra: Record<string, any> = {}) {
  savedDocs[`products/${id}`] = {
    id,
    branchId: "b1",
    petpoojaItemId: id,
    inStock: false,
    isAvailable: false,
    available: false,
    disabledUntil: { toMillis: () => due() },
    ...extra,
  };
}

/** A row that is available again but still carries a due timer (the stale case). */
function seedStale(id: string) {
  seedProduct(id, { inStock: true, isAvailable: true, available: true, autoRestoredAt: "earlier" });
}

beforeEach(() => {
  for (const k of Object.keys(savedDocs)) delete savedDocs[k];
  posPushes.length = 0;
  savedDocs["branches/b1"] = { id: "b1", petpoojaStoreId: "r1" };
});

describe("P2 — sold-out timer starvation", () => {
  it("a due item behind a full page of stale timers is restored (and stale timers are cleared)", async () => {
    // Fill the first page with 40 stale rows that all block the scan.
    for (let i = 0; i < 40; i++) seedStale(`stale_${i}`);
    seedProduct("victim");

    // The first tick clears the stale timers; a following tick reaches the victim.
    const first = await restoreDueSoldOutItems();
    expect(first.restoredCount).toBe(0);
    for (let i = 0; i < 40; i++) {
      expect(savedDocs[`products/stale_${i}`].disabledUntil).toBeNull();
    }

    const second = await restoreDueSoldOutItems();
    expect(second.restoredCount).toBe(1);
    expect(savedDocs["products/victim"]).toMatchObject({
      inStock: true,
      isAvailable: true,
      available: true,
      disabledUntil: null,
    });
    expect(posPushes.some((p) => p.itemId === "victim" && p.inStock === true)).toBe(true);
  });

  it("clears a stale timer WITHOUT restoring availability, and without a POS push", async () => {
    seedStale("stale_1");

    await restoreDueSoldOutItems();

    expect(savedDocs["products/stale_1"].disabledUntil).toBeNull();
    expect(savedDocs["products/stale_1"].inStock).toBe(true);
    expect(posPushes).toHaveLength(0);
  });

  it("does not restore a delisted product — it only clears its timer", async () => {
    seedProduct("delisted_1", { delistedFromPos: true, ghostRetired: true });

    const result = await restoreDueSoldOutItems();

    expect(result.restoredCount).toBe(0);
    expect(savedDocs["products/delisted_1"].disabledUntil).toBeNull();
    expect(savedDocs["products/delisted_1"].inStock).toBe(false);
    expect(savedDocs["products/delisted_1"].isAvailable).toBe(false);
    expect(posPushes).toHaveLength(0);
  });

  it("binds the outbound stock update to CURRENT availability, not a hardcoded 'true'", () => {
    // The value sent to the POS is derived from the fresh product state at push
    // time. A product that is sold out, delisted or unavailable must never be
    // pushed as in-stock, even if a stale scan snapshot said otherwise.
    expect(availabilityForPosPush({ inStock: true, isAvailable: true, available: true })).toBe(true);
    expect(availabilityForPosPush({ inStock: false, isAvailable: true, available: true })).toBe(false);
    expect(availabilityForPosPush({ inStock: true, isAvailable: true, available: true, delistedFromPos: true })).toBe(false);
  });
});
