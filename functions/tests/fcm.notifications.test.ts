import { describe, it, expect } from 'vitest';

export interface OrderNotificationPayload {
  orderId: string;
  orderNumber: string;
  branchId: string;
  fulfillmentType: 'delivery' | 'takeaway' | 'dinein';
  totalInr: number;
  customerName: string;
  status: string;
}

export function buildKitchenKotFcmMessage(order: OrderNotificationPayload) {
  return {
    topic: `branch_${order.branchId}_orders`,
    notification: {
      title: '🚨 NEW KOT RECEIVED!',
      body: `Order #${order.orderNumber} (${order.fulfillmentType.toUpperCase()}) - ₹${order.totalInr}`,
    },
    data: {
      orderId: order.orderId,
      orderNumber: order.orderNumber,
      fulfillmentType: order.fulfillmentType,
      type: 'NEW_KOT',
      timestamp: String(Date.now()),
    },
    android: {
      priority: 'high' as const,
      notification: {
        channelId: 'kot_acoustic_alerts',
        sound: 'kot_alarm',
        priority: 'max' as const,
        defaultVibrateTimings: true,
      },
    },
    apns: {
      payload: {
        aps: {
          sound: 'kot_alarm.wav',
          badge: 1,
          contentAvailable: true,
        },
      },
    },
    webpush: {
      headers: {
        Urgency: 'high',
      },
      notification: {
        requireInteraction: true,
        icon: '/icons/burgonomics-kot-icon.png',
        badge: '/icons/badge.png',
        actions: [
          { action: 'view_kds', title: 'Open Makeline KDS' },
          { action: 'print_kot', title: 'Print KOT' },
        ],
      },
    },
  };
}

export function buildCustomerOrderStatusFcmMessage(
  deviceToken: string,
  order: OrderNotificationPayload
) {
  const statusTitles: Record<string, string> = {
    accepted: '👨‍🍳 Kitchen Accepted Your Order!',
    preparing: '🔥 Sizzling on the Grill!',
    ready: '📦 Order Packed & Ready!',
    out_for_delivery: '🛵 Rider is Out for Delivery!',
    delivered: '🎉 Enjoy Your Fresh Smash Burgers!',
  };

  const title = statusTitles[order.status] || '🍔 Burgonomics Order Update';

  return {
    token: deviceToken,
    notification: {
      title,
      body: `Order #${order.orderNumber}: Status is now ${order.status.replace(/_/g, ' ').toUpperCase()}`,
    },
    data: {
      orderId: order.orderId,
      status: order.status,
      type: 'ORDER_STATUS_UPDATE',
    },
    android: {
      priority: 'high' as const,
      notification: {
        channelId: 'customer_order_updates',
        sound: 'default',
      },
    },
  };
}

export function shouldSendStatusNotification(beforeStatus: string, afterStatus: string): boolean {
  if (!afterStatus || beforeStatus === afterStatus) {
    return false;
  }
  const notifiableStatuses = ['accepted', 'preparing', 'ready', 'out_for_delivery', 'delivered', 'cancelled'];
  return notifiableStatuses.includes(afterStatus);
}

export function pruneDeadDeviceTokens(
  currentTokens: string[],
  invalidTokenResponseError: { code: string; token: string }
): string[] {
  if (
    invalidTokenResponseError.code === 'messaging/registration-token-not-registered' ||
    invalidTokenResponseError.code === 'messaging/invalid-registration-token'
  ) {
    return currentTokens.filter((t) => t !== invalidTokenResponseError.token);
  }
  return currentTokens;
}

describe('Backend Cloud Functions — FCM HTTP v1 Notification Payloads Suite', () => {
  const sampleOrder: OrderNotificationPayload = {
    orderId: 'ord_9901',
    orderNumber: 'BUR-9901',
    branchId: 'branch_ahmedabad_1',
    fulfillmentType: 'delivery',
    totalInr: 450,
    customerName: 'Rohit Sharma',
    status: 'pending',
  };

  it('builds a high-priority Kitchen KOT FCM message targeting the branch topic with acoustic sound channel', () => {
    const fcmPayload = buildKitchenKotFcmMessage(sampleOrder);

    expect(fcmPayload.topic).toBe('branch_branch_ahmedabad_1_orders');
    expect(fcmPayload.notification.title).toBe('🚨 NEW KOT RECEIVED!');
    expect(fcmPayload.android.notification.channelId).toBe('kot_acoustic_alerts');
    expect(fcmPayload.android.notification.sound).toBe('kot_alarm');
    expect(fcmPayload.apns.payload.aps.sound).toBe('kot_alarm.wav');
    expect(fcmPayload.webpush.headers.Urgency).toBe('high');
    expect(fcmPayload.webpush.notification.actions).toHaveLength(2);
  });

  it('builds customer order status notification for out_for_delivery', () => {
    const customerOrder: OrderNotificationPayload = {
      ...sampleOrder,
      status: 'out_for_delivery',
    };

    const msg = buildCustomerOrderStatusFcmMessage('device_token_xyz_123', customerOrder);

    expect(msg.token).toBe('device_token_xyz_123');
    expect(msg.notification.title).toBe('🛵 Rider is Out for Delivery!');
    expect(msg.data.status).toBe('out_for_delivery');
    expect(msg.android.notification.channelId).toBe('customer_order_updates');
  });

  it('deduplicates notifications by evaluating status changes before triggering push', () => {
    expect(shouldSendStatusNotification('preparing', 'preparing')).toBe(false);
    expect(shouldSendStatusNotification('preparing', 'ready')).toBe(true);
    expect(shouldSendStatusNotification('ready', 'out_for_delivery')).toBe(true);
    expect(shouldSendStatusNotification('placed', 'unknown_status')).toBe(false);
  });

  it('prunes dead registration tokens upon receipt of registration-token-not-registered error', () => {
    const tokens = ['token_valid_1', 'token_stale_dead', 'token_valid_2'];
    const err = { code: 'messaging/registration-token-not-registered', token: 'token_stale_dead' };

    const pruned = pruneDeadDeviceTokens(tokens, err);
    expect(pruned).toEqual(['token_valid_1', 'token_valid_2']);
  });
});
