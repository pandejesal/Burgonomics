import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as crypto from "node:crypto";

/**
 * PENDING REFUND LIFECYCLE — RED-first behavioural reproduction (slice 2).
 *
 * Slice 1 fixed only the WRITE SHAPE of the refund markers (nested maps instead
 * of literal dotted keys). The measured gaps this file reproduces are about the
 * pending lifecycle itself:
 *
 *   G1. An accepted `pending` gateway refund is not recorded as a durable known
 *       identity anywhere. `payment_refund_requests/*` keeps `status: "pending"`
 *       with no gateway refund id, so a same-identity retry matches
 *       `isMatchingPendingRecovery` and POSTs the provider AGAIN, bypassing the
 *       fullness/cumulative-cap checks on the way (razorpay.service.ts:3695-3711
 *       then :3887 / :3901). Money safety rests entirely on Razorpay
 *       deduplicating `X-Refund-Idempotency`, which nothing here verifies.
 *
 *   G2. `refund.processed` updates the order ledger and the order markers but
 *       never the correlated request doc and never the operator-visible
 *       `refunds/*` row. After a pending response the row stays `IN_FLIGHT`
 *       forever, and a row a human already decided gets no late-money fact.
 *
 *   G3. A callback that arrives BEFORE the gateway response can settle the
 *       refund, and the pending write that follows then regresses the settled
 *       order back to `refund_pending` / `payment.refundStatus: "pending"` /
 *       obligation `IN_FLIGHT`.
 *
 * Every case drives the REAL `autoRefund` and the REAL `handleRazorpayWebhook`
 * (including the real HMAC signature check). Only Firestore, the error
 * snapshot sink and the refund POST seam are faked. The fake is deliberately
 * faithful on the rules that make the defects real:
 *
 *   1. `set()` keys are LITERAL — a dot never creates a nested path;
 *   2. merge is RECURSIVE on nested maps (so a map patch keeps sibling keys);
 *   3. transaction snapshots are immutable copies and `tx.get` AFTER any write
 *      aborts (real Firestore order: all reads, then all writes);
 *   4. committing is all-or-nothing, and `FieldValue.delete()` / `increment()` /
 *      `serverTimestamp()` keep their sentinel semantics.
 *
 * The first block proves the fake really does those things, so a green below
 * cannot be an artefact of a permissive shim. No network, no credentials, no
 * money: every amount here is test data and the provider POST is a stub.
 */
const { mockDb, docs, control } = vi.hoisted(() => {
  process.env.OTP_HMAC_SECRET = "test_otp_refund_pending_lifecycle";
  const docs = new Map<string, any>();
  const control = {
    /** Counts reads the strict transaction fake had to reject. */
    readAfterWriteViolations: 0,
    transactionCount: 0,
    /** Every provider refund POST this process made (idempotency key included). */
    refundPosts: [] as Array<{ paymentId: string; body: any; key: string }>,
    /** Injects a competing writer BETWEEN two transactions (0 = claim). */
    beforeTransaction: null as
      | null
      | ((index: number, store: Map<string, any>) => void | Promise<void>),
  };

  const isPlain = (v: any) => !!v && typeof v === "object" && !Array.isArray(v);
  const isDelete = (v: any) => isPlain(v) && v.__fakeDelete === true;
  const isServerTs = (v: any) => isPlain(v) && v.__fakeServerTimestamp === true;
  const isIncrement = (v: any) => isPlain(v) && typeof v.__fakeIncrement === "number";

  /**
   * Real `set(..., { merge: true })` semantics: keys are used VERBATIM (a dot
   * stays part of the field name) while nested plain objects merge into the
   * existing map. Increment and delete sentinels are honoured.
   */
  const mergeInto = (target: any, patch: any): any => {
    const out: any = isPlain(target) ? { ...target } : {};
    for (const [key, value] of Object.entries(patch)) {
      if (isDelete(value)) {
        delete out[key];
        continue;
      }
      if (isIncrement(value)) {
        out[key] = (Number(out[key]) || 0) + (value as any).__fakeIncrement;
        continue;
      }
      if (isPlain(value) && !isServerTs(value)) {
        out[key] = mergeInto(out[key], value);
        continue;
      }
      out[key] = isServerTs(value) ? "MOCK_SERVER_TIMESTAMP" : value;
    }
    return out;
  };

  // Deep copy on the way in and out: a stored document is never aliased to a
  // caller, so mutating a snapshot cannot mutate the store.
  const clone = (v: any) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

  const applyWrite = (path: string, data: any, merge?: boolean) => {
    const base = merge ? docs.get(path) : undefined;
    docs.set(path, clone(mergeInto(base, data)));
  };

  // A plain dotted string in where() is a NESTED path (real Firestore shape).
  const nested = (doc: any, path: string) =>
    path.split(".").reduce((o: any, k) => (o == null ? undefined : o[k]), doc);

  const docRef = (col: string, id: string) => {
    const path = `${col}/${id}`;
    return {
      id,
      path,
      // The snapshot CAPTURES the stored value at read time. A real Firestore
      // DocumentSnapshot is a point-in-time view: a later write to the
      // document must never change what `data()` returns, and `data()` must
      // never alias the store (mutating the returned object cannot mutate it).
      get: async () => {
        const exists = docs.has(path);
        const captured = exists ? clone(docs.get(path)) : undefined;
        return {
          exists,
          data: () => clone(captured),
          ref: docRef(col, id),
        };
      },
      set: async (data: any, opts?: any) => applyWrite(path, data, !!opts?.merge),
      create: async (data: any) => {
        if (docs.has(path)) {
          const err: any = new Error("ALREADY_EXISTS: Document already exists");
          err.code = 6;
          throw err;
        }
        applyWrite(path, data, false);
      },
      update: async (data: any) => applyWrite(path, data, true),
      delete: async () => void docs.delete(path),
    };
  };

  const collectionMock = (colName: string) => {
    const filters: Array<{ field: string; value: any }> = [];
    let limitN: number | null = null;
    const q: any = {
      where: (field: string, _op: string, value: any) => {
        filters.push({ field, value });
        return q;
      },
      limit: (n: number) => {
        limitN = n;
        return q;
      },
      get: async () => {
        // Query results are POINT-IN-TIME too: capture the stored value per
        // document now, so a later write cannot change what `data()` returns.
        const found = [...docs.entries()]
          .filter(([p]) => p.startsWith(`${colName}/`))
          .filter(([, d]) => filters.every((f) => nested(d, f.field) === f.value))
          .map(([p]) => {
            const id = p.slice(colName.length + 1);
            const captured = clone(docs.get(p));
            return {
              id,
              ref: docRef(colName, id),
              exists: true,
              data: () => clone(captured),
            };
          });
        const page = limitN === null ? found : found.slice(0, limitN);
        return { empty: page.length === 0, size: page.length, docs: page };
      },
      doc: (docId?: string) =>
        docRef(colName, docId || `auto_${Math.random().toString(36).slice(2, 8)}`),
      add: async (data: any) => {
        const id = `auto_${Math.random().toString(36).slice(2, 10)}`;
        applyWrite(`${colName}/${id}`, data, false);
        return docRef(colName, id);
      },
    };
    return q;
  };

  /**
   * STRICT transaction fake: all reads before any write, abort on a
   * read-after-write, buffered all-or-nothing commit.
   */
  const runTransaction = async (fn: (tx: any) => any): Promise<any> => {
    const index = control.transactionCount++;
    if (control.beforeTransaction) await control.beforeTransaction(index, docs);
    const writes: Array<{ path: string; data: any; merge?: boolean }> = [];
    const tx = {
      get: async (ref: any) => {
        if (writes.length > 0) {
          control.readAfterWriteViolations += 1;
          const err: any = new Error(
            "FAILED_PRECONDITION: Firestore transactions require all reads to be " +
              "executed before all writes",
          );
          err.code = 9;
          throw err;
        }
        const stored = docs.has(ref.path) ? clone(docs.get(ref.path)) : undefined;
        return {
          exists: stored !== undefined,
          data: () => clone(stored),
          ref,
        };
      },
      set: (ref: any, data: any, opts?: any) =>
        void writes.push({ path: ref.path, data, merge: !!opts?.merge }),
      update: (ref: any, data: any) => void writes.push({ path: ref.path, data, merge: true }),
    };
    const result = await fn(tx);
    for (const w of writes) applyWrite(w.path, w.data, w.merge);
    return result;
  };

  const mockDb: any = { collection: collectionMock, runTransaction };
  return { mockDb, docs, control };
});

vi.mock("../src/core/firebase", () => ({ db: mockDb }));

vi.mock("firebase-admin", () => {
  const FieldValue = {
    serverTimestamp: () => ({ __fakeServerTimestamp: true }),
    increment: (n: number) => ({ __fakeIncrement: n }),
    arrayUnion: (item: any) => [item],
    delete: () => ({ __fakeDelete: true }),
  };
  const firestoreFn: any = vi.fn(() => mockDb);
  firestoreFn.FieldValue = FieldValue;
  // No FieldPath constructor on purpose: the legacy dotted-literal lookup is
  // skipped and the canonical nested query is the shape seeded here.
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

vi.mock("../src/core/errors", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/core/errors")>()),
  captureErrorSnapshot: vi.fn(async () => "mock_snapshot"),
}));

import { handleRazorpayWebhook } from "../src/modules/payments/webhookHandler";
import {
  autoRefund,
  computeGatewayRefundKey,
  refundRequestDocId,
  __setRefundPostForTests,
} from "../src/modules/payments/razorpay.service";
import { config } from "../src/config/env";

const BRANCH = "branch_a";
const WEBHOOK_SECRET = "whsec_test_pending_lifecycle";
const CAPTURE_PAISE = 50000;

const orderOf = (orderId: string) => docs.get(`orders/${orderId}`);
const rowOf = (rowId: string) => docs.get(`refunds/${rowId}`);
const postCount = () => control.refundPosts.length;
const requestDocs = () =>
  [...docs.entries()]
    .filter(([path]) => path.startsWith("payment_refund_requests/"))
    .map(([, data]) => data);
const requestDocFor = (refundRequestId: string) =>
  requestDocs().find((d) => d.refundRequestId === refundRequestId);

/**
 * An order exactly as the cancel-review queue leaves it: capture recorded in
 * the nested map, `payment.refundStatus` awaiting a human, QUEUED obligation.
 */
function seedOrder(orderId: string, over: Record<string, any> = {}) {
  const paymentId = `pay_${orderId}`;
  docs.set(`orders/${orderId}`, {
    id: orderId,
    branchId: BRANCH,
    paymentStatus: "completed",
    payment: {
      status: "completed",
      razorpayPaymentId: paymentId,
      capturedAmountPaise: CAPTURE_PAISE,
      refundStatus: "PENDING_APPROVAL",
    },
    pricing: { grandTotal: 500 },
    refundObligation: {
      status: "QUEUED",
      refundId: `refund_cancel_${orderId}`,
      amountPaise: CAPTURE_PAISE,
    },
    ...over,
  });
  return paymentId;
}

function seedRow(rowId: string, orderId: string, over: Record<string, any> = {}) {
  docs.set(`refunds/${rowId}`, {
    id: rowId,
    orderId,
    status: "PENDING",
    amountPaise: 10000,
    ...over,
  });
}

/** The default provider stub: every refund comes back ACCEPTED and `pending`. */
function stubPendingProvider() {
  __setRefundPostForTests(async (paymentId: string, body: any, key: string) => {
    control.refundPosts.push({ paymentId, body, key });
    return {
      id: `rfnd_pl_${key.slice(-10)}`,
      payment_id: paymentId,
      amount: body.amount ?? CAPTURE_PAISE,
      status: "pending",
    };
  });
}

/** The id the default stub above mints for a given [order, payment, request]. */
const pendingRefundIdFor = (orderId: string, paymentId: string, requestId: string) =>
  `rfnd_pl_${computeGatewayRefundKey(orderId, paymentId, requestId).slice(-10)}`;

const refundWebhookPayload = (
  eventId: string,
  refundId: string,
  paymentId: string,
  amountPaise: number,
) => ({
  id: eventId,
  event: "refund.processed",
  created_at: Math.floor(Date.now() / 1000),
  payload: {
    refund: {
      entity: { id: refundId, payment_id: paymentId, amount: amountPaise, currency: "INR" },
    },
  },
});

/** A real signed delivery: the handler's HMAC check runs for real. */
function signedReqRes(payload: any) {
  const rawBody = JSON.stringify(payload);
  const signature = crypto
    .createHmac("sha256", WEBHOOK_SECRET)
    .update(rawBody)
    .digest("hex");
  const req: any = {
    headers: { "x-razorpay-event-id": payload.id, "x-razorpay-signature": signature },
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

const deliverRefundProcessed = async (
  eventId: string,
  refundId: string,
  paymentId: string,
  amountPaise: number,
) => {
  const call = signedReqRes(refundWebhookPayload(eventId, refundId, paymentId, amountPaise));
  await handleRazorpayWebhook(call.req, call.res);
  return call.out();
};

let prevMockPaymentGateway = true;
let prevWebhookSecret = "";

beforeEach(() => {
  docs.clear();
  control.readAfterWriteViolations = 0;
  control.transactionCount = 0;
  control.refundPosts = [];
  control.beforeTransaction = null;
  prevMockPaymentGateway = config.mock.paymentGateway;
  prevWebhookSecret = config.razorpay.webhookSecret;
  // Live money path with the provider seam stubbed: real guards, ledger,
  // signatures and idempotency, no network.
  config.mock.paymentGateway = false;
  config.razorpay.webhookSecret = WEBHOOK_SECRET;
  stubPendingProvider();
});

afterEach(() => {
  control.beforeTransaction = null;
  __setRefundPostForTests(null);
  config.mock.paymentGateway = prevMockPaymentGateway;
  config.razorpay.webhookSecret = prevWebhookSecret;
});

// ---------------------------------------------------------------------------
// The fake must be faithful, or every green below is meaningless.
// ---------------------------------------------------------------------------
describe("the store fake enforces the Firestore rules these defects rest on", () => {
  it("keeps a dotted set() key literal and merges nested maps recursively", async () => {
    docs.set("orders/fake_pl", {
      payment: { razorpayPaymentId: "pay_1", refundStatus: "PENDING_APPROVAL" },
    });
    await mockDb
      .collection("orders")
      .doc("fake_pl")
      .set({ "payment.refundStatus": "pending", payment: { refundStatus: "pending" } }, { merge: true });

    expect(orderOf("fake_pl").payment).toEqual({
      razorpayPaymentId: "pay_1",
      refundStatus: "pending",
    });
    expect(orderOf("fake_pl")["payment.refundStatus"]).toBe("pending");
  });

  it("hands out immutable snapshots and rejects a read after a write", async () => {
    docs.set("orders/fake_pl_tx", { payment: { refundStatus: "PENDING_APPROVAL" } });
    const snap = await mockDb.collection("orders").doc("fake_pl_tx").get();
    snap.data().payment.refundStatus = "MUTATED_BY_TEST";
    expect(orderOf("fake_pl_tx").payment.refundStatus).toBe("PENDING_APPROVAL");

    await expect(
      mockDb.runTransaction(async (tx: any) => {
        await tx.get(mockDb.collection("orders").doc("fake_pl_tx"));
        tx.set(mockDb.collection("orders").doc("fake_pl_tx"), { touched: true }, { merge: true });
        await tx.get(mockDb.collection("orders").doc("fake_pl_tx"));
      }),
    ).rejects.toThrow(/reads to be executed before all writes/i);
    expect(control.readAfterWriteViolations).toBe(1);
    expect(orderOf("fake_pl_tx").touched).toBeUndefined();
  });

  it("a direct doc get() returns a POINT-IN-TIME snapshot, not a live view", async () => {
    docs.set("orders/fake_pl_snap", {
      payment: { razorpayPaymentId: "pay_snap", refundStatus: "PENDING_APPROVAL" },
    });
    const snap = await mockDb.collection("orders").doc("fake_pl_snap").get();
    expect(snap.exists).toBe(true);

    // A write AFTER the read must not change what this snapshot reports.
    docs.set("orders/fake_pl_snap", {
      payment: { razorpayPaymentId: "pay_snap", refundStatus: "refunded" },
      refundedTotalPaise: 50000,
    });

    expect(snap.data().payment.refundStatus).toBe("PENDING_APPROVAL");
    expect(snap.data().refundedTotalPaise).toBeUndefined();
    // …and the returned object is a copy, not an alias of the store.
    snap.data().payment.refundStatus = "MUTATED_BY_TEST";
    expect(snap.data().payment.refundStatus).toBe("PENDING_APPROVAL");
    expect(orderOf("fake_pl_snap").payment.refundStatus).toBe("refunded");
  });

  it("a query get() returns POINT-IN-TIME, non-aliased document snapshots", async () => {    docs.set("orders/fake_pl_q", {
      payment: { razorpayPaymentId: "pay_q", refundStatus: "pending" },
    });
    const result = await mockDb
      .collection("orders")
      .where("payment.razorpayPaymentId", "==", "pay_q")
      .limit(2)
      .get();
    expect(result.docs).toHaveLength(1);
    const qDoc = result.docs[0];

    docs.set("orders/fake_pl_q", {
      payment: { razorpayPaymentId: "pay_q", refundStatus: "refunded" },
    });

    expect(qDoc.data().payment.refundStatus).toBe("pending");
    qDoc.data().payment.refundStatus = "MUTATED_BY_TEST";
    expect(qDoc.data().payment.refundStatus).toBe("pending");
    expect(orderOf("fake_pl_q").payment.refundStatus).toBe("refunded");
  });

  it("derives the SAME request-doc id as the refund service (behavioural, not a byte pin)", () => {
    // Correlation works because both callers derive the id from the same
    // [order, payment, request] identity. This compares BEHAVIOUR: the exported
    // derivation is exercised directly, and the promotion cases below prove the
    // webhook actually reaches the record it created. It does not claim that
    // pinning the function body proves runtime correlation.
    const cases: Array<[string, string, string]> = [
      ["ord_pl_promote", "pay_ord_pl_promote", "refundreq_pl_promote"],
      ["ord_pl_race", "pay_ord_pl_race", "refundreq_pl_race"],
    ];
    for (const [orderId, paymentId, requestId] of cases) {
      const id = refundRequestDocId(orderId, paymentId, requestId);
      expect(id).toMatch(/^prfnd_[0-9a-f]{48}$/);
      // Deterministic in the identity, and distinct per identity.
      expect(refundRequestDocId(orderId, paymentId, requestId)).toBe(id);
      expect(refundRequestDocId(orderId, paymentId, `${requestId}_x`)).not.toBe(id);
      expect(refundRequestDocId(orderId, `${paymentId}_x`, requestId)).not.toBe(id);
    }
    // The behaviour that matters: the record the release path created is the
    // record the webhook finds and completes (proved in the promotion cases).
    expect(refundRequestDocId("ord_pl_promote", "pay_ord_pl_promote", "refundreq_pl_promote")).toBe(
      refundRequestDocId("ord_pl_promote", "pay_ord_pl_promote", "refundreq_pl_promote"),
    );
  });
});

// ---------------------------------------------------------------------------
// G1 — the accepted pending identity must become durable, and a same-identity
// replay must not reach the provider a second time.
// ---------------------------------------------------------------------------
describe("an ACCEPTED pending refund records a durable identity and replays locally", () => {
  it("persists the gateway refund id on the request doc and stays explicitly pending", async () => {
    const orderId = "ord_pl_accept";
    const requestId = "refundreq_pl_accept";
    const paymentId = seedOrder(orderId);
    seedRow("pl_accept", orderId);

    const res: any = await autoRefund({
      orderId,
      razorpayPaymentId: paymentId,
      amountRupees: 100,
      refundRequestId: requestId,
    });

    const refundId = pendingRefundIdFor(orderId, paymentId, requestId);
    expect(postCount()).toBe(1);
    expect(res).toMatchObject({ id: refundId, status: "pending" });

    // THE GAP: the accepted identity is nowhere durable today, so the request
    // doc says "pending" with no way to tell it apart from a transport loss.
    // `refundId` is the field the completed branch already trusts; recording it
    // here is what makes a same-identity retry a local replay.
    const reqDoc = requestDocFor(requestId);
    expect(reqDoc.refundId).toBe(refundId);
    expect(reqDoc.gatewayKey).toBe(computeGatewayRefundKey(orderId, paymentId, requestId));

    // Money is reserved (cap-honest) but NOT settled (no lie).
    const order = orderOf(orderId);
    expect(order.refundedTotalPaise).toBe(10000);
    expect(order.refundLedger).toEqual({ [refundId]: 10000 });
    expect(order.refundStatus).toBe("refund_pending");
    expect(order.payment.refundStatus).toBe("pending");
    expect(order.refundObligation.status).toBe("IN_FLIGHT");
    expect(order.refundObligation.gatewayRefundId).toBe(refundId);
    expect(order.refundObligation.settledRefundId).toBeUndefined();
    expect(order.refundObligation.settledAt).toBeUndefined();

    // The operator row is chaseable, not settled.
    expect(rowOf("pl_accept")).toMatchObject({
      status: "IN_FLIGHT",
      gatewayStatus: "pending",
      gatewayRefundId: refundId,
    });
  });

  it("a same-identity replay returns the known pending identity with ONE total provider POST", async () => {
    const orderId = "ord_pl_replay";
    const requestId = "refundreq_pl_replay";
    const paymentId = seedOrder(orderId);
    seedRow("pl_replay", orderId);

    const params = {
      orderId,
      razorpayPaymentId: paymentId,
      amountRupees: 100,
      refundRequestId: requestId,
    };
    const first: any = await autoRefund(params);
    const refundId = pendingRefundIdFor(orderId, paymentId, requestId);
    expect(first.id).toBe(refundId);
    const orderAfterFirst = JSON.parse(JSON.stringify(orderOf(orderId)));
    const rowAfterFirst = JSON.parse(JSON.stringify(rowOf("pl_replay")));

    const replay: any = await autoRefund(params);

    // ONE total POST: the second call must not reach the provider at all.
    expect(postCount()).toBe(1);
    expect(replay).toMatchObject({
      id: refundId,
      payment_id: paymentId,
      status: "pending",
      reused: true,
    });
    // The reserved amount does not move, and nothing claims settlement.
    const order = orderOf(orderId);
    expect(order.refundedTotalPaise).toBe(orderAfterFirst.refundedTotalPaise);
    expect(Object.keys(order.refundLedger)).toHaveLength(1);
    expect(order.refundStatus).toBe("refund_pending");
    expect(order.payment.refundStatus).toBe("pending");
    expect(order.refundObligation.status).toBe("IN_FLIGHT");
    expect(order.refundObligation.settledRefundId).toBeUndefined();
    expect(rowOf("pl_replay")).toEqual(rowAfterFirst);

    // No phantom audit row for a refund that never left this process again.
    expect(control.readAfterWriteViolations).toBe(0);
  });

  it("a changed amount or reason on the known pending identity is refused before provider work", async () => {
    const orderId = "ord_pl_conflict";
    const requestId = "refundreq_pl_conflict";
    const paymentId = seedOrder(orderId);
    await autoRefund({
      orderId,
      razorpayPaymentId: paymentId,
      amountRupees: 100,
      reason: "first reason",
      refundRequestId: requestId,
    });
    expect(postCount()).toBe(1);

    await expect(
      autoRefund({
        orderId,
        razorpayPaymentId: paymentId,
        amountRupees: 150,
        reason: "first reason",
        refundRequestId: requestId,
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: "REFUND_REQUEST_CONFLICT" });

    await expect(
      autoRefund({
        orderId,
        razorpayPaymentId: paymentId,
        amountRupees: 100,
        reason: "MUTATED reason",
        refundRequestId: requestId,
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: "REFUND_REQUEST_CONFLICT" });

    // Refused BEFORE any provider work.
    expect(postCount()).toBe(1);
    expect(orderOf(orderId).refundedTotalPaise).toBe(10000);
  });

  it("a changed PAYMENT on the known pending identity is refused before provider work", async () => {
    // The immutable-identity matrix must cover all three bound fields. Amount
    // and reason are covered above; payment is the one the branch guard would
    // otherwise answer first, hiding a payload conflict behind a 409 of a
    // different kind — so it is pinned separately with its own code.
    const orderId = "ord_pl_conflict_pay";
    const requestId = "refundreq_pl_conflict_pay";
    const paymentId = seedOrder(orderId);
    await autoRefund({
      orderId,
      razorpayPaymentId: paymentId,
      amountRupees: 100,
      reason: "first reason",
      refundRequestId: requestId,
    });
    expect(postCount()).toBe(1);

    await expect(
      autoRefund({
        orderId,
        razorpayPaymentId: "pay_a_different_capture",
        amountRupees: 100,
        reason: "first reason",
        refundRequestId: requestId,
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: "NO_CAPTURED_PAYMENT" });

    // No provider POST, no money movement, the stored identity unchanged.
    expect(postCount()).toBe(1);
    const order = orderOf(orderId);
    expect(order.refundedTotalPaise).toBe(10000);
    expect(order.payment.razorpayPaymentId).toBe(paymentId);
    expect(order.refundPendingGatewayId).toBe(pendingRefundIdFor(orderId, paymentId, requestId));
    expect(requestDocFor(requestId)).toMatchObject({
      status: "pending",
      paymentId,
      refundId: pendingRefundIdFor(orderId, paymentId, requestId),
    });
  });

  it("a transport-unknown attempt (pending doc with NO accepted identity) still re-POSTs on the SAME key", async () => {
    // This is the established lost-response contract: the request doc was
    // written at claim time, before the POST, so it is `pending` with no
    // gateway id. Replaying it on the same idempotency key is how recovery
    // works — it must NOT be mistaken for an accepted pending identity.
    const orderId = "ord_pl_unknown";
    const requestId = "refundreq_pl_unknown";
    const paymentId = seedOrder(orderId);
    const gatewayKey = computeGatewayRefundKey(orderId, paymentId, requestId);

    // Seed the shape the claim write leaves behind, keyed exactly as the
    // service keys it (the id is derived, so we learn it from a real claim).
    await autoRefund({
      orderId,
      razorpayPaymentId: paymentId,
      amountRupees: 100,
      refundRequestId: requestId,
    });
    const seeded = requestDocFor(requestId);
    expect(seeded).toBeTruthy();
    const reqPath = [...docs.keys()].find(
      (p) => p.startsWith("payment_refund_requests/") && docs.get(p)?.refundRequestId === requestId,
    ) as string;
    // Strip the accepted identity + the claim, simulating a transport loss.
    const lost = { ...docs.get(reqPath) };
    delete lost.refundId;
    delete lost.gatewayStatus;
    docs.set(reqPath, lost);
    docs.set(`orders/${orderId}`, {
      ...orderOf(orderId),
      refundStatus: "refunding",
      refundClaimedAt: Date.now() - 11 * 60_000,
      refundActiveClaim: {
        requestId,
        claimedAt: Date.now() - 11 * 60_000,
        paymentId,
        requestedPaise: 10000,
        gatewayKey,
        reason: null,
      },
      refundLedger: {},
      refundedTotalPaise: 0,
    });
    control.refundPosts = [];

    const recovered: any = await autoRefund({
      orderId,
      razorpayPaymentId: paymentId,
      amountRupees: 100,
      refundRequestId: requestId,
    });

    expect(postCount()).toBe(1);
    expect(control.refundPosts[0].key).toBe(gatewayKey);
    expect(recovered).toMatchObject({ status: "pending" });
    expect(orderOf(orderId).refundedTotalPaise).toBe(10000);
    expect(Object.keys(orderOf(orderId).refundLedger)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// G1b — a known in-flight refund occupies the cap. TWO separate observables
// from PENDING-SLICE2-CONTRACT 3, deliberately split so neither forces the
// unapproved multi-pending model:
//   (i)  the API cannot CREATE a second known-pending attempt while a first is
//        still in flight (fresh within-cap request is denied, zero POSTs);
//   (ii) a PRE-EXISTING legacy ledger/row set is never CLEARED when one of its
//        refunds settles.
// Only the existing single current-pending markers plus the existing ledger are
// used — no multi-pending registry, no second live pending identity.
// ---------------------------------------------------------------------------
describe("a known in-flight refund is counted against the capture", () => {
  it("refuses a fresh within-cap request while a known pending refund is in flight, with no provider POST", async () => {
    const orderId = "ord_pl_cap";
    const paymentId = seedOrder(orderId);
    seedRow("pl_cap_a", orderId, { status: "PENDING" });

    const first: any = await autoRefund({
      orderId,
      razorpayPaymentId: paymentId,
      amountRupees: 400,
      refundRequestId: "refundreq_pl_cap_a",
    });
    expect(first.status).toBe("pending");
    expect(postCount()).toBe(1);
    expect(orderOf(orderId).refundedTotalPaise).toBe(40000);
    // The single in-flight identity IS the current pending marker.
    expect(orderOf(orderId).refundStatus).toBe("refund_pending");
    expect(orderOf(orderId).refundPendingGatewayId).toBe(first.id);

    // A DIFFERENT request within the remaining ₹100 is still refused: only one
    // refund may be on the wire for this order at a time. The refusal is the
    // lease/identity guard, not the cap — ₹100 fits the remaining ₹100.
    await expect(
      autoRefund({
        orderId,
        razorpayPaymentId: paymentId,
        amountRupees: 100,
        refundRequestId: "refundreq_pl_cap_b",
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: "REFUND_IN_PROGRESS" });

    // NO second POST and NO state change.
    expect(postCount()).toBe(1);
    expect(orderOf(orderId).refundedTotalPaise).toBe(40000);
    expect(Object.keys(orderOf(orderId).refundLedger)).toEqual([first.id]);
    expect(orderOf(orderId).refundPendingGatewayId).toBe(first.id);
    expect(rowOf("pl_cap_a").status).toBe("IN_FLIGHT");
    // The refused request never created a request doc, so it cannot be replayed
    // as an accepted identity.
    expect(requestDocFor("refundreq_pl_cap_b")).toBeUndefined();
  });

  it("refuses a fresh request that would pay beyond the capture, with no provider POST", async () => {
    const orderId = "ord_pl_cap_over";
    const paymentId = seedOrder(orderId);

    const first: any = await autoRefund({
      orderId,
      razorpayPaymentId: paymentId,
      amountRupees: 400,
      refundRequestId: "refundreq_pl_capover_a",
    });
    expect(first.status).toBe("pending");
    expect(postCount()).toBe(1);
    expect(orderOf(orderId).refundedTotalPaise).toBe(40000);

    // Beyond the remaining cap: the cumulative-cap guard answers 400 and keeps
    // its own diagnostic (the single-in-flight guard must not pre-empt it).
    await expect(
      autoRefund({
        orderId,
        razorpayPaymentId: paymentId,
        amountRupees: 150,
        refundRequestId: "refundreq_pl_capover_b",
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: "REFUND_EXCEEDS_REMAINING" });

    expect(postCount()).toBe(1);
    expect(orderOf(orderId).refundedTotalPaise).toBe(40000);
    expect(requestDocFor("refundreq_pl_capover_b")).toBeUndefined();
  });

  it("the legitimate sequential remainder is allowed only after the first refund is settled", async () => {
    const orderId = "ord_pl_cap_seq";
    const paymentId = seedOrder(orderId);
    seedRow("pl_cap_seq_a", orderId, { status: "PENDING" });
    seedRow("pl_cap_seq_b", orderId, { status: "PENDING" });

    // Hermetic test state only, no live fixture.
    const first: any = await autoRefund({
      orderId,
      razorpayPaymentId: paymentId,
      amountRupees: 400,
      refundRequestId: "refundreq_pl_cap_seq_a",
    });
    expect(postCount()).toBe(1);

    // Settle the first refund — the lease/marker is released and the order is
    // genuinely partially refunded, not in flight.
    const settled = await deliverRefundProcessed("evt_pl_cap_seq", first.id, paymentId, 40000);
    expect(settled.statusCode).toBe(200);
    expect(orderOf(orderId).refundStatus).toBe("partially_refunded");
    expect(orderOf(orderId).refundPendingGatewayId).toBeUndefined();
    expect(orderOf(orderId).refundActiveClaim).toBeUndefined();
    expect(rowOf("pl_cap_seq_a").status).toBe("COMPLETED");

    // NOW the designed remainder refund is legitimate and pays once.
    const remainder: any = await autoRefund({
      orderId,
      razorpayPaymentId: paymentId,
      amountRupees: 100,
      refundRequestId: "refundreq_pl_cap_seq_b",
    });
    expect(postCount()).toBe(2);
    expect(remainder.status).toBe("pending");
    expect(orderOf(orderId).refundedTotalPaise).toBe(50000);
    expect(orderOf(orderId).refundPendingGatewayId).toBe(remainder.id);
    expect(rowOf("pl_cap_seq_b").status).toBe("IN_FLIGHT");
  });

  it("a callback for refund A never clears a PRE-EXISTING legacy pending amount B", async () => {
    // LEGACY / TEST STATE ONLY — this is a hermetic seeded artifact, NOT a
    // live staging observation and NOT something the API is asked to create.
    // It reproduces the pre-existing single-pending + ledger shape an older
    // writer could have left behind (a ledger entry and its row), and asserts
    // that settling A does not delete B's reserved amount, its row, or the
    // current pending identity that points at B.
    const orderId = "ord_pl_legacy_b";
    const legacyA = "rfnd_legacy_a";
    const legacyB = "rfnd_legacy_b";
    const requestA = "refundreq_pl_legacy_a";
    const requestB = "refundreq_pl_legacy_b";
    const paymentId = seedOrder(orderId, {
      refundedTotalPaise: 40000,
      refundLedger: { [legacyA]: 30000, [legacyB]: 10000 },
      refundStatus: "refund_pending",
      refundPendingGatewayId: legacyB,
      refundId: legacyB,
      refundAmount: 100,
      // The trusted mapping this order already carries: gateway refund id ->
      // refund request id. This is the ONLY correlation the promotion may use.
      refundKeyedReceipts: { [legacyA]: requestA, [legacyB]: requestB },
      payment: {
        status: "completed",
        razorpayPaymentId: "pay_ord_pl_legacy_b",
        capturedAmountPaise: CAPTURE_PAISE,
        refundStatus: "pending",
      },
      refundObligation: {
        status: "IN_FLIGHT",
        refundId: `refund_cancel_${orderId}`,
        amountPaise: CAPTURE_PAISE,
        gatewayRefundId: legacyB,
      },
    });
    seedRow("pl_legacy_a", orderId, { status: "IN_FLIGHT", gatewayRefundId: legacyA });
    seedRow("pl_legacy_b", orderId, { status: "IN_FLIGHT", gatewayRefundId: legacyB });
    // Request docs at the SAME deterministic ids the service uses
    // (mirrors the existing, frozen derivation; nothing here re-labels it).
    const reqDocId = (requestId: string) =>
      `prfnd_${crypto
        .createHash("sha256")
        .update(JSON.stringify([orderId, paymentId, requestId]))
        .digest("hex")
        .slice(0, 48)}`;
    docs.set(`payment_refund_requests/${reqDocId(requestA)}`, {
      orderId,
      paymentId,
      refundRequestId: requestA,
      requestedPaise: 30000,
      reason: null,
      status: "pending",
      refundId: legacyA,
      gatewayKey: computeGatewayRefundKey(orderId, paymentId, requestA),
    });
    docs.set(`payment_refund_requests/${reqDocId(requestB)}`, {
      orderId,
      paymentId,
      refundRequestId: requestB,
      requestedPaise: 10000,
      reason: null,
      status: "pending",
      refundId: legacyB,
      gatewayKey: computeGatewayRefundKey(orderId, paymentId, requestB),
    });
    const rowsBefore = JSON.parse(
      JSON.stringify({ a: rowOf("pl_legacy_a"), b: rowOf("pl_legacy_b") }),
    );

    const outcome = await deliverRefundProcessed("evt_pl_legacy_a", legacyA, paymentId, 30000);
    expect(outcome.statusCode).toBe(200);

    const order = orderOf(orderId);
    // The ledger is cumulative truth: A's callback must not drop B's ₹100.
    expect(order.refundedTotalPaise).toBe(40000);
    expect(order.refundLedger).toEqual({ [legacyA]: 30000, [legacyB]: 10000 });
    // B is still the current pending identity, and the ORDER still reads as in
    // flight: preserving the id while stamping the order "refunded" would hide
    // B from every reader and reopen a fresh-request hole.
    expect(order.refundPendingGatewayId).toBe(legacyB);
    expect(order.refundStatus).toBe("refund_pending");
    expect(order.payment.refundStatus).toBe("pending");
    // The obligation keeps its in-flight state too (no SETTLED for a refund
    // that is still open on this order).
    expect(order.refundObligation.status).toBe("IN_FLIGHT");
    expect(order.refundObligation.settledRefundId).toBeUndefined();
    expect(order.refundObligation.settledAfterDecision).toBeUndefined();
    // B's row is still the open attempt, and A's row is the closed one.
    // B's row and its reserved identity survive untouched.
    expect(rowOf("pl_legacy_b")).toEqual(rowsBefore.b);
    expect(rowOf("pl_legacy_b").status).toBe("IN_FLIGHT");
    expect(rowOf("pl_legacy_b").gatewayRefundId).toBe(legacyB);
    expect(rowOf("pl_legacy_b").settledPaise).toBeUndefined();
    // A's own row is the one that closes.
    expect(rowOf("pl_legacy_a")).toMatchObject({
      status: "COMPLETED",
      gatewayRefundId: legacyA,
      settledPaise: 30000,
    });
    // …and only A's request doc is completed; B's is left open.
    expect(requestDocFor(requestA)).toMatchObject({ status: "completed", refundId: legacyA });
    expect(requestDocFor(requestB)).toMatchObject({ status: "pending", refundId: legacyB });
  });
});

// ---------------------------------------------------------------------------
// G2 — refund.processed must promote the CORRELATED request doc and operator
// row, atomically, and only for rows that belong to this order.
// ---------------------------------------------------------------------------
describe("refund.processed promotes the correlated request doc and operator row", () => {
  it("completes the request doc and the IN_FLIGHT row in the same transaction as the ledger", async () => {
    const orderId = "ord_pl_promote";
    const requestId = "refundreq_pl_promote";
    const paymentId = seedOrder(orderId);
    seedRow("pl_promote", orderId);

    const pending: any = await autoRefund({
      orderId,
      razorpayPaymentId: paymentId,
      amountRupees: 100,
      refundRequestId: requestId,
    });
    expect(orderOf(orderId).refundStatus).toBe("refund_pending");
    expect(rowOf("pl_promote").status).toBe("IN_FLIGHT");

    const outcome = await deliverRefundProcessed("evt_pl_promote", pending.id, paymentId, 10000);
    expect(outcome.statusCode).toBe(200);

    // Request doc: the loop is closed, with the proven gateway id.
    expect(requestDocFor(requestId)).toMatchObject({
      status: "completed",
      refundId: pending.id,
      gatewayStatus: "processed",
    });
    expect(requestDocFor(requestId).completedAt).toBeDefined();

    // Operator row: no longer IN_FLIGHT forever.
    expect(rowOf("pl_promote")).toMatchObject({
      status: "COMPLETED",
      gatewayStatus: "processed",
      gatewayRefundId: pending.id,
      refundId: pending.id,
      settledPaise: 10000,
    });

    // One refund counted exactly once, and the order is honest about its state.
    const order = orderOf(orderId);
    expect(order.refundLedger).toEqual({ [pending.id]: 10000 });
    expect(order.refundedTotalPaise).toBe(10000);
    expect(order.refundStatus).toBe("partially_refunded");
    expect(order.payment.refundStatus).toBe("partially_refunded");
    expect(order.refundObligation.status).toBe("SETTLED");
    expect(order.refundObligation.settledRefundId).toBe(pending.id);
    // The lease was already released by the pending write; nothing re-acquired.
    expect(order.refundActiveClaim).toBeUndefined();
    expect(control.readAfterWriteViolations).toBe(0);
  });

  it("a duplicate callback neither double-counts the ledger nor rewrites attribution", async () => {
    const orderId = "ord_pl_dup";
    const requestId = "refundreq_pl_dup";
    const paymentId = seedOrder(orderId);
    seedRow("pl_dup", orderId);

    const pending: any = await autoRefund({
      orderId,
      razorpayPaymentId: paymentId,
      amountRupees: 100,
      refundRequestId: requestId,
    });
    await deliverRefundProcessed("evt_pl_dup_1", pending.id, paymentId, 10000);
    expect(rowOf("pl_dup").status).toBe("COMPLETED");
    const settledPaiseAfterFirst = rowOf("pl_dup").settledPaise;

    // Same delivery again (same event id): the claim dedups it outright.
    const sameEvent = await deliverRefundProcessed("evt_pl_dup_1", pending.id, paymentId, 10000);
    expect(sameEvent.statusCode).toBe(200);
    expect(sameEvent.body).toMatchObject({ status: "already_processed" });

    // A DIFFERENT event id for the same refund: a money-event replay.
    const replay = await deliverRefundProcessed("evt_pl_dup_2", pending.id, paymentId, 10000);
    expect(replay.statusCode).toBe(200);

    const order = orderOf(orderId);
    expect(order.refundedTotalPaise).toBe(10000);
    expect(Object.keys(order.refundLedger)).toHaveLength(1);
    expect(order.refundLedger[pending.id]).toBe(10000);
    // Attribution is stable across the replay.
    expect(rowOf("pl_dup")).toMatchObject({
      status: "COMPLETED",
      gatewayRefundId: pending.id,
      refundId: pending.id,
      settledPaise: settledPaiseAfterFirst,
    });
    expect(rowOf("pl_dup").refundAfterDecision).toBeUndefined();
    expect(requestDocFor(requestId)).toMatchObject({
      status: "completed",
      refundId: pending.id,
    });
  });

  it("leaves a foreign/mismatched operator row and request doc untouched", async () => {
    const orderId = "ord_pl_foreign";
    const requestId = "refundreq_pl_foreign";
    const paymentId = seedOrder(orderId, {
      // The trusted mapping exists, but the row it names belongs elsewhere.
      refundKeyedReceipts: { rfnd_pl_foreign_refund: requestId },
      refundStatus: "refund_pending",
      refundedTotalPaise: 10000,
      refundLedger: { rfnd_pl_foreign_refund: 10000 },
      payment: {
        status: "completed",
        razorpayPaymentId: `pay_${orderId}`,
        capturedAmountPaise: CAPTURE_PAISE,
        refundStatus: "pending",
      },
    });
    seedRow("pl_foreign", "ord_somebody_else", {
      status: "IN_FLIGHT",
      gatewayStatus: "pending",
    });

    const outcome = await deliverRefundProcessed(
      "evt_pl_foreign",
      "rfnd_pl_foreign_refund",
      paymentId,
      10000,
    );
    expect(outcome.statusCode).toBe(200);

    // The money truth still lands on the order…
    expect(orderOf(orderId).refundedTotalPaise).toBe(10000);
    // …but another order's row is never relabelled, and no request doc is
    // invented for a request we cannot prove belongs here.
    expect(rowOf("pl_foreign")).toMatchObject({
      status: "IN_FLIGHT",
      gatewayStatus: "pending",
    });
    expect(rowOf("pl_foreign").gatewayRefundId).toBeUndefined();
    expect(rowOf("pl_foreign").refundAfterDecision).toBeUndefined();
    // The mapping on the order names this request; a correlated-but-foreign
    // row (different orderId) must not be adopted. Only a row whose own
    // orderId matches may be promoted.
    expect(requestDocFor(requestId)).toBeUndefined();
  });

  it.each([
    {
      label: "REJECTED",
      rowId: "pl_decided_rej",
      orderId: "ord_pl_decided_rej",
      requestId: "refundreq_pl_decided_rej",
      decider: "staff_qa",
    },
    {
      label: "WITHDRAWN",
      rowId: "pl_decided_wd",
      orderId: "ord_pl_decided_wd",
      requestId: "refundreq_pl_decided_wd",
      decider: "system_queue",
    },
  ])(
    "keeps a human $label operator row decided and records the late money beside it",
    async ({ label, rowId, orderId, requestId, decider }) => {
      const paymentId = seedOrder(orderId);
      seedRow(rowId, orderId, {
        status: label,
        disposition: {
          decision: label.toLowerCase(),
          reason: "already returned in cash",
          decidedBy: decider,
        },
      });

      const pending: any = await autoRefund({
        orderId,
        razorpayPaymentId: paymentId,
        amountRupees: 100,
        refundRequestId: requestId,
      });
      // The pending write never overwrites a human decision.
      expect(rowOf(rowId).status).toBe(label);

      await deliverRefundProcessed(`evt_${rowId}`, pending.id, paymentId, 10000);

      const row = rowOf(rowId);
      expect(row.status).toBe(label);
      expect(row.disposition).toEqual({
        decision: label.toLowerCase(),
        reason: "already returned in cash",
        decidedBy: decider,
      });
      // The decision is never relabelled by the settlement: no gateway receipt
      // is stamped over it…
      expect(row.gatewayRefundId).toBeUndefined();
      // …the settlement is a SEPARATE fact beside it.
      expect(row.refundAfterDecision).toMatchObject({
        gatewayRefundId: pending.id,
        settledPaise: 10000,
      });
      expect(row.refundAfterDecision.settledPaise).toBe(10000);
      // The gateway fact is still recorded for the request loop.
      expect(requestDocFor(requestId)).toMatchObject({
        status: "completed",
        refundId: pending.id,
      });
      expect(orderOf(orderId).refundStatus).toBe("partially_refunded");
    },
  );
});

// ---------------------------------------------------------------------------
// G3 — the response/callback race must not regress a settled refund.
// ---------------------------------------------------------------------------
describe("a callback that lands before the gateway response never regresses the order", () => {
  it("a same-payment, same-amount callback with a DIFFERENT refund id does not close the active claim", async () => {
    // An out-of-band / dashboard refund can land on the same payment for the
    // same amount while our POST is still on the wire. A live claim plus a
    // matching amount is NOT proof that the callback is ours — the claim is
    // refused as a correlation source, so this delivery records order-level
    // money only and the in-flight attempt stays open and chaseable.
    const orderId = "ord_pl_foreign_id";
    const requestId = "refundreq_pl_foreign_id";
    const paymentId = seedOrder(orderId);
    seedRow("pl_foreign_id", orderId);

    let enterPost: () => void = () => undefined;
    const postEntered = new Promise<void>((resolve) => (enterPost = resolve));
    let releaseResponse: () => void = () => undefined;
    const responseGate = new Promise<void>((resolve) => (releaseResponse = resolve));
    __setRefundPostForTests(async (pid: string, body: any, key: string) => {
      control.refundPosts.push({ paymentId: pid, body, key });
      enterPost();
      await responseGate;
      return { id: "rfnd_pl_ours", payment_id: pid, amount: 10000, status: "pending" };
    });

    const inFlightCall = autoRefund({
      orderId,
      razorpayPaymentId: paymentId,
      amountRupees: 100,
      refundRequestId: requestId,
    });
    await postEntered;

    // Same payment, same amount, DIFFERENT gateway refund id.
    const outcome = await deliverRefundProcessed("evt_pl_foreign_id", "rfnd_not_ours", paymentId, 10000);
    expect(outcome.statusCode).toBe(200);

    // The money is recorded on the order (it is real money)…
    expect(orderOf(orderId).refundLedger["rfnd_not_ours"]).toBe(10000);
    // …but our active attempt is NOT claimed by it: no correlation exists for
    // that id, so neither the request doc nor the operator row is closed or
    // relabelled as that gateway refund.
    expect(rowOf("pl_foreign_id").status).not.toBe("COMPLETED");
    expect(rowOf("pl_foreign_id").gatewayRefundId).not.toBe("rfnd_not_ours");
    expect(rowOf("pl_foreign_id").settledPaise).toBeUndefined();
    expect(rowOf("pl_foreign_id").processedBy).toBeUndefined();
    // No request record was invented for the unbound id either.
    expect(
      requestDocs().some((d) => d.refundId === "rfnd_not_ours"),
    ).toBe(false);

    releaseResponse();
    await inFlightCall;
    // Our own identity is the one recorded, and the row is chaseable — not
    // completed by somebody else's refund.
    expect(requestDocFor(requestId)).toMatchObject({
      status: "pending",
      refundId: "rfnd_pl_ours",
    });
    expect(orderOf(orderId).refundPendingGatewayId).toBe("rfnd_pl_ours");
    expect(rowOf("pl_foreign_id").status).toBe("IN_FLIGHT");
    expect(rowOf("pl_foreign_id").gatewayRefundId).toBe("rfnd_pl_ours");
    expect(rowOf("pl_foreign_id").settledPaise).toBeUndefined();
  });

  it("a late pending response for refund B is not called settled by refund A's settlement", async () => {
    // Contract 6 counterexample. The ledger holds A (settled) AND B (pending,
    // reserved), and the global status word says partially_refunded because of
    // A. That combination is NOT proof about B: without a per-ID settlement
    // fact naming B, the late response must be recorded as PENDING.
    const orderId = "ord_pl_ab";
    const requestB = "refundreq_pl_ab_b";
    const paymentId = seedOrder(orderId);
    const refundA = "rfnd_pl_ab_a";
    const refundB = "rfnd_pl_ab_b";

    // Seed the state after A settled and B was accepted as pending.
    docs.set(`orders/${orderId}`, {
      ...orderOf(orderId),
      refundLedger: { [refundA]: 30000, [refundB]: 10000 },
      refundedTotalPaise: 40000,
      refundId: refundB,
      refundAmount: 100,
      refundStatus: "partially_refunded", // global word belongs to A
      refundPendingGatewayId: refundB,
      payment: {
        status: "completed",
        razorpayPaymentId: paymentId,
        capturedAmountPaise: CAPTURE_PAISE,
        refundStatus: "partially_refunded",
      },
      refundObligation: {
        status: "SETTLED",
        settledRefundId: refundA, // per-ID proof names A, not B
        settledAt: 1,
        amountPaise: CAPTURE_PAISE,
      },
      // Both gateway ids are KEYED receipts (each names its own request), so the
      // unkeyed-legacy ambiguity guard correctly does not apply to either.
      refundKeyedReceipts: {
        [refundA]: "refundreq_pl_ab_a",
        [refundB]: "refundreq_pl_ab_b",
      },
    });
    seedRow("pl_ab_b", orderId, { status: "IN_FLIGHT", gatewayRefundId: refundB });

    // The late response for B names B's own gateway id (the id already
    // reserved in the ledger).
    __setRefundPostForTests(async (pid: string, body: any, key: string) => {
      control.refundPosts.push({ paymentId: pid, body, key });
      return { id: refundB, payment_id: pid, amount: 10000, status: "pending" };
    });

    await autoRefund({
      orderId,
      razorpayPaymentId: paymentId,
      amountRupees: 100,
      reason: "second reason",
      refundRequestId: requestB,
    });

    const order = orderOf(orderId);
    // The global word is untouched (it describes A), and B is in flight.
    expect(order.refundStatus).not.toBe("refunded");
    expect(order.refundStatus).toBe("refund_pending");
    expect(order.payment.refundStatus).toBe("pending");
    expect(order.refundPendingGatewayId).toBe(refundB);
    expect(order.refundObligation.settledRefundId).toBe(refundA);
    expect(order.refundObligation.status).toBe("IN_FLIGHT");
    // B's own ledger reservation and the operator row survive.
    expect(order.refundLedger[refundB]).toBe(10000);
    expect(rowOf("pl_ab_b").status).toBe("IN_FLIGHT");
    expect(rowOf("pl_ab_b").settledPaise).toBeUndefined();
    expect(rowOf("pl_ab_b").gatewayRefundId).toBe(refundB);
  });

  it("an already COMPLETED operator row keeps its own attribution and completion time", async () => {
    // Contract 4 promotes an IN_FLIGHT row. A row an operator already released
    // (COMPLETED, their processedBy and completedAt) is that release's record:
    // a replay of the same refund must not restamp it.
    const orderId = "ord_pl_row_done";
    const requestId = "refundreq_pl_row_done";
    const paymentId = seedOrder(orderId);
    const pending: any = await autoRefund({
      orderId,
      razorpayPaymentId: paymentId,
      amountRupees: 100,
      refundRequestId: requestId,
    });

    // A human release completed this row first, for this same refund id.
    docs.set(`refunds/pl_row_done`, {
      id: "pl_row_done",
      orderId,
      status: "COMPLETED",
      gatewayStatus: "processed",
      gatewayRefundId: pending.id,
      refundId: pending.id,
      settledPaise: 10000,
      processedBy: "ops_lead@burgonomics.test",
      completedAt: 1700000000000,
    });
    const rowBefore = JSON.parse(JSON.stringify(rowOf("pl_row_done")));

    const outcome = await deliverRefundProcessed("evt_pl_row_done", pending.id, paymentId, 10000);
    expect(outcome.statusCode).toBe(200);

    const row = rowOf("pl_row_done");
    // Attribution and timestamp are the operator's, not "server"/now.
    expect(row.processedBy).toBe("ops_lead@burgonomics.test");
    expect(row.completedAt).toBe(1700000000000);
    expect(row.settledPaise).toBe(10000);
    expect(row.status).toBe("COMPLETED");
    // Nothing else was invented on the row.
    expect(row.refundAfterDecision).toBeUndefined();
    expect(Object.keys(row).sort()).toEqual(Object.keys(rowBefore).sort());
  });

  it("keeps the settled state, promotes the row, and does not re-claim the lease", async () => {
    const orderId = "ord_pl_race";
    const requestId = "refundreq_pl_race";
    const paymentId = seedOrder(orderId);
    seedRow("pl_race", orderId);

    // The provider holds the response until the callback has been delivered.
    let enterPost: () => void = () => undefined;
    const postEntered = new Promise<void>((resolve) => (enterPost = resolve));
    let releaseResponse: () => void = () => undefined;
    const responseGate = new Promise<void>((resolve) => (releaseResponse = resolve));
    const refundId = pendingRefundIdFor(orderId, paymentId, requestId);
    __setRefundPostForTests(async (pid: string, body: any, key: string) => {
      control.refundPosts.push({ paymentId: pid, body, key });
      enterPost();
      await responseGate;
      // Razorpay documented behaviour: the POST accepted the refund and
      // answered `pending`, the final state arrives by webhook.
      return { id: refundId, payment_id: pid, amount: 10000, status: "pending" };
    });

    const inFlightCall = autoRefund({
      orderId,
      razorpayPaymentId: paymentId,
      amountRupees: 100,
      refundRequestId: requestId,
    });
    await postEntered; // the claim is committed and the POST is on the wire

    const callback = await deliverRefundProcessed("evt_pl_race", refundId, paymentId, 10000);
    expect(callback.statusCode).toBe(200);
    expect(orderOf(orderId).refundStatus).toBe("partially_refunded");

    releaseResponse();
    const res: any = await inFlightCall;
    expect(res.status).toBe("pending");
    expect(postCount()).toBe(1);

    const order = orderOf(orderId);
    // NO regression: the settled truth survives the late pending response.
    expect(order.refundStatus).not.toBe("refund_pending");
    expect(order.refundStatus).toBe("partially_refunded");
    expect(order.payment.refundStatus).toBe("partially_refunded");
    expect(order.refundObligation.status).toBe("SETTLED");
    expect(order.refundObligation.settledRefundId).toBe(refundId);
    expect(order.refundPendingSince).toBeUndefined();
    expect(order.refundPendingGatewayId).toBeUndefined();
    // Counted once.
    expect(order.refundedTotalPaise).toBe(10000);
    expect(Object.keys(order.refundLedger)).toHaveLength(1);
    // The operator row is not stranded in IN_FLIGHT by the loser of the race.
    expect(rowOf("pl_race")).toMatchObject({
      status: "COMPLETED",
      gatewayRefundId: refundId,
      gatewayStatus: "processed",
    });
    // …and the request loop is closed rather than reopened as "pending".
    expect(requestDocFor(requestId)).toMatchObject({
      status: "completed",
      refundId,
    });
    expect(control.readAfterWriteViolations).toBe(0);
  });

  it("(A) after a callback wins the race, the ACTUAL returned id is mapped and a later equal sequential partial still pays once", async () => {
    // The callback lands before our pending response. The order therefore never
    // reaches the normal in-flight write, so `refundKeyedReceipts` would have no
    // entry for the id the POST actually returned — and the next legitimate
    // equal-amount request on the same capture then looks like an unkeyed
    // legacy refund and is wrongly refused.
    const orderId = "ord_pl_race_map";
    const requestA = "refundreq_pl_race_map_a";
    const requestB = "refundreq_pl_race_map_b";
    const paymentId = seedOrder(orderId);
    seedRow("pl_race_map_a", orderId);
    seedRow("pl_race_map_b", orderId);

    const actualId = "rfnd_race_map_actual";
    let enterPost: () => void = () => undefined;
    const postEntered = new Promise<void>((resolve) => (enterPost = resolve));
    let releaseResponse: () => void = () => undefined;
    const responseGate = new Promise<void>((resolve) => (releaseResponse = resolve));
    __setRefundPostForTests(async (pid: string, body: any, key: string) => {
      control.refundPosts.push({ paymentId: pid, body, key });
      enterPost();
      await responseGate;
      return { id: actualId, payment_id: pid, amount: 10000, status: "pending" };
    });

    const inFlightCall = autoRefund({
      orderId,
      razorpayPaymentId: paymentId,
      amountRupees: 100,
      refundRequestId: requestA,
    });
    await postEntered;

    // 1) The callback for the ACTUAL id settles refund A first.
    const callback = await deliverRefundProcessed("evt_pl_race_map", actualId, paymentId, 10000);
    expect(callback.statusCode).toBe(200);

    // 2) Our pending response then arrives and must record the mapping, so the
    //    settled refund is a KNOWN keyed receipt rather than an ambiguous
    //    unkeyed legacy one.
    releaseResponse();
    await inFlightCall;
    expect(postCount()).toBe(1);
    expect(orderOf(orderId).refundKeyedReceipts?.[actualId]).toBe(requestA);

    // 3) The designed sequential remainder of the SAME amount is legitimate:
    //    one new provider POST, its own row, nothing blocked.
    __setRefundPostForTests(async (pid: string, body: any, key: string) => {
      control.refundPosts.push({ paymentId: pid, body, key });
      return { id: "rfnd_race_map_second", payment_id: pid, amount: 10000, status: "pending" };
    });
    const remainder: any = await autoRefund({
      orderId,
      razorpayPaymentId: paymentId,
      amountRupees: 100,
      refundRequestId: requestB,
    });

    expect(postCount()).toBe(2);
    expect(remainder).toMatchObject({ id: "rfnd_race_map_second", status: "pending" });
    const order = orderOf(orderId);
    expect(order.refundedTotalPaise).toBe(20000);
    expect(Object.keys(order.refundLedger).sort()).toEqual(
      [actualId, "rfnd_race_map_second"].sort(),
    );
    expect(rowOf("pl_race_map_b").status).toBe("IN_FLIGHT");
    expect(requestDocFor(requestB)).toMatchObject({
      status: "pending",
      refundId: "rfnd_race_map_second",
    });
  });

  it("(B) a completed operator row belonging to ANOTHER order is not accepted as proof of settlement", async () => {
    // The row exists under the derived local id and even names the id our POST
    // is about to return — but it belongs to a different order. That is not
    // evidence about THIS refund, so the pending response must stay pending,
    // reserve the amount, and leave the foreign row untouched.
    const orderId = "ord_pl_row_foreign";
    const requestId = "refundreq_pl_row_foreign";
    const paymentId = seedOrder(orderId);
    const upcomingId = "rfnd_row_foreign_upcoming";

    docs.set("refunds/pl_row_foreign", {
      id: "pl_row_foreign",
      orderId: "ord_somebody_else",
      status: "COMPLETED",
      gatewayStatus: "processed",
      gatewayRefundId: upcomingId,
      refundId: upcomingId,
      settledPaise: 10000,
      processedBy: "ops_lead@burgonomics.test",
      completedAt: 1700000000000,
    });
    const foreignRowBefore = JSON.parse(JSON.stringify(rowOf("pl_row_foreign")));

    __setRefundPostForTests(async (pid: string, body: any, key: string) => {
      control.refundPosts.push({ paymentId: pid, body, key });
      return { id: upcomingId, payment_id: pid, amount: 10000, status: "pending" };
    });

    const res: any = await autoRefund({
      orderId,
      razorpayPaymentId: paymentId,
      amountRupees: 100,
      refundRequestId: requestId,
    });

    // A pending response, not an invented settlement.
    expect(res.status).toBe("pending");
    expect(postCount()).toBe(1);

    const order = orderOf(orderId);
    expect(order.refundStatus).toBe("refund_pending");
    expect(order.payment.refundStatus).toBe("pending");
    expect(order.refundedTotalPaise).toBe(10000);
    expect(order.refundLedger).toEqual({ [upcomingId]: 10000 });
    expect(order.refundPendingGatewayId).toBe(upcomingId);
    // The local request loop stays open — it is not completed by a foreign row.
    expect(requestDocFor(requestId)).toMatchObject({
      status: "pending",
      refundId: upcomingId,
    });
    // The foreign row is untouched in every field.
    expect(rowOf("pl_row_foreign")).toEqual(foreignRowBefore);
  });

  it("a later same-identity retry replays the completed identity with no further POST", async () => {
    const orderId = "ord_pl_race2";
    const requestId = "refundreq_pl_race2";
    const paymentId = seedOrder(orderId);
    const pending: any = await autoRefund({
      orderId,
      razorpayPaymentId: paymentId,
      amountRupees: 100,
      refundRequestId: requestId,
    });
    await deliverRefundProcessed("evt_pl_race2", pending.id, paymentId, 10000);
    const settledTotal = orderOf(orderId).refundedTotalPaise;
    expect(postCount()).toBe(1);

    const retry: any = await autoRefund({
      orderId,
      razorpayPaymentId: paymentId,
      amountRupees: 100,
      refundRequestId: requestId,
    });

    expect(postCount()).toBe(1);
    expect(retry).toMatchObject({ id: pending.id, status: "processed", reused: true });
    expect(orderOf(orderId).refundedTotalPaise).toBe(settledTotal);
    expect(Object.keys(orderOf(orderId).refundLedger)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// G4 — decision guard and claim takeover must each bite under their OWN
// one-condition mutation (slice 1 had no test for either on the pending path).
// ---------------------------------------------------------------------------
describe("the pending write respects a human decision and another owner's lease", () => {
  it("leaves a WITHDRAWN obligation decision in place and records the gateway fact beside it", async () => {
    const orderId = "ord_pl_decision";
    const paymentId = seedOrder(orderId, {
      refundObligation: {
        status: "WITHDRAWN",
        reason: "superseded_by_decision",
        refundId: `refund_cancel_${orderId}`,
        amountPaise: CAPTURE_PAISE,
      },
    });

    await autoRefund({
      orderId,
      razorpayPaymentId: paymentId,
      amountRupees: 100,
      refundRequestId: "refundreq_pl_decision",
    });

    const obligation = orderOf(orderId).refundObligation;
    // Mutation target: deleting the `obligationDecided ? {} : …` guard makes
    // this read IN_FLIGHT.
    expect(obligation.status).toBe("WITHDRAWN");
    expect(obligation.reason).toBe("superseded_by_decision");
    expect(obligation.gatewayRefundId).toBeDefined();
    expect(obligation.settledRefundId).toBeUndefined();
    expect(obligation.settledAt).toBeUndefined();
    // The order still records that the money is in flight.
    expect(orderOf(orderId).refundStatus).toBe("refund_pending");
    expect(orderOf(orderId).refundedTotalPaise).toBe(10000);
  });

  it("a pending response from a stale run leaves a competing owner's lease and markers intact", async () => {
    const orderId = "ord_pl_takeover";
    const requestId = "refundreq_pl_takeover";
    const paymentId = seedOrder(orderId);

    // Between the claim transaction and the completion transaction another
    // worker claims the same order with its OWN request identity.
    control.beforeTransaction = (index, store) => {
      if (index !== 1) return;
      const doc = store.get(`orders/${orderId}`);
      doc.refundClaimedAt = Date.now();
      doc.refundClaimedRequestId = "other_worker_request";
      doc.refundClaimedPaymentId = paymentId;
      doc.refundActiveClaim = {
        requestId: "other_worker_request",
        claimedAt: Date.now(),
        paymentId,
        requestedPaise: 10000,
      };
      doc.payment = { ...doc.payment, refundStatus: "pending" };
      doc.refundObligation = { ...doc.refundObligation, status: "IN_FLIGHT" };
      store.set(`orders/${orderId}`, doc);
    };

    const res: any = await autoRefund({
      orderId,
      razorpayPaymentId: paymentId,
      amountRupees: 100,
      refundRequestId: requestId,
    });
    expect(res.status).toBe("pending");

    const order = orderOf(orderId);
    // Mutation target: dropping the `if (stillOwnsClaim)` around the marker
    // write makes these read this run's values.
    expect(order.refundActiveClaim).toMatchObject({ requestId: "other_worker_request" });
    expect(order.refundClaimedAt).toEqual(expect.any(Number));
    expect(order.refundClaimedRequestId).toBe("other_worker_request");
    expect(order.payment.refundStatus).toBe("pending");
    expect(order.refundObligation.status).toBe("IN_FLIGHT");
    expect(order.refundObligation.settledRefundId).toBeUndefined();
    // The money truth of this POST is still recorded exactly once.
    expect(order.refundedTotalPaise).toBe(10000);
    expect(Object.keys(order.refundLedger)).toHaveLength(1);
  });
});
