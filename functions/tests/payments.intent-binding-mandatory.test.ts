import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * P1-F — EXPLOIT: pay for order A, confirm order B.
 *
 * Attack (all steps reachable before this fix):
 *  1. `createPaymentOrder` with NO `idempotencyKey` mints a cheap gateway order
 *     A and writes NO server intent.
 *  2. The caller owns an expensive internal order B whose doc carries no
 *     `pricing`/`totals` (the rules allow a doc without totals).
 *  3. `verifyPayment({ orderId: B, razorpayOrderId: A, razorpayPaymentId,
 *     signature })`: nothing binds A to B, `expectedPaise` is null, so the live
 *     amount check is SKIPPED, the capture claim binds the payment to B, and B
 *     is confirmed — expensive food at A's price, pushed to the KOT as PAID.
 *
 * Pinned here:
 *  - verify REQUIRES a durable server intent that names BOTH the internal order
 *    and the exact gateway order (no intent → refused; mismatch → refused);
 *  - the amount compared is the AUTHORITATIVE server intent amount (never the
 *    optional order-doc total), and the gateway payment's own `order_id` must
 *    agree with the claimed gateway order;
 *  - the blind legacy "amount unknown → skip the check" path is gone;
 *  - `idempotencyKey` is server-generated when omitted, so no payable gateway
 *    order can exist without an intent.
 */
const { mockDb, docs, control, snapshots, writeLog } = vi.hoisted(() => {
  process.env.OTP_HMAC_SECRET = "test_otp_p1f";

  const docs = new Map<string, any>();
  const snapshots: any[] = [];
  const writeLog: Array<{ path: string; data: any }> = [];
  const control = {
    payment: null as any,
    minted: [] as Array<{ id: string; amount: number }>,
    mintCounter: 0,
  };

  const applyWrite = (path: string, data: any, merge?: boolean) => {
    const existing = docs.get(path);
    const next =
      merge && existing && typeof existing === "object" && typeof data === "object"
        ? { ...existing, ...data }
        : { ...data };
    docs.set(path, next);
    writeLog.push({ path, data: next });
  };

  const docRef = (col: string, id: string) => {
    const path = `${col}/${id}`;
    return {
      id,
      path,
      get: async () => ({
        exists: docs.has(path),
        data: () =>
          docs.has(path) ? JSON.parse(JSON.stringify(docs.get(path))) : undefined,
        ref: docRef(col, id),
      }),
      set: async (data: any, opts?: any) => applyWrite(path, data, !!opts?.merge),
      create: async (data: any) => {
        if (docs.has(path)) {
          const err: any = new Error("ALREADY_EXISTS");
          err.code = 6;
          throw err;
        }
        applyWrite(path, data, false);
      },
      update: async (data: any) => applyWrite(path, data, true),
    };
  };

  const matches = (data: any, field: string, value: any) => {
    const nested = field
      .split(".")
      .reduce((o: any, k) => (o == null ? undefined : o[k]), data);
    return nested === value;
  };

  const mockDb: any = {
    collection: (col: string) => {
      const filters: Array<[string, any]> = [];
      const q: any = {
        where: (f: string, _op: string, v: any) => {
          filters.push([f, v]);
          return q;
        },
        limit: () => q,
        get: async () => {
          const found = [...docs.entries()]
            .filter(([p]) => p.startsWith(`${col}/`))
            .filter(([, d]) => filters.every(([f, v]) => matches(d, f, v)))
            .map(([p, d]) => {
              const id = p.slice(col.length + 1);
              return {
                id,
                ref: docRef(col, id),
                data: () => JSON.parse(JSON.stringify(d)),
              };
            });
          return { empty: found.length === 0, docs: found };
        },
        doc: (id: string) => docRef(col, id),
      };
      return q;
    },
    runTransaction: vi.fn(async (fn: any) => {
      const writes: Array<{ path: string; data: any; merge: boolean }> = [];
      const result = await fn({
        get: async (ref: any) => ({
          exists: docs.has(ref.path),
          data: () =>
            docs.has(ref.path)
              ? JSON.parse(JSON.stringify(docs.get(ref.path)))
              : undefined,
          ref,
        }),
        set: (ref: any, data: any, opts?: any) =>
          writes.push({ path: ref.path, data, merge: !!opts?.merge }),
        update: (ref: any, data: any) =>
          writes.push({ path: ref.path, data, merge: true }),
      });
      for (const w of writes) applyWrite(w.path, w.data, w.merge);
      return result;
    }),
  };

  return { mockDb, docs, control, snapshots, writeLog };
});

vi.mock("../src/core/firebase", () => ({ db: mockDb }));

vi.mock("firebase-admin", () => {
  const FieldValue = {
    serverTimestamp: () => "MOCK_TS",
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

vi.mock("../src/modules/payments/razorpayClient", () => ({
  getRazorpayClient: () => ({
    orders: {
      create: vi.fn(async (args: any) => {
        control.mintCounter += 1;
        const id = `order_mint_${control.mintCounter}`;
        control.minted.push({ id, amount: args.amount });
        return { id, amount: args.amount, currency: args.currency, notes: args.notes };
      }),
      fetchPayments: vi.fn(async () => ({ items: [] })),
    },
    payments: {
      fetch: vi.fn(async () => control.payment),
    },
  }),
  getRazorpayKeyId: () => "rzp_test_p1f",
}));

vi.mock("../src/core/errors", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    captureErrorSnapshot: vi.fn(async (s: any) => {
      snapshots.push(s);
      return "snap_1";
    }),
  };
});

import {
  createPaymentOrder,
  verifyPayment,
  __setPaymentsFetchForTests,
} from "../src/modules/payments/razorpay.service";
import { computeHmacSha256 } from "../src/core/security";
import { config } from "../src/config/env";

const SECRET = "p1f_secret";
/** Real Razorpay signature shape: HMAC-SHA256("<order>|<payment>", secret). */
const sign = (razorpayOrderId: string, razorpayPaymentId: string) =>
  computeHmacSha256(`${razorpayOrderId}|${razorpayPaymentId}`, SECRET);

const CHEAP_ITEMS = [
  { id: "p1", productId: "p1", name: "Water", price: 10, unitPrice: 10, quantity: 1 },
];
const EXPENSIVE_ITEMS = [
  {
    id: "p9",
    productId: "p9",
    name: "Family Feast",
    price: 2500,
    unitPrice: 2500,
    quantity: 1,
  },
];

const seedBranch = () => {
  docs.set("branches/branch_a", {
    id: "branch_a",
    name: "Branch A",
    isOpen: true,
    isAcceptingOrders: true,
    pricing: { packagingFee: 0, deliveryFee: 0, taxRate: 0 },
    items: [],
  });
  // Real catalog docs: the pricing engine refuses a line it cannot verify.
  docs.set("products/p1", {
    id: "p1",
    name: "Water",
    price: 10,
    inStock: true,
    customizations: [],
  });
  docs.set("products/p9", {
    id: "p9",
    name: "Family Feast",
    price: 2500,
    inStock: true,
    customizations: [],
  });
};

/** An owned expensive order with NO totals — exactly what the rules allow. */
const seedExpensiveOrderWithoutTotals = (orderId: string) => {
  docs.set(`orders/${orderId}`, {
    id: orderId,
    customerId: "cust_1",
    userId: "cust_1",
    branchId: "branch_a",
    orderType: "takeaway",
    fulfillmentType: "takeaway",
    payment: { method: "online", status: "pending" },
    paymentStatus: "pending",
    status: { code: "PLACED", label: "Order placed", kind: "upcoming", terminal: false },
    items: EXPENSIVE_ITEMS,
  });
};

/**
 * A payable order doc for the CHEAP cart. `createPaymentOrder` refuses to mint
 * for an order that does not exist / is already paid / belongs to someone
 * else, so the attack's first step needs a real owned doc too.
 */
const seedCheapOrder = (orderId: string) => {
  docs.set(`orders/${orderId}`, {
    id: orderId,
    customerId: "cust_1",
    userId: "cust_1",
    branchId: "branch_a",
    orderType: "takeaway",
    fulfillmentType: "takeaway",
    payment: { method: "online", status: "pending" },
    paymentStatus: "pending",
    status: { code: "PLACED", label: "Order placed", kind: "upcoming", terminal: false },
    items: CHEAP_ITEMS,
  });
};

const livePayment = (over: Record<string, any> = {}) => ({
  id: "pay_1",
  order_id: "order_mint_1",
  amount: 1000,
  currency: "INR",
  status: "captured",
  notes: { orderId: "ord_cheap" },
  ...over,
});

describe("P1-F — a verify must bind the EXACT internal order to the EXACT gateway order", () => {
  const prevMock = config.mock.paymentGateway;
  const prevKeySecret = config.razorpay.keySecret;
  beforeEach(() => {
    docs.clear();
    writeLog.length = 0;
    snapshots.length = 0;
    control.minted.length = 0;
    control.mintCounter = 0;
    // Live-shaped money path: the gateway truth path is the one under test.
    config.mock.paymentGateway = false;
    config.razorpay.keySecret = SECRET;
    seedBranch();
  });
  afterEach(() => {
    config.mock.paymentGateway = prevMock;
    config.razorpay.keySecret = prevKeySecret;
    __setPaymentsFetchForTests(null);
  });

  it("REFUSES the exploit: cheap order A's capture against expensive order B", async () => {
    // 1. Cheap gateway order WITHOUT an idempotency key.
    seedCheapOrder("ord_cheap");
    const cheapOrder: any = await createPaymentOrder({
      orderId: "ord_cheap",
      items: CHEAP_ITEMS as any,
      branchId: "branch_a",
      orderType: "takeaway",
      customerId: "cust_1",
    } as any);
    const gatewayOrderId = cheapOrder.razorpayOrderId;
    expect(gatewayOrderId).toBeTruthy();

    // 2. The caller's own expensive order, with no stored totals.
    seedExpensiveOrderWithoutTotals("ord_expensive");

    // 3. Verify A's capture against B.
    control.payment = livePayment({ order_id: gatewayOrderId, amount: 1000 });
    __setPaymentsFetchForTests(async () => control.payment);

    const err: any = await verifyPayment(
      {
        orderId: "ord_expensive",
        razorpayOrderId: gatewayOrderId,
        razorpayPaymentId: "pay_1",
        razorpaySignature: sign(gatewayOrderId, "pay_1"),
      },
      { uid: "cust_1" }
    ).then(
      (r) => ({ unexpectedSuccess: r }),
      (e) => e
    );

    expect(err.unexpectedSuccess).toBeUndefined();
    expect(err.code).toBe("ORDER_MISMATCH");
    expect(err.statusCode).toBe(409);

    // The expensive order must NOT be confirmed, and no KOT/paid marker written.
    const expensive = docs.get("orders/ord_expensive");
    expect(expensive.paymentStatus).toBe("pending");
    expect(expensive.paymentChannel).toBeUndefined();
    expect(expensive.petpoojaOrderId).toBeUndefined();
    expect(expensive.status).toMatchObject({ code: "PLACED" });
  });

  it("still confirms the REAL checkout: intent binds the same internal + gateway order", async () => {
    seedExpensiveOrderWithoutTotals("ord_real");
    const created: any = await createPaymentOrder({
      orderId: "ord_real",
      items: EXPENSIVE_ITEMS as any,
      branchId: "branch_a",
      orderType: "takeaway",
      customerId: "cust_1",
    } as any);
    docs.set("orders/ord_real", {
      id: "ord_real",
      customerId: "cust_1",
      userId: "cust_1",
      branchId: "branch_a",
      orderType: "takeaway",
      fulfillmentType: "takeaway",
      payment: { method: "online", status: "pending" },
      paymentStatus: "pending",
      status: { code: "PLACED", label: "Order placed", kind: "upcoming", terminal: false },
      pricing: { grandTotal: 2500 },
    });
    control.payment = livePayment({
      order_id: created.razorpayOrderId,
      amount: created.amountPaise,
      notes: { orderId: "ord_real" },
    });
    __setPaymentsFetchForTests(async () => control.payment);

    const res: any = await verifyPayment(
      {
        orderId: "ord_real",
        razorpayOrderId: created.razorpayOrderId,
        razorpayPaymentId: "pay_1",
        razorpaySignature: sign(created.razorpayOrderId, "pay_1"),
      },
      { uid: "cust_1" }
    );

    expect(res.ok).toBe(true);
    const order = docs.get("orders/ord_real");
    expect(order.paymentStatus).toBe("completed");
    expect(order.status).toMatchObject({ code: "CONFIRMED" });
  });

  it("refuses a verify whose gateway order has NO server intent at all", async () => {
    seedExpensiveOrderWithoutTotals("ord_no_intent");
    // Notes DO name the internal order (a capture cannot be bound without a
    // server intent regardless of what the gateway echoes back).
    control.payment = livePayment({
      order_id: "order_orphan",
      amount: 250000,
      notes: { orderId: "ord_no_intent" },
    });
    __setPaymentsFetchForTests(async () => control.payment);

    const err: any = await verifyPayment(
      {
        orderId: "ord_no_intent",
        razorpayOrderId: "order_orphan",
        razorpayPaymentId: "pay_1",
        razorpaySignature: sign("order_orphan", "pay_1"),
      },
      { uid: "cust_1" }
    ).then(
      (r) => ({ unexpectedSuccess: r }),
      (e) => e
    );

    expect(err.code).toBe("ORDER_MISMATCH");
    expect(docs.get("orders/ord_no_intent").paymentStatus).toBe("pending");
  });

  it("refuses when the gateway payment's own order_id differs from the claimed gateway order", async () => {
    seedExpensiveOrderWithoutTotals("ord_bind");
    const created: any = await createPaymentOrder({
      orderId: "ord_bind",
      items: EXPENSIVE_ITEMS as any,
      branchId: "branch_a",
      orderType: "takeaway",
      customerId: "cust_1",
    } as any);
    docs.set("orders/ord_bind", {
      id: "ord_bind",
      customerId: "cust_1",
      branchId: "branch_a",
      orderType: "takeaway",
      payment: { method: "online", status: "pending" },
      paymentStatus: "pending",
      status: { code: "PLACED", label: "Order placed", kind: "upcoming", terminal: false },
      pricing: { grandTotal: 2500 },
    });
    control.payment = livePayment({
      order_id: "order_somewhere_else",
      amount: 250000,
      notes: { orderId: "ord_bind" },
    });
    __setPaymentsFetchForTests(async () => control.payment);

    const err: any = await verifyPayment(
      {
        orderId: "ord_bind",
        razorpayOrderId: created.razorpayOrderId,
        razorpayPaymentId: "pay_1",
        razorpaySignature: sign(created.razorpayOrderId, "pay_1"),
      },
      { uid: "cust_1" }
    ).then(
      (r) => ({ unexpectedSuccess: r }),
      (e) => e
    );

    expect(err.code).toBe("ORDER_MISMATCH");
    expect(docs.get("orders/ord_bind").paymentStatus).toBe("pending");
  });

  it("refuses an under-amount capture against the server intent amount", async () => {
    seedExpensiveOrderWithoutTotals("ord_under");
    const created: any = await createPaymentOrder({
      orderId: "ord_under",
      items: EXPENSIVE_ITEMS as any,
      branchId: "branch_a",
      orderType: "takeaway",
      customerId: "cust_1",
    } as any);
    // Deliberately NO pricing/totals on the doc: the intent is the authority.
    docs.set("orders/ord_under", {
      id: "ord_under",
      customerId: "cust_1",
      branchId: "branch_a",
      orderType: "takeaway",
      payment: { method: "online", status: "pending" },
      paymentStatus: "pending",
      status: { code: "PLACED", label: "Order placed", kind: "upcoming", terminal: false },
    });
    control.payment = livePayment({
      order_id: created.razorpayOrderId,
      amount: 1000, // paid 10 rupees for a 2500 rupee order
      notes: { orderId: "ord_under" },
    });
    __setPaymentsFetchForTests(async () => control.payment);

    const err: any = await verifyPayment(
      {
        orderId: "ord_under",
        razorpayOrderId: created.razorpayOrderId,
        razorpayPaymentId: "pay_1",
        razorpaySignature: sign(created.razorpayOrderId, "pay_1"),
      },
      { uid: "cust_1" }
    ).then(
      (r) => ({ unexpectedSuccess: r }),
      (e) => e
    );

    expect(err.code).toBe("AMOUNT_MISMATCH");
    expect(docs.get("orders/ord_under").paymentStatus).toBe("pending");
  });

  it("mints a server-generated intent even when the caller omits idempotencyKey", async () => {
    seedCheapOrder("ord_nokey");
    await createPaymentOrder({
      orderId: "ord_nokey",
      items: CHEAP_ITEMS as any,
      branchId: "branch_a",
      orderType: "takeaway",
      customerId: "cust_1",
    } as any);

    const intents = [...docs.keys()].filter((k) => k.startsWith("payment_intents/"));
    expect(intents).toHaveLength(1);
    const stored = docs.get(intents[0]);
    expect(stored.orderId).toBe("ord_nokey");
    expect(stored.razorpayOrderId).toBe(control.minted[0].id);
    // The intent records the SERVER-priced amount (incl. branch packaging).
    expect(stored.amountPaise).toBe(control.minted[0].amount);
    expect(stored.amountPaise).toBeGreaterThanOrEqual(1000);
  });

  it("interleaved: verify arrives BEFORE the intent write — refused, then succeeds once durable", async () => {
    // Real ordering: the gateway order exists (the client holds it) but the
    // intent write has not landed yet (crashed process / replica lag). The
    // first verify must refuse rather than confirm blind.
    seedExpensiveOrderWithoutTotals("ord_interleaved");
    docs.set("orders/ord_interleaved", {
      ...docs.get("orders/ord_interleaved"),
      pricing: { grandTotal: 2500 },
    });
    control.payment = livePayment({
      order_id: "order_mint_late",
      amount: 250000,
      notes: { orderId: "ord_interleaved" },
    });
    __setPaymentsFetchForTests(async () => control.payment);

    const first: any = await verifyPayment(
      {
        orderId: "ord_interleaved",
        razorpayOrderId: "order_mint_late",
        razorpayPaymentId: "pay_1",
        razorpaySignature: sign("order_mint_late", "pay_1"),
      },
      { uid: "cust_1" }
    ).then(
      (r) => ({ unexpectedSuccess: r }),
      (e) => e
    );
    expect(first.code).toBe("ORDER_MISMATCH");
    expect(docs.get("orders/ord_interleaved").paymentStatus).toBe("pending");

    // The durable intent lands (the createPaymentOrder retry completed).
    docs.set("payment_intents/intent_late", {
      razorpayOrderId: "order_mint_late",
      orderId: "ord_interleaved",
      amountPaise: 250000,
      branchId: "branch_a",
      customerId: "cust_1",
      createdAtMs: Date.now(),
      expiresAtMs: Date.now() + 60_000,
    });

    const second: any = await verifyPayment(
      {
        orderId: "ord_interleaved",
        razorpayOrderId: "order_mint_late",
        razorpayPaymentId: "pay_1",
        razorpaySignature: sign("order_mint_late", "pay_1"),
      },
      { uid: "cust_1" }
    );
    expect(second.ok).toBe(true);
    expect(docs.get("orders/ord_interleaved").paymentStatus).toBe("completed");
  });
});
