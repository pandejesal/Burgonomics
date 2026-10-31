import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * STRESS-TEST REPAIR RED/GREEN — bumpOrderStatus authorization freshness
 * (stress sweep 2026-10-24, order-state finding S2).
 *
 * The branch authorization (`assertOrderBranchAccess`) runs against the
 * STALE pre-read; the transaction that commits the bump re-reads the doc but
 * never re-checks authorization. An order re-linked to another branch (or a
 * revoked claim) between the pre-read and the commit lets a stale-branch
 * staff member write onto an order they no longer own. Conversely,
 * `manualBranchDispatch` (porter.service.ts:1782) already authorizes against
 * the FRESH transactional snapshot — the two staff flows must agree.
 *
 * HONESTY LIMIT: in-process doc store; authorization shim via the real
 * middleware path (same as orderBump.test.ts); no network, no secret.
 */
const { mockDb, savedDocs, control } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  // Fired ONLY on transactional reads (not plain pre-reads) so the defect
  // interleaving (re-link lands between pre-read and transaction) is modeled
  // without masking the current behavior.
  const txGetHooks: Array<(path: string, data: any) => any> = [];
  const makeRef = (colName: string, docId: string) => ({
    id: docId,
    __path: `${colName}/${docId}`,
    get: vi.fn(async () => ({
      exists: !!savedDocs[`${colName}/${docId}`],
      data: () => savedDocs[`${colName}/${docId}`] || {},
    })),
    set: vi.fn(async (data: any, opts?: any) => {
      const p = `${colName}/${docId}`;
      savedDocs[p] = opts?.merge && savedDocs[p] ? { ...savedDocs[p], ...data } : data;
    }),
    update: vi.fn(async (data: any) => {
      const p = `${colName}/${docId}`;
      if (!savedDocs[p]) throw new Error(`No document to update: ${p}`);
      savedDocs[p] = { ...savedDocs[p], ...data };
    }),
  });
  const mockDb: any = {
    collection: (colName: string) => ({
      doc: (docId: string) => makeRef(colName, docId),
    }),
    runTransaction: async (fn: (tx: any) => Promise<any>) =>
      fn({
        get: async (ref: any) => {
          let data = savedDocs[ref.__path] || {};
          for (const hook of txGetHooks) {
            if (hook) data = hook(ref.__path, data);
          }
          return { exists: ref.__path in savedDocs, data: () => data };
        },
        update: async (ref: any, data: any) => {
          if (!savedDocs[ref.__path]) throw new Error(`No document to update: ${ref.__path}`);
          savedDocs[ref.__path] = { ...savedDocs[ref.__path], ...data };
        },
      }),
  };
  return {
    mockDb,
    savedDocs,
    control: {
      onTxGet: (hook: (path: string, data: any) => any) => {
        txGetHooks.push(hook);
      },
      reset: () => {
        for (const k of Object.keys(savedDocs)) delete savedDocs[k];
        txGetHooks.length = 0;
      },
    },
  };
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

import { bumpOrderStatus } from "../src/modules/orders/orderStatus";
import { config } from "../src/config/env";

describe("bumpOrderStatus transactional re-authorization (stress sweep)", () => {
  const ownBranchCaller = { uid: "staff_1", role: "branch_staff", branchIds: ["b1"] };

  beforeEach(() => {
    control.reset();
    savedDocs["orders/ord_1"] = { branchId: "b1", status: { code: "PLACED", terminal: false } };
  });

  it("re-authorizes against the TRANSACTIONAL snapshot, not the stale pre-read", async () => {
    // Mid-flight re-link: between the bump's pre-read (b1) and the commit,
    // the order moves to branch b2 — the staff member's claim no longer holds.
    control.onTxGet((path, data) => {
      if (path === "orders/ord_1") {
        return { ...(data || {}), branchId: "b2" };
      }
      return data;
    });

    await expect(
      bumpOrderStatus({ orderId: "ord_1", status: "preparing", caller: ownBranchCaller })
    ).rejects.toThrow(/^Forbidden/);
    // Nothing was written by the foreign branch.
    expect(savedDocs["orders/ord_1"].status).toMatchObject({ code: "PLACED" });
  });

  it("still bumps normally when authorization has nothing to re-check (no caller drift)", async () => {
    const res: any = await bumpOrderStatus({ orderId: "ord_1", status: "preparing", caller: ownBranchCaller });
    expect(res.status).toMatchObject({ code: "PREPARING" });
    expect(savedDocs["orders/ord_1"].status).toMatchObject({ code: "PREPARING" });
  });
});
