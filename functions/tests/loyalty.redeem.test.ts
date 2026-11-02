import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Grill-Coins redemption is a NON-LAUNCH feature (D31-D33 / OPEN-EARN-1).
 *
 * The customer app ships no loyalty balance or redemption UI and pins
 * `loyaltyPointsToRedeem` to 0, so a non-zero redemption can only come from a
 * stale client, a replayed body or a direct caller. The server refuses it with
 * one typed 409 — before any gateway order is minted, before any reservation
 * exists and before pricing can apply a coin discount — instead of maintaining
 * a live reservation/debit path nobody can legitimately reach.
 *
 * The earn path and staff coin adjustments are untouched by this gate; they are
 * covered by customerCoins tests.
 */
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

import {
  resolveRedeemableCoins,
  verifyRedeemableCoinBalance,
} from "../src/modules/payments/razorpay.service";
import { config } from "../src/config/env";

describe("launch gate: Grill-Coins redemption is refused server-side", () => {
  const prevEnabled = config.loyalty.redemptionEnabled;

  beforeEach(() => {
    for (const key of Object.keys(savedDocs)) delete savedDocs[key];
    config.loyalty.redemptionEnabled = false;
  });
  afterEach(() => {
    config.loyalty.redemptionEnabled = prevEnabled;
  });

  it("refuses ANY non-zero redemption with the typed 409, before pricing", () => {
    savedDocs["customers/cust_rich"] = { loyaltyPoints: 500 };
    let thrown: any = null;
    try {
      resolveRedeemableCoins("cust_rich", 200);
    } catch (err) {
      thrown = err;
    }
    expect(thrown?.statusCode).toBe(409);
    expect(thrown?.code).toBe("COIN_REDEMPTION_DISABLED");
    // No balance read happened: the gate is ahead of every datastore access.
    expect(mockDb.collection("customers").doc("cust_rich").get).not.toHaveBeenCalled();
  });

  it("refuses guests and unknown customers with the SAME typed refusal", () => {
    for (const [customerId, requested] of [
      ["guest", 100],
      ["cust_ghost", 10],
    ] as const) {
      let thrown: any = null;
      try {
        resolveRedeemableCoins(customerId, requested);
      } catch (err) {
        thrown = err;
      }
      expect(thrown?.statusCode).toBe(409);
      expect(thrown?.code).toBe("COIN_REDEMPTION_DISABLED");
    }
  });

  it("the launch value (0 / absent) passes through unchanged — normal checkout", () => {
    expect(resolveRedeemableCoins("cust_ghost", 0)).toBe(0);
    expect(resolveRedeemableCoins("guest", undefined)).toBe(0);
    expect(resolveRedeemableCoins("cust_rich", null)).toBe(0);
    expect(resolveRedeemableCoins("cust_rich", Number.NaN)).toBe(0);
  });

  it("an explicitly enabled feature keeps the server-side balance check", async () => {
    config.loyalty.redemptionEnabled = true;
    savedDocs["customers/cust_rich"] = { loyaltyPoints: 500 };
    expect(resolveRedeemableCoins("cust_rich", 200)).toBe(200);
    await expect(verifyRedeemableCoinBalance("cust_rich", 200)).resolves.toBeUndefined();

    savedDocs["customers/cust_poor"] = { loyaltyPoints: 50 };
    const err: any = await verifyRedeemableCoinBalance("cust_poor", 600).then(
      () => null,
      (e) => e
    );
    expect(err?.statusCode).toBe(400);
    expect(err?.code).toBe("COINS_INSUFFICIENT");
    expect(String(err?.message)).toContain("50 Grill Coins");
  });

  it("an enabled feature still refuses a guest (no balance to spend)", async () => {
    config.loyalty.redemptionEnabled = true;
    const err: any = await verifyRedeemableCoinBalance("guest", 100).then(
      () => null,
      (e) => e
    );
    expect(err?.statusCode).toBe(400);
  });
});
