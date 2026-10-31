'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const https = require('node:https');
const http2 = require('node:http2');
const { spawn, spawnSync } = require('node:child_process');
const { createRequire, isBuiltin } = require('node:module');
const assert = require('node:assert/strict');

const BASE = __dirname;
const PROJECT = 'demo-burgonomics-qa-20261028';
const JAVA = 'C:\\Program Files\\Android\\Android Studio\\jbr\\bin\\java.exe';
const KEYTOOL = 'C:\\Program Files\\Android\\Android Studio\\jbr\\bin\\keytool.exe';
const JAR = 'C:\\Users\\DELL\\.cache\\firebase\\emulators\\cloud-firestore-emulator-v1.22.0.jar';
const PACKAGE = 'C:\\Users\\DELL\\Desktop\\Burgonomics\\.swarm-worktrees\\backend-email-contract-20261029\\functions\\package.json';
const PASSPHRASE = 'LOCAL_QA_SYNTHETIC_NOT_A_MERCHANT_SECRET';

function safeLabel(s) {
  if (!/^[a-zA-Z0-9_-]+$/.test(s || '')) throw new Error('Label must be a nonempty safe filename');
  return s;
}
function sha(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function ensureInside(file) {
  const rel = path.relative(BASE, file);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Write/load outside harness refused: ' + file);
  return file;
}
function writeJson(file, data) {
  ensureInside(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}
function syntheticEnv(extra = {}) {
  const env = {};
  const allowed = new Set(['systemroot', 'windir', 'path', 'pathext', 'comspec', 'processor_architecture', 'number_of_processors']);
  for (const [key, value] of Object.entries(process.env)) if (allowed.has(key.toLowerCase())) env[key] = value;
  const runtime = path.join(BASE, 'runtime');
  fs.mkdirSync(runtime, { recursive: true });
  return { ...env, TEMP: runtime, TMP: runtime, HOME: runtime, USERPROFILE: runtime,
    VITEST: 'true', NODE_ENV: 'test', BURGONOMICS_ENV: 'dev',
    GCLOUD_PROJECT: PROJECT, GOOGLE_CLOUD_PROJECT: PROJECT, FIREBASE_PROJECT_ID: PROJECT,
    GCE_METADATA_HOST: '127.0.0.1:1', GCE_METADATA_IP: '127.0.0.1', METADATA_SERVER_DETECTION: 'none',
    ...extra };
}
function prepareTls() {
  const dir = path.join(BASE, 'tls');
  fs.mkdirSync(dir, { recursive: true });
  const pfx = path.join(dir, 'local-vendor.p12');
  const pem = path.join(dir, 'local-vendor.pem');
  if (!fs.existsSync(pfx)) {
    const args = ['-J-Djava.io.tmpdir=' + path.join(BASE, 'runtime'), '-genkeypair', '-alias', 'local-qa-vendor', '-keyalg', 'RSA', '-keysize', '2048', '-sigalg', 'SHA256withRSA', '-storetype', 'PKCS12', '-keystore', pfx, '-storepass', PASSPHRASE, '-keypass', PASSPHRASE, '-dname', 'CN=localhost,OU=LOCAL QA ONLY,O=Synthetic Test Fixture,C=ZZ', '-validity', '30', '-ext', 'SAN=DNS:localhost,IP:127.0.0.1', '-ext', 'BC=ca:true', '-ext', 'KU=digitalSignature,keyEncipherment', '-ext', 'EKU=serverAuth', '-noprompt'];
    const result = spawnSync(KEYTOOL, args, { cwd: BASE, env: syntheticEnv(), encoding: 'utf8', timeout: 30000 });
    if (result.status !== 0) throw new Error('Local synthetic keytool generation failed: ' + result.stderr);
    fs.writeFileSync(path.join(dir, 'generation.txt'), 'Synthetic localhost test key only.\n' + result.stdout + result.stderr);
  }
  if (!fs.existsSync(pem)) {
    const result = spawnSync(KEYTOOL, ['-exportcert', '-rfc', '-alias', 'local-qa-vendor', '-keystore', pfx, '-storepass', PASSPHRASE, '-file', pem], { cwd: BASE, env: syntheticEnv(), encoding: 'utf8', timeout: 30000 });
    if (result.status !== 0) throw new Error('Local certificate export failed: ' + result.stderr);
  }
  return { pfx, pem, passphrase: PASSPHRASE };
}
function verifySnapshot(label) {
  const dir = path.join(BASE, 'snapshots', safeLabel(label));
  const manifestFile = path.join(dir, 'manifest.json');
  if (!fs.existsSync(manifestFile)) throw new Error('Snapshot manifest not found; capture first');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  for (const file of manifest.files) {
    const frozen = ensureInside(path.join(dir, file.candidate, file.relativePath));
    if (sha(fs.readFileSync(frozen)) !== file.sha256) throw new Error('Frozen source hash mismatch: ' + frozen);
  }
  return { dir, manifest, manifestSha256: sha(fs.readFileSync(manifestFile)) };
}
function installNetworkGuard(ports, record) {
  const allowedPorts = new Set(ports.map(Number));
  const hosts = new Set(['127.0.0.1', '::1', 'localhost']);
  const assertDestination = (host, port) => {
    if (!hosts.has(String(host).replace(/^\[|\]$/g, '').toLowerCase()) || !allowedPorts.has(Number(port))) {
      const detail = { host: String(host), port: Number(port) };
      record({ event: 'network-refused-before-connect', ...detail });
      const err = new Error('QA_NETWORK_REFUSED: only explicit loopback harness ports are permitted');
      err.code = 'QA_NETWORK_REFUSED';
      throw err;
    }
  };
  const originalConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    // net.createConnection supplies a single already-normalized args array;
    // direct Socket.connect supplies ordinary positional arguments.
    const normalized = args.length === 1 && Array.isArray(args[0]) ? args[0] : net._normalizeArgs(args);
    const options = normalized[0];
    if (options.path) throw new Error('QA_NETWORK_REFUSED: IPC sockets not used by this harness');
    assertDestination(options.host || 'localhost', options.port);
    return originalConnect.apply(this, args);
  };
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = function (input, init) {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    assertDestination(url.hostname, url.port || (url.protocol === 'https:' ? 443 : 80));
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('QA_NETWORK_REFUSED: invalid URL');
    // This is a policy gate ONLY: no response, redirect, retry, body or tx is mocked.
    record({ event: 'native-fetch-start', url: url.href, method: init?.method || 'GET', redirect: init?.redirect || 'follow-default' });
    return nativeFetch.call(globalThis, input, init);
  };
  return { assertDestination, nativeFetch };
}
async function closeServer(server, sockets) {
  for (const socket of sockets) socket.destroy();
  if (!server.listening) return;
  await new Promise(resolve => server.close(resolve));
}
async function reserveCheck(ports) {
  const servers = [];
  try {
    for (const port of ports) {
      const s = net.createServer();
      await new Promise((resolve, reject) => { s.once('error', reject); s.listen(port, '127.0.0.1', resolve); });
      servers.push(s);
    }
  } finally { await Promise.all(servers.map(s => new Promise(resolve => s.close(resolve)))); }
}
function deadline(promise, ms, label) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Deadline: ' + label)), ms); })]).finally(() => clearTimeout(timer));
}
async function createRecorder(port, tls, record, name) {
  const requests = [];
  const errors = [];
  const sockets = new Set();
  let handler = async () => ({ status: 500, json: { error: 'No explicit local vendor scenario selected' } });
  const server = https.createServer({ pfx: fs.readFileSync(tls.pfx), passphrase: tls.passphrase }, async (req, res) => {
    const chunks = [];
    try {
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString('utf8');
      const item = { sequence: requests.length + 1, server: name, method: req.method, path: req.url, headers: req.headers, body };
      requests.push(item);
      record({ event: 'vendor-wire-request', ...item });
      const response = await handler(item);
      if (response && response.destroy) { req.socket.destroy(); return; }
      res.writeHead(response.status || 200, { 'content-type': 'application/json', ...response.headers });
      res.end(response.json !== undefined ? JSON.stringify(response.json) : (response.body || ''));
    } catch (err) {
      errors.push(err);
      record({ event: 'recorder-handler-error', server: name, message: err.message, stack: err.stack });
      if (!res.headersSent) res.writeHead(599, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ qaHandlerError: err.message }));
    }
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  record({ event: 'recorder-listening', name, port, address: server.address() });
  return { port, origin: `https://127.0.0.1:${port}`, requests, errors,
    setHandler(fn) { handler = fn; }, close: () => closeServer(server, sockets) };
}
async function createCommitProxy(port, emulatorPort, record) {
  const server = http2.createServer();
  const sessions = new Set();
  const requests = [];
  let failCommits = false;
  let commitGate = null;
  let commitType = null;
  const decodeCommit = frame => {
    if (frame.length < 5 || frame[0] !== 0 || frame.length !== frame.readUInt32BE(1) + 5) throw new Error('Unsupported gRPC frame for deterministic Commit hold');
    if (!commitType) {
      const deps = createRequire(PACKAGE);
      const root = deps('google-gax').protobuf.Root.fromJSON(deps('@google-cloud/firestore/build/protos/v1.json'));
      commitType = root.lookupType('google.firestore.v1.CommitRequest');
    }
    return commitType.decode(frame.subarray(5));
  };
  server.on('session', session => { sessions.add(session); session.once('close', () => sessions.delete(session)); session.on('error', () => {}); });
  server.on('stream', (down, headers) => {
    down.on('error', () => {});
    const rpc = { sequence: requests.length + 1, path: headers[':path'], blocked: false };
    requests.push(rpc);
    if (failCommits && String(headers[':path']).endsWith('/Commit')) {
      rpc.blocked = true;
      record({ event: 'grpc-commit-refused', ...rpc });
      // A real gRPC transport response, after the SDK serialized a real Commit.
      // Code 7 is deliberately non-retryable, so an unbounded outage does not
      // make deterministic tests spend SDK retry/deadline minutes.
      down.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true });
      down.once('wantTrailers', () => down.sendTrailers({ 'grpc-status': '7', 'grpc-message': 'QA all Commit RPCs denied after durable claim; synthetic local fault' }));
      down.resume();
      down.end();
      return;
    }
    const forward = bufferedFrame => {
      record({ event: 'grpc-forward', ...rpc, ...(bufferedFrame ? { originalFrameSha256: sha(bufferedFrame) } : {}) });
      const upstream = http2.connect(`http://127.0.0.1:${emulatorPort}`);
      sessions.add(upstream);
      upstream.on('error', err => { record({ event: 'grpc-proxy-upstream-error', message: err.message }); down.close(http2.constants.NGHTTP2_INTERNAL_ERROR); });
      upstream.once('close', () => sessions.delete(upstream));
      const up = upstream.request({ ...headers, ':authority': `127.0.0.1:${emulatorPort}` });
      let trailers = {};
      up.on('response', h => { if (!down.destroyed) down.respond(h, { waitForTrailers: true }); });
      up.on('trailers', h => { trailers = h; });
      down.on('wantTrailers', () => { if (!down.destroyed) down.sendTrailers(trailers); });
      up.on('end', () => { if (!down.destroyed) down.end(); upstream.close(); });
      up.on('error', () => { if (!down.destroyed) down.close(http2.constants.NGHTTP2_INTERNAL_ERROR); upstream.close(); });
      down.on('aborted', () => { up.close(); upstream.close(); });
      if (bufferedFrame) up.end(bufferedFrame); else down.pipe(up);
      up.pipe(down, { end: false });
    };
    if (commitGate && String(headers[':path']).endsWith('/Commit')) {
      const chunks = [];
      down.on('data', chunk => chunks.push(chunk));
      down.on('end', async () => {
        try {
          const originalFrame = Buffer.concat(chunks);
          const request = decodeCommit(originalFrame);
          const gate = commitGate;
          if (gate && gate.predicate(request)) {
            commitGate = null;
            rpc.held = true;
            const evidence = { rpcSequence: rpc.sequence, transactionBytes: request.transaction?.length || 0, originalFrameSha256: sha(originalFrame), writes: request.writes.map(w => ({ document: w.update?.name || w.delete, fields: Object.keys(w.update?.fields || {}) })) };
            record({ event: 'grpc-real-commit-held-unmodified', ...evidence });
            gate.arrivedResolve(evidence);
            await gate.resume;
            record({ event: 'grpc-real-commit-resumed-unmodified', ...evidence });
          }
          forward(originalFrame);
        } catch (err) {
          record({ event: 'grpc-commit-gate-error', message: err.message, stack: err.stack });
          if (!down.destroyed) down.close(http2.constants.NGHTTP2_INTERNAL_ERROR);
        }
      });
    } else { forward(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  record({ event: 'commit-proxy-listening', port, address: server.address() });
  return { port, requests, get failCommits() { return failCommits; }, set failCommits(value) { failCommits = Boolean(value); record({ event: 'commit-fault-switch', failCommits }); }, holdNextCommit(predicate) {
    if (commitGate) throw new Error('Only one Commit barrier may be armed at a time');
    let arrivedResolve, resumeResolve;
    const arrived = new Promise(resolve => { arrivedResolve = resolve; });
    const resume = new Promise(resolve => { resumeResolve = resolve; });
    const gate = { predicate, arrivedResolve, resume };
    commitGate = gate;
    return { arrived, release() { if (commitGate === gate) commitGate = null; resumeResolve(); } };
  }, async close() {
    for (const session of sessions) session.destroy();
    await new Promise(resolve => server.close(resolve));
  } };
}
function parseNetstatListeners(text) {
  // Windows `netstat -ano -p tcp` rows look like:
  //   TCP    127.0.0.1:48391    0.0.0.0:0    LISTENING    6604
  //   TCP    [::1]:48391        [::]:0       LISTENING    6604
  const rows = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.trim().match(/^TCP\s+(\S+)\s+(\S+)\s+LISTENING\s+(\d+)\s*$/i);
    if (!m) continue;
    const local = m[1];
    const idx = local.lastIndexOf(':');
    if (idx < 0) continue;
    rows.push({ localAddress: local.slice(0, idx), localPort: Number(local.slice(idx + 1)), owningProcess: Number(m[3]) });
  }
  return rows;
}
function isLoopbackAddress(addr) {
  return ['127.0.0.1', '::1'].includes(String(addr).replace(/^\[|\]$/g, '').toLowerCase());
}
function enumerateOwnedListeners(pid, record) {
  // Two INDEPENDENT OS enumerations of the listeners the owned PID actually
  // holds. Neither may silently report "no listeners"; that is a failure.
  //  - netstat -ano -p tcp: fast, text; authoritative here (59ms vs CIM's ~1.3s).
  //  - Get-NetTCPConnection: CIM cross-check; bounded and only consulted when
  //    netstat is unavailable/empty, because a contended CIM subsystem can
  //    exceed any sane timeout on a loaded host (the prior POS run's blank-stderr
  //    failure was exactly this 20s timeout, not a missing listener).
  const sources = [];
  const nsStart = Date.now();
  const ns = spawnSync('netstat.exe', ['-ano', '-p', 'tcp'], { cwd: BASE, env: syntheticEnv(), encoding: 'utf8', timeout: 20000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  const netstatOk = !ns.error && ns.status === 0;
  const netstatRows = netstatOk ? parseNetstatListeners(ns.stdout).filter(r => r.owningProcess === Number(pid)) : [];
  sources.push({ method: 'netstat', ok: netstatOk, status: ns.status ?? null, signal: ns.signal ?? null, error: ns.error ? (ns.error.code || ns.error.message) : null, elapsedMs: Date.now() - nsStart, listeners: netstatRows });
  if (!netstatOk || netstatRows.length === 0) {
    const cimStart = Date.now();
    const cimCommand = `$ErrorActionPreference='Continue'; $rows=@(Get-NetTCPConnection -State Listen -OwningProcess ${pid} -ErrorAction SilentlyContinue | Select-Object LocalAddress,LocalPort,OwningProcess); if ($rows.Count -gt 0) { $rows | ConvertTo-Json -Compress } else { '[]' }`;
    const cim = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cimCommand], { cwd: BASE, env: syntheticEnv(), encoding: 'utf8', timeout: 45000, windowsHide: true });
    let cimRows = [];
    let cimError = null;
    if (cim.error || cim.status !== 0) cimError = cim.error ? (cim.error.code || cim.error.message) : ('exit ' + cim.status);
    else {
      try {
        const parsed = JSON.parse(cim.stdout);
        cimRows = (Array.isArray(parsed) ? parsed : [parsed])
          .map(r => ({ localAddress: String(r.LocalAddress), localPort: Number(r.LocalPort), owningProcess: Number(r.OwningProcess) }))
          .filter(r => r.owningProcess === Number(pid));
      } catch (err) { cimError = 'parse: ' + err.message; }
    }
    sources.push({ method: 'cim', ok: !cimError, status: cim.status ?? null, signal: cim.signal ?? null, error: cimError, elapsedMs: Date.now() - cimStart, listeners: cimRows });
  }
  const listeners = sources.flatMap(s => s.listeners);
  if (!sources.some(s => s.ok)) {
    throw new Error('Cannot verify emulator loopback bindings: every listener enumeration failed ' + JSON.stringify(sources.map(s => ({ method: s.method, status: s.status, signal: s.signal, error: s.error, elapsedMs: s.elapsedMs }))));
  }
  if (listeners.length === 0) {
    throw new Error('Owned emulator PID ' + pid + ' exposes no actual loopback listener via netstat/CIM ' + JSON.stringify(sources.map(s => ({ method: s.method, ok: s.ok, error: s.error }))));
  }
  record({ event: 'emulator-actual-listeners', pid, sources });
  return { listeners, sources };
}
async function waitPort(port, processHandle) {
  const end = Date.now() + 60000;
  while (Date.now() < end) {
    if (processHandle.exitCode !== null) throw new Error('Owned emulator exited before ready: ' + processHandle.exitCode);
    const available = await new Promise(resolve => {
      const socket = net.createConnection({ host: '127.0.0.1', port });
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => { socket.destroy(); resolve(false); });
    });
    if (available) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Owned emulator readiness deadline exceeded');
}
async function startInfrastructure({ evidenceDir, basePort, snapshot }) {
  const record = event => fs.appendFileSync(path.join(evidenceDir, 'events.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n');
  const ports = { firestore: basePort, websocket: basePort + 1, webchannel: basePort + 2, proxy: basePort + 3, vendor: basePort + 4, target: basePort + 5 };
  if (basePort < 45000 || basePort > 64000) throw new Error('Only unused high ports permitted');
  await reserveCheck(Object.values(ports));
  const guard = installNetworkGuard(Object.values(ports), record);
  const tls = prepareTls();
  const stdout = fs.openSync(path.join(evidenceDir, 'firestore.stdout.log'), 'wx');
  const stderr = fs.openSync(path.join(evidenceDir, 'firestore.stderr.log'), 'wx');
  const javaArgs = ['-Djava.io.tmpdir=' + path.join(BASE, 'runtime'), '-Duser.home=' + path.join(BASE, 'runtime'), '-jar', JAR, '--host', '127.0.0.1', '--port', String(ports.firestore), '--websocket_port', String(ports.websocket), '--webchannel_port', String(ports.webchannel), '--project_id', PROJECT, '--single_project_mode', '--single_project_mode_error'];
  const emulator = spawn(JAVA, javaArgs, { cwd: evidenceDir, env: syntheticEnv(), stdio: ['ignore', stdout, stderr], windowsHide: true });
  fs.closeSync(stdout); fs.closeSync(stderr);
  const owned = { projectId: PROJECT, nodePid: process.pid, emulatorPid: emulator.pid, ports, javaCommand: [JAVA, ...javaArgs], cleanupComplete: false };
  writeJson(path.join(evidenceDir, 'owned-processes.json'), owned);
  let vendor, target, proxy, db, observer;
  try {
    await waitPort(ports.firestore, emulator);
    // Check actual Java listeners, not just declared arguments. Enumeration is
    // netstat-authoritative with a bounded CIM cross-check; every actual listener
    // the owned PID holds must be loopback-only and must include the declared
    // Firestore port. This is deliberately still strict: a slow/absent CIM can no
    // longer abort the run, but no listener check is skipped or weakened.
    const binding = enumerateOwnedListeners(emulator.pid, record);
    for (const listener of binding.listeners) assert.ok(isLoopbackAddress(listener.localAddress), 'Emulator listener must be loopback: ' + JSON.stringify(listener));
    assert.ok(binding.listeners.some(l => Number(l.localPort) === Number(ports.firestore)), 'Owned emulator must actually listen on the declared Firestore port ' + ports.firestore + ' — saw ' + JSON.stringify(binding.listeners));
    record({ event: 'emulator-loopback-verified', pid: emulator.pid, listenerCount: binding.listeners.length, listeners: binding.listeners });
    vendor = await createRecorder(ports.vendor, tls, record, 'vendor');
    target = await createRecorder(ports.target, tls, record, 'redirect-target');
    proxy = await createCommitProxy(ports.proxy, ports.firestore, record);
    Object.assign(process.env, {
      FIRESTORE_EMULATOR_HOST: `127.0.0.1:${ports.proxy}`,
      PETPOOJA_ENABLED: 'true', PETPOOJA_APP_KEY: 'QA_SENTINEL_POS_KEY', PETPOOJA_APP_SECRET: 'QA_SENTINEL_POS_SECRET', PETPOOJA_ACCESS_TOKEN: 'QA_SENTINEL_POS_TOKEN', PETPOOJA_WEBHOOK_SECRET: 'QA_SENTINEL_POS_INBOUND',
      PETPOOJA_ORDER_URL: vendor.origin + '/pos/save', PETPOOJA_MENU_URL: vendor.origin + '/pos/menu', PETPOOJA_STOCK_URL: vendor.origin + '/pos/stock', PETPOOJA_CALLBACK_URL: vendor.origin + '/pos/callback',
      BORZO_ENABLED: 'true', BORZO_API_KEY: 'QA_SENTINEL_BORZO_TOKEN', BORZO_WEBHOOK_SECRET: 'QA_SENTINEL_BORZO_INBOUND', BORZO_BASE_URL: vendor.origin,
      SHADOWFAX_ENABLED: 'false', SHADOWFAX_API_KEY: 'QA_SENTINEL_SHADOWFAX_TOKEN', SHADOWFAX_CLIENT_CODE: 'QA_SYNTHETIC_CLIENT', SHADOWFAX_WEBHOOK_SECRET: 'QA_SENTINEL_SHADOWFAX_INBOUND', SHADOWFAX_BASE_URL: vendor.origin, SHADOWFAX_CONTRACT_VERIFIED: 'true',
      PORTER_ENABLED: 'false', PORTER_BASE_URL: vendor.origin,
      MOCK_PAYMENT_GATEWAY: 'false', MOCK_PETPOOJA_POS: 'false', MOCK_BORZO_DISPATCH: 'false', MOCK_SHADOWFAX_DISPATCH: 'false', MOCK_PORTER_DISPATCH: 'false',
      DISPATCH_REQUIRE_LIVE: 'false',
    });
    const deps = createRequire(PACKAGE);
    const { Firestore, Timestamp } = deps('@google-cloud/firestore');
    db = new Firestore({ projectId: PROJECT, host: '127.0.0.1', port: ports.proxy, ssl: false });
    observer = new Firestore({ projectId: PROJECT, host: '127.0.0.1', port: ports.firestore, ssl: false });
    record({ event: 'actual-sdk-created', projectId: PROJECT, sdk: '@google-cloud/firestore', proxyHost: `127.0.0.1:${ports.proxy}`, observerHost: `127.0.0.1:${ports.firestore}`, node: process.version });
    const shutdown = async () => {
      const failures = [];
      for (const [name, fn] of [['db', () => db?.terminate()], ['observer', () => observer?.terminate()], ['proxy', () => proxy?.close()], ['vendor', () => vendor?.close()], ['target', () => target?.close()]]) {
        try { await deadline(Promise.resolve(fn()), 10000, 'cleanup ' + name); } catch (err) { failures.push({ name, message: err.message }); }
      }
      if (emulator.exitCode === null) {
        const exit = new Promise(resolve => emulator.once('exit', (code, signal) => resolve({ code, signal })));
        emulator.kill();
        try { owned.emulatorExit = await deadline(exit, 10000, 'owned emulator exit'); } catch (err) { failures.push({ name: 'emulator', message: err.message }); }
      }
      owned.cleanupComplete = failures.length === 0;
      owned.cleanupFailures = failures;
      writeJson(path.join(evidenceDir, 'owned-processes.json'), owned);
      record({ event: 'cleanup-complete', ...owned });
      if (failures.length) throw new Error('Cleanup incomplete: ' + JSON.stringify(failures));
    };
    return { projectId: PROJECT, ports, record, guard, vendor, target, proxy, db, observer, deps, Timestamp, snapshot, owned, shutdown };
  } catch (err) {
    for (const thing of [db, observer]) { try { await thing?.terminate(); } catch {} }
    for (const thing of [proxy, vendor, target]) { try { await thing?.close(); } catch {} }
    if (emulator.exitCode === null) {
      const exit = new Promise(resolve => emulator.once('exit', (code, signal) => resolve({ code, signal })));
      emulator.kill();
      try { owned.emulatorExit = await deadline(exit, 10000, 'startup-failure cleanup'); owned.cleanupComplete = true; }
      catch (cleanupError) { owned.cleanupError = cleanupError.message; }
    } else { owned.cleanupComplete = true; }
    owned.startupFailed = err.message;
    writeJson(path.join(evidenceDir, 'owned-processes.json'), owned);
    throw err;
  }
}
function createSourceLoader(infra, candidate) {
  const root = path.join(infra.snapshot.dir, candidate, 'functions', 'src');
  const ts = infra.deps('typescript');
  const moduleCache = new Map();
  const spies = [];
  const clock = { now: Date.UTC(2026, 9, 28, 12, 0, 0) };
  const NativeDate = Date;
  class ApplicationDate extends NativeDate {
    constructor(...args) { super(...(args.length ? args : [clock.now])); }
    static now() { return clock.now; }
  }
  const inert = name => async (...args) => { spies.push({ name, args }); infra.record({ event: 'inert-service-spy', candidate, name }); return { syntheticInertSpy: true }; };
  const firebaseBoundary = { db: infra.db,
    auth: { verifyIdToken: () => { throw new Error('Auth token validation is outside this local harness'); } },
    messaging: { send: inert('FCM.messaging.send'), sendEachForMulticast: inert('FCM.messaging.sendEachForMulticast') } };
  const stubs = new Map([
    ['core/firebase.ts', firebaseBoundary],
    ['core/errors.ts', { captureErrorSnapshot: inert('captureErrorSnapshot') }],
    ['modules/notifications/fcm.service.ts', { dispatchFCM: inert('dispatchFCM') }],
    ['modules/notifications/fcmClient.ts', { sendNotification: inert('sendNotification'), sendToTokens: inert('sendToTokens') }],
  ]);
  const externalAllowed = new Set(['firebase-admin', 'firebase-functions/logger', 'zod']);
  const load = file => {
    file = ensureInside(path.resolve(file));
    const relative = path.relative(root, file).replaceAll('\\', '/');
    if (relative.startsWith('..')) throw new Error('Module escaped source snapshot');
    if (stubs.has(relative)) return stubs.get(relative);
    if (moduleCache.has(file)) return moduleCache.get(file).exports;
    if (!fs.existsSync(file)) throw new Error('Frozen dependency missing: ' + file);
    const module = { exports: {} };
    moduleCache.set(file, module);
    const bytes = fs.readFileSync(file);
    const expected = infra.snapshot.manifest.files.find(f => f.candidate === candidate && f.relativePath === 'functions/src/' + relative);
    if (!expected || sha(bytes) !== expected.sha256) throw new Error('Source not covered by immutable manifest: ' + relative);
    const js = ts.transpileModule(bytes.toString('utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
    const req = id => {
      if (id === 'dotenv') return { config: () => { throw new Error('QA_REFUSED_DOTENV_READ'); } };
      if (id.startsWith('.')) {
        const stem = path.resolve(path.dirname(file), id);
        const resolved = [stem + '.ts', path.join(stem, 'index.ts')].find(p => fs.existsSync(p));
        if (!resolved) throw new Error('Cannot resolve frozen dependency: ' + id);
        return load(resolved);
      }
      if (externalAllowed.has(id) || (isBuiltin(id) && ['crypto', 'node:crypto'].includes(id))) return infra.deps(id);
      throw new Error('Unreviewed external module import refused: ' + id);
    };
    infra.record({ event: 'execute-frozen-source', candidate, relative, sha256: expected.sha256 });
    new Function('require', 'module', 'exports', '__filename', '__dirname', 'Date', js)(req, module, module.exports, file, path.dirname(file), ApplicationDate);
    return module.exports;
  };
  return { load: relative => load(path.join(root, relative)), spies, clock };
}
module.exports = { BASE, PROJECT, PACKAGE, safeLabel, sha, writeJson, syntheticEnv, prepareTls, verifySnapshot, startInfrastructure, createSourceLoader, deadline };
