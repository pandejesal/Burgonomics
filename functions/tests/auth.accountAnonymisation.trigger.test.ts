import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * SEC-11 (A3 finding 3, owner decision 2026-11-25 #2) — the DELETE TRIGGER's
 * contract, with nothing else imported.
 *
 * `tests/auth.accountAnonymisation.test.ts` covers the scrubber in full (which
 * fields, which collections, idempotence, audit). This file pins the one thing a
 * reviewer must see working end to end: after an account deletion, a past order
 * that is KEPT for tax no longer identifies the customer.
 *
 * It is deliberately written against `onUserDeletedCleanup` alone, so on base
 * `d7ecb84` it fails on the ASSERTION (the order still carries `customerPhone`)
 * rather than on a missing import.
 */
const { store, mockDb } = vi.hoisted(() => {
  const store = new Map<string, any>();

  function merge(target: any, patch: Record<string, any>, merge: boolean): any {
    const next = merge && target ? { ...target } : {};
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
        where: (field: string, op: string, value: any) =>
          build([...filters, [field, op, value]]),
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
              return {
                id: ref.id,
                path: p,
                data: () => store.get(p),
                ref,
              };
            });
          return { docs };
        },
      };
      return api;
    };
    return build([]);
  }

  const mockDb: any = {
    collection: (name: string) => collectionRef(name),
    batch: () => {
      const ops: Array<() => void> = [];
      return {
        delete: (ref: any) => ops.push(() => store.delete(ref.path)),
        set: (ref: any, data: any, options?: any) =>
          ops.push(() => {
            store.set(ref.path, merge(store.get(ref.path), data, !!options?.merge));
          }),
        commit: async () => {
          for (const op of ops) op();
        },
      };
    },
    recursiveDelete: async (ref: any) => {
      for (const p of [...store.keys()]) {
        if (p === ref.path || p.startsWith(`${ref.path}/`)) store.delete(p);
      }
    },
  };

  return { store, mockDb };
});

vi.mock("../src/core/firebase", () => ({
  db: mockDb,
  auth: { revokeRefreshTokens: vi.fn(async () => {}) },
}));

vi.mock("firebase-admin", () => {
  const FieldValue = {
    serverTimestamp: () => "MOCK_SERVER_TIMESTAMP",
    delete: () => "__DELETE__",
    increment: (n: number) => n,
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

import { onUserDeletedCleanup } from "../src/modules/auth/triggers";

const UID = "u_redgreen";

function seed(): void {
  store.clear();
  store.set(`users/${UID}`, { phone: "+919800000404", name: "Ada", role: "customer" });
  store.set(`customers/${UID}`, { phone: "+919800000404", name: "Ada" });
  store.set("orders/ord_keep", {
    id: "ord_keep",
    customerId: UID,
    branchId: "branch_a",
    customerName: "Ada Lovelace",
    customerPhone: "+919800000404",
    address: { line1: "1 Test Road", lat: 21.1, lng: 72.7 },
    items: [{ id: "p1", name: "Smash Burger", price: 149, quantity: 1 }],
    totals: { grandTotal: 149 },
    cashDuePaise: 14900,
    paymentStatus: "paid",
    createdAt: 1_760_000_000_000,
  });
}

describe("account deletion anonymises the retained order", () => {
  beforeEach(seed);

  it("removes the name, phone and address but keeps amounts, dates and items", async () => {
    await onUserDeletedCleanup(UID);
    const order = store.get("orders/ord_keep");

    // The person is gone from the record we keep for tax.
    expect(order.customerName).toBeUndefined();
    expect(order.customerPhone).toBeUndefined();
    expect(order.address).toEqual({ anonymised: true });

    // The accounting record survives.
    expect(order.totals).toEqual({ grandTotal: 149 });
    expect(order.cashDuePaise).toBe(14900);
    expect(order.paymentStatus).toBe("paid");
    expect(order.createdAt).toBe(1_760_000_000_000);
    expect(order.items).toEqual([{ id: "p1", name: "Smash Burger", price: 149, quantity: 1 }]);
  });

  it("marks the order as scrubbed so a re-run is a no-op", async () => {
    await onUserDeletedCleanup(UID);
    const first = store.get("orders/ord_keep");
    expect(first.piiAnonymisedAt).toBeTruthy();
    await onUserDeletedCleanup(UID);
    expect(store.get("orders/ord_keep")).toEqual(first);
  });
});
