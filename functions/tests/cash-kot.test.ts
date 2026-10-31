import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// CASH-KOT: a cash / pay-at-store order never reaches the Razorpay capture
// webhook that pushes online KOTs, and the customer app's own
// POST /petpooja/pushOrder is rejected for customers (staff-only route).
// The order-created trigger is therefore the ONLY server path for those
// tickets. Gate + delegation are unit-tested here; the wiring into the
// creation trigger is pinned by a narrow source assertion (no trigger
// harness exists in this repo), and duplicate-safety lives in the existing
// push claim/dedupe suite (petpooja.kot-race).
vi.mock("firebase-admin", () => {
  const FieldValue = {
    serverTimestamp: () => "MOCK_TIMESTAMP",
    increment: (n: number) => n,
    arrayUnion: (item: any) => [item],
    delete: () => "MOCK_DELETE",
  };
  const firestoreFn: any = vi.fn(() => ({
    collection: () => ({
      doc: () => ({ get: async () => ({ exists: false, data: () => ({}) }) }),
    }),
  }));
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
  isCashOrPayAtStoreOrder,
  pushKotForCashOrderOnCreate,
} from "../src/modules/petpooja/orderPush";

const cashOrder = { id: "ord_cash_1", payment: { method: "cod" }, branchId: "branch_a" };
const onlineOrder = { id: "ord_online_1", payment: { method: "upi" }, branchId: "branch_a" };

describe("CASH-KOT order-created push", () => {
  it("treats cod (cash-on-delivery / pay-at-store) and legacy cash as cash orders", () => {
    expect(isCashOrPayAtStoreOrder(cashOrder)).toBe(true);
    expect(isCashOrPayAtStoreOrder({ payment: { method: "CASH" } })).toBe(true);
    expect(isCashOrPayAtStoreOrder({ paymentMethod: "cod" })).toBe(true);
  });

  it("never treats an online order as a cash order", () => {
    for (const method of ["upi", "card", "netbanking", "wallet", "online"]) {
      expect(isCashOrPayAtStoreOrder({ payment: { method } })).toBe(false);
    }
    expect(isCashOrPayAtStoreOrder({})).toBe(false);
  });

  it("delegates a cash order to the idempotent POS push", async () => {
    // The mocked order doc does not exist, so the real pushOrderToPetpooja
    // runs and refuses — proving the cash path actually reaches it.
    await expect(pushKotForCashOrderOnCreate("ord_cash_1", cashOrder)).rejects.toThrow(
      /does not exist/
    );
  });

  it("does not touch the POS path for an online order", async () => {
    await expect(pushKotForCashOrderOnCreate("ord_online_1", onlineOrder)).resolves.toBeNull();
  });

  it("is wired into the order-created trigger", () => {
    const source = readFileSync(
      resolve(__dirname, "../src/modules/notifications/triggers.ts"),
      "utf8"
    );
    const start = source.indexOf("onDocumentCreated(");
    const end = source.indexOf("onOrderStatusChangedNotificationTrigger");
    const block = source.slice(start, end);
    expect(block).toContain("pushKotForCashOrderOnCreate(orderId, order)");
  });
});
