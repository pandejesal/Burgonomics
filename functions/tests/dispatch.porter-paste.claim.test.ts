/**
 * DR8 paste lane vs the PORTER claim — double-book guard (lane 04, session
 * ses_ea5c89e34ffeE5jJ0PRSjVSH2k).
 *
 * Defect: savePorterManualBooking (dispatch.router.ts, paste lane) checked ONLY
 * isFreshGenericPending (the generic book claim) and never isFreshPorterPending,
 * although the SAME module's transactional claimDispatch busyCheck treats both
 * as blocking (dispatch.router.ts:151) and /porter/book writes
 * porterDispatchStatus:"dispatch_pending" + porterDispatchClaimedAt as its live
 * claim. A paste landing inside that claim window flipped the order to
 * dispatched unconditionally → two live courier bookings for one order, with
 * the orphan booking never entering the maps and needsRebook cleared.
 *
 * Contract under test (positive + negative):
 *   1. fresh PORTER claim     -> 202 DISPATCH_IN_PROGRESS, order doc MUTATE
 *                                NOTHING (no delivered-state flip, no claim
 *                                clear, no map rows).
 *   2. STALE porter claim     -> paste proceeds (TTL semantics honored — no
 *                                over-blocking).
 *   3. fresh GENERIC claim    -> 202 (unchanged behavior, parity with the
 *                                existing dispatch.router.test.ts case).
 *   4. porterDispatchStatus:"dispatch_pending" WITHOUT a claim timestamp ->
 *                                NOT blocking (claimFreshMs -> 0 skew).
 *   5. RELEASED porter statuses (dispatch_failed / needs_reconciliation) ->
 *                                NOT blocking (the release path must not
 *                                wedge the paste lane).
 *   6. Timestamp-shaped claim (toMillis()) -> 202 when fresh.
 *   7. RACE-WINDOW — the order becomes claimed between the paste's initial
 *      read and its final write (claim lands after the branch/terminal
 *      checks) -> the paste must STILL refuse with 202 and mutate nothing.
 *      THIS CASE EXERCISES THE SNAPSHOT-TOCTOU: the pre-fix implementation
 *      decided from the stale pre-read and proceeded.
 * Harness mirrors tests/dispatch.router.test.ts (refreshable snapshot fake).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, savedDocs, defaultOrder, race, readCounts } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  const readCounts: Record<string, number> = {};
  const race: { docKey: string | null; afterRead: number; hook: null | (() => void) } = {
    docKey: null,
    afterRead: 2,
    hook: null,
  };
  const defaultOrder = () => ({
    branchId: "branch_ahmedabad_1",
    branchName: "Burgonomics CG Road",
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
  });
  const mergeSet = (colName: string, docId: string, data: any) => {
    savedDocs[`${colName}/${docId}`] = {
      ...(savedDocs[`${colName}/${docId}`] || {}),
      ...data,
    };
  };
  const readDoc: any = (colName: string, docId: string) => {
    const key = `${colName}/${docId}`;
    readCounts[key] = (readCounts[key] || 0) + 1;
    // Race hook (case 7): mutates the doc right before the chosen read of a
    // chosen path — models a claim landing between the paste's pre-read and
    // its final decision/write. Fires exactly once (a later read must NOT
    // re-trigger, so the assertion target of a case stays unambiguous).
    if (race.docKey === key && race.hook && readCounts[key] >= race.afterRead) {
      race.hook();
      race.hook = null;
    }
    // COPIES, not live references (DS round-3 minor 1): if data() returned the
    // live store object, the paste's pre-read would alias the very state the
    // hook mutates, and a snapshot-stale implementation could pass case 7.
    const snap: any = {
      exists: true,
      data: () => ({ ...(savedDocs[`${colName}/${docId}`] || defaultOrder()) }),
      ref: {
        get: vi.fn(async () => readDoc(colName, docId)),
        set: vi.fn(async (data: any) => mergeSet(colName, docId, data)),
      },
    };
    return snap;
  };
  const mockDb: any = {
    collection: (colName: string) => ({
      doc: (docId: string) => ({
        id: docId,
        set: vi.fn(async (data: any) => mergeSet(colName, docId, data)),
        get: vi.fn(async () => readDoc(colName, docId)),
      }),
      where: (field: string, op: string, val: any) => ({
        limit: (n: number) => ({
          get: async () => ({ empty: true, docs: [] }),
        }),
      }),
    }),
    runTransaction: vi.fn(async (fn: any) =>
      fn({
        get: (ref: any) => ref.get(),
        set: (ref: any, data: any, opts?: any) => ref.set(data, opts),
      })
    ),
  };
  return { mockDb, savedDocs, defaultOrder, race, readCounts };
});

vi.mock("firebase-admin", () => {
  const FieldValue = {
    serverTimestamp: () => "MOCK_TIMESTAMP",
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

import { savePorterManualBooking } from "../src/modules/dispatch/dispatch.router";

function seedOrder(id: string, extra: Record<string, any> = {}) {
  savedDocs[`orders/${id}`] = { ...defaultOrder(), ...extra };
}

function docOf(id: string): any {
  return savedDocs[`orders/${id}`];
}

function resetRace() {
  race.docKey = null;
  race.afterRead = 2;
  race.hook = null;
  for (const k of Object.keys(readCounts)) delete readCounts[k];
  mockDb.runTransaction.mockClear();
}

// DISPATCH_CLAIM_TTL_MS is 10 minutes in dispatch.router.ts — 11 minutes back
// is unambiguously stale without knowing the exact constant.
const STALE = Date.now() - 11 * 60 * 1000;

describe("savePorterManualBooking vs claims (porter-paste double-book guard)", () => {
  beforeEach(() => {
    resetRace();
  });

  it("1. RED — fresh /porter/book claim must 202 DISPATCH_IN_PROGRESS and mutate NOTHING", async () => {
    seedOrder("ord_porterclaim", {
      deliveryStatus: "preparing",
      // EXACT shape the direct /porter/book claim writes (porter.service:
      // porterDispatchStatus:"dispatch_pending" + porterDispatchClaimedAt).
      porterDispatchStatus: "dispatch_pending",
      porterDispatchClaimedAt: Date.now(),
    });

    await expect(
      savePorterManualBooking({ orderId: "ord_porterclaim", porterOrderId: "POR-RACE-1", staffName: "Ops" })
    ).rejects.toMatchObject({ statusCode: 202, code: "DISPATCH_IN_PROGRESS" });

    // Zero mutation: no paste flip, no supersede of the in-flight booking.
    expect(docOf("ord_porterclaim").deliveryStatus).toBe("preparing");
    expect(docOf("ord_porterclaim").dispatchOrderId).toBeUndefined();
    expect(docOf("ord_porterclaim").porterOrderId).toBeUndefined();
    expect(docOf("ord_porterclaim").dispatchStatus).toBeUndefined();
    expect(docOf("ord_porterclaim").needsRebook).toBeUndefined();
    // No binding maps were written either.
    expect(savedDocs["dispatch_order_map/POR-RACE-1"]).toBeUndefined();
    expect(savedDocs["porter_order_map/POR-RACE-1"]).toBeUndefined();
  });

  it("2. NEGATIVE — a STALE porter claim does not block the paste (TTL honored)", async () => {
    seedOrder("ord_porterstale", {
      porterDispatchStatus: "dispatch_pending",
      porterDispatchClaimedAt: STALE,
    });

    const res = await savePorterManualBooking({
      orderId: "ord_porterstale",
      porterOrderId: "POR-AFTER-TTL",
      staffName: "Ops",
    });

    expect(res).toMatchObject({ success: true, provider: "porter", porterOrderId: "POR-AFTER-TTL" });
    expect(docOf("ord_porterstale").deliveryStatus).toBe("dispatched");
    // Settled paste wipes the claim lease: no stale dispatch_pending marker
    // survives (DS round-3 minor 4).
    expect(docOf("ord_porterstale").porterDispatchStatus).toBe("dispatched");
    expect(docOf("ord_porterstale").porterDispatchClaimedAt).toBeNull();
  });

  it("3. PARITY — fresh generic claim still refuses with 202 (unchanged)", async () => {
    seedOrder("ord_generic", {
      dispatchStatus: "dispatch_pending",
      dispatchClaimedAt: Date.now(),
    });

    await expect(
      savePorterManualBooking({ orderId: "ord_generic", porterOrderId: "POR-GEN", staffName: "Ops" })
    ).rejects.toMatchObject({ statusCode: 202, code: "DISPATCH_IN_PROGRESS" });
    expect(docOf("ord_generic").deliveryStatus).toBeUndefined();
    expect(savedDocs["dispatch_order_map/POR-GEN"]).toBeUndefined();
    expect(savedDocs["porter_order_map/POR-GEN"]).toBeUndefined();
  });

  it("4. NEGATIVE — pending porter claim WITHOUT a timestamp is NOT fresh (no over-block)", async () => {
    seedOrder("ord_noclaimtime", {
      porterDispatchStatus: "dispatch_pending",
      // claimedAt absent entirely: claimFreshMs -> 0 skew -> never fresh.
    });

    const res = await savePorterManualBooking({
      orderId: "ord_noclaimtime",
      porterOrderId: "POR-NOTIME",
      staffName: "Ops",
    });

    expect(res).toMatchObject({ success: true, provider: "porter", porterOrderId: "POR-NOTIME" });
    expect(docOf("ord_noclaimtime").deliveryStatus).toBe("dispatched");
  });

  it("5. NEGATIVE — RELEASED porter statuses (dispatch_failed / needs_reconciliation) do not block", async () => {
    seedOrder("ord_failed", {
      porterDispatchStatus: "dispatch_failed",
      porterDispatchClaimedAt: Date.now(), // claimed at this moment — but status NOT pending
    });
    seedOrder("ord_needsrec", {
      porterDispatchStatus: "needs_reconciliation",
      porterDispatchClaimedAt: Date.now(),
    });

    const ok1 = await savePorterManualBooking({ orderId: "ord_failed", porterOrderId: "POR-F1" });
    const ok2 = await savePorterManualBooking({ orderId: "ord_needsrec", porterOrderId: "POR-NR1" });
    expect(ok1).toMatchObject({ success: true, provider: "porter", porterOrderId: "POR-F1" });
    expect(ok2).toMatchObject({ success: true, provider: "porter", porterOrderId: "POR-NR1" });
    // The paste must really settle each order, not just return success.
    expect(docOf("ord_failed").deliveryStatus).toBe("dispatched");
    expect(docOf("ord_needsrec").deliveryStatus).toBe("dispatched");
  });

  it("6. Timestamp-shaped claim (toMillis()) blocks while fresh — claimFreshMs honors real Firestore Timestamps", async () => {
    seedOrder("ord_tsclaim", {
      porterDispatchStatus: "dispatch_pending",
      porterDispatchClaimedAt: { toMillis: () => Date.now() },
    });

    await expect(
      savePorterManualBooking({ orderId: "ord_tsclaim", porterOrderId: "POR-TS", staffName: "Ops" })
    ).rejects.toMatchObject({ statusCode: 202, code: "DISPATCH_IN_PROGRESS" });
    expect(docOf("ord_tsclaim").deliveryStatus).toBeUndefined();
    expect(savedDocs["porter_order_map/POR-TS"]).toBeUndefined();
  });

  it("7. SNAPSHOT-TOCTOU — a claim landing after the paste's pre-read still refuses (zero mutation)", async () => {
    seedOrder("ord_race");
    race.docKey = "orders/ord_race";
    race.afterRead = 2; // after the paste's initial order read, before its write
    race.hook = () => {
      // A /porter/book claim commits in this window (numeric Date.now shape).
      docOf("ord_race").porterDispatchStatus = "dispatch_pending";
      docOf("ord_race").porterDispatchClaimedAt = Date.now();
    };

    await expect(
      savePorterManualBooking({ orderId: "ord_race", porterOrderId: "POR-RACE-WIN", staffName: "Ops" })
    ).rejects.toMatchObject({ statusCode: 202, code: "DISPATCH_IN_PROGRESS" });

    // Zero mutation: the stale-snapshot decision never lands.
    expect(docOf("ord_race").deliveryStatus).toBeUndefined();
    expect(docOf("ord_race").dispatchOrderId).toBeUndefined();
    expect(docOf("ord_race").porterOrderId).toBeUndefined();
    expect(docOf("ord_race").needsRebook).toBeUndefined();
    expect(savedDocs["dispatch_order_map/POR-RACE-WIN"]).toBeUndefined();
    // The race decision rode the transaction, not a second snapshot read.
    expect(mockDb.runTransaction).toHaveBeenCalledTimes(1);
  });

  it("8. TRUTHFUL COPY — pasting a DIFFERENT porter id over a PORTER-dispatched order 409s with Porter copy", async () => {
    seedOrder("ord_paste_over_paste", {
      deliveryStatus: "dispatched",
      dispatchProvider: undefined,
      porterOrderId: "POR-FIRST",
      dispatchOrderId: "POR-FIRST",
    });

    await expect(
      savePorterManualBooking({ orderId: "ord_paste_over_paste", porterOrderId: "POR-SECOND", staffName: "Ops" })
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "DISPATCH_EXISTS",
      message: expect.stringContaining("already dispatched via Porter"),
    });
    // The first binding is untouched — no silent rebind, no orphan.
    expect(docOf("ord_paste_over_paste").porterOrderId).toBe("POR-FIRST");
    expect(docOf("ord_paste_over_paste").dispatchOrderId).toBe("POR-FIRST");
  });

  it("9. FALLBACK PATH — a shim without runTransaction applies the SAME rules and still flips", async () => {
    seedOrder("ord_shim");
    const hadTx = mockDb.runTransaction;
    try {
      delete (mockDb as any).runTransaction;
      const res = await savePorterManualBooking({ orderId: "ord_shim", porterOrderId: "POR-SHIM", staffName: "Ops" });
      expect(res).toMatchObject({ success: true, provider: "porter", porterOrderId: "POR-SHIM" });
      expect(docOf("ord_shim").deliveryStatus).toBe("dispatched");
      expect(docOf("ord_shim").porterDispatchStatus).toBe("dispatched");
      expect(docOf("ord_shim").porterDispatchClaimedAt).toBeNull();
    } finally {
      mockDb.runTransaction = hadTx;
    }
  });

  it("10. TERMINAL IN-FLIGHT — an order delivered between pre-read and tx refuses with the typed lock error", async () => {
    seedOrder("ord_race_terminal");
    race.docKey = "orders/ord_race_terminal";
    race.afterRead = 2;
    race.hook = () => {
      docOf("ord_race_terminal").deliveryStatus = "delivered";
      docOf("ord_race_terminal").status = { terminal: true };
    };

    await expect(
      savePorterManualBooking({ orderId: "ord_race_terminal", porterOrderId: "POR-RACE-T", staffName: "Ops" })
    ).rejects.toMatchObject({ statusCode: 409 });
    // Zero mutation: the terminal flip was observed before any write.
    expect(docOf("ord_race_terminal").dispatchOrderId).toBeUndefined();
    expect(docOf("ord_race_terminal").porterOrderId).toBeUndefined();
    expect(savedDocs["dispatch_order_map/POR-RACE-T"]).toBeUndefined();
  });
});
