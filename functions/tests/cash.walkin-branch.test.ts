import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * CASH-FLOWS: counter (walk-in) cash must be recorded against the staff
 * member's REAL outlet.
 *
 * The Partner modal used to stamp `branchName` from a two-value ternary on the
 * branch id (`branchId.includes('surat') ? 'Surat Adajan' : 'Ahmedabad SG
 * Highway'`), so 15 of 17 outlets recorded walk-in revenue under the wrong
 * store. The server now reads the authorised branch document and writes its
 * name/city, and the receipt carries the same identity back to the till.
 */
const state = vi.hoisted(() => {
  const docs: Record<string, any> = {};
  const db = {
    collection: (collection: string) => ({ doc: (id = "audit") => ({ path: `${collection}/${id}`, id }) }),
    runTransaction: async (callback: (tx: any) => Promise<any>) => {
      const writes: Array<{ path: string; data: any }> = [];
      let wrote = false;
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
    },
  };
  return { docs, db };
});
vi.mock("../src/core/firebase", () => ({ db: state.db }));
vi.mock("firebase-admin", () => ({ firestore: { FieldValue: { serverTimestamp: () => "timestamp" } } }));

import { createWalkIn } from "../src/modules/orders/createWalkIn";

const BRANCHES = [
  { id: "branch_surat_adajan", name: "Surat Adajan", city: "Surat", packagingFee: 15 },
  { id: "branch_rajkot_yagnik", name: "Rajkot Yagnik Road", city: "Rajkot", packagingFee: 15 },
  { id: "branch_ayodhya", name: "Ayodhya", city: "Ayodhya", packagingFee: 15 },
  { id: "branch_indore_vijaynagar", name: "Indore Vijay Nagar", city: "Indore", packagingFee: 15 },
];

const input = (branchId: string, requestId: string) => ({
  requestId,
  branchId,
  orderType: "takeaway" as const,
  tender: "cash" as const,
  items: [{ productId: "p1", quantity: 1 }],
  expectedTotalPaise: 11500,
});

beforeEach(() => {
  for (const key of Object.keys(state.docs)) delete state.docs[key];
  state.docs["admins/staff"] = {
    role: "branch_staff",
    branchIds: BRANCHES.map((branch) => branch.id),
  };
  state.docs["users/staff"] = { active: true };
  for (const branch of BRANCHES) state.docs[`branches/${branch.id}`] = branch;
  state.docs["products/p1"] = {
    name: "Burger",
    branchId: BRANCHES[0].id,
    price: 100,
    inStock: true,
  };
});

describe("walk-in counter cash is recorded against the real outlet", () => {
  it("stamps each branch's own name and city, not a two-value guess", async () => {
    for (const [index, branch] of BRANCHES.entries()) {
      // The product must belong to the branch being ordered at.
      state.docs["products/p1"] = { ...state.docs["products/p1"], branchId: branch.id };
      const receipt = await createWalkIn(
        "staff",
        input(branch.id, `req-${index}`)
      );
      const order = state.docs[`orders/${receipt.orderId}`];
      expect(order.branchId).toBe(branch.id);
      expect(order.branchName).toBe(branch.name);
      expect(order.city).toBe(branch.city);
      expect(receipt.branchId).toBe(branch.id);
      expect(receipt.branchName).toBe(branch.name);
    }
    // Four outlets, four correct names — the old ternary produced two.
    const names = Object.entries(state.docs)
      .filter(([path]) => path.startsWith("orders/"))
      .map(([, order]) => order.branchName);
    expect(new Set(names).size).toBe(BRANCHES.length);
  });

  it("records the tender as cash and mirrors the server totals", async () => {
    state.docs["products/p1"] = { ...state.docs["products/p1"], branchId: BRANCHES[1].id };
    const receipt = await createWalkIn("staff", input(BRANCHES[1].id, "req-cash"));
    const order = state.docs[`orders/${receipt.orderId}`];
    expect(order.paymentMethod).toBe("cod");
    expect(order.payment).toMatchObject({ method: "cod", status: "pending" });
    expect(order.paymentStatus).toBe("pending");
    // Flat mirrors for the Partner list/report readers.
    expect(order.subtotal).toBe(100);
    expect(order.tax).toBe(4.76);
    expect(order.deliveryFee).toBe(0);
    expect(order.total).toBe(115);
    expect(order.totals.grandTotal).toBe(115);
    // Counter cash never carries a gateway marker.
    expect(order.paymentChannel).toBeUndefined();
  });

  it("keeps the branch-membership check for a staff member of another outlet", async () => {
    state.docs["admins/staff"] = { role: "branch_staff", branchIds: [BRANCHES[0].id] };
    await expect(
      createWalkIn("staff", input(BRANCHES[2].id, "req-foreign"))
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(
      Object.keys(state.docs).filter((path) => path.startsWith("orders/"))
    ).toHaveLength(0);
  });
});
