/**
 * Refund release → operator-visible `refunds` row completion — BEHAVIOURAL
 * coverage of the paths refund.completion-row.test.ts only pins as source text.
 *
 * The completion step derives its row id as
 *   completionDocId = refundRequestId.replace(/^refundreq_/, "")
 * and only writes when `completionDocId !== refundRequestId` (a `refundreq_`
 * prefix was actually present), the id is a safe doc id, and the row EXISTS.
 * Partner keys that are not row-scoped (`cancel_refund_<orderId>`,
 * `ops_refund_<orderId>`) therefore must never touch `refunds`, and a
 * `refundreq_` key with no row must not invent one.
 *
 * Harness: the in-memory Firestore fake from payments.refund-request-id.test.ts
 * (doc get/set + runTransaction). Gateway is in mock mode, so no network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockDb, savedDocs } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  const docRef = (colName: string, docId: string) => ({
    id: docId,
    path: `${colName}/${docId}`,
    get: vi.fn(async () => ({
      exists: !!savedDocs[`${colName}/${docId}`],
      data: () => savedDocs[`${colName}/${docId}`] || {},
    })),
    set: vi.fn(async (data: any, options?: any) => {
      const p = `${colName}/${docId}`;
      savedDocs[p] = options?.merge && savedDocs[p] ? { ...savedDocs[p], ...data } : data;
    }),
  });
  const mockDb: any = {
    collection: (colName: string) => ({ doc: (docId: string) => docRef(colName, docId) }),
    runTransaction: vi.fn(async (fn: any) => {
      const tx = {
        get: (ref: any) => ref.get(),
        set: (ref: any, data: any, options?: any) => ref.set(data, options),
        update: (ref: any, data: any) => ref.set(data, { merge: true }),
      };
      return fn(tx);
    }),
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
      firestore: firestoreFn, auth: vi.fn(() => ({})), messaging: vi.fn(() => ({})),
      initializeApp: vi.fn(), apps: [{ name: "mock" }],
    },
    firestore: firestoreFn, auth: vi.fn(() => ({})), messaging: vi.fn(() => ({})),
    initializeApp: vi.fn(), apps: [{ name: "mock" }],
  };
});

vi.mock("../src/core/errors", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/core/errors")>()),
  captureErrorSnapshot: vi.fn(async () => "mock_snapshot"),
}));

import { autoRefund } from "../src/modules/payments/razorpay.service";
import { config } from "../src/config/env";

const BRANCH = "branch_a";
const staff = {
  uid: "staff_1",
  email: "staff@burgonomics.test",
  role: "branch_staff",
  branchIds: [BRANCH],
};

const refundsKeys = () => Object.keys(savedDocs).filter((path) => path.startsWith("refunds/"));

function seedOrder(orderId: string, paymentId: string) {
  savedDocs[`orders/${orderId}`] = {
    id: orderId,
    branchId: BRANCH,
    payment: { razorpayPaymentId: paymentId, capturedAmountPaise: 50000 },
    pricing: { grandTotal: 500 },
  };
}

describe("refund release completes the operator-visible refunds row", () => {
  let prevMock: boolean;

  beforeEach(() => {
    for (const key of Object.keys(savedDocs)) delete savedDocs[key];
    prevMock = config.mock.paymentGateway;
    config.mock.paymentGateway = true;
  });

  afterEach(() => {
    config.mock.paymentGateway = prevMock;
    vi.restoreAllMocks();
  });

  // POSITIVE CONTROL: proves the harness actually reaches the completion write,
  // so the guard tests below cannot pass by never touching this code.
  it("completes a PENDING row named by a refundreq_ key, with the caller as processedBy", async () => {
    seedOrder("ord_row_ok", "pay_row_ok");
    savedDocs["refunds/row_ok"] = {
      id: "row_ok",
      orderId: "ord_row_ok",
      status: "PENDING",
      amountPaise: 10000,
      ownership: "machine",
    };

    const res: any = await autoRefund({
      orderId: "ord_row_ok",
      razorpayPaymentId: "pay_row_ok",
      amountRupees: 100,
      refundRequestId: "refundreq_row_ok",
    }, staff);

    const row = savedDocs["refunds/row_ok"];
    expect(row).toMatchObject({
      status: "COMPLETED",
      gatewayStatus: "processed",
      gatewayRefundId: res.id,
      refundId: res.id,
      settledPaise: 10000,
      processedBy: "staff@burgonomics.test",
    });
    // The row was completed, not duplicated.
    expect(refundsKeys()).toEqual(["refunds/row_ok"]);
    // Money truth still lands on the order in the same transaction.
    expect(savedDocs["orders/ord_row_ok"].refundedTotalPaise).toBe(10000);
    expect(savedDocs["orders/ord_row_ok"].refundStatus).toBe("partially_refunded");
  });

  // The partner cancel/ops keys are NOT row-scoped: `cancel_refund_<orderId>`
  // and `ops_refund_<orderId>` must never be reinterpreted as a refunds doc id.
  it.each(["cancel_refund_ord_scope_1", "ops_refund_ord_scope_1"])(
    "never touches refunds for the non-row-scoped key %s",
    async (requestId) => {
      seedOrder("ord_scope_1", "pay_scope_1");
      // A row that happens to carry the FULL request key as its document id.
      savedDocs[`refunds/${requestId}`] = {
        id: requestId,
        orderId: "ord_scope_1",
        status: "PENDING",
        amountPaise: 10000,
      };

      const res: any = await autoRefund({
        orderId: "ord_scope_1",
        razorpayPaymentId: "pay_scope_1",
        amountRupees: 100,
        refundRequestId: requestId,
      });

      expect(res.status).toBe("processed");
      // Exactly the seeded row, untouched, and no invented sibling.
      expect(refundsKeys()).toEqual([`refunds/${requestId}`]);
      expect(savedDocs[`refunds/${requestId}`]).toMatchObject({
        status: "PENDING",
        amountPaise: 10000,
      });
      expect(savedDocs[`refunds/${requestId}`].gatewayRefundId).toBeUndefined();
      expect(savedDocs["orders/ord_scope_1"].refundedTotalPaise).toBe(10000);
    }
  );

  it("does not create a refunds row for a refundreq_ key that names nothing", async () => {
    seedOrder("ord_missing_row", "pay_missing_row");

    const res: any = await autoRefund({
      orderId: "ord_missing_row",
      razorpayPaymentId: "pay_missing_row",
      amountRupees: 100,
      refundRequestId: "refundreq_row_that_does_not_exist",
    });

    expect(res.status).toBe("processed");
    // A phantom COMPLETED row would be offered to staff as a settled payout.
    expect(refundsKeys()).toEqual([]);
    expect(savedDocs["orders/ord_missing_row"].refundedTotalPaise).toBe(10000);
  });

  it("does not rewrite an already-COMPLETED row on an idempotent replay", async () => {
    seedOrder("ord_replay_row", "pay_replay_row");
    savedDocs["refunds/row_replay"] = {
      id: "row_replay",
      orderId: "ord_replay_row",
      status: "PENDING",
      amountPaise: 10000,
      ownership: "machine",
    };

    const first: any = await autoRefund({
      orderId: "ord_replay_row",
      razorpayPaymentId: "pay_replay_row",
      amountRupees: 100,
      refundRequestId: "refundreq_row_replay",
    });
    expect(first.status).toBe("processed");
    const settled = structuredClone(savedDocs["refunds/row_replay"]);
    expect(settled.status).toBe("COMPLETED");

    const replay: any = await autoRefund({
      orderId: "ord_replay_row",
      razorpayPaymentId: "pay_replay_row",
      amountRupees: 100,
      refundRequestId: "refundreq_row_replay",
    });
    expect(replay.reused).toBe(true);
    expect(replay.id).toBe(first.id);
    // The settled row is not rewritten by the replay.
    expect(savedDocs["refunds/row_replay"]).toEqual(settled);
    // …and no second payout was recorded.
    expect(Object.keys(savedDocs["orders/ord_replay_row"].refundLedger)).toHaveLength(1);
  });

  // A human REJECTED this request (disposeRefundRequest: "no rewriting
  // COMPLETED/FAILED rows"). Money later leaving the gateway must not erase
  // that decision silently — the operator row is the audit record of it.
  it("does not silently rewrite a human REJECTED decision as COMPLETED", async () => {
    seedOrder("ord_rejected_row", "pay_rejected_row");
    savedDocs["refunds/row_rejected"] = {
      id: "row_rejected",
      orderId: "ord_rejected_row",
      status: "REJECTED",
      amountPaise: 10000,
      disposition: {
        decision: "rejected",
        reason: "already handed to the customer as cash",
        decidedBy: "staff_qa",
      },
    };

    await autoRefund({
      orderId: "ord_rejected_row",
      razorpayPaymentId: "pay_rejected_row",
      amountRupees: 100,
      refundRequestId: "refundreq_row_rejected",
    }, staff);

    const row = savedDocs["refunds/row_rejected"];
    // Money truth is still recorded on the order…
    expect(savedDocs["orders/ord_rejected_row"].refundedTotalPaise).toBe(10000);
    // …but the human decision is not silently overwritten.
    expect(row.status).toBe("REJECTED");
    expect(row.disposition.decidedBy).toBe("staff_qa");
    expect(row.disposition.reason).toBe("already handed to the customer as cash");
  });
});
