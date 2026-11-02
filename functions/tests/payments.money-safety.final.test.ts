import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as crypto from "crypto";

/**
 * MONEY-SAFETY REGRESSION SUITE (final review round).
 *
 * Every scenario below is an INTERLEAVED sequence with real document shapes and
 * enters through a PRODUCTION entry point:
 *   - `createPaymentOrder` (checkout / intent reuse),
 *   - `verifyPayment` (client capture),
 *   - `handleRazorpayWebhook` (authoritative capture),
 *   - `expireAbandonedUnpaidOrders` (the scheduled expiry job).
 *
 * Nothing here calls an internal helper as the subject under test: the helpers
 * are only reachable because the entry point calls them.
 */
const { mockDb, docs, writeLog, control, snapshots } = vi.hoisted(() => {
  process.env.OTP_HMAC_SECRET = "test_otp_moneysafety";

  type Rec = { data: any; version: number };
  const docs = new Map<string, Rec>();
  const writeLog: Array<{ path: string; data: any; merge?: boolean }> = [];
  const snapshots: any[] = [];

  const control: any = {
    mintCounter: 0,
    refundPosts: [] as any[],
    refundMode: "ok" as "ok" | "fail",
    gatewayPayments: {} as Record<string, any>,
    paymentFetch: null as null | ((paymentId: string) => Promise<any>),
    afterGatewayLookup: null as null | ((orderId: string) => void | Promise<void>),
    failIntentWrite: null as null | "throw" | "swallow-before-write",
    failProductRead: false,
  };

  const versionOf = (p: string) => docs.get(p)?.version ?? -1;
  const dataOf = (p: string) => docs.get(p)?.data;
  const applyWrite = (path: string, data: any, merge?: boolean) => {
    const existing = docs.get(path);
    const next = merge && existing ? { ...existing.data, ...data } : { ...data };
    docs.set(path, { data: next, version: (existing?.version ?? 0) + 1 });
    writeLog.push({ path, data, merge: !!merge });
  };

  /** Seeds a document through the SAME store writer the service reads. */
  control.seed = (path: string, data: any, merge = false) => applyWrite(path, data, merge);

  let commitTail: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(task: () => T): Promise<T> => {
    const run = commitTail.then(task, task);
    commitTail = run.then(() => undefined, () => undefined);
    return run;
  };

  const runTransaction = (fn: (tx: any) => any): Promise<any> => {
    const attempt = async (): Promise<any> => {
      for (let tries = 0; tries <= 8; tries++) {
        const readVersions = new Map<string, number>();
        const writes: Array<{ path: string; data: any; merge?: boolean }> = [];
        const tx = {
          get: async (ref: any) => {
            readVersions.set(ref.path, versionOf(ref.path));
            const data = dataOf(ref.path);
            return {
              exists: data !== undefined,
              data: () => (data === undefined ? undefined : JSON.parse(JSON.stringify(data))),
              ref,
            };
          },
          set: (ref: any, data: any, opts?: any) =>
            void writes.push({ path: ref.path, data, merge: !!opts?.merge }),
          update: (ref: any, data: any) => void writes.push({ path: ref.path, data, merge: true }),
        };
        const result = await fn(tx);
        const conflicted = () =>
          [...readVersions.entries()].some(([p, v]) => versionOf(p) !== v);
        if (writes.length === 0) {
          if (conflicted()) continue;
          return result;
        }
        const outcome = await enqueue(() => {
          if (conflicted()) return { conflicted: true as const };
          for (const w of writes) applyWrite(w.path, w.data, w.merge);
          return { conflicted: false as const, result };
        });
        if (!outcome.conflicted) return outcome.result;
      }
      const err: any = new Error("ABORTED");
      err.code = 10;
      throw err;
    };
    return attempt();
  };

  const docRef = (col: string, id: string) => {
    const path = `${col}/${id}`;
    return {
      id,
      path,
      get: async () => ({
        exists: dataOf(path) !== undefined,
        data: () => (dataOf(path) === undefined ? undefined : JSON.parse(JSON.stringify(dataOf(path)))),
        ref: docRef(col, id),
      }),
      set: async (data: any, opts?: any) => {
        if (col === "payment_intents" && control.failIntentWrite === "throw") {
          throw new Error("firestore write unavailable");
        }
        if (col === "payment_intents" && control.failIntentWrite === "swallow-before-write") {
          // Ambiguous: NOTHING persisted, yet no error surfaced (datastore shim
          // / partial failure). The fix must still fail closed.
          return;
        }
        applyWrite(path, data, !!opts?.merge);
      },
      // The 'throw'/'swallow' seams only apply to set(), so create() keeps the
      // element's own ALREADY_EXISTS semantics. The service prefers create()
      // when the ref exposes it — these refs do not, matching the shim shape
      // of the payment suites that pin the merge-set path.
      create: async (data: any) => {
        if (docs.has(path)) {
          const err: any = new Error("ALREADY_EXISTS: Document already exists");
          err.code = 6;
          throw err;
        }
        applyWrite(path, data, false);
      },
      update: async (data: any) => applyWrite(path, data, true),
    };
  };

  const docRefNoCreate = (col: string, id: string) => {
    const ref: any = docRef(col, id);
    if (col === "products" && control.failProductRead) {
      ref.get = async () => {
        throw new Error("catalogue read outage");
      };
    }
    delete ref.create;
    return ref;
  };

  const getByPath = (obj: any, path: string) =>
    obj != null && Object.prototype.hasOwnProperty.call(obj, path)
      ? obj[path]
      : path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);

  const collectionMock = (colName: string) => {
    const filters: Array<{ field: string; value: any }> = [];
    const q: any = {
      where: (field: string, _op: string, value: any) => {
        filters.push({ field, value });
        return q;
      },
      limit: () => q,
      get: async () => {
        const found = [...docs.entries()]
          .filter(([p]) => p.startsWith(`${colName}/`))
          .filter(([, rec]) => filters.every((f) => getByPath(rec.data, f.field) === f.value))
          .map(([p, rec]) => {
            const id = p.slice(colName.length + 1);
            return { id, ref: docRef(colName, id), data: () => JSON.parse(JSON.stringify(rec.data)) };
          });
        return { empty: found.length === 0, size: found.length, docs: found };
      },
      doc: (docId?: string) =>
        docRefNoCreate(colName, docId || `auto_${Math.random().toString(36).slice(2, 8)}`),
    };
    return q;
  };

  const mockDb: any = { collection: collectionMock, runTransaction };

  return {
    mockDb,
    docs,
    writeLog,
    control,
    snapshots,
    applyWrite,
  } as any;
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
      fetchPayments: vi.fn(async (razorpayOrderId: string) => {
        const value = control.gatewayPayments[razorpayOrderId];
        if (value instanceof Error) throw value;
        return value ?? { items: [] };
      }),
    },
    payments: { fetch: vi.fn(async (id: string) => control.gatewayPayments[id]) },
  }),
  getRazorpayKeyId: () => "rzp_test_moneysafety",
}));

vi.mock("../src/core/errors", async (io) => ({
  ...(await io<any>()),
  captureErrorSnapshot: vi.fn(async (s: any) => {
    snapshots.push(s);
    return "snap_1";
  }),
}));

import { createPaymentOrder, verifyPayment, __setPaymentsFetchForTests, __setRefundPostForTests } from "../src/modules/payments/razorpay.service";
import { handleRazorpayWebhook } from "../src/modules/payments/webhookHandler";
import { expireAbandonedUnpaidOrders, __setAfterGatewayLookupForTests } from "../src/modules/orders/expireUnpaidOrders";
import { config } from "../src/config/env";

const ITEMS = [
  { id: "p1", productId: "p1", name: "Burger", price: 100, unitPrice: 100, quantity: 1 },
];
const BRANCH = "branch_ms";
const SECRET = "rzp_ms_secret";
const WHSEC = "whsec_ms_test_only";

function signVerify(gatewayOrderId: string, paymentId: string) {
  return crypto.createHmac("sha256", SECRET).update(`${gatewayOrderId}|${paymentId}`).digest("hex");
}
function signWebhook(rawBody: string) {
  return crypto.createHmac("sha256", WHSEC).update(rawBody).digest("hex");
}

function seedBranch(over: Record<string, any> = {}) {
  control.seed(`branches/${BRANCH}`, {
    id: BRANCH,
    isOpen: true,
    isAcceptingOrders: true,
    packagingFee: 0,
    monthlyFee: 0,
    ...over,
  });
}

function seedProduct(inStock = true) {
  control.seed("products/p1", {
    id: "p1",
    name: "Burger",
    price: 100,
    inStock,
    customizations: [],
  });
}

function seedOrder(
  orderId: string,
  over: Record<string, any> = {}
) {
  control.seed(`orders/${orderId}`, {
    id: orderId,
    customerId: "cust_ms",
    userId: "cust_ms",
    branchId: BRANCH,
    orderType: "takeaway",
    fulfillmentType: "takeaway",
    items: ITEMS,
    payment: { method: "online", status: "pending" },
    paymentStatus: "pending",
    routeTransferStatus: "not_required",
    status: { code: "PLACED", label: "Order placed", kind: "upcoming", terminal: false },
    createdAt: new Date().toISOString(),
    ...over,
  });
}

function seedIntent(
  key: string,
  over: Record<string, any> = {}
) {
  const data = {
    razorpayOrderId: `rzp_${key}`,
    orderId: `ord_${key}`,
    amountPaise: 10000,
    branchId: BRANCH,
    orderType: "takeaway",
    customerId: "cust_ms",
    pricing: { grandTotal: 100, loyaltyDiscount: 0, split: { branchTransferPaise: 0 } },
    createdAtMs: Date.now(),
    expiresAtMs: Date.now() + 60_000,
    ...over,
  };
  control.seed(`payment_intents/${key}`, data);
  return data;
}

function mockReqRes(payload: any, signature?: string) {
  const rawBody = JSON.stringify(payload);
  const req: any = {
    headers: {
      ...(signature ? { "x-razorpay-signature": signature } : {}),
      ...(payload.id ? { "x-razorpay-event-id": payload.id } : {}),
    },
    rawBody: Buffer.from(rawBody, "utf8"),
    body: payload,
  };
  let statusCode = 0;
  let body: any = null;
  const res: any = {
    status: (code: number) => {
      statusCode = code;
      return { json: (obj: any) => void (body = obj) };
    },
  };
  return { req, res, out: () => ({ statusCode, body }) };
}

function capturedPayload(orderId: string, gatewayOrderId: string, paymentId: string, amountPaise: number) {
  return {
    id: `evt_${paymentId}`,
    event: "payment.captured",
    created_at: Math.floor(Date.now() / 1000),
    payload: {
      payment: {
        entity: {
          id: paymentId,
          order_id: gatewayOrderId,
          amount: amountPaise,
          currency: "INR",
          notes: { orderId, branchId: BRANCH },
        },
      },
    },
  };
}

const docOf = (path: string) => docs.get(path)?.data;
const orderOf = (id: string) => docOf(`orders/${id}`);
const refundWrites = () => writeLog.filter((w) => w.path.startsWith("payment_refund_requests/"));
const anyRefundPost = () => control.refundPosts.length;

const prevMock = { pg: false, pp: false };

beforeEach(() => {
  for (const key of [...docs.keys()]) docs.delete(key);
  writeLog.length = 0;
  snapshots.length = 0;
  control.mintCounter = 0;
  control.refundPosts = [];
  control.refundMode = "ok";
  control.gatewayPayments = {};
  control.failIntentWrite = null;
  control.afterGatewayLookup = null;
  prevMock.pg = config.mock.paymentGateway;
  prevMock.pp = config.mock.petpoojaPos;
  // Live-ish money path with the provider seams stubbed: real guards, ledger,
  // signatures and idempotency, no network.
  config.mock.paymentGateway = false;
  config.mock.petpoojaPos = true;
  config.razorpay.keySecret = SECRET;
  config.razorpay.webhookSecret = WHSEC;
  seedBranch();
  seedProduct(true);
  __setRefundPostForTests(async (paymentId: string, body: any, key: string) => {
    if (control.refundMode === "fail") throw new Error("gateway refund exploded");
    control.refundPosts.push({ paymentId, body, key });
    return {
      id: `rfnd_ms_${paymentId}`,
      payment_id: paymentId,
      amount: body.amount ?? 10000,
      status: "processed",
    };
  });
  __setAfterGatewayLookupForTests(async (orderId: string) => {
    if (control.afterGatewayLookup) await control.afterGatewayLookup(orderId);
  });
});

afterEach(() => {
  config.mock.paymentGateway = prevMock.pg;
  config.mock.petpoojaPos = prevMock.pp;
  __setRefundPostForTests(null);
  __setPaymentsFetchForTests(null);
  __setAfterGatewayLookupForTests(null);
});

// ---------------------------------------------------------------------------
// ITEM 1 — a normal delivery retry must not be refused for a missing courier
// quote (availability recheck must not re-price).
// ---------------------------------------------------------------------------
describe("ITEM 1 — intent reuse re-checks availability without re-pricing", () => {
  const DROP = { lat: 23.0338, lng: 72.5262 };
  const DELIVERY_ITEMS = [
    { id: "p1", productId: "p1", name: "Burger", price: 100, unitPrice: 100, quantity: 1 },
  ];

  const seedDelivery = () => {
    seedOrder("ord_del", {
      orderType: "delivery",
      fulfillmentType: "delivery",
      items: DELIVERY_ITEMS,
      deliveryAddress: DROP,
    });
    control.seed("delivery_fee_quotes/dfq_ms", {
      uid: "cust_ms",
      branchId: BRANCH,
      storeId: "store_ms",
      dropLat: DROP.lat,
      dropLng: DROP.lng,
      fee: 42.55,
      provider: "borzo",
      providerQuoteId: "QTE-MS",
      createdAtMs: Date.now() - 1000,
      expiresAt: Date.now() + 5 * 60_000,
      usedByOrderId: null,
    });
  };

  const createDelivery = () =>
    createPaymentOrder({
      orderId: "ord_del",
      items: DELIVERY_ITEMS as any,
      branchId: BRANCH,
      orderType: "delivery",
      customerId: "cust_ms",
      deliveryQuoteId: "dfq_ms",
      idempotencyKey: "chk_delivery_ms",
    } as any);

  it("interleaved: quote minted, connection dropped, retry WITHOUT the quote id still reuses the same payable intent", async () => {
    seedDelivery();
    const first: any = await createDelivery();
    expect(first.razorpayOrderId).toBeTruthy();
    expect(first.amountPaise).toBe(14255);

    // The retry after a dropped connection / refresh: the client re-sends the
    // checkout without the quote id. The QUIOTE is already bound to the order,
    // so the persisted fee is the one charged — and the availability recheck
    // must not demand a fresh quote (that is what broke every delivery retry).
    const retry: any = await createPaymentOrder({
      orderId: "ord_del",
      items: DELIVERY_ITEMS as any,
      branchId: BRANCH,
      orderType: "delivery",
      customerId: "cust_ms",
      idempotencyKey: "chk_delivery_ms",
    } as any);

    expect(retry.reused).toBe(true);
    expect(retry.razorpayOrderId).toBe(first.razorpayOrderId);
    expect(retry.amountPaise).toBe(14255);
    expect(retry.pricing.deliveryFee).toBe(42.55);
  });

  it("the reuse path still refuses an 86'd line with the SAME typed refusal", async () => {
    seedDelivery();
    const first: any = await createDelivery();
    expect(first.razorpayOrderId).toBeTruthy();

    control.seed("products/p1", { ...(docs.get("products/p1")!.data as any), inStock: false });

    const err: any = await createDelivery().then(
      (r) => ({ unexpectedSuccess: r }),
      (e) => e
    );
    expect(err.unexpectedSuccess).toBeUndefined();
    expect(err.code).toBe("ITEM_UNAVAILABLE");
    expect(err.statusCode).toBe(409);
  });

  it("a catalogue OUTAGE on reuse is retryable, never a false ITEM_UNAVAILABLE", async () => {
    seedDelivery();
    await createDelivery();

    control.failProductRead = true;
    try {
      const err: any = await createDelivery().then(
        (r) => ({ unexpectedSuccess: r }),
        (e) => e
      );
      expect(err.unexpectedSuccess).toBeUndefined();
      expect(err.code).toBe("MENU_AVAILABILITY_UNAVAILABLE");
      expect(err.statusCode).toBe(503);
    } finally {
      control.failProductRead = false;
    }
  });
});

// ---------------------------------------------------------------------------
// ITEM 2 — intent/reservation persistence failure must NOT expose a payable
// order, and ambiguous persistence must be reconciled.
// ---------------------------------------------------------------------------
describe("ITEM 2 — a payable gateway order is never exposed without its intent", () => {
  it("intent write throws: checkout fails closed, the mint is reconciled, coins are not stuck", async () => {
    control.seed("customers/cust_ms", { id: "cust_ms", loyaltyPoints: 100 });
    seedOrder("ord_f2");

    control.failIntentWrite = "throw";
    const err: any = await createPaymentOrder({
      orderId: "ord_f2",
      items: ITEMS as any,
      branchId: BRANCH,
      orderType: "takeaway",
      customerId: "cust_ms",
      loyaltyPointsToRedeem: 20,
      idempotencyKey: "chk_f2",
    } as any).then(
      (r) => ({ unexpectedSuccess: r }),
      (e) => e
    );

    expect(err.unexpectedSuccess).toBeUndefined();
    expect(err.statusCode).toBe(503);
    expect(err.code).toBe("PAYMENT_INTENT_UNAVAILABLE");
    // No intent row exists.
    expect(docs.get("payment_intents/chk_f2")).toBeUndefined();
    // The minted gateway order is recorded for ops instead of being handed out.
    expect(docOf("payment_intent_reconciliation/order_mint_1")).toMatchObject({
      reason: "intent_store_failed",
      status: "needs_review",
    });
    // The coin reservation was released (not locked forever).
    expect(docs.get("coin_reservations/coinres_order_mint_1")?.data?.status).toBe("released");
  });

  it("a SILENT no-op persistence (ambiguous answer) also fails closed", async () => {
    seedOrder("ord_f2b");
    control.failIntentWrite = "swallow-before-write";
    const err: any = await createPaymentOrder({
      orderId: "ord_f2b",
      items: ITEMS as any,
      branchId: BRANCH,
      orderType: "takeaway",
      customerId: "cust_ms",
      idempotencyKey: "chk_f2b",
    } as any).then(
      (r) => ({ unexpectedSuccess: r }),
      (e) => e
    );
    expect(err.unexpectedSuccess).toBeUndefined();
    expect(err.statusCode).toBe(503);
    expect(docs.get("payment_intents/chk_f2b")).toBeUndefined();
    expect(docOf("payment_intent_reconciliation/order_mint_1")).toMatchObject({
      reason: "intent_store_failed",
    });
  });

  it("a healthy retry after the storage blip succeeds and is the SAME key", async () => {
    seedOrder("ord_f2c");
    control.failIntentWrite = "throw";
    await createPaymentOrder({
      orderId: "ord_f2c",
      items: ITEMS as any,
      branchId: BRANCH,
      orderType: "takeaway",
      customerId: "cust_ms",
      idempotencyKey: "chk_f2c",
    } as any).catch(() => undefined);

    control.failIntentWrite = null;
    const ok: any = await createPaymentOrder({
      orderId: "ord_f2c",
      items: ITEMS as any,
      branchId: BRANCH,
      orderType: "takeaway",
      customerId: "cust_ms",
      idempotencyKey: "chk_f2c",
    } as any);
    expect(ok.razorpayOrderId).toBeTruthy();
    expect(docs.get("payment_intents/chk_f2c")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// ITEM 3 — the expiry race: a capture that lands after the expiry-cancel is
// refunded on BOTH capture channels.
// ---------------------------------------------------------------------------
describe("ITEM 3 — a capture after the expiry cancel is refunded, never parked", () => {
  const oldIso = new Date(Date.now() - 35 * 60_000).toISOString();

  const seedAbandoned = (orderId: string, gatewayOrderId: string, paymentId: string) => {
    seedOrder(orderId, {
      createdAt: oldIso,
      placedAt: oldIso,
      pricing: { grandTotal: 100 },
    });
    control.seed(`payment_intents/intent_${orderId}`, {
      orderId,
      razorpayOrderId: gatewayOrderId,
      amountPaise: 10000,
      pricing: { grandTotal: 100 },
      createdAtMs: Date.now() - 35 * 60_000,
      expiresAtMs: Date.now() + 60_000,
    });
    control.gatewayPayments[gatewayOrderId] = { items: [] };
    return { orderId, gatewayOrderId, paymentId };
  };

  const expireThenCapture = async (
    seed: { orderId: string; gatewayOrderId: string; paymentId: string },
    channel: "verify" | "webhook"
  ) => {
    // The sweep sees no payment and cancels.
    const stats = await expireAbandonedUnpaidOrders();
    expect(stats.cancelled).toBe(1);
    const cancelled = orderOf(seed.orderId);
    expect(cancelled.status).toMatchObject({ code: "CANCELLED" });
    expect(cancelled.cancellationReason).toBe("payment_not_completed");

    if (channel === "verify") {
      __setPaymentsFetchForTests(async () => ({
        id: seed.paymentId,
        order_id: seed.gatewayOrderId,
        amount: 10000,
        currency: "INR",
        status: "captured",
        notes: { orderId: seed.orderId },
      }));
      const err: any = await verifyPayment(
        {
          orderId: seed.orderId,
          razorpayOrderId: seed.gatewayOrderId,
          razorpayPaymentId: seed.paymentId,
          razorpaySignature: signVerify(seed.gatewayOrderId, seed.paymentId),
        },
        { uid: "cust_ms" }
      ).then(
        (r) => ({ unexpectedSuccess: r }),
        (e) => e
      );
      expect(err.code).toBe("ORDER_TERMINAL");
    } else {
      const payload = capturedPayload(seed.orderId, seed.gatewayOrderId, seed.paymentId, 10000);
      const call = mockReqRes(payload, signWebhook(JSON.stringify(payload)));
      await handleRazorpayWebhook(call.req, call.res);
      expect(call.out().statusCode).toBe(200);
    }

    // The money came back through the ONE refund path…
    expect(anyRefundPost()).toBe(1);
    expect(control.refundPosts[0].paymentId).toBe(seed.paymentId);
    // …and the order was never resurrected into a KOT/confirmed state.
    const after = orderOf(seed.orderId);
    expect(after.status).toMatchObject({ code: "CANCELLED" });
    expect(after.petpoojaOrderId).toBeUndefined();
    expect(after.paymentStatus).not.toBe("completed");
    return after;
  };

  it("verify channel: expiry wins, then the capture lands -> full automatic refund", async () => {
    const seed = seedAbandoned("ord_exp_v", "rzp_exp_v", "pay_exp_v");
    await expireThenCapture(seed, "verify");
  });

  it("webhook channel: expiry wins, then the capture lands -> full automatic refund", async () => {
    const seed = seedAbandoned("ord_exp_w", "rzp_exp_w", "pay_exp_w");
    await expireThenCapture(seed, "webhook");
  });

  it("a redelivered capture after the refund never pays twice", async () => {
    const seed = seedAbandoned("ord_exp_idem", "rzp_exp_idem", "pay_exp_idem");
    await expireThenCapture(seed, "webhook");
    const postsAfterFirst = anyRefundPost();

    const payload = capturedPayload(seed.orderId, seed.gatewayOrderId, seed.paymentId, 10000);
    const call = mockReqRes(payload, signWebhook(JSON.stringify(payload)));
    await handleRazorpayWebhook(call.req, call.res);
    expect(anyRefundPost()).toBe(postsAfterFirst);
  });

  it("a STAFF-cancelled order is never auto-refunded by this lane (park only)", async () => {
    seedOrder("ord_staff_cancel", {
      pricing: { grandTotal: 100 },
      status: { code: "CANCELLED", label: "Cancelled", kind: "cancelled", terminal: true },
      cancellationReason: "Customer called it off",
    });
    const payload = capturedPayload("ord_staff_cancel", "rzp_staff_cancel", "pay_staff_cancel", 10000);
    const call = mockReqRes(payload, signWebhook(JSON.stringify(payload)));
    await handleRazorpayWebhook(call.req, call.res);
    expect(anyRefundPost()).toBe(0);
    expect(docOf("unmatched_payments/ump_evt_pay_staff_cancel")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// ITEM 4 — compensation only on the FIRST capture; a verify replay after the
// kitchen 86'd an item must be side-effect free.
// ---------------------------------------------------------------------------
describe("ITEM 4 — a paid order re-verified after an 86 is NOT refunded", () => {
  const seedPaidOrder = (orderId: string, gatewayOrderId: string, paymentId: string) => {
    seedOrder(orderId, {
      pricing: { grandTotal: 100, split: { branchTransferPaise: 10000 } },
    });
    seedIntent(`intent_${orderId}`, {
      razorpayOrderId: gatewayOrderId,
      orderId,
      amountPaise: 10000,
      pricing: { grandTotal: 100, loyaltyDiscount: 0, split: { branchTransferPaise: 10000 } },
    });
    __setPaymentsFetchForTests(async () => ({
      id: paymentId,
      order_id: gatewayOrderId,
      amount: 10000,
      currency: "INR",
      status: "captured",
      notes: { orderId },
    }));
    return { orderId, gatewayOrderId, paymentId };
  };

  const verify = (s: { orderId: string; gatewayOrderId: string; paymentId: string }) =>
    verifyPayment(
      {
        orderId: s.orderId,
        razorpayOrderId: s.gatewayOrderId,
        razorpayPaymentId: s.paymentId,
        razorpaySignature: signVerify(s.gatewayOrderId, s.paymentId),
      },
      { uid: "cust_ms" }
    );

  it("interleaved: paid + confirmed + KOT, item 86'd, customer refreshes and re-verifies -> no refund, no second KOT", async () => {
    const seed = seedPaidOrder("ord_replay", "rzp_replay", "pay_replay");

    const first: any = await verify(seed);
    expect(first.ok).toBe(true);
    expect(orderOf(seed.orderId).paymentStatus).toBe("completed");
    expect(anyRefundPost()).toBe(0);
    const kotWrites = () =>
      writeLog.filter(
        (w) =>
          w.path === `orders/${seed.orderId}` &&
          w.data != null &&
          Object.prototype.hasOwnProperty.call(w.data, "petpoojaOrderId")
      );
    expect(kotWrites()).toHaveLength(1);

    // The kitchen 86s the item AFTER the customer's food is being made.
    control.seed("products/p1", { ...(docs.get("products/p1")!.data as any), inStock: false });

    const second: any = await verify(seed);
    expect(second.ok).toBe(true);
    expect(second.success).toBe(true);

    // Side-effect free replay: no refund, no compensation marker, no re-KOT.
    expect(anyRefundPost()).toBe(0);
    expect(orderOf(seed.orderId).refundStatus).toBeUndefined();
    expect(orderOf(seed.orderId).unfulfillableCapture).toBeUndefined();
    expect(kotWrites()).toHaveLength(1);
  });

  it("the FIRST capture of an unconfirmed order still compensates (guard is not disabled)", async () => {
    const seed = seedPaidOrder("ord_first86", "rzp_first86", "pay_first86");
    control.seed("products/p1", { ...(docs.get("products/p1")!.data as any), inStock: false });

    const err: any = await verify(seed).then(
      (r) => ({ unexpectedSuccess: r }),
      (e) => e
    );
    expect(err.code).toBe("ORDER_ITEM_UNAVAILABLE_REFUNDED");
    expect(anyRefundPost()).toBe(1);
    expect(orderOf(seed.orderId).paymentStatus).not.toBe("completed");
    expect(orderOf(seed.orderId).petpoojaOrderId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ITEM 5 — the webhook-only capture path runs the SAME availability gate.
// ---------------------------------------------------------------------------
describe("ITEM 5 — a webhook-only capture of an 86'd cart is refunded, never confirmed/KOT", () => {
  it("interleaved: intent + payment, kitchen 86s, webhook captures -> refund and no KOT", async () => {
    seedOrder("ord_wh86", {
      pricing: { grandTotal: 100, split: { branchTransferPaise: 10000 } },
    });
    seedIntent("intent_ord_wh86", {
      razorpayOrderId: "rzp_wh86",
      orderId: "ord_wh86",
      amountPaise: 10000,
      pricing: { grandTotal: 100, loyaltyDiscount: 0, split: { branchTransferPaise: 10000 } },
    });
    control.seed("products/p1", { ...(docs.get("products/p1")!.data as any), inStock: false });

    const payload = capturedPayload("ord_wh86", "rzp_wh86", "pay_wh86", 10000);
    const call = mockReqRes(payload, signWebhook(JSON.stringify(payload)));
    await handleRazorpayWebhook(call.req, call.res);

    expect(call.out().statusCode).toBe(200);
    expect(anyRefundPost()).toBe(1);
    expect(control.refundPosts[0].paymentId).toBe("pay_wh86");

    const order = orderOf("ord_wh86");
    expect(order.paymentStatus).not.toBe("completed");
    expect(order.petpoojaOrderId).toBeUndefined();
    expect(order.deliveryOtpHash).toBeUndefined();
    expect(docOf("unmatched_payments/ump_evt_pay_wh86")).toMatchObject({
      status: "auto_refunded",
      reason: "capture_item_unavailable_refunded",
    });
  });

  it("a still-sellable cart over the webhook confirms and rings EXACTLY once", async () => {
    seedOrder("ord_whok", {
      pricing: { grandTotal: 100, split: { branchTransferPaise: 10000 } },
    });
    seedIntent("intent_ord_whok", {
      razorpayOrderId: "rzp_whok",
      orderId: "ord_whok",
      amountPaise: 10000,
      pricing: { grandTotal: 100, loyaltyDiscount: 0, split: { branchTransferPaise: 10000 } },
    });

    const payload = capturedPayload("ord_whok", "rzp_whok", "pay_whok", 10000);
    const call = mockReqRes(payload, signWebhook(JSON.stringify(payload)));
    await handleRazorpayWebhook(call.req, call.res);

    expect(call.out().statusCode).toBe(200);
    expect(anyRefundPost()).toBe(0);
    expect(orderOf("ord_whok").paymentStatus).toBe("completed");
    expect(orderOf("ord_whok").petpoojaOrderId).toMatch(/^pp_kot_/);
  });
});

// ---------------------------------------------------------------------------
// ITEM 6 — reserve and debit exactly the EFFECTIVE discount, in coins.
// ---------------------------------------------------------------------------
describe("ITEM 6 — reservation stores and capture debits the effective discount only", () => {
  it("balance 100, ₹100 food, request 100 coins -> ₹20 discount and exactly 20 coins reserved/debited", async () => {
    control.seed("customers/cust_ms", { id: "cust_ms", loyaltyPoints: 100 });
    seedOrder("ord_coins");

    const created: any = await (async () => {
      const res: any = await createPaymentOrder({
        orderId: "ord_coins",
        items: ITEMS as any,
        branchId: BRANCH,
        orderType: "takeaway",
        customerId: "cust_ms",
        loyaltyPointsToRedeem: 100,
        idempotencyKey: "chk_coins",
      } as any);
      return res;
    })();

    expect(created.pricing.loyaltyDiscount).toBe(20);
    expect(created.amountPaise).toBe(8000);

    // The RESERVATION is the effective discount (20 coin = ₹20), not the ask.
    expect(docs.get("coin_reservations/coinres_chk_intentplaceholder")).toBeUndefined();
    const reservationPath = [...docs.keys()].find(
      (k) => k.startsWith("coin_reservations/") && docs.get(k)?.data?.status === "reserved"
    );
    expect(reservationPath).toBeTruthy();
    expect(docs.get(reservationPath!)!.data.coins).toBe(20);

    // Availability: 100 - 20 reserved = 80 usable.
    expect(
      docs.get("coin_reservation_accounts/cust_ms")?.data?.reservations[
        reservationPath!.split("/")[1]
      ].coins
    ).toBe(20);

    // Capture through verify: exactly 20 coins leave the balance.
    seedIntent("intent_coins", {
      razorpayOrderId: created.razorpayOrderId,
      orderId: "ord_coins",
      amountPaise: 8000,
      pricing: { grandTotal: 80, loyaltyDiscount: 20, split: { branchTransferPaise: 8000 } },
    });
    // The minted intent must be the one verify reads.
    control.seed(
      "payment_intents/chk_coins",
      (() => {
        const existing = docs.get("payment_intents/chk_coins")?.data as any;
        const intent = docs.get("payment_intents/intent_coins")!.data as any;
        return { ...existing, ...intent };
      })()
    );
    __setPaymentsFetchForTests(async () => ({
      id: "pay_coins",
      order_id: created.razorpayOrderId,
      amount: 8000,
      currency: "INR",
      status: "captured",
      notes: { orderId: "ord_coins" },
    }));

    const res: any = await verifyPayment(
      {
        orderId: "ord_coins",
        razorpayOrderId: created.razorpayOrderId,
        razorpayPaymentId: "pay_coins",
        razorpaySignature: signVerify(created.razorpayOrderId, "pay_coins"),
      },
      { uid: "cust_ms" }
    );
    expect(res.ok).toBe(true);
    expect(docs.get("customers/cust_ms")!.data.loyaltyPoints).toBe(80);
    expect(
      docs.get(`coin_transactions/coin_redemption_${created.razorpayOrderId}`)!.data.delta
    ).toBe(-20);
  });
});

// ---------------------------------------------------------------------------
// ITEM 7 — a payable intent never outlives its coin funding: on capture
// without funding the coins are RE-ACQUIRED, or the capture is compensated.
// ---------------------------------------------------------------------------
describe("ITEM 7 — funding released mid-payment is re-acquired, or the capture is refunded", () => {
  const seedDiscounted = (orderId: string, gatewayOrderId: string, paymentId: string) => {
    control.seed("customers/cust_ms", { id: "cust_ms", loyaltyPoints: 100 });
    seedOrder(orderId, {
      pricing: { grandTotal: 80, split: { branchTransferPaise: 8000 } },
    });
    control.seed(`payment_intents/intent_${orderId}`, {
      razorpayOrderId: gatewayOrderId,
      orderId,
      amountPaise: 8000,
      branchId: BRANCH,
      customerId: "cust_ms",
      pricing: { grandTotal: 80, loyaltyDiscount: 20, split: { branchTransferPaise: 8000 } },
      createdAtMs: Date.now(),
      expiresAtMs: Date.now() + 60_000,
    });
    __setPaymentsFetchForTests(async () => ({
      id: paymentId,
      order_id: gatewayOrderId,
      amount: 8000,
      currency: "INR",
      status: "captured",
      notes: { orderId },
    }));
    return { orderId, gatewayOrderId, paymentId };
  };

  const verify = (s: { orderId: string; gatewayOrderId: string; paymentId: string }) =>
    verifyPayment(
      {
        orderId: s.orderId,
        razorpayOrderId: s.gatewayOrderId,
        razorpayPaymentId: s.paymentId,
        razorpaySignature: signVerify(s.gatewayOrderId, s.paymentId),
      },
      { uid: "cust_ms" }
    );

  it("coins were handed back while paying; the customer still holds them -> RE-ACQUIRED and debited, order fulfilled", async () => {
    const seed = seedDiscounted("ord_reacq", "rzp_reacq", "pay_reacq");
    // Released reservation (expired/cancelled attempt) — the funding is gone
    // from the reservation but the balance is intact.
    control.seed("coin_reservations/coinres_rzp_reacq", {
      customerId: "cust_ms",
      coins: 20,
      orderId: "ord_reacq",
      razorpayOrderId: "rzp_reacq",
      status: "released",
      reservedAtMs: Date.now() - 60 * 60_000,
      expiresAtMs: Date.now() - 30 * 60_000,
      releasedAtMs: Date.now() - 30 * 60_000,
    });

    const res: any = await verify(seed);
    expect(res.ok).toBe(true);
    expect(orderOf("ord_reacq").paymentStatus).toBe("completed");
    expect(anyRefundPost()).toBe(0);
    // The customer paid the discount in coins after all.
    expect(docs.get("customers/cust_ms")!.data.loyaltyPoints).toBe(80);
    expect(docs.get("coin_transactions/coin_redemption_rzp_reacq")!.data.delta).toBe(-20);
  });

  it("coins were spent elsewhere; the funding cannot be re-acquired -> capture COMPENSATED, never fulfilled", async () => {
    const seed = seedDiscounted("ord_unfunded", "rzp_unfunded", "pay_unfunded");
    control.seed("customers/cust_ms", { id: "cust_ms", loyaltyPoints: 0 });
    control.seed("coin_reservations/coinres_rzp_unfunded", {
      customerId: "cust_ms",
      coins: 20,
      orderId: "ord_unfunded",
      razorpayOrderId: "rzp_unfunded",
      status: "released",
      reservedAtMs: Date.now() - 60 * 60_000,
      expiresAtMs: Date.now() - 30 * 60_000,
      releasedAtMs: Date.now() - 30 * 60_000,
    });

    const err: any = await verify(seed).then(
      (r) => ({ unexpectedSuccess: r }),
      (e) => e
    );
    expect(err.code).toBe("ORDER_ITEM_UNAVAILABLE_REFUNDED");
    expect(anyRefundPost()).toBe(1);
    expect(orderOf("ord_unfunded").paymentStatus).not.toBe("completed");
    // Nothing was taken from a zero balance.
    expect(docs.get("customers/cust_ms")!.data.loyaltyPoints).toBe(0);
  });

  it("the reservation lifetime outlives the intent lifetime (no payable order without funding)", async () => {
    const { COIN_RESERVATION_TTL_MS, PAYMENT_INTENT_TTL_MS } = await import(
      "../src/modules/payments/lifetimes"
    );
    expect(COIN_RESERVATION_TTL_MS).toBeGreaterThan(PAYMENT_INTENT_TTL_MS);
    // And the live constant the reservation writer uses is that same value.
    const { COIN_RESERVATION_TTL_MS: live } = await import(
      "../src/modules/payments/coinReservations"
    );
    expect(live).toBe(COIN_RESERVATION_TTL_MS);
  });
});

// ---------------------------------------------------------------------------
// ITEM 8 — coin capture runs on the WEBHOOK path.
// ---------------------------------------------------------------------------
describe("ITEM 8 — the webhook capture consumes the coin reservation", () => {
  it("webhook-only capture debits exactly the funded coins and releases the hold", async () => {
    control.seed("customers/cust_ms", { id: "cust_ms", loyaltyPoints: 100 });
    seedOrder("ord_whcoins", {
      pricing: { grandTotal: 80, split: { branchTransferPaise: 8000 } },
    });
    seedIntent("intent_ord_whcoins", {
      razorpayOrderId: "rzp_whcoins",
      orderId: "ord_whcoins",
      amountPaise: 8000,
      pricing: { grandTotal: 80, loyaltyDiscount: 20, split: { branchTransferPaise: 8000 } },
    });
    control.seed("coin_reservations/coinres_rzp_whcoins", {
      customerId: "cust_ms",
      coins: 20,
      orderId: "ord_whcoins",
      razorpayOrderId: "rzp_whcoins",
      status: "reserved",
      reservedAtMs: Date.now(),
      expiresAtMs: Date.now() + 60 * 60_000,
    });
    control.seed("coin_reservation_accounts/cust_ms", {
      customerId: "cust_ms",
      reservations: {
        coinres_rzp_whcoins: { coins: 20, expiresAtMs: Date.now() + 60 * 60_000 },
      },
    });

    const payload = capturedPayload("ord_whcoins", "rzp_whcoins", "pay_whcoins", 8000);
    const call = mockReqRes(payload, signWebhook(JSON.stringify(payload)));
    await handleRazorpayWebhook(call.req, call.res);

    expect(call.out().statusCode).toBe(200);
    expect(orderOf("ord_whcoins").paymentStatus).toBe("completed");
    expect(docs.get("customers/cust_ms")!.data.loyaltyPoints).toBe(80);
    expect(docs.get("coin_transactions/coin_redemption_rzp_whcoins")!.data.delta).toBe(-20);
    // The hold is gone: nothing is locked forever.
    expect(docs.get("coin_reservations/coinres_rzp_whcoins")!.data.status).toBe("consumed");
    expect(
      docs.get("coin_reservation_accounts/cust_ms")!.data.reservations?.coinres_rzp_whcoins
    ).toBeUndefined();
  });

  it("webhook capture whose discount funding is gone is parked, not confirmed", async () => {
    control.seed("customers/cust_ms", { id: "cust_ms", loyaltyPoints: 0 });
    seedOrder("ord_whunfunded", {
      pricing: { grandTotal: 80, split: { branchTransferPaise: 8000 } },
    });
    seedIntent("intent_ord_whunfunded", {
      razorpayOrderId: "rzp_whunfunded",
      orderId: "ord_whunfunded",
      amountPaise: 8000,
      pricing: { grandTotal: 80, loyaltyDiscount: 20, split: { branchTransferPaise: 8000 } },
    });
    control.seed("coin_reservations/coinres_rzp_whunfunded", {
      customerId: "cust_ms",
      coins: 20,
      orderId: "ord_whunfunded",
      razorpayOrderId: "rzp_whunfunded",
      status: "released",
      reservedAtMs: Date.now() - 60 * 60_000,
      expiresAtMs: Date.now() - 30 * 60_000,
    });

    const payload = capturedPayload("ord_whunfunded", "rzp_whunfunded", "pay_whunfunded", 8000);
    const call = mockReqRes(payload, signWebhook(JSON.stringify(payload)));
    await handleRazorpayWebhook(call.req, call.res);

    expect(call.out().statusCode).toBe(200);
    expect(orderOf("ord_whunfunded").paymentStatus).not.toBe("completed");
    expect(orderOf("ord_whunfunded").petpoojaOrderId).toBeUndefined();
    expect(docOf("unmatched_payments/ump_evt_pay_whunfunded")).toMatchObject({
      reason: "capture_unfunded_discount",
      status: "needs_review",
    });
    expect(docs.get("customers/cust_ms")!.data.loyaltyPoints).toBe(0);
  });
});
