import { describe, it, expect } from 'vitest';

// These tests import the REAL message builders. The previous file defined
// local builders with divergent channel/sound IDs (kot_acoustic_alerts /
// kot_alarm) — Android SILENTLY DROPS pushes on nonexistent channels, so the
// suite was blessing payloads production must never send. The pins below are
// load-bearing: channel + sound must exist on device (see templates.ts note).

import {
  buildKotAlertMessage,
  buildCustomerOrderUpdateMessage,
  buildTicketAlertMessage,
} from '../src/modules/notifications/templates';

describe('Backend Cloud Functions — FCM HTTP v1 Notification Payloads Suite (real builders)', () => {
  it('builds a high-priority Kitchen KOT message on the branch topic with the on-device channel', () => {
    const msg: any = buildKotAlertMessage('branch_ahmedabad_1', {
      id: 'ord_9901',
      orderNumber: 'BUR-9901',
      fulfillmentType: 'delivery',
      totalAmount: 450,
    });

    expect(msg.topic).toBe('branch_branch_ahmedabad_1_orders');
    // B5-S1: plain-case KOT, no caps/emoji. The acoustic alert is the
    // android sound/channel, never shouty text.
    expect(msg.notification.title).toBe('New KOT received');
    // Must match android/res + channel creation — never invent new IDs here.
    expect(msg.android.notification.channelId).toBe('burgonomics_orders_channel');
    expect(msg.android.notification.sound).toBe('new_order');
    expect(msg.data.type).toBe('NEW_KOT');
    // Shared iOS/Web parity: same copy, kitchen-critical APNs priority.
    expect(msg.apns?.headers?.['apns-priority']).toBe('10');
    expect(msg.webpush?.notification?.title).toBe('New KOT received');
  });

  it('builds customer order status notification for OUT_FOR_DELIVERY', () => {
    const msg: any = buildCustomerOrderUpdateMessage(
      'device_token_xyz_123',
      {
        id: 'ord_9901',
        orderNumber: 'BUR-9901',
        fulfillmentType: 'delivery',
        deliveryPartnerName: 'Rider',
        etaMinutes: 18,
      },
      'OUT_FOR_DELIVERY'
    );

    expect(msg.token).toBe('device_token_xyz_123');
    expect(msg.notification.title).toBe('🛵 Out for Delivery!');
    expect(msg.notification.body).toContain('~18 mins');
    expect(msg.data.status).toBe('OUT_FOR_DELIVERY');
    expect(msg.android.notification.channelId).toBe('burgonomics_updates_channel');
    // Parity: same body on web, badge omitted when uncounted.
    expect(msg.webpush?.notification?.body).toBe(msg.notification.body);
    expect(msg.apns?.payload?.aps?.badge).toBeUndefined();
  });

  it('never invents an ETA when etaMinutes is absent', () => {
    const msg: any = buildCustomerOrderUpdateMessage(
      'device_token_xyz_123',
      { id: 'ord_9901', orderNumber: 'BUR-9901', fulfillmentType: 'delivery' },
      'OUT_FOR_DELIVERY'
    );

    expect(msg.notification.body).not.toMatch(/~\d+ mins/);
  });

  it('falls back to a generic update for unknown statuses (never throws)', () => {
    const msg: any = buildCustomerOrderUpdateMessage(
      'device_token_xyz_123',
      { id: 'ord_9901', orderNumber: 'BUR-9901', fulfillmentType: 'delivery' },
      'SOME_FUTURE_STATUS'
    );

    expect(msg.notification.title).toBe('📦 Order Update');
  });

  it('routes ticket escalation alerts to the branch tickets topic without PII', () => {
    const subject = 'Missing extra dip, call me on 9876543210';
    const msg: any = buildTicketAlertMessage('cg_road', {
      id: 'tk_1',
      ticketNumber: 'TK-092',
      subject,
      priority: 'URGENT',
    });

    expect(msg.topic).toBe('branch_cg_road_tickets');
    // Subject NEVER in body — generic copy, IDs in data only.
    expect(msg.notification?.body).not.toContain('Missing extra dip');
    expect(msg.notification?.body).not.toContain('9876543210');
    expect(msg.data?.ticketId).toBe('tk_1');
    expect(msg.data?.type).toBe('TICKET_ESCALATION');
    expect(msg.data?.subject).toBeUndefined();
  });
});
