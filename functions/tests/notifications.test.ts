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

      // Notification content
      expect(message.notification?.title).toBe("🚨 NEW KOT RECEIVED!");
      expect(message.notification?.body).toContain("Order #BG-8821 (TAKEAWAY [Table 04]) - ₹499");

      // Android High Priority & orders channel (must exist on device)
      expect(message.android?.priority).toBe("high");
      expect(message.android?.notification?.channelId).toBe("burgonomics_orders_channel");
      expect(message.android?.notification?.sound).toBe("new_order");
      expect(message.android?.notification?.priority).toBe("max");
      expect(message.android?.notification?.defaultVibrateTimings).toBe(true);

      // iOS APNs Critical Alert & Sound
      expect(message.apns?.headers?.["apns-priority"]).toBe("10");
      expect(message.apns?.payload?.aps?.sound).toBe("default");
      expect(message.apns?.payload?.aps?.badge).toBe(1);
      expect(message.apns?.payload?.aps?.contentAvailable).toBe(true);

      // WebPush High Urgency & KDS Action Button
      expect(message.webpush?.headers?.Urgency).toBe("high");
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
    it("routes ticket alert to branch tickets topic", () => {
      const branchId = "surat_adajan";
      const ticket = {
        id: "tkt_555",
        ticketNumber: "TK-092",
        subject: "Missing extra dip",
        priority: "urgent",
      };

      const message = buildTicketAlertMessage(branchId, ticket);
      expect(message.topic).toBe("branch_surat_adajan_tickets");
      expect(message.notification?.title).toContain("Ticket Escalation (URGENT)");
      expect(message.notification?.body).toBe("Ticket #TK-092: Missing extra dip");
      expect(message.data?.type).toBe("TICKET_ESCALATION");
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
