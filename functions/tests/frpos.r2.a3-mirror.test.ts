import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * r2 A3 — the Partner directory mirror is a write to the same gate state. A
 * delayed/concurrent update to `admin_stores` must not be clobbered by a stale
 * open/close; the mirror write must be inside the gate transaction (or version
 * checked).
 */
const h = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  const state = { afterTransaction: null as null | (() => Promise<void>), version: 1, closing: false };
  const docRef = (col: string, id: string): any => {
    const path = `${col}/${id}`;
    return {
      id, path,
      get: vi.fn(async () => ({ id, exists: savedDocs[path] !== undefined, data: () => (savedDocs[path] ? { ...savedDocs[path] } : undefined), updateTime: { v: state.version, isEqual: (o: any) => o?.v === state.version }, ref: docRef(col, id) })),
      set: vi.fn(async (data: any, opts?: any) => {
        savedDocs[path] = opts?.merge && savedDocs[path] ? { ...savedDocs[path], ...data } : { ...data };
      }),
      update: vi.fn(async (data: any, precondition?: any) => {
        if (precondition?.lastUpdateTime && precondition.lastUpdateTime.v !== state.version) {
          throw new Error("FAILED_PRECONDITION");
        }
        savedDocs[path] = { ...savedDocs[path], ...data };
      }),
    };
  };
  const mockDb: any = {
    collection: (col: string) => ({
      doc: (id: string) => docRef(col, id),
      where: (field: string, _op: string, val: any) => ({
        limit: () => ({
          get: async () => {
            const docs = Object.keys(savedDocs)
              .filter((k) => k.startsWith(`${col}/`) && savedDocs[k]?.[field] === val)
              .map((k) => {
                const id = k.slice(col.length + 1);
                return { id, exists: true, data: () => ({ ...savedDocs[k] }), ref: docRef(col, id) };
              });
            return { docs, empty: docs.length === 0 };
          },
        }),
      }),
    }),
    runTransaction: async (fn: any) => {
      const result = await fn({ get: (r: any) => r.get(), set: (r: any, d: any, o?: any) => r.set(d, o), update: (r: any, d: any, p?: any) => r.update(d, p) });
      if (state.afterTransaction && !state.closing) {
        const hook = state.afterTransaction;
        state.afterTransaction = null;
        await hook();
      }
      return result;
    },
  };
  return { savedDocs, state, mockDb };
});
const { savedDocs, state, mockDb } = h;

vi.mock("firebase-admin", () => {
  const FieldValue = { serverTimestamp: () => "MOCK_TS", increment: (n: number) => n, arrayUnion: (i: any) => [i], delete: () => "MOCK_DELETE" };
  const firestoreFn: any = vi.fn(() => h.mockDb);
  firestoreFn.FieldValue = FieldValue;
  firestoreFn.Timestamp = { fromMillis: (ms: number) => ms };
  return {
    default: { firestore: firestoreFn, auth: vi.fn(), messaging: vi.fn(), initializeApp: vi.fn(), apps: [{ name: "mock" }] },
    firestore: firestoreFn, auth: vi.fn(), messaging: vi.fn(), initializeApp: vi.fn(), apps: [{ name: "mock" }],
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

const REST = "res_ahm_01";
const BRANCH = "branch_1";
const STORE = "store_1";
const brandCaller: any = { uid: "brand", isBrandAdmin: true, branchIds: [BRANCH], active: true };

function seed() {
  savedDocs[`branches/${BRANCH}`] = { id: BRANCH, petpoojaStoreId: REST, active: true, acceptingOrdersStatus: "open" };
  savedDocs[`stores/${STORE}`] = { id: STORE, partnerBranchId: BRANCH, petpoojaRestId: REST, isOpen: true };
  savedDocs[`admin_stores/${STORE}`] = { id: STORE, partnerBranchId: BRANCH, petpoojaRestId: REST, isOpen: true };
}

beforeEach(() => {
  for (const k of Object.keys(savedDocs)) delete savedDocs[k];
  state.afterTransaction = null; state.version = 1; state.closing = false;
  seed();
});

/**
 * A newer close lands AFTER our open's gate transaction but BEFORE the delayed
 * mirror write. The stale mirror must not reopen what the newer close shut.
 */
async function newerCloseDuringDelay() {
  // Drive the concurrent close through the REAL staff-close handler instead
  // of hand-editing the mirror document.
  state.closing = true;
  await setStaffStoreStatus({ branchId: BRANCH, status: "closed", caller: brandCaller });
  state.closing = false;
}

describe("r2 A3 — delayed Partner mirror writes", () => {
  it("staff open does not clobber a newer close with a delayed mirror write", async () => {
    state.afterTransaction = newerCloseDuringDelay;
    await setStaffStoreStatus({ branchId: BRANCH, status: "open", caller: brandCaller });
    expect(savedDocs[`admin_stores/${STORE}`].storeStatusSource).toBe("manual");
    expect(savedDocs[`admin_stores/${STORE}`].isOpen).toBe(false);
  });

  it("POS open does not clobber a newer close with a delayed mirror write", async () => {
    state.afterTransaction = newerCloseDuringDelay;
    const reply = await handlePetpoojaStoreStatus(
      { restID: REST, store_status: 1 },
      { authenticated: true },
    );
    expect(reply!.body.status).toBe("success");
    expect(savedDocs[`admin_stores/${STORE}`].storeStatusSource).toBe("manual");
    expect(savedDocs[`admin_stores/${STORE}`].isOpen).toBe(false);
  });
});
