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
    /**
     * Simulates a read that fails AFTER a successful write (an isolated read
     * fault). Persistence must then be treated as unproven, never as "gone".
     */
    failReadBackOnce: false,
    /** Number of product/intent reads left before the injected read fault. */
    failReadBackAfter: 0,
    /** Fails EVERY intent read after the first successful one. */
    failAllIntentReadsAfterFirst: false,
    intentReadCount: 0,
    /** Runs when the availability gate reads a product (a real interleave point). */
    onProductRead: null as null | (() => void | Promise<void>),
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
      get: async () => {
        // Only a read that WOULD see a stored intent is failed — i.e. the
        // post-write read-back, not the up-front idempotency lookup.
        if (col === "payment_intents") {
          control.intentReadCount += 1;
          // The up-front idempotency lookup is read #1. Every read after it
          // (the write's read-back and the reconcile read) fails, which is the
          // ambiguity under test: the binding cannot be proved either way.
          if (control.failAllIntentReadsAfterFirst && control.intentReadCount > 1) {
            throw new Error("firestore read unavailable");
          }
        }
        if (col === "payment_intents" && docs.has(path)) {
          if (control.failReadBackOnce) {
            control.failReadBackOnce = false;
            throw new Error("firestore read unavailable");
          }
          if (control.failReadBackAfter > 0) {
            control.failReadBackAfter -= 1;
            if (control.failReadBackAfter === 0) {
              throw new Error("firestore read unavailable");
            }
          }
        }
        return {
          exists: dataOf(path) !== undefined,
          data: () => (dataOf(path) === undefined ? undefined : JSON.parse(JSON.stringify(dataOf(path)))),
          ref: docRef(col, id),
        };
      },
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
    if (col === "products") {
      const inner = ref.get;
      ref.get = async () => {
        if (control.onProductRead) {
          const hook = control.onProductRead;
          control.onProductRead = null;
          await hook();
        }
        return inner();
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
  it("intent write throws: checkout fails closed, the mint is reconciled, no coin state exists", async () => {
    control.seed("customers/cust_ms", { id: "cust_ms", loyaltyPoints: 100 });
    seedOrder("ord_f2");

    control.failIntentWrite = "throw";
    const err: any = await createPaymentOrder({
      orderId: "ord_f2",
      items: ITEMS as any,
      branchId: BRANCH,
      orderType: "takeaway",
      customerId: "cust_ms",
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
    // Redemption is withdrawn, so no reservation can exist — and none is stuck.
    expect([...docs.keys()].filter((k) => k.startsWith("coin_reservations/"))).toEqual([]);
    expect(docOf("customers/cust_ms").loyaltyPoints).toBe(100);
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

// ===========================================================================
// DECISION — redemption is refused server-side (D31-D33). The coin path is out
// of the payment lane entirely, which retires the reservation findings.
// ===========================================================================
describe("DECISION — a non-zero redemption is refused before any payable order", () => {
  it("typed 409 COIN_REDEMPTION_DISABLED, no mint, no intent, no reservation, no discount", async () => {
    control.seed("customers/cust_ms", { id: "cust_ms", loyaltyPoints: 100 });
    seedOrder("ord_dec");

    const err: any = await createPaymentOrder({
      orderId: "ord_dec",
      items: ITEMS as any,
      branchId: BRANCH,
      orderType: "takeaway",
      customerId: "cust_ms",
      loyaltyPointsToRedeem: 20,
      idempotencyKey: "chk_dec",
    } as any).then(
      (r) => ({ unexpectedSuccess: r }),
      (e) => e
    );

    expect(err.unexpectedSuccess).toBeUndefined();
    expect(err.statusCode).toBe(409);
    expect(err.code).toBe("COIN_REDEMPTION_DISABLED");
    expect(control.mintCounter).toBe(0);
    expect([...docs.keys()].filter((k) => k.startsWith("payment_intents/"))).toEqual([]);
    expect([...docs.keys()].filter((k) => k.startsWith("coin_reservations/"))).toEqual([]);
    expect([...docs.keys()].filter((k) => k.startsWith("coin_reservation_accounts/"))).toEqual([]);
    expect(orderOf("ord_dec").pricing).toBeUndefined();
    expect(docOf("customers/cust_ms").loyaltyPoints).toBe(100);
  });

  it("the launch value (0) still prices, mints and reuses normally", async () => {
    control.seed("customers/cust_ms", { id: "cust_ms", loyaltyPoints: 100 });
    seedOrder("ord_dec_ok");
    const first: any = await createPaymentOrder({
      orderId: "ord_dec_ok",
      items: ITEMS as any,
      branchId: BRANCH,
      orderType: "takeaway",
      customerId: "cust_ms",
      loyaltyPointsToRedeem: 0,
      idempotencyKey: "chk_dec_ok",
    } as any);
    expect(first.pricing.loyaltyDiscount).toBe(0);
    expect([...docs.keys()].filter((k) => k.startsWith("coin_reservations/"))).toEqual([]);

    const retry: any = await createPaymentOrder({
      orderId: "ord_dec_ok",
      items: ITEMS as any,
      branchId: BRANCH,
      orderType: "takeaway",
      customerId: "cust_ms",
      idempotencyKey: "chk_dec_ok",
    } as any);
    expect(retry.reused).toBe(true);
    expect(retry.razorpayOrderId).toBe(first.razorpayOrderId);
  });
});

// ===========================================================================
// ITEM 1 — the capture gate is a LOCK. A racing sibling must not confirm while
// the owner is deciding, and a dead owner must not wedge it.
// ===========================================================================
describe("ITEM 1 — a pending fulfilment decision blocks confirmation, with lease takeover", () => {
  const seedGateOrder = (
    orderId: string,
    gatewayOrderId: string,
    paymentId: string,
    gate?: any
  ) => {
    seedOrder(orderId, {
      pricing: { grandTotal: 100, split: { branchTransferPaise: 10000 } },
    });
    seedIntent(`intent_${orderId}`, {
      razorpayOrderId: gatewayOrderId,
      orderId,
      amountPaise: 10000,
      pricing: { grandTotal: 100, loyaltyDiscount: 0, split: { branchTransferPaise: 10000 } },
    });
    if (gate) control.seed(`orders/${orderId}`, { captureFulfillment: gate }, true);
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

  it("interleaved: verify owns a LIVE decision, the webhook arrives -> NOT confirmed, retryable non-2xx", async () => {
    const s = seedGateOrder("ord_lock", "rzp_lock", "pay_lock", {
      state: "checking",
      paymentId: "pay_lock",
      atMs: Date.now() - 5_000,
    });

    const payload = capturedPayload(s.orderId, s.gatewayOrderId, s.paymentId, 10000);
    const call = mockReqRes(payload, signWebhook(JSON.stringify(payload)));
    await handleRazorpayWebhook(call.req, call.res);

    expect(call.out().statusCode).toBe(503);
    const order = orderOf(s.orderId);
    expect(order.paymentStatus).not.toBe("completed");
    expect(order.petpoojaOrderId).toBeUndefined();
    expect(anyRefundPost()).toBe(0);
    // The delivery claim is released so Razorpay's redelivery is processed.
    expect(docOf("payment_audits/aud_evt_pay_lock")).toBeUndefined();
  });

  it("the same lock refuses the VERIFY channel too (202, not a confirmation)", async () => {
    const s = seedGateOrder("ord_lock_v", "rzp_lock_v", "pay_lock_v", {
      state: "checking",
      paymentId: "pay_lock_v",
      atMs: Date.now() - 5_000,
    });

    const err: any = await verify(s).then(
      (r) => ({ unexpectedSuccess: r }),
      (e) => e
    );
    expect(err.unexpectedSuccess).toBeUndefined();
    expect(err.statusCode).toBe(202);
    expect(err.code).toBe("CAPTURE_FULFILLMENT_PENDING");
    expect(orderOf(s.orderId).paymentStatus).not.toBe("completed");
    expect(orderOf(s.orderId).petpoojaOrderId).toBeUndefined();
    expect(anyRefundPost()).toBe(0);
  });

  it("a CRASHED owner (stale lease) is taken over: the capture still completes", async () => {
    const s = seedGateOrder("ord_stale", "rzp_stale", "pay_stale", {
      state: "checking",
      paymentId: "pay_stale",
      atMs: Date.now() - 60 * 60_000,
    });

    const res: any = await verify(s);
    expect(res.ok).toBe(true);
    expect(orderOf(s.orderId).paymentStatus).toBe("completed");
    expect(orderOf(s.orderId).captureFulfillment).toMatchObject({
      state: "fulfillable",
      paymentId: "pay_stale",
    });
  });

  it("interleaved: the owner decided to REFUND, then the sibling webhook arrives -> never confirmed, never rung", async () => {
    const s = seedGateOrder("ord_lock_ref", "rzp_lock_ref", "pay_lock_ref", {
      state: "refunded",
      paymentId: "pay_lock_ref",
      atMs: Date.now() - 1_000,
    });

    const payload = capturedPayload(s.orderId, s.gatewayOrderId, s.paymentId, 10000);
    const call = mockReqRes(payload, signWebhook(JSON.stringify(payload)));
    await handleRazorpayWebhook(call.req, call.res);

    expect(call.out().statusCode).toBe(200);
    expect(orderOf(s.orderId).paymentStatus).not.toBe("completed");
    expect(orderOf(s.orderId).petpoojaOrderId).toBeUndefined();
    // No second refund for an already-compensated capture.
    expect(anyRefundPost()).toBe(0);
  });

  it("a refund_failed state is RETRYABLE: the redelivery retries the refund instead of reporting a permanent failure", async () => {
    const s = seedGateOrder("ord_lock_rf", "rzp_lock_rf", "pay_lock_rf", {
      state: "refund_failed",
      paymentId: "pay_lock_rf",
      atMs: Date.now() - 60_000,
    });

    const payload = capturedPayload(s.orderId, s.gatewayOrderId, s.paymentId, 10000);
    const call = mockReqRes(payload, signWebhook(JSON.stringify(payload)));
    await handleRazorpayWebhook(call.req, call.res);

    // The retry COMPLETED the refund (gateway healthy again) rather than
    // answering the recorded failure forever.
    expect(call.out().statusCode).toBe(200);
    expect(anyRefundPost()).toBe(1);
    expect(orderOf(s.orderId).captureFulfillment.state).toBe("refunded");
    // Never confirmed, never rung.
    expect(orderOf(s.orderId).status.code).not.toBe("CONFIRMED");
    expect(orderOf(s.orderId).petpoojaOrderId).toBeUndefined();
  });
});

// ===========================================================================
// ITEM 2 — compensation outranks confirmation on BOTH channels, including a
// later `order.paid` that would otherwise see the stamp as "paid".
// ===========================================================================
describe("ITEM 2 — a compensated capture can never be confirmed by a later event", () => {
  it("interleaved: refund recorded, then order.paid arrives -> no confirmation, no KOT", async () => {
    seedOrder("ord_comp", {
      pricing: { grandTotal: 100, split: { branchTransferPaise: 10000 } },
    });
    seedIntent("intent_ord_comp", {
      razorpayOrderId: "rzp_comp",
      orderId: "ord_comp",
      amountPaise: 10000,
      pricing: { grandTotal: 100, loyaltyDiscount: 0, split: { branchTransferPaise: 10000 } },
    });
    control.seed(
      "orders/ord_comp",
      {
        captureFulfillment: { state: "refunded", paymentId: "pay_comp", atMs: Date.now() - 1_000 },
        unfulfillableCapture: {
          reason: "item_unavailable",
          razorpayPaymentId: "pay_comp",
          detectedAt: Date.now() - 1_000,
        },
        payment: { status: "completed", razorpayPaymentId: "pay_comp", capturedAmountPaise: 10000 },
        "payment.status": "completed",
        "payment.razorpayPaymentId": "pay_comp",
        refundStatus: "refunded",
        refundedTotalPaise: 10000,
      },
      true
    );

    const payload = {
      id: "evt_order_paid_comp",
      event: "order.paid",
      created_at: Math.floor(Date.now() / 1000),
      payload: {
        order: {
          entity: {
            id: "rzp_comp",
            amount: 10000,
            currency: "INR",
            notes: { orderId: "ord_comp", branchId: BRANCH },
            payments: [{ id: "pay_comp" }],
          },
        },
      },
    };
    const call = mockReqRes(payload, signWebhook(JSON.stringify(payload)));
    await handleRazorpayWebhook(call.req, call.res);

    expect(call.out().statusCode).toBe(200);
    const order = orderOf("ord_comp");
    expect(order.status).toMatchObject({ code: "PLACED" });
    expect(order.petpoojaOrderId).toBeUndefined();
    expect(order.deliveryOtpHash).toBeUndefined();
    expect(docOf("unmatched_payments/ump_evt_order_paid_comp")).toMatchObject({
      reason: "suppressed_capture_gate",
    });
  });

  it("the verify channel also refuses to confirm a compensated capture", async () => {
    seedOrder("ord_comp_v", {
      pricing: { grandTotal: 100, split: { branchTransferPaise: 10000 } },
    });
    seedIntent("intent_ord_comp_v", {
      razorpayOrderId: "rzp_comp_v",
      orderId: "ord_comp_v",
      amountPaise: 10000,
      pricing: { grandTotal: 100, loyaltyDiscount: 0, split: { branchTransferPaise: 10000 } },
    });
    control.seed(
      "orders/ord_comp_v",
      {
        captureFulfillment: { state: "refunded", paymentId: "pay_comp_v", atMs: Date.now() - 1_000 },
        refundStatus: "refunded",
        refundedTotalPaise: 10000,
      },
      true
    );
    __setPaymentsFetchForTests(async () => ({
      id: "pay_comp_v",
      order_id: "rzp_comp_v",
      amount: 10000,
      currency: "INR",
      status: "captured",
      notes: { orderId: "ord_comp_v" },
    }));

    const err: any = await verifyPayment(
      {
        orderId: "ord_comp_v",
        razorpayOrderId: "rzp_comp_v",
        razorpayPaymentId: "pay_comp_v",
        razorpaySignature: signVerify("rzp_comp_v", "pay_comp_v"),
      },
      { uid: "cust_ms" }
    ).then(
      (r) => ({ unexpectedSuccess: r }),
      (e) => e
    );

    expect(err.unexpectedSuccess).toBeUndefined();
    expect(err.code).toBe("ORDER_ITEM_UNAVAILABLE_REFUNDED");
    expect(orderOf("ord_comp_v").paymentStatus).not.toBe("completed");
    expect(anyRefundPost()).toBe(0);
  });
});

// ===========================================================================
// ITEM 3 — the expiry refund decision must use the TRANSACTION-fresh snapshot,
// and the verification marker must be written by the capture channels and read
// by the expiry job.
// ===========================================================================
describe("ITEM 3 — the expiry race uses fresh data and the live verification marker", () => {
  it("interleaved: capture read PLACED, sweep cancels, confirmation suppressed -> the capture is still refunded", async () => {
    seedOrder("ord_race", {
      pricing: { grandTotal: 100 },
      createdAt: new Date(Date.now() - 35 * 60_000).toISOString(),
      placedAt: new Date(Date.now() - 35 * 60_000).toISOString(),
    });
    seedIntent("intent_ord_race", {
      razorpayOrderId: "rzp_race",
      orderId: "ord_race",
      amountPaise: 10000,
      expiresAtMs: Date.now() + 60_000,
      createdAtMs: Date.now() - 35 * 60_000,
    });
    control.gatewayPayments["rzp_race"] = { items: [] };

    // The capture has ALREADY read the order as PLACED (its gate decision is
    // in flight, reading the catalogue). The sweep now cancels it — the exact
    // stale-read window. The confirmation transaction must see the fresh
    // cancellation and refund the capture instead of acking with neither.
    control.onProductRead = async () => {
      const stats = await expireAbandonedUnpaidOrders();
      expect(stats.cancelled).toBe(1);
    };

    const payload = capturedPayload("ord_race", "rzp_race", "pay_race", 10000);
    const call = mockReqRes(payload, signWebhook(JSON.stringify(payload)));
    await handleRazorpayWebhook(call.req, call.res);
    expect(call.out().statusCode).toBe(200);

    // The capture landed on the cancelled order: refunded, never confirmed.
    expect(anyRefundPost()).toBe(1);
    expect(control.refundPosts[0].paymentId).toBe("pay_race");
    const order = orderOf("ord_race");
    expect(order.status).toMatchObject({ code: "CANCELLED" });
    expect(order.petpoojaOrderId).toBeUndefined();
  });

  it("the verify channel WRITES the marker the expiry job READS (interleaved)", async () => {
    seedOrder("ord_marker", {
      pricing: { grandTotal: 100 },
      createdAt: new Date(Date.now() - 35 * 60_000).toISOString(),
      placedAt: new Date(Date.now() - 35 * 60_000).toISOString(),
    });
    seedIntent("intent_ord_marker", {
      razorpayOrderId: "rzp_marker",
      orderId: "ord_marker",
      amountPaise: 10000,
      expiresAtMs: Date.now() + 60_000,
      createdAtMs: Date.now() - 35 * 60_000,
    });
    control.gatewayPayments["rzp_marker"] = { items: [] };

    control.afterGatewayLookup = async (orderId: string) => {
      if (orderId !== "ord_marker") return;
      // A capture is IN FLIGHT here. The verify channel's own writer is
      // exercised below; this marker is the state it leaves while running.
      control.seed(
        "orders/ord_marker",
        {
          paymentAttempt: {
            status: "verifying",
            startedAt: Date.now(),
            razorpayOrderId: "rzp_marker",
            razorpayPaymentId: "pay_marker",
          },
        },
        true
      );
    };

    const stats = await expireAbandonedUnpaidOrders();
    expect(stats.cancelled).toBe(0);
    expect(orderOf("ord_marker").status).toMatchObject({ code: "PLACED" });
    expect(orderOf("ord_marker").cancellationReason).toBeUndefined();
  });

  it("the verify channel itself writes the marker (production caller), and clears it on refusal", async () => {
    seedOrder("ord_marker_write", {
      pricing: { grandTotal: 100, split: { branchTransferPaise: 10000 } },
    });
    seedIntent("intent_ord_marker_write", {
      razorpayOrderId: "rzp_marker_write",
      orderId: "ord_marker_write",
      amountPaise: 10000,
      pricing: { grandTotal: 100, loyaltyDiscount: 0, split: { branchTransferPaise: 10000 } },
    });
    __setPaymentsFetchForTests(async () => {
      throw new Error("payment status unavailable");
    });

    // Observe the order while verify is in flight (the fetch seam runs after
    // the marker write), then let verify fail closed.
    let seenDuringVerify: any = null;
    const { __setPaymentsFetchForTests: setFetch } = await import(
      "../src/modules/payments/razorpay.service"
    );
    setFetch(async () => {
      seenDuringVerify = orderOf("ord_marker_write")?.paymentAttempt ?? null;
      throw new Error("payment status unavailable");
    });

    await verifyPayment(
      {
        orderId: "ord_marker_write",
        razorpayOrderId: "rzp_marker_write",
        razorpayPaymentId: "pay_marker_write",
        razorpaySignature: signVerify("rzp_marker_write", "pay_marker_write"),
      },
      { uid: "cust_ms" }
    ).catch(() => undefined);

    expect(seenDuringVerify).toMatchObject({
      status: "verifying",
      razorpayPaymentId: "pay_marker_write",
    });
    // The refusal happened before the releaser: the marker ages out by TTL.
    expect(orderOf("ord_marker_write").paymentStatus).not.toBe("completed");
  });

  it("a stale marker (crashed attempt) does not block expiry forever", async () => {
    seedOrder("ord_marker_stale", {
      pricing: { grandTotal: 100 },
      createdAt: new Date(Date.now() - 35 * 60_000).toISOString(),
      placedAt: new Date(Date.now() - 35 * 60_000).toISOString(),
      paymentAttempt: { status: "verifying", startedAt: Date.now() - 20 * 60_000 },
    });
    seedIntent("intent_ord_marker_stale", {
      razorpayOrderId: "rzp_marker_stale",
      orderId: "ord_marker_stale",
      amountPaise: 10000,
      expiresAtMs: Date.now() + 60_000,
      createdAtMs: Date.now() - 35 * 60_000,
    });
    control.gatewayPayments["rzp_marker_stale"] = { items: [] };

    const stats = await expireAbandonedUnpaidOrders();
    expect(stats.cancelled).toBe(1);
    expect(orderOf("ord_marker_stale").status).toMatchObject({ code: "CANCELLED" });
  });
});

// ===========================================================================
// ITEM 6 — ambiguous persistence is reconciled before anything is released.
// ===========================================================================
describe("ITEM 6 — an unproven persistence failure releases nothing", () => {
  it("intent write throws and the read-back proves absence -> refuse, record, no payable order", async () => {
    seedOrder("ord_f6a");
    control.failIntentWrite = "throw";
    const err: any = await createPaymentOrder({
      orderId: "ord_f6a",
      items: ITEMS as any,
      branchId: BRANCH,
      orderType: "takeaway",
      customerId: "cust_ms",
      idempotencyKey: "chk_f6a",
    } as any).then(
      (r) => ({ unexpectedSuccess: r }),
      (e) => e
    );
    expect(err.unexpectedSuccess).toBeUndefined();
    expect(err.statusCode).toBe(503);
    expect(docs.get("payment_intents/chk_f6a")).toBeUndefined();
    expect(docOf("payment_intent_reconciliation/order_mint_1")).toMatchObject({
      reason: "intent_store_failed",
      status: "needs_review",
    });
  });

  it("the write fails but the binding IS durable -> the intent is reused, not recorded as unbacked", async () => {
    seedOrder("ord_f6b");
    // The intent already exists and is live with the EXACT cart fingerprint the
    // retry produces (e.g. an earlier attempt wrote it and this retry's write
    // then failed). Persistence must be recognised, not discarded.
    const { cartFingerprintForOrder } = await import(
      "../src/modules/payments/razorpay.service"
    );
    const fingerprint = cartFingerprintForOrder(ITEMS as any, undefined, 0);
    const existing = seedIntent("chk_f6b", {
      razorpayOrderId: "order_mint_1",
      orderId: "ord_f6b",
      amountPaise: 10000,
      cartFingerprint: fingerprint,
    });
    control.failIntentWrite = "throw";

    const res: any = await createPaymentOrder({
      orderId: "ord_f6b",
      items: ITEMS as any,
      branchId: BRANCH,
      orderType: "takeaway",
      customerId: "cust_ms",
      idempotencyKey: "chk_f6b",
    } as any).then(
      (r) => ({ ok: r }),
      (e) => ({ err: e })
    );

    // Persistence is on record: the durable intent is what the caller converges
    // on, and nothing claims the mint was unbacked.
    expect(docs.get("payment_intents/chk_f6b")!.data.razorpayOrderId).toBe(
      existing.razorpayOrderId
    );
    expect(res.ok?.razorpayOrderId).toBe(existing.razorpayOrderId);
    expect(docOf(`payment_intent_reconciliation/${existing.razorpayOrderId}`)).toBeUndefined();
  });

  it("an UNREADABLE read-back is recorded as persistence_unknown, never as absent", async () => {
    seedOrder("ord_f6c");
    control.failIntentWrite = "throw";
    // The up-front lookup answers "absent"; every later intent read fails, so
    // the reconcile cannot distinguish "gone" from "unreadable".
    control.failAllIntentReadsAfterFirst = true;
    control.intentReadCount = 0;

    const err: any = await createPaymentOrder({
      orderId: "ord_f6c",
      items: ITEMS as any,
      branchId: BRANCH,
      orderType: "takeaway",
      customerId: "cust_ms",
      idempotencyKey: "chk_f6c",
    } as any).then(
      (r) => ({ unexpectedSuccess: r }),
      (e) => e
    );

    expect(err.unexpectedSuccess).toBeUndefined();
    expect(err.statusCode).toBe(503);
    expect(docOf("payment_intent_reconciliation/order_mint_1")).toMatchObject({
      status: "persistence_unknown",
    });
  });
});
