import { createHmac } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Firestore boundary double: queued atomic transactions, query reads, and a
// failure injected at either side of the actual generator's publication.
const store = vi.hoisted(() => {
  const docs = new Map<string, any>();
  const writes: string[] = [];
  let queue = Promise.resolve();
  const DELETE = '__field_delete__';
  const fault = { publication: false, checkpoint: false, month: '' };
  const view = (path: string): any => ({
    exists: docs.has(path), id: path.split('/').at(-1), ref: ref(path),
    data: () => {
      const data = structuredClone(docs.get(path));
      const fractionalTimestamp = data?.createdAt?.fixtureTimestampMs;
      if (typeof fractionalTimestamp === 'number') data.createdAt = { toMillis: () => fractionalTimestamp };
      return data;
    },
  });
  function write(path: string, data: any, merge = false) {
    const next = { ...(merge ? docs.get(path) : {}), ...structuredClone(data) };
    for (const key of Object.keys(next)) if (next[key] === DELETE) delete next[key];
    docs.set(path, next);
    writes.push(path);
  }
  function ref(path: string): any {
    return {
      path, id: path.split('/').at(-1), get: async () => view(path),
      set: async (data: any, opt?: any) => write(path, data, opt?.merge),
      update: async (data: any) => write(path, data, true),
      create: async (data: any) => { if (docs.has(path)) throw Object.assign(new Error('exists'), { code: 6 }); write(path, data); },
      delete: async () => { docs.delete(path); },
    };
  }
  const field = (obj: any, key: any): any => typeof key === 'string'
    ? key.split('.').reduce((value, part) => value?.[part], obj) : obj[key.segments[0]];
  const scalar = (value: any) => value instanceof Date ? value.getTime() : value?.toMillis?.() ?? value;
  function query(col: string, filters: any[][] = [], cap = Infinity, sort?: string, cursor?: string): any {
    return {
      where: (...filter: any[]) => query(col, [...filters, filter], cap, sort, cursor),
      limit: (n: number) => query(col, filters, n, sort, cursor),
      orderBy: (key: string) => query(col, filters, cap, key, cursor),
      startAfter: (d: any) => query(col, filters, cap, sort, d.ref.path),
      get: async () => {
        const keys = [...docs.keys()].filter(k => k.startsWith(`${col}/`) && filters.every(([key, op, value]) => {
          const a = scalar(field(docs.get(k), key)); const b = scalar(value);
          if (op === '==') return a === b;
          if (op === '<') return a < b;
          if (op === '>=') return a >= b;
          if (op === '>') return a > b;
          return false;
        })).sort((a, b) => sort ? (field(docs.get(a), sort) > field(docs.get(b), sort) ? 1 : -1) : a.localeCompare(b));
        const matches = keys.slice(cursor ? keys.indexOf(cursor) + 1 : 0).slice(0, cap).map(view);
        return { docs: matches, empty: matches.length === 0, size: matches.length };
      },
    };
  }
  const db = {
    collection: (col: string) => ({ ...query(col), doc: (id = `auto-${docs.size}`) => ref(`${col}/${id}`), add: async (data: any) => write(`${col}/auto-${docs.size}`, data) }),
    runTransaction: (fn: any) => {
      const run = queue.then(async () => {
        const ops: { path: string; data?: any; merge?: boolean; create?: boolean }[] = [];
        const result = await fn({
          get: (r: any) => { if (ops.length) throw new Error('Firestore requires reads before writes'); return r.get(); },
          set: (r: any, data: any, opt?: any) => ops.push({ path: r.path, data, merge: opt?.merge }),
          update: (r: any, data: any) => ops.push({ path: r.path, data, merge: true }),
          create: (r: any, data: any) => ops.push({ path: r.path, data, create: true }),
          delete: (r: any) => ops.push({ path: r.path }),
        });
        if (fault.publication && ops.some(o => o.path.startsWith('branch_settlements/') && (!fault.month || o.path.includes(fault.month)))) {
          fault.publication = false; throw new Error('publication unavailable');
        }
        if (fault.checkpoint && ops.some(o => o.data?.pendingRegeneration === DELETE)) {
          fault.checkpoint = false; throw new Error('checkpoint unavailable after publication');
        }
        for (const op of ops) if (op.create && docs.has(op.path)) throw new Error('already exists');
        for (const op of ops) if (op.data) write(op.path, op.data, op.merge); else docs.delete(op.path);
        return result;
      });
      queue = run.then(() => undefined, () => undefined);
      return run;
    },
  };
  return { docs, writes, db, fault, DELETE, alert: vi.fn(), payment: vi.fn(), verify: vi.fn() };
});

vi.mock('firebase-admin', () => {
  const firestore = Object.assign(() => store.db, {
    FieldPath: class FieldPath { public segments: string[]; constructor(...segments: string[]) { this.segments = segments; } },
    FieldValue: { serverTimestamp: () => '__timestamp__', delete: () => store.DELETE, increment: (n: number) => n },
  });
  const sdk = { apps: [{}], initializeApp: vi.fn(), firestore, auth: () => ({ verifyIdToken: store.verify }), messaging: () => ({}), appCheck: () => ({ verifyToken: vi.fn() }) };
  return { ...sdk, default: sdk };
});
vi.mock('../src/modules/payments/razorpayClient', () => ({ getRazorpayClient: () => ({ payments: { fetch: store.payment } }) }));
vi.mock('../src/core/errors', async importOriginal => ({ ...await importOriginal<object>(), captureErrorSnapshot: store.alert }));

import * as endpoints from '../src/index';
import { config } from '../src/config/env';

const ORDER = 'capture-order';
const PAY = 'pay_testcaptured';
const M = '2026-10';
const N = '2026-11';
const OLD = Date.UTC(2026, 9, 31, 17, 0);
const PROVIDER = Date.UTC(2026, 9, 31, 20, 0);
const SECRET = 'local-webhook-test-secret';
const audit = () => [...store.docs.keys()].filter(k => k.startsWith('settlement_capture_resolutions/'));
const issuePath = `settlement_capture_issues/${ORDER}`;
const orderPath = `orders/${ORDER}`;
const statement = (month: string, version: number) => `branch_settlements/br_${month}_v${String(version).padStart(3, '0')}`;
const versions = (month: string) => `settlement_versions/br_${month}`;
const ledgerPath = `settlement_payments/br_${M}`;
const ledger = { settledNetPaise: 21000, payments: [{ amountPaise: 21000, reference: 'recorded-once' }] };
let server: Server;
let url: string;

beforeAll(async () => {
  vi.stubEnv('BURGONOMICS_ENV', 'dev');
  server = endpoints.app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  vi.unstubAllEnvs();
});

beforeEach(() => {
  store.docs.clear(); store.writes.length = 0;
  store.fault.publication = store.fault.checkpoint = false;
  store.fault.month = '';
  store.payment.mockReset().mockResolvedValue({ id: PAY, status: 'captured', captured: true, created_at: OLD / 1000 - 60 });
  store.alert.mockReset().mockResolvedValue('alert');
  store.verify.mockReset().mockImplementation(async (role: string) => ({ uid: role, role: role === 'registry-only' ? undefined : role }));
  for (const role of ['brand_owner', 'developer', 'registry-only']) store.docs.set(`users/${role}`, { active: true });
  store.docs.set('admins/registry-only', { active: true, role: 'brand_owner' });
  store.docs.set('branches/br', { name: 'Kitchen', active: true, settlementFee: 0, createdAt: OLD - 86_400_000 });
});

function seedOrder(extra = {}) {
  store.docs.set(orderPath, {
    branchId: 'br', createdAt: OLD - 600_000, orderType: 'takeaway', status: { code: 'DELIVERED' },
    paymentChannel: 'razorpay', paymentStatus: 'completed', payment: { razorpayPaymentId: PAY, capturedAmountPaise: 21000 },
    pricing: { grandTotal: 210, split: { totalAmountPaise: 21000 } },
    captureFulfillment: { state: 'fulfillable', paymentId: PAY },
    settlementCaptureUnresolved: true, ...extra,
  });
}
function seedConflict() {
  seedOrder({ settlementEffectiveAtMs: OLD, settlementCaptureState: 'confirmed_manual', settlementCaptureUnresolved: false });
  store.docs.set(issuePath, {
    orderId: ORDER, paymentId: PAY, status: 'conflict', firstConflictAtMs: PROVIDER,
    conflict: { paymentId: PAY, manualMonthKey: M, webhookMonthKey: N, manualAtMs: OLD, webhookAtMs: PROVIDER,
      snapshotId: `capture-month-conflict-${ORDER}-${PAY}` },
  });
  const paid = { id: `br_${M}_v001`, branchId: 'br', monthKey: M, version: 1, paidStatus: 'paid', current: true, paymentReference: 'recorded-once', netPayablePaise: 21000, ledgerSchema: 1, outstandingPaise: 0, complete: true };
  store.docs.set(statement(M, 1), paid);
  store.docs.set(versions(M), { latestVersion: 1 });
  store.docs.set(ledgerPath, ledger);
  return paid;
}
function post(path: string, body: object, token: string | null = 'brand_owner') {
  return fetch(`${url}/settlements/${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
}
const reconcile = (keepMonth = N, token: string | null = 'brand_owner') => post('reconcileCaptureMonth', { orderId: ORDER, keepMonth, reason: 'Signed provider evidence' }, token);
const resolve = (extra = {}, token: string | null = 'brand_owner') => post('resolveCapture', {
  orderId: ORDER, razorpayPaymentId: PAY, capturedAtMs: OLD, reason: 'Checked dashboard', ...extra,
}, token);
const retry = () => post('retryCaptureRegeneration', { orderId: ORDER });
const pay = (version: number) => post('markPaid', { statementId: statement(M, version).split('/')[1], reference: 'settlement-adj-2026', paidOn: '2026-11-14', additionalPayment: true });

describe('capture recovery HTTP handlers', () => {
  it.each([[null, 401], ['branch_staff', 403], ['branch_owner', 403], ['franchise', 403], ['support', 403], ['registry-only', 403]])('refuses caller %s on both commands before financial writes', async (role, status) => {
    seedConflict();
    expect((await reconcile(N, role)).status).toBe(status);
    expect((await resolve({}, role)).status).toBe(status);
    expect(store.writes).toEqual([]);
    expect(store.payment).not.toHaveBeenCalled();
  });
  it('rejects a third month without changing any financial record', async () => {
    seedConflict();
    expect((await reconcile('2026-08')).status).toBe(400);
    expect(store.docs.get(issuePath).status).toBe('conflict');
    expect(audit()).toHaveLength(0);
    expect(store.payment).not.toHaveBeenCalled();
  });
  it.each(['missing', 'ambiguous', 'not_captured'])('reconciliation refuses %s payment', async kind => {
    seedConflict();
    if (kind === 'missing') seedOrder({ payment: {} });
    if (kind === 'ambiguous') store.docs.set('orders/second-order', { 'payment.razorpayPaymentId': PAY });
    if (kind === 'not_captured') store.payment.mockResolvedValue({ id: PAY, status: 'authorized', captured: false });
    expect((await reconcile()).status).toBe(400);
    expect(audit()).toHaveLength(0);
    expect(store.docs.get(issuePath).status).toBe('conflict');
    expect(store.writes.filter(p => !p.startsWith('scheduler_locks/'))).toEqual([]);
  });
  it.each([
    ['wrong id', { razorpayPaymentId: 'pay_wrong' }, {}, undefined],
    ['missing bound id', {}, { payment: {} }, undefined],
    ['ambiguous canonical/legacy', {}, { 'payment.razorpayPaymentId': 'pay_other' }, undefined],
    ['wrong channel', {}, { paymentChannel: 'cash' }, undefined],
    ['future', { capturedAtMs: Date.UTC(2099, 0, 1) }, {}, undefined],
    ['fractional', { capturedAtMs: OLD + 0.5 }, {}, undefined],
    ['before order', { capturedAtMs: OLD - 700_000 }, {}, undefined],
    ['before authorization', { capturedAtMs: OLD - 80_000 }, {}, undefined],
    ['wrong IST month', { istMonthKey: N }, {}, undefined],
    ['blank reason', { reason: ' ' }, {}, undefined],
    ['already manual', {}, { settlementCaptureState: 'confirmed_manual' }, undefined],
    ['already provider-confirmed', {}, { settlementCaptureState: 'confirmed', settlementEffectiveAtMs: OLD, settlementCaptureUnresolved: false }, undefined],
    ['not captured', {}, {}, { id: PAY, status: 'authorized', captured: false }],
  ])('manual resolution refuses %s', async (_case, body, data, payment) => {
    seedOrder(data);
    if (payment) store.payment.mockResolvedValue(payment);
    expect((await resolve(body)).status).toBe(400);
    expect(audit()).toHaveLength(0);
    expect(store.writes).toEqual([]);
  });
  it('manually resolves a legacy-bound order, audits it, and discloses it on an actual statement', async () => {
    seedOrder({ createdAt: new Date(OLD - 600_000).toISOString(), payment: { capturedAmountPaise: 21000 }, 'payment.razorpayPaymentId': PAY });
    store.docs.set(issuePath, { orderId: ORDER, paymentId: PAY, status: 'open' });
    expect((await resolve({ istMonthKey: M }, 'developer')).status).toBe(200);
    expect(store.docs.get(orderPath)).toMatchObject({ settlementCaptureState: 'confirmed_manual', settlementEffectiveAtMs: OLD, settlementCaptureUnresolved: false, settlementCreatedAtMs: OLD - 600_000 });
    expect(store.docs.get(issuePath)).toMatchObject({ status: 'resolved', closedBy: 'developer' });
    expect(audit()).toHaveLength(1);
    const generated = await post('generate', { branchId: 'br', monthKey: M });
    expect(generated.status).toBe(201);
    expect(store.docs.get(statement(M, 1)).manuallyResolvedCaptures).toEqual([ORDER]);
  });
  it.each([false, true])('moves a held paid-month order, regenerating only closed months (N closed=%s)', async closed => {
    const paid = seedConflict();
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, closed ? 11 : 10, 15));
    try { expect((await reconcile()).status).toBe(200); } finally { now.mockRestore(); }
    expect(store.docs.get(orderPath).settlementEffectiveAtMs).toBe(PROVIDER);
    expect(store.docs.get(issuePath)).toMatchObject({ status: 'resolved' });
    expect(store.docs.get(issuePath).pendingRegeneration).toBeUndefined();
    expect(audit()).toHaveLength(1);
    expect(store.docs.get(statement(M, 1))).toStrictEqual({ ...paid, current: false });
    expect(store.docs.get(ledgerPath)).toStrictEqual(ledger);
    expect(store.writes).not.toContain(ledgerPath);
    expect(store.docs.get(statement(M, 2)).outstandingPaise).toBeLessThan(0);
    expect(store.docs.has(statement(N, 1))).toBe(closed);
    if (!closed) {
      const december = vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 11, 15));
      try { expect((await post('generate', { branchId: 'br', monthKey: N })).status).toBe(201); } finally { december.mockRestore(); }
      expect(store.docs.get(statement(N, 1)).onlineCollectedPaise).toBe(21000);
    }
  });
  it('keeps the held month without touching the order, statements or ledger; replay is idempotent', async () => {
    const paid = seedConflict();
    expect((await reconcile(M)).status).toBe(200);
    expect((await reconcile(M)).status).toBe(200);
    expect(store.docs.get(issuePath).status).toBe('resolved');
    expect(store.writes).not.toContain(orderPath);
    expect(store.docs.get(statement(M, 1))).toStrictEqual(paid);
    expect(store.docs.has(statement(M, 2))).toBe(false);
    expect(audit()).toHaveLength(1);
  });
  it.each(['publication', 'checkpoint'] as const)('resumes exactly once after %s fails, with concurrent retries', async fault => {
    seedConflict(); store.fault[fault] = true;
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 10, 15));
    try {
      const result = await reconcile();
      expect(result.status).toBe(202);
      expect(store.docs.get(issuePath).pendingRegeneration).toMatchObject({ months: [M] });
      expect(store.docs.get(orderPath).settlementEffectiveAtMs).toBe(PROVIDER);
      const responses = await Promise.all([retry(), retry()]);
      expect(responses.some(r => r.status === 200)).toBe(true);
      expect((await retry()).status).toBe(200);
    } finally { now.mockRestore(); }
    expect(store.docs.get(issuePath).pendingRegeneration).toBeUndefined();
    expect(store.docs.get(versions(M)).latestVersion).toBe(2);
    expect(store.docs.has(statement(N, 1))).toBe(false);
    expect(audit()).toHaveLength(1);
    expect(store.writes.filter(p => p === orderPath)).toHaveLength(1);
  });
  it('rejects mark-paid while the branch/month marker is present, then v2 is payable after regeneration', async () => {
    const paid = { ...seedConflict(), netPayablePaise: 24_000, outstandingPaise: 3_000 };
    store.docs.set(statement(M, 1), paid);
    const marker = `settlement_capture_regeneration/br_${M}`;
    store.docs.set(marker, { branchId: 'br', monthKey: M, pending: { [ORDER]: true } });
    const initial = await pay(1);
    expect(initial.status).toBe(409);
    expect(await initial.json()).toMatchObject({ code: 'SETTLEMENT_REGENERATION_PENDING' });
    expect(store.docs.get(ledgerPath)).toStrictEqual(ledger);
    expect(store.docs.get(statement(M, 1))).toStrictEqual(paid);
    store.docs.delete(marker); // Independent marker fixture above tests the transactional guard on the base, too.
    store.fault.publication = true;
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 10, 16));
    try {
      expect((await reconcile()).status).toBe(202);
      expect(store.docs.has(marker)).toBe(true);
      expect((await pay(1)).status).toBe(409);
      expect(store.docs.get(ledgerPath)).toStrictEqual(ledger);
      expect(store.docs.get(statement(M, 1))).toStrictEqual(paid);
      expect((await retry()).status).toBe(200);
      expect(store.docs.has(marker)).toBe(false);
      expect((await pay(2)).status).toBe(200);
    } finally { now.mockRestore(); }
  });
  it('checkpoints M when N fails and the scheduler only retries N', async () => {
    seedConflict(); store.fault.publication = true; store.fault.month = N;
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 11, 15));
    try {
      expect((await reconcile()).status).toBe(202);
      expect(store.docs.get(issuePath).pendingRegeneration).toMatchObject({ months: [N] });
      expect(store.docs.has(`settlement_capture_regeneration/br_${M}`)).toBe(false);
      expect(store.docs.has(`settlement_capture_regeneration/br_${N}`)).toBe(true);
      await (endpoints as Record<string, any>).sweepStuckSettlementCapturesJob.run({});
    } finally { now.mockRestore(); }
    expect(store.docs.get(issuePath).pendingRegeneration).toBeUndefined();
    expect(store.docs.get(versions(M)).latestVersion).toBe(2);
    expect(store.docs.get(versions(N)).latestVersion).toBe(1);
  });
});

async function signedWebhook(id: string, instant: number, event = 'payment.captured') {
  const body = JSON.stringify({ event, created_at: instant / 1000, payload: { payment: { entity: {
    id: PAY, amount: 21000, currency: 'INR', order_id: 'order_local', notes: { orderId: ORDER }, created_at: OLD / 1000 - 60,
  } }, order: { entity: { id: 'order_local', amount_paid: 21000, currency: 'INR', notes: { orderId: ORDER } } } } });
  return fetch(`${url}/payments/webhook`, { method: 'POST', headers: {
    'content-type': 'application/json', 'x-razorpay-event-id': id, 'x-razorpay-signature': createHmac('sha256', SECRET).update(body).digest('hex'),
  }, body });
}

describe('signed late-webhook and scheduler handlers', () => {
  async function withSignedClock(instant: number, fn: () => Promise<void>) {
    const now = vi.spyOn(Date, 'now').mockReturnValue(instant + 1000);
    const previous = config.razorpay.webhookSecret;
    const mock = config.mock.paymentGateway;
    config.razorpay.webhookSecret = SECRET;
    config.mock.paymentGateway = false;
    try { await fn(); } finally { now.mockRestore(); config.razorpay.webhookSecret = previous; config.mock.paymentGateway = mock; }
  }
  it.each([false, true])('holds every settlement field and claims one alert across distinct concurrent signed events (delivery fails=%s)', async fail => {
    seedOrder({ settlementEffectiveAtMs: OLD, settlementCaptureState: 'confirmed_manual', settlementCaptureUnresolved: false });
    store.docs.set(issuePath, { status: 'resolved', lastAlertedAtMs: PROVIDER - 60_000 });
    const before = store.docs.get(orderPath);
    if (fail) store.alert.mockRejectedValue(new Error('No alert channel configured'));
    await withSignedClock(PROVIDER, async () => {
      const result = await Promise.all([signedWebhook('evt_one', PROVIDER), signedWebhook('evt_two', PROVIDER)]);
      expect(result.map(r => r.status)).toEqual([200, 200]);
    });
    for (const key of ['settlementEffectiveAtMs', 'settlementCaptureState', 'settlementCaptureUnresolved']) expect(store.docs.get(orderPath)[key]).toBe(before[key]);
    expect(store.docs.get(issuePath)).toMatchObject({ status: 'conflict', conflict: { manualMonthKey: M, webhookMonthKey: N } });
    const alerts = store.alert.mock.calls.filter(([, opts]) => opts?.snapshotId === `capture-month-conflict-${ORDER}-${PAY}`);
    expect(alerts).toHaveLength(1);
    expect(alerts[0][0]).toMatchObject({ severity: 'high' });
    expect(store.writes.some(p => p.startsWith('settlement_payments/') || p.startsWith('branch_settlements/'))).toBe(false);
  });
  it('manually resolves a fractional Firestore creation timestamp, then upgrades from the same-month signed event', async () => {
    seedOrder({ createdAt: { fixtureTimestampMs: OLD - 599_999.75 } });
    await withSignedClock(OLD + 60_000, async () => {
      expect((await resolve()).status).toBe(200);
      expect(store.docs.get(orderPath).settlementCreatedAtMs).toBe(OLD - 599_999);
      expect((await signedWebhook('evt_same', OLD + 60_000)).status).toBe(200);
    });
    expect(store.docs.get(orderPath)).toMatchObject({ settlementCaptureState: 'confirmed', settlementEffectiveAtMs: OLD + 60_000 });
    expect(store.docs.get(issuePath).status).toBe('resolved');
  });
  it('updates the issue only, gates reminders, and does not abort when the alert channel fails', async () => {
    seedOrder();
    const instant = PROVIDER + 36_000_000;
    const now = vi.spyOn(Date, 'now').mockReturnValue(instant);
    const before = structuredClone(store.docs.get(orderPath));
    store.alert.mockRejectedValue(new Error('No alert channel configured'));
    const tick = (endpoints as Record<string, any>).sweepStuckSettlementCapturesJob;
    try {
      expect(typeof tick?.run).toBe('function');
      await tick.run({});
      now.mockReturnValue(instant + 1_800_000);
      await tick.run({});
      now.mockReturnValue(instant + 86_400_000);
      await tick.run({});
    } finally { now.mockRestore(); }
    expect(store.docs.get(orderPath)).toStrictEqual(before);
    const issue = store.docs.get(issuePath);
    expect(issue).toMatchObject({ status: 'open', orderId: ORDER, paymentId: PAY, providerStatus: 'captured', providerCaptured: true, attempts: 3 });
    expect(store.alert.mock.calls.filter(([, opts]) => opts?.snapshotId === `capture-recovery-issue-${ORDER}`)).toHaveLength(2);
  });
  it('a signed webhook wins while the manual provider fetch is in flight', async () => {
    seedOrder();
    await withSignedClock(PROVIDER, async () => {
      let finish!: () => void;
      let started!: () => void;
      const fetching = new Promise<void>(r => { started = r; });
      store.payment.mockImplementationOnce(() => { started(); return new Promise(r => { finish = () => r({ id: PAY, status: 'captured', captured: true, created_at: OLD / 1000 - 60 }); }); });
      // The base has no admin endpoint: assert that it is installed without
      // waiting forever for a provider read that will never be made.
      const pending = resolve();
      expect(await Promise.race([fetching.then(() => true), pending.then(() => false)])).toBe(true);
      try { expect((await signedWebhook('evt_race', PROVIDER)).status).toBe(200); } finally { finish(); }
      expect((await pending).status).toBe(400);
    });
    expect(store.docs.get(orderPath)).toMatchObject({ settlementCaptureState: 'confirmed', settlementEffectiveAtMs: PROVIDER });
    expect(audit()).toHaveLength(0);
  });
  it('a signed webhook that arrives after the manual transaction opens the conflict rather than moving the order', async () => {
    seedOrder();
    await withSignedClock(PROVIDER, async () => {
      expect((await resolve()).status).toBe(200);
      expect((await signedWebhook('evt_after_manual', PROVIDER)).status).toBe(200);
    });
    expect(store.docs.get(orderPath)).toMatchObject({ settlementCaptureState: 'confirmed_manual', settlementEffectiveAtMs: OLD });
    expect(store.docs.get(issuePath).status).toBe('conflict');
    expect(audit()).toHaveLength(1);
  });
});
