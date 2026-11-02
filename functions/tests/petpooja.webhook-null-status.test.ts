import { describe, it, expect, vi, beforeEach } from "vitest";

// Regression: a Petpooja order-status callback that resolves to a real order but
// carries NO status field wrote `petpoojaKitchenStatus: undefined`.
//
// The Admin SDK rejects `undefined` anywhere in a write payload, so the whole
// merged write threw, the webhook answered 500, and every vendor redelivery
// failed the same way: the order never recorded `petpoojaWebhookEventId` and the
// endpoint logged a permanent 500 loop for one malformed callback.
//
// HARNESS NOTE: the usual in-memory double accepts `undefined`, which is exactly
// why this class of failure is invisible to unit tests. The double below is
// STRICT - set/update/create reject any payload containing `undefined` at any
// depth, matching the real SDK - and every case ALSO asserts directly on the
// recorded payload, so a future shim that loosens the strictness still cannot
// hide the bug.

const { mockDb, savedDocs, writes, strict } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  const writes: Array<{ path: string; data: any }> = [];
  const strict = { enabled: true };
  let autoId = 0;

  const findUndefined = (value: any, path: string): string | null => {
    if (value === undefined) return path || "(root)";
    if (value === null || typeof value !== "object") return null;
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        const hit = findUndefined(value[i], path + "[" + i + "]");
        if (hit) return hit;
      }
      return null;
    }
    if (typeof value.toMillis === "function" || typeof value.isEqual === "function") {
      return null; // FieldValue / Timestamp sentinels are not plain data
    }
    for (const [key, entry] of Object.entries(value)) {
      const hit = findUndefined(entry, path ? path + "." + key : key);
      if (hit) return hit;
    }
    return null;
  };

  const assertNoUndefined = (data: any, path: string) => {
    if (!strict.enabled) return;
    const bad = findUndefined(data, "");
    if (bad) {
      // Same wording class as the real SDK so a future reader recognises it.
      throw new Error(
        'Cannot use "undefined" as a Firestore value (found in field "' + bad + '") while writing ' + path
      );
    }
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
        writes.push({ path, data: { ...data } });
        assertNoUndefined(data, path);
        savedDocs[path] =
          opts?.merge && savedDocs[path] ? { ...savedDocs[path], ...data } : data;
      }),
      update: vi.fn(async (data: any) => {
        writes.push({ path, data: { ...data } });
        assertNoUndefined(data, path);
        savedDocs[path] = { ...(savedDocs[path] || {}), ...data };
      }),
      create: vi.fn(async (data: any) => {
        writes.push({ path, data: { ...data } });
        assertNoUndefined(data, path);
        savedDocs[path] = data;
      }),
    };
  };

  const query = (col: string) => {
    const filters: Array<[string, string, any]> = [];
    const q: any = {
      where: (f: string, op: string, v: any) => {
        filters.push([f, op, v]);
        return q;
      },
      limit: () => q,
      get: vi.fn(async () => {
        const docs = Object.keys(savedDocs)
          .filter(
            (p) =>
              p.startsWith(col + "/") &&
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
      doc: (id?: string) => docRef(col, id || "auto_" + ++autoId),
      where: query(col).where,
    }),
    runTransaction: vi.fn(async (fn: any) =>
      fn({
        get: (ref: any) => ref.get(),
        set: (ref: any, data: any, opts?: any) => ref.set(data, opts),
        update: (ref: any, data: any) => ref.update(data),
      })
    ),
    batch: () => ({
      set: (ref: any, data: any, opts?: any) => ref.set(data, opts),
      update: (ref: any, data: any) => ref.update(data),
      commit: async () => undefined,
    }),
  };
  return { mockDb, savedDocs, writes, strict };
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

import { handlePetpoojaWebhook } from "../src/modules/petpooja/item86ingSync";

const trusted = { authenticated: true };

const seedOrder = (id: string, extra: Record<string, any> = {}) => {
  savedDocs["orders/" + id] = {
    id,
    branchId: "branch_t1",
    customerId: "cust_t1",
    items: [{ productId: "prod_1", name: "Classic Smash", quantity: 1, price: 219 }],
    pricing: { grandTotal: 260, split: { branchTransferPaise: 23000 } },
    status: { code: "CONFIRMED", label: "Order confirmed", kind: "upcoming", terminal: false },
    payment: { status: "completed", razorpayPaymentId: "pay_t1" },
    createdAt: "2026-11-02T09:00:00.000Z",
    ...extra,
  };
};

const orderWrites = () => writes.filter((w) => w.path.startsWith("orders/"));
const lastOrderWrite = (id: string) => {
  const all = orderWrites().filter((w) => w.path === "orders/" + id);
  return all[all.length - 1];
};

describe("Petpooja status webhook - a callback with no status field", () => {
  beforeEach(() => {
    for (const key of Object.keys(savedDocs)) delete savedDocs[key];
    writes.length = 0;
    strict.enabled = true;
  });

  it("does not write undefined when the payload omits both status fields", async () => {
    seedOrder("ord_null_status");
    await handlePetpoojaWebhook({ order_id: "ord_null_status" }, trusted);

    const write = lastOrderWrite("ord_null_status");
    expect(write).toBeDefined();
    // Direct assertion on the payload itself - independent of shim strictness.
    expect(Object.prototype.hasOwnProperty.call(write.data, "petpoojaKitchenStatus")).toBe(true);
    expect(write.data.petpoojaKitchenStatus).not.toBeUndefined();
    expect(write.data.petpoojaKitchenStatus).toBeNull();
  });

  it("does not write undefined when both status fields are empty strings", async () => {
    seedOrder("ord_empty_status");
    await handlePetpoojaWebhook(
      { order_id: "ord_empty_status", order_status: "" },
      trusted
    );

    const write = lastOrderWrite("ord_empty_status");
    expect(write).toBeDefined();
    expect(write.data.petpoojaKitchenStatus).not.toBeUndefined();
  });

  it("records the event id so a redelivery converges instead of 500-looping", async () => {
    seedOrder("ord_null_status_evt");
    await handlePetpoojaWebhook(
      { order_id: "ord_null_status_evt", id: "evt_missing_status" },
      trusted
    );

    expect(savedDocs["orders/ord_null_status_evt"].petpoojaWebhookEventId).toBe(
      "evt_missing_status"
    );
  });

  it("preserves the raw status verbatim when one IS supplied (number)", async () => {
    seedOrder("ord_num_status");
    await handlePetpoojaWebhook({ order_id: "ord_num_status", status: 5 }, trusted);
    expect(savedDocs["orders/ord_num_status"].petpoojaKitchenStatus).toBe(5);
  });

  it("preserves the raw status verbatim when one IS supplied (string)", async () => {
    seedOrder("ord_str_status");
    await handlePetpoojaWebhook({ order_id: "ord_str_status", status: "ready" }, trusted);
    expect(savedDocs["orders/ord_str_status"].petpoojaKitchenStatus).toBe("ready");
  });

  it("keeps a 0 status (falsy but real) instead of collapsing it to null", async () => {
    seedOrder("ord_zero_status");
    await handlePetpoojaWebhook({ order_id: "ord_zero_status", status: 0 }, trusted);
    const write = lastOrderWrite("ord_zero_status");
    expect(write).toBeDefined();
    expect(write.data.petpoojaKitchenStatus).toBe(0);
  });

  it("never writes a nested undefined anywhere in the merged order payload", async () => {
    seedOrder("ord_deep_scan");
    await handlePetpoojaWebhook(
      { order_id: "ord_deep_scan", orderID: "ord_deep_scan", cancel_reason: undefined },
      trusted
    );
    const write = lastOrderWrite("ord_deep_scan");
    expect(write).toBeDefined();
    const serialised = JSON.stringify(write.data, (_k, v) =>
      v === undefined ? "__UNDEF__" : v
    );
    expect(serialised).not.toContain("__UNDEF__");
  });
});
