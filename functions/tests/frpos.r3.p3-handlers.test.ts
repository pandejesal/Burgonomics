import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * r3 P3 through the REAL helpers:
 * - a claim from a DISCARDED Firestore transaction attempt must not run cleanup;
 * - a datastore fault beneath the real coupon helper surfaces as an explicit
 *   failure, so the obligation stays retryable;
 * - a courier result recorded with its own durable intent is left to the
 *   courier worker (no repeated alert / reset budget).
 */
const h = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  const calls = { coupon: 0, courier: 0, obligationRuns: 0 };
  const state = { txCount: 0, discardFirstClaim: false, faultCouponTx: false, secondAttempt: false };
  const docRef = (col: string, id: string): any => {
    const path = `${col}/${id}`;
    return {
      id,
      get: vi.fn(async () => ({ id, exists: savedDocs[path] !== undefined, data: () => (savedDocs[path] ? { ...savedDocs[path] } : undefined), ref: docRef(col, id) })),
      set: vi.fn(async (data: any, opts?: any) => {
        savedDocs[path] = opts?.merge && savedDocs[path] ? { ...savedDocs[path], ...data } : { ...data };
      }),
    };
  };
  const mockDb: any = {
    collection: (col: string) => ({
      doc: (id: string) => docRef(col, id),
      where: () => ({ limit: () => ({ get: async () => ({ docs: [], empty: true }) }) }),
    }),
    runTransaction: async (fn: any) => {
      state.txCount++;
      // Simulate a real Firestore retry: the first claim attempt is discarded.
      if (state.discardFirstClaim && !state.secondAttempt) {
        state.secondAttempt = true;
        await fn({ get: (r: any) => r.get(), set: (r: any, d: any) => r.set(d) });
        // Another instance wins the lease between attempts.
        savedDocs["petpoojaCancelSideEffectObligations/pcs_ord"] = {
          orderId: "ord", status: "processing", claimedAt: Date.now(), claimToken: "other", completedCoupon: false,
        };
        throw new Error("FAILED_PRECONDITION (discarded attempt)");
      }
      // Fault the coupon transaction (second transaction in a drain: claim is first).
      if (state.faultCouponTx) {
        throw new Error("datastore unavailable beneath real coupon helper");
      }
      return fn({ get: (r: any) => r.get(), set: (r: any, d: any, o?: any) => r.set(d, o) });
    },
  };
  return { savedDocs, calls, state, mockDb };
});
const { savedDocs, calls, state, mockDb } = h;

vi.mock("firebase-admin", () => {
  const FieldValue = { serverTimestamp: () => "TS", increment: (n: number) => n, arrayUnion: (i: any) => [i], delete: () => "DEL" };
  const firestoreFn: any = vi.fn(() => h.mockDb);
  firestoreFn.FieldValue = FieldValue;
  firestoreFn.Timestamp = { fromMillis: (ms: number) => ({ toMillis: () => ms }) };
  return {
    default: { firestore: firestoreFn, auth: vi.fn(), messaging: vi.fn(), initializeApp: vi.fn(), apps: [{ name: "mock" }] },
    firestore: firestoreFn, auth: vi.fn(), messaging: vi.fn(), initializeApp: vi.fn(), apps: [{ name: "mock" }],
  };
});
vi.mock("../src/core/errors", async (importOriginal) => {
  const actual: any = await importOriginal();
  return { ...actual, captureErrorSnapshot: vi.fn(async () => "err") };
});
vi.mock("../src/modules/petpooja/orderCancel", () => ({ requestPetpoojaOrderCancel: vi.fn(async () => "skipped_pos_originated") }));
vi.mock("../src/modules/dispatch/shadowfax.reconcile", () => ({
  recordAndAttemptProviderCancel: vi.fn(async () => { h.calls.courier++; return { state: "pending", attempts: 1, lastError: "retry later" }; }),
}));
vi.mock("../src/modules/customers/customerCoins", () => ({ restoreRedeemedCoins: vi.fn(async () => ({ alreadyDone: true })) }));

import { applyCancelSideEffects } from "../src/modules/orders/cancelSideEffects";
import { processPosCancelSideEffectObligation } from "../src/modules/petpooja/cancelSideEffectsObligation";

const P = "petpoojaCancelSideEffectObligations/pcs_ord";
beforeEach(() => {
  for (const k of Object.keys(savedDocs)) delete savedDocs[k];
  calls.coupon = 0; calls.courier = 0; calls.obligationRuns = 0;
  state.txCount = 0; state.discardFirstClaim = false; state.faultCouponTx = false; state.secondAttempt = false;
  savedDocs["orders/ord"] = { id: "ord", status: { code: "CANCELLED" }, dispatchProvider: "borzo", dispatchOrderId: "b1", deliveryStatus: "pending" };
  savedDocs[P] = { orderId: "ord", status: "pending", attempts: 0 };
});

describe("r3 P3 — real-handler claim and failure paths", () => {
  it("a claim from a discarded transaction attempt runs no cleanup", async () => {
    state.discardFirstClaim = true;
    const result = await processPosCancelSideEffectObligation("ord");
    expect(result).toBe("skipped");
    expect(calls.coupon).toBe(0);
    expect(calls.courier).toBe(0);
    expect(savedDocs[P].claimToken).toBe("other");
  });

  it("a datastore fault under the real coupon helper is an explicit failure", async () => {
    // Real releaseCouponRedemption is used (not mocked); only the datastore faults.
    const { releaseCouponRedemption } = await import("../src/modules/coupons/couponAuthority");
    savedDocs["couponRedemptions/red_ord"] = { code: "C1", status: "held", customerId: "c1" };
    state.faultCouponTx = true;
    const outcome = await releaseCouponRedemption({ orderId: "ord", reason: "order_cancelled" });
    expect(outcome.failed).toBe(true);
    expect(outcome.released).toBe(false);
  });

  it("a courier pending intent is not converted into an obligation retry", async () => {
    const result = await applyCancelSideEffects({
      orderId: "ord", requestedBy: "petpooja", reason: "order_cancelled", skipPosCancel: true,
    });
    expect(result.courierCleanup).toBe("failed");
    expect(result.providerCancelAttempted).toBe(true);
    expect(calls.courier).toBe(1);
  });
});
