import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * P1-A — ticket/order ownership (money safety).
 *
 * Defect: `createTicket` stamped any `orderId` the caller sent, and
 * `resolveTicket` refunded `ticket.orderId` without ever checking that the
 * named order belonged to the ticket's customer or branch. A customer could
 * therefore raise a ticket against ANOTHER customer's order; local staff
 * resolved it, and `autoRefund` (called without a caller) returned that
 * stranger's money.
 *
 * This suite uses REAL document shapes (orders carry `customerId`, `branchId`,
 * `payment.razorpayPaymentId`; tickets carry `customerId`, `branchId`,
 * `orderId`, `status`) and asserts:
 *  - creation refuses an order the caller does not own, opaquely (the refusal
 *    must not reveal whether the foreign order exists),
 *  - creation keeps working for a customer's OWN order and for the partner
 *    app's staff-raised tickets (which send no orderId at all),
 *  - resolution refuses to move money when the ticket's order does not match
 *    the ticket's customer/branch,
 *  - resolution hands the verified staff caller to `autoRefund` so its own
 *    branch guard runs.
 */
const { mockDb, savedDocs } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};

  const docRef = (colName: string, docId: string) => {
    const path = `${colName}/${docId}`;
    return {
      id: docId,
      path,
      get: async () => ({
        exists: Object.prototype.hasOwnProperty.call(savedDocs, path),
        data: () => (savedDocs[path] ? { ...savedDocs[path] } : undefined),
        ref: docRef(colName, docId),
      }),
      set: async (data: any, opts?: any) => {
        savedDocs[path] =
          opts?.merge && savedDocs[path] ? { ...savedDocs[path], ...data } : { ...data };
      },
      update: async (data: any) => {
        savedDocs[path] = { ...(savedDocs[path] || {}), ...data };
      },
    };
  };

  const query = (colName: string) => {
    const filters: Array<[string, any]> = [];
    const q: any = {
      where: (field: string, _op: string, value: any) => {
        filters.push([field, value]);
        return q;
      },
      orderBy: () => q,
      limit: () => q,
      get: async () => {
        const docs = Object.keys(savedDocs)
          .filter((p) => p.startsWith(`${colName}/`))
          .filter((p) => filters.every(([f, v]) => savedDocs[p]?.[f] === v))
          .map((p) => {
            const id = p.slice(colName.length + 1);
            return { id, ref: docRef(colName, id), exists: true, data: () => savedDocs[p] };
          });
        return { docs, empty: docs.length === 0 };
      },
    };
    return q;
  };

  const mockDb: any = {
    collection: (colName: string) => ({
      doc: (docId: string) => docRef(colName, docId),
      where: (field: string, op: string, value: any) => query(colName).where(field, op, value),
    }),
    runTransaction: vi.fn(async (fn: any) =>
      fn({
        get: (ref: any) => ref.get(),
        set: (ref: any, data: any, opts?: any) => ref.set(data, opts),
        update: (ref: any, data: any) => ref.update(data),
      })
    ),
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

// Only the provider call is replaced: the ticket service logic under test runs
// for real. The spy lets us assert (a) whether money moved at all and (b) that
// the verified staff caller reached autoRefund's own guards.
vi.mock("../src/modules/payments/razorpay.service", () => ({
  autoRefund: vi.fn(async () => ({ id: "rfnd_mock_1", status: "processed" })),
}));

import { createTicket, resolveTicket } from "../src/modules/tickets/tickets.service";
import { autoRefund } from "../src/modules/payments/razorpay.service";

const STAFF_GLOBAL = { uid: "staff_owner", role: "brand_owner" } as const;
const STAFF_BRANCH_A = { uid: "staff_a", role: "branch_owner", branchIds: ["branch_a"] } as const;
const CUSTOMER_1 = { uid: "cust_1", role: "customer" } as const;

const orderDoc = (over: Record<string, any> = {}) => ({
  customerId: "cust_1",
  branchId: "branch_a",
  payment: { method: "online", status: "completed", razorpayPaymentId: "pay_1" },
  status: { code: "DELIVERED", label: "Delivered", kind: "completed", terminal: true },
  ...over,
});

const ticketDoc = (over: Record<string, any> = {}) => ({
  ticketNumber: "TICK-2026-7001",
  customerId: "cust_1",
  branchId: "branch_a",
  orderId: "ord_1",
  status: "open",
  timeline: [],
  ...over,
});

const createInput = (over: Record<string, any> = {}) => ({
  customerName: "Cust One",
  branchId: "branch_a",
  category: "wrong_item" as const,
  subject: "Missing fries in the bag",
  description: "The fries were missing from the sealed bag.",
  ...over,
});

const ticketDocs = () => Object.keys(savedDocs).filter((p) => p.startsWith("support_tickets/tkt_"));

describe("P1-A createTicket — the order must belong to the verified caller and the ticket branch", () => {
  beforeEach(() => {
    for (const key of Object.keys(savedDocs)) delete savedDocs[key];
    vi.mocked(autoRefund).mockClear();
  });

  it("refuses a ticket naming ANOTHER customer's order, and writes no ticket", async () => {
    savedDocs["orders/ord_other"] = orderDoc({ customerId: "cust_2" });

    const err: any = await createTicket({
      ...createInput({ orderId: "ord_other" }),
      customerId: "cust_1",
      caller: CUSTOMER_1,
    }).then(
      (r) => ({ unexpectedSuccess: r }),
      (e) => e
    );

    expect(err.code).toBe("TICKET_ORDER_NOT_YOURS");
    expect(err.statusCode).toBe(403);
    expect(ticketDocs()).toEqual([]);
  });

  it("refuses another customer's order even when the branch matches", async () => {
    // Same branch is not ownership: branch alone must never authorize a refund
    // target.
    savedDocs["orders/ord_other"] = orderDoc({ customerId: "cust_2", branchId: "branch_a" });

    await expect(
      createTicket({
        ...createInput({ orderId: "ord_other" }),
        customerId: "cust_1",
        caller: CUSTOMER_1,
      })
    ).rejects.toMatchObject({ code: "TICKET_ORDER_NOT_YOURS", statusCode: 403 });
    expect(ticketDocs()).toEqual([]);
  });

  it("refuses an order id that does not exist with the SAME refusal (no existence oracle)", async () => {
    savedDocs["orders/ord_other"] = orderDoc({ customerId: "cust_2" });

    const foreign: any = await createTicket({
      ...createInput({ orderId: "ord_other" }),
      customerId: "cust_1",
      caller: CUSTOMER_1,
    }).catch((e) => e);
    const missing: any = await createTicket({
      ...createInput({ orderId: "ord_does_not_exist" }),
      customerId: "cust_1",
      caller: CUSTOMER_1,
    }).catch((e) => e);

    expect(missing.code).toBe(foreign.code);
    expect(missing.statusCode).toBe(foreign.statusCode);
    expect(missing.message).toBe(foreign.message);
    expect(ticketDocs()).toEqual([]);
  });

  it("accepts a customer's OWN order on the ticket's branch", async () => {
    savedDocs["orders/ord_mine"] = orderDoc({ customerId: "cust_1", branchId: "branch_a" });

    const created: any = await createTicket({
      ...createInput({ orderId: "ord_mine" }),
      customerId: "cust_1",
      caller: CUSTOMER_1,
    });

    expect(created.orderId).toBe("ord_mine");
    expect(created.customerId).toBe("cust_1");
    expect(ticketDocs()).toHaveLength(1);
  });

  it("refuses the customer's own order when the ticket claims a different branch", async () => {
    savedDocs["orders/ord_mine"] = orderDoc({ customerId: "cust_1", branchId: "branch_b" });

    await expect(
      createTicket({
        ...createInput({ orderId: "ord_mine", branchId: "branch_a" }),
        customerId: "cust_1",
        caller: CUSTOMER_1,
      })
    ).rejects.toMatchObject({ code: "TICKET_ORDER_NOT_YOURS", statusCode: 403 });
    expect(ticketDocs()).toEqual([]);
  });

  it("keeps the partner app's staff-raised ticket working (it sends no orderId)", async () => {
    // RaiseTicketModal -> useTickets.createTicket posts customerName/branchId/
    // category/priority/subject/description only — no orderId.
    const created: any = await createTicket({
      ...createInput({ customerName: "Store Staff" }),
      customerId: "staff_a",
      caller: STAFF_BRANCH_A,
    });

    expect(created.orderId).toBeNull();
    expect(created.branchId).toBe("branch_a");
    expect(ticketDocs()).toHaveLength(1);
  });

  it("lets branch staff attach a CUSTOMER's order that sits on the ticket's branch", async () => {
    savedDocs["orders/ord_cust"] = orderDoc({ customerId: "cust_9", branchId: "branch_a" });

    const created: any = await createTicket({
      ...createInput({ orderId: "ord_cust" }),
      customerName: "Store Staff",
      customerId: "staff_a",
      caller: STAFF_BRANCH_A,
    });

    expect(created.orderId).toBe("ord_cust");
    expect(ticketDocs()).toHaveLength(1);
  });

  it("still refuses staff naming an order on a DIFFERENT branch", async () => {
    savedDocs["orders/ord_far"] = orderDoc({ customerId: "cust_9", branchId: "branch_b" });

    await expect(
      createTicket({
        ...createInput({ orderId: "ord_far" }),
        customerName: "Store Staff",
        customerId: "staff_a",
        caller: STAFF_BRANCH_A,
      })
    ).rejects.toMatchObject({ code: "TICKET_ORDER_NOT_YOURS", statusCode: 403 });
    expect(ticketDocs()).toEqual([]);
  });
});

describe("P1-A resolveTicket — re-verify the linked order before any money moves", () => {
  beforeEach(() => {
    for (const key of Object.keys(savedDocs)) delete savedDocs[key];
    vi.mocked(autoRefund).mockClear();
  });

  it("refuses a full refund when the ticket's order belongs to ANOTHER customer", async () => {
    savedDocs["support_tickets/tk_foreign"] = ticketDoc({
      orderId: "ord_victim",
      customerId: "cust_attacker",
      branchId: "branch_a",
    });
    savedDocs["orders/ord_victim"] = orderDoc({
      customerId: "cust_victim",
      branchId: "branch_a",
      payment: { razorpayPaymentId: "pay_victim" },
    });

    const err: any = await resolveTicket({
      ticketId: "tk_foreign",
      resolvedBy: "staff_owner",
      action: "full_refund",
      notes: "refund please",
      caller: STAFF_GLOBAL,
    }).then(
      (r) => ({ unexpectedSuccess: r }),
      (e) => e
    );

    expect(err.code).toBe("TICKET_ORDER_MISMATCH");
    expect(err.statusCode).toBe(409);
    expect(vi.mocked(autoRefund)).not.toHaveBeenCalled();
    expect(savedDocs["orders/ord_victim"].refundStatus).toBeUndefined();
    expect(savedDocs["support_tickets/tk_foreign"].status).toBe("open");
  });

  it("refuses a full refund when the order sits on a DIFFERENT branch than the ticket", async () => {
    savedDocs["support_tickets/tk_branch"] = ticketDoc({
      orderId: "ord_b",
      customerId: "cust_1",
      branchId: "branch_a",
    });
    savedDocs["orders/ord_b"] = orderDoc({
      customerId: "cust_1",
      branchId: "branch_b",
      payment: { razorpayPaymentId: "pay_b" },
    });

    await expect(
      resolveTicket({
        ticketId: "tk_branch",
        resolvedBy: "staff_owner",
        action: "full_refund",
        notes: "refund please",
        caller: STAFF_GLOBAL,
      })
    ).rejects.toMatchObject({ code: "TICKET_ORDER_MISMATCH", statusCode: 409 });
    expect(vi.mocked(autoRefund)).not.toHaveBeenCalled();
    expect(savedDocs["support_tickets/tk_branch"].status).toBe("open");
  });

  it("refunds a matching ticket and hands autoRefund the verified staff caller", async () => {
    savedDocs["support_tickets/tk_ok"] = ticketDoc({ orderId: "ord_ok" });
    savedDocs["orders/ord_ok"] = orderDoc({
      customerId: "cust_1",
      branchId: "branch_a",
      payment: { razorpayPaymentId: "pay_ok" },
    });

    const res: any = await resolveTicket({
      ticketId: "tk_ok",
      resolvedBy: "staff_owner",
      action: "full_refund",
      notes: "missing item",
      caller: STAFF_GLOBAL,
    });

    expect(res.success).toBe(true);
    expect(vi.mocked(autoRefund)).toHaveBeenCalledTimes(1);
    const call = vi.mocked(autoRefund).mock.calls[0] as any[];
    expect(call[0]).toMatchObject({ orderId: "ord_ok", razorpayPaymentId: "pay_ok" });
    // Second argument = the verified caller, so autoRefund's own branch guard
    // (assertOrderBranchAccess) actually runs instead of being skipped.
    expect(call[1]).toMatchObject({ uid: "staff_owner", role: "brand_owner" });
  });

  it("keeps legacy tickets with no orderId resolvable without money", async () => {
    savedDocs["support_tickets/tk_legacy"] = {
      ticketNumber: "TICK-2026-7002",
      customerId: "cust_1",
      branchId: "branch_a",
      status: "open",
    };

    const res: any = await resolveTicket({
      ticketId: "tk_legacy",
      resolvedBy: "staff_owner",
      action: "explanation",
      notes: "explained",
      caller: STAFF_GLOBAL,
    });

    expect(res.success).toBe(true);
    expect(savedDocs["support_tickets/tk_legacy"].status).toBe("resolved");
  });

  it("still refuses a refund on an order-less ticket with the typed 400", async () => {
    savedDocs["support_tickets/tk_noorder"] = {
      ticketNumber: "TICK-2026-7003",
      customerId: "cust_1",
      branchId: "branch_a",
      status: "open",
    };

    await expect(
      resolveTicket({
        ticketId: "tk_noorder",
        resolvedBy: "staff_owner",
        action: "full_refund",
        notes: "refund",
        caller: STAFF_GLOBAL,
      })
    ).rejects.toMatchObject({ code: "TICKET_REFUND_NO_ORDER", statusCode: 400 });
    expect(vi.mocked(autoRefund)).not.toHaveBeenCalled();
  });
});
