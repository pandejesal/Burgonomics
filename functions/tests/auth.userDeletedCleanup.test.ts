import { describe, it, expect, vi, beforeEach } from "vitest";

// SEC-02: account deletion must erase the customer profile, its address data
// and the user's device tokens, while order documents are retained for
// accounting. Every delete is guarded so one failure cannot skip the rest.
const { mockDb, store, control, calls } = vi.hoisted(() => {
  const store = new Map<string, any>();
  const calls: string[] = [];
  const control = { failRecursivePath: "" };

  const subcollectionNames = (parentPath: string): string[] => {
    const names = new Set<string>();
    for (const p of store.keys()) {
      if (!p.startsWith(`${parentPath}/`)) continue;
      const rest = p.slice(parentPath.length + 1);
      const [name, ...tail] = rest.split("/");
      if (tail.length > 0) names.add(name);
    }
    return [...names];
  };

  function collectionRef(path: string) {
    return {
      path,
      get: async () => {
        const docs = [...store.keys()]
          .filter((p) => {
            if (!p.startsWith(`${path}/`)) return false;
            return !p.slice(path.length + 1).includes("/");
          })
          .map((p) => makeDoc(p));
        return { docs };
      },
    };
  }

  function applySet(path: string, data: any, options?: any) {
    const next = options?.merge && store.get(path) ? { ...store.get(path) } : {};
    for (const [k, v] of Object.entries(data)) {
      if (v === "MOCK_DELETE") delete next[k];
      else next[k] = v;
    }
    store.set(path, next);
  }

  function makeDoc(path: string) {
    return {
      path,
      get: async () => ({ exists: store.has(path), data: () => store.get(path) }),
      set: async (data: any, options?: any) => {
        applySet(path, data, options);
      },
      delete: async () => {
        store.delete(path);
      },
      listCollections: async () => subcollectionNames(path).map((n) => collectionRef(`${path}/${n}`)),
    };
  }

  const mockDb: any = {
    collection: (name: string) => ({
      doc: (id: string) => makeDoc(`${name}/${id}`),
      where: (field: string, _op: string, value: any) => ({
        get: async () => {
          const docs = [...store.keys()]
            .filter(
              (p) =>
                p.startsWith(`${name}/`) &&
                !p.slice(name.length + 1).includes("/") &&
                store.get(p)?.[field] === value
            )
            .map((p) => {
              const ref = makeDoc(p);
              return { ...ref, id: p.slice(name.length + 1), ref };
            });
          return { docs };
        },
      }),
    }),
    batch: () => {
      const ops: Array<() => void> = [];
      return {
        delete: (ref: any) => ops.push(() => store.delete(ref.path)),
        set: (ref: any, data: any, options?: any) => {
          ops.push(() => applySet(ref.path, data, options));
        },
        commit: async () => {
          for (const op of ops) op();
        },
      };
    },
    recursiveDelete: async (ref: any) => {
      if (control.failRecursivePath === ref.path) throw new Error(`cannot delete ${ref.path}`);
      calls.push(ref.path);
      for (const p of [...store.keys()]) {
        if (p === ref.path || p.startsWith(`${ref.path}/`)) store.delete(p);
      }
    },
  };

  return { mockDb, store, control, calls };
});

vi.mock("../src/core/firebase", () => ({
  db: mockDb,
  auth: { revokeRefreshTokens: vi.fn(async () => {}) },
}));

vi.mock("firebase-admin", () => {
  const FieldValue = {
    serverTimestamp: () => "MOCK_SERVER_TIMESTAMP",
    delete: () => "MOCK_DELETE",
  };
  const firestoreFn: any = vi.fn(() => mockDb);
  firestoreFn.FieldValue = FieldValue;
  return {
    default: {
      firestore: firestoreFn,
      auth: vi.fn(() => ({ revokeRefreshTokens: vi.fn(async () => {}) })),
      messaging: vi.fn(() => ({})),
      initializeApp: vi.fn(),
      apps: [{ name: "mock" }],
    },
    firestore: firestoreFn,
    auth: vi.fn(() => ({ revokeRefreshTokens: vi.fn(async () => {}) })),
    initializeApp: vi.fn(),
    apps: [{ name: "mock" }],
  };
});

import { onUserDeletedCleanup } from "../src/modules/auth/triggers";

const seed = () => {
  store.clear();
  calls.length = 0;
  control.failRecursivePath = "";
  store.set("users/u1", {
    phone: "+919800000001",
    email: "a@example.com",
    name: "Ada",
    addresses: [{ line1: "1 Test Road" }],
    fcmTokens: ["tok_1"],
    role: "customer",
  });
  store.set("users/u1/addresses/a1", { line1: "1 Test Road" });
  store.set("users/u1/notifications/n1", { title: "hello" });
  store.set("customers/u1", {
    phone: "+919800000001",
    email: "a@example.com",
    name: "Ada",
    addresses: [{ line1: "1 Test Road" }],
    loyaltyPoints: 10,
  });
  store.set("customers/u1/addresses/a1", { line1: "1 Test Road" });
  store.set("customers/u1/deviceTokens/tok_1", { token: "tok_1" });
  store.set("device_tokens/tok_1", { userId: "u1", token: "tok_1" });
  store.set("device_tokens/tok_2", { userId: "other", token: "tok_2" });
  store.set("orders/ord_1", { customerId: "u1", pricing: { grandTotal: 500 } });
};

describe("onUserDeletedCleanup PII erasure (SEC-02)", () => {
  beforeEach(seed);

  it("erases the customers profile and its subcollections but retains orders", async () => {
    await expect(onUserDeletedCleanup("u1")).resolves.toBe(true);
    expect(store.has("customers/u1")).toBe(false);
    expect(store.has("customers/u1/addresses/a1")).toBe(false);
    expect(store.has("customers/u1/deviceTokens/tok_1")).toBe(false);
    // Tax/accounting records are deliberately kept.
    expect(store.get("orders/ord_1")).toMatchObject({ customerId: "u1" });
  });

  it("strips the retained user profile and its address/notification data", async () => {
    await onUserDeletedCleanup("u1");
    const user = store.get("users/u1");
    expect(user.isDeleted).toBe(true);
    expect(user.phone).toBeUndefined();
    expect(user.email).toBeUndefined();
    expect(user.addresses).toEqual([]);
    expect(user.fcmTokens).toBeUndefined();
    expect(store.has("users/u1/addresses/a1")).toBe(false);
    expect(store.has("users/u1/notifications/n1")).toBe(false);
  });

  it("detaches only the deleted user's device tokens", async () => {
    await onUserDeletedCleanup("u1");
    expect(store.has("device_tokens/tok_1")).toBe(false);
    expect(store.has("device_tokens/tok_2")).toBe(true);
  });

  it("is idempotent", async () => {
    await expect(onUserDeletedCleanup("u1")).resolves.toBe(true);
    await expect(onUserDeletedCleanup("u1")).resolves.toBe(true);
  });

  it("logs a partial failure and still runs the remaining deletes", async () => {
    control.failRecursivePath = "customers/u1";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(onUserDeletedCleanup("u1")).resolves.toBe(false);
    // The failed customer tree is the only thing left behind...
    expect(store.has("customers/u1")).toBe(true);
    // ...while the other erasures still happened.
    expect(store.has("device_tokens/tok_1")).toBe(false);
    expect(store.has("users/u1/addresses/a1")).toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
