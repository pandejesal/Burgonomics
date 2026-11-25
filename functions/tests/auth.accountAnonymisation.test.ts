import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * SEC-11 (A3 findings 1 and 2): a deleted account's personal data must be
 * ANONYMISED on every retained copy, not just on the profile documents.
 *
 * Owner decision 2026-11-25 #2: keep the amounts, dates and items for tax;
 * remove the name, phone, address and any other identifying field.
 *
 * These tests drive the REAL writer (`anonymiseDeletedUserPii` /
 * `anonymiseAndAuditDeletedUser`) through `onUserDeletedCleanup`, against an
 * in-memory Firestore fake with the query shapes the code actually uses
 * (equality + array-contains), so the assertions are about stored documents,
 * not about the shape of the patch helper alone.
 */
const { store, control, audits, writeFails, mockDb } = vi.hoisted(() => {
  const store = new Map<string, any>();
  const audits: any[] = [];
  const control = { auditThrow: false };
  const writeFails = new Set<string>();

  const matches = (data: any, filters: Array<[string, string, any]>) =>
    filters.every(([field, op, value]) => {
      const current = data?.[field];
      if (op === "==") return current === value;
      if (op === "array-contains") return Array.isArray(current) && current.includes(value);
      return false;
    });

  /**
   * Merge semantics that match the real server for `set(..., {merge:true})`:
   * the merge is SHALLOW — a field given as a map REPLACES the stored map
   * (it is not deep-merged), and a delete sentinel removes that field.
   */
  function mergeWrite(target: any, patch: Record<string, any>, merge: boolean): any {
    const next = merge && target ? { ...target } : {};
    for (const [key, value] of Object.entries(patch)) {
      if (value === "MOCK_DELETE") delete next[key];
      else next[key] = value;
    }
    return next;
  }

  function docRef(path: string, filters: Array<[string, string, any]>) {
    const ref: any = {
      path,
      id: path.split("/").pop() as string,
      get: async () => ({ exists: store.has(path), data: () => store.get(path) }),
      data: () => store.get(path),
      exists: store.has(path),
      set: async (data: any, options?: any) => {
        if (writeFails.has(path)) throw new Error(`write refused for ${path}`);
        store.set(path, mergeWrite(store.get(path), data, !!options?.merge));
      },
      delete: async () => {
        store.delete(path);
      },
      collection: (name: string) => collectionRef(`${path}/${name}`, []),
      // A chat thread's messages are reached through its own ref.
      listCollections: async () => [],
    };
    ref.ref = ref;
    if (filters.length) ref.__filters = filters;
    return ref;
  }

  function collectionRef(name: string, filters: Array<[string, string, any]>) {
    const api: any = {
      doc: (id: string) => docRef(`${name}/${id}`, []),
      add: async (data: any) => {
        if (control.auditThrow) throw new Error("audit down");
        const id = `auto_${audits.length + 1}`;
        audits.push({ id, ...data });
        store.set(`${name}/${id}`, data);
        return { id };
      },
      limit: () => api,
      orderBy: () => api,
      startAfter: () => api,
      get: async () => {
        const docs = [...store.keys()]
          .filter((p) => {
            if (!p.startsWith(`${name}/`)) return false;
            return !p.slice(name.length + 1).includes("/");
          })
          .filter((p) => matches(store.get(p), filters))
          .map((p) => docRef(p, []));
        return { docs, empty: docs.length === 0, size: docs.length };
      },
    };
    api.where = (field: string, op: string, value: any) =>
      collectionRef(name, [...filters, [field, op, value]]);
    return api;
  }

  const mockDb: any = {
    collection: (name: string) => collectionRef(name, []),
    batch: () => {
      const ops: Array<() => void> = [];
      return {
        delete: (ref: any) => ops.push(() => store.delete(ref.path)),
        set: (ref: any, data: any, options?: any) =>
          ops.push(async () => {
            store.set(ref.path, mergeWrite(store.get(ref.path), data, !!options?.merge));
          }),
        commit: async () => {
          for (const op of ops) await op();
        },
      };
    },
    recursiveDelete: async (ref: any) => {
      for (const p of [...store.keys()]) {
        if (p === ref.path || p.startsWith(`${ref.path}/`)) store.delete(p);
      }
    },
  };

  return { store, control, audits, writeFails, mockDb };
});

vi.mock("../src/core/firebase", () => ({
  db: mockDb,
  auth: { revokeRefreshTokens: vi.fn(async () => {}) },
}));

vi.mock("firebase-admin", () => {
  const FieldValue = {
    serverTimestamp: () => "MOCK_SERVER_TS",
    delete: () => "MOCK_DELETE",
  };
  const FieldPath = { documentId: () => "__name__" };
  const firestoreFn: any = vi.fn(() => mockDb);
  firestoreFn.FieldValue = FieldValue;
  firestoreFn.FieldPath = FieldPath;
  return {
    default: {
      firestore: firestoreFn,
      auth: vi.fn(() => ({ revokeRefreshTokens: vi.fn(async () => {}) })),
      messaging: vi.fn(() => ({})),
      initializeApp: vi.fn(),
      apps: [{ name: "mock" }],
    },
    firestore: firestoreFn,
    FieldValue,
    FieldPath,
    auth: vi.fn(() => ({ revokeRefreshTokens: vi.fn(async () => {}) })),
    initializeApp: vi.fn(),
    apps: [{ name: "mock" }],
  };
});

import {
  anonymiseDeletedUserPii,
  anonymiseAndAuditDeletedUser,
  orderAnonymisationPatch,
  ticketAnonymisationPatch,
  quoteAnonymisationPatch,
  ANONYMISED_NAME,
  ANONYMISATION_LEDGER,
} from "../src/modules/auth/accountAnonymisation";
import { onUserDeletedCleanup } from "../src/modules/auth/triggers";

const UID = "u_sec11";

function seed(): void {
  store.clear();
  audits.length = 0;
  control.auditThrow = false;
  writeFails.clear();

  store.set(`users/${UID}`, {
    phone: "+919800000001",
    email: "a@example.com",
    name: "Ada",
    addresses: [{ line1: "1 Test Road" }],
    fcmTokens: ["tok_1"],
    role: "customer",
  });
  store.set("customers/u_sec11", { name: "Ada", phone: "+919800000001" });
  store.set("device_tokens/tok_1", { userId: UID, token: "tok_1" });

  // A completed cash order WITH personal data, and full money fields.
  store.set(`orders/ord_cash`, {
    id: "ord_cash",
    orderId: "ord_cash",
    customerId: UID,
    userId: UID,
    branchId: "branch_a",
    customerName: "Ada Lovelace",
    customerPhone: "+919800000001",
    customerEmail: "a@example.com",
    address: { line1: "1 Test Road", lat: 21.1, lng: 72.7, contactPhone: "+919800000001" },
    deliveryAddress: { line1: "1 Test Road", contactName: "Ada" },
    notes: "Ring the bell twice",
    items: [
      { id: "p1", name: "Smash Burger", price: 149, quantity: 1, notes: "no onion" },
      { id: "p2", name: "Fries", price: 99, quantity: 1 },
    ],
    customerLines: [{ id: "p1", name: "Smash Burger", price: 149, quantity: 1, notes: "no onion" }],
    pricing: { grandTotal: 248, gst: 12 },
    totals: { grandTotal: 248 },
    cashDuePaise: 24800,
    cashCollectedPaise: 24800,
    paymentStatus: "paid",
    paymentChannel: "cash",
    whatsappOptIn: true,
    whatsappOptInAt: "MOCK_SERVER_TS",
    settlementEffectiveAtMs: 1_760_000_000_000,
    createdAt: "MOCK_SERVER_TS",
    cashReceipt: { orderId: "ord_cash", cashDuePaise: 24800, customerName: "Ada Lovelace" },
  });

  // A second order reached only through `userId` (legacy shape).
  store.set("orders/ord_legacy", {
    id: "ord_legacy",
    userId: UID,
    branchId: "branch_a",
    customerPhone: "+919800000001",
    items: [{ id: "p1", name: "Smash Burger", price: 149, quantity: 1 }],
    totals: { grandTotal: 149 },
    paymentStatus: "paid",
  });

  // Someone else's order must never be touched.
  store.set("orders/ord_other", {
    id: "ord_other",
    customerId: "u_other",
    customerName: "Grace",
    customerPhone: "+919800000009",
    items: [],
    totals: { grandTotal: 100 },
  });

  store.set("delivery_fee_quotes/quote_1", {
    uid: UID,
    branchId: "branch_a",
    dropLat: 21.1234,
    dropLng: 72.4321,
    fee: 39,
    expiresAt: 1_760_000_000_000,
    usedByOrderId: "ord_cash",
  });

  store.set("support_tickets/tkt_1", {
    customerId: UID,
    customerName: "Ada Lovelace",
    customerPhone: "+919800000001",
    subject: "Cold food",
    status: "open",
  });

  store.set("chats/chat_1", { participantIds: [UID, "staff_1"], lastMessageText: "hi" });
  store.set("chats/chat_1/messages/m1", {
    senderId: UID,
    senderName: "Ada",
    text: "my burger was cold",
    createdAt: "MOCK_SERVER_TS",
  });
  store.set("chats/chat_1/messages/m2", {
    senderId: "staff_1",
    senderName: "Support",
    text: "sorry about that",
    createdAt: "MOCK_SERVER_TS",
  });
}

describe("order anonymisation keeps money and drops the person", () => {
  beforeEach(seed);

  it("removes name, phone, email, addresses and notes but keeps amounts/dates/items", async () => {
    const counts = await anonymiseDeletedUserPii(UID);
    expect(counts.orders).toBe(2);
    const order = store.get("orders/ord_cash");
    expect(order.customerName).toBeUndefined();
    expect(order.customerPhone).toBeUndefined();
    expect(order.customerEmail).toBeUndefined();
    expect(order.notes).toBeUndefined();
    expect(order.address).toEqual({ anonymised: true });
    expect(order.deliveryAddress).toEqual({ anonymised: true });
    expect(order.whatsappOptIn).toBe(false);
    // Tax/accounting record survives intact.
    expect(order.cashDuePaise).toBe(24800);
    expect(order.cashCollectedPaise).toBe(24800);
    expect(order.paymentStatus).toBe("paid");
    expect(order.pricing).toEqual({ grandTotal: 248, gst: 12 });
    expect(order.settlementEffectiveAtMs).toBe(1_760_000_000_000);
    expect(order.createdAt).toBe("MOCK_SERVER_TS");
    expect(order.items.map((i: any) => [i.name, i.price, i.quantity])).toEqual([
      ["Smash Burger", 149, 1],
      ["Fries", 99, 1],
    ]);
    // The per-line free text and the receipt copy of the name are gone too.
    expect(order.items[0].notes).toBeUndefined();
    expect(order.customerLines[0].notes).toBeUndefined();
    expect(order.cashReceipt.customerName).toBeUndefined();
    expect(order.cashReceipt.cashDuePaise).toBe(24800);
  });

  it("covers the legacy userId-only order and never touches another customer's order", async () => {
    await anonymiseDeletedUserPii(UID);
    expect(store.get("orders/ord_legacy").customerPhone).toBeUndefined();
    expect(store.get("orders/ord_legacy").totals).toEqual({ grandTotal: 149 });
    expect(store.get("orders/ord_other")).toMatchObject({
      customerName: "Grace",
      customerPhone: "+919800000009",
    });
  });

  it("scrubs the delivery quote pin, the ticket contact and the chat sender name", async () => {
    const counts = await anonymiseDeletedUserPii(UID);
    const quote = store.get("delivery_fee_quotes/quote_1");
    expect(quote.dropLat).toBeUndefined();
    expect(quote.dropLng).toBeUndefined();
    expect(quote.uid).toBe(ANONYMISED_NAME);
    expect(quote.fee).toBe(39);
    expect(quote.usedByOrderId).toBe("ord_cash");
    expect(counts.quotes).toBe(1);

    const ticket = store.get("support_tickets/tkt_1");
    expect(ticket.customerName).toBe(ANONYMISED_NAME);
    expect(ticket.customerPhone).toBeUndefined();
    expect(ticket.subject).toBe("Cold food");
    expect(counts.tickets).toBe(1);

    expect(store.get("chats/chat_1/messages/m1").senderName).toBe(ANONYMISED_NAME);
    // The other participant's message is not ours to rewrite.
    expect(store.get("chats/chat_1/messages/m2").senderName).toBe("Support");
    expect(counts.messages).toBe(1);
  });

  it("is idempotent: a second run changes nothing and counts nothing", async () => {
    await anonymiseDeletedUserPii(UID);
    const snapshot = JSON.stringify([...store.entries()].sort());
    const second = await anonymiseDeletedUserPii(UID);
    expect(second.orders).toBe(0);
    expect(second.quotes).toBe(0);
    expect(second.tickets).toBe(0);
    expect(second.messages).toBe(0);
    expect(second.skipped).toBeGreaterThan(0);
    expect(JSON.stringify([...store.entries()].sort())).toBe(snapshot);
  });

  it("reports an incomplete run instead of claiming success when a write fails", async () => {
    writeFails.add("orders/ord_cash");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const counts = await anonymiseDeletedUserPii(UID);
    expect(counts.failed).toBeGreaterThan(0);
    // ...and the other records were still scrubbed.
    expect(store.get("support_tickets/tkt_1").customerPhone).toBeUndefined();
    warn.mockRestore();
  });
});

describe("chained from the account-deletion trigger, with audit", () => {
  beforeEach(seed);

  it("onUserDeletedCleanup erases the profile and anonymises the retained orders", async () => {
    await expect(onUserDeletedCleanup(UID)).resolves.toBe(true);
    expect(store.has("customers/u_sec11")).toBe(false);
    expect(store.has("device_tokens/tok_1")).toBe(false);
    expect(store.get("users/u_sec11").isDeleted).toBe(true);
    // The orders still exist, without the person on them.
    expect(store.has("orders/ord_cash")).toBe(true);
    expect(store.get("orders/ord_cash").customerPhone).toBeUndefined();
    expect(store.get("orders/ord_cash").cashDuePaise).toBe(24800);
  });

  it("writes one audit row and a per-uid ledger with the counts", async () => {
    await anonymiseAndAuditDeletedUser(UID);
    const audit = audits.find((row) => row.action === "account_deletion_pii_anonymised");
    expect(audit).toBeTruthy();
    expect(audit.targetType).toBe("user");
    expect(audit.targetId).toBe(UID);
    expect(audit.metadata.orders).toBe(2);
    expect(audit.metadata.complete).toBe(true);
    const ledger = store.get(`${ANONYMISATION_LEDGER}/${UID}`);
    expect(ledger).toMatchObject({ uid: UID, complete: true, orders: 2, messages: 1 });
  });

  it("finishes the erasure even when the audit writer is down", async () => {
    control.auditThrow = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const counts = await anonymiseAndAuditDeletedUser(UID);
    expect(counts.orders).toBe(2);
    expect(store.get("orders/ord_cash").customerPhone).toBeUndefined();
    warn.mockRestore();
  });
});

describe("patch helpers are pure and conservative", () => {
  it("an already-anonymised order yields no patch (idempotence by marker)", () => {
    expect(orderAnonymisationPatch({ piiAnonymisedAt: "MOCK_SERVER_TS", customerName: "Ada" })).toEqual({});
    expect(ticketAnonymisationPatch({ piiAnonymisedAt: "MOCK_SERVER_TS" })).toEqual({});
    expect(quoteAnonymisationPatch({ piiAnonymisedAt: "MOCK_SERVER_TS" })).toEqual({});
  });

  it("an order without PII still gets the marker so the job settles", () => {
    const patch = orderAnonymisationPatch({ id: "o1", totals: { grandTotal: 10 } });
    expect(Object.keys(patch).sort()).toEqual(["piiAnonymisedAt", "updatedAt"]);
  });
});
