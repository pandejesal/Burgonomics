#!/usr/bin/env node
'use strict';

/**
 * Burgonomics delivery-queue controller (run-20261020b). One durable queue, one
 * active item, one attempt per tick. `buildPlan` is a pure tick over injected
 * dependencies; disk and network live outside it. `--once` is DRY-RUN (read-only,
 * no writes, no POST); only `--apply` reserves, posts, and persists.
 *
 * Native API: GET /api/session/active, GET /api/session/{id},
 * GET /api/session/{id}/message?limit=12&order=desc&type=assistant,
 * POST /api/session/{id}/synthetic {text, description, delivery:"queue"}.
 * Basic auth is read fresh from service.json per request and never printed.
 */

const fs = require('node:fs');
const path = require('node:path');

const PHASE = Object.freeze({
  OWNER: 'owner',
  QA: 'qa',
  AWAITING_MAIN: 'awaiting_main_acceptance',
  ACCEPTED: 'accepted',
  EXTERNAL_BLOCK: 'external_block',
  NEEDS_ATTENTION: 'needs_attention',
});
const PHASES = new Set(Object.values(PHASE));
const TERMINAL_PHASES = new Set([PHASE.AWAITING_MAIN, PHASE.ACCEPTED, PHASE.EXTERNAL_BLOCK, PHASE.NEEDS_ATTENTION]);
const DEFAULTS = Object.freeze({
  perItemDeliveries: 6,
  totalDeliveries: 12,
  idleContinuationMs: 15 * 60 * 1000,
  minBackoffMs: 30 * 60 * 1000,
  maxBackoffMs: 4 * 60 * 60 * 1000,
});
const ALLOWED_WORKERS = Object.freeze([
  Object.freeze({ providerID: 'opencode', modelID: 'deepseek-v4.1-flash-free' }),
  Object.freeze({ providerID: 'opencode', modelID: 'glm-5.3-flash-free' }),
]);
const SESSION_ID = /^ses_[A-Za-z0-9]{6,}$/;
const ITEM_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_CONSUMED_IDS = 20;
const STALE_LOCK_MS = 30 * 60 * 1000;
const HTTP_TIMEOUT_MS = 20 * 1000;
const USAGE = `Burgonomics delivery-queue controller (run-20261020b)

  node controller.cjs --once            DRY-RUN (default): read-only, no writes, no POST
  node controller.cjs --once --apply    Apply: lease, reserve, POST if due, persist state
  --help                                this text

No autostart, service reload, deletion, worktree, or git operations.
`;

const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());
const normalizePath = (v) => String(v == null ? '' : v).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const sameRoot = (a, b) => normalizePath(a) === normalizePath(b);
const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const errorText = (err) => String((err && err.message) || err || 'unknown error').slice(0, 240);

/* ---------------------------------------------------------------- validation */

function validateQueue(queue) {
  if (!queue || typeof queue !== 'object' || Array.isArray(queue)) return 'queue.json must be an object';
  if (typeof queue.enabled !== 'boolean') return 'queue.enabled must be boolean';
  if (typeof queue.runId !== 'string' || !queue.runId.trim()) return 'queue.runId must be a non-empty string';
  if (typeof queue.rootRepo !== 'string' || !path.isAbsolute(queue.rootRepo)) return 'queue.rootRepo must be an absolute path';
  if (queue.mainSessionID != null && !SESSION_ID.test(queue.mainSessionID)) return 'queue.mainSessionID is not a session id';
  const limits = { ...DEFAULTS, ...(queue.limits || {}) };
  for (const key of ['perItemDeliveries', 'totalDeliveries']) {
    if (!Number.isInteger(limits[key]) || limits[key] < 1) return `limits.${key} must be a positive integer`;
  }
  for (const key of ['idleContinuationMs', 'minBackoffMs', 'maxBackoffMs']) {
    if (!Number.isFinite(limits[key]) || limits[key] < 0) return `limits.${key} must be a non-negative number`;
  }
  if (limits.maxBackoffMs < limits.minBackoffMs) return 'limits.maxBackoffMs must be >= limits.minBackoffMs';
  if (!Array.isArray(queue.items) || queue.items.length === 0) return 'queue.items must be a non-empty array';
  const seen = new Set();
  const usedSessions = new Map();
  for (const item of queue.items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return 'each queue item must be an object';
    if (typeof item.id !== 'string' || !ITEM_ID.test(item.id)) return 'item.id is invalid';
    if (seen.has(item.id)) return `duplicate item id ${item.id}`;
    seen.add(item.id);
    if (!SESSION_ID.test(item.ownerSessionID || '')) return `item ${item.id} ownerSessionID is invalid`;
    if (!SESSION_ID.test(item.qaSessionID || '')) return `item ${item.id} qaSessionID is invalid`;
    if (item.ownerSessionID === item.qaSessionID) return `item ${item.id} owner and QA sessions must differ`;
    // One session can only serve one role in one item: otherwise two items could
    // prompt the same worker and read each other's answers as evidence.
    for (const [role, sessionID] of [['owner', item.ownerSessionID], ['qa', item.qaSessionID]]) {
      if (usedSessions.has(sessionID)) {
        return `session ${sessionID} is used by both ${usedSessions.get(sessionID)} and item ${item.id} (${role})`;
      }
      usedSessions.set(sessionID, `item ${item.id} (${role})`);
    }
    if (item.phase != null && !PHASES.has(item.phase)) return `item ${item.id} phase is invalid`;
    if (item.mainSessionID != null && !SESSION_ID.test(item.mainSessionID)) return `item ${item.id} mainSessionID is invalid`;
    if (item.rootRepo != null && (!path.isAbsolute(item.rootRepo) || !sameRoot(item.rootRepo, queue.rootRepo))) {
      return `item ${item.id} rootRepo must match queue.rootRepo`;
    }
  }
  return null;
}

function validateState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return 'state.json must be an object';
  if (!state.items || typeof state.items !== 'object' || Array.isArray(state.items)) return 'state.items must be an object';
  for (const key of ['totalAttempts', 'totalDeliveries']) {
    if (state[key] != null && (!Number.isInteger(state[key]) || state[key] < 0)) return `state.${key} is invalid`;
  }
  for (const [id, item] of Object.entries(state.items)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return `state item ${id} is invalid`;
    if (!PHASES.has(item.phase)) return `state item ${id} has unknown phase ${String(item.phase)}`;
    for (const key of ['attempts', 'deliveries', 'consecutiveProviderErrors']) {
      if (item[key] != null && (!Number.isInteger(item[key]) || item[key] < 0)) return `state item ${id}.${key} is invalid`;
    }
    if (item.consumedMessageIds != null && !Array.isArray(item.consumedMessageIds)) return `state item ${id}.consumedMessageIds is invalid`;

    // Timestamps drive backoff and freshness. An ISO string here would silently
    // compare as NaN and disable the retry gate, so reject it loudly instead.
    for (const key of ['lastSentAt', 'lastDeliveryAt', 'lastContinuationAt', 'lastErrorAt', 'retryAt', 'mainNotifiedAt', 'lastAttemptAt']) {
      const value = item[key];
      if (value != null && !Number.isFinite(value)) return `state item ${id}.${key} must be an epoch number, got ${JSON.stringify(value)}`;
    }
    if (item.reservation != null && (!item.reservation.id || !['pending', 'sent'].includes(item.reservation.status))) {
      return `state item ${id}.reservation is invalid`;
    }
  }
  if (state.seededItemIds != null) {
    if (!Array.isArray(state.seededItemIds)) return 'state.seededItemIds must be an array';
    if (state.seededItemIds.some((id) => typeof id !== 'string' || !ITEM_ID.test(id))) return 'state.seededItemIds contains an invalid item id';
  }
  return null;
}

/* ------------------------------------------------------------------ helpers */

function clampBackoff(consecutive, limits) {
  const base = Math.max(0, Number(limits.minBackoffMs) || DEFAULTS.minBackoffMs);
  const cap = Math.max(base, Number(limits.maxBackoffMs) || DEFAULTS.maxBackoffMs);
  return Math.min(base * Math.pow(2, Math.max(0, (Number(consecutive) || 0) - 1)), cap);
}

const modelOf = (session) => ({
  providerID: (session && session.model && session.model.providerID) || null,
  id: (session && session.model && session.model.id) || null,
});
const modelAllowed = (model) =>
  ALLOWED_WORKERS.some((w) => w.providerID === model.providerID && w.modelID === model.id);

function assistantText(message) {
  const parts = message && Array.isArray(message.content) ? message.content : [];
  return parts.filter((p) => p && p.type === 'text').map((p) => String(p.text == null ? '' : p.text)).join('\n').trim();
}

/** Canonical final line only: `SUPERVISOR_STATE: COMPLETE` or `EXTERNAL_BLOCK[ reason]`. */
function parseSupervisorState(text) {
  const lines = String(text == null ? '' : text).replace(/\r\n/g, '\n').split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return null;
  const last = lines[lines.length - 1];
  if (/^SUPERVISOR_STATE:\s*COMPLETE$/.test(last)) return 'COMPLETE';
  if (/^SUPERVISOR_STATE:\s*EXTERNAL_BLOCK(?:\s+\S.*)?$/.test(last)) return 'EXTERNAL_BLOCK';
  return null;
}
const lastSupervisorState = parseSupervisorState;

function hasCorrelation(text, itemId) {
  return new RegExp(`(^|[^A-Za-z0-9_.-])QUEUE_TASK\\s*:\\s*${escapeRegExp(itemId)}(?![A-Za-z0-9._-])`, 'i').test(String(text == null ? '' : text));
}

function pushConsumed(item, messageId) {
  if (!messageId) return Array.isArray(item.consumedMessageIds) ? item.consumedMessageIds : [];
  const next = [...(Array.isArray(item.consumedMessageIds) ? item.consumedMessageIds : []), messageId];
  return next.slice(-MAX_CONSUMED_IDS);
}

function itemState(state, item) {
  if (!state.items[item.id]) {
    state.items[item.id] = {
      phase: item.phase || PHASE.OWNER,
      phaseSetBy: 'queue_seed',
      attempts: 0,
      deliveries: 0,
      consecutiveProviderErrors: 0,
      lastAttemptAt: null,
      lastSentAt: null,
      lastSentPhase: null,
      lastDeliveryAt: null,
      lastContinuationAt: null,
      lastErrorAt: null,
      retryAt: null,
      lastError: null,
      lastErrorMessageId: null,
      reservation: null,
      needsAttention: null,
      mainNotifiedAt: null,
      consumedMessageIds: [],
    };
    // Remember that this item once had a record: if the record later disappears,
    // that is a deletion (a stop), not a fresh item to re-deliver.
    state.seededItemIds = Array.isArray(state.seededItemIds) ? state.seededItemIds : [];
    if (!state.seededItemIds.includes(item.id)) state.seededItemIds.push(item.id);
  }
  return state.items[item.id];
}

const observingSession = (item, phase) =>
  phase === PHASE.QA ? { id: item.qaSessionID, kind: PHASE.QA } : { id: item.ownerSessionID, kind: PHASE.OWNER };

const sessionView = (id, kind, session) => ({
  id,
  kind,
  model: modelOf(session),
  outcome: session.outcome || null,
  directory: (session.location && session.location.directory) || null,
  idleSince: iso(session.time && session.time.idle),
});

const budgetOf = (state, s, limits) => ({
  attempts: Number(s.attempts) || 0,
  attemptsMax: limits.perItemDeliveries,
  deliveries: Number(s.deliveries) || 0,
  totalAttempts: Number(state.totalAttempts) || 0,
  totalAttemptsMax: limits.totalDeliveries,
  totalDeliveries: Number(state.totalDeliveries) || 0,
});

/* ------------------------------------------------------------------ prompts */

function renderPrompt(item, phase, kind, s) {
  const ctx = item.packetContext || {};
  const shas = ctx.committed || {};
  const head = `[Burgonomics delivery queue | ${ctx.runId || 'run'} | item ${item.id} | phase ${phase} | ${kind}]`;
  const marker = `QUEUE_TASK: ${item.id}`;
  const packet = [
    `Repo: ${item.rootRepo || ''}.`,
    ctx.brief && `Brief: ${ctx.brief}.`,
    ctx.contract && `Contract: ${ctx.contract}.`,
    ctx.evidenceDir && `Evidence dir: ${ctx.evidenceDir}.`,
    `Committed baseline: root ${shas.root || 'unknown'}, customer ${shas.customer || 'unknown'}, partner ${shas.partner || 'unknown'}.`,
  ].filter(Boolean).join(' ');
  const rules = `Start your final message with "${marker}" so the queue can correlate it; COMPLETE/EXTERNAL_BLOCK without this marker is ignored. `
    + 'Owned paths only; no pushes, deploys, secret changes, provider changes or network changes. '
    + 'If your last state is WAITING_REVIEW, do not spawn or replace a child; finish the same packet. '
    + 'End with exactly one SUPERVISOR_STATE line: the final line must be exactly `SUPERVISOR_STATE: COMPLETE` with no trailing text, or `SUPERVISOR_STATE: EXTERNAL_BLOCK <reason>`. Anything else is ignored.';
  const finish = 'Say COMPLETE only when the work and evidence are actually finished. '
    + 'Use EXTERNAL_BLOCK <reason> only for a real external prerequisite.';

  if (kind === 'qa_verification') {
    return [
      head,
      `Evidence-verification stage only for item ${item.id}. This is not acceptance and not a redo.`,
      packet,
      'Check that the committed work and recorded evidence match the claims (diff, tests, truth labels). '
        + 'Do not re-run the full gate suite unless an evidence gap requires it; record what you checked and what you could not check.',
      'Main accepts the item; the queue never marks it accepted.',
      rules,
    ].join('\n');
  }
  if (kind === 'continuation') {
    return [
      head,
      `No completion observed since the last queued prompt at ${iso(s.lastSentAt)}.`,
      packet,
      'Continue the same packet from the existing context. Do not restart finished gates and do not reimplement committed work.',
      rules,
      finish,
    ].join('\n');
  }
  return [
    head,
    'Continue your existing packet; do not reimplement committed work or redo gates that already have evidence.',
    packet,
    ctx.note && `Reconciliation note: ${ctx.note}`,
    rules,
    finish,
  ].filter(Boolean).join('\n');
}

const makeDelivery = (item, phase, kind, s) => ({
  itemId: item.id,
  phase,
  kind,
  sessionID: phase === PHASE.QA ? item.qaSessionID : item.ownerSessionID,
  description: `queue:${item.id}:${phase}:${kind}`,
  text: renderPrompt(item, phase, kind, s),
});

/**
 * One bounded notification to manifest.orchestrator. Main is not a worker: no
 * model check and no work request. The queue never verifies or accepts for it.
 */
function makeMainNotification(item, queue, sessionID, obs) {
  const ctx = item.packetContext || {};
  const shas = ctx.committed || {};
  const text = [
    `[Burgonomics delivery queue | ${ctx.runId || queue.runId || 'run'} | item ${item.id} | main acceptance required]`,
    `QUEUE_TASK: ${item.id}`,
    `QA reported SUPERVISOR_STATE: COMPLETE at ${iso(obs.latest && obs.latest.time && obs.latest.time.created)}. The queue did not verify the item and did not accept it.`,
    `Inspect the evidence for ${item.id}: root ${shas.root || 'unknown'}, customer ${shas.customer || 'unknown'}, partner ${shas.partner || 'unknown'}; evidence dir ${ctx.evidenceDir || 'unstated'}.`,
    'Accept or reject it yourself. To accept, set state.json items[<id>].phase to "accepted" (or remove the item); the queue never advances on its own and never accepts from message text.',
    'This is the only notification for this item; no work is requested of you here.',
  ].join('\n');
  return {
    itemId: item.id,
    phase: PHASE.AWAITING_MAIN,
    kind: 'main_acceptance_notification',
    sessionID,
    sourceMessageId: obs.latest ? obs.latest.id : null,
    description: `queue:${item.id}:awaiting_main_acceptance:main_notification`,
    text,
  };
}

async function inspect(api, sessionID) {
  const session = (await api.getSession(sessionID)) || {};
  const messages = await api.getMessages(sessionID, { limit: 12 });
  const latest = Array.isArray(messages) && messages.length > 0 ? messages[0] : null;
  const text = latest ? assistantText(latest) : '';
  return { session, latest, text, supervisor: parseSupervisorState(text) };
}

/* --------------------------------------------------------------- pure tick */

/** Decide this tick. Returns {state (deep clone), status, delivery?}. */
async function buildPlan({ now, queue, state, api, mode }) {
  const limits = { ...DEFAULTS, ...((queue && queue.limits) || {}) };
  const next = state && typeof state === 'object' ? JSON.parse(JSON.stringify(state)) : {};
  next.version = 1;
  next.items = next.items && typeof next.items === 'object' && !Array.isArray(next.items) ? next.items : {};
  next.totalAttempts = Number(next.totalAttempts) || 0;
  next.totalDeliveries = Number(next.totalDeliveries) || 0;
  // Preserve budget across an older state file that only tracked successful sends.
  for (const entry of Object.values(next.items)) {
    if (entry && typeof entry === 'object') {
      if (entry.attempts == null) entry.attempts = Number(entry.deliveries) || 0;
      if (entry.deliveries == null) entry.deliveries = 0;
    }
  }

  const base = { polledAt: iso(now), mode, runId: (queue && queue.runId) || null, enabled: queue && queue.enabled === true, needsAttention: false };
  const queueError = validateQueue(queue);
  if (queueError) return { state: next, status: { ...base, decision: 'invalid_config', error: queueError } };
  const stateError = validateState(next);
  if (stateError) return { state: next, status: { ...base, decision: 'invalid_state', error: stateError } };
  if (!base.enabled) return { state: next, status: { ...base, decision: 'disabled' } };

  const items = queue.items;

  // A record that disappears after it was seeded was deleted. Deletion is not
  // acceptance: stop instead of re-arming the item with a fresh budget. Items that
  // were never seeded are normal (they are seeded when they become active).
  const seeded = Array.isArray(next.seededItemIds) ? next.seededItemIds : [];
  const deleted = items.filter((candidate) => !next.items[candidate.id] && seeded.includes(candidate.id));
  if (deleted.length > 0) {
    return {
      state: next,
      status: {
        ...base,
        decision: 'needs_attention',
        needsAttention: true,
        attention: {
          reason: 'unseeded_item',
          at: iso(now),
          items: deleted.map((candidate) => candidate.id),
          hint: 'state.json is missing a previously seeded item; re-add its record deliberately instead of re-delivering it',
        },
      },
    };
  }

  // Main acceptance is a human gate: while any item waits for it, the queue holds
  // and does not activate another item. Only Main moves the item to "accepted".
  const phaseOf = (candidate) => {
    const existing = next.items[candidate.id];
    return existing ? existing.phase : (candidate.phase || PHASE.OWNER);
  };
  const waiting = items.find((candidate) => phaseOf(candidate) === PHASE.AWAITING_MAIN);
  if (waiting) {
    const waitingState = itemState(next, waiting);
    return {
      state: next,
      status: {
        ...base,
        itemId: waiting.id,
        phase: PHASE.AWAITING_MAIN,
        decision: 'awaiting_main_acceptance',
        mainNotifiedAt: iso(waitingState.mainNotifiedAt),
        budget: budgetOf(next, waitingState, limits),
      },
    };
  }

  let item = null;
  let s = null;
  for (const candidate of items) {
    const candidateState = itemState(next, candidate);
    if (!TERMINAL_PHASES.has(candidateState.phase)) {
      item = candidate;
      s = candidateState;
      break;
    }
  }
  if (!item) return { state: next, status: { ...base, decision: 'no_active_item' } };

  const view = (extra) => ({ ...base, itemId: item.id, phase: s.phase, budget: budgetOf(next, s, limits), ...extra });
  if (s.needsAttention) {
    return { state: next, status: view({ decision: 'needs_attention', needsAttention: true, attention: s.needsAttention }) };
  }
  if (s.reservation && s.reservation.status === 'pending') {
    s.needsAttention = { reason: 'unresolved_delivery', at: iso(now), reservationId: s.reservation.id };
    return { state: next, status: view({ decision: 'needs_attention', needsAttention: true, attention: s.needsAttention }) };
  }

  const active = await api.getActive();
  const target = observingSession(item, s.phase);
  const executing = Boolean(active[target.id]);
  const obs = await inspect(api, target.id);
  const latestCreated = Number(obs.latest && obs.latest.time && obs.latest.time.created) || 0;
  const signal = {
    supervisorState: obs.supervisor,
    messageId: (obs.latest && obs.latest.id) || null,
    fresh: s.lastSentPhase === s.phase && s.lastSentAt != null && latestCreated > s.lastSentAt,
    correlated: hasCorrelation(obs.text, item.id),
    consumed: Boolean(obs.latest && Array.isArray(s.consumedMessageIds) && s.consumedMessageIds.includes(obs.latest.id)),
  };
  signal.honored = Boolean(signal.supervisorState && signal.fresh && signal.correlated && !signal.consumed);
  const evidencePending = s.lastSentAt != null && (!obs.latest || latestCreated <= s.lastSentAt);

  const enriched = view({
    executing,
    idle: !executing,
    evidencePending,
    attempts: Number(s.attempts) || 0,
    deliveries: Number(s.deliveries) || 0,
    session: sessionView(target.id, target.kind, obs.session),
    lastAssistant: obs.latest
      ? { id: obs.latest.id, createdAt: iso(latestCreated || null), supervisorState: obs.supervisor, textTail: obs.text.slice(-200) }
      : null,
    signal,
    retryAt: iso(s.retryAt),
    providerError: s.lastError || null,
  });
  const stop = (reason, extra) => {
    s.needsAttention = { reason, at: iso(now), ...(extra || {}) };
    return { state: next, status: { ...enriched, decision: 'needs_attention', needsAttention: true, attention: s.needsAttention } };
  };
  const rootRepo = item.rootRepo || queue.rootRepo;

  if (!sameRoot(obs.session.location && obs.session.location.directory, rootRepo)) {
    return stop('root_mismatch', { expected: rootRepo, actual: (obs.session.location && obs.session.location.directory) || null });
  }
  if (!modelAllowed(modelOf(obs.session))) return stop('worker_model_not_allowed', { model: modelOf(obs.session) });

  // An active actor is never woken and never interrupted.
  if (executing) return { state: next, status: { ...enriched, decision: 'session_active' } };

  // Record a provider error carried by the latest assistant message, then apply
  // the persisted backoff unconditionally (this also covers POST 429s and restarts).
  const errorIsCurrent = Boolean(obs.latest && obs.latest.error && latestCreated > (s.lastSentAt || 0));
  if (errorIsCurrent && s.lastErrorMessageId !== obs.latest.id) {
    s.lastErrorMessageId = obs.latest.id;
    s.consecutiveProviderErrors = (Number(s.consecutiveProviderErrors) || 0) + 1;
    s.lastErrorAt = latestCreated || now;
    s.backoffMs = clampBackoff(s.consecutiveProviderErrors, limits);
    s.retryAt = s.lastErrorAt + s.backoffMs;
    s.lastError = {
      status: obs.latest.error.status == null ? null : obs.latest.error.status,
      type: obs.latest.error.type || 'provider.error',
      message: String(obs.latest.error.message || '').slice(0, 240),
      backoffMs: s.backoffMs,
    };
  }
  if (s.retryAt != null && now < s.retryAt) {
    return { state: next, status: { ...enriched, decision: 'backoff_wait', retryAt: iso(s.retryAt), providerError: s.lastError || null } };
  }

  // Observation-based decay. A 200 admission is NOT provider health; only a newer
  // assistant message with no error proves recovery. POST-429 backoff is therefore
  // never reset by the delivery that follows it.
  if (obs.latest && !obs.latest.error && latestCreated > (s.lastSentAt || 0)) {
    s.consecutiveProviderErrors = 0;
    s.retryAt = null;
    s.lastError = null;
    s.lastErrorMessageId = obs.latest.id;
    enriched.retryAt = null;
    enriched.providerError = null;
  }

  const attemptCapReached = () =>
    (Number(s.attempts) || 0) >= limits.perItemDeliveries || next.totalAttempts >= limits.totalDeliveries;
  const deliver = (kind, phase, decision) => {
    const delivery = makeDelivery(item, phase, kind, s);
    return {
      state: next,
      status: {
        ...enriched,
        phase,
        decision,
        planned: mode === 'dry-run'
          ? { sessionID: delivery.sessionID, kind, description: delivery.description, attempt: (Number(s.attempts) || 0) + 1, text: delivery.text }
          : null,
      },
      delivery,
    };
  };

  if (signal.honored && signal.supervisorState === 'EXTERNAL_BLOCK') {
    s.phase = PHASE.EXTERNAL_BLOCK;
    s.phaseSetBy = `external_block:${signal.messageId}`;
    s.consumedMessageIds = pushConsumed(s, signal.messageId);
    return { state: next, status: { ...enriched, phase: s.phase, decision: 'external_block' } };
  }

  if (signal.honored && signal.supervisorState === 'COMPLETE') {
    if (s.phase === PHASE.OWNER) {
      const qa = await inspect(api, item.qaSessionID);
      const eligible = sameRoot(qa.session.location && qa.session.location.directory, rootRepo)
        && modelAllowed(modelOf(qa.session));
      if (!eligible) {
        return stop('qa_session_not_eligible', {
          model: modelOf(qa.session),
          directory: (qa.session.location && qa.session.location.directory) || null,
        });
      }
      if (active[item.qaSessionID]) return { state: next, status: { ...enriched, decision: 'qa_session_active' } };
      if (attemptCapReached()) return stop('attempt_budget_exhausted');
      s.phase = PHASE.QA;
      s.phaseSetBy = `owner_complete:${signal.messageId}`;
      s.consumedMessageIds = pushConsumed(s, signal.messageId);
      return deliver('qa_verification', PHASE.QA, 'owner_complete_to_qa');
    }
    if (s.phase === PHASE.QA) {
      if (s.mainNotifiedAt) {
        // Main already saw a completion and put the item back to qa: a second
        // COMPLETE is a rejection re-completion, not a silent hold. Consume the
        // message so that clearing needsAttention actually resumes the queue.
        s.consumedMessageIds = pushConsumed(s, signal.messageId);
        return stop('qa_recompleted_after_rejection');
      }
      const mainSessionID = item.mainSessionID || queue.mainSessionID;
      if (!mainSessionID) return stop('main_session_missing');
      if (attemptCapReached()) return stop('notification_budget_exhausted');
      let mainSession = null;
      try {
        mainSession = await api.getSession(mainSessionID);
      } catch (err) {
        return {
          state: next,
          status: {
            ...enriched,
            decision: 'needs_attention',
            needsAttention: true,
            attention: { reason: 'main_session_unavailable', at: iso(now), error: errorText(err) },
          },
        };
      }
      const notification = makeMainNotification(item, queue, mainSessionID, obs);
      return {
        state: next, // phase stays qa until the POST is durably confirmed
        status: {
          ...enriched,
          phase: PHASE.AWAITING_MAIN,
          decision: 'qa_complete_awaiting_main',
          main: { id: mainSessionID, model: modelOf(mainSession) }, // informational only
          planned: mode === 'dry-run'
            ? { sessionID: mainSessionID, kind: notification.kind, description: notification.description, attempt: (Number(s.attempts) || 0) + 1, text: notification.text }
            : null,
        },
        delivery: notification,
      };
    }
  }

  if (s.lastSentAt == null || s.lastSentPhase !== s.phase) {
    // No successful delivery yet in this phase: send the phase-entry prompt, not a
    // continuation (e.g. the QA prompt 429'd after the owner -> QA transition).
    if (attemptCapReached()) return stop('attempt_budget_exhausted');
    return s.phase === PHASE.QA
      ? deliver('qa_verification', PHASE.QA, 'qa_verification_delivery')
      : deliver('owner_initial', PHASE.OWNER, 'initial_delivery');
  }

  // Bounded 15-minute continuations while idle; at the cap this becomes explicit
  // attention instead of an endless quiet loop.
  if (now - s.lastSentAt >= limits.idleContinuationMs) {
    if (attemptCapReached()) return stop('continuation_cap_reached');
    return deliver('continuation', s.phase, 'idle_continuation');
  }
  return { state: next, status: { ...enriched, decision: evidencePending ? 'awaiting_evidence' : 'progress_observed' } };
}

/* ------------------------------------------------------------ disk + lease */

const readJsonFile = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

function readState(file) {
  if (!fs.existsSync(file)) return { version: 1, items: {}, totalAttempts: 0, totalDeliveries: 0 };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : { version: 1, items: {}, totalAttempts: 0, totalDeliveries: 0 };
  } catch {
    const error = new Error(`state file is not valid JSON (${file}); refusing to overwrite it`);
    error.code = 'EBADSTATE';
    throw error;
  }
}

/**
 * tmp + fsync + rename. There is deliberately NO unlink-old fallback: if the
 * rename fails, the previous file is retained and the caller fails closed.
 */
/**
 * Previous heartbeat, if readable. `stateSeen: true` in it is the only proof that a
 * state.json ever existed: pre-state failures (lock, api) write a heartbeat without it.
 */
function readPriorStatus(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    throw err;
  }
}

function appendEvent(file, event) {
  if (!file) return;
  fs.appendFileSync(file, `${JSON.stringify(event)}\n`);
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM' ? true : false;
  }
}

function releaseLock(lockPath, token) {
  try {
    const current = readJsonFile(lockPath);
    if (current && current.token === token) fs.unlinkSync(lockPath);
  } catch { /* already gone or unreadable */ }
}

function createLockFile(lockPath, now) {
  const token = `${process.pid}:${now}:${Math.random().toString(36).slice(2, 8)}`;
  try {
    const fd = fs.openSync(lockPath, 'wx');
    try {
      fs.writeFileSync(fd, JSON.stringify({ token, pid: process.pid, createdAt: iso(now) }));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return { acquired: true, release: () => releaseLock(lockPath, token) };
  } catch (err) {
    if (err && err.code === 'EEXIST') return null;
    throw err;
  }
}

/**
 * Conservative lease. A live PID is NEVER stolen, whatever its age: an old live
 * lock is reported as attention. Only a dead PID plus an old lease is reclaimed.
 */
function acquireLock(lockPath, now, options) {
  const staleMs = (options && options.staleMs) || STALE_LOCK_MS;
  const created = createLockFile(lockPath, now);
  if (created) return created;

  let existing = null;
  try { existing = readJsonFile(lockPath); } catch { /* unreadable */ }
  const createdAt = existing && Date.parse(existing.createdAt);
  const ageMs = now - (Number.isFinite(createdAt) ? createdAt : fs.statSync(lockPath).mtimeMs);
  const alive = existing ? pidAlive(existing.pid) : null;

  if (alive === false && ageMs > staleMs) {
    if (existing && existing.token) releaseLock(lockPath, existing.token);
    else fs.unlinkSync(lockPath);
    return createLockFile(lockPath, now) || { acquired: false, release: () => {}, reason: 'lock_held', ageMs };
  }
  if (alive !== false && ageMs > staleMs) {
    return { acquired: false, release: () => {}, reason: 'live_lock_stale', ageMs, attention: true };
  }
  return { acquired: false, release: () => {}, reason: alive === false ? 'dead_lock_too_young' : 'lock_held', ageMs };
}

/* ---------------------------------------------------------------- apply run */

function classifyPost(response) {
  const status = Number(response && response.status);
  if (status >= 200 && status < 300) return { kind: 'sent', status };
  if (status === 429) return { kind: 'rate_limited', status };
  return { kind: 'uncertain', status: Number.isFinite(status) ? status : null };
}

async function runOnce({ mode, now, queuePath, statePath, lockPath, statusPath, eventsPath, api, persistState }) {
  const persist = persistState || writeJsonAtomic;
  // Every heartbeat records whether state.json existed when it was written, so a later
  // absence can be distinguished from a legitimate first run.
  const writeStatus = (status) => persist(statusPath, { ...status, stateSeen: fs.existsSync(statePath) });
  const queue = readJsonFile(queuePath);
  const write = mode === 'apply';
  const limits = { ...DEFAULTS, ...(queue.limits || {}) };
  const base = { polledAt: iso(now), mode, runId: queue.runId || null, needsAttention: false };

  const queueError = validateQueue(queue);
  if (queueError) return { status: { ...base, enabled: queue && queue.enabled === true, decision: 'invalid_config', error: queueError }, exitCode: 2, wrote: false };
  if (queue.enabled !== true) return { status: { ...base, enabled: false, decision: 'disabled' }, exitCode: 0, wrote: false };

  let release = () => {};
  if (write) {
    let lock;
    try {
      lock = acquireLock(lockPath, now);
    } catch (err) {
      const status = { ...base, enabled: true, decision: 'lock_error', error: errorText(err) };
      if (write) { try { writeStatus(status); } catch { /* heartbeat best effort */ } }
      return { status, exitCode: 3, wrote: false };
    }
    if (!lock.acquired) {
      const status = {
        ...base,
        enabled: true,
        decision: 'lock_held',
        lock: lock.reason || 'lock_held',
        lockAgeMs: lock.ageMs == null ? null : lock.ageMs,
        needsAttention: Boolean(lock.attention),
        attention: lock.attention ? { reason: lock.reason || 'lock_held', at: iso(now), ageMs: lock.ageMs } : null,
      };
      try { writeStatus(status); } catch { /* heartbeat is best effort here */ }
      return { status, exitCode: lock.attention ? 3 : 0, wrote: false };
    }
    release = lock.release;
  }

  try {
    let state;
    // An absent state.json is only legitimate before the first delivery. A previous
    // heartbeat that saw state.json (stateSeen: true) or an event log proves it was
    // deleted: fail closed rather than restart with a clean budget.
    const priorStatus = readPriorStatus(statusPath);
    const stateWasDeleted = !fs.existsSync(statePath)
      && ((priorStatus && priorStatus.stateSeen === true) || fs.existsSync(eventsPath));
    if (stateWasDeleted) {
      const status = {
        ...base,
        enabled: true,
        decision: 'state_missing_but_history_exists',
        needsAttention: true,
        attention: { reason: 'state_missing_but_history_exists', at: iso(now) },
      };
      if (write) { try { writeStatus(status); } catch { /* heartbeat best effort */ } }
      return { status, exitCode: 3, wrote: false };
    }
    try {
      state = readState(statePath);
    } catch (err) {
      return { status: { ...base, enabled: true, decision: 'state_unreadable', error: errorText(err) }, exitCode: 3, wrote: false };
    }

    let plan;
    try {
      plan = await buildPlan({ now, queue, state, api, mode });
    } catch (err) {
      const status = { ...base, enabled: true, decision: 'api_error', error: errorText(err) };
      if (write) { try { writeStatus(status); } catch { /* heartbeat best effort */ } }
      return { status, exitCode: 3, wrote: false };
    }

    let status = plan.status;
    if (['invalid_config', 'invalid_state'].includes(status.decision)) {
      return { status, exitCode: 2, wrote: false };
    }

    if (write && plan.delivery) {
      const d = plan.delivery;
      const after = plan.state.items[d.itemId];
      const isMainNotification = d.kind === 'main_acceptance_notification';
      const reservation = {
        id: `res_${now}_${Math.random().toString(36).slice(2, 8)}`,
        itemId: d.itemId,
        phase: d.phase,
        sessionID: d.sessionID,
        text: d.text,
        status: 'pending',
        createdAt: iso(now),
      };

      // Charge the attempt and persist the reservation BEFORE the POST. A failure
      // here means no POST at all: the old state is retained and we fail closed.
      after.attempts = (Number(after.attempts) || 0) + 1;
      plan.state.totalAttempts = (Number(plan.state.totalAttempts) || 0) + 1;
      after.lastAttemptAt = now;
      after.reservation = reservation;
      plan.state.updatedAt = iso(now);
      try {
        persist(statePath, plan.state);
      } catch (err) {
        return {
          status: {
            ...plan.status,
            decision: 'state_write_failed',
            needsAttention: true,
            attention: { reason: 'state_write_failed', at: iso(now), stage: 'reservation', error: errorText(err) },
          },
          exitCode: 3,
          wrote: false,
        };
      }

      let outcome;
      try {
        outcome = classifyPost(await api.postSynthetic(d.sessionID, { text: d.text, description: d.description, delivery: 'queue' }));
      } catch (err) {
        outcome = { kind: 'uncertain', status: err && err.status ? err.status : null };
      }

      if (outcome.kind === 'sent') {
        after.reservation = { ...reservation, status: 'sent', sentAt: iso(now), httpStatus: outcome.status };
        after.deliveries = (Number(after.deliveries) || 0) + 1;
        after.lastSentAt = now;
        after.lastDeliveryAt = now;
        after.lastSentPhase = d.phase;
        after.retryAt = null;
        if (d.kind === 'continuation') after.lastContinuationAt = now;
        if (isMainNotification) {
          after.phase = PHASE.AWAITING_MAIN;
          after.mainNotifiedAt = now;
          after.phaseSetBy = `qa_complete_notified:${d.itemId}`;
          after.consumedMessageIds = pushConsumed(after, d.sourceMessageId);
        }
        plan.state.totalDeliveries = (Number(plan.state.totalDeliveries) || 0) + 1;
        plan.state.updatedAt = iso(now);

        // Persist the accepted delivery BEFORE any observation call.
        try {
          persist(statePath, plan.state);
        } catch (err) {
          return {
            status: {
              ...plan.status,
              decision: 'state_write_failed',
              needsAttention: true,
              attention: { reason: 'state_write_failed', at: iso(now), stage: 'post_send', error: errorText(err) },
            },
            exitCode: 3,
            wrote: false,
          };
        }

        let eventLogError = null;
        if (isMainNotification) {
          try {
            appendEvent(eventsPath, {
              at: iso(now),
              runId: queue.runId || null,
              itemId: d.itemId,
              event: 'awaiting_main_acceptance',
              sessionID: d.sessionID,
              reservationId: reservation.id,
            });
          } catch (err) {
            eventLogError = errorText(err);
          }
        }

        // Observation is best effort: the delivery is already durable.
        let activeAfter = null;
        let delivered = null;
        let observationError = null;
        try {
          activeAfter = await api.getActive();
          delivered = await api.getSession(d.sessionID);
        } catch (err) {
          observationError = errorText(err);
        }
        const executingAfter = activeAfter ? Boolean(activeAfter[d.sessionID]) : null;
        status = {
          ...status,
          phase: isMainNotification ? PHASE.AWAITING_MAIN : status.phase,
          decision: isMainNotification ? 'awaiting_main_acceptance' : 'delivered_awaiting_evidence',
          executing: executingAfter,
          idle: executingAfter === null ? null : !executingAfter,
          observation: observationError ? 'unavailable' : 'ok',
          observationError,
          evidencePending: !isMainNotification, // an accepted prompt is not execution or progress
          session: delivered ? sessionView(d.sessionID, d.phase, delivered) : status.session,
          budget: budgetOf(plan.state, after, limits),
          attemptsCharged: true,
          eventLogError,
          mainNotification: isMainNotification
            ? { sessionID: d.sessionID, acceptedAt: iso(now), httpStatus: outcome.status, event: 'awaiting_main_acceptance' }
            : null,
          delivery: { itemId: d.itemId, kind: d.kind, sessionID: d.sessionID, description: d.description, acceptedAt: iso(now), httpStatus: outcome.status },
          planned: null,
        };
      } else if (outcome.kind === 'rate_limited') {
        after.reservation = null;
        after.consecutiveProviderErrors = (Number(after.consecutiveProviderErrors) || 0) + 1;
        after.lastErrorAt = now;
        after.backoffMs = clampBackoff(after.consecutiveProviderErrors, limits);
        after.retryAt = now + after.backoffMs;
        after.lastError = { status: 429, type: 'rate_limited', message: 'synthetic POST returned HTTP 429', backoffMs: after.backoffMs };
        plan.state.updatedAt = iso(now);
        try {
          persist(statePath, plan.state);
        } catch (err) {
          return {
            status: {
              ...plan.status,
              decision: 'state_write_failed',
              needsAttention: true,
              attention: { reason: 'state_write_failed', at: iso(now), stage: 'post_429', error: errorText(err) },
            },
            exitCode: 3,
            wrote: false,
          };
        }
        status = { ...status, decision: 'backoff_wait', retryAt: iso(after.retryAt), providerError: after.lastError, budget: budgetOf(plan.state, after, limits), planned: null };
      } else {
        after.needsAttention = { reason: 'delivery_uncertain', at: iso(now), httpStatus: outcome.status };
        plan.state.updatedAt = iso(now);
        try {
          persist(statePath, plan.state);
        } catch (err) {
          return {
            status: {
              ...plan.status,
              decision: 'state_write_failed',
              needsAttention: true,
              attention: { reason: 'state_write_failed', at: iso(now), stage: 'post_uncertain', error: errorText(err) },
            },
            exitCode: 3,
            wrote: false,
          };
        }
        status = { ...status, decision: 'needs_attention', needsAttention: true, attention: after.needsAttention, budget: budgetOf(plan.state, after, limits), planned: null };
      }
    } else if (write) {
      plan.state.updatedAt = iso(now);
      try {
        persist(statePath, plan.state);
      } catch (err) {
        return {
          status: {
            ...status,
            decision: 'state_write_failed',
            needsAttention: true,
            attention: { reason: 'state_write_failed', at: iso(now), stage: 'tick', error: errorText(err) },
          },
          exitCode: 3,
          wrote: false,
        };
      }
    }

    if (write) {
      try {
        writeStatus(status);
      } catch {
        status = { ...status, statusWriteError: true };
      }
    }
    return { status, exitCode: status.needsAttention ? 3 : 0, wrote: write };
  } finally {
    release();
  }
}

/* ------------------------------------------------------------------- native */

function isLoopbackHost(hostname) {
  const host = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host === '::1' || host === '::' || host === '0.0.0.0' || /^127\./.test(host);
}

/**
 * Accepts the canonical `{url, password|token}` form and the legacy
 * `{hostname, port, password}` form. Non-loopback targets are rejected.
 */
function resolveService(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('service.json must be an object');
  if (typeof raw.url === 'string' && raw.url.trim()) {
    let parsed;
    try {
      parsed = new URL(raw.url.trim());
    } catch {
      throw new Error('service.json url is not a valid URL');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('service.json url must be http(s)');
    if (parsed.username || parsed.password) throw new Error('service.json url must not embed credentials');
    if (!isLoopbackHost(parsed.hostname)) throw new Error(`service.json url host ${parsed.hostname} is not loopback; refusing`);
    if (!parsed.port) throw new Error('service.json url is missing a port');
    const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
    const host = hostname === '0.0.0.0' || hostname === '::' ? '127.0.0.1' : hostname;
    return { baseUrl: `${parsed.protocol}//${host}:${parsed.port}`, password: raw.password || raw.token || '' };
  }
  const port = Number(raw.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error('service.json legacy form needs a valid port');
  const hostname = raw.hostname || '127.0.0.1';
  if (!isLoopbackHost(hostname)) throw new Error(`service.json hostname ${hostname} is not loopback; refusing`);
  const host = hostname === '0.0.0.0' || hostname === '::' ? '127.0.0.1' : hostname;
  return { baseUrl: `http://${host}:${port}`, password: raw.password || '' };
}

function serviceCandidates() {
  const home = process.env.USERPROFILE || process.env.HOME || '.';
  return [
    path.join(home, '.local', 'state', 'opencode', 'service.json'),
    path.join(home, '.local', 'share', 'opencode', 'service.json'),
    path.join(home, '.config', 'opencode', 'service.json'),
    path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'opencode', 'service.json'),
    path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'opencode', 'service.json'),
  ];
}

/** First existing file wins; a present but unsafe/invalid file is rejected. */
function readService() {
  for (const candidate of serviceCandidates()) {
    if (!fs.existsSync(candidate)) continue;
    return resolveService(readJsonFile(candidate));
  }
  throw new Error('opencode service.json not found; is the opencode server running?');
}

function assertActiveMap(body) {
  if (!body || typeof body !== 'object' || !body.data || typeof body.data !== 'object' || Array.isArray(body.data)) {
    throw new Error('native /api/session/active returned an unexpected shape');
  }
  return body.data;
}

async function request(service, pathname, init, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${service.baseUrl}${pathname}`, {
      method: init.method || 'GET',
      headers: {
        authorization: `Basic ${Buffer.from(`opencode:${service.password || ''}`).toString('base64')}`,
        'content-type': 'application/json',
      },
      body: init.body == null ? undefined : JSON.stringify(init.body),
      signal: controller.signal,
    });
    return { status: response.status, text: await response.text() };
  } finally {
    clearTimeout(timer);
  }
}

async function getJson(service, pathname, fetchImpl) {
  const response = await request(service, pathname, { method: 'GET' }, fetchImpl);
  if (response.status < 200 || response.status >= 300) {
    const err = new Error(`opencode API GET ${pathname} -> HTTP ${response.status}`);
    err.status = response.status;
    throw err;
  }
  if (!response.text) return {};
  try {
    return JSON.parse(response.text);
  } catch {
    throw new Error(`opencode API GET ${pathname} returned non-JSON`);
  }
}

function createApi(options) {
  const fetchImpl = (options && options.fetchImpl) || globalThis.fetch;
  return {
    async getActive() {
      return assertActiveMap(await getJson(readService(), '/api/session/active', fetchImpl));
    },
    async getSession(sessionID) {
      const body = await getJson(readService(), `/api/session/${encodeURIComponent(sessionID)}`, fetchImpl);
      if (!body || !body.data || typeof body.data !== 'object' || Array.isArray(body.data)) {
        throw new Error('native /api/session/{id} returned an unexpected shape');
      }
      return body.data;
    },
    async getMessages(sessionID, query) {
      const limit = (query && query.limit) || 12;
      const body = await getJson(
        readService(),
        `/api/session/${encodeURIComponent(sessionID)}/message?limit=${limit}&order=desc&type=assistant`,
        fetchImpl,
      );
      if (!body || !Array.isArray(body.data)) throw new Error('native message list returned an unexpected shape');
      return body.data;
    },
    async postSynthetic(sessionID, payload) {
      const response = await request(
        readService(),
        `/api/session/${encodeURIComponent(sessionID)}/synthetic`,
        { method: 'POST', body: payload },
        fetchImpl,
      );
      return { status: response.status };
    },
  };
}

/* --------------------------------------------------------------------- cli */

async function main(argv) {
  const args = (argv || process.argv).slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(USAGE);
    return 0;
  }
  const allowed = new Set(['--once', '--apply', '--dry-run']);
  const unknown = args.filter((arg) => !allowed.has(arg));
  if (unknown.length > 0) {
    process.stderr.write(`unknown flag(s): ${unknown.join(' ')}\n${USAGE}`);
    return 2;
  }
  const dir = __dirname;
  const result = await runOnce({
    mode: args.includes('--apply') ? 'apply' : 'dry-run',
    now: Date.now(),
    queuePath: path.join(dir, 'queue.json'),
    statePath: path.join(dir, 'state.json'),
    lockPath: path.join(dir, 'controller.lock'),
    statusPath: path.join(dir, 'status.json'),
    eventsPath: path.join(dir, 'events.log'),
    api: createApi(),
  });
  process.stdout.write(`${JSON.stringify(result.status, null, 2)}\n`);
  return result.exitCode;
}

module.exports = {
  PHASE,
  DEFAULTS,
  ALLOWED_WORKERS,
  buildPlan,
  runOnce,
  acquireLock,
  writeJsonAtomic,
  readState,
  renderPrompt,
  parseSupervisorState,
  lastSupervisorState,
  hasCorrelation,
  clampBackoff,
  validateQueue,
  validateState,
  resolveService,
  assertActiveMap,
  isLoopbackHost,
  createApi,
};

if (require.main === module) {
  main(process.argv)
    .then((code) => { process.exitCode = code; })
    .catch((err) => {
      process.stderr.write(`controller failed: ${err && err.message ? err.message : String(err)}\n`);
      process.exitCode = 1;
    });
}
