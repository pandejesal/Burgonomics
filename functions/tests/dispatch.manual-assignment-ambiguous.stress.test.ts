import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";

/**
 * STRESS-TEST REPAIR RED/GREEN — in-house rider over an AMBIGUOUS external
 * booking (stress sweep 2026-10-24, dispatch finding D — race hunter P1).
 *
 * A Borzo/Shadowfax `book()` that times out mid-POST writes
 * `dispatchStatus: "needs_reconciliation"` and RELEASES all provider ids
 * (dispatch.router.ts:802-816, buildReleasedBindingWrite) — the remote courier
 * MAY already be booked. `manualBranchDispatch`'s guards: active-binding
 * check (false: ids nulled, deliveryStatus confirmed), unresolved ids
 * (empty), pending claims (only "dispatch_pending"), Porter reconciliation
 * flag (Porter lane only) — every one passes, so the in-house rider is
 * written over a courier that may already be en route.
 *
 * Fix: treat `dispatchStatus === "needs_reconciliation"` as the same
 * reconciliation gate the Porter lane already enforces.
 *
 * Harness mirrors dispatch.manual-assignment-race.test.ts (offline, no
 * provider keys, no network).
 */

const { mockDb, savedDocs, control, nextTs } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  let tsSeq = 0;
  const control = {
    writeCalls: [] as Array<{ path: string; data: any }>,
  };
  const mergeSet = (path: string, data: any) => {
    savedDocs[path] = { ...(savedDocs[path] || {}), ...data };
  };
  const makeRef = (colName: string, docId: string) => {
    const path = `${colName}/${docId}`;
    const ref: any = {
      id: docId,
      path,
      get: async () => {
        const record = savedDocs[path];
        return { exists: Boolean(record), data: () => (record ? { ...record } : undefined), ref };
      },
      set: async (data: any) => {
        control.writeCalls.push({ path, data });
        mergeSet(path, data);
      },
    };
    return ref;
  };
  const mockDb: any = {
    collection: (colName: string) => ({
      doc: (docId: string) => makeRef(colName, docId),
      where: () => ({
        limit: () => ({ get: async () => ({ empty: true, docs: [] }) }),
      }),
    }),
    runTransaction: vi.fn(async (fn: any) =>
      fn({
        get: async (ref: any) => ref.get(),
        set: (ref: any, data: any) => {
          control.writeCalls.push({ path: ref.path, data });
          mergeSet(ref.path, data);
        },
      })
    ),
  };
  return { mockDb, savedDocs, control, nextTs: () => `MOCK_TS_${++tsSeq}` };
});

vi.mock("firebase-admin", () => {
  const FieldValue = {
    serverTimestamp: () => nextTs(),
    increment: (n: number) => n,
    arrayUnion: (item: any) => [item],
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

import { manualBranchDispatch } from "../src/modules/porter/porter.service";
import { config } from "../src/config/env";

const originalFetch = globalThis.fetch;
const fetchSpy = vi.fn(async () => {
  throw new Error("no provider network in this suite");
});
beforeAll(() => {
  globalThis.fetch = fetchSpy as any;
});
afterAll(() => {
  globalThis.fetch = originalFetch;
});

let saved: any = {};

const baseOrder = (over: Record<string, any> = {}) => ({
  branchId: "branch_ahmedabad_1",
  store: { name: "Burgonomics CG Road", phone: "+91 98250 12345" },
  branchCoordinates: { lat: 23.0131, lng: 72.5085 },
  deliveryAddress: {
    full: "102, Shivalik Highstreet, Vastrapur",
    lat: 23.0338,
    lng: 72.5262,
  },
  customerPhone: "+91 99999 88888",
  customerName: "Aarav Shah",
  status: "ready",
  ...over,
});

const seedAmbiguousOrder = (id: string) => {
  savedDocs[`orders/${id}`] = baseOrder({
    // The exact write the Borzo/Shadowfax AMBIGUOUS book leaves behind
    // (dispatch.router.ts:802-816): reconciliation park + released bindings.
    dispatchStatus: "needs_reconciliation",
    dispatchProvider: null,
    dispatchOrderId: null,
    borzoOrderId: null,
    shadowfaxOrderId: null,
    porterOrderId: null,
    deliveryStatus: "confirmed",
  });
};

const manager = { uid: "staff_manager_1", role: "branch_manager", branchIds: ["branch_ahmedabad_1"] };

describe("manualBranchDispatch refuses an ambiguous generic 3PL booking (stress sweep)", () => {
  beforeEach(() => {
    saved = {
      porter: { ...config.porter },
      borzo: { ...config.borzo },
      shadowfax: { ...config.shadowfax },
      mock: { ...config.mock },
      dispatch: { ...config.dispatch },
    };
    config.porter.enabled = false;
    config.porter.apiKey = "";
    config.borzo.enabled = true;
    config.borzo.apiKey = "";
    config.shadowfax.enabled = false;
    config.shadowfax.apiKey = "";
    config.mock.borzoDispatch = true;
    config.dispatch.requireLive = false;
    for (const key of Object.keys(savedDocs)) delete savedDocs[key];
    control.writeCalls.length = 0;
    fetchSpy.mockClear();
  });
  afterEach(() => {
    Object.assign(config.porter, saved.porter);
    Object.assign(config.borzo, saved.borzo);
    Object.assign(config.shadowfax, saved.shadowfax);
    Object.assign(config.mock, saved.mock);
    Object.assign(config.dispatch, saved.dispatch);
  });

  it("RED: refuses an in-house assignment over a Borzo/Shadowfax ambiguous booking", async () => {
    seedAmbiguousOrder("ord_amb_bz");

    await expect(
      manualBranchDispatch({
        orderId: "ord_amb_bz",
        riderName: "Ravi In-House",
        riderPhone: "+91 98765 00001",
        staffName: "Branch Manager",
        caller: manager,
      })
    ).rejects.toMatchObject({ statusCode: 409, code: "DISPATCH_RECONCILIATION_REQUIRED" });

    // No rider write over the ambiguity.
    expect(control.writeCalls).toHaveLength(0);
    const doc = savedDocs["orders/ord_amb_bz"];
    expect(doc.dispatchType).toBeUndefined();
    expect(doc.riderName).toBeUndefined();
    expect(doc.deliveryStatus).toBe("confirmed");
  });
});
