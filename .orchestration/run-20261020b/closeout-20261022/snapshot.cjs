'use strict';

// Read-only API inventory; never prompts, changes a model, stages, or commits.
const fs = require('node:fs');
const path = require('node:path');
const { createApi } = require('../controller/controller.cjs');
const registry = JSON.parse(fs.readFileSync(
  'C:/Users/DELL/AppData/Local/Temp/opencode/fresh-run-2-20261020.json', 'utf8',
));
const queue = JSON.parse(fs.readFileSync(path.join(__dirname, '../controller/queue.json'), 'utf8'));
const state = JSON.parse(fs.readFileSync(path.join(__dirname, '../controller/state.json'), 'utf8'));
const allowed = new Set(['deepseek-v4.1-flash-free', 'glm-5.3-flash-free']);

(async () => {
  const api = createApi();
  const active = await api.getActive();
  const rows = [];
  for (let offset = 0; offset < registry.sessions.length; offset += 3) {
    const batch = await Promise.all(registry.sessions.slice(offset, offset + 3).map(async (entry) => {
      try {
        const session = await api.getSession(entry.id);
        const messages = await api.getMessages(entry.id, { limit: 100 });
        const latest = messages[0];
        const report = messages.find(m => (m.content || []).some(p => p.type === 'text' && p.text.trim()));
        const text = report ? report.content.filter(p => p.type === 'text').map(p => p.text).join('\n') : '';
        const current = queue.items.find(item => item.ownerSessionID === entry.id);
        const persistedRetry = current && state.items[current.id] && state.items[current.id].retryAt;
        const quotaRetry = latest && latest.error && latest.error.status === 429
          ? Number(latest.time.created) + 30 * 60 * 1000 : 0;
        const retryAt = Math.max(Number(persistedRetry) || 0, quotaRetry);
        return {
          lane: entry.index, name: entry.name, sessionID: entry.id,
          model: session.model, parentID: session.parentID ?? null,
          directory: session.location && session.location.directory,
          permitted: session.model?.providerID === 'opencode' && allowed.has(session.model?.id),
          active: Boolean(active[entry.id]),
          latestAssistantAt: latest && latest.time ? latest.time.created : null,
          error: latest && latest.error ? { type: latest.error.type, status: latest.error.status || null } : null,
          earliestAdmission: retryAt ? new Date(retryAt).toISOString() : null,
          cooldownActive: retryAt > Date.now(),
          lastTextAt: report && report.time ? report.time.created : null,
          claimedCommitCandidates: [...new Set(text.match(/\b[0-9a-f]{7,40}\b/g) || [])],
          statedState: (text.match(/SUPERVISOR_STATE:\s*([A-Z_]+)/g) || []).slice(-1)[0] || null,
        };
      } catch (error) {
        return { lane: entry.index, sessionID: entry.id, readError: error.message };
      }
    }));
    rows.push(...batch);
  }
  const result = { observedAt: new Date().toISOString(), inventoryOnly: true, rows };
  fs.writeFileSync(path.join(__dirname, 'sessions.json'), JSON.stringify(result, null, 2) + '\n');
  for (const row of rows) console.log(JSON.stringify(row));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
