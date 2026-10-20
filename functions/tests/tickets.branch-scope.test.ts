import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Loop 7 hardening (FIX1): fail-closed branch scoping for staff ticket paths.
// The prior inline guards skipped the check when a branch-scoped caller held
// a MISSING or EMPTY branchIds claim, letting a branch_staff act (refunds
// included) on any branch. This file pins the fail-closed contract at the
// SERVICE boundary, asserted BEFORE any refund/snapshot/status side effect.

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
    runTransaction: vi.fn(async (fn: any) =>
      fn({
        get: (ref: any) => ref.get(),
        set: (ref: any, data: any, opts?: any) => ref.set(data, opts),
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

import { resolveTicket, resolveTicketNote, addTicketMessage, escalateTicket } from "../src/modules/tickets/tickets.service";
import { config } from "../src/config/env";

const BRANCH_A_TICKET = (id: string) => ({
  ticketNumber: "TICK-SCOPE-0001",
  customerId: "cust_9",
  branchId: "branch_a",
  status: "open",
});
const CAPTURED_PAYMENT_ORDER = {
  payment: { razorpayPaymentId: "pay_live_scope_1" },
};

describe("assertTicketBranchAccess fail-closed contract (Loop 7 hardening)", () => {
  const prevMock = config.mock.paymentGateway;
  beforeEach(() => {
    for (const key of Object.keys(savedDocs)) delete savedDocs[key];
    config.mock.paymentGateway = true; // refund attempts (if any) use the mock, never a provider
  });
  afterEach(() => {
    config.mock.paymentGateway = prevMock;
  });

  const scopedMoneyCaller = (branchIds?: string[], role = "branch_staff") => ({
    uid: "staff_1",
    role,
    branchIds,
  });

  it("denies a scoped caller with a MISSING branchIds list (403, no refund side effect)", async () => {
    savedDocs["support_tickets/tk_scope_1"] = BRANCH_A_TICKET("tk_scope_1");
    savedDocs["orders/order_scope_1"] = CAPTURED_PAYMENT_ORDER;
    savedDocs["support_tickets/tk_scope_1"].orderId = "order_scope_1";
    await expect(
      resolveTicket({
        ticketId: "tk_scope_1",
        resolvedBy: "staff_1",
        resolvedByName: "Staff One",
        action: "full_refund",
        notes: "attacker path",
        caller: scopedMoneyCaller(undefined), // branchIds absent
      })
    ).rejects.toMatchObject({ code: "TICKET_FORBIDDEN", statusCode: 403 });
    // Side effects BEFORE the check must not have happened.
    expect(savedDocs["orders/order_scope_1"].refundStatus).toBeUndefined();
    expect(savedDocs["support_tickets/tk_scope_1"].status).toBe("open");
  });

  it("denies a scoped caller with an EMPTY branchIds list (403)", async () => {
    savedDocs["support_tickets/tk_scope_2"] = BRANCH_A_TICKET("tk_scope_2");
    await expect(
      resolveTicketNote({
        ticketId: "tk_scope_2",
        resolution: "empty-claims bypass attempt",
        caller: scopedMoneyCaller([]),
      })
    ).rejects.toMatchObject({ code: "TICKET_FORBIDDEN", statusCode: 403 });
    expect(savedDocs["support_tickets/tk_scope_2"].status).toBe("open");
  });

  it("denies escalations by scoped callers outside their branches (403, no snapshot write)", async () => {
    savedDocs["support_tickets/tk_scope_3"] = BRANCH_A_TICKET("tk_scope_3");
    await expect(
      escalateTicket({
        ticketId: "tk_scope_3",
        targetTier: "developer_team",
        reason: "cross-branch escalate attempt",
        escalatedBy: "staff_2",
        escalatedByName: "Staff Two",
        caller: scopedMoneyCaller(["branch_b"], "regional_manager"),
      })
    ).rejects.toMatchObject({ code: "TICKET_FORBIDDEN", statusCode: 403 });
    expect(savedDocs["support_tickets/tk_scope_3"].tier).toBeUndefined();
    expect(savedDocs["support_tickets/tk_scope_3"].status).toBe("open");
  });

  it("rejects callers whose identity is not bound (caller object without uid)", async () => {
    savedDocs["support_tickets/tk_scope_4"] = BRANCH_A_TICKET("tk_scope_4");
    await expect(
      resolveTicket({
        ticketId: "tk_scope_4",
        resolvedBy: "ghost",
        resolvedByName: "Ghost",
        action: "full_refund",
        notes: "no uid",
        caller: { role: "branch_staff" } as any,
      })
    ).rejects.toMatchObject({ code: "TICKET_FORBIDDEN", statusCode: 403 });
    expect(savedDocs["support_tickets/tk_scope_4"].status).toBe("open");
  });

  it("rejects driverless service calls on the money path (no caller -> 403)", async () => {
    savedDocs["support_tickets/tk_scope_5"] = BRANCH_A_TICKET("tk_scope_5");
    await expect(
      resolveTicket({
        ticketId: "tk_scope_5",
        resolvedBy: "someone",
        resolvedByName: "Someone",
        action: "full_refund",
        notes: "no caller at all",
      })
    ).rejects.toMatchObject({ code: "TICKET_FORBIDDEN", statusCode: 403 });
    expect(savedDocs["support_tickets/tk_scope_5"].status).toBe("open");
  });

  it("rejects an unbound caller on messages rather than skipping visibility", async () => {
    savedDocs["support_tickets/tk_scope_6"] = BRANCH_A_TICKET("tk_scope_6");
    await expect(
      addTicketMessage({
        ticketId: "tk_scope_6",
        senderId: "ghost",
        senderName: "Ghost",
        senderRole: "customer",
        text: "hello",
        caller: { role: "customer" } as any,
      })
    ).rejects.toMatchObject({ code: "TICKET_FORBIDDEN", statusCode: 403 });
    expect(savedDocs["support_tickets/tk_scope_6"].timeline).toBeUndefined();
  });

  it("still allows matched scoped staff and global roles without branchIds", async () => {
    savedDocs["support_tickets/tk_scope_7"] = BRANCH_A_TICKET("tk_scope_7");
    const ev = await addTicketMessage({
      ticketId: "tk_scope_7",
      senderId: "staff_1",
      senderName: "Staff One",
      senderRole: "customer",
      text: "On it.",
      caller: { uid: "staff_1", role: "branch_staff", branchIds: ["branch_a"] },
    });
    expect(ev.actorRole).toBe("branch_staff");

    // Global roles (rbac.md: brand_owner/developer/support global; support is
    // Global Tickets) act WITHOUT branchIds.
    for (const role of ["brand_owner", "developer", "support"]) {
      savedDocs[`support_tickets/tk_global_${role}`] = BRANCH_A_TICKET(`tk_global_${role}`);
      await expect(
        resolveTicketNote({
          ticketId: `tk_global_${role}`,
          resolution: "global role acting",
          caller: { uid: "staff_g", role },
        })
      ).resolves.toMatchObject({ success: true });
    }
  });

  it("legacy branchless ticket docs remain staff-actionable (documented backstop)", async () => {
    // Preconditions changing this rule must be explicit: rules + requireRole
    // remain backstop; scoped staff on an unbranched doc is allowed here.
    savedDocs["support_tickets/tk_scope_legacy"] = {
      ticketNumber: "TICK-SCOPE-LEGACY",
      customerId: "cust_9",
      status: "open",
    };
    await expect(
      resolveTicketNote({
        ticketId: "tk_scope_legacy",
        resolution: "legacy doc",
        caller: { uid: "staff_1", role: "branch_staff", branchIds: [] },
      })
    ).resolves.toMatchObject({ success: true });
  });
});
