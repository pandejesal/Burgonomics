import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, savedDocs, addedDocs } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  const addedDocs: Array<{ col: string; data: any }> = [];
  const mockDb = {
    collection: (colName: string) => ({
      doc: (docId: string) => ({
        id: docId,
        path: `${colName}/${docId}`,
        get: vi.fn(async () => ({
          exists: !!savedDocs[`${colName}/${docId}`],
          data: () => savedDocs[`${colName}/${docId}`] || {},
        })),
        set: vi.fn(async (data: any, options?: any) => {
          const docPath = `${colName}/${docId}`;
          savedDocs[docPath] =
            options?.merge && savedDocs[docPath]
              ? { ...savedDocs[docPath], ...data }
              : data;
        }),
      }),
      add: vi.fn(async (data: any) => {
        addedDocs.push({ col: colName, data });
        return { id: `auto_${addedDocs.length}` };
      }),
    }),
  };
  return { mockDb, savedDocs, addedDocs };
});

vi.mock("firebase-admin", () => {
  const FieldValue = {
    serverTimestamp: () => "MOCK_SERVER_TIMESTAMP",
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

import { adjustCustomerCoins } from "../src/modules/customers/customerCoins";

const STAFF_A = { uid: "staff_a", role: "branch_staff", branchIds: ["branch_surat_01"] };
const STAFF_B = { uid: "staff_b", role: "branch_staff", branchIds: ["branch_ahmedabad_01"] };
const ADMIN = { uid: "admin_1", role: "brand_owner", isBrandAdmin: true };

describe("Staff Grill-Coins adjustment (server-side, audited)", () => {
  beforeEach(() => {
    for (const key of Object.keys(savedDocs)) delete savedDocs[key];
    addedDocs.length = 0;
    savedDocs["customers/cust_1"] = {
      loyaltyPoints: 100,
      favoriteBranchId: "branch_surat_01",
    };
  });

  it("credits the balance and writes one actor-attributed ledger row", async () => {
    const res = await adjustCustomerCoins(
      { customerId: "cust_1", delta: 50, reason: "Order compensation" },
      STAFF_A
    );
    expect(res.success).toBe(true);
    expect(res.balanceAfter).toBe(150);
    expect(savedDocs["customers/cust_1"].loyaltyPoints).toBe(150);
    const ledger = addedDocs.filter((d) => d.col === "coin_transactions");
    expect(ledger).toHaveLength(1);
    expect(ledger[0].data).toMatchObject({
      customerId: "cust_1",
      delta: 50,
      balanceAfter: 150,
      type: "staff_adjustment",
      actorUid: "staff_a",
    });
  });

  it("clamps debits at zero instead of going negative", async () => {
    const res = await adjustCustomerCoins(
      { customerId: "cust_1", delta: -500, reason: "Manual balance correction" },
      STAFF_A
    );
    expect(res.balanceAfter).toBe(0);
    expect(res.applied).toBe(-100);
  });

  it("denies staff outside the customer's home branch", async () => {
    await expect(
      adjustCustomerCoins(
        { customerId: "cust_1", delta: 50, reason: "Order compensation" },
        STAFF_B
      )
    ).rejects.toThrow(/outside your assigned branches/);
    expect(savedDocs["customers/cust_1"].loyaltyPoints).toBe(100);
    expect(addedDocs).toHaveLength(0);
  });

  it("lets brand admins adjust any customer", async () => {
    const res = await adjustCustomerCoins(
      { customerId: "cust_1", delta: 10, reason: "Customer delight" },
      ADMIN
    );
    expect(res.balanceAfter).toBe(110);
  });

  it("rejects anonymous callers and invalid payloads", async () => {
    await expect(
      adjustCustomerCoins({ customerId: "cust_1", delta: 10, reason: "Order compensation" }, undefined)
    ).rejects.toThrow(/authentication required/);
    await expect(
      adjustCustomerCoins({ customerId: "cust_1", delta: 0, reason: "Order compensation" }, STAFF_A)
    ).rejects.toThrow();
    await expect(
      adjustCustomerCoins({ customerId: "cust_1", delta: 10, reason: "x" }, STAFF_A)
    ).rejects.toThrow();
  });
});
