import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * r2 P3 — durable POS cancellation obligations must reclaim expired leases,
 * fence result writes to the claim token, retry explicit coupon/courier failures,
 * and be drained even while the outbound POS bridge is disabled.
 */
const h = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  const calls = { coupon: 0, courier: 0, drain: 0 };
  const state = {
    enabled: true,
    couponFails: false,
    courierFails: false,
    onResultTx: null as null | (() => void),
    txCount: 0,
    secondDrain: null as null | (() => void),
    secondDrainUsed: false,
  };
  const docRef = (col: string, id: string): any => {
    const path = `${col}/${id}`;
    return {
      id,
      get: vi.fn(async () => ({ id, exists: savedDocs[path] !== undefined, data: () => (savedDocs[path] ? { ...savedDocs[path] } : undefined), ref: docRef(col, id) })),
      set: vi.fn(async (data: any, opts?: any) => {
        if (data?.status === "processing" && state.secondDrain && !state.secondDrainUsed) {
          state.secondDrainUsed = true;
          const hook = state.secondDrain;
          await hook();
        }
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
    runTransaction: async (fn: any) => {
      state.txCount++;
      // The second transaction in a drain is the fenced result write: simulate
      // a competing instance taking over the lease just before it re-reads.
      if (state.txCount === 2 && state.onResultTx) {
        const hook = state.onResultTx;
        state.onResultTx = null;
        hook();
      }
      return fn({ get: (r: any) => r.get(), set: (r: any, d: any, o?: any) => r.set(d, o) });
    },
  };
  return { savedDocs, calls, state, mockDb };
});
const { savedDocs, calls, state, mockDb } = h;

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
vi.mock("../src/core/errors", async (importOriginal) => {
  const actual: any = await importOriginal();
  return { ...actual, captureErrorSnapshot: vi.fn(async () => "err") };
});
vi.mock("../src/modules/petpooja/client", async (importOriginal) => {
  const actual: any = await importOriginal();
  return { ...actual, isPetpoojaEnabled: () => h.state.enabled };
});
vi.mock("../src/modules/petpooja/orderCancel", async (importOriginal) => {
  const actual: any = await importOriginal();
  return { ...actual, requestPetpoojaOrderCancel: vi.fn(async () => "cancelled") };
});
vi.mock("../src/modules/customers/customerCoins", () => ({ restoreRedeemedCoins: vi.fn(async () => ({ alreadyDone: false })) }));
vi.mock("../src/modules/dispatch/shadowfax.reconcile", () => ({
  recordAndAttemptProviderCancel: vi.fn(async () => { h.calls.courier++; return {state: h.state.courierFails ? 'pending' : 'confirmed', attempts:1, lastError:h.state.courierFails ? 'courier unavailable' : null}; }),
}));
vi.mock("../src/modules/coupons/couponAuthority", () => ({
  releaseCouponRedemption: vi.fn(async () => {
    h.calls.coupon++;
    if (h.state.couponFails) throw new Error("coupon service unavailable");
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
import { retryPendingPetpoojaOrderCancelsWorker } from "../src/modules/petpooja/orderCancel";

const P = `${POS_CANCEL_SIDE_EFFECT_COLLECTION}/pcs_ord_pos`;
beforeEach(() => {
  for (const k of Object.keys(savedDocs)) delete savedDocs[k];
  calls.coupon = 0; calls.courier = 0;
  state.enabled = true; state.couponFails = false;
  state.courierFails = false;
  state.onResultTx = null; state.txCount = 0; state.secondDrain = null; state.secondDrainUsed = false;
  savedDocs["orders/ord_pos"] = { id: "ord_pos", status: { code: "CANCELLED" }, dispatchProvider: "borzo", dispatchOrderId: "b1", deliveryStatus: "pending" };
});

describe("r2 P3 — obligation hardening", () => {
  it("reclaims an expired processing lease after a crash (callback → crash → restart)", async () => {
    savedDocs[P] = { orderId: "ord_pos", status: "processing", claimedAt: Date.now() - 11 * 60 * 1000, claimToken: "stale", attempts: 1 };
    const res = await processPendingPosCancelSideEffects();
    expect(res.ran).toBe(1);
    expect(savedDocs[P].status).toBe("done");
    expect(calls.coupon).toBe(1);
  });

  it("a concurrent replay cannot double-run the cleanup", async () => {
    await enqueuePosCancelSideEffects("ord_pos", "b1");
    state.secondDrain = async () => {
      await processPosCancelSideEffectObligation("ord_pos");
    };
    const outcome = await processPosCancelSideEffectObligation("ord_pos");
    expect(["ran", "skipped"]).toContain(outcome);
    expect(calls.coupon).toBe(1);
    expect(calls.courier).toBe(1);
  });

  it("never marks a failed coupon cleanup as done; a later retry converges", async () => {
    await enqueuePosCancelSideEffects("ord_pos", "b1");
    state.couponFails = true;
    expect(await processPosCancelSideEffectObligation("ord_pos")).toBe("retry");
    expect(savedDocs[P].status).toBe("pending");
    state.couponFails = false;
    expect(await processPosCancelSideEffectObligation("ord_pos")).toBe("ran");
    expect(savedDocs[P].status).toBe("done");
    expect(calls.coupon).toBe(2);
    expect(calls.courier).toBe(1);
  });

  it('leaves a courier pending intent to its own worker; the obligation still completes', async () => {
    await enqueuePosCancelSideEffects('ord_pos','b1');
    state.courierFails = true;
    // The courier's pending/dead-letter state is NOT an obligation failure.
    expect(await processPosCancelSideEffectObligation('ord_pos')).toBe('ran');
    expect(savedDocs[P].status).toBe('done');
    expect(calls.courier).toBe(1);
    expect(calls.coupon).toBe(1);
  });

  it("fences the result to the claim token — a takeover's newer state is not clobbered", async () => {
    await enqueuePosCancelSideEffects("ord_pos", "b1");
    state.onResultTx = () => {
      savedDocs[P] = { ...savedDocs[P], status: "processing", claimToken: "newer" };
    };
    expect(await processPosCancelSideEffectObligation("ord_pos")).toBe("skipped");
    expect(savedDocs[P].status).toBe("processing");
    expect(savedDocs[P].claimToken).toBe("newer");
  });

  it("drains obligations even when the outbound POS bridge is disabled", async () => {
    await enqueuePosCancelSideEffects("ord_pos", "b1");
    state.enabled = false;
    await retryPendingPetpoojaOrderCancelsWorker();
    expect(savedDocs[P].status).toBe("done");
    expect(calls.coupon).toBe(1);
  });
});
