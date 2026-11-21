import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * F2 (staging 2026-11-21, Test 9): a staff "close" flips `stores/demo.isOpen`
 * to false and the customer store card says "Closed", but the SERVER kept
 * minting gateway orders and kept creating cash orders for the closed outlet.
 *
 * Rule pinned here: for a CLOSED storefront (`stores|admin_stores.isOpen`
 * false) every NEW ONLINE CUSTOMER order is refused with a typed 409
 * `STORE_CLOSED` and customer-safe copy, in
 *   - POST /checkout/fees,
 *   - createPaymentOrder, and
 *   - createCashOrder.
 *
 * A staff walk-in counter sale is NOT an online customer order: it must keep
 * working while the shopfront is closed (people still walk in while the
 * kitchen is winding down), so `createWalkIn` stays allowed.
 */

const h = vi.hoisted(() => {
  process.env.BURGONOMICS_ENV = "dev";
  const docs = new Map<string, any>();
  const copy = (v: any) => (v === undefined ? undefined : structuredClone(v));
  const apply = (path: string, data: any, merge?: boolean) => {
    docs.set(path, merge ? { ...(docs.get(path) ?? {}), ...copy(data) } : copy(data));
  };
  const ref = (collection: string, id: string) => ({
    id,
    path: `${collection}/${id}`,
    get: async () => ({
      exists: docs.has(`${collection}/${id}`),
      id,
      data: () => copy(docs.get(`${collection}/${id}`)),
    }),
    set: async (data: any, options?: { merge?: boolean }) =>
      apply(`${collection}/${id}`, data, options?.merge),
    update: async (data: any) => apply(`${collection}/${id}`, data, true),
    create: async (data: any) => {
      if (docs.has(`${collection}/${id}`)) throw new Error("already exists");
      apply(`${collection}/${id}`, data, false);
    },
  });
  const nested = (d: any, f: string) =>
    f.split(".").reduce((o: any, k) => (o == null ? undefined : o[k]), d);
  const db: any = {
    collection: (name: string) => {
      const filters: Array<[string, any]> = [];
      const q: any = {
        where: (f: string, _o: string, v: any) => {
          filters.push([f, v]);
          return q;
        },
        limit: () => q,
        get: async () => {
          const found = [...docs.entries()]
            .filter(([p]) => p.startsWith(`${name}/`))
            .filter(([, d]) => filters.every(([f, v]) => nested(d, f) === v))
            .map(([p, d]) => ({
              id: p.slice(name.length + 1),
              data: () => copy(d),
              ref: ref(name, p.slice(name.length + 1)),
            }));
          return { empty: found.length === 0, docs: found };
        },
        doc: (id: string) => ref(name, id),
      };
      return q;
    },
    getAll: async (...refs: any[]) =>
      refs.map((r: any) => ({
        id: r.id,
        exists: docs.has(r.path),
        data: () => copy(docs.get(r.path)),
        ref: r,
      })),
    runTransaction: async (cb: (tx: any) => Promise<any>) => {
      const pending: Array<() => void> = [];
      const result = await cb({
        get: async (r: any) => r.get(),
        set: (r: any, data: any, o?: { merge?: boolean }) => pending.push(() => apply(r.path, data, o?.merge)),
        create: (r: any, data: any) => {
          if (docs.has(r.path)) throw new Error("already exists");
          pending.push(() => apply(r.path, data, false));
        },
        update: (r: any, data: any) => pending.push(() => apply(r.path, data, true)),
      });
      for (const w of pending) w();
      return result;
    },
  };
  return { docs, db, reset: () => docs.clear() };
});

vi.mock("../src/core/firebase", () => ({ db: h.db }));
vi.mock("firebase-admin", () => {
  const firestore: any = vi.fn(() => h.db);
  firestore.FieldValue = {
    serverTimestamp: () => "SERVER_TS",
    increment: (n: number) => n,
    arrayUnion: (i: any) => [i],
    delete: () => "DELETE",
  };
  return {
    default: { firestore: vi.fn(() => h.db), auth: vi.fn(() => ({})), initializeApp: vi.fn(), apps: [{ name: "mock" }] },
    firestore,
    auth: vi.fn(() => ({})),
    initializeApp: vi.fn(),
    apps: [{ name: "mock" }],
  };
});

import { resolveCheckoutFees } from "../src/modules/payments/checkoutFees";
import { createCashOrder } from "../src/modules/orders/createCashOrder";
import { createWalkIn } from "../src/modules/orders/createWalkIn";
import { createPaymentOrder } from "../src/modules/payments/razorpay.service";
import { config } from "../src/config/env";
import { clearBranchPricingCache } from "../src/modules/payments/branchPricing";

const STORE = "demo";
const BRANCH = "branch_demo";
const CUSTOMER = "cust_closed_probe";

let prevMockGateway: boolean;

function seedWorld(isOpen: boolean) {
  h.docs.set(`stores/${STORE}`, { id: STORE, name: "Burgonomics DEMO", partnerBranchId: BRANCH, isOpen });
  h.docs.set(`branches/${BRANCH}`, {
    name: "Burgonomics DEMO",
    city: "Ahmedabad",
    packagingFee: 0,
    cashOnDelivery: { enabled: true, maxOrderValuePaise: 500000 },
    monthlyFee: 2000,
  });
  h.docs.set("products/p1", {
    name: "2 Jr. Hero Burger",
    branchId: BRANCH,
    price: 109,
    inStock: true,
  });
  h.docs.set(`admins/staff_demo`, { role: "branch_owner", branchIds: [BRANCH] });
  h.docs.set("admins/brand_admin", { role: "brand_owner", branchIds: [] });
}

const cashInput = (orderId: string, over: Record<string, any> = {}) => ({
  orderId,
  storeId: STORE,
  orderType: "takeaway" as const,
  items: [{ productId: "p1", quantity: 1 }],
  expectedTotalPaise: 10900,
  ...over,
});

/**
 * The order document the customer app writes before Razorpay opens: online,
 * pending, owned by this customer, pointing at the storefront under test.
 */
function seedOrderForPayment(orderId: string) {
  h.docs.set(`orders/${orderId}`, {
    id: orderId,
    customerId: CUSTOMER,
    userId: CUSTOMER,
    storeId: STORE,
    orderType: "takeaway",
    payment: { method: "online", status: "pending" },
    paymentStatus: "pending",
    status: { code: "PLACED", label: "Order placed", kind: "upcoming", terminal: false },
    items: [{ id: "p1", productId: "p1", name: "2 Jr. Hero Burger", price: 109, quantity: 1 }],
  });
}

beforeEach(() => {
  h.reset();
  clearBranchPricingCache();
  seedWorld(true);
  prevMockGateway = config.mock.paymentGateway;
  config.mock.paymentGateway = true;
});

describe("F2 — a closed outlet refuses new ONLINE customer orders", () => {
  it("POST /checkout/fees refuses with STORE_CLOSED (no live COD offer)", async () => {
    seedWorld(false);
    clearBranchPricingCache();
    await expect(
      resolveCheckoutFees({ storeId: STORE, orderType: "takeaway", customerId: CUSTOMER })
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "STORE_CLOSED",
      message: expect.stringMatching(/closed/i),
    });
  });

  it("POST /checkout/fees still answers for an open outlet", async () => {
    await expect(
      resolveCheckoutFees({ storeId: STORE, orderType: "takeaway", customerId: CUSTOMER })
    ).resolves.toMatchObject({ serviceable: true, packagingFee: 0 });
  });

  it("createCashOrder refuses a closed outlet instead of creating the order", async () => {
    seedWorld(false);
    await expect(createCashOrder(CUSTOMER, cashInput("qa_f2_cash_closed"))).rejects.toMatchObject({
      statusCode: 409,
      code: "STORE_CLOSED",
    });
    expect(h.docs.has("orders/qa_f2_cash_closed")).toBe(false);
  });

  it("createCashOrder still works while the outlet is open", async () => {
    const receipt = await createCashOrder(CUSTOMER, cashInput("qa_f2_cash_open"));
    expect(receipt).toMatchObject({ paymentChannel: "cash", cashDuePaise: 10900 });
  });

  it("createPaymentOrder never mints a gateway order for a closed outlet", async () => {
    const orderId = "ord_f2_closed";
    seedOrderForPayment(orderId);
    seedWorld(false);

    const err: any = await createPaymentOrder({
      orderId,
      items: [{ id: "p1", productId: "p1", name: "x", price: 1, quantity: 1 }],
      orderType: "takeaway",
      customerId: CUSTOMER,
      idempotencyKey: "qa_f2_closed_pay",
    } as any).then(
      () => null,
      (e) => e
    );
    expect(err).toMatchObject({ statusCode: 409, code: "STORE_CLOSED" });
    expect(err.unexpectedSuccess).toBeUndefined();
    // Nothing payable was minted and no intent was written.
    expect([...h.docs.keys()].filter((k) => k.startsWith("payment_intents/"))).toHaveLength(0);
  });

  it("createPaymentOrder never mints a gateway order for a closed outlet", async () => {
    const orderId = "ord_f2_closed";
    seedOrderForPayment(orderId);
    seedWorld(false);

    const err: any = await createPaymentOrder({
      orderId,
      items: [{ id: "p1", productId: "p1", name: "x", price: 1, quantity: 1 }],
      orderType: "takeaway",
      customerId: CUSTOMER,
      idempotencyKey: "qa_f2_closed_pay",
    } as any).then(
      () => null,
      (e) => e
    );
    expect(err).toMatchObject({ statusCode: 409, code: "STORE_CLOSED" });
    expect(err.unexpectedSuccess).toBeUndefined();
    // Nothing payable was minted and no intent was written.
    expect([...h.docs.keys()].filter((k) => k.startsWith("payment_intents/"))).toHaveLength(0);
  });

  it("createPaymentOrder still mints a gateway order while the outlet is open", async () => {
    const orderId = "ord_f2_open";
    seedOrderForPayment(orderId);
    const res: any = await createPaymentOrder({
      orderId,
      items: [{ id: "p1", productId: "p1", name: "x", price: 1, quantity: 1 }],
      orderType: "takeaway",
      customerId: CUSTOMER,
      idempotencyKey: "qa_f2_open_pay",
    } as any);
    expect(res.razorpayOrderId).toBeTruthy();
    expect(res.amountPaise).toBe(10900);
  });

  it("staff walk-in counter sales stay allowed while the outlet is closed", async () => {
    seedWorld(false);
    const receipt = await createWalkIn("staff_demo", {
      requestId: "qa_f2_walkin_closed",
      branchId: BRANCH,
      orderType: "takeaway",
      tender: "cash",
      items: [{ productId: "p1", quantity: 1 }],
      expectedTotalPaise: 10900,
    });
    expect(receipt).toMatchObject({ status: { code: "PLACED" }, branchId: BRANCH });
  });
});
