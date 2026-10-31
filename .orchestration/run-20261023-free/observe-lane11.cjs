'use strict';
// Local observation only. No prompts, no provider calls.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const service = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.local/state/opencode/service.json'), 'utf8'));
const base = service.url.replace(/\/$/, '');
const headers = { Authorization: 'Basic ' + Buffer.from('opencode:' + service.password).toString('base64') };
const id = 'ses_ea5c87669ffeLD1vE6kugwmFVm';
const deadline = Date.parse('2026-10-23T06:00:00Z');
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  while (Date.now() < deadline) {
    const active = (await (await fetch(base + '/api/session/active', { headers })).json()).data;
    if (!active[id]) {
      console.log(JSON.stringify({ event: 'lane11_idle', at: new Date().toISOString() }));
      return;
    }
    await sleep(15000);
  }
  console.log(JSON.stringify({ event: 'lane11_watch_timeout', at: new Date().toISOString() }));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
