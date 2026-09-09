import { describe, it, expect } from "vitest";
import {
  buildKotAlertMessage,
  buildCustomerOrderUpdateMessage,
  buildTicketAlertMessage,
  STATUS_MESSAGES,
} from "../src/modules/notifications/templates";
import { sendFcmMessage, sendMulticastFcm } from "../src/modules/notifications/fcmClient";

describe("Prompt 19: Backend FCM Push Notifications & Acoustic Audio Payloads", () => {
  describe("1. KOT Acoustic Audio Alert Payload Construction", () => {
    it("constructs high-priority acoustic KOT payload for POS / KDS terminals", () => {
      const branchId = "branch_andheri_west";
      const order = {
        id: "ord_1001",
        orderNumber: "BG-8821",
        fulfillmentType: "takeaway",
        totalAmount: 499,
        tableNumber: "04",
      };

      const message = buildKotAlertMessage(branchId, order);

      // Topic routing
      expect(message.topic).toBe("branch_branch_andheri_west_orders");

      // Notification content (B5-S1: plain-case KOT, no caps/emoji)
      expect(message.notification?.title).toBe("New KOT received");
      expect(message.notification?.body).toContain("Order #BG-8821 (TAKEAWAY [Table 04]) - ₹499");

      // Android High Priority & orders channel (must exist on device)
      expect(message.android?.priority).toBe("high");
      expect(message.android?.notification?.channelId).toBe("burgonomics_orders_channel");
      expect(message.android?.notification?.sound).toBe("new_order");
      expect(message.android?.notification?.priority).toBe("max");
      expect(message.android?.notification?.defaultVibrateTimings).toBe(true);

      // iOS APNs Critical Alert & Sound (shared parity helper, no per-user badge on KOT)
      expect(message.apns?.headers?.["apns-priority"]).toBe("10");
      expect(message.apns?.payload?.aps?.sound).toBe("default");
      expect(message.apns?.payload?.aps?.badge).toBeUndefined();
      expect(message.apns?.payload?.aps?.contentAvailable).toBe(true);

      // WebPush High Urgency & KDS Action Button (same copy as Android/iOS)
      expect(message.webpush?.headers?.Urgency).toBe("high");
      expect(message.webpush?.notification?.title).toBe("New KOT received");
      expect(message.webpush?.notification?.actions).toEqual([
        { action: "view_kot", title: "View KDS" },
      ]);
    });
  });

  describe("2. Customer Order Status Update Notifications", () => {
    const mockOrder = {
      id: "ord_2002",
      orderNumber: "BG-9932",
      fulfillmentType: "delivery",
      storeName: "Burgonomics Bandra",
      etaMinutes: 20,
      deliveryPartnerName: "Rahul Sharma (Porter)",
    };

    it("generates correct title and body for PREPARING state", () => {
      const message = buildCustomerOrderUpdateMessage("fcm_token_123", mockOrder, "PREPARING");
      expect(message.notification?.title).toBe("🔥 Burgers on the Grill!");
      expect(message.notification?.body).toContain("Order #BG-9932 is sizzling fresh on the grill!");
      expect(message.data?.status).toBe("PREPARING");
    });

    it("generates correct title and driver ETA for OUT_FOR_DELIVERY state", () => {
      const message = buildCustomerOrderUpdateMessage("fcm_token_123", mockOrder, "OUT_FOR_DELIVERY");
      expect(message.notification?.title).toBe("🛵 Out for Delivery!");
      expect(message.notification?.body).toContain("Rahul Sharma (Porter) is on the way");
      expect(message.notification?.body).toContain("~20 mins");
    });

    it("covers all 8 standard status transitions in STATUS_MESSAGES", () => {
      const expectedStatuses = [
        "PLACED",
        "CONFIRMED",
        "ACCEPTED",
        "PREPARING",
        "READY_FOR_PICKUP",
        "OUT_FOR_DELIVERY",
        "DELIVERED",
        "CANCELLED",
      ];
      expectedStatuses.forEach((status) => {
        expect(STATUS_MESSAGES[status]).toBeDefined();
        expect(STATUS_MESSAGES[status].title).toBeDefined();
        expect(typeof STATUS_MESSAGES[status].body).toBe("function");
      });
    });
  });

  describe("3. Support Ticket Escalation Alerts", () => {
    it("routes ticket alert to branch tickets topic with PII-free body", () => {
      const branchId = "surat_adajan";
      const ticket = {
        id: "tkt_555",
        ticketNumber: "TK-092",
        subject: "Missing extra dip, my phone is 9876543210",
        priority: "urgent",
      };

      const message = buildTicketAlertMessage(branchId, ticket);
      expect(message.topic).toBe("branch_surat_adajan_tickets");
      expect(message.notification?.body).not.toContain("Missing extra dip");
      expect(message.notification?.body).not.toContain("9876543210");
      expect(message.notification?.body?.length).toBeLessThanOrEqual(120);
      expect(message.data?.type).toBe("TICKET_ESCALATION");
      expect(message.data?.ticketId).toBe("tkt_555");
    });

    it("keeps refund/veg/ETA claims backend-backed", () => {      const base = { id: "o1", orderNumber: "BG-1", fulfillmentType: "delivery" };
      // No flags => generic honest copy, no invented ETA/refund/veg.
      const cancelled = buildCustomerOrderUpdateMessage("t", base, "CANCELLED");
      expect(cancelled.notification?.body).toContain("No money was charged");
      expect(cancelled.notification?.body).not.toContain("refund has been initiated");
      const delivered = buildCustomerOrderUpdateMessage("t", base, "DELIVERED");
      expect(delivered.notification?.body).not.toContain("veg");
      const enRoute = buildCustomerOrderUpdateMessage("t", base, "OUT_FOR_DELIVERY");
      expect(enRoute.notification?.body).not.toMatch(/~\d+ mins/);
      // Flags present => specific copy allowed.
      const refunded = buildCustomerOrderUpdateMessage(
        "t",
        { ...base, refundInitiated: true },
        "CANCELLED"
      );
      expect(refunded.notification?.body).toContain("refund has been initiated");
      const veg = buildCustomerOrderUpdateMessage("t", { ...base, allVeg: true }, "DELIVERED");
      expect(veg.notification?.body).toContain("veg");
    });

    // MOP-S1 (B5-S1 follow-up 3): PLACED/CONFIRMED carry no unbacked
    // kitchen/POS receipt claim — the KOT push can fail into pending_retry
    // after this copy is already on the lock screen.
    it("PLACED/CONFIRMED carry no unbacked kitchen-grill POS-ack claim", () => {
      const base = { id: "o1", orderNumber: "BG-1", fulfillmentType: "delivery" };
      for (const status of ["PLACED", "CONFIRMED"]) {
        const msg = buildCustomerOrderUpdateMessage("t", base, status);
        expect(msg.notification?.body).not.toContain("kitchen grill");
        expect(msg.notification?.body).not.toContain("Sent directly");
        expect(msg.notification?.body).toContain("BG-1");
      }
    });
  });

  describe("4. FCM Client & Dispatch Verification", () => {
    it("dispatches single message cleanly without throwing errors", async () => {
      const message = buildKotAlertMessage("branch_1", {
        id: "ord_1",
        orderNumber: "BG-01",
        fulfillmentType: "dinein",
        totalAmount: 250,
      });

      const success = await sendFcmMessage(message);
      expect(success).toBe(true);
    });

    it("dispatches multicast message and returns result structure", async () => {
      const result = await sendMulticastFcm(
        ["token_1", "token_2"],
        {
          notification: { title: "Test", body: "Test Body" },
        },
        "user_123"
      );

      expect(result.successCount).toBeGreaterThanOrEqual(0);
      expect(Array.isArray(result.prunedTokens)).toBe(true);
    });
  });
});
