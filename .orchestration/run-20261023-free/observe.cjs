'use strict';
// File observation only: no prompts, no provider calls, no retry loops.
const fs = require('node:fs');
const path = require('node:path');

const dir = __dirname;
const statusFile = path.join(dir, 'status.json');
const deadline = Date.parse('2026-10-23T12:20:00Z');
let done = false;
let watcher;
let interval;
let timeout;

function cleanup() {
  if (watcher) watcher.close();
  if (interval) clearInterval(interval);
  if (timeout) clearTimeout(timeout);
}

function inspect() {
  if (done) return;
  try {
    const status = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
    if (!status.finishedAt && !status.halted) return;
    done = true;
    cleanup();
    const tasks = Object.entries(status.tasks || {}).map(([id, task]) => ({
      id,
      phase: task.phase,
      actualModels: task.actualModels || [],
      blockedReason: task.blockedReason || null,
      error: task.error || null,
    }));
    console.log(JSON.stringify({
      event: 'free_run_finished_or_halted',
      finishedAt: status.finishedAt || null,
      halted: status.halted || null,
      admissions: status.admissions,
      workers: status.workers,
      tasks,
    }, null, 2));
  } catch { /* status replacement is atomic but the first read can race */ }
}

watcher = fs.watch(dir, (_event, name) => { if (String(name) === 'status.json') inspect(); });
interval = setInterval(inspect, 60000);
timeout = setTimeout(() => {
  if (done) return;
  done = true;
  cleanup();
  console.log(JSON.stringify({ event: 'observer_timeout', statusFile }));
}, Math.max(1, deadline - Date.now()));
inspect();
