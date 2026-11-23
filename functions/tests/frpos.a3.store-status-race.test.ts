import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * A3 — a POS "open" that resolved BEFORE a staff close must not undo it, and
 * checkout must refuse the inconsistent state (isOpen:true + override:true).
 */
const h = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  const writeLog: string[] = [];
  const state: { onTransaction: null | (() => void); txCount: number } = {
    onTransaction: null,
    txCount: 0,
  };

  const docRef = (col: string, id: string): any => {
    const path = `${col}/${id}`;
    return {
      id,
      path,
      get: vi.fn(async () => ({
        id,
        exists: savedDocs[path] !== undefined,
        data: () => (savedDocs[path] ? JSON.parse(JSON.stringify(savedDocs[path])) : undefined),
        ref: docRef(col, id),
      })),
      set: vi.fn(async (data: any, opts?: any) => {
        writeLog.push(`set ${path}`);
        savedDocs[path] = opts?.merge && savedDocs[path] ? { ...savedDocs[path], ...data } : { ...data };
      }),
    };
  };

  const mockDb: any = {
    collection: (col: string) => ({
      doc: (id: string) => docRef(col, id),
      where: (field: string, _op: string, val: any) => ({
        limit: () => ({
          get: async () => ({
            docs: Object.keys(savedDocs)
              .filter((k) => k.startsWith(`${col}/`))
              .filter((k) => savedDocs[k]?.[field] === val)
              .map((k) => {
                const id = k.slice(col.length + 1);
                return { id, exists: true, data: () => ({ ...savedDocs[k] }), ref: docRef(col, id) };
              }),
            empty: false,
          }),
        }),
      }),
    }),
    runTransaction: vi.fn(async (fn: any) => {
      state.txCount++;
      if (state.onTransaction) {
        const hook = state.onTransaction;
        state.onTransaction = null;
        hook();
      }
      return fn({
        get: (ref: any) => ref.get(),
        set: (ref: any, data: any, opts?: any) => ref.set(data, opts),
      });
    }),
  };
  return { savedDocs, writeLog, state, mockDb };
});
const { savedDocs, writeLog, state, mockDb } = h;

vi.mock("firebase-admin", () => {
  const FieldValue = { serverTimestamp: () => "MOCK_TS", increment: (n: number) => n, arrayUnion: (i: any) => [i], delete: () => "MOCK_DELETE" };
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
vi.mock("../src/config/env", async (importOriginal) => {
  const actual: any = await importOriginal();
  return { ...actual, config: { ...actual.config, mock: { ...actual.config.mock, petpoojaPos: false } } };
});
vi.mock("../src/core/errors", async (importOriginal) => {
  const actual: any = await importOriginal();
  return { ...actual, captureErrorSnapshot: vi.fn(async () => "err") };
});

import { handlePetpoojaStoreStatus } from "../src/modules/petpooja/item86ingSync";
import { setStaffStoreStatus } from "../src/modules/stores/storeStatus";
import { readOutletOpenState, isStorefrontOpen } from "../src/modules/payments/outletStatus";

const REST = "res_ahm_01";
const BRANCH = "branch_ahmedabad_1";
const STORE = "store_ahm_01";
const brandCaller: any = { uid: "brand_1", isBrandAdmin: true, branchIds: [BRANCH], active: true };

function seed() {
  savedDocs[`branches/${BRANCH}`] = {
    id: BRANCH,
    petpoojaStoreId: REST,
    active: true,
    acceptingOrdersStatus: "open",
  };
  savedDocs[`stores/${STORE}`] = {
    id: STORE,
    partnerBranchId: BRANCH,
    petpoojaRestId: REST,
    isOpen: true,
  };
}

beforeEach(() => {
  for (const k of Object.keys(savedDocs)) delete savedDocs[k];
  writeLog.length = 0;
  state.txCount = 0;
  state.onTransaction = null;
  seed();
});

describe("A3 — POS open cannot outrun a staff close", () => {
  it("re-checks the override inside the transaction: a late POS open is refused", async () => {
    // Simulate a verified POS open that resolved BEFORE the staff close landed.
    // The staff close commits just as the POS gate transaction is about to run.
    state.onTransaction = () => {
      savedDocs[`stores/${STORE}`] = {
        ...savedDocs[`stores/${STORE}`],
        isOpen: false,
        storeStatusOverride: true,
      };
      savedDocs[`branches/${BRANCH}`] = {
        ...savedDocs[`branches/${BRANCH}`],
        acceptingOrdersStatus: "closed",
        storeStatusOverride: true,
      };
    };

    const reply = await handlePetpoojaStoreStatus(
      { restID: REST, store_status: 1 },
      { authenticated: true }
    );

    expect(reply!.body.status).toBe("failed");
    expect(savedDocs[`stores/${STORE}`].isOpen).toBe(false);
    expect(savedDocs[`stores/${STORE}`].storeStatusOverride).toBe(true);
  });

  it("writes the staff close gate + override in ONE transaction", async () => {
    await setStaffStoreStatus({ branchId: BRANCH, status: "closed", caller: brandCaller });

    expect(state.txCount).toBe(1);
    expect(savedDocs[`stores/${STORE}`]).toMatchObject({
      isOpen: false,
      storeStatusOverride: true,
    });
    expect(savedDocs[`branches/${BRANCH}`]).toMatchObject({
      acceptingOrdersStatus: "closed",
      storeStatusOverride: true,
    });
    expect(writeLog.filter((w) => w.includes(`stores/${STORE}`)).length).toBe(1);
    expect(writeLog.filter((w) => w.includes(`branches/${BRANCH}`)).length).toBe(1);
  });

  it("checkout refuses the inconsistent isOpen:true + close-override state", async () => {
    // The raced-then-late-open state: gate reads open, override is still set.
    savedDocs[`stores/${STORE}`].storeStatusOverride = true;
    expect(savedDocs[`stores/${STORE}`].isOpen).toBe(true);

    expect(await readOutletOpenState({ storeId: STORE })).toBe(false);
    expect(isStorefrontOpen({ isOpen: true, storeStatusOverride: true })).toBe(false);
  });
});
