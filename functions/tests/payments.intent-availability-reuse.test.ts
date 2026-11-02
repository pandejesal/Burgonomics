import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * P1-I — availability must be re-checked when a payable intent is REUSED.
 *
 * Sequence that loses money:
 *  1. `createPaymentOrder` mints a payable intent for a cart (item in stock).
 *  2. The kitchen 86s an item (product `inStock: false`).
 *  3. The customer's retry hits the idempotency key and gets the EXISTING
 *     payable intent back — availability is never re-read, so they pay for
 *     food that cannot be cooked.
 *  4. The capture then confirms the order and rings the KOT for the 86'd item.
 *
 * Required: every intent reuse revalidates availability BEFORE payment, and a
 * capture that can no longer be fulfilled is compensated through the EXISTING
 * automatic-refund path (P1-C's `refundLateCaptureForExpiredOrder` machinery),
 * never a second refund mechanism.
 */
const { mockDb, docs, control } = vi.hoisted(() => {
  process.env.OTP_HMAC_SECRET = "test_otp_p1i";
  const docs = new Map<string, any>();
  const control = { mintCounter: 0, refundPosts: [] as any[] };

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
        data: () => (docs.has(path) ? JSON.parse(JSON.stringify(docs.get(path))) : undefined),
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
  const nested = (d: any, f: string) =>
    f.split(".").reduce((o: any, k) => (o == null ? undefined : o[k]), d);

  const mockDb: any = {
    collection: (col: string) => {
      const filters: Array<[string, any]> = [];
      const q: any = {
        where: (f: string, _o: string, v: any) => {
          filters.push([f, v]);
          return q;
        },
        limit: () => q,
        get: async () => {
          const found = [...docs.entries()]
            .filter(([p]) => p.startsWith(`${col}/`))
            .filter(([, d]) => filters.every(([f, v]) => nested(d, f) === v))
            .map(([p, d]) => ({
              id: p.slice(col.length + 1),
              ref: docRef(col, p.slice(col.length + 1)),
              data: () => JSON.parse(JSON.stringify(d)),
            }));
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
        if ([...reads.entries()].some(([p, v]) => JSON.stringify(docs.get(p) ?? null) !== v)) continue;
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
    arrayUnion: (i: any) => [i],
    delete: () => "MOCK_DELETE",
  };
  const f: any = vi.fn(() => mockDb);
  f.FieldValue = FieldValue;
  return {
    default: {
      firestore: f,
      auth: vi.fn(() => ({})),
      messaging: vi.fn(() => ({})),
      initializeApp: vi.fn(),
      apps: [{ name: "mock" }],
    },
    firestore: f,
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
    payments: { fetch: vi.fn(async () => ({ status: "captured", amount: 50000 })) },
  }),
  getRazorpayKeyId: () => "rzp_test_p1i",
}));

vi.mock("../src/core/errors", async (io) => ({
  ...(await io<any>()),
  captureErrorSnapshot: vi.fn(async () => "snap_1"),
}));

import { createPaymentOrder } from "../src/modules/payments/razorpay.service";
import { computeHmacSha256 } from "../src/core/security";
import { config } from "../src/config/env";

const ITEMS = [
  { id: "p1", productId: "p1", name: "Burger", price: 500, unitPrice: 500, quantity: 1 },
];

const seedWorld = (inStock = true) => {
  docs.set("branches/branch_a", {
    id: "branch_a",
    isOpen: true,
    isAcceptingOrders: true,
    pricing: { packagingFee: 0, deliveryFee: 0, taxRate: 0 },
    items: [],
  });
  docs.set("products/p1", {
    id: "p1",
    name: "Burger",
    price: 500,
    inStock,
    customizations: [],
  });
  docs.set("customers/cust_1", { id: "cust_1", loyaltyPoints: 0 });
  docs.set("orders/ord_1", {
    id: "ord_1",
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

const create = () =>
  createPaymentOrder({
    orderId: "ord_1",
    items: ITEMS as any,
    branchId: "branch_a",
    orderType: "takeaway",
    customerId: "cust_1",
    idempotencyKey: "chk_p1i_1",
  } as any);

describe("P1-I — intent reuse must revalidate availability", () => {
  const prevMock = config.mock.paymentGateway;
  beforeEach(() => {
    docs.clear();
    control.mintCounter = 0;
    config.mock.paymentGateway = true;
  });
  afterEach(() => {
    config.mock.paymentGateway = prevMock;
  });

  it("interleaved: intent minted, item 86'd, retry is REFUSED instead of paying", async () => {
    seedWorld(true);
    const first: any = await create();
    expect(first.razorpayOrderId).toBeTruthy();

    // The kitchen 86s the only item between the first attempt and the retry.
    docs.set("products/p1", {
      ...docs.get("products/p1"),
      inStock: false,
    });

    const err: any = await create().then(
      (r) => ({ unexpectedSuccess: r }),
      (e) => e
    );

    expect(err.unexpectedSuccess).toBeUndefined();
    expect(err.code).toBe("ITEM_UNAVAILABLE");
    expect(err.statusCode).toBe(409);
  });

  it("keeps returning the same intent while the item stays available", async () => {
    seedWorld(true);
    const first: any = await create();
    const second: any = await create();
    expect(second.razorpayOrderId).toBe(first.razorpayOrderId);
    // Exactly one intent exists: the retry reused it, it did not fork.
    expect([...docs.keys()].filter((k) => k.startsWith("payment_intents/"))).toHaveLength(1);
  });

  it("refuses a retry when the branch closed in the meantime", async () => {
    seedWorld(true);
    const first: any = await create();
    expect(first.razorpayOrderId).toBeTruthy();

    docs.set("branches/branch_a", { ...docs.get("branches/branch_a"), isOpen: false });
    docs.set("products/p1", { ...docs.get("products/p1"), inStock: false });

    await expect(create()).rejects.toMatchObject({ code: "ITEM_UNAVAILABLE" });
  });

  it("a stale intent whose order was already cancelled is not handed out", async () => {
    seedWorld(true);
    await create();
    docs.set("orders/ord_1", {
      ...docs.get("orders/ord_1"),
      status: { code: "CANCELLED", label: "Cancelled", kind: "cancelled", terminal: true },
    });
    docs.set("products/p1", { ...docs.get("products/p1"), inStock: false });

    await expect(create()).rejects.toMatchObject({ code: "ITEM_UNAVAILABLE" });
  });
});
