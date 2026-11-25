import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * SEC-11 r2 — reviewer findings on the account-deletion scrub (Big Pickle,
 * security-c11 CHANGES_REQUIRED).
 *
 * Three gaps, all about copies of personal data the first pass missed:
 *
 *  1 (HIGH) `support_tickets.timeline[].actorName` still carried the customer's
 *    name: `ticketAnonymisationPatch` only deleted the TOP-LEVEL fields. Every
 *    timeline event authored by the customer (or attributed to the customer
 *    role) must be anonymised, and the raw uid must not survive in the ticket.
 *  2 (HIGH) …and the same class of nested copy exists in chat threads, where
 *    `participantNames[uid]` holds the display name.
 *  3 (MEDIUM) `scrubLineNotes(order.items ?? order.customerLines)` wrote ONE
 *    result into BOTH arrays, so when `items` and `customerLines` differ the
 *    `customerLines` copy was replaced by the `items` copy.
 *
 * Everything here drives the real `anonymiseDeletedUserPii` / patch helpers
 * against an in-memory Firestore fake, so the assertions are about stored
 * documents.
 */
const { store, mockDb } = vi.hoisted(() => {
  const store = new Map<string, any>();

  function merge(target: any, patch: Record<string, any>, mergeOn: boolean): any {
    const next = mergeOn && target ? { ...target } : {};
    for (const [k, v] of Object.entries(patch)) {
      if (v === "__DELETE__") delete next[k];
      else next[k] = v;
    }
    return next;
  }

  const docRef = (path: string): any => {
    const ref: any = {
      path,
      id: path.split("/").pop(),
      get: async () => ({ exists: store.has(path), data: () => store.get(path) }),
      set: async (data: any, options?: any) => {
        store.set(path, merge(store.get(path), data, !!options?.merge));
      },
      delete: async () => {
        store.delete(path);
      },
      collection: (name: string) => collectionRef(`${path}/${name}`),
      listCollections: async () => [],
    };
    ref.ref = ref;
    return ref;
  };

  function collectionRef(name: string): any {
    const build = (filters: Array<[string, string, any]>): any => {
      const api: any = {
        doc: (id: string) => docRef(`${name}/${id}`),
        orderBy: () => api,
        limit: () => api,
        startAfter: () => api,
        where: (field: string, op: string, value: any) => build([...filters, [field, op, value]]),
        get: async () => {
          const docs = [...store.keys()]
            .filter((p) => p.startsWith(`${name}/`) && !p.slice(name.length + 1).includes("/"))
            .filter((p) =>
              filters.every(([field, op, value]) => {
                const current = store.get(p)?.[field];
                if (op === "array-contains") return Array.isArray(current) && current.includes(value);
                return current === value;
              })
            )
            .map((p) => {
              const ref = docRef(p);
              return { id: ref.id, path: p, data: () => store.get(p), ref };
            });
          return { docs };
        },
      };
      return api;
    };
    return build([]);
  }

  const mockDb: any = { collection: (name: string) => collectionRef(name) };
  return { store, mockDb };
});

vi.mock("../src/core/firebase", () => ({
  db: mockDb,
  auth: { revokeRefreshTokens: vi.fn(async () => {}) },
}));

vi.mock("firebase-admin", () => {
  const FieldValue = {
    serverTimestamp: () => "MOCK_SERVER_TS",
    delete: () => "__DELETE__",
    increment: (n: number) => n,
  };
  const FieldPath = { documentId: () => "__name__" };
  const firestoreFn: any = vi.fn(() => mockDb);
  firestoreFn.FieldValue = FieldValue;
  firestoreFn.FieldPath = FieldPath;
  return {
    default: { firestore: firestoreFn, FieldValue, FieldPath },
    firestore: firestoreFn,
    FieldValue,
    FieldPath,
  };
});

import {
  anonymiseDeletedUserPii,
  orderAnonymisationPatch,
  ticketAnonymisationPatch,
  ANONYMISED_NAME,
} from "../src/modules/auth/accountAnonymisation";

const UID = "u_r2_nested";
const NAME = "Ada Lovelace";

function seedTicket(): void {
  store.set("support_tickets/tkt_r2", {
    id: "tkt_r2",
    ticketNumber: "TKT-1",
    customerId: UID,
    customerName: NAME,
    customerPhone: "+919800000909",
    subject: "Cold food",
    status: "open",
    branchId: "branch_a",
    timeline: [
      {
        action: "ticket_created",
        actorId: UID,
        actorName: NAME,
        actorRole: "customer",
        message: "Ticket raised: Cold food",
        timestamp: "2026-01-01T10:00:00.000Z",
      },
      {
        action: "message_added",
        actorId: UID,
        actorName: NAME,
        actorRole: "customer",
        message: "still cold",
        timestamp: "2026-01-01T10:05:00.000Z",
      },
      {
        action: "message_added",
        actorId: "staff_1",
        actorName: "Ravi (Support)",
        actorRole: "staff",
        message: "sorry about that",
        timestamp: "2026-01-01T10:06:00.000Z",
      },
      // A legacy event with no actorId but the customer role: must be caught by
      // the role arm, not just the id arm.
      {
        action: "message_added",
        actorName: NAME,
        actorRole: "customer",
        message: "any update?",
        timestamp: "2026-01-01T10:07:00.000Z",
      },
    ],
  });
}

function seedOrderWithDifferentArrays(): void {
  store.set("orders/ord_r2", {
    id: "ord_r2",
    customerId: UID,
    items: [
      { id: "p1", name: "Smash Burger", price: 149, quantity: 2, notes: "no onion" },
      { id: "p2", name: "Fries", price: 99, quantity: 1 },
    ],
    // A DIFFERENT array: one line only, its own note text.
    customerLines: [{ id: "p1", name: "Smash Burger", price: 149, quantity: 2, note: "extra cheese" }],
    totals: { grandTotal: 397 },
    paymentStatus: "paid",
  });
}

function seedChat(): void {
  store.set("chats/chat_r2", {
    id: "chat_r2",
    type: "direct_dm",
    title: `${NAME} & Ravi`,
    participantIds: [UID, "staff_1"],
    participantNames: { [UID]: NAME, staff_1: "Ravi" },
  });
  store.set("chats/chat_r2/messages/m1", { senderId: UID, senderName: NAME, text: "hello" });
}

beforeEach(() => {
  store.clear();
  seedTicket();
  seedOrderWithDifferentArrays();
  seedChat();
});

describe("ticket timeline no longer names the deleted customer", () => {
  it("anonymises every event authored by the customer (by uid AND by role)", async () => {
    await anonymiseDeletedUserPii(UID);
    const ticket = store.get("support_tickets/tkt_r2");

    expect(ticket.customerName).toBe(ANONYMISED_NAME);
    const timeline = ticket.timeline as any[];
    expect(timeline).toHaveLength(4);

    // The two uid-attributed events and the role-only legacy event.
    expect(timeline[0].actorName).toBe(ANONYMISED_NAME);
    expect(timeline[1].actorName).toBe(ANONYMISED_NAME);
    expect(timeline[3].actorName).toBe(ANONYMISED_NAME);

    // The staff event keeps the staff member's name: the case history is intact.
    expect(timeline[2].actorName).toBe("Ravi (Support)");
    expect(timeline[2].actorRole).toBe("staff");

    // The case itself survives.
    expect(ticket.subject).toBe("Cold food");
    expect(ticket.status).toBe("open");
    expect(timeline[1].message).toBe("still cold");
  });

  it("leaves neither the name nor the uid on any timeline event", async () => {
    await anonymiseDeletedUserPii(UID);
    const ticket = store.get("support_tickets/tkt_r2");

    // The name is gone from the whole document.
    const serialised = JSON.stringify(ticket);
    expect(serialised).not.toContain(NAME);
    expect(serialised).not.toContain("Ada");

    // No timeline event carries the deleted uid or the name any more.
    const timelineSerialised = JSON.stringify(ticket.timeline);
    expect(timelineSerialised).not.toContain(UID);
    expect(timelineSerialised).not.toContain(NAME);

    // The ONE retained reference is the structural account key `customerId`:
    // it is what the read rule (`resource.data.customerId == request.auth.uid`),
    // the retention/audit trail and the deletion ledger key on, and it points at
    // an Auth account that no longer exists. Asserted explicitly so a future
    // edit cannot quietly widen it back into the timeline or a name field.
    const occurrences = serialised.split(UID).length - 1;
    expect(occurrences).toBe(1);
    expect(ticket.customerId).toBe(UID);
  });

  it("is idempotent for a ticket whose identity was already replaced", async () => {
    await anonymiseDeletedUserPii(UID);
    const first = store.get("support_tickets/tkt_r2");
    await anonymiseDeletedUserPii(UID);
    expect(store.get("support_tickets/tkt_r2")).toEqual(first);
  });

  it("the pure patch helper scrubs the timeline without a uid (role arm only)", () => {
    const patch = ticketAnonymisationPatch(store.get("support_tickets/tkt_r2"));
    const timeline = patch.timeline as any[];
    expect(timeline[0].actorName).toBe(ANONYMISED_NAME);
    expect(timeline[2].actorName).toBe("Ravi (Support)");
  });
});

describe("chat threads no longer name the deleted participant", () => {
  it("replaces the display name in participantNames and the DM title", async () => {
    await anonymiseDeletedUserPii(UID);
    const chat = store.get("chats/chat_r2");
    expect(chat.participantNames[UID]).toBe(ANONYMISED_NAME);
    expect(JSON.stringify(chat)).not.toContain(NAME);
    // The other participant's name is not ours to rewrite.
    expect(chat.participantNames.staff_1).toBe("Ravi");
    expect(store.get("chats/chat_r2/messages/m1").senderName).toBe(ANONYMISED_NAME);
  });
});

describe("items and customerLines are scrubbed independently", () => {
  it("keeps each array's own lines, minus the notes", async () => {
    await anonymiseDeletedUserPii(UID);
    const order = store.get("orders/ord_r2");

    expect(order.items).toEqual([
      { id: "p1", name: "Smash Burger", price: 149, quantity: 2 },
      { id: "p2", name: "Fries", price: 99, quantity: 1 },
    ]);
    expect(order.customerLines).toEqual([
      { id: "p1", name: "Smash Burger", price: 149, quantity: 2 },
    ]);
    expect(order.totals).toEqual({ grandTotal: 397 });
  });

  it("the pure patch helper writes two separate arrays when both differ", () => {
    const patch = orderAnonymisationPatch(store.get("orders/ord_r2"));
    expect((patch.items as any[]).map((i) => i.id)).toEqual(["p1", "p2"]);
    expect((patch.customerLines as any[]).map((i) => i.id)).toEqual(["p1"]);
  });

  it("an order with only customerLines still gets its notes scrubbed", () => {
    const patch = orderAnonymisationPatch({
      id: "o1",
      customerLines: [{ id: "p1", name: "Burger", notes: "no onion" }],
      totals: { grandTotal: 149 },
    });
    expect(patch.customerLines).toEqual([{ id: "p1", name: "Burger" }]);
    expect(patch.items).toBeUndefined();
  });
});
