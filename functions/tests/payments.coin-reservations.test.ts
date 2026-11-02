import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * P1-G + P1-H — Grill Coins must be RESERVED when an intent is created, not
 * merely checked.
 *
 * Defects:
 *  P1-G: omitting `idempotencyKey` used to skip the intent write entirely, so a
 *        redemption discount applied but nothing recorded it — the coins were
 *        never debited and stayed reusable forever.
 *  P1-H: several discounted intents could be minted against ONE balance. Each
 *        was payable; at capture the debit clamped to whatever was left, so
 *        every discount stood while the balance drained to zero.
 *
 * Required: reserve transactionally at intent creation (so the same coins
 * cannot back two payable orders), release on expiry/cancel, consume on
 * capture. The customer must never receive a discount they did not pay for.
 */
const { mockDb, docs, control } = vi.hoisted(() => {
  process.env.OTP_HMAC_SECRET = "test_otp_p1h";

  const docs = new Map<string, any>();
  const control = { mintCounter: 0 };

  const applyWrite = (path: string, data: any, merge?: boolean) => {
    const existing = docs.get(path);
    const next =
      merge && existing && typeof existing === "object" && typeof data === "object"
        ? { ...existing, ...data }
        : { ...data };
    docs.set(path, next);
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
      // Real optimistic-concurrency retry domain: re-run on conflict.
      for (let attempt = 0; attempt < 8; attempt++) {
        const reads = new Map<string, string>();
        const writes: Array<{ path: string; data: any; merge: boolean }> = [];
        const result = await fn({
          get: async (ref: any) => {
            reads.set(ref.path, JSON.stringify(docs.get(ref.path) ?? null));
            return {
              exists: docs.has(ref.path),
              data: () =>
                docs.has(ref.path)
                  ? JSON.parse(JSON.stringify(docs.get(ref.path)))
                  : undefined,
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
  getRazorpayKeyId: () => "rzp_test_p1h",
}));

vi.mock("../src/core/errors", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return { ...actual, captureErrorSnapshot: vi.fn(async () => "snap_1") };
});

import { createPaymentOrder, debitRedeemedCoinsIfReserved } from "../src/modules/payments/razorpay.service";
import {
  reserveRedeemedCoins,
  releaseReservedCoins,
  availableCoinBalance,
} from "../src/modules/payments/coinReservations";
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
    // PAY-13: the money is computed from the ORDER DOCUMENT's cart.
    items: ITEMS,
    payment: { method: "online", status: "pending" },
    paymentStatus: "pending",
    status: { code: "PLACED", label: "Order placed", kind: "upcoming", terminal: false },
  });
};

const createFor = (orderId: string, coins: number, key?: string) => {
  seedOrder(orderId);
  return createPaymentOrder({
    orderId,
    items: ITEMS as any,
    branchId: "branch_a",
    orderType: "takeaway",
    customerId: "cust_1",
    loyaltyPointsToRedeem: coins,
    ...(key ? { idempotencyKey: key } : {}),
  } as any);
};

describe("P1-H — a discount must be RESERVED, not merely checked", () => {
  const prevMock = config.mock.paymentGateway;
  beforeEach(() => {
    docs.clear();
    control.mintCounter = 0;
    config.mock.paymentGateway = true;
  });
  afterEach(() => {
    config.mock.paymentGateway = prevMock;
  });

  it("refuses a SECOND discounted order that would spend coins already reserved", async () => {
    seedWorld(100);

    // First checkout reserves 80 of the customer's 100 coins.
    const first: any = await createFor("ord_a", 80);
    expect(first.razorpayOrderId).toBeTruthy();
    expect(docs.get("customers/cust_1").loyaltyPoints).toBe(100);
    expect(await availableCoinBalance("cust_1")).toBe(20);

    // Second checkout asks for 80 — only 20 are uncommitted.
    const err: any = await createFor("ord_b", 80).then(
      (r) => ({ unexpectedSuccess: r }),
      (e) => e
    );
    expect(err.unexpectedSuccess).toBeUndefined();
    expect(err.code).toBe("COINS_INSUFFICIENT");
    expect(err.statusCode).toBe(400);
    // The second checkout never becomes PAYABLE: no intent is accepted for it
    // (the gateway order it minted is stranded unpaid, never handed out).
    expect(docs.has("payment_intents/chk_ord_b")).toBe(false);
    expect(
      [...docs.keys()].filter(
        (k) => k.startsWith("payment_intents/") && docs.get(k)?.orderId === "ord_b"
      )
    ).toEqual([]);
  });

  it("interleaved: two concurrent checkouts cannot both reserve the same coins", async () => {
    seedWorld(100);
    seedOrder("ord_a");
    seedOrder("ord_b");

    const mk = (orderId: string, coins: number) =>
      createPaymentOrder({
        orderId,
        items: ITEMS as any,
        branchId: "branch_a",
        orderType: "takeaway",
        customerId: "cust_1",
        loyaltyPointsToRedeem: coins,
        idempotencyKey: `chk_${orderId}`,
      } as any).then(
        (r) => ({ ok: true as const, r }),
        (e) => ({ ok: false as const, e })
      );

    const [a, b] = await Promise.all([mk("ord_a", 80), mk("ord_b", 80)]);
    const wins = [a, b].filter((x) => x.ok);
    const losses = [a, b].filter((x) => !x.ok);

    expect(wins).toHaveLength(1);
    expect(losses).toHaveLength(1);
    expect((losses[0] as any).e.code).toBe("COINS_INSUFFICIENT");
    // Exactly ONE discounted payable order exists; the loser's gateway order
    // is stranded and its intent was never accepted.
    expect(
      [...docs.keys()].filter(
        (k) => k.startsWith("payment_intents/") && docs.get(k)?.pricing?.loyaltyDiscount === 80
      )
    ).toHaveLength(1);
    expect(await availableCoinBalance("cust_1")).toBe(20);
  });

  it("consumes the reservation on capture, so the balance actually drops", async () => {
    seedWorld(100);
    const created: any = await createFor("ord_c", 80);

    const debit = await debitRedeemedCoinsIfReserved({
      customerId: "cust_1",
      orderId: "ord_c",
      razorpayOrderId: created.razorpayOrderId,
    });

    expect(debit.debited).toBe(80);
    expect(docs.get("customers/cust_1").loyaltyPoints).toBe(20);
    expect(await availableCoinBalance("cust_1")).toBe(20);
    expect(docs.get("coin_transactions/coin_redemption_" + created.razorpayOrderId)).toBeDefined();
  });

  it("releases the reservation on expiry/cancel, returning the coins to availability", async () => {
    seedWorld(100);
    const created: any = await createFor("ord_d", 80);
    expect(await availableCoinBalance("cust_1")).toBe(20);

    await releaseReservedCoins({ razorpayOrderId: created.razorpayOrderId, reason: "expired" });

    // Never debited, and fully available again.
    expect(docs.get("customers/cust_1").loyaltyPoints).toBe(100);
    expect(await availableCoinBalance("cust_1")).toBe(100);
  });

  it("release is idempotent and never returns coins twice", async () => {
    seedWorld(100);
    const created: any = await createFor("ord_e", 80);

    await releaseReservedCoins({ razorpayOrderId: created.razorpayOrderId, reason: "expired" });
    await releaseReservedCoins({ razorpayOrderId: created.razorpayOrderId, reason: "expired" });

    expect(await availableCoinBalance("cust_1")).toBe(100);
  });

  it("a captured order after release is refunded, not silently debited (P1-C link)", async () => {
    seedWorld(100);
    const created: any = await createFor("ord_f", 80);
    await releaseReservedCoins({ razorpayOrderId: created.razorpayOrderId, reason: "expired" });

    const debit = await debitRedeemedCoinsIfReserved({
      customerId: "cust_1",
      orderId: "ord_f",
      razorpayOrderId: created.razorpayOrderId,
    });

    // The coins were already handed back; consuming them now would punish the
    // customer for a race the system caused.
    expect(debit.debited).toBe(0);
    expect(debit.reason).toBe("reservation_released");
    expect(docs.get("customers/cust_1").loyaltyPoints).toBe(100);
  });

  it("P1-G: omitting idempotencyKey still persists the redemption (no free discount)", async () => {
    seedWorld(100);
    const created: any = await createFor("ord_g", 40);

    // An intent exists for the minted gateway order and records the redemption
    // (the key is server-generated, not absent).
    const intents = [...docs.keys()].filter((k) => k.startsWith("payment_intents/"));
    expect(intents).toHaveLength(1);
    const stored = docs.get(intents[0]);
    expect(stored.razorpayOrderId).toBe(created.razorpayOrderId);
    expect(stored.orderId).toBe("ord_g");
    expect(stored.pricing.loyaltyDiscount).toBe(40);

    // And the reservation is real: the coins cannot back another order.
    expect(await availableCoinBalance("cust_1")).toBe(60);
  });
});
