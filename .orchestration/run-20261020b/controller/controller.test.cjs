'use strict';

/**
 * Mock-only tests for the delivery-queue controller. No network, no real
 * sessions: the opencode API, clock, and persistence hook are injected.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  PHASE,
  DEFAULTS,
  buildPlan,
  runOnce,
  acquireLock,
  writeJsonAtomic,
  parseSupervisorState,
  hasCorrelation,
  clampBackoff,
  validateQueue,
  validateState,
  resolveService,
  assertActiveMap,
  isLoopbackHost,
} = require('./controller.cjs');

const ROOT = 'C:/Users/DELL/Desktop/Burgonomics';
const OWNER = 'ses_ea5c88140ffeqstoAT9sWrRWFE';
const QA = 'ses_ea5c87413ffeBOyHpHeVPuHIoW';
const MAIN = 'ses_ec0542be0ffemk4j2yKN0lXQnI';
const NOW = 1792600000000;
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

function baseItem(overrides) {
  return {
    id: 'ticket-rules-mask',
    phase: 'owner',
    ownerSessionID: OWNER,
    qaSessionID: QA,
    rootRepo: ROOT,
    packetContext: {
      runId: 'run-20261020b',
      brief: '.orchestration/run-20261020b/lane-07.md',
      contract: '.orchestration/run-20261020b/CONTRACT.md',
      evidenceDir: '.orchestration/run-20261020b/evidence/lane-07',
      committed: { root: '0cca973', customer: '9c5ecc1', partner: '8a59244' },
      note: 'Ticket-mask fix is already committed; reconcile it and check QA evidence instead of reimplementing.',
    },
    ...overrides,
  };
}

function baseQueue(overrides) {
  return {
    runId: 'run-20261020b',
    enabled: true,
    rootRepo: ROOT,
    mainSessionID: MAIN,
    limits: { ...DEFAULTS },
    items: [baseItem()],
    ...overrides,
  };
}

function session(id, model, extra) {
  return {
    id,
    model: model || { providerID: 'opencode', id: 'deepseek-v4.1-flash-free' },
    outcome: 'idle',
    time: { created: NOW - HOUR, updated: NOW - MINUTE, idle: NOW - MINUTE },
    location: { directory: ROOT },
    ...extra,
  };
}

function assistant(id, created, text, extra) {
  return {
    id,
    type: 'assistant',
    time: { created },
    model: { providerID: 'opencode', id: 'glm-5.3-flash-free' },
    content: text == null ? [] : [{ type: 'text', text }],
    ...extra,
  };
}

const MARKER = 'QUEUE_TASK: ticket-rules-mask';
const completeText = (body) => `${body || 'Done.'}\n${MARKER}\nSUPERVISOR_STATE: COMPLETE`;
const blockedText = (reason) => `Stopped.\n${MARKER}\nSUPERVISOR_STATE: EXTERNAL_BLOCK ${reason}`;

function emptyState() {
  return { version: 1, items: {}, totalAttempts: 0, totalDeliveries: 0 };
}

function stateFor(phase, overrides) {
  return {
    version: 1,
    items: {
      'ticket-rules-mask': {
        phase,
        attempts: 1,
        deliveries: 1,
        lastSentAt: NOW - HOUR,
        lastSentPhase: phase,
        lastDeliveryAt: NOW - HOUR,
        consumedMessageIds: [],
        ...overrides,
      },
    },
    totalAttempts: 1,
    totalDeliveries: 1,
  };
}

function mockApi({ active = {}, sessions = {}, messages = {}, post } = {}) {
  const calls = { active: 0, session: [], messages: [], post: [] };
  return {
    calls,
    async getActive() {
      calls.active += 1;
      return active;
    },
    async getSession(id) {
      calls.session.push(id);
      return sessions[id] || session(id);
    },
    async getMessages(id, query) {
      calls.messages.push({ id, query });
      return messages[id] || [];
    },
    async postSynthetic(id, body) {
      calls.post.push({ id, body });
      return post ? post(id, body) : { status: 200 };
    },
  };
}

function plan(queue, api, state) {
  return buildPlan({ now: NOW, queue, state: state || emptyState(), api, mode: 'dry-run' });
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'burg-queue-'));
}

function runOptions(dir, api, extra) {
  return {
    mode: 'apply',
    now: NOW,
    queuePath: path.join(dir, 'queue.json'),
    statePath: path.join(dir, 'state.json'),
    lockPath: path.join(dir, 'controller.lock'),
    statusPath: path.join(dir, 'status.json'),
    eventsPath: path.join(dir, 'events.log'),
    api,
    ...extra,
  };
}

/* ------------------------------------------------------- correlation/state */

test('only the canonical final state line counts, and quoted COMPLETE is ignored', () => {
  assert.equal(parseSupervisorState('work\nSUPERVISOR_STATE: COMPLETE'), 'COMPLETE');
  assert.equal(parseSupervisorState('work\r\nSUPERVISOR_STATE: EXTERNAL_BLOCK no secret\r\n'), 'EXTERNAL_BLOCK');
  assert.equal(parseSupervisorState('SUPERVISOR_STATE: "COMPLETE"'), null);
  assert.equal(parseSupervisorState('SUPERVISOR_STATE: COMPLETE\nfollow-up text'), null);
  assert.equal(parseSupervisorState('inline SUPERVISOR_STATE: COMPLETE only'), null);
  assert.equal(parseSupervisorState('SUPERVISOR_STATE: WAITING_REVIEW'), null);
  assert.equal(parseSupervisorState(''), null);
});

test('task correlation marker is required and matched exactly', () => {
  assert.equal(hasCorrelation('x\nQUEUE_TASK: ticket-rules-mask\nSUPERVISOR_STATE: COMPLETE', 'ticket-rules-mask'), true);
  assert.equal(hasCorrelation('QUEUE_TASK:ticket-rules-mask', 'ticket-rules-mask'), true);
  assert.equal(hasCorrelation('QUEUE_TASK: other-item', 'ticket-rules-mask'), false);
  assert.equal(hasCorrelation('QUEUE_TASK: ticket-rules-mask-extra', 'ticket-rules-mask'), false);
  assert.equal(hasCorrelation('nothing', 'ticket-rules-mask'), false);
});

/* -------------------------------------------------------------- tick cases */

test('a busy session is never woken or interrupted', async () => {
  const api = mockApi({
    active: { [OWNER]: { type: 'running' } },
    sessions: { [OWNER]: session(OWNER) },
    messages: { [OWNER]: [assistant('m1', NOW - MINUTE, 'still working')] },
  });

  const result = await plan(baseQueue(), api);

  assert.equal(result.status.decision, 'session_active');
  assert.equal(result.status.executing, true);
  assert.equal(result.status.idle, false);
  assert.equal(result.delivery, undefined);
  assert.equal(api.calls.post.length, 0);
});

test('provider 429 on the latest assistant message backs off at least 30 minutes', async () => {
  const errorMessage = assistant('e1', NOW - 1000, '', {
    error: { type: 'provider.rate_limit', message: 'Too many requests', status: 429 },
  });
  const api = mockApi({ sessions: { [OWNER]: session(OWNER) }, messages: { [OWNER]: [errorMessage] } });

  const first = await plan(baseQueue(), api);
  assert.equal(first.status.decision, 'backoff_wait');
  assert.equal(first.status.providerError.status, 429);
  assert.ok(Date.parse(first.status.retryAt) - (NOW - 1000) >= DEFAULTS.minBackoffMs);
  assert.equal(first.delivery, undefined);

  const tooEarly = await buildPlan({ now: NOW + 20 * MINUTE, queue: baseQueue(), state: first.state, api: mockApi({ sessions: { [OWNER]: session(OWNER) }, messages: { [OWNER]: [errorMessage] } }), mode: 'dry-run' });
  assert.equal(tooEarly.status.decision, 'backoff_wait');
  assert.equal(tooEarly.delivery, undefined);

  const lateApi = mockApi({ sessions: { [OWNER]: session(OWNER) }, messages: { [OWNER]: [errorMessage] } });
  const after = await buildPlan({ now: NOW + 31 * MINUTE, queue: baseQueue(), state: first.state, api: lateApi, mode: 'dry-run' });
  assert.equal(after.status.decision, 'initial_delivery');
  assert.ok(after.delivery);

  assert.equal(clampBackoff(1, DEFAULTS), 30 * MINUTE);
  assert.equal(clampBackoff(2, DEFAULTS), 60 * MINUTE);
  assert.equal(clampBackoff(9, DEFAULTS), 4 * HOUR);
});

test('a persisted retryAt blocks POSTs even with no assistant error', async () => {
  const state = stateFor(PHASE.OWNER, { retryAt: NOW + 10 * MINUTE, lastSentAt: NOW - 5 * MINUTE });
  const api = mockApi({ sessions: { [OWNER]: session(OWNER) }, messages: { [OWNER]: [assistant('m1', NOW - MINUTE, 'progress')] } });

  const result = await plan(baseQueue(), api, state);

  assert.equal(result.status.decision, 'backoff_wait');
  assert.equal(result.delivery, undefined);
  assert.equal(Date.parse(result.status.retryAt), NOW + 10 * MINUTE);
});

test('POST 429 charges an attempt, persists retryAt, and is not retried early', async () => {
  const dir = tempDir();
  try {
    fs.writeFileSync(path.join(dir, 'queue.json'), JSON.stringify(baseQueue()));
    const api = mockApi({ sessions: { [OWNER]: session(OWNER) }, messages: { [OWNER]: [] }, post: () => ({ status: 429 }) });

    const first = await runOnce(runOptions(dir, api));
    assert.equal(api.calls.post.length, 1);
    assert.equal(first.status.decision, 'backoff_wait');
    assert.equal(first.status.needsAttention, false);

    const persisted = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
    assert.equal(persisted.items['ticket-rules-mask'].attempts, 1); // charged before POST
    assert.equal(persisted.totalAttempts, 1);
    assert.equal(persisted.items['ticket-rules-mask'].reservation, null);
    assert.ok(persisted.items['ticket-rules-mask'].retryAt >= NOW + DEFAULTS.minBackoffMs);

    const earlyApi = mockApi({ sessions: { [OWNER]: session(OWNER) }, messages: { [OWNER]: [] } });
    const early = await runOnce(runOptions(dir, earlyApi, { now: NOW + 20 * MINUTE }));
    assert.equal(earlyApi.calls.post.length, 0);
    assert.equal(early.status.decision, 'backoff_wait');

    const lateApi = mockApi({ sessions: { [OWNER]: session(OWNER) }, messages: { [OWNER]: [] } });
    const late = await runOnce(runOptions(dir, lateApi, { now: NOW + 31 * MINUTE }));
    assert.equal(lateApi.calls.post.length, 1);
    assert.equal(late.status.decision, 'delivered_awaiting_evidence');
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).items['ticket-rules-mask'].attempts, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('attempt caps are finite per item and per run', async () => {
  const api = mockApi({ sessions: { [OWNER]: session(OWNER) }, messages: { [OWNER]: [] } });

  const perItem = await plan(baseQueue(), api, stateFor(PHASE.OWNER, { attempts: 6, lastSentAt: NOW - HOUR }));
  assert.equal(perItem.status.decision, 'needs_attention');
  assert.equal(perItem.status.attention.reason, 'continuation_cap_reached');

  const perRun = await plan(baseQueue(), api, { version: 1, items: {}, totalAttempts: 12, totalDeliveries: 0 });
  assert.equal(perRun.status.decision, 'needs_attention');
  assert.equal(perRun.status.attention.reason, 'attempt_budget_exhausted');
  assert.equal(perRun.delivery, undefined);

  const busy = await plan(
    baseQueue(),
    mockApi({ active: { [OWNER]: { type: 'running' } }, sessions: { [OWNER]: session(OWNER) } }),
    stateFor(PHASE.OWNER, { attempts: 6 }),
  );
  assert.equal(busy.status.executing, true);
});

test('continuations repeat every 15 idle minutes until the cap, then need attention', async () => {
  const api = mockApi({ sessions: { [OWNER]: session(OWNER) }, messages: { [OWNER]: [] } });

  const due = await plan(baseQueue(), api, stateFor(PHASE.OWNER, { attempts: 2, lastSentAt: NOW - 16 * MINUTE }));
  assert.equal(due.status.decision, 'idle_continuation');
  assert.equal(due.delivery.kind, 'continuation');
  assert.equal(due.status.planned.attempt, 3);

  const tooSoon = await plan(baseQueue(), api, stateFor(PHASE.OWNER, { attempts: 2, lastSentAt: NOW - 5 * MINUTE }));
  assert.equal(tooSoon.status.decision, 'awaiting_evidence');

  const capped = await plan(baseQueue(), api, stateFor(PHASE.OWNER, { attempts: 6, lastSentAt: NOW - 16 * MINUTE }));
  assert.equal(capped.status.decision, 'needs_attention');
  assert.equal(capped.status.attention.reason, 'continuation_cap_reached');
  assert.equal(capped.delivery, undefined);
});

test('a non-allowed worker model and a wrong root stop the item', async () => {
  const paid = { providerID: 'openai', id: 'gpt-6.1-sol' };
  const worker = await plan(baseQueue(), mockApi({ sessions: { [OWNER]: session(OWNER, paid) }, messages: { [OWNER]: [] } }));
  assert.equal(worker.status.decision, 'needs_attention');
  assert.equal(worker.status.attention.reason, 'worker_model_not_allowed');
  assert.equal(worker.delivery, undefined);

  const wrongRoot = await plan(baseQueue(), mockApi({ sessions: { [OWNER]: session(OWNER, null, { location: { directory: 'C:/tmp/elsewhere' } }) }, messages: { [OWNER]: [] } }));
  assert.equal(wrongRoot.status.decision, 'needs_attention');
  assert.equal(wrongRoot.status.attention.reason, 'root_mismatch');
});

test('EXTERNAL_BLOCK is honoured only when fresh, correlated, and unconsumed', async () => {
  const honoured = await plan(
    baseQueue(),
    mockApi({ sessions: { [OWNER]: session(OWNER) }, messages: { [OWNER]: [assistant('b1', NOW - MINUTE, blockedText('missing webhook secret'))] } }),
    stateFor(PHASE.OWNER),
  );
  assert.equal(honoured.status.decision, 'external_block');
  assert.equal(honoured.state.items['ticket-rules-mask'].phase, PHASE.EXTERNAL_BLOCK);
  assert.deepEqual(honoured.state.items['ticket-rules-mask'].consumedMessageIds, ['b1']);

  const noMarker = await plan(
    baseQueue(),
    mockApi({ sessions: { [OWNER]: session(OWNER) }, messages: { [OWNER]: [assistant('b2', NOW - MINUTE, 'SUPERVISOR_STATE: EXTERNAL_BLOCK reason')] } }),
    stateFor(PHASE.OWNER, { lastSentAt: NOW - 5 * MINUTE }),
  );
  assert.equal(noMarker.status.decision, 'progress_observed');
  assert.equal(noMarker.state.items['ticket-rules-mask'].phase, PHASE.OWNER);

  const stale = await plan(
    baseQueue(),
    mockApi({ sessions: { [OWNER]: session(OWNER) }, messages: { [OWNER]: [assistant('b3', NOW - HOUR, blockedText('old'))] } }),
    stateFor(PHASE.OWNER, { lastSentAt: NOW - MINUTE }),
  );
  assert.equal(stale.status.decision, 'awaiting_evidence');
  assert.equal(stale.state.items['ticket-rules-mask'].phase, PHASE.OWNER);
});

test('owner COMPLETE advances to QA only with a fresh correlated message, consuming its id', async () => {
  const api = mockApi({
    sessions: { [OWNER]: session(OWNER), [QA]: session(QA) },
    messages: { [OWNER]: [assistant('c1', NOW - MINUTE, completeText('Committed.'))], [QA]: [] },
  });

  const result = await plan(baseQueue(), api, stateFor(PHASE.OWNER));

  assert.equal(result.status.decision, 'owner_complete_to_qa');
  assert.equal(result.status.phase, PHASE.QA);
  assert.equal(result.delivery.sessionID, QA);
  assert.equal(result.state.items['ticket-rules-mask'].phase, PHASE.QA);
  assert.deepEqual(result.state.items['ticket-rules-mask'].consumedMessageIds, ['c1']);
});

test('old, uncorrelated, or consumed COMPLETE never advances (no old QA COMPLETE)', async () => {
  const messages = { [QA]: [assistant('old-qa', NOW - HOUR, completeText('old'))] };

  const stale = await plan(
    baseQueue(),
    mockApi({ sessions: { [QA]: session(QA) }, messages }),
    stateFor(PHASE.QA, { lastSentAt: NOW - MINUTE }),
  );
  assert.equal(stale.status.decision, 'awaiting_evidence');
  assert.equal(stale.state.items['ticket-rules-mask'].phase, PHASE.QA);

  const uncorrelated = await plan(
    baseQueue(),
    mockApi({ sessions: { [QA]: session(QA) }, messages: { [QA]: [assistant('q1', NOW - MINUTE, 'SUPERVISOR_STATE: COMPLETE')] } }),
    stateFor(PHASE.QA, { lastSentAt: NOW - 5 * MINUTE }),
  );
  assert.equal(uncorrelated.status.decision, 'progress_observed');
  assert.equal(uncorrelated.status.signal.correlated, false);
  assert.equal(uncorrelated.state.items['ticket-rules-mask'].phase, PHASE.QA);

  const consumed = await plan(
    baseQueue(),
    mockApi({ sessions: { [QA]: session(QA) }, messages: { [QA]: [assistant('q2', NOW - MINUTE, completeText('done'))] } }),
    stateFor(PHASE.QA, { lastSentAt: NOW - 5 * MINUTE, consumedMessageIds: ['q2'] }),
  );
  assert.equal(consumed.status.decision, 'progress_observed');
  assert.equal(consumed.status.signal.consumed, true);
  assert.equal(consumed.state.items['ticket-rules-mask'].phase, PHASE.QA);
});

test('QA COMPLETE plans one Main notification and is never auto-accepted', async () => {
  const api = mockApi({
    sessions: { [QA]: session(QA), [MAIN]: session(MAIN) },
    messages: { [QA]: [assistant('q1', NOW - MINUTE, completeText('Verified.'))] },
  });

  const result = await plan(baseQueue(), api, stateFor(PHASE.QA));

  assert.equal(result.status.decision, 'qa_complete_awaiting_main');
  assert.equal(result.status.phase, PHASE.AWAITING_MAIN);
  assert.equal(result.delivery.sessionID, MAIN);
  assert.equal(result.delivery.kind, 'main_acceptance_notification');
  assert.match(result.delivery.text, /main acceptance required/);
  assert.match(result.delivery.text, /QUEUE_TASK: ticket-rules-mask/);
  assert.equal(result.state.items['ticket-rules-mask'].phase, PHASE.QA); // durable only after send
  assert.notEqual(result.state.items['ticket-rules-mask'].phase, PHASE.ACCEPTED);
});

test('main is notified exactly once across restart, attempts counted, never auto-accepted', async () => {
  const dir = tempDir();
  try {
    fs.writeFileSync(path.join(dir, 'queue.json'), JSON.stringify(baseQueue()));
    writeJsonAtomic(path.join(dir, 'state.json'), stateFor(PHASE.QA));
    const api = mockApi({
      sessions: { [QA]: session(QA), [MAIN]: session(MAIN, { providerID: 'openai', id: 'gpt-6.1-sol' }) },
      messages: { [QA]: [assistant('q1', NOW - MINUTE, completeText('Verified.'))] },
    });

    const first = await runOnce(runOptions(dir, api));
    assert.equal(api.calls.post.length, 1);
    assert.equal(api.calls.post[0].id, MAIN);
    assert.equal(first.status.decision, 'awaiting_main_acceptance');
    assert.equal(first.status.phase, PHASE.AWAITING_MAIN);
    assert.equal(first.status.evidencePending, false);

    const persisted = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
    const item = persisted.items['ticket-rules-mask'];
    assert.equal(item.phase, PHASE.AWAITING_MAIN);
    assert.equal(item.attempts, 2);
    assert.equal(item.deliveries, 2);
    assert.equal(persisted.totalAttempts, 2);
    assert.equal(persisted.totalDeliveries, 2);
    assert.ok(item.mainNotifiedAt);
    assert.deepEqual(item.consumedMessageIds, ['q1']);
    assert.equal(fs.readFileSync(path.join(dir, 'events.log'), 'utf8').trim().split('\n').length, 1);

    const secondApi = mockApi({
      sessions: { [QA]: session(QA), [MAIN]: session(MAIN) },
      messages: { [QA]: [assistant('q1', NOW - MINUTE, completeText('Verified.'))] },
    });
    const second = await runOnce(runOptions(dir, secondApi, { now: NOW + 5 * MINUTE }));
    assert.equal(secondApi.calls.post.length, 0);
    assert.equal(secondApi.calls.active, 0);
    assert.equal(second.status.decision, 'awaiting_main_acceptance');
    assert.equal(fs.readFileSync(path.join(dir, 'events.log'), 'utf8').trim().split('\n').length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('awaiting main acceptance holds the queue and never advances the next item', async () => {
  const queue = baseQueue({
    items: [
      baseItem(),
      { id: 'second-item', phase: 'owner', ownerSessionID: 'ses_secondowner001', qaSessionID: 'ses_secondqa00001', rootRepo: ROOT, packetContext: {} },
    ],
  });
  const state = stateFor(PHASE.AWAITING_MAIN, { mainNotifiedAt: NOW - MINUTE });
  const api = mockApi();

  const result = await plan(queue, api, state);

  assert.equal(result.status.decision, 'awaiting_main_acceptance');
  assert.equal(result.status.itemId, 'ticket-rules-mask');
  assert.equal(api.calls.active, 0);
  assert.equal(result.state.items['second-item'], undefined);
});

test('a paid worker model is still rejected while the Main notification is exempt', async () => {
  const paid = { providerID: 'openai', id: 'gpt-6.1-sol' };
  const worker = await plan(baseQueue(), mockApi({ sessions: { [OWNER]: session(OWNER, paid) }, messages: { [OWNER]: [] } }));
  assert.equal(worker.status.decision, 'needs_attention');
  assert.equal(worker.status.attention.reason, 'worker_model_not_allowed');

  const main = await plan(
    baseQueue(),
    mockApi({ sessions: { [QA]: session(QA), [MAIN]: session(MAIN, paid) }, messages: { [QA]: [assistant('q1', NOW - MINUTE, completeText('ok'))] } }),
    stateFor(PHASE.QA),
  );
  assert.equal(main.status.decision, 'qa_complete_awaiting_main');
  assert.equal(main.delivery.sessionID, MAIN);
});

test('the Main notification obeys the same attempt budget', async () => {
  const api = mockApi({
    sessions: { [QA]: session(QA), [MAIN]: session(MAIN) },
    messages: { [QA]: [assistant('q1', NOW - MINUTE, completeText('ok'))] },
  });

  const result = await plan(baseQueue(), api, stateFor(PHASE.QA, { attempts: 6 }));

  assert.equal(result.status.decision, 'needs_attention');
  assert.equal(result.status.attention.reason, 'notification_budget_exhausted');
  assert.equal(result.delivery, undefined);
  assert.equal(api.calls.post.length, 0);
});

test('only one item is active at a time and the second is untouched', async () => {
  const queue = baseQueue({
    items: [
      baseItem(),
      { id: 'second-item', phase: 'owner', ownerSessionID: 'ses_secondowner001', qaSessionID: 'ses_secondqa00001', rootRepo: ROOT, packetContext: {} },
    ],
  });
  const api = mockApi({
    sessions: { [OWNER]: session(OWNER), [QA]: session(QA), ses_secondowner001: session('ses_secondowner001') },
    messages: { [OWNER]: [assistant('c1', NOW - MINUTE, completeText('done'))], [QA]: [] },
  });

  const result = await plan(queue, api, stateFor(PHASE.OWNER));

  assert.equal(result.status.itemId, 'ticket-rules-mask');
  assert.equal(result.delivery.sessionID, QA);
  assert.equal(api.calls.session.includes('ses_secondowner001'), false);
  assert.equal(result.state.items['second-item'], undefined);
});

/* ---------------------------------------------------------- apply / failure */

test('dry-run reads the API but writes nothing, charges no attempt, and never posts', async () => {
  const dir = tempDir();
  try {
    fs.writeFileSync(path.join(dir, 'queue.json'), JSON.stringify(baseQueue()));
    const api = mockApi({ sessions: { [OWNER]: session(OWNER) }, messages: { [OWNER]: [] } });

    const result = await runOnce(runOptions(dir, api, { mode: 'dry-run' }));

    assert.equal(result.status.decision, 'initial_delivery');
    assert.equal(result.status.planned.attempt, 1);
    assert.equal(result.wrote, false);
    assert.equal(api.calls.post.length, 0);
    assert.deepEqual(fs.readdirSync(dir), ['queue.json']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('disabled queue writes nothing even with --apply', async () => {
  const dir = tempDir();
  try {
    fs.writeFileSync(path.join(dir, 'queue.json'), JSON.stringify(baseQueue({ enabled: false })));
    const api = mockApi();

    const result = await runOnce(runOptions(dir, api));

    assert.equal(result.status.decision, 'disabled');
    assert.deepEqual(fs.readdirSync(dir), ['queue.json']);
    assert.equal(api.calls.active, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('apply charges the attempt and writes the reservation before POST, then does not duplicate', async () => {
  const dir = tempDir();
  try {
    const queuePath = path.join(dir, 'queue.json');
    const statePath = path.join(dir, 'state.json');
    fs.writeFileSync(queuePath, JSON.stringify(baseQueue()));

    let seenPending = null;
    const api = mockApi({
      sessions: { [OWNER]: session(OWNER) },
      messages: { [OWNER]: [] },
      post: () => {
        const persisted = JSON.parse(fs.readFileSync(statePath, 'utf8'));
        seenPending = persisted.items['ticket-rules-mask'];
        return { status: 200 };
      },
    });

    const first = await runOnce(runOptions(dir, api));

    assert.equal(seenPending.attempts, 1);
    assert.equal(seenPending.reservation.status, 'pending');
    assert.equal(api.calls.post.length, 1);
    assert.deepEqual(api.calls.post[0].body.delivery, 'queue');
    assert.equal(first.status.decision, 'delivered_awaiting_evidence');
    assert.equal(first.status.evidencePending, true);

    const persisted = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(persisted.items['ticket-rules-mask'].attempts, 1);
    assert.equal(persisted.items['ticket-rules-mask'].deliveries, 1);
    assert.equal(persisted.totalAttempts, 1);
    assert.equal(persisted.totalDeliveries, 1);
    assert.equal(persisted.items['ticket-rules-mask'].reservation.status, 'sent');

    const secondApi = mockApi({ sessions: { [OWNER]: session(OWNER) }, messages: { [OWNER]: [] } });
    const second = await runOnce(runOptions(dir, secondApi, { now: NOW + MINUTE }));
    assert.equal(secondApi.calls.post.length, 0);
    assert.equal(second.status.decision, 'awaiting_evidence');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a reservation write failure fails closed: no POST and the old state is retained', async () => {
  const dir = tempDir();
  try {
    const statePath = path.join(dir, 'state.json');
    fs.writeFileSync(path.join(dir, 'queue.json'), JSON.stringify(baseQueue()));
    const oldState = stateFor(PHASE.OWNER);
    writeJsonAtomic(statePath, oldState);

    const api = mockApi({ sessions: { [OWNER]: session(OWNER) }, messages: { [OWNER]: [] } });
    const failingPersist = () => {
      throw new Error('disk full');
    };

    const result = await runOnce(runOptions(dir, api, { persistState: failingPersist }));

    assert.equal(api.calls.post.length, 0);
    assert.equal(result.status.decision, 'state_write_failed');
    assert.equal(result.status.attention.stage, 'reservation');
    assert.equal(result.exitCode, 3);
    assert.deepEqual(JSON.parse(fs.readFileSync(statePath, 'utf8')), oldState);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a post-send persist failure keeps the pending reservation and never resends', async () => {
  const dir = tempDir();
  try {
    const statePath = path.join(dir, 'state.json');
    fs.writeFileSync(path.join(dir, 'queue.json'), JSON.stringify(baseQueue()));
    const api = mockApi({ sessions: { [OWNER]: session(OWNER) }, messages: { [OWNER]: [] } });

    let calls = 0;
    const failingSecondPersist = (file, value) => {
      calls += 1;
      if (calls === 1) return writeJsonAtomic(file, value);
      throw new Error('rename failed');
    };

    const result = await runOnce(runOptions(dir, api, { persistState: failingSecondPersist }));
    assert.equal(api.calls.post.length, 1);
    assert.equal(result.status.decision, 'state_write_failed');
    assert.equal(result.status.attention.stage, 'post_send');

    const persisted = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(persisted.items['ticket-rules-mask'].reservation.status, 'pending');

    const retryApi = mockApi({ sessions: { [OWNER]: session(OWNER) }, messages: { [OWNER]: [] } });
    const retry = await runOnce(runOptions(dir, retryApi, { now: NOW + MINUTE }));
    assert.equal(retryApi.calls.post.length, 0);
    assert.equal(retry.status.decision, 'needs_attention');
    assert.equal(retry.status.attention.reason, 'unresolved_delivery');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('crash or unknown POST outcome becomes needs_attention and is never resent', async () => {
  const dir = tempDir();
  try {
    const statePath = path.join(dir, 'state.json');
    fs.writeFileSync(path.join(dir, 'queue.json'), JSON.stringify(baseQueue()));

    const failingApi = mockApi({
      sessions: { [OWNER]: session(OWNER) },
      messages: { [OWNER]: [] },
      post: () => {
        throw new Error('socket hang up');
      },
    });

    const first = await runOnce(runOptions(dir, failingApi));
    assert.equal(first.status.decision, 'needs_attention');
    assert.equal(first.status.attention.reason, 'delivery_uncertain');
    assert.equal(first.exitCode, 3);

    const persisted = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(persisted.items['ticket-rules-mask'].reservation.status, 'pending');
    assert.equal(persisted.items['ticket-rules-mask'].attempts, 1);

    const retryApi = mockApi({ sessions: { [OWNER]: session(OWNER) }, messages: { [OWNER]: [] } });
    const second = await runOnce(runOptions(dir, retryApi, { now: NOW + MINUTE }));
    assert.equal(retryApi.calls.post.length, 0);
    assert.equal(second.status.decision, 'needs_attention');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an observation failure after a sent POST does not lose the delivery', async () => {
  const dir = tempDir();
  try {
    const statePath = path.join(dir, 'state.json');
    fs.writeFileSync(path.join(dir, 'queue.json'), JSON.stringify(baseQueue()));

    const api = mockApi({ sessions: { [OWNER]: session(OWNER) }, messages: { [OWNER]: [] } });
    let posted = false;
    api.postSynthetic = async (id, body) => {
      api.calls.post.push({ id, body });
      posted = true;
      return { status: 200 };
    };
    const originalActive = api.getActive;
    const originalSession = api.getSession;
    api.getActive = async () => {
      if (posted) throw new Error('observation down');
      return originalActive();
    };
    api.getSession = async (id) => {
      if (posted) throw new Error('observation down');
      return originalSession(id);
    };

    const result = await runOnce(runOptions(dir, api));

    assert.equal(api.calls.post.length, 1);
    assert.equal(result.status.decision, 'delivered_awaiting_evidence');
    assert.equal(result.status.observation, 'unavailable');
    assert.equal(result.status.executing, null);
    assert.equal(result.status.idle, null);
    assert.equal(result.status.needsAttention, false);

    const persisted = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(persisted.items['ticket-rules-mask'].reservation.status, 'sent');
    assert.equal(persisted.items['ticket-rules-mask'].deliveries, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('queue and state validation runs before any API call or POST', async () => {
  const badRoot = await plan(baseQueue({ rootRepo: 'relative/path' }), mockApi());
  assert.equal(badRoot.status.decision, 'invalid_config');

  const duplicate = await plan(baseQueue({ items: [baseItem(), baseItem()] }), mockApi());
  assert.equal(duplicate.status.decision, 'invalid_config');
  assert.match(duplicate.status.error, /duplicate item id/);

  const badOwner = await plan(baseQueue({ items: [baseItem({ ownerSessionID: 'owner' })] }), mockApi());
  assert.equal(badOwner.status.decision, 'invalid_config');

  const badPhase = await plan(baseQueue({ items: [baseItem({ phase: 'done' })] }), mockApi());
  assert.equal(badPhase.status.decision, 'invalid_config');

  const badLimits = await plan(baseQueue({ limits: { ...DEFAULTS, perItemDeliveries: 0 } }), mockApi());
  assert.equal(badLimits.status.decision, 'invalid_config');

  const api = mockApi();
  const badState = await plan(baseQueue(), api, stateFor(PHASE.OWNER, { phase: 'bogus' }));
  assert.equal(badState.status.decision, 'invalid_state');
  assert.equal(api.calls.active, 0);

  assert.equal(validateQueue(baseQueue()), null);
  assert.equal(validateState(emptyState()), null);
});

test('a failed phase-entry delivery is retried as the phase prompt, not a continuation', async () => {
  const api = mockApi({ sessions: { [QA]: session(QA) }, messages: { [QA]: [] } });

  const result = await plan(baseQueue(), api, stateFor(PHASE.QA, { lastSentAt: NOW - HOUR, lastSentPhase: PHASE.OWNER }));

  assert.equal(result.status.decision, 'qa_verification_delivery');
  assert.equal(result.delivery.kind, 'qa_verification');
  assert.equal(result.delivery.sessionID, QA);
});

test('an older state without attempts preserves the budget from deliveries', async () => {
  const api = mockApi({ sessions: { [OWNER]: session(OWNER) }, messages: { [OWNER]: [] } });
  const legacy = {
    version: 1,
    items: { 'ticket-rules-mask': { phase: PHASE.OWNER, deliveries: 5, lastSentAt: NOW - 5 * MINUTE, lastSentPhase: PHASE.OWNER } },
    totalDeliveries: 5,
  };

  const result = await plan(baseQueue(), api, legacy);

  assert.equal(result.status.budget.attempts, 5);
  assert.equal(result.status.decision, 'awaiting_evidence');
});

/* ------------------------------------------------------------------- lease */

test('the lease never steals a live PID and reclaims only a stale dead one', () => {
  const dir = tempDir();
  try {
    const lockPath = path.join(dir, 'controller.lock');

    const first = acquireLock(lockPath, NOW);
    assert.equal(first.acquired, true);
    assert.equal(acquireLock(lockPath, NOW + 1000).acquired, false);
    first.release();
    assert.equal(fs.existsSync(lockPath), false);

    fs.writeFileSync(lockPath, JSON.stringify({ token: 'dead', pid: 999999, createdAt: new Date(NOW - 2 * HOUR).toISOString() }));
    const recovered = acquireLock(lockPath, NOW);
    assert.equal(recovered.acquired, true);
    recovered.release();

    fs.writeFileSync(lockPath, JSON.stringify({ token: 'young', pid: 999999, createdAt: new Date(NOW).toISOString() }));
    const young = acquireLock(lockPath, NOW);
    assert.equal(young.acquired, false);
    assert.equal(young.reason, 'dead_lock_too_young');

    fs.writeFileSync(lockPath, JSON.stringify({ token: 'live', pid: process.pid, createdAt: new Date(NOW - 2 * HOUR).toISOString() }));
    const live = acquireLock(lockPath, NOW);
    assert.equal(live.acquired, false);
    assert.equal(live.reason, 'live_lock_stale');
    assert.equal(live.attention, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runOnce reports lock-held as a heartbeat and stale-live locks as attention', async () => {
  const dir = tempDir();
  try {
    fs.writeFileSync(path.join(dir, 'queue.json'), JSON.stringify(baseQueue()));
    fs.writeFileSync(path.join(dir, 'controller.lock'), JSON.stringify({ token: 'live', pid: process.pid, createdAt: new Date(NOW).toISOString() }));
    const api = mockApi();

    const held = await runOnce(runOptions(dir, api));
    assert.equal(held.status.decision, 'lock_held');
    assert.equal(held.status.needsAttention, false);
    assert.equal(api.calls.active, 0);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'status.json'), 'utf8')).decision, 'lock_held');

    fs.writeFileSync(path.join(dir, 'controller.lock'), JSON.stringify({ token: 'live', pid: process.pid, createdAt: new Date(NOW - 2 * HOUR).toISOString() }));
    const stale = await runOnce(runOptions(dir, api, { now: NOW + MINUTE }));
    assert.equal(stale.status.decision, 'lock_held');
    assert.equal(stale.status.needsAttention, true);
    assert.equal(stale.status.attention.reason, 'live_lock_stale');
    assert.equal(stale.exitCode, 3);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('state writes are atomic and leave no temp files', () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, 'state.json');
    writeJsonAtomic(file, { totalAttempts: 1 });
    writeJsonAtomic(file, { totalAttempts: 2 });

    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { totalAttempts: 2 });
    assert.deepEqual(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp')), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------------------------------------------------------------- service */

test('service.json supports canonical url and legacy port forms, rejects non-loopback', () => {
  assert.equal(resolveService({ url: 'http://127.0.0.1:49380', password: 'p' }).baseUrl, 'http://127.0.0.1:49380');
  assert.equal(resolveService({ url: 'http://localhost:49380', token: 't' }).password, 't');
  assert.equal(resolveService({ url: 'http://0.0.0.0:49380', password: 'p' }).baseUrl, 'http://127.0.0.1:49380');
  assert.equal(resolveService({ url: 'http://[::]:49380', password: 'p' }).baseUrl, 'http://127.0.0.1:49380');
  assert.equal(resolveService({ hostname: '0.0.0.0', port: 49380, password: 'p' }).baseUrl, 'http://127.0.0.1:49380');
  assert.equal(resolveService({ port: 49380 }).baseUrl, 'http://127.0.0.1:49380');

  assert.throws(() => resolveService({ url: 'http://10.0.0.5:49380' }), /not loopback/);
  assert.throws(() => resolveService({ url: 'http://user:pass@127.0.0.1:49380' }), /credentials/);
  assert.throws(() => resolveService({ url: 'http://127.0.0.1' }), /missing a port/);
  assert.throws(() => resolveService({ hostname: '192.168.1.2', port: 49380 }), /not loopback/);
  assert.throws(() => resolveService({ port: 0 }), /valid port/);

  assert.equal(isLoopbackHost('::1'), true);
  assert.equal(isLoopbackHost('[::1]'), true);
  assert.equal(isLoopbackHost('127.0.0.2'), true);
  assert.equal(isLoopbackHost('10.0.0.5'), false);
});

test('active-session responses with the wrong shape are rejected', () => {
  assert.deepEqual(assertActiveMap({ data: { a: { type: 'running' } } }), { a: { type: 'running' } });
  assert.throws(() => assertActiveMap({ data: [] }), /unexpected shape/);
  assert.throws(() => assertActiveMap({}), /unexpected shape/);
  assert.throws(() => assertActiveMap(null), /unexpected shape/);
});

/* ------------------------------------------------- provider backoff reality */

test('a 200 admission never resets provider backoff; real quota errors double it', async () => {
  const dir = tempDir();
  try {
    fs.writeFileSync(
      path.join(dir, 'queue.json'),
      JSON.stringify(baseQueue({ limits: { ...DEFAULTS, perItemDeliveries: 8, totalDeliveries: 16 } })),
    );
    const statePath = path.join(dir, 'state.json');
    let now = NOW;
    let messages = [];
    const api = mockApi({ sessions: { [OWNER]: session(OWNER) }, messages: { [OWNER]: [] } });
    api.getMessages = async () => messages;
    const expected = [30 * MINUTE, 60 * MINUTE, 120 * MINUTE];

    for (let cycle = 0; cycle < 3; cycle += 1) {
      // Admission is HTTP 200 but the model has not run yet: not provider health.
      const admit = await runOnce(runOptions(dir, api, { now }));
      assert.equal(api.calls.post.length, cycle + 1);
      assert.equal(admit.status.decision, 'delivered_awaiting_evidence');
      let persisted = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      assert.equal(persisted.items['ticket-rules-mask'].consecutiveProviderErrors, cycle);

      // The quota error arrives afterwards, as an assistant message error.
      now += 5000;
      messages = [assistant(`err-${cycle}`, now, '', { error: { type: 'provider.quota', status: 429, message: 'FreeUsageLimitError' } })];
      const errTick = await runOnce(runOptions(dir, api, { now }));
      assert.equal(errTick.status.decision, 'backoff_wait');
      assert.equal(api.calls.post.length, cycle + 1, 'no POST while backing off');

      persisted = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      assert.equal(persisted.items['ticket-rules-mask'].consecutiveProviderErrors, cycle + 1);
      assert.equal(persisted.items['ticket-rules-mask'].backoffMs, expected[cycle]);
      assert.equal(persisted.items['ticket-rules-mask'].retryAt, now + expected[cycle]);

      now += expected[cycle] + 1000;
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('only a fresh error-free assistant message clears provider backoff', async () => {
  const api = mockApi({
    sessions: { [OWNER]: session(OWNER) },
    messages: { [OWNER]: [assistant('ok-1', NOW - MINUTE, 'still working')] },
  });
  const state = stateFor(PHASE.OWNER, {
    consecutiveProviderErrors: 2,
    backoffMs: 60 * MINUTE,
    retryAt: NOW - 1000,
    lastError: { status: 429, type: 'provider.quota' },
    lastErrorMessageId: 'err-1',
  });

  const result = await plan(baseQueue(), api, state);
  const item = result.state.items['ticket-rules-mask'];
  assert.equal(item.consecutiveProviderErrors, 0);
  assert.equal(item.retryAt, null);
  assert.equal(item.lastError, null);
  assert.equal(item.lastErrorMessageId, 'ok-1');
});

test('a second QA COMPLETE after a Main rejection is attention, not a silent hold', async () => {
  const api = mockApi({
    sessions: { [QA]: session(QA) },
    messages: { [QA]: [assistant('qa-2', NOW - MINUTE, completeText('Re-verified after rejection.'))] },
  });
  const state = stateFor(PHASE.QA, {
    lastSentAt: NOW - HOUR,
    lastSentPhase: PHASE.QA,
    lastDeliveryAt: NOW - HOUR,
    mainNotifiedAt: NOW - 2 * HOUR,
  });

  const result = await plan(baseQueue(), api, state);

  assert.equal(result.status.decision, 'needs_attention');
  assert.equal(result.status.attention.reason, 'qa_recompleted_after_rejection');
  assert.equal(result.delivery, undefined);
  assert.deepEqual(result.state.items['ticket-rules-mask'].consumedMessageIds, ['qa-2']);

  // Clearing attention must actually resume: the triggering message is consumed,
  // so the same COMPLETE cannot re-latch the item forever.
  const cleared = await plan(baseQueue(), api, {
    ...result.state,
    items: { 'ticket-rules-mask': { ...result.state.items['ticket-rules-mask'], needsAttention: null } },
  });
  assert.notEqual(cleared.status.decision, 'needs_attention');
  assert.equal(cleared.status.decision, 'idle_continuation');
});

test('needsAttention latches until Main clears it, and clearing resumes the queue', async () => {
  const api = mockApi({ sessions: { [OWNER]: session(OWNER) }, messages: { [OWNER]: [] } });

  const held = await plan(
    baseQueue(),
    api,
    stateFor(PHASE.OWNER, { needsAttention: { reason: 'provider_auth', at: new Date(NOW).toISOString() } }),
  );
  assert.equal(held.status.decision, 'needs_attention');
  assert.equal(api.calls.active, 0, 'no session is read while attention is latched');

  const resumed = await plan(baseQueue(), api, stateFor(PHASE.OWNER, { needsAttention: null }));
  assert.equal(resumed.status.decision, 'idle_continuation');
  assert.equal(resumed.delivery.sessionID, OWNER);
});

test('one session cannot serve two items or both roles', async () => {
  const second = baseItem({ id: 'second-item', qaSessionID: MAIN });
  const reusedOwner = await plan(baseQueue({ items: [baseItem(), { ...second, ownerSessionID: OWNER }] }), mockApi());
  assert.equal(reusedOwner.status.decision, 'invalid_config');
  assert.match(reusedOwner.status.error, /used by both/);

  const reusedQa = await plan(
    baseQueue({ items: [baseItem(), baseItem({ id: 'second-item', ownerSessionID: MAIN, qaSessionID: QA })] }),
    mockApi(),
  );
  assert.equal(reusedQa.status.decision, 'invalid_config');
  assert.match(reusedQa.status.error, /used by both/);
});

test('ISO timestamps in state are rejected instead of silently disabling backoff', async () => {
  const api = mockApi();
  const isoRetry = await plan(baseQueue(), api, stateFor(PHASE.OWNER, { retryAt: new Date(NOW).toISOString() }));
  assert.equal(isoRetry.status.decision, 'invalid_state');
  assert.match(isoRetry.status.error, /must be an epoch number/);
  assert.equal(api.calls.active, 0);
});

/* --------------------------------------------------- deletion is not acceptance */

test('deleting an item record is a stop, never a re-delivery with a fresh budget', async () => {
  const api = mockApi({ sessions: { [OWNER]: session(OWNER) }, messages: { [OWNER]: [] } });

  const deleted = await plan(baseQueue(), api, {
    version: 1,
    items: {},
    seededItemIds: ['ticket-rules-mask'],
    totalAttempts: 3,
    totalDeliveries: 3,
  });
  assert.equal(deleted.status.decision, 'needs_attention');
  assert.equal(deleted.status.attention.reason, 'unseeded_item');
  assert.deepEqual(deleted.status.attention.items, ['ticket-rules-mask']);
  assert.equal(deleted.delivery, undefined);
  assert.equal(api.calls.active, 0, 'nothing is read for an unseeded item');

  // A genuinely fresh run still bootstraps the single declared item.
  const fresh = await plan(baseQueue(), api, emptyState());
  assert.equal(fresh.status.decision, 'initial_delivery');
});

test('a deleted state.json with an existing heartbeat fails closed instead of resetting budgets', async () => {
  const dir = tempDir();
  try {
    fs.writeFileSync(path.join(dir, 'queue.json'), JSON.stringify(baseQueue()));
    fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({ decision: 'delivered_awaiting_evidence', stateSeen: true }));
    const api = mockApi({ sessions: { [OWNER]: session(OWNER) }, messages: { [OWNER]: [] } });

    const result = await runOnce(runOptions(dir, api));

    assert.equal(result.status.decision, 'state_missing_but_history_exists');
    assert.equal(result.exitCode, 3);
    assert.equal(api.calls.post.length, 0);
    assert.equal(fs.existsSync(path.join(dir, 'state.json')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('correlation and completion markers need real boundaries', () => {
  assert.equal(hasCorrelation('XQUEUE_TASK: ticket-rules-mask', 'ticket-rules-mask'), false);
  assert.equal(hasCorrelation('QUEUE_TASK: ticket-rules-mask-extra', 'ticket-rules-mask'), false);
  assert.equal(hasCorrelation('prefix\nQUEUE_TASK: ticket-rules-mask', 'ticket-rules-mask'), true);

  assert.equal(parseSupervisorState('done\nSUPERVISOR_STATE: COMPLETE later'), null);
  assert.equal(parseSupervisorState('done\nSUPERVISOR_STATE: COMPLETE'), 'COMPLETE');
  assert.equal(parseSupervisorState('done\nSUPERVISOR_STATE: EXTERNAL_BLOCK no credentials'), 'EXTERNAL_BLOCK');
});

test('a pre-state heartbeat (lock/api failure) does not block a legitimate first run', async () => {
  const dir = tempDir();
  try {
    fs.writeFileSync(path.join(dir, 'queue.json'), JSON.stringify(baseQueue()));
    // Exactly what the pre-state failure paths write: a heartbeat without stateSeen.
    fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({ decision: 'api_error', stateSeen: false }));
    const api = mockApi({ sessions: { [OWNER]: session(OWNER) }, messages: { [OWNER]: [] } });

    const result = await runOnce(runOptions(dir, api));

    assert.equal(result.status.decision, 'delivered_awaiting_evidence');
    assert.equal(api.calls.post.length, 1);
    const persisted = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
    assert.equal(persisted.items['ticket-rules-mask'].attempts, 1);
    const status = JSON.parse(fs.readFileSync(path.join(dir, 'status.json'), 'utf8'));
    assert.equal(status.stateSeen, true, 'the heartbeat now records that state.json exists');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
