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
    expect(msg.notification.title).toBe('🚨 NEW KOT RECEIVED!');
    // Must match android/res + channel creation — never invent new IDs here.
    expect(msg.android.notification.channelId).toBe('burgonomics_orders_channel');
    expect(msg.android.notification.sound).toBe('new_order');
    expect(msg.data.type).toBe('NEW_KOT');
  });

  it('builds customer order status notification for OUT_FOR_DELIVERY', () => {
    const msg: any = buildCustomerOrderUpdateMessage(
      'device_token_xyz_123',
      { id: 'ord_9901', orderNumber: 'BUR-9901', fulfillmentType: 'delivery' },
      'OUT_FOR_DELIVERY'
    );

    expect(msg.token).toBe('device_token_xyz_123');
    expect(msg.notification.title).toBe('🛵 Out for Delivery!');
    expect(msg.data.status).toBe('OUT_FOR_DELIVERY');
    expect(msg.android.notification.channelId).toBe('burgonomics_updates_channel');
  });

  it('falls back to a generic update for unknown statuses (never throws)', () => {
    const msg: any = buildCustomerOrderUpdateMessage(
      'device_token_xyz_123',
      { id: 'ord_9901', orderNumber: 'BUR-9901', fulfillmentType: 'delivery' },
      'SOME_FUTURE_STATUS'
    );

    expect(msg.notification.title).toBe('📦 Order Update');
  });

  it('routes ticket escalation alerts to the branch tickets topic', () => {
    const msg: any = buildTicketAlertMessage('cg_road', {
      id: 'tk_1',
      ticketNumber: 'TK-092',
      subject: 'Missing extra dip',
      priority: 'URGENT',
    });

    expect(msg.topic).toBe('branch_cg_road_tickets');
    expect(msg.notification?.title).toContain('Ticket Escalation (URGENT)');
    expect(msg.data?.type).toBe('TICKET_ESCALATION');
  });
});
