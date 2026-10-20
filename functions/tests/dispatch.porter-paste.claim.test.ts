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
 * Harness mirrors tests/dispatch.router.test.ts (refreshable snapshot fake).
 */
import { describe, it, expect, vi } from "vitest";

const { mockDb, savedDocs, defaultOrder } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
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
    const snap: any = {
      exists: true,
      data: () => savedDocs[`${colName}/${docId}`] || defaultOrder(),
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
  return { mockDb, savedDocs, defaultOrder };
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

// DISPATCH_CLAIM_TTL_MS is 10 minutes in dispatch.router.ts — 11 minutes back
// is unambiguously stale without knowing the exact constant.
const STALE = Date.now() - 11 * 60 * 1000;

describe("savePorterManualBooking vs claims (porter-paste double-book guard)", () => {
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
});
