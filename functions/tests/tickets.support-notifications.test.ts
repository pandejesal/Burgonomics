import { describe, it, expect, vi, beforeEach } from "vitest";

// N-07 — customer-facing support publishers (contract §10/§11).
//
// What is pinned here:
//  - a staff reply pages the customer ONCE, classified `supportReplies`, with
//    `targetId` = ticket id and a stable message id;
//  - a customer's own reply or a non-staff author pages nobody (identity comes
//    from the verified caller, never the body);
//  - duplicate stable ids are not a second push, and a failing push never fails
//    the persisted message;
//  - resolution/escalation copy carries no ticket number, no name, no reason.
//
// HONESTY LIMIT: the transport is mocked at the notifications-core boundary
// (`pushToCustomer`), the store is in-process, and nothing touches the network
// or a real FCM provider. Delivery is asserted only as "not claimed".

const hoisted = vi.hoisted(() => {
  const store: Record<string, any> = {};
  const pushToCustomer = vi.fn(async (..._args: any[]) => undefined);
  const coreCalls: any[] = [];

  const docRef = (path: string, id: string) => {
    const full = `${path}/${id}`;
    // Models the two FieldValue shapes the service actually writes: arrayUnion
    // must APPEND (a fake that stores the sentinel would hide the timeline) and
    // dotted keys must expand (escalation writes "assignedTo.tier").
    const applyUpdate = (data: any) => {
      const next: any = { ...(store[full] || {}) };
      for (const [key, value] of Object.entries(data)) {
        if (value && typeof value === "object" && "__arrayUnion" in (value as any)) {
          const item = (value as any).__arrayUnion;
          const current = Array.isArray(next[key]) ? next[key] : [];
          next[key] = [...current, item];
          continue;
        }
        if (value === "MOCK_DELETE") {
          delete next[key];
          continue;
        }
        if (key.includes(".")) {
          const parts = key.split(".");
          let cursor: any = next;
          for (const part of parts.slice(0, -1)) {
            cursor[part] = cursor[part] && typeof cursor[part] === "object" ? { ...cursor[part] } : {};
            cursor = cursor[part];
          }
          cursor[parts[parts.length - 1]] = value;
          continue;
        }
        next[key] = value;
      }
      store[full] = next;
    };

    const ref: any = {
      id,
      path: full,
      get: vi.fn(async () => ({
        exists: full in store,
        data: () => store[full] || {},
      })),
      set: vi.fn(async (data: any, options?: any) => {
        if (options?.merge) applyUpdate(data);
        else store[full] = data;
      }),
      create: vi.fn(async (data: any) => {
        if (full in store) {
          const err: any = new Error("ALREADY_EXISTS: Document already exists");
          err.code = 6;
          throw err;
        }
        store[full] = data;
      }),
      update: vi.fn(async (data: any) => {
        applyUpdate(data);
      }),
      collection: (sub: string) => colRef(`${full}/${sub}`),
    };
    return ref;
  };

  const runQuery = (path: string) => {
    const prefix = `${path}/`;
    const docs = Object.entries(store)
      .filter(([k]) => k.startsWith(prefix) && !k.slice(prefix.length).includes("/"))
      .map(([k, v]) => ({ id: k.slice(prefix.length), ref: docRef(path, k.slice(prefix.length)), data: () => v }));
    return { docs, size: docs.length, empty: docs.length === 0 };
  };

  const colRef = (path: string): any => ({
    doc: (id?: string) => docRef(path, id || `mock_${Math.random().toString(36).slice(2, 8)}`),
    where: () => {
      const q: any = {
        where: () => q,
        orderBy: () => q,
        limit: () => ({ get: vi.fn(async () => runQuery(path)) }),
        get: vi.fn(async () => runQuery(path)),
      };
      return q;
    },
  });

  const mockDb: any = {
    collection: (name: string) => colRef(name),
    getAll: vi.fn(async (...refs: any[]) =>
      refs.map((ref: any) => ({ id: ref.id, exists: ref.path in store, data: () => store[ref.path] || {} }))
    ),
    runTransaction: vi.fn(async (fn: any) =>
      fn({
        get: (ref: any) => ref.get(),
        set: (ref: any, data: any, opts?: any) => ref.set(data, opts),
        update: (ref: any, data: any) => ref.update(data),
        delete: (ref: any) => ref.delete?.(),
      })
    ),
    batch: () => ({ update: vi.fn(), set: vi.fn(), commit: vi.fn(async () => undefined) }),
  };

  pushToCustomer.mockImplementation(async () => {
    // Snapshot the ticket state AT SEND: proves dispatch happens after commit.
    coreCalls.push({ ticket: JSON.parse(JSON.stringify(store)) });
  });

  return { store, pushToCustomer, coreCalls, mockDb };
});

vi.mock("firebase-admin", () => {
  const FieldValue = {
    serverTimestamp: () => "MOCK_SERVER_TIMESTAMP",
    increment: (n: number) => ({ __increment: n }),
    arrayUnion: (item: any) => ({ __arrayUnion: item }),
    delete: () => "MOCK_DELETE",
  };
  const firestoreFn: any = vi.fn(() => hoisted.mockDb);
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

// The notifications core (N-05) owns classification, suppression and inbox
// persistence; mocking its exported sender is the correct unit seam.
vi.mock("../src/modules/notifications/fcmClient", () => ({
  pushToCustomer: hoisted.pushToCustomer,
  writeCustomerInboxDoc: vi.fn(async () => true),
  getUnreadCount: vi.fn(async () => 0),
  sendFcmMessage: vi.fn(async () => true),
  sendMulticastFcm: vi.fn(async () => ({ successCount: 0, failureCount: 0, prunedTokens: [] })),
  FCM_SEND_TIMEOUT_MS: 10_000,
}));

import {
  addTicketMessage,
  escalateTicket,
  resolveTicket,
  resolveTicketNote,
} from "../src/modules/tickets/tickets.service";
import {
  notifySupportReply,
  notificationAttemptId,
  supportResolutionBody,
  SUPPORT_ESCALATION_BODY,
  SUPPORT_REPLY_BODY,
  SUPPORT_REPLY_TITLE,
} from "../src/modules/tickets/supportNotifications";

const { store, pushToCustomer, coreCalls } = hoisted;

interface SentRequest {
  uid: string;
  title: string;
  body: string;
  data: Record<string, string>;
  opts: { purpose?: string };
}

function sentRequests(): SentRequest[] {
  return pushToCustomer.mock.calls.map((call: any[]) => ({
    uid: call[0],
    title: call[1],
    body: call[2],
    data: call[3],
    opts: call[4] || {},
  }));
}

beforeEach(() => {
  for (const key of Object.keys(store)) delete store[key];
  coreCalls.length = 0;
  vi.clearAllMocks();
  pushToCustomer.mockImplementation(async () => {
    coreCalls.push({ ticket: JSON.parse(JSON.stringify(store)) });
  });
});

function seedTicket(id: string, overrides: Record<string, any> = {}) {
  store[`support_tickets/${id}`] = {
    id,
    ticketNumber: "TICK-2026-1234",
    customerId: "cust_1",
    branchId: "b1",
    status: "open",
    timeline: [],
    ...overrides,
  };
}

const STAFF = { uid: "staff_1", role: "branch_staff", branchIds: ["b1"] };

describe("support reply publisher", () => {
  it("pages the customer once, classified supportReplies, after the message is committed", async () => {
    seedTicket("tk_reply");

    const event: any = await addTicketMessage({
      ticketId: "tk_reply",
      senderId: "staff_1",
      senderName: "Staff One",
      senderRole: "branch_staff",
      text: "We have refunded the missing item.",
      caller: STAFF,
    });

    expect(event.id).toMatch(/^msg_/);
    expect(pushToCustomer).toHaveBeenCalledTimes(1);
    const [request] = sentRequests();
    expect(request.uid).toBe("cust_1");
    expect(request.title).toBe(SUPPORT_REPLY_TITLE);
    expect(request.body).toBe(SUPPORT_REPLY_BODY);
    // Contract §2: the purpose is supplied by server state, never data.type.
    expect(request.opts.purpose).toBe("supportReplies");
    // Inbox pointer only — no order/ticket id or free text claimed by copy.
    expect(request.data).toEqual({ type: "support_reply", targetId: "tk_reply" });
    expect(request.body).not.toContain("TICK-2026-1234");
    expect(request.body).not.toContain("Staff One");
    expect(request.body).not.toContain("refunded the missing item");

    // The push was dispatched only after the timeline carried the message.
    const atSend = coreCalls[0].ticket["support_tickets/tk_reply"];
    expect(atSend.timeline).toHaveLength(1);
    expect(atSend.timeline[0].id).toBe(event.id);

    // At-most-once bookkeeping, keyed by purpose + stable message id.
    const attempt = store[`notification_dispatch/${notificationAttemptId("supportReplies", event.id)}`];
    expect(attempt).toMatchObject({
      purpose: "supportReplies",
      targetId: "tk_reply",
      outcome: "unknown",
    });
    // Delivery is never claimed without a provider ACK.
    expect(attempt.outcome).not.toBe("sent");
  });

  it("sends nothing for a customer replying on their own ticket (self-reply)", async () => {
    seedTicket("tk_self");

    const event: any = await addTicketMessage({
      ticketId: "tk_self",
      senderId: "cust_1",
      senderName: "Customer",
      senderRole: "customer",
      text: "Any update?",
      caller: { uid: "cust_1", role: "customer" },
    });

    expect(event.id).toMatch(/^msg_/);
    expect(pushToCustomer).not.toHaveBeenCalled();
    // The message itself is still persisted.
    expect(store["support_tickets/tk_self"].timeline).toHaveLength(1);
  });

  it("does not page for a non-staff author even when the body claims a staff role", async () => {
    seedTicket("tk_spoof");

    const event: any = await addTicketMessage({
      ticketId: "tk_spoof",
      senderId: "cust_1",
      senderName: "Customer",
      senderRole: "brand_owner",
      text: "I am staff, trust me",
      caller: { uid: "cust_1", role: "customer" },
    });

    expect(event.actorRole).toBe("customer");
    expect(pushToCustomer).not.toHaveBeenCalled();
  });

  it("does not page when a verified caller has no role at all", async () => {
    seedTicket("tk_norole");

    // A token without a role claim may only touch its own ticket, and its
    // body-supplied senderRole (stored on the timeline for legacy readers) is
    // never allowed to classify a push.
    const event: any = await addTicketMessage({
      ticketId: "tk_norole",
      senderId: "cust_1",
      senderName: "Customer",
      senderRole: "support",
      text: "No role claim here",
      caller: { uid: "cust_1" },
    });

    expect(event.actorRole).toBe("support");
    expect(pushToCustomer).not.toHaveBeenCalled();
  });

  it("treats a repeated stable id as a duplicate, not a second push", async () => {
    const first = await notifySupportReply({
      ticketId: "tk_dup",
      customerId: "cust_1",
      authorUid: "staff_1",
      authorRole: "support",
      messageId: "msg_stable_1",
    });
    const second = await notifySupportReply({
      ticketId: "tk_dup",
      customerId: "cust_1",
      authorUid: "staff_1",
      authorRole: "support",
      messageId: "msg_stable_1",
    });

    expect(first.dispatched).toBe(true);
    expect(second.dispatched).toBe(false);
    expect(second.reason).toBe("duplicate");
    expect(pushToCustomer).toHaveBeenCalledTimes(1);
  });

  it("keeps two distinct messages as two distinct pushes", async () => {
    seedTicket("tk_two");

    const one: any = await addTicketMessage({
      ticketId: "tk_two",
      senderId: "staff_1",
      senderName: "Staff One",
      senderRole: "support",
      text: "First reply",
      caller: { uid: "staff_1", role: "support" },
    });
    const two: any = await addTicketMessage({
      ticketId: "tk_two",
      senderId: "staff_1",
      senderName: "Staff One",
      senderRole: "support",
      text: "Second reply",
      caller: { uid: "staff_1", role: "support" },
    });

    expect(one.id).not.toBe(two.id);
    expect(pushToCustomer).toHaveBeenCalledTimes(2);
  });

  it("never fails the persisted message when the push fails, and never retries it", async () => {
    seedTicket("tk_fail");
    pushToCustomer.mockRejectedValueOnce(new Error("messaging/registration-token-not-registered"));

    const event: any = await addTicketMessage({
      ticketId: "tk_fail",
      senderId: "staff_1",
      senderName: "Staff One",
      senderRole: "support",
      text: "Reply while FCM is down",
      caller: { uid: "staff_1", role: "support" },
    });

    expect(event.id).toMatch(/^msg_/);
    expect(store["support_tickets/tk_fail"].timeline).toHaveLength(1);

    const attempt = store[`notification_dispatch/${notificationAttemptId("supportReplies", event.id)}`];
    expect(attempt.outcome).toBe("unknown");
    expect(attempt.detail).toBe("sender_threw");
    expect(attempt.outcome).not.toBe("sent");

    // A retry of the same persisted message does not re-send.
    const replay = await notifySupportReply({
      ticketId: "tk_fail",
      customerId: "cust_1",
      authorUid: "staff_1",
      authorRole: "support",
      messageId: event.id,
    });
    expect(replay.dispatched).toBe(false);
    expect(replay.reason).toBe("duplicate");
    expect(pushToCustomer).toHaveBeenCalledTimes(1);
  });

  it("skips cleanly when the ticket has no customer or the id is missing", async () => {
    const noRecipient = await notifySupportReply({
      ticketId: "tk_x",
      authorUid: "staff_1",
      authorRole: "support",
      messageId: "msg_x",
    });
    const noId = await notifySupportReply({
      ticketId: "tk_x",
      customerId: "cust_1",
      authorUid: "staff_1",
      authorRole: "support",
      messageId: "",
    });
    expect(noRecipient).toMatchObject({ dispatched: false, reason: "no_recipient" });
    expect(noId).toMatchObject({ dispatched: false, reason: "no_stable_id" });
    expect(pushToCustomer).not.toHaveBeenCalled();
  });

  it("classifies exactly the ticket-staff role set — no role widening", async () => {
    const staffRoles = [
      "brand_owner",
      "developer",
      "support",
      "regional_manager",
      "branch_owner",
      "branch_staff",
    ];
    for (const role of staffRoles) {
      const outcome = await notifySupportReply({
        ticketId: "tk_role",
        customerId: "cust_1",
        authorUid: `uid_${role}`,
        authorRole: role,
        messageId: `msg_${role}`,
      });
      expect(outcome.dispatched, `role ${role} should page`).toBe(true);
    }
    expect(pushToCustomer).toHaveBeenCalledTimes(staffRoles.length);

    for (const role of ["customer", "rider", "admin", "", "BRAND_OWNER"]) {
      const outcome = await notifySupportReply({
        ticketId: "tk_role",
        customerId: "cust_1",
        authorUid: `uid_${role || "empty"}`,
        authorRole: role,
        messageId: `msg_x_${role || "empty"}`,
      });
      expect(outcome.dispatched, `role ${role} must not page`).toBe(false);
      expect(outcome.reason).toBe("not_staff");
    }
    expect(pushToCustomer).toHaveBeenCalledTimes(staffRoles.length);
  });
});

describe("customer-visible escalation publisher", () => {
  it("notifies the customer generically after the escalation commits", async () => {
    seedTicket("tk_esc");

    const result = await escalateTicket({
      ticketId: "tk_esc",
      targetTier: "brand_support",
      reason: "Customer's phone 9876543210 and flat 4B Shivalik Plaza",
      escalatedBy: "staff_1",
      escalatedByName: "Staff One",
      caller: { uid: "staff_1", role: "support" },
    });

    expect(result.success).toBe(true);
    expect(pushToCustomer).toHaveBeenCalledTimes(1);
    const [request] = sentRequests();
    expect(request.uid).toBe("cust_1");
    expect(request.opts.purpose).toBe("supportReplies");
    expect(request.data).toEqual({ type: "ticket_escalated", targetId: "tk_esc" });
    // No internal tier name, no ticket number, no operator free text.
    expect(request.body).toBe(SUPPORT_ESCALATION_BODY);
    expect(request.body).not.toContain("brand support");
    expect(request.body).not.toContain("TICK-2026-1234");
    expect(request.body).not.toContain("9876543210");
    expect(request.body).not.toContain("Shivalik");
    // Escalation reached the DB before the push.
    expect((coreCalls[0].ticket["support_tickets/tk_esc"] as any).status).toBe("escalated");
  });

  it("does not re-page on a retried escalation transition", async () => {
    seedTicket("tk_esc2");
    const caller = { uid: "staff_1", role: "support" };

    await escalateTicket({
      ticketId: "tk_esc2",
      targetTier: "brand_support",
      reason: "first",
      escalatedBy: "staff_1",
      escalatedByName: "Staff One",
      caller,
    });
    // The monotonic guard refuses the replay before any side effect.
    await expect(
      escalateTicket({
        ticketId: "tk_esc2",
        targetTier: "brand_support",
        reason: "replay",
        escalatedBy: "staff_1",
        escalatedByName: "Staff One",
        caller,
      })
    ).rejects.toMatchObject({ code: "TICKET_ESCALATION_NOT_UPWARD" });

    expect(pushToCustomer).toHaveBeenCalledTimes(1);
  });
});

describe("resolution publisher", () => {
  it("drops the ticket number from resolution copy and classifies the send", async () => {
    seedTicket("tk_res");

    const result: any = await resolveTicket({
      ticketId: "tk_res",
      resolvedBy: "staff_1",
      resolvedByName: "Staff One",
      action: "explanation",
      notes: "Explained and closed.",
      caller: { uid: "staff_1", role: "support" },
    });

    expect(result.success).toBe(true);
    expect(pushToCustomer).toHaveBeenCalledTimes(1);
    const [request] = sentRequests();
    expect(request.uid).toBe("cust_1");
    expect(request.opts.purpose).toBe("supportReplies");
    expect(request.data).toEqual({ type: "ticket_resolved", targetId: "tk_res" });
    expect(request.body).not.toContain("TICK-2026-1234");
    expect(request.body).not.toContain("tk_res");
    expect(request.body).toContain("resolved");
  });

  it("names the refund only when money actually moved", () => {
    expect(supportResolutionBody(false)).not.toContain("refund");
    expect(supportResolutionBody(true)).toContain("refund");
  });
});

describe("note-only resolution publisher (resolveTicketNote)", () => {
  it("pages the customer once when a non-money note closes the ticket", async () => {
    seedTicket("tk_note");

    const result: any = await resolveTicketNote({
      ticketId: "tk_note",
      resolution: "Explained the delay; nothing to refund.",
      caller: { uid: "staff_1", role: "support" },
    });

    expect(result).toEqual({ success: true, ticketId: "tk_note" });
    // The close is persisted before the push.
    expect(store["support_tickets/tk_note"].status).toBe("resolved");
    expect(store["support_tickets/tk_note"].resolution).toBe(
      "Explained the delay; nothing to refund."
    );
    expect(pushToCustomer).toHaveBeenCalledTimes(1);

    const [request] = sentRequests();
    expect(request.uid).toBe("cust_1");
    expect(request.opts.purpose).toBe("supportReplies");
    expect(request.data).toEqual({ type: "ticket_resolved", targetId: "tk_note" });
    // Generic copy: no staff note, no ticket number, no refund claim.
    expect(request.body).not.toContain("Explained the delay");
    expect(request.body).not.toContain("TICK-2026-1234");
    expect(request.body).not.toContain("refund");
    // Push happened after the commit.
    expect((coreCalls[0].ticket["support_tickets/tk_note"] as any).status).toBe("resolved");
  });

  it("does not push a second time for a duplicate note-resolution attempt", async () => {
    seedTicket("tk_note_dup");
    const caller = { uid: "staff_1", role: "support" };

    await resolveTicketNote({ ticketId: "tk_note_dup", resolution: "Closed once.", caller });
    await expect(
      resolveTicketNote({ ticketId: "tk_note_dup", resolution: "Closed twice.", caller })
    ).rejects.toMatchObject({ code: "TICKET_NOT_PENDING" });

    expect(pushToCustomer).toHaveBeenCalledTimes(1);
    // The record still reflects the FIRST resolution.
    expect(store["support_tickets/tk_note_dup"].resolution).toBe("Closed once.");
  });

  it("keeps the persisted note when the push fails, and never retries it", async () => {
    seedTicket("tk_note_fail");
    pushToCustomer.mockRejectedValueOnce(new Error("messaging/internal-error"));

    const result: any = await resolveTicketNote({
      ticketId: "tk_note_fail",
      resolution: "Closed while FCM was down.",
      caller: { uid: "staff_1", role: "support" },
    });

    expect(result.success).toBe(true);
    expect(store["support_tickets/tk_note_fail"].status).toBe("resolved");
    expect(store["support_tickets/tk_note_fail"].resolution).toBe("Closed while FCM was down.");

    const attempts = Object.keys(store).filter((k) => k.startsWith("notification_dispatch/supportReplies:"));
    expect(attempts).toHaveLength(1);
    const attempt = store[attempts[0]];
    expect(attempt.outcome).toBe("unknown");
    expect(attempt.detail).toBe("sender_threw");
    // A replay is refused by the terminal-status guard, so no second push.
    await expect(
      resolveTicketNote({
        ticketId: "tk_note_fail",
        resolution: "retry",
        caller: { uid: "staff_1", role: "support" },
      })
    ).rejects.toMatchObject({ code: "TICKET_NOT_PENDING" });
    expect(pushToCustomer).toHaveBeenCalledTimes(1);
  });

  it("shares one resolution transition id shape with the money path (no cross-path double push)", async () => {
    seedTicket("tk_note_cross");
    await resolveTicketNote({
      ticketId: "tk_note_cross",
      resolution: "Closed by note.",
      caller: { uid: "staff_1", role: "support" },
    });

    // The money path on an already-closed ticket refuses before any side effect.
    await expect(
      resolveTicket({
        ticketId: "tk_note_cross",
        resolvedBy: "staff_1",
        resolvedByName: "Staff One",
        action: "explanation",
        notes: "money-style close",
        caller: { uid: "staff_1", role: "support" },
      })
    ).rejects.toMatchObject({ code: "TICKET_ALREADY_RESOLVED" });

    expect(pushToCustomer).toHaveBeenCalledTimes(1);
    const attempts = Object.keys(store).filter((k) =>
      k.startsWith("notification_dispatch/supportReplies:res_tk_note_cross_")
    );
    expect(attempts).toHaveLength(1);
  });

  it("keeps the staff/branch authorization boundary and pushes nothing on refusal", async () => {
    seedTicket("tk_note_auth", { branchId: "b1" });

    // Non-staff caller.
    await expect(
      resolveTicketNote({
        ticketId: "tk_note_auth",
        resolution: "customer self-close",
        caller: { uid: "cust_1", role: "customer" },
      })
    ).rejects.toMatchObject({ code: "TICKET_FORBIDDEN" });

    // Scoped staff outside the ticket's branch.
    await expect(
      resolveTicketNote({
        ticketId: "tk_note_auth",
        resolution: "other branch",
        caller: { uid: "staff_2", role: "branch_staff", branchIds: ["b2"] },
      })
    ).rejects.toMatchObject({ code: "TICKET_FORBIDDEN" });

    expect(pushToCustomer).not.toHaveBeenCalled();
    expect(store["support_tickets/tk_note_auth"].status).toBe("open");
  });
});
