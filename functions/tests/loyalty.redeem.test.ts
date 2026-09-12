import { describe, it, expect, vi, beforeEach } from "vitest";

// Loop 62/120 rig: same in-memory Firestore pattern as
// razorpay.service.test.ts — the pricing engine used to trust any
// client-supplied loyaltyPointsToRedeem (guests included) with no balance
// check and no debit. resolveRedeemableCoins must fail closed.
const { mockDb, savedDocs } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  const docRef = (colName: string, docId: string) => ({
    id: docId,
    path: `${colName}/${docId}`,
    get: vi.fn(async () => ({
      exists: !!savedDocs[`${colName}/${docId}`],
      data: () => savedDocs[`${colName}/${docId}`] || {},
    })),
    set: vi.fn(async (data: any, options?: any) => {
      const p = `${colName}/${docId}`;
      savedDocs[p] =
        options?.merge && savedDocs[p] ? { ...savedDocs[p], ...data } : data;
    }),
  });
  const mockDb: any = {
    collection: (colName: string) => ({
      doc: (docId: string) => docRef(colName, docId),
    }),
  };
  return { mockDb, savedDocs };
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

import { resolveRedeemableCoins } from "../src/modules/payments/razorpay.service";

describe("Loop 62: loyalty redemption is server-checked", () => {
  beforeEach(() => {
    for (const key of Object.keys(savedDocs)) delete savedDocs[key];
  });

  it("returns the requested amount when the balance covers it", async () => {
    savedDocs["customers/cust_rich"] = { loyaltyPoints: 500 };
    await expect(resolveRedeemableCoins("cust_rich", 200)).resolves.toBe(200);
  });

  it("fails closed with 400 when requesting more than the balance", async () => {
    savedDocs["customers/cust_poor"] = { loyaltyPoints: 50 };
    const err: any = await resolveRedeemableCoins("cust_poor", 600).then(
      () => null,
      (e) => e
    );
    expect(err?.statusCode).toBe(400);
    expect(String(err?.message)).toContain("50 Grill Coins");
  });

  it("fails closed for guests with any redemption request", async () => {
    const err: any = await resolveRedeemableCoins("guest", 100).then(
      () => null,
      (e) => e
    );
    expect(err?.statusCode).toBe(400);
  });

  it("fails closed for unknown customers (no doc, no balance)", async () => {
    const err: any = await resolveRedeemableCoins("cust_ghost", 10).then(
      () => null,
      (e) => e
    );
    expect(err?.statusCode).toBe(400);
  });

  it("passes zero/empty requests through without a balance lookup", async () => {
    await expect(resolveRedeemableCoins("cust_ghost", 0)).resolves.toBe(0);
    await expect(resolveRedeemableCoins("guest", undefined)).resolves.toBe(0);
  });
});
