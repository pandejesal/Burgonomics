import * as admin from "firebase-admin";

/**
 * B5-S1 push-copy contract (H17/H33/H34):
 * - Free-text subject / names / phones NEVER appear in notification `body`
 *   (PII paste risk on lock screens + screen readers). Generic copy only;
 *   ticket/order IDs ride in `data` so the app fetches detail on open.
 * - Every claim is backend-backed: ETA only when etaMinutes is present,
 *   veg only when allVeg === true, refund only when refundInitiated === true.
 * - Bodies are server-truncated to ~120 chars (tray backstop).
 * - KOT copy is plain-case, no caps/emoji (kitchen printers + accessibility).
 */
export const PUSH_BODY_MAX_CHARS = 120;

/** Server-side truncate backstop for tray bodies (~120 chars, word-safe). */
export function truncatePushText(text: string, maxChars = PUSH_BODY_MAX_CHARS): string {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (clean.length <= maxChars) return clean;
  const cut = clean.slice(0, maxChars - 1);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

export interface ParityOptions {
  /** APNs badge. Omitted => badge key omitted (leaves device badge untouched). */
  badge?: number;
  /** Critical-alert delivery (KOT/kitchen). Default background priority. */
  apnsPriority10?: boolean;
  /** Web action buttons, e.g. KDS "View KDS". */
  webActions?: Array<{ action: string; title: string }>;
}

/**
 * Shared iOS/Web parity extras (H34/M21-server-half). Every push that sets
 * `notification` must spread these so iOS (apns) and web (webpush) render the
 * same title/body instead of going silent while Android alerts.
 */
export function buildParityExtras(
  title: string,
  body: string,
  opts: ParityOptions = {}
): Pick<admin.messaging.Message, "apns" | "webpush"> {
  const extras: Pick<admin.messaging.Message, "apns" | "webpush"> = {
    apns: {
      ...(opts.apnsPriority10 ? { headers: { "apns-priority": "10" as const } } : {}),
      payload: {
        aps: {
          sound: "default",
          contentAvailable: true,
          ...(typeof opts.badge === "number" ? { badge: opts.badge } : {}),
        },
      },
    },
    webpush: {
      headers: { Urgency: "high" },
      notification: {
        title,
        body,
        icon: "/brand/burgonomics-logo.png",
        badge: "/brand/badge-icon.png",
        ...(opts.webActions ? { actions: opts.webActions } : {}),
      },
    },
  };
  return extras;
}

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
  /** Backend-backed flags — copy claims require these, never assumptions. */
  allVeg?: boolean;
  refundInitiated?: boolean;
  paymentMethod?: string;
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
  // Plain-case KOT copy (B5-S1 H33): no caps, no emoji. The acoustic alert
  // comes from the android sound/channel below, never from shouty text.
  const title = "New KOT received";
  const body = `Order #${order.orderNumber} (${fulfillmentUpper}${tableSuffix}) - ₹${order.totalAmount}`;

  return {
    topic: `branch_${branchId}_orders`,
    notification: { title, body },
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
    // Shared parity extras (H34): same title/body on iOS + web. No badge on
    // shared kitchen terminals (badge is per-user inbox state, not per-KOT).
    ...buildParityExtras(title, body, {
      apnsPriority10: true,
      webActions: [{ action: "view_kot", title: "View KDS" }],
    }),
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
    // MOP-S1 (B5-S1 pattern): the old "Sent directly to our kitchen grill"
    // claimed POS/kitchen receipt with no backend field behind it — the KOT
    // push can fail into pending_retry (webhookHandler) after this copy is
    // already on the lock screen. Claim removed, not reworded.
    body: (o) => `We've received your order #${o.orderNumber}. Open the app to track it live.`,
    sound: "default",
  },
  CONFIRMED: {
    title: "🍔 Order Confirmed!",
    body: (o) => `We've received your order #${o.orderNumber}. Open the app to track it live.`,
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
    // ETA is backend-backed only: no etaMinutes => no invented "~20 mins".
    // Partner name only when the dispatch service actually assigned one.
    body: (o) => {
      const eta = typeof o.etaMinutes === "number" && Number.isFinite(o.etaMinutes) && o.etaMinutes > 0
        ? ` (~${Math.round(o.etaMinutes)} mins)`
        : "";
      return o.deliveryPartnerName
        ? `${o.deliveryPartnerName} is on the way with your order #${o.orderNumber}${eta}.`
        : `Your order #${o.orderNumber} is on the way to your doorstep${eta}.`;
    },
    sound: "default",
  },
  DELIVERED: {
    title: "✨ Delivered! Enjoy your meal!",
    // Veg claim only when the order is backend-verified all-veg (H33).
    body: (o) =>
      o.allVeg === true
        ? `Order #${o.orderNumber} has been delivered. Rate your 100% pure veg feast!`
        : `Order #${o.orderNumber} has been delivered. Rate your meal!`,
    sound: "default",
  },
  CANCELLED: {
    title: "⚠️ Order Cancelled",
    // Refund copy only when a refund was actually initiated (H33): COD /
    // unpaid cancels must never promise money movement. paymentMethod and
    // refundInitiated come from the order doc via triggers.ts.
    body: (o) =>
      o.refundInitiated === true
        ? `Order #${o.orderNumber} was cancelled. A refund has been initiated to your original payment method.`
        : `Order #${o.orderNumber} was cancelled. No money was charged for this order.`,
    sound: "default",
  },
};

/**
 * Builds customer notification message for status change.
 * Badge (H18) is per-user inbox state: callers pass the unread count at send
 * time (see fcm.service getUnreadCount). Omitted => badge key omitted.
 */
export function buildCustomerOrderUpdateMessage(
  token: string,
  order: CustomerOrderPayload,
  status: string,
  badge?: number
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
  const body = truncatePushText(meta.body(order));

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
    // Shared iOS/Web parity (H34): same title/body, server-computed badge.
    ...buildParityExtras(title, body, { badge }),
  };
}

/**
 * Builds PII-free support ticket escalation alert (H17).
 * The free-text subject NEVER enters notification.body (reporters paste
 * phones/addresses into subjects; unbounded text also truncates mid-word on
 * trays). Detail rides in data.ticketId — open Tickets to read it.
 */
export function buildTicketAlertMessage(
  branchId: string,
  ticket: { id: string; ticketNumber: string; subject?: string; priority: string },
  badge?: number
): admin.messaging.Message {
  const title = `Ticket ${ticket.ticketNumber} needs attention`;
  const body = truncatePushText(
    `A ${String(ticket.priority).toLowerCase()} priority support ticket is awaiting action — open Tickets to view.`
  );
  return {
    topic: `branch_${branchId}_tickets`,
    notification: { title, body },
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
    // Shared iOS/Web parity (H34).
    ...buildParityExtras(title, body, { badge }),
  };
}
