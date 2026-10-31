'use strict';

// Bounded free-model scheduler. It prompts existing root sessions, never edits
// product code, never pushes, and never accepts an owner's completion claim.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const dir = __dirname;
const root = path.resolve(dir, '../..');
const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'queues.json'), 'utf8'));
const statusFile = path.join(dir, 'status.json');
const lockFile = path.join(dir, 'dispatcher.lock');
const stopFile = path.join(dir, 'STOP');
const service = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.local/state/opencode/service.json'), 'utf8'));
const base = service.url.replace(/\/$/, '');
const headers = {
  Authorization: 'Basic ' + Buffer.from('opencode:' + service.password).toString('base64'),
  'Content-Type': 'application/json',
};

const FREE_PRIMARY = 'opencode/deepseek-v4.1-flash-free';
const FREE_FALLBACK = 'opencode/glm-5.3-flash-free';

function isFreeModel(model) {
  if (!model) return false;
  const id = model.id || model.modelID || '';
  if (model.providerID === 'opencode') return /-free$/.test(id) || id === 'big-pickle';
  // Direct OpenCode route for Antigravity Gemini 3.8 Flash. Fixed low/medium/high
  // ids work; the base id with a "default" variant returns 404 on this connection.
  if (model.providerID === 'google') return /^antigravity-gemini-3\.8-flash(-(low|medium|high))?$/.test(id);
  // OpenRouter zero-cost models are a separate free quota from OpenCode Zen.
  if (model.providerID === 'openrouter') return /:free$/.test(id);
  return false;
}
function isQuota(error) {
  if (!error) return false;
  return error.status === 429 || /free-limit|quota|rate.?limit|usage.?limit/i.test(String(error.type || ''));
}
function modelLabel(model) {
  return `${model.providerID}/${model.id}#${model.variant || 'default'}`;
}
function classify(rows, since) {
  const fresh = rows
    .filter(m => m.type === 'assistant' && m.time?.created >= since)
    .sort((a, b) => (b.time?.created || 0) - (a.time?.created || 0));
  const latest = fresh[0];
  if (latest?.error) {
    return { phase: 'blocked', error: { type: latest.error.type, status: latest.error.status }, messageID: latest.id };
  }
  const final = fresh.find(m => m.time?.completed && m.finish !== 'tool-calls' &&
    (m.content || []).some(p => p.type === 'text' && p.text?.trim()));
  if (!final) return { phase: 'idle_without_report' };
  const text = (final.content || []).filter(p => p.type === 'text').map(p => p.text).join('\n');
  return {
    phase: text.trimEnd().endsWith('SUPERVISOR_STATE: COMPLETE') ? 'reported_complete_unaccepted' : 'reported_pending',
    text,
    messageID: final.id,
  };
}

let status = fs.existsSync(statusFile) ? JSON.parse(fs.readFileSync(statusFile, 'utf8')) : {
  runId: cfg.runId,
  startedAt: cfg.startedAt,
  deadline: cfg.deadline,
  primary: modelLabel(cfg.primary),
  fallback: modelLabel(cfg.fallback),
  admissions: 0,
  acceptedAutomatically: false,
  halted: null,
  workers: {},
  tasks: {},
};
status.acceptedAutomatically = false;
if (!status.tasks) status.tasks = {};

const sleepCell = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms) { Atomics.wait(sleepCell, 0, 0, ms); }
function save() {
  status.updatedAt = new Date().toISOString();
  const json = JSON.stringify(status, null, 2);
  let renameError;
  // Windows can briefly refuse the replace while the observer reads the file.
  // Retry, then fall back to a direct write so a read race cannot kill the run.
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      fs.writeFileSync(statusFile + '.tmp', json);
      fs.renameSync(statusFile + '.tmp', statusFile);
      return;
    } catch (error) {
      renameError = error;
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) break;
      sleepSync(100 * (attempt + 1));
    }
  }
  try {
    fs.writeFileSync(statusFile, json);
  } catch (error) {
    throw new Error(`status write failed: ${error.code || error.message}; rename=${renameError?.code || 'none'}`);
  }
}
function log(kind, details) {
  const event = { at: new Date().toISOString(), kind, ...details };
  fs.appendFileSync(path.join(dir, 'events.jsonl'), JSON.stringify(event) + '\n');
  console.log(JSON.stringify(event));
}
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function api(method, uri, body, timeout = 45000) {
  const response = await fetch(base + uri, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${uri.split('?')[0]} HTTP ${response.status} ${text.slice(0, 240)}`);
  return text ? JSON.parse(text) : null;
}
const activeMap = async () => (await api('GET', '/api/session/active')).data;
const messages = async (id) => (await api('GET', `/api/session/${id}/message?type=assistant&limit=120&order=desc`)).data;

function buildPrompt(task) {
  const brief = task.brief ? path.join(root, '.orchestration/run-20261020b/closeout-20261022', task.brief) : '';
  const freePool = (cfg.freePool || []).map(modelLabel).join(', ');
  const reviewRule = task.review === 'two'
    ? 'High-risk packet: use two independent reviews if free quota allows; if it does not, one review plus an explicit gap note.'
    : task.review === 'one'
      ? 'Use one independent review of the frozen final blobs; add a second only if the first finds a material issue.'
      : 'No reviewer child is required for this read-only evidence/QA packet. Do not spawn review-of-review children.';
  return [
    `[Free-model orchestrator ${cfg.runId}] QUEUE_TASK: ${task.id}`,
    `Read ${path.join(dir, 'POLICY.md')} FIRST. The latest user instruction is to use FREE models for every session. Primary ${FREE_PRIMARY}; after a real 429/free-limit use the zero-cost pool (${freePool}) and then ${FREE_FALLBACK}. Never call GPT, OpenAI, or any paid model.`,
    brief
      ? `Resume your existing packet. Brief: ${brief}. Load it selectively; do not redo accepted work.`
      : 'Bounded new QA task. Prior accepted work is not reopened.',
    task.note,
    `Repository scope: ${task.repos.join(', ')}. One owner per repository; other queues may run in other repositories. Do not touch files outside your scope.`,
    `Free-model rules: author on your current free model. Independent review must use a different zero-cost free model from the author (one of ${FREE_PRIMARY}, ${FREE_FALLBACK}, or the OpenRouter free pool). Reviewers are foreground, read-only, spawn no descendants, and inspect frozen final blobs. ${reviewRule}`,
    'Quality: reproduce before fixing; positive and negative tests; no weakened assertions; isolated exact-bundle typecheck/tests/build; exact local commit only after review and gate.',
    'Safety: no push, deploy, external PR, email, real payment/refund, rider booking, vendor or production write, PII export, secret or credential change, auth/rule weakening, broad staging, foreign staging, reset/stash of foreign work, or forced worktree deletion. HTTP 200, a mock, a receipt, or a local test is not live fulfilment.',
    'Report at most 400 words: QUEUE_TASK, final paths/blobs, actual reviewer models and verdicts, RED/GREEN evidence, gate exits, local SHA(s), remaining limits. `SUPERVISOR_STATE: COMPLETE` only if the scoped packet is really finished.',
    `Deadline ${cfg.deadline}. Stop starting new work then and leave a resumable snapshot. Do not wait for further instructions.`,
  ].join('\n\n');
}

async function setModel(sessionID, model) {
  await api('POST', `/api/session/${sessionID}/model`, { model });
}
async function putInstruction(sessionID) {
  const freePool = (cfg.freePool || []).map(modelLabel).join(', ');
  const value = `FREE MODEL WINDOW ${cfg.runId}. Read ${path.join(dir, 'POLICY.md')} on admission. Use ${FREE_PRIMARY}; after a real 429 use the zero-cost pool (${freePool}) then ${FREE_FALLBACK}. Never GPT/paid. Supersedes older model rules for this run, not scope or safety. One owner per repo. WAIT for the run task prompt; this entry is not an admission.`;
  await api('PUT', `/api/experimental/session/${sessionID}/instructions/entries/free-window-20261023`, { value });
  await api('PUT', `/api/experimental/session/${sessionID}/instructions/entries/burgonomics-gpt-window`, { value });
}

async function waitReposIdle(repos, taskId, queueName) {
  while (Date.now() < Date.parse(cfg.deadline) && !status.halted && !fs.existsSync(stopFile)) {
    const active = await activeMap();
    const busy = Object.entries(cfg.tasks)
      .filter(([id, t]) => id !== taskId && t.repos.some(r => repos.includes(r)) && active[t.sessionID])
      .map(([id]) => id);
    if (!busy.length) return true;
    log('waiting_repo', { queue: queueName, task: taskId, busy });
    await sleep(15000);
  }
  return false;
}

async function waitForExecution(sessionID, since, deadlineMs) {
  const limit = Math.min(deadlineMs, Date.now() + 8 * 60000);
  while (Date.now() < limit) {
    const active = await activeMap();
    const rows = await messages(sessionID);
    if (active[sessionID] || rows.some(m => m.time?.created >= since)) return { started: true };
    const inbox = (await api('GET', `/api/session/${sessionID}/inbox`)).data;
    if (!inbox.length && !active[sessionID]) return { started: false, reason: 'prompt_not_draining' };
    await sleep(5000);
  }
  return { started: false, reason: 'execution_start_timeout' };
}

async function waitForCompletion(sessionID, deadlineMs) {
  while (Date.now() < deadlineMs) {
    const active = await activeMap();
    if (!active[sessionID]) return { idle: true };
    const remaining = deadlineMs - Date.now();
    if (remaining <= 0) break;
    try {
      await api('POST', `/api/experimental/session/${sessionID}/wait`, undefined, Math.min(5 * 60000, remaining));
    } catch { /* timeout is not proof of idle; loop re-checks active */ }
    await sleep(2000);
  }
  return { idle: false };
}

async function runTask(queueName, taskId) {
  const task = cfg.tasks[taskId];
  if (!task) throw new Error('unknown task ' + taskId);
  const item = status.tasks[taskId] ||= {
    lane: task.lane,
    sessionID: task.sessionID,
    repos: task.repos,
    phase: 'queued',
    attempts: [],
  };
  if (item.phase !== 'queued') return;

  const reposFree = await waitReposIdle(task.repos, taskId, queueName);
  if (!reposFree) {
    item.phase = 'blocked';
    item.blockedReason = 'deadline_or_stop_before_admission';
    save();
    return;
  }
  if (fs.existsSync(stopFile) || Date.now() > Date.parse(cfg.deadline) || status.halted) {
    item.blockedReason = 'stopped_before_admission';
    save();
    return;
  }

  const session = (await api('GET', `/api/session/${task.sessionID}`)).data;
  if (session.parentID || path.resolve(session.location.directory).toLowerCase() !== root.toLowerCase()) {
    item.phase = 'blocked';
    item.blockedReason = 'session_scope_mismatch';
    save();
    return;
  }
  const inbox = (await api('GET', `/api/session/${task.sessionID}/inbox`)).data;
  if (inbox.length) {
    item.phase = 'blocked';
    item.blockedReason = `pending_inbox:${inbox.length}`;
    save();
    return;
  }

  const plan = [
    { model: cfg.primary, cooldownMs: 0 },
    { model: cfg.primary, cooldownMs: 240000 },
    ...(cfg.freePool || []).map(model => ({ model, cooldownMs: 0 })),
    { model: cfg.fallback, cooldownMs: 240000 },
  ];
  const deadlineMs = Date.parse(cfg.deadline);
  for (let index = 0; index < plan.length; index++) {
    const { model, cooldownMs } = plan[index];
    if (cooldownMs > 0) {
      item.phase = 'cooling_down';
      item.cooldownUntil = new Date(Date.now() + cooldownMs).toISOString();
      save();
      log('cooldown', { queue: queueName, task: taskId, model: modelLabel(model), waitMs: cooldownMs });
      await sleep(cooldownMs);
      if (status.halted || fs.existsSync(stopFile) || Date.now() > deadlineMs) {
        item.phase = 'blocked';
        item.blockedReason = 'halted_during_cooldown';
        save();
        return;
      }
    }
    await setModel(task.sessionID, model);
    await putInstruction(task.sessionID);
    const since = Date.now();
    const attempt = {
      model: modelLabel(model),
      admittedAt: new Date(since).toISOString(),
      phase: 'admission_reserved',
    };
    item.attempts.push(attempt);
    item.phase = 'admission_reserved';
    item.currentModel = attempt.model;
    status.admissions++;
    save();

    let admission;
    try {
      admission = await api('POST', `/api/session/${task.sessionID}/synthetic`, {
        text: buildPrompt(task),
        delivery: 'queue',
        description: `Free owner lane ${task.lane}: ${task.id}`,
        metadata: { orchestratorRun: cfg.runId, taskId: task.id, model: attempt.model },
      });
    } catch (error) {
      attempt.phase = 'admission_transport_error';
      attempt.error = { type: 'admission_transport', message: error.message };
      item.phase = 'blocked';
      item.blockedReason = 'admission_transport_error';
      save();
      log('admission_error', { queue: queueName, task: taskId, error: error.message });
      return;
    }
    attempt.messageID = admission.data.id;
    item.messageID = attempt.messageID;
    item.phase = 'admitted_unverified';
    save();
    log('admitted', { queue: queueName, lane: task.lane, task: taskId, model: attempt.model, messageID: attempt.messageID });

    const execution = await waitForExecution(task.sessionID, since, deadlineMs);
    if (!execution.started) {
      attempt.phase = execution.reason;
      item.phase = 'blocked';
      item.blockedReason = execution.reason;
      save();
      log('not_started', { queue: queueName, task: taskId, reason: execution.reason });
      return;
    }

    const completion = await waitForCompletion(task.sessionID, deadlineMs);
    const rows = await messages(task.sessionID);
    const fresh = rows.filter(m => m.type === 'assistant' && m.time?.created >= since);
    item.actualModels = [...new Set(fresh.map(m => `${m.model?.providerID}/${m.model?.id}`))];
    item.assistantRows = fresh.length;
    if (fresh.some(m => !isFreeModel(m.model))) {
      item.phase = 'model_violation';
      item.blockedReason = 'non_free_actual_model';
      status.halted = `non_free_model:${taskId}`;
      save();
      log('model_violation', { queue: queueName, task: taskId, actualModels: item.actualModels });
      return;
    }
    const result = completion.idle ? classify(rows, since) : { phase: 'still_running' };
    attempt.phase = result.phase;
    attempt.error = result.error || null;
    attempt.finishedAt = new Date().toISOString();
    if (result.text) {
      const reportFile = path.join(dir, taskId + '.report.md');
      fs.writeFileSync(reportFile, result.text);
      item.report = reportFile;
    }
    const errorType = result.error?.type || '';
    const retryable = isQuota(result.error) || (errorType.startsWith('provider.') && errorType !== 'provider.aborted');
    if (result.phase === 'blocked' && retryable && index < plan.length - 1) {
      item.phase = 'retrying_free';
      item.lastError = result.error;
      save();
      log('free_retry', {
        queue: queueName,
        task: taskId,
        attempt: index + 1,
        error: result.error,
        next: modelLabel(plan[index + 1].model),
        cooldownMs: plan[index + 1].cooldownMs,
      });
      continue;
    }
    Object.assign(item, {
      phase: result.phase,
      finishedAt: new Date().toISOString(),
      messageID: result.messageID || item.messageID,
    });
    if (result.error) item.error = result.error;
    if (result.phase === 'still_running') item.blockedReason = 'deadline_reached_while_running';
    if (result.phase === 'blocked' && isQuota(result.error)) {
      item.blockedReason = 'free_quota_exhausted';
      status.halted = `free_quota:${taskId}`;
    }
    save();
    log('observed', {
      queue: queueName,
      lane: task.lane,
      task: taskId,
      phase: item.phase,
      actualModels: item.actualModels,
      error: item.error || null,
    });
    return;
  }
}

async function runQueue(name, ids) {
  status.workers[name] = { state: 'running', current: null };
  save();
  for (const taskId of ids) {
    if (status.halted || fs.existsSync(stopFile) || Date.now() > Date.parse(cfg.deadline)) break;
    status.workers[name].current = taskId;
    save();
    try {
      await runTask(name, taskId);
    } catch (error) {
      status.workers[name].error = error.message;
      save();
      log('task_error', { queue: name, task: taskId, error: error.message });
      break;
    }
    const item = status.tasks[taskId];
    status.workers[name].current = null;
    if (item?.phase === 'still_running') break;
    save();
  }
  status.workers[name].state = 'done';
  status.workers[name].current = null;
  save();
}

async function waitAllIdle(deadlineMs) {
  while (Date.now() < deadlineMs) {
    const active = await activeMap();
    if (!Object.values(cfg.tasks).some(t => active[t.sessionID])) return true;
    await sleep(30000);
  }
  return false;
}

async function recoverTask(taskId) {
  const item = status.tasks[taskId];
  if (!item || item.phase !== 'admitted_unverified') return;
  const active = await activeMap();
  if (active[item.sessionID]) {
    log('recovering_active_task', { task: taskId });
    const completion = await waitForCompletion(item.sessionID, Date.parse(cfg.deadline));
    if (!completion.idle) {
      item.phase = 'still_running';
      item.blockedReason = 'recovery_wait_deadline';
      save();
      return;
    }
  }
  const since = Date.parse(item.attempts?.[0]?.admittedAt || item.admittedAt || 0);
  const rows = await messages(item.sessionID);
  const fresh = rows.filter(m => m.type === 'assistant' && m.time?.created >= since);
  item.actualModels = [...new Set(fresh.map(m => `${m.model?.providerID}/${m.model?.id}`))];
  item.assistantRows = fresh.length;
  if (fresh.some(m => !isFreeModel(m.model))) {
    item.phase = 'model_violation';
    status.halted = `non_free_model:${taskId}`;
    save();
    log('model_violation', { task: taskId, actualModels: item.actualModels });
    return;
  }
  const result = classify(rows, since);
  if (result.text) {
    const reportFile = path.join(dir, taskId + '.report.md');
    fs.writeFileSync(reportFile, result.text);
    item.report = reportFile;
  }
  item.recoveries = (item.recoveries || 0) + 1;
  item.finishedAt = new Date().toISOString();
  if (result.phase === 'blocked' || result.phase === 'idle_without_report') {
    if (item.recoveries <= 2) {
      item.phase = 'queued';
      item.blockedReason = 'recovered_interrupted_turn';
      if (result.error) item.lastError = result.error;
    } else {
      item.phase = 'blocked';
      item.blockedReason = 'recovery_limit';
      item.error = result.error;
    }
  } else {
    item.phase = result.phase;
    if (result.error) item.error = result.error;
    if (result.messageID) item.messageID = result.messageID;
  }
  save();
  log('recovered', { task: taskId, phase: item.phase, actualModels: item.actualModels, recoveries: item.recoveries });
}

async function runSerial(ids) {
  status.workers.serial = { state: 'running', current: null };
  save();
  for (const taskId of ids) {
    if (status.halted || fs.existsSync(stopFile) || Date.now() > Date.parse(cfg.deadline)) break;
    await recoverTask(taskId);
    const recovered = status.tasks[taskId];
    if (recovered?.phase === 'still_running') break;
    if (recovered?.phase !== 'queued') continue;
    status.workers.serial.current = taskId;
    save();
    try {
      await runTask('serial', taskId);
    } catch (error) {
      status.workers.serial.error = error.message;
      save();
      log('task_error', { queue: 'serial', task: taskId, error: error.message });
      break;
    }
    status.workers.serial.current = null;
    save();
  }
  status.workers.serial.state = 'done';
  status.workers.serial.current = null;
  save();
}

async function main() {
  if (status.finishedAt) {
    console.log('run already finished; refusing a duplicate admission');
    return;
  }
  if (status.halted) {
    console.log('run is halted: ' + status.halted);
    return;
  }
  const fd = fs.openSync(lockFile, 'wx');
  fs.writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  try {
    const pluginQuery = '?location[directory]=' + encodeURIComponent(root);
    const plugins = await api('GET', '/api/plugin' + pluginQuery);
    const list = Array.isArray(plugins) ? plugins : plugins.data || [];
    if (list.some(p => p.id === 'chatgpt-fallback')) {
      throw new Error('project automatic fallback is active; it could switch a free session to a paid model');
    }
    const active = await activeMap();
    const alreadyActive = Object.entries(cfg.tasks)
      .filter(([taskId, task]) => active[task.sessionID] && status.tasks[taskId]?.phase !== 'admitted_unverified')
      .map(([taskId]) => taskId);
    if (alreadyActive.length) throw new Error('owned session already active without recovery state: ' + alreadyActive.join(','));

    for (const [taskId, task] of Object.entries(cfg.tasks)) {
      status.tasks[taskId] ||= {
        lane: task.lane,
        sessionID: task.sessionID,
        repos: task.repos,
        phase: 'queued',
        attempts: [],
      };
    }
    save();
    log('prepared', { tasks: Object.keys(cfg.tasks).length, primary: modelLabel(cfg.primary), fallback: modelLabel(cfg.fallback), concurrency: 'root+customer+partner' });

    await runSerial(cfg.serialOrder);
    status.finishedAt = new Date().toISOString();
    save();
    log('finished', { admissions: status.admissions, halted: status.halted || null });
  } catch (error) {
    status.halted = error.message;
    save();
    log('safety_stop', { reason: error.message });
    process.exitCode = 1;
  } finally {
    fs.closeSync(fd);
    try { fs.unlinkSync(lockFile); } catch { /* lock already gone */ }
  }
}

module.exports = { classify, isQuota, isFreeModel, buildPrompt };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
