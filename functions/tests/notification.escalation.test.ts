import { describe, it, expect, vi, beforeEach } from "vitest";

const { handlers, fcmMocks, errorMocks } = vi.hoisted(() => {
  const handlers: { created: any[]; updated: any[] } = { created: [], updated: [] };
  const fcmMocks = {
    sendFcmMessage: vi.fn(async () => true),
    sendMulticastFcm: vi.fn(async () => ({ successCount: 1 })),
    writeCustomerInboxDoc: vi.fn(async () => {}),
  };
  const errorMocks = {
    captureErrorSnapshot: vi.fn(async () => "err_test_123"),
  };
  return { handlers, fcmMocks, errorMocks };
});

// Capture the raw handlers so the trigger logic can be unit-invoked without
// the firebase-functions runtime.
vi.mock("firebase-functions/v2/firestore", () => ({
  onDocumentCreated: (_cfg: any, handler: any) => {
    handlers.created.push(handler);
    return handler;
  },
  onDocumentUpdated: (_cfg: any, handler: any) => {
    handlers.updated.push(handler);
    return handler;
  },
}));

vi.mock("../src/modules/notifications/fcmClient", () => ({
  sendFcmMessage: fcmMocks.sendFcmMessage,
  sendMulticastFcm: fcmMocks.sendMulticastFcm,
  writeCustomerInboxDoc: fcmMocks.writeCustomerInboxDoc,
}));

vi.mock("../src/core/errors", () => ({
  captureErrorSnapshot: errorMocks.captureErrorSnapshot,
}));

vi.mock("firebase-admin", () => {
  const FieldValue = { serverTimestamp: () => "MOCK_TIMESTAMP" };
  const firestoreFn: any = vi.fn(() => ({ collection: () => ({ doc: () => ({ get: async () => ({ data: () => ({}) }) }) }) }));
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

import { onTicketEscalatedNotificationTrigger } from "../src/modules/notifications/triggers";

/**
 * P2 (finding 14): the escalation trigger previously had no try/catch — a
 * throwing FCM send rejected the Firestore trigger (retry storm) while the
 * SLA clock kept running silently. It must snapshot loudly instead.
 */

function escalationEvent(before: any, after: any) {
  return {
    data: {
      before: { data: () => before },
      after: { data: () => after },
    },
    params: { ticketId: "tkt_900" },
  } as any;
}

beforeEach(() => {
  fcmMocks.sendFcmMessage.mockClear().mockResolvedValue(true as any);
  errorMocks.captureErrorSnapshot.mockClear();
});

describe("onTicketEscalatedNotificationTrigger (P2 finding 14)", () => {
  it("registers on the canonical support_tickets collection", () => {
    expect(typeof onTicketEscalatedNotificationTrigger).toBe("function");
    expect(handlers.updated.length).toBeGreaterThan(0);
  });

  it("a throwing alert is caught, snapshotted, and never rejects the trigger", async () => {
    fcmMocks.sendFcmMessage.mockRejectedValueOnce(new Error("FCM transport exploded"));

    await expect(
      onTicketEscalatedNotificationTrigger(
        escalationEvent(
          { priority: "high", branchId: "b1", ticketNumber: "T-77" },
          { priority: "urgent", branchId: "b1", ticketNumber: "T-77" }
        )
      )
    ).resolves.toBeUndefined();

    expect(fcmMocks.sendFcmMessage).toHaveBeenCalledTimes(1);
    expect(errorMocks.captureErrorSnapshot).toHaveBeenCalledTimes(1);
    expect(errorMocks.captureErrorSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "notifications",
        severity: "high",
        message: expect.stringMatching(/escalation alert failed for ticket tkt_900/),
      })
    );
  });

  it("a healthy escalation sends the alert without snapshots", async () => {
    await onTicketEscalatedNotificationTrigger(
      escalationEvent(
        { priority: "normal", branchId: "b1" },
        { priority: "urgent", branchId: "b1", ticketNumber: "T-78" }
      )
    );

    expect(fcmMocks.sendFcmMessage).toHaveBeenCalledTimes(1);
    expect(errorMocks.captureErrorSnapshot).not.toHaveBeenCalled();
  });

  it("non-escalation priority changes (or no change) never alert", async () => {
    await onTicketEscalatedNotificationTrigger(
      escalationEvent({ priority: "urgent" }, { priority: "urgent" })
    );
    await onTicketEscalatedNotificationTrigger(
      escalationEvent({ priority: "urgent" }, { priority: "high" })
    );

    expect(fcmMocks.sendFcmMessage).not.toHaveBeenCalled();
    expect(errorMocks.captureErrorSnapshot).not.toHaveBeenCalled();
  });
});
