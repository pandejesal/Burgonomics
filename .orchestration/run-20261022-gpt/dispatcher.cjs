'use strict';
// Bounded native-session dispatcher. Local observation is not an LLM call.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const root = path.resolve(__dirname, '../..');
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'tasks.json'), 'utf8'));
const file = path.join(__dirname, 'status.json');
const svc = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.local/state/opencode/service.json'), 'utf8'));
const base = svc.url.replace(/\/$/, '');
const headers = { Authorization: 'Basic ' + Buffer.from('opencode:' + svc.password).toString('base64'), 'Content-Type': 'application/json' };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function classify(rows, since) {
  const fresh = rows.filter(m => m.type === 'assistant' && m.time.created >= since);
  const failed = fresh.find(m => m.error);
  if (failed) return { phase: 'blocked', error: { type: failed.error.type, status: failed.error.status } };
  const m = fresh.find(m => m.time.completed && m.finish !== 'tool-calls' &&
    (m.content || []).some(p => p.type === 'text' && p.text.trim()));
  if (!m) return { phase: 'idle_without_report' };
  const text = m.content.filter(p => p.type === 'text').map(p => p.text).join('\n');
  return { phase: text.trimEnd().endsWith('\nSUPERVISOR_STATE: COMPLETE') ? 'reported_complete_unaccepted' : 'reported_pending', text, messageID: m.id };
}
const eligible = (status, now) => now < Date.parse(cfg.deadline) && status.admissions < cfg.maxAdmissions && !status.halted;
async function api(method, uri, body, timeout = 45000) {
  const r = await fetch(base + uri, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
  if (!r.ok) throw Error(`${method} ${uri.split('?')[0]} HTTP${r.status}`);
  const t = await r.text(); return t ? JSON.parse(t) : null;
}
const messages = async id => (await api('GET', `/api/session/${id}/message?type=assistant&limit=150&order=desc`)).data;

async function main() {
  const lock = path.join(__dirname, 'dispatcher.lock'), fd = fs.openSync(lock, 'wx');
  fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  const s = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) :
    { runId: cfg.runId, deadline: cfg.deadline, admissions: 0, acceptedAutomatically: false, items: {} };
  const save = () => { s.updatedAt = new Date().toISOString(); fs.writeFileSync(file + '.tmp', JSON.stringify(s, null, 2)); fs.renameSync(file + '.tmp', file); };
  const log = (kind, data = {}) => { const x = { at: new Date().toISOString(), kind, ...data }; fs.appendFileSync(path.join(__dirname, 'events.jsonl'), JSON.stringify(x) + '\n'); console.log(JSON.stringify(x)); };
  try {
    const p = await api('GET', '/api/plugin?location[directory]=' + encodeURIComponent(root));
    if ((Array.isArray(p) ? p : p.data).some(x => x.id === 'chatgpt-fallback')) throw Error('workspace automatic fallback still active');
    for (const t of cfg.tasks) s.items[t.id] ||= { lane: t.lane, sessionID: t.sessionID, phase: 'queued' };
    save();
    for (const t of cfg.tasks) {
      const item = s.items[t.id];
      if (item.phase !== 'queued') continue; // never resend an uncertain reservation
      if (!eligible(s, Date.now())) break;
      if (s.lastAdmissionAt) await pause(Math.max(0, Date.parse(s.lastAdmissionAt) + cfg.spacingMs - Date.now()));
      if (!eligible(s, Date.now()) || fs.existsSync(path.join(__dirname, 'STOP'))) break;
      const active = (await api('GET', '/api/session/active')).data;
      if (cfg.tasks.some(x => active[x.sessionID])) throw Error('another owned root active: no duplicate/overlap');
      const session = (await api('GET', `/api/session/${t.sessionID}`)).data;
      if (session.parentID || session.location.directory.toLowerCase() !== root.toLowerCase()) throw Error('session scope mismatch');
      if ((await api('GET', `/api/session/${t.sessionID}/inbox`)).data.length) throw Error('pending inbox: inspect before resume');
      await api('POST', `/api/session/${t.sessionID}/model`, { model: cfg.model });
      const brief = t.brief ? path.join(root, '.orchestration/run-20261020b/closeout-20261022', t.brief) : '';
      const text = [
        `[GPT orchestrator ${cfg.runId}] QUEUE_TASK: ${t.id}`,
        `Read ${path.join(__dirname, 'POLICY.md')} FIRST. Latest user allows GPT primary, superseding older free-only/expired deadline clauses, NOT safety/scope. Primary openai/gpt-6.1-sol#low; independent GPT review then separate GPT verifier authorized. Unavailable free-provider retries forbidden.`,
        brief ? `Resume existing packet; scope/requirements in ${brief}. Read selectively; no redo of accepted work.` : 'Bounded new QA task below; previous accepted work is not reopened.',
        t.note,
        `Only this root is admitted; required local gate slot(s) granted. Stop starting new work at ${cfg.deadline}.`,
        'At most2 sequential FOREGROUND independent READONLY review children, no descendants; explicitly select openai/gpt-6.1-sol#low. Do not leave an active background reviewer when returning. Existing review transfers require exact blobs. No full-history dumps or repetitive loops. Keep report<=400words; exact paths/hashes/actual serving models/verdicts/RED/GREEN/gate exits/localSHAs orBLOCKED. No pushes/deploys/provider calls/money/riders/PII/secrets/auth weakening/foreign staging/worktree deletes. Main accepts separately.',
      ].join('\n');
      item.phase = 'admission_reserved'; item.admittedAt = new Date().toISOString();
      s.admissions++; s.lastAdmissionAt = item.admittedAt; save();
      const admission = await api('POST', `/api/session/${t.sessionID}/synthetic`, { text, delivery: 'queue', description: `GPT owner ${t.lane}: ${t.id}`, metadata: { orchestratorRun: cfg.runId } });
      item.messageID = admission.data.id; item.phase = 'admitted_unverified'; save(); log('admitted', { lane: t.lane, task: t.id });
      await pause(5000); // allow drain startup before one bounded long-poll
      let idle = false;
      try {
        await api('POST', `/api/experimental/session/${t.sessionID}/wait`, undefined,
          Math.max(1, Math.min(Date.parse(cfg.deadline) - Date.now(), 35 * 60000)));
        idle = true;
      } catch {
        idle = !(await api('GET', '/api/session/active')).data[t.sessionID];
      }
      const rows = await messages(t.sessionID), fresh = rows.filter(m => m.time.created >= Date.parse(item.admittedAt));
      const r = idle ? classify(rows, Date.parse(item.admittedAt)) : { phase: 'still_running_at_budget' };
      const { text: report, ...details } = r; Object.assign(item, details);
      item.actualModels = [...new Set(fresh.map(m => `${m.model.providerID}/${m.model.id}`))];
      item.assistantRows = fresh.length; item.finishedAt = new Date().toISOString();
      if (report) fs.writeFileSync(path.join(__dirname, t.id + '.report.md'), report);
      if (!fresh.length) s.halted = 'no_fresh_execution_evidence';
      if (fresh.some(m => m.model.providerID !== 'openai' || !m.model.id.startsWith('gpt-'))) s.halted = 'actual_model_violation';
      if (fresh.some(m => m.error?.status === 429 || /provider\.|auth|quota|fund|limit/.test(m.error?.type || ''))) s.halted = 'provider_capacity_auth_or_unsupported_model';
      if (!idle) s.halted = 'root_still_running_do_not_overlap';
      save(); log('observed', { lane: t.lane, task: t.id, phase: item.phase, actualModels: item.actualModels, error: item.error || null });
      if (s.halted) break;
    }
    s.finishedAt = new Date().toISOString(); save(); log('finished', { admissions: s.admissions, halted: s.halted || null });
  } catch (e) { s.halted = e.message; save(); log('safety_stop', { reason: e.message }); process.exitCode = 1; }
  finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}
module.exports = { classify, eligible };
if (require.main === module) main().catch(e => { console.error(e.message); process.exitCode = 1; });
