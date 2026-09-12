import { describe, it, expect, vi, beforeEach } from "vitest";

// Loop 63/120 rig: confirm-time Grill-Coins debit must run exactly once per
// captured payment (webhook retries + dual verify/webhook converge) and
// never drive balances negative. In-memory Firestore with transactions and
// a minimal where() for the intent lookup.
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
      where: (field: string, _op: string, value: any) => ({
        limit: (_n: number) => ({
          get: vi.fn(async () => {
            const docs = Object.entries(savedDocs)
              .filter(([p, d]) => p.startsWith(`${colName}/`) && (d as any)?.[field] === value)
              .map(([p, d]) => ({ id: p.split("/")[1], data: () => d }));
            return { docs };
          }),
        }),
      }),
    }),
    runTransaction: vi.fn(async (fn: any) =>
      fn({
        get: (ref: any) => ref.get(),
        set: (ref: any, data: any, opts?: any) => ref.set(data, opts),
      })
    ),
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

import { debitRedeemedCoins } from "../src/modules/customers/customerCoins";
import { resolveIntentRedemption } from "../src/modules/payments/razorpay.service";

describe("Loop 63: confirm-time coin debit", () => {
  beforeEach(() => {
    for (const key of Object.keys(savedDocs)) delete savedDocs[key];
  });

  it("debits the balance once and writes a redemption ledger row", async () => {
    savedDocs["customers/c1"] = { loyaltyPoints: 500 };
    const res = await debitRedeemedCoins({
      customerId: "c1",
      coins: 200,
      orderId: "ord_1",
      razorpayOrderId: "rzp_1",
    });
    expect(res.alreadyDone).toBe(false);
    expect(res.debited).toBe(200);
    expect(res.balanceAfter).toBe(300);
    expect(savedDocs["customers/c1"].loyaltyPoints).toBe(300);
    const ledger = savedDocs["coin_transactions/coin_redemption_rzp_1"];
    expect(ledger.type).toBe("redemption");
    expect(ledger.delta).toBe(-200);
    expect(ledger.orderId).toBe("ord_1");
  });

  it("is idempotent: a retry converges on the first debit, no double spend", async () => {
    savedDocs["customers/c1"] = { loyaltyPoints: 500 };
    const first = await debitRedeemedCoins({
      customerId: "c1",
      coins: 200,
      orderId: "ord_1",
      razorpayOrderId: "rzp_1",
    });
    expect(first.alreadyDone).toBe(false);
    const second = await debitRedeemedCoins({
      customerId: "c1",
      coins: 200,
      orderId: "ord_1",
      razorpayOrderId: "rzp_1",
    });
    expect(second.alreadyDone).toBe(true);
    expect(second.debited).toBe(200);
    expect(savedDocs["customers/c1"].loyaltyPoints).toBe(300);
  });

  it("clamps at the live balance, never negative", async () => {
    savedDocs["customers/c2"] = { loyaltyPoints: 100 };
    const res = await debitRedeemedCoins({
      customerId: "c2",
      coins: 300,
      orderId: "ord_2",
      razorpayOrderId: "rzp_2",
    });
    expect(res.debited).toBe(100);
    expect(res.balanceAfter).toBe(0);
    expect(savedDocs["customers/c2"].loyaltyPoints).toBe(0);
  });

  it("no-ops for guests and zero amounts", async () => {
    await expect(
      debitRedeemedCoins({ customerId: "guest", coins: 50, orderId: "o", razorpayOrderId: "r" })
    ).resolves.toMatchObject({ debited: 0, alreadyDone: true });
    await expect(
      debitRedeemedCoins({ customerId: "c1", coins: 0, orderId: "o", razorpayOrderId: "r" })
    ).resolves.toMatchObject({ debited: 0, alreadyDone: true });
  });

  it("resolves redemption from the server-written intent only", async () => {
    savedDocs["payment_intents/key_1"] = {
      razorpayOrderId: "rzp_9",
      customerId: "c9",
      pricing: { loyaltyDiscount: 150, grandTotal: 800 },
    };
    await expect(resolveIntentRedemption("rzp_9")).resolves.toEqual({
      customerId: "c9",
      coins: 150,
    });
    await expect(resolveIntentRedemption("rzp_missing")).resolves.toBeNull();
    savedDocs["payment_intents/key_2"] = {
      razorpayOrderId: "rzp_10",
      customerId: "c9",
      pricing: { loyaltyDiscount: 0, grandTotal: 800 },
    };
    await expect(resolveIntentRedemption("rzp_10")).resolves.toBeNull();
  });
});
