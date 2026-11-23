import { describe, it, expect, vi, beforeEach } from "vitest";

/** Staging backfill plan: no guessed months, receipts, rollback, safe exclusions. */
const { savedDocs, mockDb, deleteSentinel } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  const deleteSentinel = "FIELD_DELETED";
  const FieldValue = {
    serverTimestamp: () => "TS",
    increment: (n: number) => ({ __inc: n }),
    delete: () => deleteSentinel,
  };
  const docRef = (col: string, id: string): any => ({
    id,
    path: `${col}/${id}`,
    get: async () => ({
      id,
      exists: Object.prototype.hasOwnProperty.call(savedDocs, `${col}/${id}`),
      data: () => savedDocs[`${col}/${id}`],
      ref: docRef(col, id),
    }),
    set: async (data: any, opts?: any) => {
      const p = `${col}/${id}`;
      const base = opts?.merge && savedDocs[p] ? { ...savedDocs[p] } : {};
      for (const [k, v] of Object.entries(data || {})) {
        if (v === deleteSentinel) delete base[k];
        else base[k] = v;
      }
      savedDocs[p] = base;
    },
  });
  const query = (col: string, filters: any[] = [], limit = Infinity, after?: string): any => ({
    where: (f: string, op: string, v: any) => query(col, [...filters, { f, op, v }], limit, after),
    orderBy: () => query(col, filters, limit, after),
    limit: (n: number) => query(col, filters, n, after),
    startAfter: (d: any) => query(col, filters, limit, String(d?.id ?? d)),
    get: async () => {
      let ids = Object.keys(savedDocs)
        .filter((p) => p.startsWith(`${col}/`))
        .map((p) => p.slice(col.length + 1))
        .filter((id) => !after || id > after)
        .sort();
      const docs = ids.slice(0, limit === Infinity ? undefined : limit).map((id) => ({
        id,
        ref: docRef(col, id),
        data: () => savedDocs[`${col}/${id}`],
      }));
      return { empty: docs.length === 0, docs };
    },
  });
  const mockDb: any = {
    collection: (col: string) => ({ ...query(col), doc: (id: string) => docRef(col, id) }),
    runTransaction: async (fn: any) =>
      fn({ get: (r: any) => r.get(), set: (r: any, d: any, o?: any) => r.set(d, o) }),
  };
  return { savedDocs, mockDb, deleteSentinel, FieldValue };
});

vi.mock("firebase-admin", () => {
  const fn: any = vi.fn(() => mockDb);
  fn.FieldValue = { serverTimestamp: () => "TS", increment: (n: number) => ({ __inc: n }), delete: () => deleteSentinel };
  fn.FieldPath = { documentId: () => "__name__" };
  return {
    default: {
      firestore: fn,
      initializeApp: vi.fn(),
      apps: [{ name: "mock" }],
      auth: vi.fn(() => ({})),
      messaging: vi.fn(() => ({})),
    },
    firestore: fn,
    initializeApp: vi.fn(),
    apps: [{ name: "mock" }],
    auth: vi.fn(() => ({})),
    messaging: vi.fn(() => ({})),
  };
});

beforeEach(() => {
  for (const k of Object.keys(savedDocs)) delete savedDocs[k];
});

async function mod() {
  return await import("../../scripts/backfill/settlementEffectiveAt");
}

describe("settlementEffectiveAt backfill", () => {
  it("online with no capture gets no numeric key and is unresolved", async () => {
    const m = await mod();
    const plan = m.planSettlementPatch({
      paymentChannel: "razorpay",
      payment: { capturedAmountPaise: 50000 },
      createdAt: "2026-11-20T10:00:00.000Z",
    });
    expect(plan.skip).toBeUndefined();
    expect(plan.patch.settlementEffectiveAtMs).toBeUndefined();
    expect(plan.patch.settlementCaptureState).toBe("unknown");
    expect(plan.patch.settlementCaptureUnresolved).toBe(true);
  });

  it("online with a provider capture gets that instant", async () => {
    const m = await mod();
    const plan = m.planSettlementPatch({
      paymentChannel: "razorpay",
      payment: { capturedAmountPaise: 50000, captured_at: 1763642400 },
      createdAt: "2026-11-20T10:00:00.000Z",
    });
    expect(plan.patch.settlementEffectiveAtMs).toBe(1763642400000);
    expect(plan.patch.settlementCaptureState).toBe("confirmed");
    expect(plan.patch.settlementCaptureUnresolved).toBe(false);
  });

  it("cash uses the live cash-collection semantics, never unresolved", async () => {
    const m = await mod();
    const plan = m.planSettlementPatch({
      paymentChannel: "cash",
      createdAt: "2026-11-20T10:00:00.000Z",
    });
    expect(plan.patch.settlementEffectiveAtMs).toBe(Date.parse("2026-11-20T10:00:00.000Z"));
    expect(plan.patch.settlementCaptureState).toBe("confirmed");
    expect(plan.patch.settlementCaptureUnresolved).toBe(false);
  });

  it("re-running writes zero documents", async () => {
    const m = await mod();
    savedDocs["orders/a"] = { paymentChannel: "cash", createdAt: "2026-11-20T10:00:00.000Z" };
    const first = await m.runBackfill(mockDb);
    expect(first.written).toBe(1);
    const second = await m.runBackfill(mockDb);
    expect(second.written).toBe(0);
  });

  it("rollback removes exactly the written settlement fields", async () => {
    const m = await mod();
    savedDocs["orders/b"] = { paymentChannel: "razorpay", payment: { capturedAmountPaise: 50000 } };
    const result = await m.runBackfill(mockDb);
    expect(result.written).toBe(1);
    expect(savedDocs["orders/b"].settlementCaptureUnresolved).toBe(true);
    await m.rollbackBackfill(mockDb, result.receipt);
    expect(savedDocs["orders/b"].settlementCaptureUnresolved).toBeUndefined();
    expect(savedDocs["orders/b"].settlementCaptureState).toBeUndefined();
    expect(savedDocs["orders/b"].settlementEffectiveAtMs).toBeUndefined();
    expect(savedDocs["orders/b"].payment.capturedAmountPaise).toBe(50000);
  });

  it("cancelled razorpay rows are excluded because refund reconcile can act on them", async () => {
    const m = await mod();
    const order = {
      paymentChannel: "razorpay",
      status: { code: "CANCELLED" },
      payment: { razorpayPaymentId: "pay_x", capturedAmountPaise: 50000 },
      createdAt: "2026-11-20T10:00:00.000Z",
    };
    savedDocs["orders/c"] = { ...order };
    const result = await m.runBackfill(mockDb);
    expect(result.written).toBe(0);
    expect(result.excluded).toContain("orders/c");
    expect(savedDocs["orders/c"].settlementEffectiveAtMs).toBeUndefined();

    // Prove the exclusion is required: a settlement-only update still reaches
    // the cancelled-paid refund obligation, which creates a refund review row.
    const { ensureCancelledPaidRefundObligation } = await import(
      "../../src/modules/orders/cancelRefundObligation"
    );
    const after = { ...order, settlementCaptureState: "confirmed" };
    const outcome = await ensureCancelledPaidRefundObligation({ orderId: "c", after, db: mockDb });
    expect(outcome.reason).not.toBe("not_cancelled");
    expect(savedDocs["refunds/refund_cancel_c"]).toBeTruthy();
  });
});
