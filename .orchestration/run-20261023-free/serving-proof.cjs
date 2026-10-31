'use strict';
// Read-only serving proof: counts assistant rows per actual model for a session.
// Prints counts only (no prompt/response text, no secrets).
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const service = JSON.parse(
  fs.readFileSync(path.join(os.homedir(), '.local/state/opencode/service.json'), 'utf8')
);
const base = service.url.replace(/\/$/, '');
const headers = {
  Authorization: 'Basic ' + Buffer.from('opencode:' + service.password).toString('base64'),
};

const sid = process.argv[2];
if (!sid) {
  console.error('usage: node serving-proof.cjs <sessionID>');
  process.exit(2);
}

(async () => {
  const res = await fetch(
    `${base}/api/session/${encodeURIComponent(sid)}/message?type=assistant&limit=200&order=desc`,
    { headers }
  );
  if (!res.ok) {
    console.error('HTTP', res.status, (await res.text()).slice(0, 300));
    process.exit(1);
  }
  const data = await res.json();
  const rows = Array.isArray(data) ? data : data.data || [];
  const counts = {};
  let withModel = 0;
  let last = null;
  for (const row of rows) {
    const m = row.model || row.info?.model;
    if (!m || !m.providerID) continue;
    withModel += 1;
    const key = `${m.providerID}/${m.id}`;
    counts[key] = (counts[key] || 0) + 1;
    if (!last) last = key;
  }
  console.log(
    JSON.stringify({ session: sid, assistantRows: rows.length, withModel, counts, newest: last }, null, 2)
  );
})();
