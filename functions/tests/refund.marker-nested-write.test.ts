import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * REFUND MARKER WRITE SHAPE — behavioural reproduction.
 *
 * Defect. The refund release (`autoRefund`) and the `refund.processed` webhook
 * both wrote the two markers the console and the customer card read as
 * DOTTED KEYS inside a merge-set:
 *
 *   tx.set(orderRef, { "payment.refundStatus": "pending" }, { merge: true })
 *   tx.set(orderRef, { "refundObligation.status": "IN_FLIGHT" }, { merge: true })
 *
 * Firestore `set()` treats every key as a LITERAL field name; dotted paths are
 * `update()` syntax. So both writes created sibling fields literally NAMED
 * "payment.refundStatus" / "refundObligation.status" and left the nested
 * `payment.refundStatus` and `refundObligation.status` values stale:
 *
 *   payment.refundStatus     "PENDING_APPROVAL"  (stale — console says awaiting a human)
 *   refundObligation.status  "QUEUED"            (stale — obligation looks unclaimed)
 *   "payment.refundStatus"   "pending"           (junk literal field nobody reads)
 *
 * The store fake below is deliberately faithful on the exact three rules that
 * make this a bug rather than a style nit:
 *   1. `set()` keys are LITERAL — a dot never creates a nested path;
 *   2. merge is RECURSIVE on nested maps (so a nested map patch preserves the
 *      sibling keys of that map, and cannot be mistaken for a full replace);
 *   3. transaction snapshots are immutable copies, and `tx.get` AFTER any write
 *      aborts (real Firestore order: all reads, then all writes).
 *
 * The first describe block proves the fake really does those three things, so a
 * green below cannot be an artefact of a permissive shim.
 *
 * Only Firestore, `captureErrorSnapshot` and the refund POST seam are faked. The
 * release routine, the webhook handler, the claim guards and the status
 * vocabulary are the real code. No network, no credentials, no money.
 */
const { mockDb, docs, control } = vi.hoisted(() => {
  process.env.OTP_HMAC_SECRET = "test_otp_refund_marker_nested";
  const docs = new Map<string, any>();
  const control = {
    // Counts reads the strict transaction fake had to reject.
    readAfterWriteViolations: 0,
    transactionCount: 0,
    /** Injects a competing writer between transactions (0 = claim, 1 = completion). */
    beforeTransaction: null as null | ((index: number, store: Map<string, any>) => void),
  };

  const isPlain = (v: any) => !!v && typeof v === "object" && !Array.isArray(v);
  const isDelete = (v: any) => isPlain(v) && v.__fakeDelete === true;
  const isServerTs = (v: any) => isPlain(v) && v.__fakeServerTimestamp === true;

  /**
   * Recursive merge that honours real `set(..., { merge: true })` semantics:
   * keys are used VERBATIM (a dot stays part of the field name) while nested
   * plain-object values merge into the existing map.
   */
  const mergeInto = (target: any, patch: any): any => {
    const out: any = isPlain(target) ? { ...target } : {};
    for (const [key, value] of Object.entries(patch)) {
      if (isDelete(value)) {
        delete out[key];
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
  // caller's object, so mutating a snapshot cannot mutate the store.
  const clone = (v: any) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

  const applyWrite = (path: string, data: any, merge?: boolean) => {
    const base = merge ? docs.get(path) : undefined;
    docs.set(path, clone(mergeInto(base, data)));
  };

  const nested = (doc: any, path: string) =>
    path.split(".").reduce((o: any, k) => (o == null ? undefined : o[k]), doc);

  const docRef = (col: string, id: string) => {
    const path = `${col}/${id}`;
    return {
      id,
      path,
      get: async () => ({
        exists: docs.has(path),
        data: () => clone(docs.get(path)),
        ref: docRef(col, id),
      }),
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
      // Real Firestore parses a dotted string in where() as a NESTED path.
      where: (field: string, _op: string, value: any) => {
        filters.push({ field, value });
        return q;
      },
      limit: (n: number) => {
        limitN = n;
        return q;
      },
      get: async () => {
        const found = [...docs.entries()]
          .filter(([p]) => p.startsWith(`${colName}/`))
          .filter(([, d]) => filters.every((f) => nested(d, f.field) === f.value))
          .map(([p]) => ({ id: p.slice(colName.length + 1), ref: docRef(colName, p.slice(colName.length + 1)), exists: true, data: () => clone(docs.get(p)) }));
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
   * STRICT transaction fake. Firestore runs all reads before any write, and
   * aborts on a read-after-write; committing is all-or-nothing.
   * `control.beforeTransaction(index)` lets a test inject a competing writer
   * BETWEEN two transactions (index 0 = claim, 1 = completion).
   */
  const runTransaction = async (fn: (tx: any) => any): Promise<any> => {
    const index = control.transactionCount++;
    control.beforeTransaction?.(index, docs);
    const writes: Array<{ path: string; data: any; merge?: boolean }> = [];
    const tx = {
      get: async (ref: any) => {
        if (writes.length > 0) {
          control.readAfterWriteViolations += 1;
          const err: any = new Error(
            "FAILED_PRECONDITION: Firestore transactions require all reads to be " +
              "executed before all writes"
          );
          err.code = 9;
          throw err;
        }
        const stored = docs.get(ref.path);
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
    increment: (n: number) => n,
    arrayUnion: (item: any) => [item],
    delete: () => ({ __fakeDelete: true }),
  };
  const firestoreFn: any = vi.fn(() => mockDb);
  firestoreFn.FieldValue = FieldValue;
  // No FieldPath constructor on purpose: the handler falls back to the
  // canonical nested query, which is the shape these tests seed and assert.
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
  __setRefundPostForTests,
} from "../src/modules/payments/razorpay.service";
import { config } from "../src/config/env";

const BRANCH = "branch_a";
const staff = {
  uid: "staff_1",
  email: "staff@burgonomics.test",
  role: "branch_staff",
  branchIds: [BRANCH],
};

const orderOf = (orderId: string) => docs.get(`orders/${orderId}`);

/**
 * An order exactly as the cancel-review queue leaves it: capture recorded in
 * the nested map, `payment.refundStatus` awaiting a human, and a QUEUED
 * cancellation obligation pointing at the review row.
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
      capturedAmountPaise: 50000,
      refundStatus: "PENDING_APPROVAL",
    },
    pricing: { grandTotal: 500 },
    refundObligation: {
      status: "QUEUED",
      refundId: `refund_cancel_${orderId}`,
      amountPaise: 50000,
    },
    ...over,
  });
  return paymentId;
}

const refundWebhookPayload = (
  eventId: string,
  refundId: string,
  paymentId: string,
  amountPaise: number
) => ({
  id: eventId,
  event: "refund.processed",
  payload: {
    refund: { entity: { id: refundId, payment_id: paymentId, amount: amountPaise, currency: "INR" } },
  },
});

function mockReqRes(payload: any) {
  const req: any = { headers: { "x-razorpay-event-id": payload.id }, body: payload };
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

describe("the store fake enforces the three Firestore rules that expose the bug", () => {
  beforeEach(() => docs.clear());

  it("treats a dotted set() key as a literal field name, never a nested path", async () => {
    docs.set("orders/fake_dotted", { payment: { refundStatus: "PENDING_APPROVAL" } });
    await mockDb
      .collection("orders")
      .doc("fake_dotted")
      .set({ "payment.refundStatus": "pending" }, { merge: true });

    const doc = orderOf("fake_dotted");
    expect(doc.payment.refundStatus).toBe("PENDING_APPROVAL"); // nested: untouched
    expect(doc["payment.refundStatus"]).toBe("pending"); // literal sibling
  });

  it("merges nested maps recursively so a map patch keeps sibling keys", async () => {
    docs.set("orders/fake_merge", {
      payment: { razorpayPaymentId: "pay_1", capturedAmountPaise: 50000 },
      refundObligation: { status: "QUEUED", refundId: "refund_cancel_fake_merge" },
    });
    await mockDb
      .collection("orders")
      .doc("fake_merge")
      .set({ payment: { refundStatus: "pending" } }, { merge: true });

    const doc = orderOf("fake_merge");
    expect(doc.payment).toEqual({
      razorpayPaymentId: "pay_1",
      capturedAmountPaise: 50000,
      refundStatus: "pending",
    });
  });

  it("hands out immutable snapshots and rejects a read after a write", async () => {
    docs.set("orders/fake_tx", { payment: { refundStatus: "PENDING_APPROVAL" } });
    const snap = await mockDb.collection("orders").doc("fake_tx").get();
    snap.data().payment.refundStatus = "MUTATED_BY_TEST";
    expect(orderOf("fake_tx").payment.refundStatus).toBe("PENDING_APPROVAL");

    await expect(
      mockDb.runTransaction(async (tx: any) => {
        await tx.get(mockDb.collection("orders").doc("fake_tx"));
        tx.set(mockDb.collection("orders").doc("fake_tx"), { touched: true }, { merge: true });
        await tx.get(mockDb.collection("orders").doc("fake_tx"));
      })
    ).rejects.toThrow(/reads to be executed before all writes/i);
    expect(control.readAfterWriteViolations).toBe(1);
    expect(orderOf("fake_tx").touched).toBeUndefined();
  });
});

describe("a PENDING gateway refund parks the order in flight (nested markers)", () => {
  let prevMock = true;
  beforeEach(() => {
    docs.clear();
    prevMock = config.mock.paymentGateway;
    config.mock.paymentGateway = false; // live path; only the POST seam is stubbed
    __setRefundPostForTests(async (paymentId: string, _body: any, _key: string) => ({
      id: `rfnd_pending_${paymentId}`,
      payment_id: paymentId,
      amount: 10000,
      status: "pending",
    }));
  });
  afterEach(() => {
    __setRefundPostForTests(null);
    config.mock.paymentGateway = prevMock;
  });

  it("writes payment.refundStatus = pending, not a literal dotted sibling", async () => {
    const paymentId = seedOrder("ord_mk_pending");

    const res: any = await autoRefund({
      orderId: "ord_mk_pending",
      razorpayPaymentId: paymentId,
      amountRupees: 100,
      refundRequestId: "refundreq_row_pending",
    });

    expect(res.status).toBe("pending");
    const doc = orderOf("ord_mk_pending");
    expect(doc.payment.refundStatus).toBe("pending");
    expect(doc.refundStatus).toBe("refund_pending");
  });

  it("writes refundObligation.status = IN_FLIGHT with the gateway refund id", async () => {
    const paymentId = seedOrder("ord_mk_pending_ob");

    await autoRefund({
      orderId: "ord_mk_pending_ob",
      razorpayPaymentId: paymentId,
      amountRupees: 100,
      refundRequestId: "refundreq_row_pending_ob",
    });

    const obligation = orderOf("ord_mk_pending_ob").refundObligation;
    expect(obligation.status).toBe("IN_FLIGHT");
    expect(obligation.gatewayRefundId).toBe(`rfnd_pending_${paymentId}`);
    expect(obligation.pendingSince).toBe("MOCK_SERVER_TIMESTAMP");
    // In flight is NOT settled: no settlement stamp may exist yet.
    expect(obligation.settledRefundId).toBeUndefined();
    expect(obligation.settledAt).toBeUndefined();
  });

  it("introduces no literal dotted keys and preserves unrelated payment/obligation keys", async () => {
    const paymentId = seedOrder("ord_mk_pending_shape");

    await autoRefund({
      orderId: "ord_mk_pending_shape",
      razorpayPaymentId: paymentId,
      amountRupees: 100,
      refundRequestId: "refundreq_row_pending_shape",
    });

    const doc = orderOf("ord_mk_pending_shape");
    // No junk sibling fields: the markers must live where every reader looks.
    expect(Object.keys(doc)).not.toContain("payment.refundStatus");
    expect(Object.keys(doc)).not.toContain("refundObligation.status");
    expect(Object.keys(doc)).not.toContain("refundObligation.gatewayRefundId");
    expect(Object.keys(doc)).not.toContain("refundObligation.pendingSince");
    // Unrelated truth is untouched.
    expect(doc.payment.razorpayPaymentId).toBe(paymentId);
    expect(doc.payment.capturedAmountPaise).toBe(50000);
    expect(doc.pricing.grandTotal).toBe(500);
    expect(doc.refundObligation.refundId).toBe("refund_cancel_ord_mk_pending_shape");
    expect(doc.refundObligation.amountPaise).toBe(50000);
    // The gateway accepted the amount, so it still counts against the cap.
    expect(doc.refundedTotalPaise).toBe(10000);
    // …and the lease is released (an in-flight refund is chaseable, not claimed).
    expect(doc.refundClaimedAt).toBeUndefined();
    expect(doc.refundActiveClaim).toBeUndefined();
  });
});

describe("a PROCESSED gateway refund settles the nested markers", () => {
  let prevMock = true;
  beforeEach(() => {
    docs.clear();
    control.transactionCount = 0;
    control.beforeTransaction = null;
    prevMock = config.mock.paymentGateway;
    config.mock.paymentGateway = false;
  });
  afterEach(() => {
    control.beforeTransaction = null;
    __setRefundPostForTests(null);
    config.mock.paymentGateway = prevMock;
  });

  it("writes the computed status into payment.refundStatus (state honesty kept)", async () => {
    const paymentId = seedOrder("ord_mk_settled");
    __setRefundPostForTests(async () => ({
      id: `rfnd_done_${paymentId}`,
      payment_id: paymentId,
      amount: 10000,
      status: "processed",
    }));

    await autoRefund({
      orderId: "ord_mk_settled",
      razorpayPaymentId: paymentId,
      amountRupees: 100,
      refundRequestId: "refundreq_row_settled",
    });

    const doc = orderOf("ord_mk_settled");
    // ₹100 of a ₹500 capture: partial, and the nested marker must say so
    // rather than leave the PENDING_APPROVAL the queue wrote.
    expect(doc.refundStatus).toBe("partially_refunded");
    expect(doc.payment.refundStatus).toBe("partially_refunded");
  });

  it("settles the obligation with the proven gateway refund id", async () => {
    const paymentId = seedOrder("ord_mk_settled_ob");
    __setRefundPostForTests(async () => ({
      id: `rfnd_done_${paymentId}`,
      payment_id: paymentId,
      amount: 10000,
      status: "processed",
    }));

    await autoRefund({
      orderId: "ord_mk_settled_ob",
      razorpayPaymentId: paymentId,
      amountRupees: 100,
      refundRequestId: "refundreq_row_settled_ob",
    });

    const obligation = orderOf("ord_mk_settled_ob").refundObligation;
    expect(obligation.status).toBe("SETTLED");
    expect(obligation.settledRefundId).toBe(`rfnd_done_${paymentId}`);
    expect(obligation.settledAt).toBe("MOCK_SERVER_TIMESTAMP");
    // The queue's own identity survives the settlement.
    expect(obligation.refundId).toBe("refund_cancel_ord_mk_settled_ob");
    expect(obligation.amountPaise).toBe(50000);
  });

  it("introduces no literal dotted keys on the settled write", async () => {
    const paymentId = seedOrder("ord_mk_settled_shape");
    __setRefundPostForTests(async () => ({
      id: `rfnd_done_${paymentId}`,
      payment_id: paymentId,
      amount: 10000,
      status: "processed",
    }));

    await autoRefund({
      orderId: "ord_mk_settled_shape",
      razorpayPaymentId: paymentId,
      amountRupees: 100,
      refundRequestId: "refundreq_row_settled_shape",
    });

    const doc = orderOf("ord_mk_settled_shape");
    for (const key of Object.keys(doc)) {
      expect(key.includes(".")).toBe(false);
    }
    expect(doc.payment.razorpayPaymentId).toBe(paymentId);
    expect(doc.payment.capturedAmountPaise).toBe(50000);
  });
});

describe("the refund.processed webhook settles the same nested markers", () => {
  let prevMock = false;
  beforeEach(() => {
    docs.clear();
    prevMock = config.mock.paymentGateway;
    config.mock.paymentGateway = true; // webhook mock branch: no signature needed
  });
  afterEach(() => {
    config.mock.paymentGateway = prevMock;
  });

  it("clears the in-flight markers and settles the obligation", async () => {
    const paymentId = seedOrder("ord_wh_settle", {
      payment: {
        status: "completed",
        razorpayPaymentId: "pay_ord_wh_settle",
        capturedAmountPaise: 50000,
        refundStatus: "pending",
      },
      refundObligation: {
        status: "IN_FLIGHT",
        gatewayRefundId: "rfnd_wh_pending",
        refundId: "refund_cancel_ord_wh_settle",
        amountPaise: 50000,
      },
      refundPendingSince: 1700000000000,
      refundPendingGatewayId: "rfnd_wh_pending",
    });

    const call = mockReqRes(
      refundWebhookPayload("evt_mk_wh_1", "rfnd_wh_done", paymentId, 40000)
    );
    await handleRazorpayWebhook(call.req, call.res);

    expect(call.out().statusCode).toBe(200);
    const doc = orderOf("ord_wh_settle");
    expect(doc.payment.refundStatus).toBe("partially_refunded");
    expect(doc.refundObligation.status).toBe("SETTLED");
    expect(doc.refundObligation.settledRefundId).toBe("rfnd_wh_done");
    expect(doc.refundObligation.settledAt).toBe("MOCK_SERVER_TIMESTAMP");
    // In-flight stamps are gone, not merely shadowed by a literal sibling.
    expect(doc.refundPendingSince).toBeUndefined();
    expect(doc.refundPendingGatewayId).toBeUndefined();
    // Unrelated truth is untouched.
    expect(doc.payment.capturedAmountPaise).toBe(50000);
    expect(doc.refundObligation.refundId).toBe("refund_cancel_ord_wh_settle");
  });

  it("introduces no literal dotted keys on the webhook settlement", async () => {
    const paymentId = seedOrder("ord_wh_shape");

    const call = mockReqRes(
      refundWebhookPayload("evt_mk_wh_2", "rfnd_wh_shape", paymentId, 10000)
    );
    await handleRazorpayWebhook(call.req, call.res);

    expect(call.out().statusCode).toBe(200);
    const doc = orderOf("ord_wh_shape");
    for (const key of Object.keys(doc)) {
      expect(key.includes(".")).toBe(false);
    }
    expect(doc.payment.refundStatus).toBe("partially_refunded");
    expect(doc.refundObligation.status).toBe("SETTLED");
  });
});

describe("the claim-owner guard keeps a takeover from rewriting another worker's lease", () => {
  let prevMock = true;
  beforeEach(() => {
    docs.clear();
    control.transactionCount = 0;
    control.beforeTransaction = null;
    prevMock = config.mock.paymentGateway;
    config.mock.paymentGateway = false;
  });
  afterEach(() => {
    control.beforeTransaction = null;
    __setRefundPostForTests(null);
    config.mock.paymentGateway = prevMock;
  });

  it("a stale-run takeover leaves the competing owner's markers and lease intact", async () => {
    const paymentId = seedOrder("ord_takeover");

    // Between the claim transaction and the completion transaction another
    // worker claims the same order with its OWN request identity.
    control.beforeTransaction = (index, store) => {
      if (index !== 1) return;
      const doc = store.get("orders/ord_takeover");
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
      store.set("orders/ord_takeover", doc);
    };

    __setRefundPostForTests(async () => ({
      id: `rfnd_takeover_${paymentId}`,
      payment_id: paymentId,
      amount: 10000,
      status: "processed",
    }));

    await autoRefund({
      orderId: "ord_takeover",
      razorpayPaymentId: paymentId,
      amountRupees: 100,
      refundRequestId: "refundreq_ord_takeover",
    }).catch(() => undefined);

    const doc = orderOf("ord_takeover");
    // The money and the recorded total still move (that is the point of the
    // takeover), but the OTHER owner's lease is not destroyed…
    expect(doc.refundActiveClaim).toMatchObject({ requestId: "other_worker_request" });
    expect(doc.refundClaimedAt).toEqual(expect.any(Number));
    // …and this run does not relabel their in-flight state as settled.
    expect(doc.payment.refundStatus).toBe("pending");
    expect(doc.refundObligation.status).toBe("IN_FLIGHT");
    expect(doc.refundObligation.settledRefundId).toBeUndefined();
    expect(doc.refundedTotalPaise).toBe(10000);
  });
});

describe("a human decision is never rewritten by machine completion", () => {
  let prevMock = true;
  beforeEach(() => {
    docs.clear();
    control.transactionCount = 0;
    control.beforeTransaction = null;
    prevMock = config.mock.paymentGateway;
    config.mock.paymentGateway = false;
  });
  afterEach(() => {
    __setRefundPostForTests(null);
    config.mock.paymentGateway = prevMock;
  });

  const processed = (paymentId: string) =>
    __setRefundPostForTests(async () => ({
      id: `rfnd_after_${paymentId}`,
      payment_id: paymentId,
      amount: 10000,
      status: "processed",
    }));

  it("keeps a REJECTED refunds row and records the late money fact", async () => {
    const paymentId = seedOrder("ord_hd_rej");
    docs.set("refunds/row_hd_rej", {
      id: "row_hd_rej",
      orderId: "ord_hd_rej",
      status: "REJECTED",
      amountPaise: 10000,
      disposition: { decision: "rejected", reason: "already refunded in cash", decidedBy: "staff_qa" },
    });
    processed(paymentId);

    await autoRefund(
      {
        orderId: "ord_hd_rej",
        razorpayPaymentId: paymentId,
        amountRupees: 100,
        refundRequestId: "refundreq_row_hd_rej",
      },
      staff
    );

    const row = docs.get("refunds/row_hd_rej");
    expect(row.status).toBe("REJECTED");
    expect(row.disposition).toEqual({
      decision: "rejected",
      reason: "already refunded in cash",
      decidedBy: "staff_qa",
    });
    expect(row.gatewayRefundId).toBeUndefined();
    expect(row.refundAfterDecision).toMatchObject({
      gatewayRefundId: `rfnd_after_${paymentId}`,
      settledPaise: 10000,
      processedBy: "staff@burgonomics.test",
    });
    // The money is still recorded on the order — a decision never hides it.
    expect(orderOf("ord_hd_rej").refundedTotalPaise).toBe(10000);
  });

  it("keeps a WITHDRAWN refunds row and records the late money fact", async () => {
    const paymentId = seedOrder("ord_hd_wd");
    docs.set("refunds/row_hd_wd", {
      id: "row_hd_wd",
      orderId: "ord_hd_wd",
      status: "WITHDRAWN",
      withdrawReason: "superseded_by_decision",
      amountPaise: 10000,
    });
    processed(paymentId);

    await autoRefund(
      {
        orderId: "ord_hd_wd",
        razorpayPaymentId: paymentId,
        amountRupees: 100,
        refundRequestId: "refundreq_row_hd_wd",
      },
      staff
    );

    const row = docs.get("refunds/row_hd_wd");
    expect(row.status).toBe("WITHDRAWN");
    expect(row.withdrawReason).toBe("superseded_by_decision");
    expect(row.refundAfterDecision).toMatchObject({
      gatewayRefundId: `rfnd_after_${paymentId}`,
      settledPaise: 10000,
    });
  });

  it("keeps a WITHDRAWN obligation decision while exposing the settled money", async () => {
    const paymentId = seedOrder("ord_hd_ob_wd", {
      refundObligation: {
        status: "WITHDRAWN",
        refundId: "refund_cancel_ord_hd_ob_wd",
        reason: "superseded_by_decision",
        amountPaise: 50000,
      },
    });
    processed(paymentId);

    await autoRefund(
      {
        orderId: "ord_hd_ob_wd",
        razorpayPaymentId: paymentId,
        amountRupees: 100,
        refundRequestId: "refundreq_row_hd_ob_wd",
      },
      staff
    );

    const obligation = orderOf("ord_hd_ob_wd").refundObligation;
    // The decision stands…
    expect(obligation.status).toBe("WITHDRAWN");
    expect(obligation.reason).toBe("superseded_by_decision");
    expect(obligation.refundId).toBe("refund_cancel_ord_hd_ob_wd");
    // …and the money fact is exposed beside it, not written over it.
    expect(obligation.settledAfterDecision).toMatchObject({
      gatewayRefundId: `rfnd_after_${paymentId}`,
    });
    expect(obligation.settledAfterDecision.settledAt).toBe("MOCK_SERVER_TIMESTAMP");
    // Order-level money truth still moves.
    expect(orderOf("ord_hd_ob_wd").refundStatus).toBe("partially_refunded");
    expect(orderOf("ord_hd_ob_wd").payment.refundStatus).toBe("partially_refunded");
  });

  it("keeps a REJECTED obligation decision on the webhook settlement path", async () => {
    const paymentId = seedOrder("ord_hd_ob_rej", {
      refundObligation: {
        status: "REJECTED",
        refundId: "refund_cancel_ord_hd_ob_rej",
        amountPaise: 50000,
      },
    });
    const prev = config.mock.paymentGateway;
    config.mock.paymentGateway = true;
    try {
      const call = mockReqRes(
        refundWebhookPayload("evt_mk_hd_ob", "rfnd_hd_ob_done", paymentId, 40000)
      );
      await handleRazorpayWebhook(call.req, call.res);
      expect(call.out().statusCode).toBe(200);
    } finally {
      config.mock.paymentGateway = prev;
    }

    const obligation = orderOf("ord_hd_ob_rej").refundObligation;
    expect(obligation.status).toBe("REJECTED");
    expect(obligation.settledAfterDecision).toMatchObject({
      gatewayRefundId: "rfnd_hd_ob_done",
    });
    // The settlement itself is still recorded where readers look.
    expect(orderOf("ord_hd_ob_rej").payment.refundStatus).toBe("partially_refunded");
    expect(orderOf("ord_hd_ob_rej").refundedTotalPaise).toBe(40000);
  });
});
