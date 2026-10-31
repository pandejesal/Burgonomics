import { describe, it, expect, vi, beforeEach } from "vitest";

// Finding 7 regressions: the per-customer spam guard must sample the MOST
// RECENT tickets (orderBy createdAt desc BEFORE limit) — without the orderBy,
// Firestore returns an arbitrary 25 docs (document-id order) and a customer
// with a long history sails past the 3-per-10m ceiling entirely.
const { mockDb, savedDocs, queryChains } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  const queryChains: Record<string, string[]> = {};
  const docRef = (col: string, id: string) => {
    const path = `${col}/${id}`;
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
  const query = (col: string) => {
    // Accumulate: each collection() call registers another chain on the SAME
    // column array (the ticket write re-collects after the guard query).
    const calls: string[] = (queryChains[col] ||= []);
    const filters: Array<[string, string, any]> = [];
    const q: any = {
      where: (f: string, op: string, v: any) => {
        calls.push("where");
        filters.push([f, op, v]);
        return q;
      },
      orderBy: (f: string, dir: string) => {
        calls.push(`orderBy:${f}:${dir}`);
        return q;
      },
      limit: (n: number) => {
        calls.push(`limit:${n}`);
        return q;
      },
      get: vi.fn(async () => {
        const docs = Object.keys(savedDocs)
          .filter(
            (p) =>
              p.startsWith(`${col}/`) &&
              filters.every(([f, op, v]) => (op === "==" ? savedDocs[p]?.[f] === v : false))
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
  const mockDb: any = {
    collection: (col: string) => ({
      doc: (id: string) => docRef(col, id),
      where: query(col).where,
    }),
    runTransaction: vi.fn(async (fn: any) =>
      fn({
        get: (ref: any) => ref.get(),
        set: (ref: any, data: any, opts?: any) => ref.set(data, opts),
      })
    ),
  };
  return { mockDb, savedDocs, queryChains };
});

vi.mock("firebase-admin", () => {
  const FieldValue = {
    serverTimestamp: () => "MOCK_TIMESTAMP",
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

import { createTicket } from "../src/modules/tickets/tickets.service";

const baseInput = {
  customerName: "Test Customer",
  branchId: "branch_sg_1",
  category: "food_quality" as const,
  subject: "Cold fries on arrival",
  description: "The fries were cold when the rider arrived.",
};

describe("Ticket spam guard — recent-first sampling (finding 7)", () => {
  beforeEach(() => {
    for (const key of Object.keys(savedDocs)) delete savedDocs[key];
    for (const key of Object.keys(queryChains)) delete queryChains[key];
  });

  it("samples with orderBy(createdAt desc) BEFORE limit(25)", async () => {
    await createTicket({ ...baseInput, customerId: "cust_q1" });
    const chain = queryChains["support_tickets"] || [];
    expect(chain).toContain("orderBy:createdAt:desc");
    expect(chain).toContain("limit:25");
    expect(chain.indexOf("orderBy:createdAt:desc")).toBeLessThan(chain.indexOf("limit:25"));
  });

  it("still rate-limits 3 tickets inside the 10-minute window", async () => {
    const now = Date.now();
    for (let i = 0; i < 3; i++) {
      savedDocs[`support_tickets/spam_${i}`] = {
        customerId: "cust_spam",
        status: "resolved",
        createdAt: now - i * 1000, // all inside the window
      };
    }
    await expect(
      createTicket({ ...baseInput, customerId: "cust_spam" })
    ).rejects.toThrow(/created 3 tickets in 10m/);
    // Nothing was created past the guard.
    expect(
      Object.keys(savedDocs).filter((p) => p.startsWith("support_tickets/tkt_"))
    ).toEqual([]);
  });

  it("counts OPEN tickets across the recent sample (10-open ceiling)", async () => {
    const old = Date.now() - 60 * 60 * 1000; // outside the 10m window
    for (let i = 0; i < 10; i++) {
      savedDocs[`support_tickets/open_${i}`] = {
        customerId: "cust_open",
        status: i % 2 === 0 ? "open" : "escalated",
        createdAt: old,
      };
    }
    await expect(
      createTicket({ ...baseInput, customerId: "cust_open" })
    ).rejects.toThrow(/holds 10 open tickets/);
  });

  it("lets a quiet customer through", async () => {
    savedDocs["support_tickets/old_1"] = {
      customerId: "cust_quiet",
      status: "resolved",
      createdAt: Date.now() - 60 * 60 * 1000,
    };
    const res = await createTicket({ ...baseInput, customerId: "cust_quiet" });
    expect(res.ticketId || res.id || res.success).toBeTruthy();
  });
});
