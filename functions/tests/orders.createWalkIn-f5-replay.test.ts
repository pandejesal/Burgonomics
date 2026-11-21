import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F5 (staging 2026-11-21, Test 7): a walk-in replay is rejected after a
 * PRICE_CHANGED retry.
 *
 * Reproduction: the till posts the bill it previewed (`expectedTotalPaise`),
 * the server prices the cart higher (HL Road charges ₹15 packaging), the till
 * is refused 409 PRICE_CHANGED and retries at the server's total under the SAME
 * request id. The retry is booked. A replay of the request afterwards answered
 * IDEMPOTENCY_CONFLICT instead of the original receipt, because the stored
 * request hash included the expected total, so the refused body and the
 * accepted body hashed differently.
 *
 * RED against `createWalkIn` before the fix (hash includes the total); GREEN
 * once the hash identifies the ORDER (cart, branch, tender, request id) and the
 * confirmed total is only a price check.
 */
const state = vi.hoisted(() => {
  const docs: Record<string, any> = {};
  let tail = Promise.resolve();
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
        for (const write of writes) docs[write.path] = write.data;
        return result;
      } finally { release(); }
    },
  };
  return { docs, db };
});
vi.mock("../src/core/firebase", () => ({ db: state.db }));
vi.mock("firebase-admin", () => ({ firestore: { FieldValue: { serverTimestamp: () => "timestamp" } } }));

import { createWalkIn, walkInIdentityHash, walkInLegacyHash } from "../src/modules/orders/createWalkIn";

const bill = (expectedTotalPaise: number) => ({
  requestId: "request-f5",
  branchId: "hl-road",
  orderType: "takeaway" as const,
  tender: "upi" as const,
  items: [{ productId: "p1", quantity: 1 }],
  expectedTotalPaise,
});

const orders = () => Object.entries(state.docs).filter(([path]) => path.startsWith("orders/"));

beforeEach(() => {
  for (const key of Object.keys(state.docs)) delete state.docs[key];
  state.docs["admins/staff"] = { role: "branch_staff", branchIds: ["hl-road"] };
  // HL Road charges ₹15 packaging, so ₹100 food bills at ₹115.
  state.docs["branches/hl-road"] = { name: "HL Road", city: "Ahmedabad", packagingFee: 15 };
  state.docs["products/p1"] = { name: "Burger", branchId: "hl-road", price: 100, inStock: true };
});

describe("walk-in replay after a PRICE_CHANGED retry (F5)", () => {
  it("books the corrected retry once and replays both bodies to the same receipt", async () => {
    // 1. The till previewed ₹100 but the server prices ₹115.
    await expect(createWalkIn("staff", bill(10000))).rejects.toMatchObject({
      statusCode: 409,
      code: "PRICE_CHANGED",
      totals: { packagingFee: 15, grandTotal: 115 },
    });
    expect(orders()).toHaveLength(0);

    // 2. The retry at the server's total, SAME request id: booked, exactly once.
    const created = await createWalkIn("staff", bill(11500));
    expect(created.replayed).toBe(false);
    expect(created.totals.grandTotal).toBe(115);
    expect(created.totals.packagingFee).toBe(15);
    expect(orders()).toHaveLength(1);

    // 3. Replaying the accepted body returns the original receipt.
    const acceptedReplay = await createWalkIn("staff", bill(11500));
    expect(acceptedReplay).toEqual({ ...created, replayed: true });

    // 4. Replaying the ORIGINAL refused body must not conflict either: the
    //    order exists, so the honest answer is the receipt it was booked at.
    const refusedReplay = await createWalkIn("staff", bill(10000));
    expect(refusedReplay.replayed).toBe(true);
    expect(refusedReplay.orderId).toBe(created.orderId);
    expect(refusedReplay.totals.grandTotal).toBe(115);

    // Exactly one order and one audit row, whatever order the replays arrive in.
    expect(orders()).toHaveLength(1);
    expect(Object.keys(state.docs).filter((path) => path.startsWith("admin_audit_logs/"))).toHaveLength(1);
  });

  it("still refuses a different order under a reused request id", async () => {
    const created = await createWalkIn("staff", bill(11500));
    await expect(
      createWalkIn("staff", { ...bill(11500), items: [{ productId: "p2", quantity: 1 }] })
    ).rejects.toMatchObject({ statusCode: 409, code: "IDEMPOTENCY_CONFLICT" });
    expect(orders()).toHaveLength(1);
    // The stored hash identifies the order, not the confirmed total.
    expect(state.docs[`orders/${created.orderId}`].walkInRequestHash).toBe(walkInIdentityHash(bill(11500)));
  });

  it("still refuses a changed basket detail, not just a changed price", async () => {
    await createWalkIn("staff", bill(11500));
    await expect(
      createWalkIn("staff", { ...bill(11500), notes: "different note" })
    ).rejects.toMatchObject({ statusCode: 409, code: "IDEMPOTENCY_CONFLICT" });
    expect(orders()).toHaveLength(1);
  });

  it("keeps a pre-fix counter order replayable through its legacy hash", async () => {
    // A counter order written before this fix stores the price-included hash.
    const acceptedBody = bill(11500);
    expect(walkInLegacyHash(acceptedBody)).not.toBe(walkInIdentityHash(acceptedBody));
    const pre_fix = await createWalkIn("staff", acceptedBody);
    state.docs[`orders/${pre_fix.orderId}`].walkInRequestHash = walkInLegacyHash(acceptedBody);
    const replay = await createWalkIn("staff", acceptedBody);
    expect(replay.replayed).toBe(true);
    expect(replay.orderId).toBe(pre_fix.orderId);
    expect(orders()).toHaveLength(1);
  });
});
