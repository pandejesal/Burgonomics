import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A2 #3 (preprod audit cycle 11): the unpaid-order expiry sweep read a FIXED
 * window of 100 PLACED documents and only checked age inside the loop, so a
 * batch of young PLACED documents (every checkout draft, plus every cash order
 * being cooked) hid every stale unpaid order behind it for ever.
 *
 * Required behaviour: the scan PAGEs (keyset, deterministic, resumable) and
 * stops only on a short/empty page, the cancel cap, or a hard page bound — and
 * a capped tick says so instead of reporting a healthy no-op.
 */
const h = vi.hoisted(() => {
  const docs = new Map<string, any>();
  const snapshots: any[] = [];
  const copy = (value: any) => (value === undefined ? undefined : structuredClone(value));
  const apply = (path: string, data: any, merge?: boolean) => {
    docs.set(path, merge ? { ...(docs.get(path) ?? {}), ...copy(data) } : copy(data));
  };

  const ref = (collection: string, id: string) => {
    const path = `${collection}/${id}`;
    const self: any = {
      id,
      path,
      get: async () => ({ exists: docs.has(path), id, ref: self, data: () => copy(docs.get(path)) }),
      set: async (data: any, options?: { merge?: boolean }) => apply(path, data, options?.merge),
      update: async (data: any) => apply(path, data, true),
    };
    return self;
  };

  /** A keyset query: where(equality) -> orderBy(documentId) -> startAfter -> limit. */
  const query = (collection: string, field: string | null, value: any) => {
    const state = { after: null as string | null, max: Infinity, ordered: false };
    const rows = () => {
      let list = [...docs.entries()]
        .filter(([path]) => path.startsWith(`${collection}/`))
        .map(([path, data]) => ({ id: path.slice(collection.length + 1), data }));
      if (field) {
        list = list.filter(({ data }) => {
          const nested = field.split(".").reduce((acc: any, key) => acc?.[key], data);
          return nested === value;
        });
      }
      list.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      if (state.after) list = list.filter(({ id }) => id > (state.after as string));
      return list.slice(0, state.max === Infinity ? list.length : state.max);
    };
    const builder: any = {
      orderBy: () => {
        state.ordered = true;
        return builder;
      },
      startAfter: (cursor: any) => {
        state.after = typeof cursor === "string" ? cursor : String(cursor?.id ?? "");
        return builder;
      },
      limit: (n: number) => {
        state.max = n;
        return builder;
      },
      get: async () => {
        const found = rows();
        return { empty: found.length === 0, docs: found.map((row) => ({ id: row.id, data: () => copy(row.data) })) };
      },
    };
    return builder;
  };

  const db: any = {
    collection: (name: string) => ({
      doc: (id: string) => ref(name, id),
      where: (field: string, _op: string, value: any) => query(name, field, value),
      orderBy: () => query(name, null, null),
      limit: (n: number) => query(name, null, null).limit(n),
    }),
    runTransaction: async (callback: (tx: any) => Promise<any>) => {
      const pending: Array<() => void> = [];
      const result = await callback({
        get: async (reference: any) => reference.get(),
        set: (reference: any, data: any, options?: { merge?: boolean }) =>
          pending.push(() => apply(reference.path, data, options?.merge)),
        update: (reference: any, data: any) => pending.push(() => apply(reference.path, data, true)),
      });
      for (const write of pending) write();
      return result;
    },
  };

  return { docs, db, snapshots, reset: () => { docs.clear(); snapshots.length = 0; } };
});

vi.mock("../src/core/firebase", () => ({ db: h.db }));
vi.mock("firebase-admin", () => {
  const firestore: any = vi.fn(() => h.db);
  firestore.FieldPath = { documentId: () => "__name__" };
  firestore.FieldValue = {
    serverTimestamp: () => "SERVER_TS",
    increment: (n: number) => n,
    arrayUnion: (item: any) => [item],
    delete: () => "DELETE",
  };
  return {
    default: { firestore, auth: vi.fn(() => ({})), messaging: vi.fn(() => ({})), initializeApp: vi.fn(), apps: [{ name: "mock" }] },
    firestore, auth: vi.fn(() => ({})), messaging: vi.fn(() => ({})), initializeApp: vi.fn(), apps: [{ name: "mock" }],
  };
});
vi.mock("../src/modules/payments/razorpayClient", () => ({
  getRazorpayClient: () => ({
    orders: { fetchPayments: vi.fn(async () => ({ items: [] })) },
  }),
}));
vi.mock("../src/core/errors", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    captureErrorSnapshot: vi.fn(async (snapshot: any) => {
      h.snapshots.push(snapshot);
      return "snap";
    }),
  };
});

import { expireAbandonedUnpaidOrders, UNPAID_EXPIRY_SCAN_LIMIT } from "../src/modules/orders/expireUnpaidOrders";

const OLD = new Date(Date.now() - 40 * 60_000).toISOString();
const RECENT = new Date(Date.now() - 2 * 60_000).toISOString();

const draft = (id: string, createdAt: string) => ({
  id,
  orderId: id,
  shortCode: `BG-${id.slice(-6).toUpperCase()}`,
  customerId: "cust_qa",
  userId: "cust_qa",
  branchId: "branch_a",
  fulfillment: "takeaway",
  createdAt,
  placedAt: createdAt,
  status: { code: "PLACED", label: "Order placed", kind: "upcoming", terminal: false },
  paymentMethod: "online",
  paymentStatus: "pending",
  payment: { method: "online", label: "Pay Online", status: "pending" },
  pricing: { grandTotal: 100 },
});

beforeEach(() => {
  h.reset();
});

describe("unpaid expiry scan pages instead of reading a fixed 100-doc window (A2 #3)", () => {
  it("cancels stale drafts that sit behind a full page of young PLACED documents", async () => {
    // 120 young PLACED drafts occupy the first page and sort BEFORE the stale
    // ones, exactly like a busy evening of checkouts behind an abandoned one.
    for (let i = 1; i <= 120; i += 1) {
      const id = `ord_a_young_${String(i).padStart(3, "0")}`;
      h.docs.set(`orders/${id}`, draft(id, RECENT));
    }
    for (let i = 1; i <= 10; i += 1) {
      const id = `ord_z_stale_${String(i).padStart(3, "0")}`;
      h.docs.set(`orders/${id}`, draft(id, OLD));
      h.docs.set(`payment_intents/intent_${i}`, { orderId: id, razorpayOrderId: `rzp_${i}`, createdAtMs: Date.now() });
    }

    const stats = await expireAbandonedUnpaidOrders();

    expect(stats.cancelled).toBe(10);
    expect(stats.scanned).toBeGreaterThan(UNPAID_EXPIRY_SCAN_LIMIT);
    for (let i = 1; i <= 10; i += 1) {
      expect(h.docs.get(`orders/ord_z_stale_${String(i).padStart(3, "0")}`).status.code).toBe("CANCELLED");
    }
    // Every young draft is untouched.
    expect(h.docs.get("orders/ord_a_young_001").status.code).toBe("PLACED");
  });

  it("records a resumable cursor and wraps when the lane is drained", async () => {
    for (let i = 1; i <= 5; i += 1) {
      const id = `ord_small_${i}`;
      h.docs.set(`orders/${id}`, draft(id, RECENT));
    }
    await expireAbandonedUnpaidOrders();
    // A short page means the end of the lane: the cursor resets so the next
    // tick starts from the beginning again (bounded wrap-around).
    const cursor = h.docs.get("scheduler_locks/unpaid-expiry-cursor");
    expect(cursor).toBeTruthy();
    expect(cursor.cursorId).toBe("");
  });

  it("is bounded per tick and reports the cap instead of a healthy no-op", async () => {
    const total = UNPAID_EXPIRY_SCAN_LIMIT * 12 + 5;
    for (let i = 1; i <= total; i += 1) {
      const id = `ord_young_${String(i).padStart(5, "0")}`;
      h.docs.set(`orders/${id}`, draft(id, RECENT));
    }

    const stats = await expireAbandonedUnpaidOrders();

    expect(stats.cancelled).toBe(0);
    expect(stats.scanned).toBeLessThanOrEqual(UNPAID_EXPIRY_SCAN_LIMIT * 10);
    expect(stats.pageCapped).toBe(true);
    expect(h.snapshots.some((s) => /scan cap|page cap|not fully scanned/i.test(String(s.message)))).toBe(true);
  });
});
