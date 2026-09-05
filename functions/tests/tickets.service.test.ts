import { describe, it, expect, vi, beforeEach } from "vitest";

// These tests drive the REAL resolveTicket (money movement included) — the
// previous file asserted a locally-defined transitions map and proved nothing
// about production.

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
      const docPath = `${colName}/${docId}`;
      savedDocs[docPath] =
        options?.merge && savedDocs[docPath] ? { ...savedDocs[docPath], ...data } : data;
    }),
    update: vi.fn(async (data: any) => {
      const docPath = `${colName}/${docId}`;
      savedDocs[docPath] = { ...(savedDocs[docPath] || {}), ...data };
    }),
  });
  const mockDb = {
    collection: (colName: string) => ({
      doc: (docId?: string) => docRef(colName, docId || `mock_${Math.random().toString(36).slice(2, 8)}`),
    }),
  };
  return { mockDb, savedDocs };
});

vi.mock("firebase-admin", () => {
  const FieldValue = {
    serverTimestamp: () => "MOCK_SERVER_TIMESTAMP",
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

import { resolveTicket } from "../src/modules/tickets/tickets.service";

const BASE = {
  resolvedBy: "staff_1",
  resolvedByName: "Staff One",
  notes: "test resolution",
} as const;

describe("resolveTicket (real money paths)", () => {
  beforeEach(() => {
    for (const key of Object.keys(savedDocs)) delete savedDocs[key];
  });

  it("executes a full refund through autoRefund and resolves the ticket", async () => {
    savedDocs["support_tickets/tk_1"] = {
      ticketNumber: "TICK-2026-0001",
      orderId: "order_paid_1",
      customerId: "cust_1",
    };
    savedDocs["orders/order_paid_1"] = {
      payment: { razorpayPaymentId: "pay_live_1" },
    };

    const res = await resolveTicket({ ...BASE, ticketId: "tk_1", action: "full_refund" });
    expect(res.success).toBe(true);
    expect(res.resolution.refundResult).toMatchObject({ payment_id: "pay_live_1" });
    expect(savedDocs["orders/order_paid_1"].refundStatus).toBe("refunded");
    expect(savedDocs["support_tickets/tk_1"].status).toBe("resolved");
  });

  it("refuses a refund when the ticket has no linked order (no silent resolve)", async () => {
    savedDocs["support_tickets/tk_guest"] = { ticketNumber: "TICK-2026-0002" };
    await expect(
      resolveTicket({ ...BASE, ticketId: "tk_guest", action: "full_refund" })
    ).rejects.toThrow(/no linked order/);
    expect(savedDocs["support_tickets/tk_guest"].status).toBeUndefined();
  });

  it("refuses a refund when no captured payment exists (COD/unpaid)", async () => {
    savedDocs["support_tickets/tk_cod"] = {
      ticketNumber: "TICK-2026-0003",
      orderId: "order_cod_1",
    };
    savedDocs["orders/order_cod_1"] = { payment: { method: "cod" } };
    await expect(
      resolveTicket({ ...BASE, ticketId: "tk_cod", action: "partial_refund", amount: 99 })
    ).rejects.toThrow(/no captured Razorpay payment/);
    expect(savedDocs["support_tickets/tk_cod"].status).toBeUndefined();
  });

  it("applies loyalty credit exactly once to the customer profile", async () => {
    savedDocs["support_tickets/tk_loyal"] = {
      ticketNumber: "TICK-2026-0004",
      customerId: "cust_9",
    };
    const res = await resolveTicket({
      ...BASE,
      ticketId: "tk_loyal",
      action: "loyalty_credit",
      amount: 100,
    });
    expect(res.success).toBe(true);
    expect(savedDocs["support_tickets/tk_loyal"].status).toBe("resolved");
  });
});
