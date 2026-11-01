import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Loop 64/120 rig: full refunds omit amountRupees — the old record write
// stored `undefined`, which real Firestore rejects AFTER the gateway refund
// posted (staff saw failure, retried, double refund). The mock set() accepts
// undefined, so this test asserts the stored shape directly: null, never
// undefined, and JSON-serializable.
const { mockDb, savedDocs, control } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  const control = { failCustomerReadId: "", failOrderWriteAt: 0, orderWrites: 0 };
  const docRef = (colName: string, docId: string) => ({
    id: docId,
    path: `${colName}/${docId}`,
    get: vi.fn(async () => {
      if (colName === "customers" && docId === control.failCustomerReadId) {
        throw new Error("customer read unavailable");
      }
      return {
        exists: !!savedDocs[`${colName}/${docId}`],
        data: () => savedDocs[`${colName}/${docId}`] || {},
      };
    }),
    set: vi.fn(async (data: any, options?: any) => {
      if (colName === "orders") {
        control.orderWrites++;
        if (control.failOrderWriteAt && control.orderWrites === control.failOrderWriteAt) {
          throw new Error("order write unavailable");
        }
      }
      const p = `${colName}/${docId}`;
      savedDocs[p] =
        options?.merge && savedDocs[p] ? { ...savedDocs[p], ...data } : data;
    }),
  });
  const mockDb: any = {
    collection: (colName: string) => ({
      doc: (docId: string) => docRef(colName, docId),
    }),
    // Transaction seam: runs the callback immediately against the same
    // in-memory refs (single-threaded test, no contention to simulate).
    runTransaction: vi.fn(async (fn: any) => {
      const tx = {
        get: (ref: any) => ref.get(),
        set: (ref: any, data: any, options?: any) => ref.set(data, options),
        update: (ref: any, data: any) => ref.set(data, { merge: true }),
      };
      return fn(tx);
    }),
  };
  return { mockDb, savedDocs, control };
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

import { autoRefund, __setRefundPostForTests } from "../src/modules/payments/razorpay.service";
import { config } from "../src/config/env";

describe("Loop 64: refund record writes are Firestore-serializable", () => {
  let prevMock: boolean;

  beforeEach(() => {
    for (const key of Object.keys(savedDocs)) delete savedDocs[key];
    prevMock = config.mock.paymentGateway;
    config.mock.paymentGateway = true; // gateway POST stubbed, record path real
    savedDocs["orders/ord_r1"] = {
      payment: { razorpayPaymentId: "pay_r1" },
      pricing: { grandTotal: 500 },
    };
  });

  afterEach(() => {
    config.mock.paymentGateway = prevMock;
  });

  const noUndefined = (obj: Record<string, any>, path: string) => {
    for (const [k, v] of Object.entries(obj)) {
      expect(v, `${path}.${k}`).not.toBeUndefined();
    }
  };

  it("full refund (no amount, no reason) stores null, never undefined", async () => {
    const res: any = await autoRefund({ orderId: "ord_r1", razorpayPaymentId: "pay_r1" });
    expect(res.status).toBe("processed");
    const order = savedDocs["orders/ord_r1"];
    expect(order.refundStatus).toBe("refunded");
    expect(order.refundAmount).toBeNull();
    expect(typeof order.refundId).toBe("string");
    noUndefined(order, "orders/ord_r1");
    const audits = Object.entries(savedDocs).filter(([p]) =>
      p.startsWith("payment_audits/")
    );
    expect(audits).toHaveLength(1);
    const [, audit] = audits[0];
    expect((audit as any).action).toBe("refund_processed");
    expect((audit as any).amountRupees).toBeNull();
    expect((audit as any).reason).toBeNull();
    noUndefined(audit as any, "payment_audits row");
  });

  it("partial refund stores the numeric amount and replays idempotently", async () => {
    const first: any = await autoRefund({
      orderId: "ord_r1",
      razorpayPaymentId: "pay_r1",
      amountRupees: 200,
      reason: "item rejection",
    });
    expect(first.status).toBe("processed");
    expect(savedDocs["orders/ord_r1"].refundAmount).toBe(200);
    const second: any = await autoRefund({
      orderId: "ord_r1",
      razorpayPaymentId: "pay_r1",
      amountRupees: 200,
      reason: "item rejection",
    });
    expect(second.reused).toBe(true);
    expect(second.id).toBe(first.id);
  });

  it("refuses a second refund while a live lease is held (409 REFUND_IN_PROGRESS)", async () => {
    savedDocs["orders/ord_r1"] = {
      payment: { razorpayPaymentId: "pay_r1" },
      pricing: { grandTotal: 500 },
      refundStatus: "refunding",
      refundClaimedAt: Date.now(),
    };
    await expect(
      autoRefund({ orderId: "ord_r1", razorpayPaymentId: "pay_r1", amountRupees: 100 })
    ).rejects.toMatchObject({ statusCode: 409, code: "REFUND_IN_PROGRESS" });
  });

  it("refuses a partial that exceeds the remaining refundable total (400)", async () => {
    savedDocs["orders/ord_r1"] = {
      payment: { razorpayPaymentId: "pay_r1" },
      pricing: { grandTotal: 500 },
      refundedTotalPaise: 40000, // ₹400 of ₹500 already refunded
    };
    await expect(
      autoRefund({ orderId: "ord_r1", razorpayPaymentId: "pay_r1", amountRupees: 200 })
    ).rejects.toMatchObject({ statusCode: 400, code: "REFUND_EXCEEDS_REMAINING" });
  });

  it("refuses a full refund after partials with the exact remainder (409)", async () => {
    savedDocs["orders/ord_r1"] = {
      payment: { razorpayPaymentId: "pay_r1" },
      pricing: { grandTotal: 500 },
      refundedTotalPaise: 40000,
    };
    await expect(
      autoRefund({ orderId: "ord_r1", razorpayPaymentId: "pay_r1" })
    ).rejects.toMatchObject({ statusCode: 409, code: "REFUND_PARTIALS_EXIST" });
  });
});

describe("PAY-03: redeemed Grill Coins on refund", () => {
  let prevMock: boolean;

  beforeEach(() => {
    for (const key of Object.keys(savedDocs)) delete savedDocs[key];
    control.failCustomerReadId = "";
    prevMock = config.mock.paymentGateway;
    config.mock.paymentGateway = true;
    savedDocs["orders/ord_c1"] = {
      payment: { razorpayPaymentId: "pay_c1", razorpayOrderId: "rzp_c1" },
      pricing: { grandTotal: 500 },
    };
    savedDocs["customers/c1"] = { loyaltyPoints: 50 };
    // A clamped debit: 200 were requested, only 100 were on the balance.
    savedDocs["coin_transactions/coin_redemption_rzp_c1"] = {
      customerId: "c1",
      delta: -100,
      balanceAfter: 0,
      type: "redemption",
      orderId: "ord_c1",
    };
  });

  afterEach(() => {
    config.mock.paymentGateway = prevMock;
  });

  it("restores exactly what the debit actually took on a full refund", async () => {
    const res: any = await autoRefund({ orderId: "ord_c1", razorpayPaymentId: "pay_c1" });
    expect(res.status).toBe("processed");
    expect(savedDocs["customers/c1"].loyaltyPoints).toBe(150);
    expect(savedDocs["coin_transactions/coin_redemption_restore_ord_c1"]).toMatchObject({
      customerId: "c1",
      delta: 100,
      type: "redemption_restore",
      orderId: "ord_c1",
    });
  });

  it("restores nothing on a partial refund", async () => {
    await autoRefund({
      orderId: "ord_c1",
      razorpayPaymentId: "pay_c1",
      amountRupees: 200,
      reason: "item rejection",
    });
    expect(savedDocs["orders/ord_c1"].refundStatus).toBe("partially_refunded");
    expect(savedDocs["customers/c1"].loyaltyPoints).toBe(50);
    expect(savedDocs["coin_transactions/coin_redemption_restore_ord_c1"]).toBeUndefined();
  });

  it("still completes the refund when the coin restore throws", async () => {
    control.failCustomerReadId = "c1";
    const res: any = await autoRefund({ orderId: "ord_c1", razorpayPaymentId: "pay_c1" });
    expect(res.status).toBe("processed");
    expect(savedDocs["orders/ord_c1"].refundStatus).toBe("refunded");
    expect(savedDocs["customers/c1"].loyaltyPoints).toBe(50);
  });
});

describe("PAY-02: refund claim release on gateway failure", () => {
  let prevMock: boolean;

  beforeEach(() => {
    for (const key of Object.keys(savedDocs)) delete savedDocs[key];
    control.failCustomerReadId = "";
    control.failOrderWriteAt = 0;
    control.orderWrites = 0;
    prevMock = config.mock.paymentGateway;
    config.mock.paymentGateway = false; // live path, refund POST stubbed
    savedDocs["orders/ord_f1"] = {
      payment: { razorpayPaymentId: "pay_f1" },
      pricing: { grandTotal: 500 },
    };
  });

  afterEach(() => {
    __setRefundPostForTests(null);
    config.mock.paymentGateway = prevMock;
  });

  it("releases the claim so a retry is not wedged for 10 minutes", async () => {
    __setRefundPostForTests(async () => {
      throw new Error("gateway timeout");
    });
    await expect(
      autoRefund({ orderId: "ord_f1", razorpayPaymentId: "pay_f1" , refundRequestId: "refund_req_f1_release" })
    ).rejects.toMatchObject({ statusCode: 502, code: "REFUND_GATEWAY_FAILED" });
    // "MOCK_DELETE" is the FieldValue.delete() sentinel in this rig.
    expect(savedDocs["orders/ord_f1"].refundClaimedAt).toBe("MOCK_DELETE");
    expect(savedDocs["orders/ord_f1"].refundStatus).toBe("MOCK_DELETE");
  });

  it("restores a prior partially_refunded status instead of erasing it", async () => {
    savedDocs["orders/ord_f1"] = {
      payment: { razorpayPaymentId: "pay_f1" },
      pricing: { grandTotal: 500 },
      refundedTotalPaise: 10000,
      refundStatus: "partially_refunded",
    };
    __setRefundPostForTests(async () => {
      throw new Error("gateway refused");
    });
    await expect(
      autoRefund({ orderId: "ord_f1", razorpayPaymentId: "pay_f1", amountRupees: 200 , refundRequestId: "refund_req_f1_restore" })
    ).rejects.toMatchObject({ statusCode: 502, code: "REFUND_GATEWAY_FAILED" });
    expect(savedDocs["orders/ord_f1"].refundStatus).toBe("partially_refunded");
    expect(savedDocs["orders/ord_f1"].refundClaimedAt).toBe("MOCK_DELETE");
  });

  it("still throws the original 502 when releasing the claim fails", async () => {
    // Write 1 = claim, write 2 = release. Fail the release.
    control.failOrderWriteAt = 2;
    __setRefundPostForTests(async () => {
      throw new Error("gateway timeout");
    });
    await expect(
      autoRefund({ orderId: "ord_f1", razorpayPaymentId: "pay_f1" , refundRequestId: "refund_req_f1_release_fail" })
    ).rejects.toMatchObject({ statusCode: 502, code: "REFUND_GATEWAY_FAILED" });
    // Release failed: the lease marker is still the numeric claim timestamp.
    expect(typeof savedDocs["orders/ord_f1"].refundClaimedAt).toBe("number");
  });
});
