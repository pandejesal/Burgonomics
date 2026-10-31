import { describe, it, expect, vi, beforeEach } from "vitest";

// CASH-KOT trigger-level behaviour: the KOT push runs AFTER the customer
// notification, inside its own try/catch, so a POS failure/timeout can never
// block a notification or reject (and therefore replay) the whole trigger.
const { pushMock } = vi.hoisted(() => ({
  pushMock: vi.fn(async (): Promise<boolean | null> => {
    throw new Error("Petpooja refund request timed out");
  }),
}));

vi.mock("../src/modules/petpooja/orderPush", () => ({
  pushKotForCashOrderOnAccept: pushMock,
  // Keep any other symbol the notifications module might import harmless.
  pushOrderToPetpooja: vi.fn(async () => true),
  isCashOrPayAtStoreOrder: vi.fn(() => true),
  isCashKotAcceptTransition: vi.fn(() => true),
}));

const { sendMulticastMock, inboxMock } = vi.hoisted(() => ({
  sendMulticastMock: vi.fn(async () => ({ successCount: 1 })),
  inboxMock: vi.fn(async () => undefined),
}));

vi.mock("../src/modules/notifications/fcmClient", () => ({
  sendFcmMessage: vi.fn(async () => true),
  sendMulticastFcm: sendMulticastMock,
  writeCustomerInboxDoc: inboxMock,
  getUnreadCount: vi.fn(async () => 0),
  pushToCustomer: vi.fn(async () => undefined),
}));

const { mockDb } = vi.hoisted(() => {
  const mockDb: any = {
    collection: () => ({
      doc: () => ({
        get: async () => ({
          exists: true,
          data: () => ({ fcmTokens: ["tok_1"] }),
        }),
      }),
    }),
  };
  return { mockDb };
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

import { handleOrderStatusChanged } from "../src/modules/notifications/triggers";

const status = (code: string) => ({ code, label: code, kind: "in_progress", terminal: false });
const order = (code: string) => ({
  id: "ord_cash_1",
  customerId: "cust_1",
  branchId: "branch_a",
  payment: { method: "cod" },
  status: status(code),
});

describe("CASH-KOT in the order-status-changed trigger", () => {
  beforeEach(() => {
    pushMock.mockClear();
    sendMulticastMock.mockClear();
    inboxMock.mockClear();
  });

  it("sends notifications first, then the KOT push, and resolves when the POS fails", async () => {
    await expect(
      handleOrderStatusChanged("ord_cash_1", order("PLACED"), order("PREPARING"))
    ).resolves.toBeUndefined();

    expect(sendMulticastMock).toHaveBeenCalledTimes(1);
    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(pushMock).toHaveBeenCalledWith(
      "ord_cash_1",
      expect.objectContaining({ status: expect.objectContaining({ code: "PLACED" }) }),
      expect.objectContaining({ status: expect.objectContaining({ code: "PREPARING" }) })
    );
    // Push strictly after the notification: a POS hang cannot silence it.
    expect(pushMock.mock.invocationCallOrder[0]).toBeGreaterThan(
      sendMulticastMock.mock.invocationCallOrder[0]
    );
  });

  it("does nothing when the status did not change (unrelated update)", async () => {
    await handleOrderStatusChanged("ord_cash_1", order("PLACED"), order("PLACED"));

    expect(sendMulticastMock).not.toHaveBeenCalled();
    expect(pushMock).not.toHaveBeenCalled();
  });
});
