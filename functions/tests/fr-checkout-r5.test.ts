import { beforeEach, describe, expect, it, vi } from "vitest";
import { COUPON_OBLIGATION_HOLD_MS } from "../src/modules/coupons/couponAuthority";
import { drainCouponObligations, type GatewayCheck } from "../src/modules/coupons/couponObligationWorker";

/**
 * r5: a gateway-bound slot is held past the intent TTL until the worker proves
 * the Razorpay order is NON-CAPTURABLE. Deterministic interleaving: the provider
 * response is injected (no live calls), the clock is injected, and the release
 * is fenced on the verified binding.
 */
const h = vi.hoisted(() => {
  process.env.BURGONOMICS_ENV = "dev";
  const docs = new Map<string, any>();
  const DEL = "__DEL__";
  const copy = (v: any) => (v === undefined ? undefined : structuredClone(v));
  const apply = (path: string, data: any, merge?: boolean) => {
    const next: any = merge ? { ...(docs.get(path) ?? {}), ...copy(data) } : copy(data);
    for (const [k, v] of Object.entries(next)) if (v === DEL) delete next[k];
    docs.set(path, next);
  };
  const ref = (collection: string, id: string) => ({
    id,
    path: `${collection}/${id}`,
    get: async () => ({ exists: docs.has(`${collection}/${id}`), id, data: () => copy(docs.get(`${collection}/${id}`)) }),
    set: async (data: any, o?: { merge?: boolean }) => apply(`${collection}/${id}`, data, o?.merge),
    create: async (data: any) => { if (docs.has(`${collection}/${id}`)) throw new Error("exists"); apply(`${collection}/${id}`, data, false); },
    update: async (data: any) => apply(`${collection}/${id}`, data, true),
  });
  const query = (name: string) => {
    const q: any = {
      value: undefined as any,
      after: "",
      where(_f: string, _o: string, v: any) { q.value = v; return q; },
      orderBy() { return q; },
      startAfter(a: string) { q.after = a; return q; },
      limit(n: number) {
        return { get: async () => ({ docs: [...docs.entries()]
          .filter(([p, d]) => p.startsWith(`${name}/`) && (q.value === undefined || d?.status === q.value))
          .filter(([p]) => p.slice(name.length + 1) > q.after)
          .sort(([a], [b]) => a.localeCompare(b)).slice(0, n)
          .map(([p, d]) => ({ id: p.slice(name.length + 1), data: () => copy(d) })) }) };
      },
    };
    return q;
  };
  const collection = (name: string) => ({
    doc: (id: string) => ref(name, id),
    where: (f: string, o: string, v: any) => query(name).where(f, o, v),
  });
  const db: any = {
    collection,
    runTransaction: async (cb: any) => {
      const pending: Array<() => void> = [];
      let wrote = false;
      const tx = {
        get: async (r: any) => { if (wrote) throw new Error("READ_AFTER_WRITE"); return r.get(); },
        set: (r: any, d: any, o?: any) => { wrote = true; pending.push(() => apply(r.path, d, o?.merge)); },
        create: (r: any, d: any) => { wrote = true; pending.push(() => apply(r.path, d, false)); },
        update: (r: any, d: any) => { wrote = true; pending.push(() => apply(r.path, d, true)); },
      };
      const out = await cb(tx);
      for (const w of pending) w();
      return out;
    },
  };
  return { docs, db, DEL };
});

vi.mock("../src/core/firebase", () => ({ db: h.db }));
vi.mock("firebase-admin", () => {
  const firestore: any = vi.fn(() => h.db);
  firestore.FieldValue = { serverTimestamp: () => "TS", delete: () => h.DEL, increment: (n: number) => n };
  return { default: { firestore: vi.fn(() => h.db), auth: vi.fn(() => ({})), initializeApp: vi.fn(), apps: [{ name: "mock" }] }, firestore, auth: vi.fn(() => ({})), initializeApp: vi.fn(), apps: [{ name: "mock" }] };
});

const NOW = Date.UTC(2026, 10, 23);
function seed(gateway = "rzp_abandoned") {
  const old = NOW - COUPON_OBLIGATION_HOLD_MS - 7_200_000;
  h.docs.set("coupons/R5", { code: "R5", committed: 0, reservations: {} });
  h.docs.set("coupon_customer_usage/R5__cust", { code: "R5", customerId: "cust", committed: 0, reservations: {} });
  h.docs.set("coupon_redemptions/ord", { code: "R5", orderId: "ord", customerId: "cust", status: "reserved", gatewayOrderId: gateway, version: 1, expiresAtMs: old + COUPON_OBLIGATION_HOLD_MS, paymentIntentId: "pi" });
  h.docs.set("coupon_obligations/ord", { orderId: "ord", gatewayOrderId: gateway, slotId: "ord", version: 1, code: "R5", customerId: "cust", status: "pending", createdAtMs: old });
  h.docs.set("coupon_gateway_bindings/" + gateway, { orderId: "ord", slotId: "ord", gatewayOrderId: gateway, version: 1, code: "R5", customerId: "cust" });
  h.docs.set("orders/ord", { paymentStatus: "pending", payment: { status: "pending" }, status: { code: "PLACED" } });
}

const verifier = (state: GatewayCheck["state"]): ((g: string) => Promise<GatewayCheck>) =>
  async (g) => ({ state, gatewayOrderId: g, checkedAtMs: NOW });

beforeEach(() => h.docs.clear());

describe("r5 post-TTL gateway verification", () => {
  it("releases an abandoned slot ONCE after a verified non-capturable gateway", async () => {
    seed();
    const v = verifier("non_capturable");
    const first = await drainCouponObligations(10, { nowMs: NOW, gatewayVerifier: v });
    expect(first.released).toBe(1);
    expect(h.docs.get("coupon_redemptions/ord").status).toBe("released");
    expect(h.docs.get("coupon_obligations/ord").status).toBe("released");
    const second = await drainCouponObligations(10, { nowMs: NOW, gatewayVerifier: v });
    expect(second.released).toBe(0);
  });

  it("does NOT release when a late authorised payment is found", async () => {
    seed();
    const result = await drainCouponObligations(10, { nowMs: NOW, gatewayVerifier: verifier("capturable") });
    expect(result.released).toBe(0);
    expect(result.flagged).toBe(1);
    expect(h.docs.get("coupon_redemptions/ord").status).toBe("reserved");
    expect(h.docs.get("coupon_obligations/ord").status).toBe("pending");
  });

  it("keeps the hold and flags when the provider errors", async () => {
    seed();
    const boom = async () => { throw new Error("provider 500"); };
    const result = await drainCouponObligations(10, { nowMs: NOW, gatewayVerifier: boom });
    expect(result.released).toBe(0);
    expect(result.flagged).toBe(1);
    expect(h.docs.get("coupon_redemptions/ord").status).toBe("reserved");
  });

  it("holds without calling the provider before TTL plus the safety margin", async () => {
    seed();
    const spy = vi.fn(verifier("non_capturable"));
    const result = await drainCouponObligations(10, { nowMs: NOW - COUPON_OBLIGATION_HOLD_MS + 1_000, gatewayVerifier: spy });
    expect(spy).not.toHaveBeenCalled();
    expect(result.released).toBe(0);
  });
});
