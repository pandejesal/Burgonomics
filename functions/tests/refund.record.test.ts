import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Loop 64/120 rig: full refunds omit amountRupees — the old record write
// stored `undefined`, which real Firestore rejects AFTER the gateway refund
// posted (staff saw failure, retried, double refund). The mock set() accepts
// undefined, so this test asserts the stored shape directly: null, never
// undefined, and JSON-serializable.
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
      savedDocs[p] =
        options?.merge && savedDocs[p] ? { ...savedDocs[p], ...data } : data;
    }),
  });
  const mockDb: any = {
    collection: (colName: string) => ({
      doc: (docId: string) => docRef(colName, docId),
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

import { autoRefund } from "../src/modules/payments/razorpay.service";
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
});
