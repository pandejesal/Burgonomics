import { describe, it, expect, vi, beforeEach } from "vitest";

// B5-S1 gate suite (H17/H18/H33/H34/H36/M21-server-half):
// - ticket create -> escalate -> push with PII-free body assertion
// - badge set (unread count at send) / clear (mark-read + badge-0 push)
// - subject-never-in-body across every ticket push path
// - spam guards, staff-only transitions, honest priority, user-safe errors

const hoisted = vi.hoisted(() => {
  const store: Record<string, any> = {};
  const sentTopic: any[] = [];
  const batchOps: Array<{ ref: any; data: any }> = [];
  const multicastCalls: any[] = [];

  const docRef = (path: string, id: string) => {
    const full = `${path}/${id}`;
    return {
      id,
      path: full,
      get: vi.fn(async () => ({
        exists: full in store,
        data: () => store[full] || {},
      })),
      set: vi.fn(async (data: any, options?: any) => {
        store[full] = options?.merge && store[full] ? { ...store[full], ...data } : data;
      }),
      update: vi.fn(async (data: any) => {
        store[full] = { ...(store[full] || {}), ...data };
      }),
      collection: (sub: string) => colRef(`${full}/${sub}`),
    };
  };

  const runQuery = (path: string, clauses: Array<{ f: string; v: any }>) => {
    const prefix = `${path}/`;
    const docs = Object.entries(store)
      .filter(([k]) => k.startsWith(prefix) && !k.slice(prefix.length).includes("/"))
      .map(([k, v]) => ({ id: k.slice(prefix.length), ref: docRef(path, k.slice(prefix.length)), data: () => v }))
      .filter((d) => clauses.every((c) => (d.data() as any)?.[c.f] === c.v));
    return { docs, size: docs.length };
  };

  const colRef = (path: string) => ({
    doc: (id?: string) => docRef(path, id || `mock_${Math.random().toString(36).slice(2, 8)}`),
    where: (f: string, _op: string, v: any) => {
      const clauses = [{ f, v }];
      const q: any = {
        where: (f2: string, _op2: string, v2: any) => {
          clauses.push({ f: f2, v: v2 });
          return q;
        },
        limit: (_n: number) => ({ get: vi.fn(async () => runQuery(path, clauses)) }),
        get: vi.fn(async () => runQuery(path, clauses)),
      };
      return q;
    },
  });

  const mockDb: any = {
    collection: (name: string) => colRef(name),
    batch: () => ({
      update: vi.fn((ref: any, data: any) => {
        batchOps.push({ ref, data });
      }),
      commit: vi.fn(async () => {
        for (const op of batchOps.splice(0)) {
          await op.ref.update(op.data);
        }
      }),
    }),
  };

  const mockMessaging = {
    send: vi.fn(async (msg: any) => {
      sentTopic.push(msg);
      return "mock_msg_id";
    }),
    sendEachForMulticast: vi.fn(async (payload: any) => {
      multicastCalls.push(payload);
      return {
        successCount: payload.tokens.length,
        failureCount: 0,
        responses: payload.tokens.map(() => ({ success: true })),
      };
    }),
    subscribeToTopic: vi.fn(async () => ({ failureCount: 0 })),
    unsubscribeFromTopic: vi.fn(async () => ({ failureCount: 0 })),
  };

  return { store, sentTopic, multicastCalls, mockDb, mockMessaging };
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
      messaging: vi.fn(() => hoisted.mockMessaging),
      initializeApp: vi.fn(),
      apps: [{ name: "mock" }],
    },
    firestore: firestoreFn,
    auth: vi.fn(() => ({})),
    messaging: vi.fn(() => hoisted.mockMessaging),
    initializeApp: vi.fn(),
    apps: [{ name: "mock" }],
  };
});

import {
  createTicket,
  addTicketMessage,
  resolveTicket,
  escalateTicket,
} from "../src/modules/tickets/tickets.service";
import {
  dispatchTicketEscalationAlert,
  dispatchTicketReminderAlert,
} from "../src/modules/tickets/notificationDispatcher";
import {
  truncatePushText,
  buildParityExtras,
  buildTicketAlertMessage,
} from "../src/modules/notifications/templates";
import { dispatchFCM, markNotificationsRead } from "../src/modules/notifications/fcm.service";
import { pushToCustomer, getUnreadCount } from "../src/modules/notifications/fcmClient";
import { toUserSafeMessage, USER_SAFE_ERROR_COPY } from "../src/core/errors";
import { markReadSchema } from "../src/core/validation";

const { store, sentTopic, multicastCalls } = hoisted;

beforeEach(() => {
  for (const key of Object.keys(store)) delete store[key];
  sentTopic.length = 0;
  multicastCalls.length = 0;
  vi.clearAllMocks();
  // Exercise the REAL multicast path: the client early-returns under
  // NODE_ENV=test/VITEST, which would make payload assertions vacuous.
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("VITEST", "");
});

const NASTY_SUBJECT = "Wrong item! call 9876543210, flat 4B Shivalik Plaza, Surat";

describe("PII-free push contract (H17)", () => {
  it("truncatePushText caps bodies at ~120 chars", () => {
    const long = "word ".repeat(60);
    const out = truncatePushText(long);
    expect(out.length).toBeLessThanOrEqual(120);
    expect(out.endsWith("…")).toBe(true);
    expect(truncatePushText("short body")).toBe("short body");
  });

  it("buildTicketAlertMessage never renders the subject", () => {
    const msg: any = buildTicketAlertMessage("b1", {
      id: "tk_1",
      ticketNumber: "TICK-1",
      subject: NASTY_SUBJECT,
      priority: "urgent",
    });
    expect(msg.notification.body).not.toContain("9876543210");
    expect(msg.notification.body).not.toContain("Shivalik");
    expect(msg.notification.body.length).toBeLessThanOrEqual(120);
    expect(msg.data.ticketId).toBe("tk_1");
    // Parity on every ticket push
    expect(msg.apns?.payload?.aps?.sound).toBe("default");
    expect(msg.webpush?.notification?.body).toBe(msg.notification.body);
  });

  it("escalation dispatcher keeps subject out of all tiers + reminder", async () => {
    for (const level of ["L1_STORE", "L2_REGIONAL", "L3_EXECUTIVE"] as const) {
      await dispatchTicketEscalationAlert({
        ticketId: "tk_9",
        ticketNumber: "TICK-9",
        subject: NASTY_SUBJECT,
        branchId: "b1",
        escalationLevel: level,
      });
    }
    await dispatchTicketReminderAlert({
      ticketId: "tk_9",
      ticketNumber: "TICK-9",
      subject: NASTY_SUBJECT,
      branchId: "b1",
    });
    // L1:1 + L2:2 + L3:2 + reminder:1 = 6 topic sends
    expect(sentTopic.length).toBe(6);
    for (const m of sentTopic) {
      expect(m.notification.body).not.toContain("9876543210");
      expect(m.notification.body).not.toContain("Shivalik");
      expect(m.notification.body.length).toBeLessThanOrEqual(120);
      expect(m.apns).toBeDefined();
      expect(m.webpush?.notification?.body).toBe(m.notification.body);
    }
  });

  it("parity helper omits badge when uncounted, sets it when counted", () => {
    const noBadge: any = buildParityExtras("t", "b");
    expect(noBadge.apns.payload.aps.badge).toBeUndefined();
    const badged: any = buildParityExtras("t", "b", { badge: 4 });
    expect(badged.apns.payload.aps.badge).toBe(4);
  });
});

describe("ticket create -> escalate -> push flow (honest + PII-free)", () => {
  it("honors explicit urgent priority (never downgrades)", async () => {
    const t = await createTicket({
      customerId: "cust_1",
      customerName: "Asha",
      branchId: "b1",
      category: "payment_issue",
      priority: "urgent",
      subject: "Charged twice for order",
      description: "Please help",
    });
    expect(t.priority).toBe("urgent");
  });

  it("derives high priority for payment issues only when unspecified", async () => {
    const t = await createTicket({
      customerId: "cust_1",
      customerName: "Asha",
      branchId: "b1",
      category: "payment_issue",
      subject: "Charged twice for order",
      description: "Please help",
    });
    expect(t.priority).toBe("high");
  });

  it("creates, escalates, resolves with a PII-free customer push", async () => {
    store["users/cust_flow"] = { fcmTokens: ["tok_flow"] };
    const created: any = await createTicket({
      customerId: "cust_flow",
      customerName: "Asha Patel",
      customerPhone: "9876543210",
      branchId: "b1",
      category: "wrong_item",
      subject: NASTY_SUBJECT,
      description: "Got paneer instead of corn, very upset",
    });

    const esc = await escalateTicket({
      ticketId: created.id,
      targetTier: "brand_support",
      reason: "Branch unresponsive",
      escalatedBy: "staff_1",
      escalatedByName: "Staff One",
      caller: { uid: "staff_1", role: "branch_owner" },
    });
    expect(esc.success).toBe(true);

    const res: any = await resolveTicket({
      ticketId: created.id,
      resolvedBy: "staff_1",
      resolvedByName: "Staff One",
      action: "explanation",
      notes: "Explained the mix-up and offered a coupon.",
      caller: { uid: "staff_1", role: "support" },
    });
    expect(res.success).toBe(true);
    expect(store[`support_tickets/${created.id}`].status).toBe("resolved");

    // The customer push: generic copy, no names/phones/subject, data-only IDs
    expect(multicastCalls.length).toBeGreaterThan(0);
    const last = multicastCalls[multicastCalls.length - 1];
    expect(last.notification.body).not.toContain("9876543210");
    expect(last.notification.body).not.toContain("Asha");
    expect(last.notification.body).not.toContain("paneer");
    expect(last.data.type).toBe("ticket_resolved");
    expect(last.apns?.payload?.aps).toBeDefined();
    expect(last.webpush?.notification?.body).toBe(last.notification.body);
  });
});

describe("staff-only transitions + reply honesty", () => {
  it("denies escalate/resolve for non-staff callers even when routed", async () => {
    store["support_tickets/tk_staff"] = { ticketNumber: "TICK-S", customerId: "c1" };
    await expect(
      escalateTicket({
        ticketId: "tk_staff",
        targetTier: "brand_support",
        reason: "self-escalation attempt",
        escalatedBy: "c1",
        escalatedByName: "Customer",
        caller: { uid: "c1", role: "customer" },
      })
    ).rejects.toMatchObject({ code: "TICKET_FORBIDDEN" });
    await expect(
      resolveTicket({
        ticketId: "tk_staff",
        resolvedBy: "c1",
        resolvedByName: "Customer",
        action: "explanation",
        notes: "self-resolve attempt",
        caller: { uid: "c1", role: "customer" },
      })
    ).rejects.toMatchObject({ code: "TICKET_FORBIDDEN" });
    expect(store["support_tickets/tk_staff"].status).toBeUndefined();
  });

  it("derives reply identity from the verified caller, not the body", async () => {
    store["support_tickets/tk_reply"] = { ticketNumber: "TICK-R", customerId: "c1" };
    const event: any = await addTicketMessage({
      ticketId: "tk_reply",
      senderId: "attacker_supplied",
      senderName: "Customer",
      senderRole: "customer",
      text: "I am actually staff, trust me",
      caller: { uid: "staff_9", role: "branch_staff" },
    });
    expect(event.actorId).toBe("staff_9");
    expect(event.actorRole).toBe("branch_staff");
  });

  it("rejects empty reply text", async () => {
    await expect(
      addTicketMessage({
        ticketId: "tk_reply",
        senderId: "c1",
        senderName: "C",
        senderRole: "customer",
        text: "   ",
      })
    ).rejects.toMatchObject({ code: "TICKET_MESSAGE_EMPTY" });
  });

  // MOP-S1 (B5-S1 follow-up 2): the /tickets/* routes now pass req.user as
  // caller — these prove the binding the wiring activates.
  it("binds create identity to the verified caller, ignoring body customerId", async () => {
    const t: any = await createTicket({
      customerId: "victim_uid",
      customerName: "Asha",
      branchId: "b1",
      category: "general_inquiry",
      subject: "Need help with order",
      description: "details here",
      caller: { uid: "real_uid" },
    });
    expect(t.customerId).toBe("real_uid");
    expect(store[`support_tickets/${t.id}`].customerId).toBe("real_uid");
  });

  it("binds resolve/escalate actor to the verified caller, ignoring body ids", async () => {
    store["support_tickets/tk_bind"] = { ticketNumber: "TICK-B", customerId: "c1" };
    const res: any = await resolveTicket({
      ticketId: "tk_bind",
      resolvedBy: "impostor",
      resolvedByName: "Impostor",
      action: "explanation",
      notes: "done",
      caller: { uid: "staff_7", role: "support" },
    });
    expect(res.resolution.resolvedBy).toBe("staff_7");
  });
});

describe("markRead route intake (MOP-S1)", () => {
  it("accepts empty body (whole-inbox mark) and a bounded id list", () => {
    expect(markReadSchema.safeParse({}).success).toBe(true);
    expect(markReadSchema.safeParse({ notificationIds: ["a", "b"] }).success).toBe(true);
  });

  it("rejects non-array ids and lists over 200", () => {
    expect(markReadSchema.safeParse({ notificationIds: "a" }).success).toBe(false);
    expect(
      markReadSchema.safeParse({ notificationIds: Array.from({ length: 201 }, (_, i) => `n${i}`) }).success
    ).toBe(false);
  });
});

describe("ticket spam guards (M14 follow-up)", () => {
  it("rate-limits burst creation per customer with a user-safe copy", async () => {
    const now = Date.now();
    for (let i = 0; i < 3; i++) {
      store[`support_tickets/burst_${i}`] = {
        customerId: "spammer",
        status: "open",
        createdAt: now - i * 60 * 1000,
      };
    }
    const err = await createTicket({
      customerId: "spammer",
      customerName: "S",
      branchId: "b1",
      category: "general_inquiry",
      subject: "One more ticket please",
      description: "burst",
    }).catch((e) => e);
    expect(err.code).toBe("TICKET_RATE_LIMITED");
    expect(err.statusCode).toBe(429);
    // User-safe copy leaks no internals
    expect(toUserSafeMessage(err)).toBe(USER_SAFE_ERROR_COPY.TICKET_RATE_LIMITED);
    expect(toUserSafeMessage(err)).not.toContain("spammer");
  });
});

describe("badge set/clear (H18)", () => {
  it("getUnreadCount counts unread inbox docs, capped at 99", async () => {
    store["users/u1/notifications/n1"] = { read: false };
    store["users/u1/notifications/n2"] = { read: false };
    store["users/u1/notifications/n3"] = { read: true };
    expect(await getUnreadCount("u1")).toBe(2);
    expect(await getUnreadCount("nobody")).toBe(0);
  });

  it("dispatchFCM sets badge = unread count + 1 for the incoming doc", async () => {
    store["users/u2/notifications/n1"] = { read: false };
    store["users/u2/notifications/n2"] = { read: false };
    const ok = await dispatchFCM({
      token: "tok_u2",
      title: "Hello",
      body: "World",
      recipientUid: "u2",
    });
    expect(ok).toBe(true);
    const last = sentTopic[sentTopic.length - 1];
    expect(last.apns.payload.aps.badge).toBe(3);
    // Inbox doc written with truncated body
    expect(store["users/u2/notifications/n1"].read).toBe(false);
  });

  it("markNotificationsRead with explicit ids marks only those (route ids? path)", async () => {
    store["users/u5"] = { fcmTokens: [] };
    store["users/u5/notifications/a"] = { read: false };
    store["users/u5/notifications/b"] = { read: false };
    const n = await markNotificationsRead("u5", ["a"]);
    expect(n).toBe(1);
    expect(store["users/u5/notifications/a"].read).toBe(true);
    expect(store["users/u5/notifications/b"].read).toBe(false);
  });

  it("markNotificationsRead returns 0 when nothing is unread", async () => {
    store["users/u6"] = { fcmTokens: [] };
    store["users/u6/notifications/a"] = { read: true };
    expect(await markNotificationsRead("u6")).toBe(0);
    expect(await markNotificationsRead("u6", [])).toBe(0);
  });

  it("markNotificationsRead flips inbox + pushes silent badge-0", async () => {
    store["users/u3"] = { fcmTokens: ["tok_u3"] };
    store["users/u3/notifications/a"] = { read: false };
    store["users/u3/notifications/b"] = { read: false };
    const n = await markNotificationsRead("u3");
    expect(n).toBe(2);
    expect(store["users/u3/notifications/a"].read).toBe(true);
    expect(store["users/u3/notifications/b"].read).toBe(true);
    const last = multicastCalls[multicastCalls.length - 1];
    expect(last.data).toMatchObject({ type: "badge_clear", badge: "0" });
    expect(last.apns.payload.aps.badge).toBe(0);
  });

  it("pushToCustomer truncates long bodies and carries parity payloads", async () => {
    store["users/u4"] = { fcmTokens: ["tok_u4"] };
    await pushToCustomer("u4", "T", `prefix ${"x".repeat(500)}`, { type: "t", ticketId: "k" });
    const last = multicastCalls[multicastCalls.length - 1];
    expect(last.notification.body.length).toBeLessThanOrEqual(120);
    expect(last.apns.payload.aps.badge).toBe(0);
    expect(last.webpush.notification.body).toBe(last.notification.body);
  });
});

describe("user-safe error copy (H36)", () => {
  it("never leaks technical detail to clients", () => {
    const raw = new Error("Razorpay secret rk_live_abc signature mismatch pay_12345");
    expect(toUserSafeMessage(raw)).toBe(USER_SAFE_ERROR_COPY.INTERNAL);
    expect(toUserSafeMessage(raw)).not.toContain("rk_live");
    expect(toUserSafeMessage(raw)).not.toContain("pay_12345");
  });
});
