import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";

/**
 * Cross-path exclusion between an IN-HOUSE (branch terminal) rider assignment
 * and every paid dispatch path.
 *
 * The defect: `manualBranchDispatch` read the order, then unconditionally wrote
 * rider fields (check-then-act). A generic provider claim could land in that
 * window, and a claimed/queued provider booking could be layered on top of a
 * live in-house rider — two riders, one order. Conversely the generic claim and
 * the direct Porter book only looked for provider ids, so they never saw an
 * in-house owner at all.
 *
 * Fix under test:
 *   - the in-house write happens in ONE transaction that re-reads the order,
 *     re-authorizes, and refuses terminal orders, active external bindings,
 *     a live assignment for a DIFFERENT rider, and any pending claim lease
 *     (fresh → 202 retry; expired → 409, because an expired lease is not proof
 *     the remote booking never happened and this path cannot cancel it);
 *   - replaying the SAME rider writes nothing (timestamps untouched);
 *   - `claimDispatch` (generic book/rebook), `claimPorterDispatch` (direct
 *     /porter/book) and the manual paste lane all refuse an active in-house
 *     owner inside their own transaction.
 *
 * Deterministic fake: `runTransaction` runs once, synchronously, over the live
 * doc store; `control.txReadSnapshot` substitutes what the transaction read so
 * the stale-read races are reproducible without timers or real Firestore.
 * RED (pre-fix): the transaction/no-mutation/cross-path groups fail.
 */

const { mockDb, savedDocs, control, nextTs } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  let tsSeq = 0;
  const control = {
    /** When set, what the transaction actually reads (a stale/torn snapshot). */
    txReadSnapshot: null as null | Record<string, any>,
    /** When true, the transaction re-read finds NO document (deleted in-flight). */
    txDocMissing: false,
    txGetCalls: 0,
    /** Every write attempted through a doc ref or a transaction. */
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
        return {
          exists: Boolean(record),
          data: () => (record ? { ...record } : undefined),
          ref,
        };
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
        get: async (ref: any) => {
          control.txGetCalls++;
          if (control.txDocMissing) {
            return { exists: false, data: () => undefined, ref };
          }
          if (control.txReadSnapshot) {
            return {
              exists: true,
              data: () => ({ ...control.txReadSnapshot }),
              ref,
            };
          }
          return ref.get();
        },
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

import { manualBranchDispatch, bookPorterRider } from "../src/modules/porter/porter.service";
import { dispatchBook, savePorterManualBooking } from "../src/modules/dispatch/dispatch.router";
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

function seedOrder(id: string, over: Record<string, any> = {}) {
  savedDocs[`orders/${id}`] = baseOrder(over);
}

const docOf = (id: string) => savedDocs[`orders/${id}`];

const manager = {
  uid: "staff_manager_1",
  role: "branch_manager",
  branchIds: ["branch_ahmedabad_1"],
};

let saved: any = {};

beforeEach(() => {
  saved = {
    porter: { ...config.porter },
    borzo: { ...config.borzo },
    shadowfax: { ...config.shadowfax },
    mock: { ...config.mock },
    dispatch: { ...config.dispatch },
  };
  // Offline, deterministic provider config: no keys, mock-only eligibility.
  config.porter.enabled = false;
  config.porter.apiKey = "";
  config.porter.customerId = "";
  config.porter.webhookSecret = "";
  config.borzo.enabled = true;
  config.borzo.apiKey = "";
  config.borzo.customerId = "";
  config.shadowfax.enabled = false;
  config.shadowfax.apiKey = "";
  config.shadowfax.clientCode = "";
  config.shadowfax.contractVerified = false;
  config.mock.borzoDispatch = true;
  config.mock.shadowfaxDispatch = false;
  config.mock.porterDispatch = false;
  config.dispatch.requireLive = false;

  for (const key of Object.keys(savedDocs)) delete savedDocs[key];
  control.txReadSnapshot = null;
  control.txDocMissing = false;
  control.txGetCalls = 0;
  control.writeCalls.length = 0;
  mockDb.runTransaction.mockClear();
  fetchSpy.mockClear();
});

afterEach(() => {
  Object.assign(config.porter, saved.porter);
  Object.assign(config.borzo, saved.borzo);
  Object.assign(config.shadowfax, saved.shadowfax);
  Object.assign(config.mock, saved.mock);
  Object.assign(config.dispatch, saved.dispatch);
});

describe("manualBranchDispatch: transactional in-house assignment", () => {
  it("assigns the rider inside one transaction, preserving dispatched + manual_branch_terminal", async () => {
    seedOrder("ord_manual_ok");

    const result = await manualBranchDispatch({
      orderId: "ord_manual_ok",
      riderName: "  Vikram Local Rider  ",
      riderPhone: "  +91 98980 12345  ",
      staffName: "Branch Manager",
      caller: manager,
    });

    expect(result).toMatchObject({
      success: true,
      orderId: "ord_manual_ok",
      dispatchType: "manual_branch_terminal",
      deliveryStatus: "dispatched",
      riderName: "Vikram Local Rider",
      riderPhone: "+91 98980 12345",
    });
    expect(mockDb.runTransaction).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();

    const doc = docOf("ord_manual_ok");
    expect(doc.dispatchType).toBe("manual_branch_terminal");
    expect(doc.deliveryStatus).toBe("dispatched");
    expect(doc.riderName).toBe("Vikram Local Rider"); // trimmed, never raw-space
    expect(doc.riderPhone).toBe("+91 98980 12345");
    expect(doc.riderVehicleNumber).toBe("Local / In-Store");
    expect(doc.needsRebook).toBe(false);
    expect(doc.rebookTrigger).toBeNull();
    // Written through the transaction, never a bare doc set.
    expect(control.writeCalls).toHaveLength(1);
    expect(control.writeCalls[0].path).toBe("orders/ord_manual_ok");
    expect(control.txGetCalls).toBe(1);
  });

  it("replaying the same rider is idempotent: no write, dispatchedAt/updatedAt untouched", async () => {
    seedOrder("ord_manual_replay");
    const params = {
      orderId: "ord_manual_replay",
      riderName: "Vikram Local Rider",
      riderPhone: "+91 98980 12345",
      staffName: "Branch Manager",
    };

    await manualBranchDispatch(params);
    const first = docOf("ord_manual_replay");
    const stamps = { dispatchedAt: first.dispatchedAt, updatedAt: first.updatedAt };
    expect(control.writeCalls).toHaveLength(1);

    const replay = await manualBranchDispatch(params);

    expect(replay).toMatchObject({ success: true, reused: true, riderName: "Vikram Local Rider" });
    expect(control.writeCalls).toHaveLength(1); // nothing new written
    expect(docOf("ord_manual_replay").dispatchedAt).toBe(stamps.dispatchedAt);
    expect(docOf("ord_manual_replay").updatedAt).toBe(stamps.updatedAt);
  });

  it("refuses a conflicting assignment while an in-house rider owns the order", async () => {
    seedOrder("ord_manual_conflict");
    await manualBranchDispatch({
      orderId: "ord_manual_conflict",
      riderName: "Vikram Local Rider",
      riderPhone: "+91 98980 12345",
    });

    await expect(
      manualBranchDispatch({
        orderId: "ord_manual_conflict",
        riderName: "Someone Else",
        riderPhone: "+91 90000 00009",
      })
    ).rejects.toMatchObject({ statusCode: 409, code: "DISPATCH_EXISTS" });

    expect(docOf("ord_manual_conflict").riderName).toBe("Vikram Local Rider");
    expect(control.writeCalls).toHaveLength(1);
  });

  it("refuses terminal orders without mutating them", async () => {
    for (const terminal of ["delivered", "cancelled"]) {
      const id = `ord_manual_terminal_${terminal}`;
      seedOrder(id, { deliveryStatus: terminal, porterOrderId: null });

      await expect(
        manualBranchDispatch({
          orderId: id,
          riderName: "Vikram Local Rider",
          riderPhone: "+91 98980 12345",
        })
      ).rejects.toMatchObject({ statusCode: 409, code: "DISPATCH_LOCKED" });

      expect(docOf(id).deliveryStatus).toBe(terminal);
      expect(docOf(id).dispatchType).toBeUndefined();
      expect(docOf(id).riderName).toBeUndefined();
    }
    expect(control.writeCalls).toHaveLength(0);
  });

  it("refuses an order already owned by an active external provider binding", async () => {
    seedOrder("ord_external_first", {
      deliveryStatus: "dispatched",
      dispatchStatus: "dispatched",
      dispatchProvider: "borzo",
      dispatchOrderId: "BRZ-LIVE-1",
      riderName: "Borzo Rider Kiran",
      riderPhone: "918880000001",
    });

    await expect(
      manualBranchDispatch({
        orderId: "ord_external_first",
        riderName: "Vikram Local Rider",
        riderPhone: "+91 98980 12345",
      })
    ).rejects.toMatchObject({ statusCode: 409, code: "DISPATCH_EXISTS" });

    const doc = docOf("ord_external_first");
    expect(doc.dispatchProvider).toBe("borzo");
    expect(doc.dispatchOrderId).toBe("BRZ-LIVE-1");
    expect(doc.riderName).toBe("Borzo Rider Kiran");
    expect(doc.dispatchType).toBeUndefined();
    expect(control.writeCalls).toHaveLength(0);
  });

  it("decides from the re-read, not the stale pre-read (external booking landed in between)", async () => {
    seedOrder("ord_stale_read"); // pre-read: free
    control.txReadSnapshot = {
      deliveryStatus: "dispatched",
      dispatchStatus: "dispatched",
      dispatchProvider: "shadowfax",
      dispatchOrderId: "SFX-LIVE-9",
    };

    await expect(
      manualBranchDispatch({
        orderId: "ord_stale_read",
        riderName: "Vikram Local Rider",
        riderPhone: "+91 98980 12345",
      })
    ).rejects.toMatchObject({ statusCode: 409, code: "DISPATCH_EXISTS" });

    expect(control.txGetCalls).toBe(1);
    expect(control.writeCalls).toHaveLength(0);
    expect(docOf("ord_stale_read").dispatchType).toBeUndefined();
  });

  it("re-authorizes against the document read inside the transaction", async () => {
    seedOrder("ord_auth_reread", { branchId: "branch_ahmedabad_1" });
    // The pre-read order belongs to the caller's branch; the transactional
    // read shows it re-linked to another outlet.
    control.txReadSnapshot = { branchId: "branch_surat_01", status: "ready" };

    await expect(
      manualBranchDispatch({
        orderId: "ord_auth_reread",
        riderName: "Vikram Local Rider",
        riderPhone: "+91 98980 12345",
        caller: manager,
      })
    ).rejects.toThrow(/outside your assigned branches/);

    expect(control.writeCalls).toHaveLength(0);
    expect(docOf("ord_auth_reread").dispatchType).toBeUndefined();
  });

  it("rejects blank (whitespace-only) rider name or phone before any read/write", async () => {
    seedOrder("ord_blank_rider");

    await expect(
      manualBranchDispatch({
        orderId: "ord_blank_rider",
        riderName: "   ",
        riderPhone: "+91 98980 12345",
      })
    ).rejects.toMatchObject({ statusCode: 400, code: "INVALID_RIDER_DETAILS" });

    await expect(
      manualBranchDispatch({
        orderId: "ord_blank_rider",
        riderName: "Vikram Local Rider",
        riderPhone: "\t  ",
      })
    ).rejects.toMatchObject({ statusCode: 400, code: "INVALID_RIDER_DETAILS" });

    expect(mockDb.runTransaction).not.toHaveBeenCalled();
    expect(control.writeCalls).toHaveLength(0);
    expect(docOf("ord_blank_rider").deliveryStatus).toBeUndefined();
  });

  it("refuses a fresh generic claim lease (202 retry, claim untouched)", async () => {
    seedOrder("ord_claim_fresh", {
      dispatchStatus: "dispatch_pending",
      dispatchClaimedAt: Date.now() - 1_000,
    });

    await expect(
      manualBranchDispatch({
        orderId: "ord_claim_fresh",
        riderName: "Vikram Local Rider",
        riderPhone: "+91 98980 12345",
      })
    ).rejects.toMatchObject({ statusCode: 202, code: "DISPATCH_IN_PROGRESS" });

    expect(docOf("ord_claim_fresh").dispatchStatus).toBe("dispatch_pending");
    expect(docOf("ord_claim_fresh").deliveryStatus).toBeUndefined();
    expect(control.writeCalls).toHaveLength(0);
  });

  it("refuses a fresh Porter claim lease (202 retry, claim untouched)", async () => {
    seedOrder("ord_porter_claim", {
      porterDispatchStatus: "dispatch_pending",
      porterDispatchClaimedAt: Date.now() - 1_000,
    });

    await expect(
      manualBranchDispatch({
        orderId: "ord_porter_claim",
        riderName: "Vikram Local Rider",
        riderPhone: "+91 98980 12345",
      })
    ).rejects.toMatchObject({ statusCode: 202, code: "DISPATCH_IN_PROGRESS" });

    expect(docOf("ord_porter_claim").porterDispatchStatus).toBe("dispatch_pending");
    expect(control.writeCalls).toHaveLength(0);
  });

  it("refuses an EXPIRED claim without pretending it was cancelled or clearing it", async () => {
    const claimedAt = Date.now() - 11 * 60 * 1000;
    seedOrder("ord_claim_stale", {
      dispatchStatus: "dispatch_pending",
      dispatchClaimedAt: claimedAt,
    });

    await expect(
      manualBranchDispatch({
        orderId: "ord_claim_stale",
        riderName: "Vikram Local Rider",
        riderPhone: "+91 98980 12345",
      })
    ).rejects.toMatchObject({ statusCode: 409, code: "DISPATCH_CLAIM_STALE" });

    const doc = docOf("ord_claim_stale");
    // Conservative: the stale lease is neither released nor rewritten (the
    // remote booking it may represent is not ours to cancel from here).
    expect(doc.dispatchStatus).toBe("dispatch_pending");
    expect(doc.dispatchClaimedAt).toBe(claimedAt);
    expect(doc.deliveryStatus).toBeUndefined();
    expect(doc.porterProviderCancel).toBeUndefined();
    expect(control.writeCalls).toHaveLength(0);
  });

  it("refuses an ambiguous provider booking awaiting reconciliation", async () => {
    seedOrder("ord_reconciliation", { porterDispatchStatus: "needs_reconciliation" });

    await expect(
      manualBranchDispatch({
        orderId: "ord_reconciliation",
        riderName: "Vikram Local Rider",
        riderPhone: "+91 98980 12345",
      })
    ).rejects.toMatchObject({ statusCode: 409, code: "DISPATCH_RECONCILIATION_REQUIRED" });

    expect(control.writeCalls).toHaveLength(0);
  });
});

describe("no provider path may book after an in-house rider wins", () => {
  it("generic claimDispatch refuses a live in-house assignment (no provider traffic)", async () => {
    seedOrder("ord_manual_then_generic");
    await manualBranchDispatch({
      orderId: "ord_manual_then_generic",
      riderName: "Vikram Local Rider",
      riderPhone: "+91 98980 12345",
    });

    await expect(dispatchBook({ orderId: "ord_manual_then_generic", staffName: "Ops" })).rejects.toMatchObject(
      { statusCode: 409, code: "DISPATCH_EXISTS" }
    );

    const doc = docOf("ord_manual_then_generic");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(doc.dispatchType).toBe("manual_branch_terminal");
    expect(doc.dispatchProvider).toBeUndefined();
    expect(doc.dispatchOrderId).toBeUndefined();
    expect(doc.dispatchStatus).toBeUndefined();
    expect(doc.riderName).toBe("Vikram Local Rider");
  });

  it("direct Porter book refuses a live in-house assignment (no provider traffic)", async () => {
    config.porter.enabled = true;
    config.mock.porterDispatch = false;
    seedOrder("ord_manual_then_porter");
    await manualBranchDispatch({
      orderId: "ord_manual_then_porter",
      riderName: "Vikram Local Rider",
      riderPhone: "+91 98980 12345",
    });

    await expect(bookPorterRider("ord_manual_then_porter", "Ops")).rejects.toMatchObject({
      statusCode: 409,
      code: "DISPATCH_EXISTS",
    });

    const doc = docOf("ord_manual_then_porter");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(doc.porterOrderId).toBeUndefined();
    expect(doc.porterDispatchStatus).toBeUndefined();
    expect(doc.riderName).toBe("Vikram Local Rider");
  });

  it("the Porter paste lane refuses a live in-house assignment", async () => {
    seedOrder("ord_manual_then_paste");
    await manualBranchDispatch({
      orderId: "ord_manual_then_paste",
      riderName: "Vikram Local Rider",
      riderPhone: "+91 98980 12345",
    });

    await expect(
      savePorterManualBooking({ orderId: "ord_manual_then_paste", porterOrderId: "PRTR-PASTE-77" })
    ).rejects.toMatchObject({ statusCode: 409, code: "DISPATCH_EXISTS" });

    const doc = docOf("ord_manual_then_paste");
    expect(doc.porterOrderId).toBeUndefined();
    expect(doc.dispatchType).toBe("manual_branch_terminal");
    expect(Object.keys(savedDocs).filter((key) => key.startsWith("porter_order_map/"))).toHaveLength(0);
    expect(Object.keys(savedDocs).filter((key) => key.startsWith("dispatch_order_map/"))).toHaveLength(0);
  });

  it("generic claimDispatch re-checks terminal state inside the transaction (stale pre-read)", async () => {
    seedOrder("ord_terminal_race"); // pre-read: ready
    control.txReadSnapshot = { deliveryStatus: "delivered" };

    await expect(dispatchBook({ orderId: "ord_terminal_race" })).rejects.toMatchObject({
      statusCode: 409,
      code: "DISPATCH_LOCKED",
    });

    expect(control.txGetCalls).toBe(1);
    expect(control.writeCalls).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(docOf("ord_terminal_race").deliveryStatus).toBeUndefined();
  });
});

describe("inactive/legacy provider-order bindings block in-house assignment", () => {
  const legacyBindings = [
    { porterOrderId: "PRTR-LEGACY-1" },
    { dispatchOrderId: "BRZ-LEGACY-2" },
    { borzoOrderId: "BRZ-LEGACY-3" },
    { shadowfaxOrderId: "SFX-LEGACY-4" },
  ];

  it("refuses every lingering provider-order id with 409, even on rider_cancelled/ready orders", async () => {
    for (const [index, binding] of legacyBindings.entries()) {
      const field = Object.keys(binding)[0];
      const value = Object.values(binding)[0];
      const id = `ord_legacy_binding_${field}`;
      seedOrder(id, {
        // Inactive on purpose: the old active-binding guard only inspected
        // ACTIVE_DELIVERY_STATUSES, which is exactly the hole being closed.
        deliveryStatus: index % 2 === 0 ? "rider_cancelled" : "ready",
        dispatchStatus: "dispatch_failed",
        needsRebook: true,
        rebookTrigger: "carrier_cancelled",
        ...binding,
      });

      await expect(
        manualBranchDispatch({
          orderId: id,
          riderName: "Vikram Local Rider",
          riderPhone: "+91 98980 12345",
        })
      ).rejects.toMatchObject({ statusCode: 409, code: "DISPATCH_RECONCILIATION_REQUIRED" });

      const doc = docOf(id);
      // The unresolved id is neither cleared nor overwritten (we cannot cancel
      // the remote booking) and no in-house ownership marker was written.
      expect(doc[field]).toBe(value);
      expect(doc.dispatchType).toBeUndefined();
      expect(doc.riderName).toBeUndefined();
      expect(doc.riderPhone).toBeUndefined();
      expect(doc.needsRebook).toBe(true);
    }
    expect(control.writeCalls).toHaveLength(0);
  });

  it("decides from the transactional re-read when the binding lands after the pre-read", async () => {
    seedOrder("ord_legacy_stale"); // pre-read: free
    control.txReadSnapshot = {
      deliveryStatus: "rider_cancelled",
      porterOrderId: "PRTR-TORN-9",
    };

    await expect(
      manualBranchDispatch({
        orderId: "ord_legacy_stale",
        riderName: "Vikram Local Rider",
        riderPhone: "+91 98980 12345",
      })
    ).rejects.toMatchObject({ statusCode: 409, code: "DISPATCH_RECONCILIATION_REQUIRED" });

    expect(control.txGetCalls).toBe(1);
    expect(control.writeCalls).toHaveLength(0);
    expect(docOf("ord_legacy_stale").dispatchType).toBeUndefined();
    expect(docOf("ord_legacy_stale").porterOrderId).toBeUndefined();
  });
});

describe("canonical terminal status locks every claim path", () => {
  it("manual / generic book / paste all refuse when status.terminal is true but deliveryStatus lags", async () => {
    const status = { code: "DELIVERED", label: "Delivered", kind: "completed", terminal: true };
    seedOrder("ord_canon_manual", { deliveryStatus: "confirmed", status });
    seedOrder("ord_canon_generic", { deliveryStatus: "confirmed", status });
    seedOrder("ord_canon_paste", { deliveryStatus: "confirmed", status });

    await expect(
      manualBranchDispatch({
        orderId: "ord_canon_manual",
        riderName: "Vikram Local Rider",
        riderPhone: "+91 98980 12345",
      })
    ).rejects.toMatchObject({ statusCode: 409, code: "DISPATCH_LOCKED" });

    await expect(dispatchBook({ orderId: "ord_canon_generic" })).rejects.toMatchObject({
      statusCode: 409,
      code: "DISPATCH_LOCKED",
    });

    await expect(
      savePorterManualBooking({ orderId: "ord_canon_paste", porterOrderId: "PRTR-CANON-1" })
    ).rejects.toMatchObject({ statusCode: 409, code: "DISPATCH_LOCKED" });

    for (const id of ["ord_canon_manual", "ord_canon_generic", "ord_canon_paste"]) {
      const doc = docOf(id);
      expect(doc.deliveryStatus).toBe("confirmed"); // never rewound to dispatched
      expect(doc.dispatchType).toBeUndefined();
      expect(doc.porterOrderId).toBeUndefined();
      expect(doc.dispatchProvider).toBeUndefined();
    }
    expect(control.writeCalls).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("direct Porter book refuses a canonical completed order before any provider work", async () => {
    config.porter.enabled = true;
    config.mock.porterDispatch = true;
    seedOrder("ord_canon_porter", {
      deliveryStatus: "ready",
      // `kind: "completed"` without an explicit terminal flag: the OR-clause.
      status: { code: "DELIVERED", label: "Delivered", kind: "completed" },
    });

    await expect(bookPorterRider("ord_canon_porter", "Ops")).rejects.toMatchObject({
      statusCode: 409,
      code: "DISPATCH_LOCKED",
    });

    expect(control.writeCalls).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(docOf("ord_canon_porter").porterOrderId).toBeUndefined();
    expect(docOf("ord_canon_porter").porterDispatchStatus).toBeUndefined();
  });

  it("a canonical CANCELLED terminal object also locks the generic claim", async () => {
    seedOrder("ord_canon_cancelled", {
      deliveryStatus: "confirmed",
      status: { code: "CANCELLED", label: "Cancelled", kind: "cancelled", terminal: true },
    });

    await expect(dispatchBook({ orderId: "ord_canon_cancelled" })).rejects.toMatchObject({
      statusCode: 409,
      code: "DISPATCH_LOCKED",
    });
    expect(control.writeCalls).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("stale pre-read: a terminal flip landing in-flight is caught inside the transaction", async () => {
    seedOrder("ord_canon_race"); // pre-read: ready
    control.txReadSnapshot = {
      deliveryStatus: "confirmed",
      status: { code: "DELIVERED", label: "Delivered", kind: "completed", terminal: true },
    };

    await expect(dispatchBook({ orderId: "ord_canon_race" })).rejects.toMatchObject({
      statusCode: 409,
      code: "DISPATCH_LOCKED",
    });
    expect(control.txGetCalls).toBe(1);
    expect(control.writeCalls).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();

    // The paste lane re-checks canonical terminal state in its own transaction.
    seedOrder("ord_canon_race_paste");
    await expect(
      savePorterManualBooking({ orderId: "ord_canon_race_paste", porterOrderId: "PRTR-RACE-1" })
    ).rejects.toMatchObject({ statusCode: 409, code: "DISPATCH_LOCKED" });
    expect(control.writeCalls).toHaveLength(0);
    expect(docOf("ord_canon_race").deliveryStatus).toBeUndefined();
    expect(docOf("ord_canon_race_paste").porterOrderId).toBeUndefined();
  });
});

describe("claim transaction re-read of a deleted order fails 404 before provider work", () => {
  it("generic claim returns ORDER_NOT_FOUND with zero writes", async () => {
    seedOrder("ord_deleted_generic");
    control.txDocMissing = true;

    await expect(dispatchBook({ orderId: "ord_deleted_generic" })).rejects.toMatchObject({
      statusCode: 404,
      code: "ORDER_NOT_FOUND",
    });

    expect(control.txGetCalls).toBe(1);
    expect(control.writeCalls).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("direct Porter claim returns ORDER_NOT_FOUND before any booking", async () => {
    config.porter.enabled = true;
    config.mock.porterDispatch = true;
    seedOrder("ord_deleted_porter");
    control.txDocMissing = true;

    await expect(bookPorterRider("ord_deleted_porter", "Ops")).rejects.toMatchObject({
      statusCode: 404,
      code: "ORDER_NOT_FOUND",
    });

    expect(control.writeCalls).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(docOf("ord_deleted_porter").porterOrderId).toBeUndefined();
  });
});

describe("fresh manual response is safely serializable", () => {
  it("does not echo unresolved serverTimestamp sentinels; replay returns committed values", async () => {
    seedOrder("ord_manual_serializable");
    const params = {
      orderId: "ord_manual_serializable",
      riderName: "Vikram Local Rider",
      riderPhone: "+91 98980 12345",
    };

    const fresh = await manualBranchDispatch(params);

    expect(fresh).toMatchObject({
      success: true,
      dispatchType: "manual_branch_terminal",
      riderName: "Vikram Local Rider",
    });
    // The committed timestamp is a post-commit truth we do not have yet.
    expect(fresh.dispatchedAt).toBeUndefined();
    expect(fresh.updatedAt).toBeUndefined();
    expect(JSON.stringify(fresh)).not.toMatch(/MOCK_TS_/);
    for (const value of Object.values(fresh)) {
      const serializable = value === null || ["string", "number", "boolean"].includes(typeof value);
      expect(serializable).toBe(true);
    }

    const replay = await manualBranchDispatch(params);
    const doc = docOf("ord_manual_serializable");
    // Replay reports the STORED timestamps (no sentinel, no new write).
    expect(replay).toMatchObject({ reused: true });
    expect(replay.dispatchedAt).toBe(doc.dispatchedAt);
    expect(replay.updatedAt).toBe(doc.updatedAt);
    expect(doc.dispatchedAt).toBeTruthy();
    expect(control.writeCalls).toHaveLength(1);
  });
});

describe("in-house winner landing after the preliminary read", () => {
  const inHouseWinner = () => ({
    dispatchType: "manual_branch_terminal",
    deliveryStatus: "dispatched",
    riderName: "Vikram Local Rider",
    riderPhone: "+91 98980 12345",
  });

  it("generic claim takes 409 DISPATCH_EXISTS with zero writes/maps/fetch", async () => {
    seedOrder("ord_inhouse_race_generic"); // pre-read: free
    control.txReadSnapshot = inHouseWinner();

    await expect(dispatchBook({ orderId: "ord_inhouse_race_generic" })).rejects.toMatchObject({
      statusCode: 409,
      code: "DISPATCH_EXISTS",
    });

    expect(control.txGetCalls).toBe(1);
    expect(control.writeCalls).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(
      Object.keys(savedDocs).filter(
        (key) => key.startsWith("dispatch_order_map/") || key.startsWith("porter_order_map/")
      )
    ).toHaveLength(0);
    expect(docOf("ord_inhouse_race_generic").dispatchProvider).toBeUndefined();
  });

  it("paste lane takes 409 DISPATCH_EXISTS with zero writes/maps/fetch", async () => {
    seedOrder("ord_inhouse_race_paste"); // pre-read: free
    control.txReadSnapshot = inHouseWinner();

    await expect(
      savePorterManualBooking({ orderId: "ord_inhouse_race_paste", porterOrderId: "PRTR-INHOUSE-1" })
    ).rejects.toMatchObject({ statusCode: 409, code: "DISPATCH_EXISTS" });

    expect(control.txGetCalls).toBe(1);
    expect(control.writeCalls).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(
      Object.keys(savedDocs).filter(
        (key) => key.startsWith("dispatch_order_map/") || key.startsWith("porter_order_map/")
      )
    ).toHaveLength(0);
    expect(docOf("ord_inhouse_race_paste").porterOrderId).toBeUndefined();
  });
});
