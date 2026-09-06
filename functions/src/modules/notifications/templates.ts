import * as admin from "firebase-admin";

export interface KotOrderPayload {
  id: string;
  orderNumber: string;
  fulfillmentType: string;
  totalAmount: number;
  itemsCount?: number;
  tableNumber?: string;
}

export interface CustomerOrderPayload {
  id: string;
  orderNumber: string;
  fulfillmentType: string;
  storeName?: string;
  etaMinutes?: number;
  deliveryPartnerName?: string;
}

/**
 * Builds high-priority acoustic KOT kitchen alert message for POS/KDS devices.
 */
export function buildKotAlertMessage(
  branchId: string,
  order: KotOrderPayload
): admin.messaging.Message {
  const fulfillmentUpper = (order.fulfillmentType || "DELIVERY").toUpperCase();
  const tableSuffix = order.tableNumber ? ` [Table ${order.tableNumber}]` : "";

  return {
    topic: `branch_${branchId}_orders`,
    notification: {
      title: "🚨 NEW KOT RECEIVED!",
      body: `Order #${order.orderNumber} (${fulfillmentUpper}${tableSuffix}) - ₹${order.totalAmount}`,
    },
    data: {
      orderId: String(order.id),
      orderNumber: String(order.orderNumber),
      fulfillmentType: String(order.fulfillmentType),
      totalAmount: String(order.totalAmount),
      type: "NEW_KOT",
      click_action: "FLUTTER_NOTIFICATION_CLICK",
    },
    android: {
      priority: "high",
      notification: {
        // Channel + sound MUST exist on device (partner
        // pushNotifications.ts creates burgonomics_orders_channel; the
        // new_order.wav asset is bundled in android res/raw). A nonexistent
        // channel ID is silently dropped by Android — never invent one here
        // without shipping the asset + creation call first.
        channelId: "burgonomics_orders_channel",
        sound: "new_order",
        priority: "max",
        defaultVibrateTimings: true,
      },
    },
    apns: {
      headers: {
        "apns-priority": "10",
      },
      payload: {
        aps: {
          sound: "default",
          badge: 1,
          contentAvailable: true,
        },
      },
    },
    webpush: {
      headers: {
        Urgency: "high",
      },
      notification: {
        title: "🚨 NEW KOT RECEIVED!",
        body: `Order #${order.orderNumber} (${fulfillmentUpper}${tableSuffix}) - ₹${order.totalAmount}`,
        icon: "/brand/burgonomics-logo.png",
        badge: "/brand/badge-icon.png",
        actions: [
          {
            action: "view_kot",
            title: "View KDS",
          },
        ],
      },
    },
  };
}

/**
 * Status definitions & customer push copy
 */
export const STATUS_MESSAGES: Record<
  string,
  { title: string; body: (o: CustomerOrderPayload) => string; sound: string }
> = {
  PLACED: {
    title: "🍔 Order Confirmed!",
    body: (o) => `We've received your order #${o.orderNumber}. Sent directly to our kitchen grill!`,
    sound: "default",
  },
  CONFIRMED: {
    title: "🍔 Order Confirmed!",
    body: (o) => `We've received your order #${o.orderNumber}. Sent directly to our kitchen grill!`,
    sound: "default",
  },
  ACCEPTED: {
    title: "👨‍🍳 Kitchen Accepted!",
    body: (o) => `Our chefs at ${o.storeName || "Burgonomics"} have fired up the grill for order #${o.orderNumber}.`,
    sound: "default",
  },
  PREPARING: {
    title: "🔥 Burgers on the Grill!",
    body: (o) => `Order #${o.orderNumber} is sizzling fresh on the grill!`,
    sound: "default",
  },
  READY_FOR_PICKUP: {
    title: "🛍️ Ready for Pickup!",
    body: (o) => `Your order #${o.orderNumber} is packed and waiting at the counter!`,
    sound: "default",
  },
  OUT_FOR_DELIVERY: {
    title: "🛵 Out for Delivery!",
    body: (o) =>
      o.deliveryPartnerName
        ? `${o.deliveryPartnerName} is on the way with your order #${o.orderNumber} (~${o.etaMinutes || 20} mins).`
        : `Your hot burgers are on the way to your doorstep (~${o.etaMinutes || 20} mins).`,
    sound: "default",
  },
  DELIVERED: {
    title: "✨ Delivered! Enjoy your meal!",
    body: (o) => `Order #${o.orderNumber} has been delivered. Rate your 100% pure veg feast!`,
    sound: "default",
  },
  CANCELLED: {
    title: "⚠️ Order Cancelled",
    body: (o) => `Order #${o.orderNumber} was cancelled. If you were charged, a full refund has been initiated.`,
    sound: "default",
  },
};

/**
 * Builds customer notification message for status change.
 */
export function buildCustomerOrderUpdateMessage(
  token: string,
  order: CustomerOrderPayload,
  status: string
): admin.messaging.Message {
  const meta = STATUS_MESSAGES[status.toUpperCase()] || {
    // Never interpolate raw internal status codes to the lock screen
    // (ROUTE_TRANSFER_PENDING etc. read as jargon). Generic + actionable.
    title: "📦 Order Update",
    body: () => `Order #${order.orderNumber} has a new update — open the app to track it.`,
    sound: "default",
  };
  if (!STATUS_MESSAGES[status.toUpperCase()]) {
    console.warn(`[Notifications] Unmapped order status pushed generically: ${status}`);
  }

  const title = meta.title;
  const body = meta.body(order);

  return {
    token,
    notification: {
      title,
      body,
    },
    data: {
      orderId: String(order.id),
      orderNumber: String(order.orderNumber),
      status: String(status),
      type: "ORDER_STATUS_UPDATE",
    },
    android: {
      priority: "high",
      notification: {
        // Must match a channel created on device (see note above).
        channelId: "burgonomics_updates_channel",
        sound: meta.sound,
      },
    },
    apns: {
      payload: {
        aps: {
          sound: "default",
          badge: 1,
        },
      },
    },
  };
}

/**
 * Builds support ticket escalation alert message.
 */
export function buildTicketAlertMessage(
  branchId: string,
  ticket: { id: string; ticketNumber: string; subject: string; priority: string }
): admin.messaging.Message {
  return {
    topic: `branch_${branchId}_tickets`,
    notification: {
      title: `🎫 Ticket Escalation (${ticket.priority.toUpperCase()})`,
      body: `Ticket #${ticket.ticketNumber}: ${ticket.subject}`,
    },
    data: {
      ticketId: String(ticket.id),
      ticketNumber: String(ticket.ticketNumber),
      priority: String(ticket.priority),
      type: "TICKET_ESCALATION",
    },
    android: {
      priority: "high",
      notification: {
        // Must match a channel created on device (see note above).
        channelId: "burgonomics_updates_channel",
        sound: "default",
      },
    },
  };
}
