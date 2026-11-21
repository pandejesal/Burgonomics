import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => {
  const docs: Record<string, any> = {};
  let tail = Promise.resolve();
  let failAudit = false;
  const db = {
    collection: (collection: string) => ({ doc: (id = "audit") => ({ path: `${collection}/${id}`, id }) }),
    runTransaction: async (callback: (tx: any) => Promise<any>) => {
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      const writes: Array<{ path: string; data: any }> = [];
      let wrote = false;
      try {
        const result = await callback({
          get: async (ref: { path: string }) => {
            if (wrote) throw new Error("Firestore reads must precede writes");
            return { exists: Object.hasOwn(docs, ref.path), data: () => docs[ref.path] };
          },
          create: (ref: { path: string }, data: any) => {
            wrote = true;
            if (Object.hasOwn(docs, ref.path)) throw new Error("already exists");
            writes.push({ path: ref.path, data });
          },
          set: (ref: { path: string }, data: any) => {
            wrote = true;
            writes.push({ path: ref.path, data });
          },
        });
        if (failAudit && writes.some((write) => write.path.startsWith("admin_audit_logs/"))) throw new Error("audit commit unavailable");
        for (const write of writes) docs[write.path] = write.data;
        return result;
      } finally { release(); }
    },
  };
  return { docs, db, setFailAudit: (value: boolean) => { failAudit = value; } };
});
vi.mock("../src/core/firebase", () => ({ db: state.db }));
vi.mock("firebase-admin", () => ({ firestore: { FieldValue: { serverTimestamp: () => "timestamp" } } }));

import { createWalkIn, createWalkInSchema } from "../src/modules/orders/createWalkIn";

const input = () => ({ requestId: "request-123", branchId: "b1", orderType: "dinein" as const, tender: "cash" as const, items: [{ productId: "p1", quantity: 1 }], expectedTotalPaise: 10000 });
const orders = () => Object.entries(state.docs).filter(([path]) => path.startsWith("orders/"));
const create = (body = input()) => createWalkIn("staff", body);

beforeEach(() => {
  for (const key of Object.keys(state.docs)) delete state.docs[key];
  state.setFailAudit(false);
  state.docs["admins/staff"] = { role: "branch_staff", branchIds: ["b1"] };
  state.docs["branches/b1"] = {};
  state.docs["products/p1"] = { name: "Burger", branchId: "b1", price: 100, inStock: true, petpoojaItemId: "pos1" };
});

describe("walk-in creation", () => {
  it.each(["support", "regional_manager", "customer", "unknown"])("denies %s", async (role) => {
    state.docs["admins/staff"].role = role;
    await expect(create()).rejects.toMatchObject({ statusCode: 403 });
    expect(orders()).toHaveLength(0);
  });
  it("requires an authenticated actor and assigned branch", async () => {
    await expect(createWalkIn("", input())).rejects.toMatchObject({ statusCode: 401 });
    state.docs["admins/staff"].branchIds = ["other"];
    await expect(create()).rejects.toMatchObject({ statusCode: 403 });
  });
  it.each(["brand_owner", "developer"])("allows %s on a real branch", async (role) => {
    state.docs["admins/staff"] = { role };
    expect((await create()).replayed).toBe(false);
  });
  it.each([
    ["unavailable", { inStock: false }, 503],
    ["foreign", { branchId: "other" }, 503],
    ["nonfinite price", { price: Number.NaN }, 503],
    ["configurable", { customizations: [{ id: "variation" }] }, 422],
  ])("refuses %s products", async (_label, update, statusCode) => {
    Object.assign(state.docs["products/p1"], update);
    await expect(create()).rejects.toMatchObject({ statusCode });
    expect(orders()).toHaveLength(0);
  });
  it("strictly rejects caller price, payment and unknown fields", () => {
    for (const field of ["price", "tax", "fee", "paymentChannel", "status", "providerId"]) {
      expect(createWalkInSchema.safeParse({ ...input(), [field]: 1 }).success).toBe(false);
      expect(createWalkInSchema.safeParse({ ...input(), items: [{ ...input().items[0], [field]: 1 }] }).success).toBe(false);
    }
  });
  it("returns price changed with authoritative totals without writing", async () => {
    await expect(create({ ...input(), expectedTotalPaise: 1 })).rejects.toMatchObject({ statusCode: 409, code: "PRICE_CHANGED", totals: { grandTotal: 100 } });
    expect(orders()).toHaveLength(0);
  });
  it("replays the original receipt without repricing and rejects changed payload", async () => {
    const first = await create();
    state.docs["products/p1"].price = 999;
    const replay = await create();
    expect(replay).toEqual({ ...first, replayed: true });
    // CHANGED FOR F5 (staging 2026-11-21): this assertion used to require a
    // 409 IDEMPOTENCY_CONFLICT for the same cart under a different
    // expectedTotalPaise. That is the bug F5 reports: after a PRICE_CHANGED
    // refusal the till retries at the server's total under the same request id
    // and must be recognised as the SAME order, not a new one. The total is a
    // confirmation, not an identity, so the honest answer here is the receipt
    // the order was actually booked at. A different CART is still refused
    // (next assertion, and tests/orders.createWalkIn-f5-replay.test.ts).
    const sameOrderNewTotal = await create({ ...input(), expectedTotalPaise: 99900 });
    expect(sameOrderNewTotal).toEqual({ ...first, replayed: true });
    await expect(create({ ...input(), items: [{ productId: "p1", quantity: 2 }] })).rejects.toMatchObject({ statusCode: 409, code: "IDEMPOTENCY_CONFLICT" });
    expect(orders()).toHaveLength(1);
    state.docs["admins/staff"].branchIds = [];
    await expect(create()).rejects.toMatchObject({ statusCode: 403 });
  });
  it("serializes concurrent duplicates into one order and audit", async () => {
    const results = await Promise.all([create(), create()]);
    expect(results.map((result) => result.replayed).sort()).toEqual([false, true]);
    expect(orders()).toHaveLength(1);
    expect(Object.keys(state.docs).filter((path) => path.startsWith("admin_audit_logs/"))).toHaveLength(1);
  });
  it("does not commit an order if audit creation fails", async () => {
    state.setFailAudit(true);
    await expect(create()).rejects.toBeDefined();
    expect(orders()).toHaveLength(0);
  });
  it.each(["cash", "upi"] as const)("keeps %s pending without capture markers", async (tender) => {
    const result = await createWalkIn("staff", { ...input(), tender });
    const order = state.docs[`orders/${result.orderId}`];
    expect(order.paymentStatus).toBe("pending");
    expect(order.payment.status).toBe("pending");
    expect(order.paymentMethod).toBe(tender === "cash" ? "cod" : "upi");
    expect(order.items[0]).toMatchObject({ productId: "p1", petpoojaItemId: "pos1", name: "Burger", price: 100 });
    expect(order).not.toHaveProperty("paymentChannel");
    expect(order).not.toHaveProperty("paidAt");
    expect(order.payment).not.toHaveProperty("capturedAmountPaise");
    expect(result.settlementAvailable).toBe(false);
  });
  it("refuses delivery explicitly", async () => {
    await expect(createWalkIn("staff", { ...input(), orderType: "delivery" })).rejects.toMatchObject({ statusCode: 422 });
  });
});
