import { describe, it, expect, vi, beforeEach } from "vitest";

// Regression: a staff reply sets the ticket to `in_progress`
// (tickets.service.addTicketMessage), but the inactivity worker queried only
// ["open","escalated"]. Any ticket a human had replied to therefore dropped out
// of the scan permanently: no reminder, no escalation, and no way back in, even
// long past the tier SLA. The fix widens the query in the scheduler.
//
// The double below models Firestore's `in` filter for real (it intersects the
// stored value with the operator's array), because a permissive double that
// ignores `where` is exactly what let this ship.

const { mockDb, savedDocs, state } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  const state = { lastInFilter: null as string[] | null, batchWrites: 0 };

  // Real Firestore semantics for a dotted key in an update payload: it names a
  // NESTED field (`assignedTo.tier`), never a literal dotted document key.
  const applyWrite = (path: string, data: Record<string, any>, merge: boolean) => {
    const target: Record<string, any> = merge ? { ...(savedDocs[path] || {}) } : {};
    for (const [key, value] of Object.entries(data)) {
      if (key.includes(".")) {
        const parts = key.split(".");
        let node: any = target;
        for (let i = 0; i < parts.length - 1; i++) {
          const part = parts[i];
          node[part] = node[part] && typeof node[part] === "object" ? { ...node[part] } : {};
          node = node[part];
        }
        node[parts[parts.length - 1]] = value;
      } else {
        target[key] = value;
      }
    }
    savedDocs[path] = target;
  };

  const docRef = (col: string, id: string) => {
    const path = col + "/" + id;
    return {
      id,
      path,
      get: vi.fn(async () => ({
        exists: Object.prototype.hasOwnProperty.call(savedDocs, path),
        data: () => savedDocs[path],
        ref: docRef(col, id),
      })),
      set: vi.fn(async (data: any, opts?: any) => {
        savedDocs[path] =
          opts?.merge && savedDocs[path] ? { ...savedDocs[path], ...data } : data;
      }),
      update: vi.fn(async (data: any) => {
        savedDocs[path] = { ...(savedDocs[path] || {}), ...data };
      }),
    };
  };

  const collectionRef = (col: string) => {
    const filters: Array<{ kind: "in" | "eq"; field: string; value: any }> = [];
    const q: any = {
      where: (field: string, op: string, value: any) => {
        if (op === "in") {
          filters.push({ kind: "in", field, value });
          state.lastInFilter = value;
        } else if (op === "==") {
          filters.push({ kind: "eq", field, value });
        }
        return q;
      },
      orderBy: () => q,
      limit: () => q,
      get: vi.fn(async () => {
        const docs = Object.keys(savedDocs)
          .filter((p) => p.startsWith(col + "/"))
          .filter((p) =>
            filters.every((f) =>
              f.kind === "in"
                ? Array.isArray(f.value) && f.value.includes(savedDocs[p]?.[f.field])
                : savedDocs[p]?.[f.field] === f.value
            )
          )
          .map((p) => {
            const id = p.slice(col.length + 1);
            return { id, ref: docRef(col, id), exists: true, data: () => savedDocs[p] };
          });
        return { docs, empty: docs.length === 0 };
      }),
    };
    return q;
  };

  const batch = () => {
    const ops: Array<() => void> = [];
    return {
      update: (ref: any, data: any) => {
        ops.push(() => applyWrite(ref.path, data, true));
        state.batchWrites += 1;
        return b;
      },
      set: (ref: any, data: any, opts?: any) => {
        ops.push(() => applyWrite(ref.path, data, !!opts?.merge));
        state.batchWrites += 1;
        return b;
      },
      commit: async () => {
        for (const op of ops) op();
      },
    };
    // eslint-disable-next-line no-unreachable
    var b: any;
  };

  const mockDb: any = {
    collection: (col: string) => {
      const c: any = collectionRef(col);
      c.doc = (id?: string) => docRef(col, id || "auto");
      return c;
    },
    batch,
    runTransaction: vi.fn(async (fn: any) =>
      fn({ get: (ref: any) => ref.get(), set: (ref: any, d: any, o?: any) => ref.set(d, o) })
    ),
  };
  return { mockDb, savedDocs, state };
});

vi.mock("firebase-admin", () => {
  const FieldValue = {
    serverTimestamp: () => ({ __sentinel: "serverTimestamp" }),
    increment: (n: number) => ({ __sentinel: "increment", n }),
    arrayUnion: (item: any) => ({ __sentinel: "arrayUnion", item }),
    delete: () => ({ __sentinel: "delete" }),
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

// The alert fan-out is a transport concern owned by its own suite; stub it so
// this file asserts selection + escalation only.
vi.mock("../src/modules/notifications/fcmClient", () => ({
  sendFcmMessage: vi.fn(async () => true),
}));
vi.mock("../src/modules/notifications/sendGate", () => ({
  TRUSTED_SERVER_ACTOR: { trusted: true },
}));
vi.mock("../src/modules/notifications/templates", () => ({
  truncatePushText: (s: string) => s,
  buildParityExtras: () => ({}),
}));

import { checkTicketInactivityReminders } from "../src/modules/tickets/ticketReminder.scheduler";

const now = Date.now();
const MIN = 60 * 1000;

// A real support_tickets doc as `createTicket` writes it, plus the fields
// `addTicketMessage` / `escalateTicket` layer on.
const seedTicket = (id: string, over: Record<string, any> = {}) => {
  savedDocs["support_tickets/" + id] = {
    id,
    ticketNumber: "TICK-2026-0001",
    customerId: "cust_t1",
    customerName: "Asha",
    customerPhone: "",
    orderId: null,
    branchId: "branch_t1",
    category: "wrong_item",
    priority: "medium",
    status: "open",
    subject: "Missing fries",
    description: "No fries in the bag",
    attachments: [],
    assignedTo: { tier: "branch" },
    timeline: [],
    diagnostics: {},
    branchReminderSent: false,
    createdAt: new Date(now - 10 * MIN).toISOString(),
    updatedAt: new Date(now - 10 * MIN).toISOString(),
    lastActivityAt: new Date(now - 10 * MIN).toISOString(),
    ...over,
  };
};

describe("ticket inactivity worker - staff-replied tickets stay on the ladder", () => {
  beforeEach(() => {
    for (const key of Object.keys(savedDocs)) delete savedDocs[key];
    state.lastInFilter = null;
    state.batchWrites = 0;
  });

  it("includes in_progress in the scanned status set", async () => {
    seedTicket("tk_open", { status: "open" });
    await checkTicketInactivityReminders();
    expect(state.lastInFilter).not.toBeNull();
    expect(state.lastInFilter).toEqual(
      expect.arrayContaining(["open", "in_progress", "escalated"])
    );
  });

  it("escalates a ticket sitting in in_progress past its SLA", async () => {
    // The exact shape addTicketMessage leaves behind: status flipped by a staff
    // reply, lastActivityAt 70 minutes ago (past the 60-minute branch SLA).
    seedTicket("tk_replied", {
      status: "in_progress",
      lastActivityAt: new Date(now - 70 * MIN).toISOString(),
    });
    await checkTicketInactivityReminders();
    expect(savedDocs["support_tickets/tk_replied"].status).toBe("escalated");
    expect(savedDocs["support_tickets/tk_replied"].assignedTo.tier).toBe("brand_support");
  });

  it("escalates a staff-replied ticket that had already reached brand_support", async () => {
    seedTicket("tk_replied_l2", {
      status: "in_progress",
      assignedTo: { tier: "brand_support" },
      escalationTier: "brand_support",
      lastActivityAt: new Date(now - 130 * MIN).toISOString(),
    });
    await checkTicketInactivityReminders();
    expect(savedDocs["support_tickets/tk_replied_l2"].status).toBe("escalated");
    expect(savedDocs["support_tickets/tk_replied_l2"].assignedTo.tier).toBe(
      "developer_team"
    );
  });

  it("still ignores resolved and closed tickets", async () => {
    seedTicket("tk_resolved", {
      status: "resolved",
      lastActivityAt: new Date(now - 500 * MIN).toISOString(),
    });
    seedTicket("tk_closed", {
      status: "closed",
      lastActivityAt: new Date(now - 500 * MIN).toISOString(),
    });
    await checkTicketInactivityReminders();
    expect(savedDocs["support_tickets/tk_resolved"].status).toBe("resolved");
    expect(savedDocs["support_tickets/tk_closed"].status).toBe("closed");
    expect(savedDocs["support_tickets/tk_resolved"].assignedTo.tier).toBe("branch");
  });

  it("does not escalate an in_progress ticket still inside the SLA window", async () => {
    seedTicket("tk_fresh", {
      status: "in_progress",
      lastActivityAt: new Date(now - 5 * MIN).toISOString(),
    });
    await checkTicketInactivityReminders();
    expect(savedDocs["support_tickets/tk_fresh"].status).toBe("in_progress");
    expect(savedDocs["support_tickets/tk_fresh"].assignedTo.tier).toBe("branch");
  });

  it("keeps escalating open tickets exactly as before (no regression)", async () => {
    seedTicket("tk_plain_open", {
      status: "open",
      lastActivityAt: new Date(now - 70 * MIN).toISOString(),
    });
    await checkTicketInactivityReminders();
    expect(savedDocs["support_tickets/tk_plain_open"].status).toBe("escalated");
    expect(savedDocs["support_tickets/tk_plain_open"].assignedTo.tier).toBe(
      "brand_support"
    );
  });
});
