'use strict';
// File-system notification only: zero prompts, provider requests or retry loops.
const fs = require('node:fs');
const path = require('node:path');
const task = 'fcm-recipient-ownership';
let done = false, watcher, timer;
function inspect() {
  if (done) return;
  try {
    const s = JSON.parse(fs.readFileSync(path.join(__dirname, 'status.json'), 'utf8'));
    const item = s.items[task];
    if (!s.halted && !['reported_complete_unaccepted', 'reported_pending', 'idle_without_report', 'still_running_at_budget'].includes(item?.phase)) return;
    done = true; watcher.close(); clearTimeout(timer);
    console.log(JSON.stringify({ event: 'first_GPT_packet_finished_or_safety_stop', phase: item?.phase, actualModels: item?.actualModels, assistantRows: item?.assistantRows, halted: s.halted || null, report: path.join(__dirname, task + '.report.md') }));
  } catch { /* atomic status replacement may briefly be unavailable */ }
}
watcher = fs.watch(__dirname, (_event, name) => { if (String(name) === 'status.json') inspect(); });
timer = setTimeout(() => { done = true; watcher.close(); console.log('Local observer deadline; no completion inferred and no prompt sent.'); }, Math.max(1, Date.parse('2026-10-22T10:26:00Z') - Date.now()));
inspect();
