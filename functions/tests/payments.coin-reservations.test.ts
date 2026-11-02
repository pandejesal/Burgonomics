import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Grill-Coins reservations are UNREACHABLE at launch (D31-D33).
 *
 * The launch customer app pins `loyaltyPointsToRedeem` to 0, and the server
 * refuses any non-zero redemption with a typed 409 before a gateway order is
 * minted. So `createPaymentOrder` can no longer reserve coins, and the whole
 * class of "one balance backs several payable discounts" defects is retired by
 * construction rather than by more reservation bookkeeping.
 *
 * This suite pins that retirement through the REAL entry point: a discounted
 * checkout is REFUSED, no reservation is ever written, and the balance is not
 * locked. The reservation module itself is kept (not half-wired) for a future,
 * explicitly enabled launch; its own arithmetic is exercised only when the flag
 * is on, and the merge-delete fix is covered where the module is used.
 */
const { mockDb, docs, control } = vi.hoisted(() => {
  process.env.OTP_HMAC_SECRET = "test_otp_coins_disabled";

  const docs = new Map<string, any>();
  const control = { mintCounter: 0 };

  const applyWrite = (path: string, data: any, merge?: boolean) => {
    const existing = docs.get(path);
    docs.set(
      path,
      merge && existing && typeof existing === "object" && typeof data === "object"
        ? { ...existing, ...data }
        : { ...data }
    );
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

  const nested = (data: any, field: string) =>
    field.split(".").reduce((o: any, k) => (o == null ? undefined : o[k]), data);

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
            .filter(([, d]) => filters.every(([f, v]) => nested(d, f) === v))
            .map(([p, d]) => {
              const id = p.slice(col.length + 1);
              return { id, ref: docRef(col, id), data: () => JSON.parse(JSON.stringify(d)) };
            });
          return { empty: found.length === 0, docs: found };
        },
        doc: (id: string) => docRef(col, id),
      };
      return q;
    },
    runTransaction: vi.fn(async (fn: any) => {
      for (let attempt = 0; attempt < 8; attempt++) {
        const reads = new Map<string, string>();
        const writes: Array<{ path: string; data: any; merge: boolean }> = [];
        const result = await fn({
          get: async (ref: any) => {
            reads.set(ref.path, JSON.stringify(docs.get(ref.path) ?? null));
            return {
              exists: docs.has(ref.path),
              data: () =>
                docs.has(ref.path) ? JSON.parse(JSON.stringify(docs.get(ref.path))) : undefined,
              ref,
            };
          },
          set: (ref: any, data: any, opts?: any) =>
            writes.push({ path: ref.path, data, merge: !!opts?.merge }),
          update: (ref: any, data: any) =>
            writes.push({ path: ref.path, data, merge: true }),
        });
        const conflicted = [...reads.entries()].some(
          ([p, v]) => JSON.stringify(docs.get(p) ?? null) !== v
        );
        if (conflicted) continue;
        for (const w of writes) applyWrite(w.path, w.data, w.merge);
        return result;
      }
      const err: any = new Error("ABORTED");
      err.code = 10;
      throw err;
    }),
  };

  return { mockDb, docs, control };
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
        return { id: `order_mint_${control.mintCounter}`, amount: args.amount };
      }),
      fetchPayments: vi.fn(async () => ({ items: [] })),
    },
    payments: { fetch: vi.fn(async () => ({ status: "captured", amount: 0 })) },
  }),
  getRazorpayKeyId: () => "rzp_test_coins_disabled",
}));

vi.mock("../src/core/errors", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return { ...actual, captureErrorSnapshot: vi.fn(async () => "snap_1") };
});

import { createPaymentOrder } from "../src/modules/payments/razorpay.service";
import { config } from "../src/config/env";

const ITEMS = [
  { id: "p1", productId: "p1", name: "Burger", price: 500, unitPrice: 500, quantity: 1 },
];

const seedWorld = (loyaltyPoints = 100) => {
  docs.set("branches/branch_a", {
    id: "branch_a",
    isOpen: true,
    isAcceptingOrders: true,
    pricing: { packagingFee: 0, deliveryFee: 0, taxRate: 0 },
    items: [],
  });
  docs.set("products/p1", { id: "p1", name: "Burger", price: 500, inStock: true, customizations: [] });
  docs.set("customers/cust_1", { id: "cust_1", loyaltyPoints });
};

const seedOrder = (orderId: string) => {
  docs.set(`orders/${orderId}`, {
    id: orderId,
    customerId: "cust_1",
    userId: "cust_1",
    branchId: "branch_a",
    orderType: "takeaway",
    items: ITEMS,
    payment: { method: "online", status: "pending" },
    paymentStatus: "pending",
    status: { code: "PLACED", label: "Order placed", kind: "upcoming", terminal: false },
  });
};

const createFor = (orderId: string, coins: number) => {
  seedOrder(orderId);
  return createPaymentOrder({
    orderId,
    items: ITEMS as any,
    branchId: "branch_a",
    orderType: "takeaway",
    customerId: "cust_1",
    loyaltyPointsToRedeem: coins,
    idempotencyKey: `chk_${orderId}`,
  } as any);
};

describe("launch: a discounted checkout is refused, no coins are held", () => {
  const prevMock = config.mock.paymentGateway;
  const prevEnabled = config.loyalty.redemptionEnabled;
  beforeEach(() => {
    docs.clear();
    control.mintCounter = 0;
    config.mock.paymentGateway = true;
    config.loyalty.redemptionEnabled = false;
  });
  afterEach(() => {
    config.mock.paymentGateway = prevMock;
    config.loyalty.redemptionEnabled = prevEnabled;
  });

  it("createPaymentOrder refuses ANY redemption with COIN_REDEMPTION_DISABLED", async () => {
    seedWorld(100);
    const err: any = await createFor("ord_a", 20).then(
      (r) => ({ unexpectedSuccess: r }),
      (e) => e
    );
    expect(err.unexpectedSuccess).toBeUndefined();
    expect(err.statusCode).toBe(409);
    expect(err.code).toBe("COIN_REDEMPTION_DISABLED");
  });

  it("no gateway order, no intent and no reservation is created by a refused redemption", async () => {
    seedWorld(100);
    await createFor("ord_b", 80).catch(() => undefined);

    expect(control.mintCounter).toBe(0);
    expect([...docs.keys()].filter((k) => k.startsWith("payment_intents/"))).toEqual([]);
    expect([...docs.keys()].filter((k) => k.startsWith("coin_reservations/"))).toEqual([]);
    expect([...docs.keys()].filter((k) => k.startsWith("coin_reservation_accounts/"))).toEqual([]);
    // The balance is untouched and nothing is locked.
    expect(docs.get("customers/cust_1").loyaltyPoints).toBe(100);
    // The order was not priced either.
    expect(docs.get("orders/ord_b").pricing).toBeUndefined();
  });

  it("the launch checkout (0 coins) is completely unaffected and prices the full amount", async () => {
    seedWorld(100);
    const res: any = await createFor("ord_c", 0);
    expect(res.razorpayOrderId).toBeTruthy();
    expect(res.pricing.loyaltyDiscount).toBe(0);
    // 500 food + 15 default packaging (no branch packagingFee configured).
    expect(res.amountPaise).toBe(51500);
    // Still no coin state anywhere on the payment path.
    expect([...docs.keys()].filter((k) => k.startsWith("coin_reservations/"))).toEqual([]);
    expect(docs.get("customers/cust_1").loyaltyPoints).toBe(100);
  });

  it("a retry of the SAME zero-coin checkout reuses the intent (normal customers)", async () => {
    seedWorld(100);
    const first: any = await createFor("ord_d", 0);
    const second: any = await createFor("ord_d", 0);
    expect(second.reused).toBe(true);
    expect(second.razorpayOrderId).toBe(first.razorpayOrderId);
    expect([...docs.keys()].filter((k) => k.startsWith("payment_intents/"))).toHaveLength(1);
  });
});
