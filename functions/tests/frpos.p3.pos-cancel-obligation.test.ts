import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * P3 — a POS-originated cancellation runs the SHARED cancel side effects once
 * (coupon release + courier cleanup) and NEVER calls the vendor's cancel back.
 */
const h = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  const calls = {
    posCancel: 0,
    couponRelease: 0,
    courierCleanup: 0,
    coinsRestore: 0,
  };
  const docRef = (col: string, id: string): any => {
    const path = `${col}/${id}`;
    return {
      id,
      get: vi.fn(async () => ({
        id,
        exists: savedDocs[path] !== undefined,
        data: () => (savedDocs[path] ? { ...savedDocs[path] } : undefined),
        ref: docRef(col, id),
      })),
      set: vi.fn(async (data: any, opts?: any) => {
        savedDocs[path] = opts?.merge && savedDocs[path] ? { ...savedDocs[path], ...data } : { ...data };
      }),
    };
  };
  const mockDb: any = {
    collection: (col: string) => ({
      doc: (id: string) => docRef(col, id),
      where: (field: string, op: string, val: any) => ({
        limit: (n: number) => ({
          get: async () => ({
            docs: Object.keys(savedDocs)
              .filter((k) => k.startsWith(`${col}/`) && savedDocs[k]?.[field] === val)
              .slice(0, n)
              .map((k) => {
                const id = k.slice(col.length + 1);
                return { id, exists: true, data: () => ({ ...savedDocs[k] }), ref: docRef(col, id) };
              }),
            empty: false,
          }),
        }),
      }),
    }),
    runTransaction: async (fn: any) =>
      fn({
        get: (ref: any) => ref.get(),
        set: (ref: any, data: any, opts?: any) => ref.set(data, opts),
      }),
  };
  return { savedDocs, calls, mockDb };
});
const { savedDocs, calls, mockDb } = h;

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
vi.mock("../src/core/errors", async (importOriginal) => {
  const actual: any = await importOriginal();
  return { ...actual, captureErrorSnapshot: vi.fn(async () => "err") };
});
vi.mock("../src/modules/petpooja/orderCancel", () => ({
  requestPetpoojaOrderCancel: vi.fn(async () => {
    calls.posCancel++;
    return "cancelled";
  }),
}));
vi.mock("../src/modules/dispatch/shadowfax.reconcile", () => ({
  recordAndAttemptProviderCancel: vi.fn(async () => {
    calls.courierCleanup++;
  }),
}));
vi.mock("../src/modules/customers/customerCoins", () => ({
  restoreRedeemedCoins: vi.fn(async () => {
    calls.coinsRestore++;
    return { alreadyDone: false };
  }),
}));
vi.mock("../src/modules/coupons/couponAuthority", () => ({
  releaseCouponRedemption: vi.fn(async () => {
    calls.couponRelease++;
    return { released: true };
  }),
}));

import { applyCancelSideEffects } from "../src/modules/orders/cancelSideEffects";
import {
  enqueuePosCancelSideEffects,
  processPosCancelSideEffectObligation,
  processPendingPosCancelSideEffects,
  POS_CANCEL_SIDE_EFFECT_COLLECTION,
} from "../src/modules/petpooja/cancelSideEffectsObligation";

beforeEach(() => {
  for (const k of Object.keys(savedDocs)) delete savedDocs[k];
  calls.posCancel = 0;
  calls.couponRelease = 0;
  calls.courierCleanup = 0;
  calls.coinsRestore = 0;
  savedDocs["orders/ord_pos"] = {
    id: "ord_pos",
    status: { code: "CANCELLED", kind: "cancelled" },
    dispatchProvider: "borzo",
    dispatchOrderId: "borzo_1",
    deliveryStatus: "pending",
  };
});

describe("P3 — skip the outbound POS cancel, keep the shared cleanup", () => {
  it("runs coupon release + courier cleanup but never calls the POS cancel", async () => {
    const result = await applyCancelSideEffects({
      orderId: "ord_pos",
      requestedBy: "petpooja",
      reason: "order_cancelled",
      skipPosCancel: true,
    });

    expect(result.posCancel).toBe("skipped_pos_originated");
    expect(calls.posCancel).toBe(0);
    expect(calls.couponRelease).toBe(1);
    expect(calls.courierCleanup).toBe(1);
  });

  it("a normal cancellation still calls the POS cancel", async () => {
    await applyCancelSideEffects({
      orderId: "ord_pos",
      requestedBy: "customer:c1",
      reason: "order_cancelled",
    });
    expect(calls.posCancel).toBe(1);
  });
});

describe("P3 — durable POS cancellation obligation", () => {
  it("drains the obligation once; a replay writes no second cleanup", async () => {
    await enqueuePosCancelSideEffects("ord_pos", "b1");
    expect(savedDocs[`${POS_CANCEL_SIDE_EFFECT_COLLECTION}/pcs_ord_pos`].status).toBe("pending");

    expect(await processPosCancelSideEffectObligation("ord_pos")).toBe("ran");
    expect(savedDocs[`${POS_CANCEL_SIDE_EFFECT_COLLECTION}/pcs_ord_pos`].status).toBe("done");
    expect(calls.couponRelease).toBe(1);

    expect(await processPosCancelSideEffectObligation("ord_pos")).toBe("skipped");
    expect(calls.couponRelease).toBe(1);
    expect(calls.posCancel).toBe(0);
  });

  it("re-enqueue after completion does not reopen a finished obligation", async () => {
    await enqueuePosCancelSideEffects("ord_pos", "b1");
    await processPosCancelSideEffectObligation("ord_pos");
    await enqueuePosCancelSideEffects("ord_pos", "b1");
    expect(savedDocs[`${POS_CANCEL_SIDE_EFFECT_COLLECTION}/pcs_ord_pos`].status).toBe("done");
    expect((await processPendingPosCancelSideEffects()).ran).toBe(0);
  });
});
