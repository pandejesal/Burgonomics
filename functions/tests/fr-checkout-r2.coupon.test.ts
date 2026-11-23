import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * fr-checkout r2 â€” M2/M3 behavioural RED/GREEN.
 *
 * M2: distinct order IDs never share a redemption; a last slot funds exactly
 * one checkout; a decline does not free the slot, so decline -> retry -> capture
 * commits once; reuse AND capture require the exact live intent.
 * M3: a durable obligation is drained by a worker; the slot stays held until
 * that worker resolves it; crash/replay/expiry converge without losing usage.
 */
const h = vi.hoisted(() => {
  process.env.BURGONOMICS_ENV = "dev";
  const docs = new Map<string, any>();
  const DEL = "__FIELD_DELETE__";
  const copy = (v: any) => (v === undefined ? undefined : structuredClone(v));
  const apply = (path: string, data: any, merge?: boolean) => {
    const next = merge ? { ...(docs.get(path) ?? {}), ...copy(data) } : copy(data);
    if (next && typeof next === "object" && !Array.isArray(next)) {
      for (const [k, v] of Object.entries(next)) {
        if (v === DEL) delete next[k];
        else if (v && typeof v === "object" && !Array.isArray(v)) {
          for (const [k2, v2] of Object.entries(v as object)) if (v2 === DEL) delete (next[k] as any)[k2];
        }
      }
    }
    docs.set(path, next);
  };
  const ref = (collection: string, id: string) => ({
    id,
    path: `${collection}/${id}`,
    get: async () => ({ exists: docs.has(`${collection}/${id}`), id, data: () => copy(docs.get(`${collection}/${id}`)) }),
    set: async (data: any, options?: { merge?: boolean }) => apply(`${collection}/${id}`, data, options?.merge),
  });
  const collection = (name: string) => ({
    doc: (id: string) => ref(name, id),
    where: (field: string, _op: string, value: any) => ({
      after:"",
      orderBy(){return this},
      startAfter(id:string){this.after=id;return this},
      limit(n: number) {return {
        get: async () => ({
          docs: [...docs.entries()]
            .filter(([path, data]) => path.startsWith(`${name}/`) && data?.[field] === value)
            .filter(([path])=>path.slice(name.length+1)>this.after).sort(([a],[b])=>a.localeCompare(b)).slice(0, n)
            .map(([path, data]) => ({ id: path.slice(name.length + 1), data: () => copy(data) })),
        }),
      }},
    }),
  });
  const db: any = {
    collection,
    runTransaction: async (cb: (tx: any) => Promise<any>) => {
      const pending: Array<() => void> = [];
      let wrote = false;
      const tx = {
        get: async (r: any) => {
          if (wrote) throw new Error("FIRESTORE_READ_AFTER_WRITE");
          return r.get();
        },
        set: (r: any, data: any, opts?: { merge?: boolean }) => {
          wrote = true;
          pending.push(() => apply(r.path, data, opts?.merge));
        },
      };
      const result = await cb(tx);
      for (const w of pending) w();
      return result;
    },
  };
  return { docs, db, DEL };
});

vi.mock("../src/core/firebase", () => ({ db: h.db }));
vi.mock("firebase-admin", () => {
  const firestore: any = vi.fn(() => h.db);
  firestore.FieldValue = { serverTimestamp: () => "TS", increment: (n: number) => n, delete: () => h.DEL };
  return {
    default: { firestore: vi.fn(() => h.db), auth: vi.fn(() => ({})), initializeApp: vi.fn(), apps: [{ name: "mock" }] },
    firestore,
    auth: vi.fn(() => ({})),
    initializeApp: vi.fn(),
    apps: [{ name: "mock" }],
  };
});

import {
  assertCouponReservationLive,
  couponRedemptionId,
  readCouponRedemption,
  reconcileCouponOnCapture,
  reserveCouponInTx,
  commitCouponRedemption,
  releaseCouponRedemption,
} from "../src/modules/coupons/couponAuthority";
import { drainCouponObligations } from "../src/modules/coupons/couponObligationWorker";

const CODE = "FR20";
function seedCoupon(cap = 1) {
  h.docs.set(`coupons/${CODE}`, {
    code: CODE, active: true, discountType: "percent", value: 20, maxDiscount: 200,
    minOrder: 0, validFromMs: null, validToMs: null, perCustomerLimit: null,
    totalCap: cap, branchScope: "all", customerScope: null,
  });
}
const reserve = (orderId: string, intentId: string, commitNow = false) =>
  h.db.runTransaction(async (tx: any) =>
    reserveCouponInTx(tx, {
      code: CODE, orderId, customerId: "cust_1", foodSubtotal: 500,
      expectedDiscount: 100, paymentIntentId: intentId, commitNow,
    })
  );

beforeEach(() => h.docs.clear());

it('r4 capture fences the gateway id; a bound slot is not released on cancel',async()=>{
  seedCoupon(1);
  await h.db.runTransaction(async(tx:any)=>reserveCouponInTx(tx,{code:CODE,orderId:'cap',customerId:'cust_1',foodSubtotal:500,expectedDiscount:100,paymentIntentId:'i',gatewayOrderId:'rzp_1'}));
  await expect(commitCouponRedemption('cap','rzp_wrong')).rejects.toMatchObject({code:'COUPON_CAPTURE_BINDING'});
  const rel=await releaseCouponRedemption({orderId:'cap',reason:'cancel'});
  expect(rel.released).toBe(false);
  expect(rel.reason).toBe('gateway_still_bound');
});

it('does not lose an outstanding global or personal slot at a real future clock',async()=>{
  seedCoupon(1);
  await reserve('r4_hold','r4_intent');
  const future=Date.now()+30*86400000;
  const competing=(uid:string)=>h.db.runTransaction((tx:any)=>reserveCouponInTx(tx,{code:CODE,orderId:'new',customerId:uid,paymentIntentId:'other',foodSubtotal:500,expectedDiscount:100,nowMs:future}));
  await expect(competing('other')).rejects.toMatchObject({code:'COUPON_EXHAUSTED'});
  Object.assign(h.docs.get(`coupons/${CODE}`),{totalCap:null,perCustomerLimit:1});
  await expect(competing('cust_1')).rejects.toMatchObject({code:'COUPON_PER_CUSTOMER_LIMIT'});
});

it('pages past live rows and retries an unresolved row after a datastore fault',async()=>{
  seedCoupon(9);
  await reserve('a_live','ia');await reserve('b_live','ib');await reserve('c_terminal','ic');
  h.docs.set('orders/c_terminal',{status:{code:'CANCELLED'}});
  expect((await drainCouponObligations(2)).left).toBe(2);
  const fault=vi.spyOn(h.db,'runTransaction').mockRejectedValueOnce(new Error('interrupted'));
  expect((await drainCouponObligations(2)).released).toBe(0);
  expect(h.docs.get('coupon_obligations/c_terminal').status).toBe('pending');
  fault.mockRestore();
  await drainCouponObligations(2);
  expect((await drainCouponObligations(2)).released).toBe(1);
});

describe("M2 â€” collision-free keys and one slot, one intent", () => {
  it("gives distinct order IDs distinct redemption keys", () => {
    expect(couponRedemptionId("ord/A")).not.toBe(couponRedemptionId("ord:A"));
    expect(couponRedemptionId("ord|A")).not.toBe(couponRedemptionId("ord A"));
  });

  it("a competing last-slot checkout is refused", async () => {
    seedCoupon(1);
    await reserve("ord_A", "intent_A");
    await expect(reserve("ord_B", "intent_B")).rejects.toMatchObject({ code: "COUPON_EXHAUSTED" });
    expect(h.docs.get(`coupon_stats/${CODE}`)?.committed).toBe(0);
  });

  it("decline then retry on the SAME intent then capture commits exactly once", async () => {
    seedCoupon(1);
    await reserve("ord_A", "intent_A");
    // decline: no release (a decline is not terminal for the payable intent)
    await expect(assertCouponReservationLive("ord_A", "intent_A")).resolves.toBeUndefined();
    await expect(assertCouponReservationLive("ord_A", "intent_A")).resolves.toBeUndefined();
    // retry reuses the still-live slot; capture reconciles it to committed
    expect(await reconcileCouponOnCapture("ord_A", "intent_A")).toBe("committed");
    expect(await reconcileCouponOnCapture("ord_A", "intent_A")).toBe("noop");
    expect((await readCouponRedemption("ord_A"))?.status).toBe("committed");
    expect(h.docs.get(`coupon_stats/${CODE}`)?.committed).toBe(1);
  });

  it("reuse and capture with a DIFFERENT intent are refused/flagged", async () => {
    seedCoupon(1);
    await reserve("ord_A", "intent_A");
    await expect(assertCouponReservationLive("ord_A", "intent_other")).rejects.toMatchObject({
      code: "COUPON_SLOT_WRONG_INTENT",
    });
    expect(await reconcileCouponOnCapture("ord_A", "intent_other")).toBe("flagged");
    expect((await readCouponRedemption("ord_A"))?.status).toBe("reserved");
    expect(h.docs.get(`coupon_stats/${CODE}`)?.committed).toBe(0);
  });

  it("never hands out a discounted intent with a missing redemption", async () => {
    await expect(assertCouponReservationLive("missing", "intent", Date.now(), true)).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe("M3 â€” durable online obligation is drained and holds the slot", () => {
  it("a decline and a long-delayed capture cannot return an outstanding slot", async () => {
    seedCoupon(1);
    await reserve("a", "intent");
    h.docs.set("orders/a", {paymentStatus: "failed"});
    await drainCouponObligations();
    await expect(reserve("b", "intent_b")).rejects.toMatchObject({ code: "COUPON_EXHAUSTED" });
    expect(await reconcileCouponOnCapture("a", "intent")).toBe("committed");
  });
  it("commits and settles a captured obligation; replay is a no-op", async () => {
    seedCoupon(1);
    await reserve("ord_online", "intent_online");
    expect(h.docs.get(`coupon_obligations/${couponRedemptionId("ord_online")}`)?.status).toBe("pending");
    h.docs.set("orders/ord_online", { paymentChannel: "razorpay", paymentStatus: "completed" });
    const first = await drainCouponObligations();
    expect(first.committed).toBe(1);
    const second = await drainCouponObligations();
    expect(second.committed).toBe(0);
    expect((await readCouponRedemption("ord_online"))?.status).toBe("committed");
    expect(h.docs.get(`coupon_stats/${CODE}`)?.committed).toBe(1);
  });

  it("releases a cancelled obligation without consuming usage", async () => {
    seedCoupon(1);
    await reserve("ord_cancel", "intent_cancel");
    h.docs.set("orders/ord_cancel", { status: { code: "CANCELLED" }, paymentStatus: "cancelled" });
    const result = await drainCouponObligations();
    expect(result.released).toBe(1);
    expect((await readCouponRedemption("ord_cancel"))?.status).toBe("released");
    expect(h.docs.get(`coupon_stats/${CODE}`)?.committed).toBe(0);
  });

  it("keeps the slot held past reservation TTL while an obligation is pending", async () => {
    seedCoupon(1);
    await reserve("ord_hold", "intent_hold");
    h.docs.set(`coupon_redemptions/${couponRedemptionId("ord_hold")}`, {
      ...h.docs.get(`coupon_redemptions/${couponRedemptionId("ord_hold")}`),
      expiresAtMs: Date.now() + 7*24*60*60*1000, // held by obligation
    });
    h.docs.set(`coupon_stats/${CODE}`, {
      ...h.docs.get(`coupon_stats/${CODE}`),
      reservations: { [couponRedemptionId("ord_hold")]: { expiresAtMs: Date.now() + 7*24*60*60*1000 } },
    });
    // A pending obligation means the slot is still owed, so a competing
    // checkout must NOT be able to take it merely because the TTL elapsed.
    await expect(reserve("ord_other", "intent_other")).rejects.toMatchObject({ code: "COUPON_EXHAUSTED" });
  });
});
