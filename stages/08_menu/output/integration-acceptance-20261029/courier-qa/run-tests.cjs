'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { BASE, PROJECT, safeLabel, writeJson, syntheticEnv, prepareTls, verifySnapshot, startInfrastructure, createSourceLoader, deadline } = require('./infrastructure.cjs');

function option(name, fallback) { const index = process.argv.indexOf('--' + name); return index < 0 ? fallback : process.argv[index + 1]; }
const snapshotLabel = safeLabel(option('snapshot', ''));
const mode = option('mode', 'smoke');
const scope = option('scope', 'all');
const reusedSmoke = option('reuse-smoke');
const runLabel = safeLabel(option('run', new Date().toISOString().replace(/[:.]/g, '-')));
const basePort = Number(option('base-port', '48381'));
if (!['smoke', 'exploratory', 'final'].includes(mode)) throw new Error('Mode must be smoke, exploratory, or final');
if (!['pos', 'dispatch', 'all'].includes(scope)) throw new Error('Scope must be pos, dispatch, or all');

if (!process.argv.includes('--worker')) {
  const tls = prepareTls();
  const transcriptDir = path.join(BASE, 'evidence', runLabel);
  fs.mkdirSync(transcriptDir, { recursive: true });
  const transcriptPath = path.join(transcriptDir, 'transcript.txt');
  const transcriptFd = fs.openSync(transcriptPath, 'wx');
  const transcript = fs.createWriteStream(transcriptPath, { fd: transcriptFd, autoClose: true });
  const child = spawn(process.execPath, [__filename, ...process.argv.slice(2), '--worker'], { cwd: BASE, env: syntheticEnv({ NODE_EXTRA_CA_CERTS: tls.pem }), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  child.stdout.on('data', bytes => { process.stdout.write(bytes); transcript.write(bytes); });
  child.stderr.on('data', bytes => { process.stderr.write(bytes); transcript.write(bytes); });
  child.on('error', err => { console.error(err); process.exitCode = 1; });
  child.on('exit', (code, signal) => { process.exitCode = code ?? 1; if (signal) console.error('Worker signal: ' + signal); });
  child.on('close', () => transcript.end());
} else {
  main().catch(err => { console.error(err.stack || err); process.exitCode = 1; });
}

async function main() {
  const snapshot = verifySnapshot(snapshotLabel);
  const evidenceDir = path.join(BASE, 'evidence', runLabel);
  fs.mkdirSync(evidenceDir, { recursive: true });
  if (fs.existsSync(path.join(evidenceDir, 'run.json'))) throw new Error('Evidence run label already used; choose a new label');
  const entries = snapshot.manifest.files.filter(f => snapshot.manifest.candidates[f.candidate].entries.includes(f.relativePath));
  const scopedEntries = entries.filter(f => scope === 'all' || scope === f.candidate);
  if (scopedEntries.length === 0) throw new Error('Selected scope is absent from frozen snapshot');
  if (scope === 'all' && (!snapshot.manifest.candidates.pos || !snapshot.manifest.candidates.dispatch)) throw new Error('All scope requires both candidate snapshots');
  if (mode === 'final') {
    const expectedPath = option('expected');
    if (!expectedPath) throw new Error('Final mode requires parent-supplied --expected hashes JSON');
    const expected = JSON.parse(fs.readFileSync(expectedPath, 'utf8'));
    for (const entry of scopedEntries) assert.equal(entry.sha256, String(expected[entry.candidate + ':' + entry.relativePath]).toLowerCase(), 'Final parent-ready source fingerprint must match: ' + entry.relativePath);
    for (const [key, hash] of Object.entries(expected)) {
      const file = snapshot.manifest.files.find(f => key === f.candidate + ':' + f.relativePath);
      assert.ok(file, 'Owner-ready expected file must be present in frozen snapshot: ' + key);
      assert.equal(file.sha256, String(hash).toLowerCase(), 'Owner-ready auxiliary/source hash mismatch: ' + key);
    }
  }
  const report = { runLabel, mode, scope, projectId: PROJECT, startedAt: new Date().toISOString(), command: [process.execPath, __filename, ...process.argv.slice(2).filter(s => s !== '--worker')], snapshotLabel, snapshotManifestSha256: snapshot.manifestSha256, entryHashes: scopedEntries, sourceAcceptance: false, results: [], limitations: [
    'Local real SDK/emulator and native TLS fetch only; never provider, deployment or production evidence.',
    'No application files changed. Copied TypeScript executes via transpileModule; this is not a full package typecheck/build or Functions HTTP routing test.',
    'Core Firebase initialization is replaced with the actual isolated Firestore SDK. Auth token verification, FCM, developer alerts are inert explicit boundaries; no payment module executes.',
    'Commit-fault proxy produces non-retryable gRPC code 7 after the durable claim, not a packet-loss/timing or emulator restart/crash test.',
    'Admin SDK bypasses Firestore Security Rules; authorization/rules coverage is not claimed.',
    'Single-process concurrency crosses real SDK transaction RPCs; not multi-Functions-host latency/load testing.',
    'Local emulator does not enforce production composite-index requirements.',
    'Observed runtime is Node 24.18.0; package declares Node 22. No installed Node 22 runtime was selected.',
  ] };
  report.harnessHashes = Object.fromEntries(['snapshot.cjs', 'infrastructure.cjs', 'run-tests.cjs'].map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(BASE, file))).digest('hex')]));
  const harnessArchive = path.join(evidenceDir, 'harness');
  fs.mkdirSync(harnessArchive, { recursive: true });
  for (const file of Object.keys(report.harnessHashes)) fs.copyFileSync(path.join(BASE, file), path.join(harnessArchive, file), fs.constants.COPYFILE_EXCL);
  if (reusedSmoke) {
    if (mode === 'smoke') throw new Error('A smoke run cannot skip its own tests');
    const previous = path.join(BASE, 'evidence', safeLabel(reusedSmoke), 'run.json');
    const smoke = JSON.parse(fs.readFileSync(previous, 'utf8'));
    assert.equal(smoke.projectId, PROJECT);
    assert.equal(smoke.cleanupComplete, true);
    assert.ok(smoke.results.filter(r => r.name.startsWith('infrastructure/') && r.status === 'PASS').length === 3, 'Reused smoke must contain all three real passing infrastructure tests');
    report.infrastructureEvidenceReference = previous;
    console.log('REUSE confirmed real infrastructure evidence: ' + previous + ' (not rerun)');
  }
  writeJson(path.join(evidenceDir, 'run.json'), report);
  let infra;
  const check = async (name, test) => {
    const start = Date.now();
    console.log('RUN ' + name);
    try {
      const evidence = await deadline(Promise.resolve().then(test), 45000, name);
      const result = { name, status: 'PASS', durationMs: Date.now() - start, evidence };
      report.results.push(result);
      console.log('PASS ' + name + ' ' + JSON.stringify(evidence));
    } catch (err) {
      report.results.push({ name, status: 'FAIL', durationMs: Date.now() - start, error: { name: err.name, message: err.message, stack: err.stack } });
      console.error('FAIL ' + name + '\n' + (err.stack || err));
      process.exitCode = 1;
    }
    writeJson(path.join(evidenceDir, 'run.json'), report);
  };
  try {
    infra = await startInfrastructure({ evidenceDir, basePort, snapshot });
    if (!reusedSmoke) {
    await check('infrastructure/native-fetch-loopback-recorder-and-network-refusal', async () => {
      infra.vendor.setHandler(item => ({ status: 200, json: { observedMethod: item.method, observedBody: item.body } }));
      const response = await fetch(infra.vendor.origin + '/smoke', { method: 'POST', headers: { 'X-QA-Sentinel': 'NOT_A_MERCHANT_KEY' }, body: '{"synthetic":true}' });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { observedMethod: 'POST', observedBody: '{"synthetic":true}' });
      assert.equal(infra.vendor.requests.at(-1).headers['x-qa-sentinel'], 'NOT_A_MERCHANT_KEY');
      assert.throws(() => infra.guard.assertDestination('example.invalid', 443), { code: 'QA_NETWORK_REFUSED' });
      assert.throws(() => infra.guard.assertDestination('127.0.0.1', 8080), { code: 'QA_NETWORK_REFUSED' });
      // Reserved documentation IP: exercise native fetch below the top-level
      // URL gate and prove the socket policy stops it before a network connect.
      await assert.rejects(infra.guard.nativeFetch('https://203.0.113.1/qa-no-wire'), err => err.cause?.code === 'QA_NETWORK_REFUSED');
      assert.equal(infra.vendor.errors.length, 0);
      return { actualWireRequests: 1, nativeFetch: true, tlsVerification: 'synthetic localhost certificate trusted by child only', externalDestinationAndShared8080: 'refused before connect' };
    });
    await check('infrastructure/real-sdk-concurrent-transactions-and-read-before-write-control', async () => {
      const a = infra.db.doc('_qa_smoke/counter');
      const b = infra.db.doc('_qa_smoke/other');
      await Promise.all([a.set({ count: 0 }), b.set({ sentinel: true })]);
      const increment = () => infra.db.runTransaction(async tx => { const snap = await tx.get(a); tx.update(a, { count: snap.data().count + 1 }); });
      await Promise.all([increment(), increment()]);
      assert.equal((await infra.observer.doc(a.path).get()).data().count, 2);
      await assert.rejects(infra.db.runTransaction(async tx => { const snap = await tx.get(a); tx.update(a, { count: snap.data().count + 1 }); await tx.get(b); }), /all reads.*before.*writes/i);
      assert.equal((await infra.observer.doc(a.path).get()).data().count, 2);
      return { counterAfterConcurrentIncrements: 2, invalidReadAfterWriteRejected: true, noPartialWriteFromRejectedTransaction: true };
    });
    await check('infrastructure/real-grpc-commit-fault-after-durable-state-and-restore', async () => {
      const ref = infra.db.doc('_qa_smoke/durable');
      await infra.db.runTransaction(async tx => { await tx.get(ref); tx.set(ref, { durable: true, stage: 'before-fault' }); });
      const faultStart = infra.proxy.requests.length;
      infra.proxy.failCommits = true;
      try {
        await assert.rejects(ref.set({ stage: 'forbidden-direct-write' }, { merge: true }), err => err.code === 7);
        await assert.rejects(infra.db.runTransaction(async tx => { await tx.get(ref); tx.set(ref, { stage: 'forbidden-transaction-write' }, { merge: true }); }), err => err.code === 7);
        assert.equal((await ref.get()).data().stage, 'before-fault');
        assert.equal((await infra.observer.doc(ref.path).get()).data().durable, true);
      } finally { infra.proxy.failCommits = false; }
      const blocked = infra.proxy.requests.slice(faultStart).filter(r => r.blocked).length;
      assert.equal(blocked, 2);
      await ref.set({ stage: 'restored' }, { merge: true });
      assert.equal((await infra.observer.doc(ref.path).get()).data().stage, 'restored');
      return { realCommitRpcsDenied: blocked, readsAvailableDuringFault: true, initialDurableStatePreserved: true, restoredWriteConfirmedByIndependentSdk: true };
    });
    if (report.results.some(r => r.status === 'FAIL')) throw new Error('Infrastructure smoke failed; application cases not executed');
    }
    if (mode !== 'smoke') await applicationCases(infra, check, scope);
    else report.notExecuted = [
      'POS durable pre-send intent after ACK and all later writes fail; +11min direct caller stays at one wire request',
      'POS multi-document retry scheduler real Firestore ordering',
      'POS 429/malformed 2xx/307 no replay or redirect follow',
      'Borzo incomplete/wrong-ID/active 200 retain live binding',
      'Concurrent cancellation one wire request; late response after signed webhook + real rebook does not clear replacement',
      'Shared native-fetch helper cross-origin 302/307 never forwards sentinel header',
    ];
    assert.equal(infra.vendor.errors.length, 0, 'Local recorder handlers must not hide assertion/setup failures');
    assert.equal(infra.target.errors.length, 0);
  } catch (err) {
    report.harnessError = { message: err.message, stack: err.stack };
    console.error('HARNESS ERROR ' + (err.stack || err));
    process.exitCode = 1;
  } finally {
    if (infra) {
      try { await infra.shutdown(); report.cleanupComplete = true; } catch (err) { report.cleanupComplete = false; report.cleanupError = err.message; process.exitCode = 1; }
    }
    report.finishedAt = new Date().toISOString();
    report.exitCode = process.exitCode || 0;
    // A scoped local gate is never an overall source/production acceptance.
    report.sourceAcceptance = false;
    report.scopedChecksPassed = mode === 'final' && report.exitCode === 0;
    writeJson(path.join(evidenceDir, 'run.json'), report);
    console.log('RESULT ' + JSON.stringify({ mode, scope, sourceAcceptance: false, scopedChecksPassed: report.scopedChecksPassed, statuses: report.results.map(r => ({ name: r.name, status: r.status })), exitCode: report.exitCode, cleanupComplete: report.cleanupComplete, evidenceDir }));
  }
}

function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
const capture = promise => promise.then(value => ({ ok: true, value }), err => ({ ok: false, error: { code: err.code, message: err.message, requiresManualReview: err.requiresManualReview, ambiguous: err.ambiguous } }));

async function applicationCases(infra, check, scope) {
  const pos = scope === 'dispatch' ? null : createSourceLoader(infra, 'pos');
  const dispatch = scope === 'pos' ? null : createSourceLoader(infra, 'dispatch');
  const push = pos?.load('modules/petpooja/orderPush.ts');
  const scheduler = pos?.load('modules/petpooja/petpooja.scheduler.ts');
  const router = dispatch?.load('modules/dispatch/dispatch.router.ts');
  const helper = dispatch?.load('modules/dispatch/providers/shared.ts');
  const webhook = dispatch?.load('modules/dispatch/dispatch.webhooks.ts');
  const createdOrderPaths = new Set();
  const caseCheck = (name, body) => check(name, async () => {
    if (pos) pos.clock.now = Date.UTC(2026, 9, 28, 12, 0, 0);
    if (dispatch) dispatch.clock.now = Date.UTC(2026, 9, 28, 12, 0, 0);
    try { return await body(); }
    finally {
      infra.proxy.failCommits = false;
      for (const orderPath of createdOrderPaths) await infra.observer.doc(orderPath).delete();
      createdOrderPaths.clear();
    }
  });
  const branchId = 'qa-synthetic-branch';
  const caller = { uid: 'qa-synthetic-staff', role: 'branch_manager', branchIds: [branchId] };
  await infra.db.doc('branches/' + branchId).set({ name: 'LOCAL QA ONLY', active: true, petpoojaStoreId: 'QA-NOT-A-MERCHANT', phone: '+91 9999900001', coordinates: { lat: 23.0131, lng: 72.5085 }, petpoojaTaxes: [{ id: 'QA-CGST', name: 'CGST', rate: 2.5 }, { id: 'QA-SGST', name: 'SGST', rate: 2.5 }], petpoojaTaxesRestId: 'QA-NOT-A-MERCHANT', petpoojaTaxesCapturedAt: infra.Timestamp.fromMillis(Date.UTC(2026, 9, 28, 10, 0, 0)) });
  const seed = async (id, extra = {}) => {
    const data = { id, branchId, branchName: 'LOCAL QA ONLY', branchAddress: 'Synthetic pickup', branchCity: 'Test City', branchState: 'Test State', branchPincode: '000000',
      store: { id: branchId, name: 'LOCAL QA ONLY', phone: '+91 9999900001' }, branchCoordinates: { lat: 23.0131, lng: 72.5085 },
      deliveryAddress: { full: 'Synthetic drop, no delivery permitted', lat: 23.0238, lng: 72.5162 },
      customerPhone: '+91 9999900002', customerName: 'Synthetic Customer', fulfillmentType: 'delivery', payment: { method: 'RAZORPAY' }, paymentStatus: 'paid',
      status: { code: 'PREPARING', terminal: false }, items: [{ productId: 'prod_' + branchId + '_QA_ITEM', petpoojaItemId: 'QA_ITEM', name: 'Synthetic item', unitPrice: 100, quantity: 1 }],
      pricing: { subtotal: 100, foodSubtotal: 100, grandTotal: 105, gst: 5, deliveryFee: 0, packagingFee: 0, discount: 0, loyaltyDiscount: 0 }, createdAt: infra.Timestamp.fromMillis(Date.UTC(2026, 9, 28, 11, 59, 0)), ...extra };
    createdOrderPaths.add('orders/' + id);
    await infra.db.doc('orders/' + id).set(data);
    return infra.observer.doc('orders/' + id);
  };
  const seedDispatch = (id, extra = {}) => seed(id, { deliveryStatus: 'dispatched', dispatchStatus: 'dispatched', dispatchProvider: 'borzo', dispatchOrderId: '1250032', borzoOrderId: '1250032', dispatchBindingVersion: 1, needsRebook: false, ...extra });
  const confirmedCancel = () => ({ status: 200, json: { is_successful: true, order: { order_id: 1250032, status: 'canceled' } } });
  const posAck = item => ({ status: 200, json: { success: '1', orderID: 'QA-POS-' + JSON.parse(item.body).orderinfo.OrderInfo.Order.details.clientOrderID } });

  if (pos) {
  await caseCheck('POS/direct-legacy-pending-retry-timeout-without-claim-must-not-send', async () => {
    const id = 'qa-pos-direct-legacy-timeout';
    const ref = await seed(id, { petpoojaStatus: 'pending_retry', petpoojaSyncStatus: 'pending_retry', petpoojaRetryCount: 1, lastPetpoojaError: 'legacy timeout after possible provider acceptance' });
    const start = infra.vendor.requests.length;
    infra.vendor.setHandler(item => { assert.equal(item.path, '/pos/save'); return posAck(item); });
    const outcome = await capture(push.pushOrderToPetpooja(id, caller));
    const wireRequests = infra.vendor.requests.length - start;
    const after = (await ref.get()).data();
    infra.record({ event: 'legacy-direct-case-observation', id, outcome, wireRequests, statusAfter: after.petpoojaStatus, acceptedIdAfter: after.petpoojaOrderId || null });
    assert.equal(wireRequests, 0, 'Direct caller must not replay a legacy possibly-sent pending_retry row with no positive pre-send evidence');
    assert.ok(!after.petpoojaOrderId && !after.petpoojaAcceptedNoId);
    return { outcome, wireRequests, statusAfter: after.petpoojaStatus };
  });
  await caseCheck('POS/ACK-all-later-Commit-RPCs-fail-restore-plus11min-no-resend', async () => {
    const id = 'qa-pos-ack-outage';
    const ref = await seed(id);
    const firstWire = infra.vendor.requests.length;
    const faultStart = infra.proxy.requests.length;
    let claimAtAck;
    infra.vendor.setHandler(async item => {
      assert.equal(item.path, '/pos/save');
      claimAtAck = (await ref.get()).data();
      assert.equal(claimAtAck.petpoojaUnresolvedIntent, true);
      assert.equal(claimAtAck.petpoojaSendIntentState, 'in_flight');
      assert.ok(claimAtAck.petpoojaAttemptId);
      infra.record({ event: 'app-claim-confirmed-before-ACK', id, attemptId: claimAtAck.petpoojaAttemptId, claimCommitted: true });
      infra.proxy.failCommits = true;
      return posAck(item);
    });
    let outcome;
    try { outcome = await capture(push.pushOrderToPetpooja(id, caller)); }
    finally { infra.proxy.failCommits = false; }
    const blocked = infra.proxy.requests.slice(faultStart).filter(r => r.blocked).length;
    assert.ok(blocked >= 2, 'ACK persistence and all failure bookkeeping Commit RPCs must be denied');
    const durable = (await ref.get()).data();
    assert.equal(durable.petpoojaUnresolvedIntent, true);
    assert.equal(durable.petpoojaSendIntentState, 'in_flight');
    assert.equal(durable.petpoojaAttemptId, claimAtAck.petpoojaAttemptId);
    assert.ok(!durable.petpoojaOrderId && !durable.petpoojaAcceptedNoId);
    pos.clock.now += 11 * 60 * 1000;
    const repeat = await push.pushOrderToPetpooja(id, caller);
    assert.equal(repeat, false);
    assert.equal(infra.vendor.requests.length - firstWire, 1);
    assert.equal((await ref.get()).data().petpoojaAttemptId, claimAtAck.petpoojaAttemptId);
    return { firstOutcome: outcome, durableIntentObservedBeforeAck: true, laterCommitRpcsDenied: blocked, clockAdvancedMs: 660000, wireRequestsAcrossRestoreAndDirectRecall: 1 };
  });
  await caseCheck('POS/documented-400-refusal-resolves-intent-without-automatic-replay', async () => {
    const id = 'qa-pos-documented-400';
    const ref = await seed(id);
    const start = infra.vendor.requests.length;
    infra.vendor.setHandler(item => {
      assert.equal(item.path, '/pos/save');
      return { status: 400, json: {
        success: '0',
        message: 'There were some error in order details.',
        errorCode: 'SO_105',
        validation_errors: { orderID: ['Please provide order id.'] },
      } };
    });
    assert.equal(await push.pushOrderToPetpooja(id, caller), false);
    const rejected = (await ref.get()).data();
    assert.equal(rejected.petpoojaStatus, 'failed');
    assert.equal(rejected.petpoojaUnresolvedIntent, false);
    assert.equal(rejected.petpoojaSendIntentState, 'rejected');
    assert.ok(!rejected.petpoojaOrderId && !rejected.petpoojaAcceptedNoId && !rejected.kotPrinted);
    await scheduler.retryPendingPetpoojaOrdersWorker();
    assert.equal(infra.vendor.requests.length - start, 1);
    return { documentedRefusal: 'HTTP 400 / success:0 / SO_105', status: rejected.petpoojaStatus, unresolved: false, wireRequestsIncludingScheduler: 1 };
  });
  await caseCheck('POS/multiple-scheduler-documents-real-SDK-reads-before-writes', async () => {
    const ids = ['qa-pos-retry-a', 'qa-pos-retry-b'];
    for (const id of ids) await seed(id, { petpoojaStatus: 'pending_retry', petpoojaSyncStatus: 'pending_retry', petpoojaRetryCount: 1, petpoojaUnresolvedIntent: false, petpoojaSendIntentState: 'provably_unsent' });
    const start = infra.vendor.requests.length;
    infra.vendor.setHandler(item => { assert.equal(item.path, '/pos/save'); return posAck(item); });
    const result = await scheduler.retryPendingPetpoojaOrdersWorker();
    assert.deepEqual(result, { retriedCount: 2, failedCount: 0 });
    const sent = infra.vendor.requests.slice(start).map(item => JSON.parse(item.body).orderinfo.OrderInfo.Order.details.clientOrderID).sort();
    assert.deepEqual(sent, ids);
    for (const id of ids) { const data = (await infra.observer.doc('orders/' + id).get()).data(); assert.equal(data.petpoojaStatus, 'synced'); assert.equal(data.petpoojaUnresolvedIntent, false); }
    return { schedulerResult: result, wireOrderIds: sent, actualSdkReadAfterWriteNegativeControlRanEarlier: true };
  });
  for (const [label, response] of [
    ['429', () => ({ status: 429, json: { message: 'Synthetic rate limit' } })],
    ['malformed-200', () => ({ status: 200, body: '<html>Synthetic malformed acknowledgement</html>' })],
    ['307', () => ({ status: 307, headers: { location: infra.target.origin + '/must-not-receive-pos' } })],
  ]) await caseCheck('POS/' + label + '-no-resend-no-redirect-follow', async () => {
    const id = 'qa-pos-' + label;
    const ref = await seed(id);
    const start = infra.vendor.requests.length;
    const targetStart = infra.target.requests.length;
    const spyStart = pos.spies.length;
    infra.vendor.setHandler(item => { assert.equal(item.path, '/pos/save'); return response(); });
    assert.equal(await push.pushOrderToPetpooja(id, caller), false);
    const parked = (await ref.get()).data();
    assert.equal(parked.petpoojaStatus, 'reconciliation_required');
    assert.equal(parked.petpoojaUnresolvedIntent, true);
    assert.ok(!parked.petpoojaOrderId && !parked.petpoojaAcceptedNoId && !parked.kotPrinted);
    pos.clock.now += 11 * 60 * 1000;
    assert.equal(await push.pushOrderToPetpooja(id, caller), false);
    await scheduler.retryPendingPetpoojaOrdersWorker();
    assert.equal(infra.vendor.requests.length - start, 1);
    assert.equal(infra.target.requests.length - targetStart, 0);
    assert.ok(!pos.spies.slice(spyStart).some(s => s.name === 'dispatchFCM'), 'No enter-manually FCM for ambiguous outcome');
    return { status: parked.petpoojaStatus, wireRequestsIncludingRecallAndScheduler: 1, redirectedRequests: 0, fabricatedPrinterProof: false, manualEntryFcm: 0 };
  });
  await caseCheck('POS/wire-payload-strict-money-contract', async () => {
    const id = 'qa-pos-payload';
    const ref = await seed(id);
    const start = infra.vendor.requests.length;
    let payload;
    infra.vendor.setHandler(item => { assert.equal(item.path, '/pos/save'); payload = JSON.parse(item.body); return posAck(item); });
    assert.equal(await push.pushOrderToPetpooja(id, caller), true);
    assert.equal(infra.vendor.requests.length - start, 1);
    const seeded = (await ref.get()).data();
    assert.equal(seeded.paymentMethod, undefined);
    assert.equal(seeded.payment.method, 'RAZORPAY');
    const d = payload.orderinfo.OrderInfo.Order.details;
    const line = payload.orderinfo.OrderInfo.OrderItem.details[0];
    const tax = payload.orderinfo.OrderInfo.Tax.details;
    assert.equal(d.clientOrderID, id);
    assert.equal(d.payment_type, 'ONLINE');
    assert.equal(d.total, '105.00');
    assert.equal(d.tax_total, '5.00');
    assert.equal(d.tax, '5.00');
    assert.equal(d.collect_cash, '0.00');
    assert.equal(line.price, '100.00');
    assert.equal(line.final_price, '100.00');
    assert.equal(line.quantity, '1');
    assert.equal(line.tax_inclusive, false);
    assert.equal(Number(line.tax_percentage), 5);
    assert.deepEqual(line.item_tax.map(t => t.id), ['QA-CGST', 'QA-SGST']);
    assert.deepEqual(line.item_tax.map(t => Number(t.amount)), [2.5, 2.5]);
    assert.deepEqual(tax.map(t => t.id), ['QA-CGST', 'QA-SGST']);
    assert.deepEqual(tax.map(t => Number(t.tax)), [2.5, 2.5]);
    assert.equal(payload.orderinfo.OrderInfo.Restaurant.details.restID, 'QA-NOT-A-MERCHANT');
    return { total: d.total, taxTotal: d.tax_total, paymentType: d.payment_type, unitPrice: line.price, finalPrice: line.final_price, quantity: line.quantity, taxInclusive: line.tax_inclusive, itemTaxIds: line.item_tax.map(t => t.id), taxRowIds: tax.map(t => t.id), restID: payload.orderinfo.OrderInfo.Restaurant.details.restID, wireRequests: 1 };
  });
  await caseCheck('POS/concurrent-direct-pushes-one-wire-and-no-resent-kot', async () => {
    const id = 'qa-pos-dedupe';
    const ref = await seed(id);
    const start = infra.vendor.requests.length;
    infra.vendor.setHandler(item => { assert.equal(item.path, '/pos/save'); return posAck(item); });
    const outcomes = await Promise.all([
      capture(push.pushOrderToPetpooja(id, caller)),
      capture(push.pushOrderToPetpooja(id, caller)),
    ]);
    const wire = infra.vendor.requests.length - start;
    assert.equal(wire, 1, 'two concurrent direct pushes must produce exactly one KOT wire request');
    const accepted = outcomes.filter(o => o.ok && o.value === true).length;
    assert.ok(accepted >= 1, 'at least one concurrent push must report success; the loser is an idempotent dedupe, not a second KOT');
    const data = (await ref.get()).data();
    assert.equal(data.petpoojaStatus, 'synced');
    const retryResult = await push.pushOrderToPetpooja(id, caller);
    assert.equal(infra.vendor.requests.length - start, 1, 'a post-ACK direct retry must not resend the KOT');
    return { outcomes, wireRequests: wire, acceptedPushes: accepted, statusAfter: data.petpoojaStatus, postAckRetryResult: retryResult, postAckRetryWireRequests: 1 };
  });
  await caseCheck('POS/branch-tax-provenance-mismatch-refused-pre-wire', async () => {
    const id = 'qa-pos-tax-mismatch';
    const ref = await seed(id);
    const branchRef = infra.db.doc('branches/' + branchId);
    const original = (await branchRef.get()).data();
    const start = infra.vendor.requests.length;
    let outcome;
    try {
      await branchRef.set({ petpoojaTaxesRestId: 'OTHER-OUTLET' }, { merge: true });
      outcome = await capture(push.pushOrderToPetpooja(id, caller));
    } finally {
      await branchRef.set({ petpoojaTaxesRestId: original.petpoojaTaxesRestId }, { merge: true });
    }
    assert.equal(infra.vendor.requests.length - start, 0, 'a tax-provenance mismatch must be refused before any POS wire call');
    const data = (await ref.get()).data();
    const message = String((outcome.ok ? (outcome.value === false ? data.lastPetpoojaError : '') : outcome.error.message) || '');
    assert.match(message, /captured for outlet/i);
    assert.ok(data.petpoojaStatus !== 'synced');
    return { outcome, wireRequests: 0, statusAfter: data.petpoojaStatus, error: message };
  });  }
  if (dispatch) {
  for (const [label, response] of [
    ['empty', { status: 200, body: '' }], ['non-json', { status: 200, body: '<html>not confirmation</html>' }],
    ['incomplete', { status: 200, json: { is_successful: true } }],
    ['wrong-id', { status: 200, json: { is_successful: true, order: { order_id: 999, status: 'canceled' } } }],
    ['active', { status: 200, json: { is_successful: true, order: { order_id: 1250032, status: 'active' } } }],
  ]) await caseCheck('Borzo/' + label + '-200-never-releases-binding-or-repeats-wire', async () => {
    const id = 'qa-borzo-' + label;
    const ref = await seedDispatch(id);
    const start = infra.vendor.requests.length;
    infra.vendor.setHandler(item => { assert.equal(item.path, '/api/business/1.8/cancel-order'); assert.deepEqual(JSON.parse(item.body), { order_id: 1250032 }); return response; });
    const first = await capture(router.dispatchCancel({ orderId: id, caller }));
    assert.equal(first.ok, false);
    assert.equal(first.error.requiresManualReview, true);
    const data = (await ref.get()).data();
    assert.equal(data.dispatchProvider, 'borzo'); assert.equal(data.dispatchOrderId, '1250032'); assert.equal(data.borzoOrderId, '1250032');
    assert.equal(data.deliveryStatus, 'dispatched'); assert.equal(data.needsRebook, false);
    assert.equal(data.dispatchCancelIntent.state, 'ambiguous');
    assert.equal((data.dispatchReleasedBindings || []).length, 0);
    const second = await capture(router.dispatchCancel({ orderId: id, caller }));
    assert.equal(second.ok, false); assert.equal(second.error.requiresManualReview, true);
    assert.equal(infra.vendor.requests.length - start, 1);
    return { firstError: first.error.code, secondError: second.error.code, bindingAfter: data.dispatchOrderId, deliveryStatusAfter: data.deliveryStatus, intentState: data.dispatchCancelIntent.state, wireRequests: 1 };
  });
  await caseCheck('dispatch/concurrent-cancels-one-real-wire-and-one-release', async () => {
    const id = 'qa-concurrent-cancel';
    const ref = await seedDispatch(id);
    const arrived = deferred(); const release = deferred();
    const start = infra.vendor.requests.length;
    infra.vendor.setHandler(async item => { assert.equal(item.path, '/api/business/1.8/cancel-order'); arrived.resolve(); await release.promise; return confirmedCancel(); });
    const first = capture(router.dispatchCancel({ orderId: id, staffName: 'QA A', caller }));
    const second = capture(router.dispatchCancel({ orderId: id, staffName: 'QA B', caller }));
    let outcomes;
    try {
      await deadline(arrived.promise, 10000, 'first concurrent cancellation at recorder');
      const loser = await deadline(Promise.race([first, second]), 10000, 'competing cancel must fail closed before first ACK');
      assert.equal(loser.ok, false); assert.equal(loser.error.requiresManualReview, true);
      assert.equal(infra.vendor.requests.length - start, 1);
    } finally { release.resolve(); outcomes = await Promise.all([first, second]); }
    assert.equal(outcomes.filter(o => o.ok).length, 1);
    assert.equal(outcomes.find(o => o.ok).value.providerCancel, 'confirmed');
    const data = (await ref.get()).data();
    assert.equal(data.dispatchOrderId, null); assert.equal(data.deliveryStatus, 'rider_cancelled');
    assert.equal(data.dispatchReleasedBindings.filter(b => b.providerOrderId === '1250032').length, 1);
    assert.equal(infra.vendor.requests.length - start, 1);
    return { outcomes, wireRequests: 1, releasedBindingRecords: 1 };
  });
  await caseCheck('dispatch/late-cancel-after-signed-callback-and-real-rebook-preserves-replacement', async () => {
    const id = 'qa-stale-cancel';
    const ref = await seedDispatch(id);
    const arrived = deferred(); const release = deferred();
    const start = infra.vendor.requests.length;
    infra.vendor.setHandler(async item => {
      if (item.path.endsWith('/cancel-order')) { arrived.resolve(); await release.promise; return confirmedCancel(); }
      if (item.path.endsWith('/calculate-order')) return { status: 200, json: { is_successful: true, order: { payment_amount: '50.00' } } };
      if (item.path.endsWith('/create-order')) return { status: 200, json: { is_successful: true, order: { order_id: 1250999, status: 'new', points: [] } } };
      throw new Error('Unexpected wire path during real rebook: ' + item.path);
    });
    const late = capture(router.dispatchCancel({ orderId: id, caller }));
    let before, outcome, rebook;
    try {
      await deadline(arrived.promise, 10000, 'held cancellation reached recorder');
      const payload = { event_type: 'order_changed', event_datetime: new Date(dispatch.clock.now).toISOString(), order: { order_id: 1250032, client_order_id: id, status: 'canceled' } };
      const raw = JSON.stringify(payload);
      const signature = crypto.createHmac('sha256', 'QA_SENTINEL_BORZO_INBOUND').update(raw).digest('hex');
      await webhook.handleDispatchWebhook('borzo', raw, signature, payload);
      const released = (await ref.get()).data();
      assert.equal(released.rebookTrigger, 'staff_cancelled'); assert.equal(released.dispatchCancelIntent.state, 'released'); assert.equal(released.dispatchOrderId, null);
      rebook = await router.dispatchRebook({ orderId: id, caller });
      assert.equal(rebook.providerOrderId, '1250999');
      before = (await ref.get()).data();
      assert.equal(before.dispatchOrderId, '1250999');
    } finally { release.resolve(); outcome = await late; }
    assert.equal(outcome.ok, false); assert.equal(outcome.error.requiresManualReview, true);
    const after = (await ref.get()).data();
    assert.deepEqual(after, before, 'Old provider ACK may not mutate ANY newer booking fields');
    const paths = infra.vendor.requests.slice(start).map(r => r.path);
    assert.equal(paths.filter(p => p.endsWith('/cancel-order')).length, 1);
    assert.equal(paths.filter(p => p.endsWith('/create-order')).length, 1);
    return { signedCallbackExecuted: true, actualDispatchRebookExecuted: true, replacementIdBefore: before.dispatchOrderId, replacementIdAfter: after.dispatchOrderId, replacementVersion: after.dispatchBindingVersion, lateError: outcome.error.code, paths };
  });
  for (const status of [302, 307]) await caseCheck('HTTP/helper-cross-origin-' + status + '-does-not-forward-sentinel', async () => {
    const start = infra.vendor.requests.length;
    const targetStart = infra.target.requests.length;
    infra.target.setHandler(() => ({ status: 200, body: 'should never receive request' }));
    infra.vendor.setHandler(() => ({ status, headers: { location: infra.target.origin + '/must-not-receive-token' } }));
    const result = await capture(helper.fetchProviderJson('borzo', infra.vendor.origin + '/redirect-probe', { method: 'POST', headers: { 'X-DV-Auth-Token': 'QA_SENTINEL_NEVER_FORWARD', Authorization: 'Token QA_SENTINEL_NEVER_FORWARD' }, body: '{"order_id":1250032}' }));
    assert.equal(result.ok, false);
    assert.equal(infra.vendor.requests.length - start, 1);
    assert.equal(infra.target.requests.length - targetStart, 0);
    assert.equal(infra.vendor.requests.at(-1).headers['x-dv-auth-token'], 'QA_SENTINEL_NEVER_FORWARD');
    return { originalRequests: 1, crossOriginTargetRequests: 0, sentinelSeenOnlyByOriginalRecorder: true, error: result.error.message };
  });
  for (const status of [200, 204]) await caseCheck('Shadowfax/' + status + '-ACK-keeps-live-binding-and-blocks-repeat', async () => {
    const id = 'qa-shadowfax-ack-' + status;
    const ref = await seedDispatch(id, { dispatchProvider: 'shadowfax', dispatchOrderId: 'QA-SFX-OLD', borzoOrderId: null, shadowfaxOrderId: 'QA-SFX-OLD' });
    const start = infra.vendor.requests.length;
    infra.vendor.setHandler(item => { assert.equal(item.path, '/api/v2/orders/QA-SFX-OLD/cancel/'); assert.equal(item.method, 'PUT'); return { status, body: '' }; });
    const first = await capture(router.dispatchCancel({ orderId: id, caller }));
    assert.equal(first.ok, false); assert.equal(first.error.requiresManualReview, true);
    const data = (await ref.get()).data();
    assert.equal(data.dispatchOrderId, 'QA-SFX-OLD'); assert.equal(data.deliveryStatus, 'dispatched'); assert.equal(data.needsRebook, false);
    assert.equal(data.dispatchCancelIntent.state, 'acknowledged');
    const repeat = await capture(router.dispatchCancel({ orderId: id, caller }));
    assert.equal(repeat.ok, false); assert.equal(infra.vendor.requests.length - start, 1);
    return { firstError: first.error.code, repeatError: repeat.error.code, liveBindingRetained: data.dispatchOrderId, durableState: data.dispatchCancelIntent.state, wireRequests: 1, statusLookupCalls: 0 };
  });
  await caseCheck('dispatch/held-transactional-callback-commit-serializes-and-preserves-replacement', async () => {
    const id = 'qa-callback-commit-race';
    const ref = await seedDispatch(id);
    const cancelArrived = deferred(); const releaseCancel = deferred();
    const start = infra.vendor.requests.length;
    infra.vendor.setHandler(async item => {
      if (item.path.endsWith('/cancel-order')) { cancelArrived.resolve(); await releaseCancel.promise; return confirmedCancel(); }
      if (item.path.endsWith('/calculate-order')) return { status: 200, json: { is_successful: true, order: { payment_amount: '50.00' } } };
      if (item.path.endsWith('/create-order')) return { status: 200, json: { is_successful: true, order: { order_id: 1250999, status: 'new', points: [] } } };
      throw new Error('Unexpected wire during callback Commit race: ' + item.path);
    });
    const cancel = capture(router.dispatchCancel({ orderId: id, caller }));
    let gate, callback, held, cancelOutcome, callbackOutcome, settledWhileHeld, rebook;
    try {
      await deadline(cancelArrived.promise, 10000, 'cancel wire before callback race');
      gate = infra.proxy.holdNextCommit(request => request.writes.some(w => w.update?.name?.endsWith('/orders/' + id) && w.update.fields?.dispatchProviderCancelSource?.stringValue === 'webhook'));
      const payload = { event_type: 'order_changed', event_datetime: new Date(dispatch.clock.now).toISOString(), order: { order_id: 1250032, client_order_id: id, status: 'canceled' } };
      const raw = JSON.stringify(payload);
      const signature = crypto.createHmac('sha256', 'QA_SENTINEL_BORZO_INBOUND').update(raw).digest('hex');
      callback = capture(webhook.handleDispatchWebhook('borzo', raw, signature, payload));
      held = await deadline(gate.arrived, 10000, 'hold actual transactional callback Commit');
      assert.ok(held.transactionBytes > 0, 'callback commit must be a real transaction');
      releaseCancel.resolve();
      settledWhileHeld = await deadline(Promise.race([cancel.then(() => true, () => true), new Promise(resolve => setTimeout(() => resolve(false), 1500))]), 5000, 'cancel serialization probe');
      infra.record({ event: 'callback-case-serialization-probe', settledWhileHeld, heldTransactionBytes: held.transactionBytes });
      assert.equal(settledWhileHeld, false, 'a held transactional callback Commit must serialize the same-document cancel (no interleaved release)');
    } finally {
      releaseCancel.resolve(); gate?.release();
      cancelOutcome = await cancel;
      if (callback) callbackOutcome = await callback;
    }
    rebook = await router.dispatchRebook({ orderId: id, caller });
    assert.equal(rebook.providerOrderId, '1250999');
    const after = (await ref.get()).data();
    assert.equal(after.dispatchOrderId, '1250999');
    assert.equal(after.dispatchProvider, 'borzo');
    assert.equal(after.deliveryStatus, 'dispatched');
    infra.record({ event: 'callback-serialization-observation', id, held, settledWhileHeld, cancelOutcome, callbackOutcome, afterBinding: { orderId: after.dispatchOrderId, version: after.dispatchBindingVersion, deliveryStatus: after.deliveryStatus } });
    return { heldCommit: held, cancelSettledWhileCommitHeld: settledWhileHeld, cancelOutcome, callbackOutcome, replacementId: after.dispatchOrderId, replacementVersion: after.dispatchBindingVersion, wirePaths: infra.vendor.requests.slice(start).map(r => r.path) };
  });  await caseCheck('dispatch/foreign-branch-caller-refused-before-provider-wire', async () => {
    const id = 'qa-foreign-branch';
    await seedDispatch(id, { branchId: 'qa-foreign-branch', store: { id: 'qa-foreign-branch', name: 'FOREIGN BRANCH', phone: '+91 9999900009' } });
    const start = infra.vendor.requests.length;
    const outcome = await capture(router.dispatchCancel({ orderId: id, caller }));
    assert.equal(outcome.ok, false);
    assert.match(outcome.error.message, /^Forbidden/);
    assert.equal(infra.vendor.requests.length - start, 0);
    return { error: outcome.error.message, wireRequests: 0, callerBranchIds: caller.branchIds };
  });
  await caseCheck('Borzo/quote-native-wire-success-honours-test-token', async () => {
    const start = infra.vendor.requests.length;
    infra.vendor.setHandler(item => {
      assert.ok(item.path.endsWith('/calculate-order'), 'unexpected quote path ' + item.path);
      assert.equal(item.method, 'POST');
      assert.equal(item.headers['x-dv-auth-token'], 'QA_SENTINEL_BORZO_TOKEN');
      return { status: 200, json: { is_successful: true, order: { payment_amount: '50.00' } } };
    });
    const quote = await router.dispatchQuote({ pickupLat: 23.0131, pickupLng: 72.5085, dropLat: 23.0238, dropLng: 72.5162, orderId: 'qa-borzo-quote', customerName: 'Synthetic Customer', customerPhone: '+91 9999900002' });
    assert.equal(quote.serviceable, true);
    assert.equal(quote.winner, 'borzo');
    assert.equal(quote.estimatedFare, 50);
    assert.equal(quote.source, 'borzo_api_live');
    assert.equal(infra.vendor.requests.length - start, 1);
    return { winner: quote.winner, fare: quote.estimatedFare, source: quote.source, wireRequests: 1 };
  });
  await caseCheck('Borzo/book-native-wire-binds-and-writes-order-map', async () => {
    const id = 'qa-borzo-book';
    const ref = await seed(id);
    const start = infra.vendor.requests.length;
    infra.vendor.setHandler(item => {
      if (item.path.endsWith('/calculate-order')) return { status: 200, json: { is_successful: true, order: { payment_amount: '50.00' } } };
      if (item.path.endsWith('/create-order')) return { status: 200, json: { is_successful: true, order: { order_id: 1250032, status: 'new', points: [] } } };
      throw new Error('Unexpected book wire path: ' + item.path);
    });
    const result = await router.dispatchBook({ orderId: id, caller });
    const data = (await ref.get()).data();
    const paths = infra.vendor.requests.slice(start).map(r => r.path);
    assert.equal(data.dispatchProvider, 'borzo');
    assert.equal(data.dispatchOrderId, '1250032');
    assert.equal(data.borzoOrderId, '1250032');
    assert.equal(data.deliveryStatus, 'dispatched');
    assert.equal(data.dispatchBindingVersion, 1);
    assert.equal(paths.filter(p => p.endsWith('/calculate-order')).length, 1);
    assert.equal(paths.filter(p => p.endsWith('/create-order')).length, 1);
    const map = await infra.observer.doc('dispatch_order_map/1250032').get();
    assert.equal(map.exists, true);
    assert.equal(map.data().orderId, id);
    await infra.observer.doc('dispatch_order_map/1250032').delete();
    return { responseKeys: Object.keys(result || {}), provider: data.dispatchProvider, providerOrderId: data.dispatchOrderId, bindingVersion: data.dispatchBindingVersion, wirePaths: paths };
  });
  await caseCheck('Borzo/book-ambiguous-2xx-without-id-never-fails-over', async () => {
    const id = 'qa-borzo-book-noid';
    const ref = await seed(id);
    const start = infra.vendor.requests.length;
    infra.vendor.setHandler(item => {
      if (item.path.endsWith('/calculate-order')) return { status: 200, json: { is_successful: true, order: { payment_amount: '50.00' } } };
      if (item.path.endsWith('/create-order')) return { status: 200, json: { is_successful: true, order: { status: 'new' } } };
      throw new Error('Unexpected path: ' + item.path);
    });
    const outcome = await capture(router.dispatchBook({ orderId: id, caller }));
    assert.equal(outcome.ok, false);
    assert.match(outcome.error.message, /no order id/i);
    const data = (await ref.get()).data();
    assert.ok(!data.dispatchOrderId && !data.borzoOrderId && !data.shadowfaxOrderId && !data.porterOrderId);
    assert.ok(!data.deliveryStatus);
    const createCalls = infra.vendor.requests.slice(start).filter(r => r.path.endsWith('/create-order')).length;
    assert.equal(createCalls, 1);
    return { error: outcome.error.message, createOrderWireRequests: createCalls, boundProviderId: data.dispatchOrderId || null };
  });
  await caseCheck('Borzo/book-connection-drop-after-send-never-books-second-provider', async () => {
    const id = 'qa-borzo-book-drop';
    const ref = await seed(id);
    const start = infra.vendor.requests.length;
    infra.vendor.setHandler(item => {
      if (item.path.endsWith('/calculate-order')) return { status: 200, json: { is_successful: true, order: { payment_amount: '50.00' } } };
      if (item.path.endsWith('/create-order')) return { destroy: true };
      throw new Error('Unexpected path: ' + item.path);
    });
    const outcome = await capture(router.dispatchBook({ orderId: id, caller }));
    assert.equal(outcome.ok, false);
    const data = (await ref.get()).data();
    assert.ok(!data.dispatchOrderId && !data.borzoOrderId && !data.shadowfaxOrderId && !data.porterOrderId);
    const createCalls = infra.vendor.requests.slice(start).filter(r => r.path.endsWith('/create-order')).length;
    assert.equal(createCalls, 1);
    return { error: outcome.error.message, createOrderWireRequests: 1, boundProviderId: data.dispatchOrderId || null, secondProviderCalls: 0 };
  });
  await caseCheck('dispatch/readiness-reports-test-host-violations-but-is-inert-by-default', async () => {
    const readiness = dispatch.load('modules/dispatch/readiness.ts');
    const report = readiness.dispatchReadinessReport();
    const borzo = report.providers.find(p => p.provider === 'borzo');
    assert.equal(borzo.testHost, false);
    assert.ok(report.violations.some(v => v.includes('borzo') && v.includes('TEST host')));
    assert.equal(readiness.assertDispatchReadinessIfRequired(), null);
    return { borzoHost: borzo.host, borzoTestHost: borzo.testHost, violations: report.violations, entrypointRefused: false };
  });
  }
}
