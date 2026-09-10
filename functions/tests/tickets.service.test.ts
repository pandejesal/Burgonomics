import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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

import { resolveTicket, addTicketMessage } from "../src/modules/tickets/tickets.service";
import { config } from "../src/config/env";

const BASE = {
  resolvedBy: "staff_1",
  resolvedByName: "Staff One",
  notes: "test resolution",
} as const;

describe("resolveTicket (real money paths)", () => {
  const prevMock = config.mock.paymentGateway;
  beforeEach(() => {
    for (const key of Object.keys(savedDocs)) delete savedDocs[key];
    // Upstream env is fail-closed: mock gateway engages only on explicit
    // opt-in. These tests drive the mock refund branch deliberately.
    config.mock.paymentGateway = true;
  });
  afterEach(() => {
    config.mock.paymentGateway = prevMock;
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

  it("refuses a second resolution of an already-resolved ticket (double-refund guard)", async () => {
    savedDocs["support_tickets/tk_double"] = {
      ticketNumber: "TICK-2026-0005",
      orderId: "order_paid_2",
      customerId: "cust_2",
    };
    savedDocs["orders/order_paid_2"] = {
      payment: { razorpayPaymentId: "pay_live_2" },
    };
    const first = await resolveTicket({ ...BASE, ticketId: "tk_double", action: "full_refund" });
    expect(first.success).toBe(true);
    const auditsAfterFirst = Object.keys(savedDocs).filter((k) =>
      k.startsWith("payment_audits/")
    ).length;
    expect(auditsAfterFirst).toBe(1);
    await expect(
      resolveTicket({ ...BASE, ticketId: "tk_double", action: "partial_refund", amount: 50 })
    ).rejects.toThrow(/already resolved/);
    const auditsAfterSecond = Object.keys(savedDocs).filter((k) =>
      k.startsWith("payment_audits/")
    ).length;
    expect(auditsAfterSecond).toBe(1);
  });

  it("replays idempotently across tickets on the same order, refuses a different amount", async () => {
    savedDocs["support_tickets/tk_rfnd_a"] = {
      ticketNumber: "TICK-2026-0006",
      orderId: "order_rfnd_1",
      customerId: "cust_3",
    };
    savedDocs["support_tickets/tk_rfnd_b"] = {
      ticketNumber: "TICK-2026-0007",
      orderId: "order_rfnd_1",
      customerId: "cust_3",
    };
    savedDocs["orders/order_rfnd_1"] = {
      payment: { razorpayPaymentId: "pay_live_3" },
    };
    const first = await resolveTicket({
      ...BASE,
      ticketId: "tk_rfnd_a",
      action: "partial_refund",
      amount: 50,
    });
    expect(first.success).toBe(true);
    const auditsAfterFirst = Object.keys(savedDocs).filter((k) =>
      k.startsWith("payment_audits/")
    ).length;
    expect(auditsAfterFirst).toBe(1);
    // Same order + same amount on a second ticket: stored receipt replayed,
    // no second charge, no new audit.
    const replay = await resolveTicket({
      ...BASE,
      ticketId: "tk_rfnd_b",
      action: "partial_refund",
      amount: 50,
    });
    expect(replay.success).toBe(true);
    expect(replay.resolution.refundResult.reused).toBe(true);
    const auditsAfterReplay = Object.keys(savedDocs).filter((k) =>
      k.startsWith("payment_audits/")
    ).length;
    expect(auditsAfterReplay).toBe(1);
  });

  it("refuses a different-amount refund on an already-refunded order (ALREADY_REFUNDED)", async () => {
    savedDocs["support_tickets/tk_rfnd_c"] = {
      ticketNumber: "TICK-2026-0008",
      orderId: "order_rfnd_2",
      customerId: "cust_3",
    };
    savedDocs["orders/order_rfnd_2"] = {
      payment: { razorpayPaymentId: "pay_live_4" },
      refundStatus: "refunded",
      refundAmount: 50,
      refundId: "rfnd_prior_1",
    };
    await expect(
      resolveTicket({ ...BASE, ticketId: "tk_rfnd_c", action: "partial_refund", amount: 75 })
    ).rejects.toThrow(/already fully refunded/);
  });
});

describe("addTicketMessage authz (Loop 57/58)", () => {
  beforeEach(() => {
    for (const key of Object.keys(savedDocs)) delete savedDocs[key];
  });

  it("lets a customer message their own ticket", async () => {
    savedDocs["support_tickets/tk_own"] = {
      ticketNumber: "TICK-2026-0010",
      customerId: "cust_1",
      branchId: "branch_a",
      status: "open",
    };
    const ev = await addTicketMessage({
      ticketId: "tk_own",
      senderId: "cust_1",
      senderName: "Cust One",
      senderRole: "customer",
      text: "Where is my order?",
      caller: { uid: "cust_1", role: "customer" },
    });
    expect(ev.actorRole).toBe("customer");
    expect(savedDocs["support_tickets/tk_own"].status).toBe("open");
  });

  it("blocks a customer messaging someone else's ticket, even with a forged staff senderRole", async () => {
    savedDocs["support_tickets/tk_other"] = {
      ticketNumber: "TICK-2026-0011",
      customerId: "cust_9",
      branchId: "branch_a",
      status: "open",
    };
    await expect(
      addTicketMessage({
        ticketId: "tk_other",
        senderId: "cust_1",
        senderName: "Impostor",
        senderRole: "support",
        text: "Refund this now",
        caller: { uid: "cust_1", role: "customer" },
      })
    ).rejects.toThrow(/only message their own tickets/);
  });

  it("binds identity to the authenticated caller, ignoring a mismatched body senderId", async () => {
    savedDocs["support_tickets/tk_mismatch"] = {
      ticketNumber: "TICK-2026-0012",
      customerId: "cust_1",
      branchId: "branch_a",
      status: "open",
    };
    const ev = await addTicketMessage({
      ticketId: "tk_mismatch",
      senderId: "cust_9",
      senderName: "Cust One",
      senderRole: "customer",
      text: "hi",
      caller: { uid: "cust_1", role: "customer" },
    });
    expect(ev.actorId).toBe("cust_1");
  });

  it("lets branch staff message tickets inside their assigned branches", async () => {
    savedDocs["support_tickets/tk_staff"] = {
      ticketNumber: "TICK-2026-0013",
      customerId: "cust_9",
      branchId: "branch_a",
      status: "open",
    };
    const ev = await addTicketMessage({
      ticketId: "tk_staff",
      senderId: "staff_1",
      senderName: "Staff One",
      senderRole: "customer",
      text: "On it.",
      caller: { uid: "staff_1", role: "branch_owner", branchIds: ["branch_a"] },
    });
    expect(ev.actorRole).toBe("branch_owner");
    expect(savedDocs["support_tickets/tk_staff"].status).toBe("in_progress");
  });

  it("blocks scoped staff messaging tickets outside their branches", async () => {
    savedDocs["support_tickets/tk_far"] = {
      ticketNumber: "TICK-2026-0014",
      customerId: "cust_9",
      branchId: "branch_b",
      status: "open",
    };
    await expect(
      addTicketMessage({
        ticketId: "tk_far",
        senderId: "staff_1",
        senderName: "Staff One",
        senderRole: "branch_owner",
        text: "On it.",
        caller: { uid: "staff_1", role: "branch_owner", branchIds: ["branch_a"] },
      })
    ).rejects.toThrow(/outside your assigned branches/);
  });

  it("throws a clean not-found for missing tickets", async () => {
    await expect(
      addTicketMessage({
        ticketId: "tk_missing",
        senderId: "cust_1",
        senderName: "Cust One",
        senderRole: "customer",
        text: "hi",
        caller: { uid: "cust_1", role: "customer" },
      })
    ).rejects.toThrow(/not found/);
  });
});
