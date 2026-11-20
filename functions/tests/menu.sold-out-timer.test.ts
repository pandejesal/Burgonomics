import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * SOLD-OUT TIMER â€” "unavailable until 14:30" must actually come back at 14:30.
 *
 * The defect (checked 2026-11-20): the Partner app persists
 * `products/{id}.disabledUntil` when staff 86 an item "for 2 hours" / "rest of
 * day" (useBranchMenu.ts:154-196) and even shows the deadline back to them, but
 * `git grep disabledUntil functions/src` was EMPTY â€” no trigger, no scheduler,
 * no reader. An item 86'd with a timer stayed 86'd until a human remembered.
 *
 * Pinned here, against the REAL scheduler (only Firestore and the POS push are
 * faked):
 *   - a due timer restores the item (all three availability flags, timer
 *     cleared, audit stamp) and pushes the restored stock to the POS once;
 *   - a timer that has NOT arrived is untouched â€” no write, no POS call;
 *   - a second tick writes nothing and calls the POS zero times (idempotent);
 *   - a staff re-86 that lands between the scan and the write WINS (the
 *     transaction re-proves the deadline on the fresh document);
 *   - a POS-originated 86 clears the timer, so this worker can never resurrect
 *     an item the POS itself took off sale.
 */

const h = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  const posPushes: Array<{ branchId: string; itemId: string; inStock: boolean }> = [];
  const state: { posPushResult: boolean; posPushThrows: boolean; afterScan?: () => void } = {
    posPushResult: true,
    posPushThrows: false,
  };
  const snapshots: Array<Record<string, any>> = [];

  function msOf(value: any): number {
    if (typeof value === "number") return value;
    if (value && typeof value.toMillis === "function") return Number(value.toMillis());
    if (value && typeof value.seconds === "number") return Number(value.seconds) * 1000;
    return 0;
  }

  // Built INSIDE vi.hoisted: the firebase-admin factory below is hoisted to the
  // top of the file, so it cannot close over a later top-level const.
  const makeRef = (path: string, id: string): any => ({
    id,
    __path: path,
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
            // A test hook that lets a staff re-86 land AFTER the scan and BEFORE
            // the transactional re-check.
            if (state.afterScan) state.afterScan();
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

  return { savedDocs, posPushes, state, snapshots, mockDb };
});

const { savedDocs, posPushes, state, snapshots, mockDb } = h;

vi.mock("firebase-admin", () => {
  const FieldValue = {
    serverTimestamp: () => "MOCK_TIMESTAMP",
    increment: (n: number) => n,
    arrayUnion: (i: any) => [i],
    delete: () => "MOCK_DELETE",
  };
  const firestoreFn: any = vi.fn(() => h.mockDb);
  firestoreFn.FieldValue = FieldValue;
  firestoreFn.Timestamp = { fromMillis: (ms: number) => ms };
  return {
    default: { firestore: firestoreFn, auth: vi.fn(() => ({})), messaging: vi.fn(() => ({})), initializeApp: vi.fn(), apps: [{ name: "mock" }] },
    firestore: firestoreFn,
    auth: vi.fn(() => ({})),
    messaging: vi.fn(() => ({})),
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
      if (state.posPushThrows) throw new Error("stock push exploded");
      return state.posPushResult;
    }),
  };
});

vi.mock("../src/core/errors", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    captureErrorSnapshot: vi.fn(async (s: any) => {
      snapshots.push(s);
      return "err_test";
    }),
  };
});

import {
  restoreDueSoldOutItems,
  isDueSoldOutTimer,
  soldOutUntilMsOf,
} from "../src/modules/menu/soldOutTimer.scheduler";
import { handlePetpoojaStockWebhook } from "../src/modules/petpooja/item86ingSync";

const productOf = (id: string) => savedDocs[`products/${id}`];

beforeEach(() => {
  for (const k of Object.keys(savedDocs)) delete savedDocs[k];
  posPushes.length = 0;
  snapshots.length = 0;
  state.posPushResult = true;
  state.posPushThrows = false;
  state.afterScan = undefined;
  savedDocs["branches/b1"] = { id: "b1", petpoojaStoreId: "31z58ciw0h" };
});

function seedSoldOut(id: string, disabledUntilMs: number, extra: Record<string, any> = {}) {
  savedDocs[`products/${id}`] = {
    id,
    branchId: "b1",
    name: "Tandoori Dahi Kebab",
    petpoojaItemId: "30791",
    price: 350,
    inStock: false,
    isAvailable: false,
    available: false,
    disabledUntil: { toMillis: () => disabledUntilMs },
    eightSixDuration: "2_hours",
    eightSixReason: "out of stock",
    ...extra,
  };
}

describe("sold-out timer", () => {
  it("restores an item whose timer has arrived, and pushes the stock to the POS once", async () => {
    const due = Date.now() - 60_000;
    seedSoldOut("prod_b1_30791", due);

    const result = await restoreDueSoldOutItems();

    expect(result.restoredCount).toBe(1);
    expect(productOf("prod_b1_30791")).toMatchObject({
      inStock: true,
      isAvailable: true,
      available: true,
      disabledUntil: null,
      eightSixDuration: null,
      eightSixReason: null,
      lastAutoRestorePosSync: "synced",
    });
    expect(posPushes).toEqual([{ branchId: "b1", itemId: "30791", inStock: true }]);
  });

  it("leaves a timer that has not arrived alone â€” no write, no POS call", async () => {
    const future = Date.now() + 90 * 60 * 1000;
    seedSoldOut("prod_b1_30791", future);

    const result = await restoreDueSoldOutItems();

    expect(result.restoredCount).toBe(0);
    expect(productOf("prod_b1_30791").inStock).toBe(false);
    expect(productOf("prod_b1_30791").disabledUntil).toBeTruthy();
    expect(posPushes).toHaveLength(0);
  });

  it("is idempotent: a second tick after the restore writes nothing and calls no vendor", async () => {
    seedSoldOut("prod_b1_30791", Date.now() - 1_000);

    expect((await restoreDueSoldOutItems()).restoredCount).toBe(1);
    expect(posPushes).toHaveLength(1);

    const second = await restoreDueSoldOutItems();
    expect(second.restoredCount).toBe(0);
    expect(posPushes).toHaveLength(1);
  });

  it("a staff re-86 between the scan and the write wins", async () => {
    seedSoldOut("prod_b1_30791", Date.now() - 1_000);
    // The kitchen re-86s the item while this tick is running: a NEW deadline.
    state.afterScan = () => {
      productOf("prod_b1_30791").disabledUntil = {
        toMillis: () => Date.now() + 2 * 60 * 60 * 1000,
      };
      productOf("prod_b1_30791").eightSixReason = "still out";
    };

    const result = await restoreDueSoldOutItems();

    expect(result.restoredCount).toBe(0);
    expect(productOf("prod_b1_30791").inStock).toBe(false);
    expect(productOf("prod_b1_30791").eightSixReason).toBe("still out");
    expect(posPushes).toHaveLength(0);
  });

  it("records an honest POS failure without failing the restore", async () => {
    seedSoldOut("prod_b1_30791", Date.now() - 1_000);
    state.posPushResult = false;

    const result = await restoreDueSoldOutItems();

    expect(result.restoredCount).toBe(1);
    expect(result.posFailed).toBe(1);
    expect(productOf("prod_b1_30791").inStock).toBe(true);
    expect(productOf("prod_b1_30791").lastAutoRestorePosSync).toBe("failed");
    expect(snapshots.some((s) => /POS may still show it sold out/i.test(String(s.message)))).toBe(
      true
    );
  });

  it("a POS-originated 86 clears the timer, so the worker can never resurrect it", async () => {
    seedSoldOut("prod_b1_30791", Date.now() + 60 * 60 * 1000);

    const res = await handlePetpoojaStockWebhook(
      { restID: "31z58ciw0h", itemID: "30791", inStock: "0" },
      { authenticated: true }
    );
    expect(res.outcome).toBe("applied");

    // The POS owns the item now: no deadline is left for this worker to act on.
    expect(productOf("prod_b1_30791").inStock).toBe(false);
    expect(soldOutUntilMsOf(productOf("prod_b1_30791"))).toBe(0);
    expect(isDueSoldOutTimer(productOf("prod_b1_30791"), Date.now() + 2 * 60 * 60 * 1000)).toBe(
      false
    );
  });
});
