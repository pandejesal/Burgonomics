import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Payment-intent REUSE binding (lane 7 Razorpay, main grant 2026-10-20).
 *
 * Defect under test (LOCAL CODE VERIFIED before the fix): `createPaymentOrder`
 * reuses a stored gateway order on an idempotency-key hit without checking
 * that the stored intent is bound to the SAME internal order the caller is
 * paying for. After a payment-modal dismiss or a page reload the client mints
 * a NEW internal order but keeps the same basket fingerprint key, so the
 * server would hand back the OLD gateway order; `verifyPayment` only then
 * refuses with ORDER_MISMATCH — after the customer's money moved.
 *
 * The lost-claim path additionally ignored intent expiry: an expired lease
 * minted a fresh gateway order, lost `create()`, and then returned the STALE
 * winner (TTL ineffective).
 *
 * Contract pinned here: a LIVE reused intent bound to a different (or
 * unreadable) internal order is refused BEFORE any gateway order is handed
 * out (409 PAYMENT_INTENT_ORDER_MISMATCH); an EXPIRED lease is superseded by
 * the freshly minted order so retries converge on it.
 *
 * Mock-only, in-memory store: no network, no gateway, no Firestore.
 */

const { mockDb, savedDocs } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};

  const docRef = (col: string, id: string) => {
    const path = `${col}/${id}`;
    return {
      id,
      path,
      get: vi.fn(async () => {
        const stored = savedDocs[path];
        // Simulates "another writer claimed between our read and create()":
        // the doc is invisible to exactly one read, while create() still
        // sees it EXISTS and throws ALREADY_EXISTS.
        if (stored?.__hideOnce) {
          delete stored.__hideOnce;
          return { exists: false, data: () => undefined };
        }
        // Authoritative catalog fallback: the pricing engine refuses lines it
        // cannot resolve, so fixtures need a real product row.
        if (col === "products" && !Object.prototype.hasOwnProperty.call(savedDocs, path)) {
          const catalog: Record<string, { price: number; inStock: boolean }> = {
            p1: { price: 199, inStock: true },
          };
          const entry = catalog[id];
          if (entry) return { exists: true, data: () => ({ ...entry }) };
        }
        return {
          exists: Object.prototype.hasOwnProperty.call(savedDocs, path),
          data: () => stored,
        };
      }),
      set: vi.fn(async (data: any, opts?: any) => {
        savedDocs[path] =
          opts?.merge && savedDocs[path] ? { ...savedDocs[path], ...data } : data;
      }),
      create: vi.fn(async (data: any) => {
        if (Object.prototype.hasOwnProperty.call(savedDocs, path)) {
          const err: any = new Error("Document already exists");
          err.code = 6;
          throw err;
        }
        savedDocs[path] = data;
      }),
      update: vi.fn(async (data: any) => {
        savedDocs[path] = { ...(savedDocs[path] || {}), ...data };
      }),
      delete: vi.fn(async () => {
        delete savedDocs[path];
      }),
    };
  };

  const mockDb: any = {
    collection: (col: string) => ({
      doc: (id: string) => docRef(col, id),
    }),
    runTransaction: vi.fn(async (fn: any) =>
      fn({
        get: (ref: any) => ref.get(),
        set: (ref: any, data: any, opts?: any) => ref.set(data, opts),
      })
    ),
  };
  return { mockDb, savedDocs };
});

vi.mock("firebase-admin", () => {
  const FieldValue = {
    serverTimestamp: () => "MOCK_TIMESTAMP",
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

import { createPaymentOrder } from "../src/modules/payments/razorpay.service";
import { config } from "../src/config/env";

const basket = {
  items: [{ id: "p1", productId: "p1", name: "Burger", price: 199, quantity: 1 }],
  branchId: "branch_c1",
  orderType: "takeaway" as const,
  customerId: "cust_a",
};

function seedOrder(id: string, customerId = "cust_a", extra: Record<string, any> = {}) {
  savedDocs[`orders/${id}`] = {
    id,
    customerId,
    orderType: "takeaway",
    status: "pending_payment",
    ...extra,
  };
}

function seedLiveIntent(key: string, overrides: Record<string, any> = {}) {
  savedDocs[`payment_intents/${key}`] = {
    razorpayOrderId: "order_mock_STALE",
    amountPaise: 19900,
    receipt: "rcpt_stale",
    pricing: { grandTotal: 199 },
    orderId: "ord_a",
    branchId: "branch_c1",
    orderType: "takeaway",
    customerId: "cust_a",
    createdAtMs: Date.now() - 60_000,
    expiresAtMs: Date.now() + 60 * 60 * 1000,
    ...overrides,
  };
}

describe("createPaymentOrder — reused intent must stay bound to the same internal order", () => {
  let prevMock: boolean;
  let prevKeyId: string;
  let prevKeySecret: string;

  beforeEach(() => {
    for (const key of Object.keys(savedDocs)) delete savedDocs[key];
    prevMock = config.mock.paymentGateway;
    prevKeyId = config.razorpay.keyId;
    prevKeySecret = config.razorpay.keySecret;
    config.mock.paymentGateway = true;
    // Branch config is money-critical: the pricing engine refuses to price
    // without a branch doc (royalty/packaging source).
    savedDocs["branches/branch_c1"] = { razorpayAccountId: "acc_c1" };
    seedOrder("ord_a");
    seedOrder("ord_b");
  });

  afterEach(() => {
    config.mock.paymentGateway = prevMock;
    config.razorpay.keyId = prevKeyId;
    config.razorpay.keySecret = prevKeySecret;
  });

  it("positive: the SAME internal order reuses its open gateway order", async () => {
    const first = await createPaymentOrder({ ...basket, orderId: "ord_a", idempotencyKey: "k_same" });
    const second = await createPaymentOrder({ ...basket, orderId: "ord_a", idempotencyKey: "k_same" });

    expect(second.razorpayOrderId).toBe(first.razorpayOrderId);
    expect((second as any).reused).toBe(true);
    expect(savedDocs["payment_intents/k_same"].orderId).toBe("ord_a");
    expect(savedDocs["payment_intents/k_same"].razorpayOrderId).toBe(first.razorpayOrderId);
  });

  it("negative: a DIFFERENT internal order cannot be handed the live reused intent", async () => {
    const first = await createPaymentOrder({ ...basket, orderId: "ord_a", idempotencyKey: "k_cross" });

    await expect(
      createPaymentOrder({ ...basket, orderId: "ord_b", idempotencyKey: "k_cross" })
    ).rejects.toMatchObject({ statusCode: 409, code: "PAYMENT_INTENT_ORDER_MISMATCH" });

    // The winner is untouched and the refused order was never priced/stamped.
    expect(savedDocs["payment_intents/k_cross"].orderId).toBe("ord_a");
    expect(savedDocs["payment_intents/k_cross"].razorpayOrderId).toBe(first.razorpayOrderId);
    expect(savedDocs["orders/ord_b"].pricing).toBeUndefined();
  });

  it("negative: a live intent with NO stored order binding is refused (never guessed)", async () => {
    seedLiveIntent("k_nobind", { orderId: undefined });

    await expect(
      createPaymentOrder({ ...basket, orderId: "ord_a", idempotencyKey: "k_nobind" })
    ).rejects.toMatchObject({ statusCode: 409, code: "PAYMENT_INTENT_ORDER_MISMATCH" });
    expect(savedDocs["payment_intents/k_nobind"].razorpayOrderId).toBe("order_mock_STALE");
  });

  it("negative: a live intent with a corrupt (non-string) order binding is refused", async () => {
    seedLiveIntent("k_corrupt", { orderId: 12345 });

    await expect(
      createPaymentOrder({ ...basket, orderId: "ord_a", idempotencyKey: "k_corrupt" })
    ).rejects.toMatchObject({ statusCode: 409, code: "PAYMENT_INTENT_ORDER_MISMATCH" });
  });

  it("negative: ownership is still proven before any reuse (foreign order)", async () => {
    seedOrder("ord_victim", "cust_victim");
    seedLiveIntent("k_foreign", { orderId: "ord_victim" });

    await expect(
      createPaymentOrder({ ...basket, orderId: "ord_victim", idempotencyKey: "k_foreign" })
    ).rejects.toMatchObject({ statusCode: 409, code: "ORDER_NOT_OWNED" });
  });

  it("expired lease: mints a FRESH order, records the superseded id, and retries reuse it", async () => {
    seedLiveIntent("k_expired", {
      orderId: "ord_a",
      expiresAtMs: Date.now() - 1_000,
    });

    const fresh = await createPaymentOrder({
      ...basket,
      orderId: "ord_b",
      idempotencyKey: "k_expired",
    });

    expect(fresh.razorpayOrderId).not.toBe("order_mock_STALE");
    expect((fresh as any).reused).toBeUndefined();
    const intent = savedDocs["payment_intents/k_expired"];
    expect(intent.orderId).toBe("ord_b");
    expect(intent.razorpayOrderId).toBe(fresh.razorpayOrderId);
    expect(intent.supersedes).toBe("order_mock_STALE");
    expect(Number(intent.expiresAtMs)).toBeGreaterThan(Date.now());

    // A retry of the SAME checkout converges on the fresh order: no re-mint.
    const retry = await createPaymentOrder({
      ...basket,
      orderId: "ord_b",
      idempotencyKey: "k_expired",
    });
    expect(retry.razorpayOrderId).toBe(fresh.razorpayOrderId);
    expect((retry as any).reused).toBe(true);
  });

  it("negative: the 409 message never echoes stored intent/order ids", async () => {
    await createPaymentOrder({ ...basket, orderId: "ord_a", idempotencyKey: "k_msg" });

    const err: any = await createPaymentOrder({
      ...basket,
      orderId: "ord_b",
      idempotencyKey: "k_msg",
    }).catch((e: any) => e);

    expect(err.statusCode).toBe(409);
    expect(err.code).toBe("PAYMENT_INTENT_ORDER_MISMATCH");
    expect(err.message).not.toContain("ord_a");
    expect(err.message).not.toContain("ord_b");
    expect(err.message).not.toContain("order_mock_");
  });

  it("legacy caller with NO internal order keeps the previous reuse behaviour", async () => {
    const first = await createPaymentOrder({ ...basket, orderId: "ord_a", idempotencyKey: "k_legacy" });
    const legacy = await createPaymentOrder({
      items: basket.items,
      branchId: basket.branchId,
      orderType: basket.orderType,
      customerId: basket.customerId,
      idempotencyKey: "k_legacy",
    });

    expect(legacy.razorpayOrderId).toBe(first.razorpayOrderId);
    expect((legacy as any).reused).toBe(true);
  });

  it("corrupt (string) stored amount is refused BEFORE minting and leaves the doc alone", async () => {
    seedLiveIntent("k_badamount", { amountPaise: "19900" });

    await expect(
      createPaymentOrder({ ...basket, orderId: "ord_a", idempotencyKey: "k_badamount" })
    ).rejects.toMatchObject({ statusCode: 503 });

    expect(savedDocs["payment_intents/k_badamount"].razorpayOrderId).toBe("order_mock_STALE");
    // Refused before pricing/minting: no stamp, no fresh gateway order.
    expect(savedDocs["orders/ord_a"].pricing).toBeUndefined();
  });

  it("lost-supersede: a winner that turns LIVE concurrently is re-read and reused when it matches", async () => {
    seedLiveIntent("k_suprace", { orderId: "ord_b", expiresAtMs: Date.now() - 1_000 });
    const realTx = mockDb.runTransaction.getMockImplementation() as any;

    // Simulates another caller refreshing the intent between our winner read
    // and our supersede transaction: the transaction must NOT overwrite it.
    mockDb.runTransaction.mockImplementationOnce(async (fn: any) => {
      savedDocs["payment_intents/k_suprace"] = {
        ...savedDocs["payment_intents/k_suprace"],
        razorpayOrderId: "order_mock_REFRESHED",
        orderId: "ord_b",
        expiresAtMs: Date.now() + 60 * 60 * 1000,
      };
      return realTx(fn);
    });

    const res = await createPaymentOrder({
      ...basket,
      orderId: "ord_b",
      idempotencyKey: "k_suprace",
    });

    expect(res.razorpayOrderId).toBe("order_mock_REFRESHED");
    expect((res as any).reused).toBe(true);
    expect(savedDocs["payment_intents/k_suprace"].supersedes).toBeUndefined();
  });

  it("lost-supersede: a concurrently refreshed winner bound to ANOTHER order is refused", async () => {
    seedLiveIntent("k_suprace2", { orderId: "ord_a", expiresAtMs: Date.now() - 1_000 });
    const realTx = mockDb.runTransaction.getMockImplementation() as any;

    mockDb.runTransaction.mockImplementationOnce(async (fn: any) => {
      savedDocs["payment_intents/k_suprace2"] = {
        ...savedDocs["payment_intents/k_suprace2"],
        razorpayOrderId: "order_mock_REFRESHED2",
        orderId: "ord_a",
        expiresAtMs: Date.now() + 60 * 60 * 1000,
      };
      return realTx(fn);
    });

    await expect(
      createPaymentOrder({ ...basket, orderId: "ord_b", idempotencyKey: "k_suprace2" })
    ).rejects.toMatchObject({ statusCode: 409, code: "PAYMENT_INTENT_ORDER_MISMATCH" });
    expect(savedDocs["payment_intents/k_suprace2"].orderId).toBe("ord_a");
  });

  it("no transactional datastore: expired lease is NOT blind-overwritten (503, doc untouched)", async () => {
    seedLiveIntent("k_notx", { orderId: "ord_a", expiresAtMs: Date.now() - 1_000 });
    const originalTx = mockDb.runTransaction;
    (mockDb as any).runTransaction = undefined;
    try {
      await expect(
        createPaymentOrder({ ...basket, orderId: "ord_b", idempotencyKey: "k_notx" })
      ).rejects.toMatchObject({ statusCode: 503 });
    } finally {
      mockDb.runTransaction = originalTx;
    }
    expect(savedDocs["payment_intents/k_notx"].razorpayOrderId).toBe("order_mock_STALE");
    expect(savedDocs["payment_intents/k_notx"].orderId).toBe("ord_a");
  });
  it("lost-claim race: a live winner bound to another order is refused, not returned", async () => {
    // Winner appears only after our pre-read (simulated concurrent claim).
    savedDocs["payment_intents/k_race"] = {
      __hideOnce: true,
      razorpayOrderId: "order_mock_RACEWINNER",
      amountPaise: 19900,
      receipt: "rcpt_race",
      pricing: { grandTotal: 199 },
      orderId: "ord_a",
      branchId: "branch_c1",
      orderType: "takeaway",
      customerId: "cust_a",
      createdAtMs: Date.now() - 1_000,
      expiresAtMs: Date.now() + 60 * 60 * 1000,
    };

    await expect(
      createPaymentOrder({ ...basket, orderId: "ord_b", idempotencyKey: "k_race" })
    ).rejects.toMatchObject({ statusCode: 409, code: "PAYMENT_INTENT_ORDER_MISMATCH" });
    // Winner untouched; the loser's freshly minted order is never handed out.
    expect(savedDocs["payment_intents/k_race"].razorpayOrderId).toBe("order_mock_RACEWINNER");
    expect(savedDocs["payment_intents/k_race"].orderId).toBe("ord_a");
  });
});
